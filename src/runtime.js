const fs = require("node:fs");
const path = require("node:path");
const {
  USAGE_RANGES,
  buildView,
  fingerprintFor,
  viewTitle,
  normalizedConfig,
  hasConfig,
  normalizeMetric,
  normalizeUsageRange,
  aggregateRecentSummary,
} = require("./core");
const { HubClient, redactSecrets } = require("./hub-client");
const { WIDTH: RENDER_WIDTH, renderKey } = require("./render");

const KEY_CIDS = new Set([
  "com.upkiry.flexbarcchusage.quota",
  "com.upkiry.flexbarcchusage.usage",
]);

// 指标由按键 data.metric 决定。保留默认值可以兼容旧版已放置的按键。
const USAGE_METRICS = new Set(["callsCost", "tokens", "cache", "recent", "summary"]);
const QUOTA_METRIC = "quotaStatus";

// 每个时间范围对应多少天的窗口，供"最近调用"指标使用。
const RANGE_DAYS = { "5h": 1, "1d": 1, "7d": 7, "1m": 30 };
// 单次绘制的超时，防止宿主无响应时绘制队列被永久堵死。
const DRAW_TIMEOUT_MS = 8_000;
// 连续失败时的最大退避倍数。
const MAX_BACKOFF_FACTOR = 8;
// 相同错误日志的最小间隔，避免长时间运行时刷屏。
const ERROR_LOG_INTERVAL_MS = 60_000;
// 定期从宿主复查配置的间隔。
const CONFIG_RECHECK_MS = 5 * 60_000;

function emptyCache() {
  return {
    quota: null,
    today: null,
    summaries: {},
    recentLogs: null,
    recentSummary: null,
    recentError: null,
    recentTruncated: false,
    fetchedAt: null,
    stale: true,
    error: null,
    errors: {},
    fresh: {},
  };
}

function keyRange(key) {
  if (key?.cid?.endsWith("quota")) return "5h";
  return normalizeUsageRange(key?.data?.range, "1d");
}

function keyMetric(key) {
  if (key?.cid?.endsWith("quota")) return QUOTA_METRIC;
  const metric = normalizeMetric(key?.data?.metric);
  return USAGE_METRICS.has(metric) ? metric : "callsCost";
}

function keyIdentifier(key) {
  return String(key?.uid || key?.cid || "");
}

function summarizeRecentLogs(value) {
  return aggregateRecentSummary(value);
}

function findMessageConfig(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if (value.config && typeof value.config === "object") return value.config;
  if (typeof value.cchUrl === "string" || typeof value.CCH_URL === "string") return value;
  for (const child of Object.values(value)) {
    const found = findMessageConfig(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function readConfigBackup(configStorePath) {
  if (!configStorePath) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(configStorePath, "utf8"));
    return hasConfig(stored) ? normalizedConfig(stored) : null;
  } catch {
    return null;
  }
}

function writeConfigBackup(configStorePath, value) {
  if (!configStorePath || !hasConfig(value)) return;
  try {
    fs.mkdirSync(path.dirname(configStorePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${configStorePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizedConfig(value))}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, configStorePath);
    fs.chmodSync(configStorePath, 0o600);
  } catch {
    // The host configuration remains authoritative if the optional backup cannot be written.
  }
}

/**
 * 修补 SDK 的重连回调。
 *
 * 1. SDK 用 `setTimeout(this.start, 5000)` 重连，this 会丢失；
 * 2. 'close' 与 'error' 会各排一个定时器，一次断线可能建出两条 WebSocket；
 * 3. 旧连接被丢弃但没有关闭，会泄漏。
 */
function hardenTransport(transport, logger) {
  if (!transport || typeof transport.start !== "function") return false;
  if (transport.start.__flexbarHardened) return false;
  const original = transport.start.bind(transport);
  const hardened = function hardenedStart(...args) {
    const socket = transport.ws;
    // 已经有一个连接或正在连接时不再重复建立。
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return undefined;
    try {
      return original(...args);
    } catch (error) {
      logger?.error?.(`插件重连失败：${error?.message || error}`);
      return undefined;
    }
  };
  Object.defineProperty(hardened, "__flexbarHardened", { value: true });
  // 保留旧标记，兼容既有测试与外部集成。
  Object.defineProperty(hardened, "__flexbarBound", { value: true });
  transport.start = hardened;
  return true;
}

function withTimeout(promise, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("绘制超时")), milliseconds);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 插件运行时。
 *
 * 职责划分：
 * - 事件处理只做"记账 + 触发"，立刻返回，绝不在宿主回调里等待网络；
 * - 一台设备一份状态，按键集合变化时递增代次，丢弃过期绘制；
 * - 刷新失败按分片隔离，坏掉的接口不会连累其它按键；
 * - 定时刷新带退避，长时间运行不会把 CC Hub 打满。
 */
function createPluginRuntime({
  plugin,
  logger,
  HubClientClass = HubClient,
  renderKeyFn = renderKey,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  configStorePath,
  drawTimeoutMs = DRAW_TIMEOUT_MS,
} = {}) {
  const devices = new Map();
  const desiredSignatures = new Map();
  const confirmedSignatures = new Map();
  const pending = new Map();
  const draining = new Set();
  let config = {};
  let client;
  let cache = emptyCache();
  let refreshPromise = null;
  let queuedRefresh = null;
  let refreshDirty = false;
  let pendingRedraw = false;
  let configVersion = 0;
  let refreshTimer = null;
  let configPromise = null;
  let configLoaded = false;
  let configReadAt = 0;
  let backupRestoreAttempted = false;
  let failures = 0;
  let lastFailureAt = 0;
  let lastErrorSignature = "";
  let lastErrorAt = 0;
  let registered = false;
  let started = false;

  function safeError(error) {
    return redactSecrets(error?.message || "查询失败", [config.apiKey, client?.cookie]);
  }

  function logError(message) {
    const text = String(message || "");
    const stamp = now();
    if (text === lastErrorSignature && stamp - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorSignature = text;
    lastErrorAt = stamp;
    logger.error(text);
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  function applyConfig(next, options = {}) {
    // 后台读取宿主配置的途中可能已经收到更新的配置，这时丢弃旧结果。
    if (options.expectedVersion !== undefined && options.expectedVersion !== configVersion) {
      return { changed: false, identityChanged: false };
    }
    const identityChanged = next.cchUrl !== config.cchUrl || next.apiKey !== config.apiKey;
    const changed = identityChanged || next.refreshIntervalSeconds !== config.refreshIntervalSeconds;
    config = next;
    configVersion += 1;
    if (changed || !client) {
      client = config.cchUrl && config.apiKey ? new HubClientClass(config) : null;
    }
    if (changed) {
      writeConfigBackup(configStorePath, config);
      scheduleTimer();
    }
    return { changed, identityChanged };
  }

  async function readStoredConfig() {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await plugin.getConfig();
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError || new Error("无法读取插件配置");
  }

  /**
   * 读取宿主配置。
   *
   * 旧实现每轮刷新都调用一次 plugin.getConfig()，既多一次宿主 IPC，
   * 又把配置文件反复写盘。现在只在首次、配置变更事件和定期复查时读取。
   */
  function ensureConfig(storedConfig) {
    if (storedConfig !== undefined) {
      applyConfig(normalizedConfig(storedConfig));
      return Promise.resolve(config);
    }
    const needsRead = !configLoaded
      || (configReadAt && now() - configReadAt > CONFIG_RECHECK_MS);
    if (!needsRead) return Promise.resolve(config);
    if (configPromise) return configPromise;
    configReadAt = now();
    // 读取期间可能已经收到更新的配置，回来时必须核对版本，否则旧配置会覆盖新配置。
    const version = configVersion;
    configPromise = readStoredConfig()
      .then((stored) => {
        configLoaded = true;
        if (version !== configVersion) return config;
        const next = normalizedConfig(stored);
        const backup = readConfigBackup(configStorePath);
        if (!hasConfig(next) && backup) {
          // 宿主配置被重装清空时用本地副本恢复。
          if (!backupRestoreAttempted && typeof plugin.setConfig === "function") {
            backupRestoreAttempted = true;
            plugin.setConfig(backup).catch((error) => {
              logger.warn(`恢复插件配置失败：${safeError(error)}`);
            });
          }
          applyConfig(backup, { expectedVersion: version });
          return config;
        }
        applyConfig(next, { expectedVersion: version });
        return config;
      })
      .catch((error) => {
        logger.warn(`读取 CC Hub 插件配置失败，将保留当前配置并稍后重试：${safeError(error)}`);
        return config;
      })
      .finally(() => {
        configPromise = null;
      });
    return configPromise;
  }

  // -------------------------------------------------------------------------
  // 设备与按键
  // -------------------------------------------------------------------------

  function deviceFor(serial) {
    if (!devices.has(serial)) {
      devices.set(serial, { serial, generation: 0, keys: new Map(), connected: true });
    }
    return devices.get(serial);
  }

  function forgetSignatures(serial) {
    const prefix = `${serial}:`;
    for (const id of [...desiredSignatures.keys(), ...confirmedSignatures.keys()]) {
      if (!id.startsWith(prefix)) continue;
      desiredSignatures.delete(id);
      confirmedSignatures.delete(id);
    }
  }

  function applyKeys(device, keys) {
    const previous = device.keys;
    let changed = previous.size !== keys.size;
    if (!changed) {
      for (const id of keys.keys()) {
        if (!previous.has(id)) {
          changed = true;
          break;
        }
      }
    }
    device.keys = keys;
    if (changed) {
      // 代次变化会让在途绘制作废，避免旧按键的数据画到新按键上。
      device.generation += 1;
      for (const id of previous.keys()) {
        if (!keys.has(id)) desiredSignatures.delete(`${device.serial}:${id}`);
      }
    }
    return changed;
  }

  function markDisconnected(serial) {
    const device = devices.get(serial);
    if (!device) return;
    device.generation += 1;
    device.connected = false;
    // 保留按键列表：宿主不一定在重新插上后重发按键列表。
    pending.delete(serial);
    forgetSignatures(serial);
  }

  function connectedDevices() {
    return [...devices.values()].filter((device) => device.connected && device.keys.size > 0);
  }

  /** 本轮需要哪些时间范围和哪些附加数据。 */
  function requestPlan() {
    const ranges = new Set();
    const metrics = new Set();
    let recentDays = 1;
    for (const device of connectedDevices()) {
      for (const key of device.keys.values()) {
        const metric = keyMetric(key);
        metrics.add(metric);
        const range = keyRange(key);
        if (metric === "recent") {
          recentDays = Math.max(recentDays, RANGE_DAYS[range] || 1);
          continue;
        }
        ranges.add(range);
      }
    }
    const options = {
      includeRecentLogs: metrics.has("recent"),
      recentLimit: 8,
      recentDays,
    };
    // 缓存和汇总指标依赖 stats-summary，1 天范围需要额外取一次。
    if (ranges.has("1d") && (metrics.has("cache") || metrics.has("summary"))) {
      options.includeDailySummary = true;
    }
    return { ranges: USAGE_RANGES.filter((range) => ranges.has(range)), options };
  }

  // -------------------------------------------------------------------------
  // 抓取与合并
  // -------------------------------------------------------------------------

  function applyResult(result) {
    const errors = result?.errors || {};
    const fresh = {};
    const next = { ...cache, summaries: { ...(cache.summaries || {}) } };
    const mark = (slice) => { fresh[slice] = !errors[slice]; };

    if (result?.quota !== undefined) next.quota = result.quota;
    mark("quota");

    if (result?.today !== undefined) next.today = result.today;
    mark("today");

    for (const range of ["1d", "7d", "1m"]) {
      if (result?.summaries?.[range] !== undefined) next.summaries[range] = result.summaries[range];
      mark(range);
    }

    if (result?.recentLogs !== undefined) {
      next.recentLogs = result.recentLogs;
      next.recentSummary = summarizeRecentLogs(result.recentLogs);
      next.recentTruncated = Boolean(result.recentTruncated);
    }
    next.recentError = result?.recentError || null;
    mark("recent");

    next.fresh = fresh;
    next.errors = errors;
    next.fetchedAt = now();
    next.stale = false;
    next.error = null;
    cache = next;
  }

  async function performRefresh(reason, storedConfig) {
    await ensureConfig(storedConfig);
    if (!client) {
      cache = { ...cache, stale: true, error: "请在插件配置中设置 CC Hub URL 和 API Key" };
      await drawAll();
      return cache;
    }
    const plan = requestPlan();
    const planSignature = JSON.stringify(plan);
    try {
      const result = await client.load(plan.ranges, plan.options);
      applyResult(result);
      failures = 0;
      const problems = Array.isArray(result?.problems) ? result.problems : [];
      if (problems.length) {
        logError(`CC Hub 返回了部分异常字段：${problems.slice(0, 3).join("；")}`);
      }
    } catch (error) {
      failures += 1;
      lastFailureAt = now();
      cache = { ...cache, stale: true, error: safeError(error) };
      logError(`CC Hub ${reason}失败：${cache.error}`);
    }
    await drawAll();
    // 抓取期间可能又来了新设备或新按键，这一轮的数据不覆盖它们，需要再跑一轮。
    if (JSON.stringify(requestPlan()) !== planSignature) refreshDirty = true;
    // 抓取期间接上的设备，这一轮的绘制可能没轮到它，补画一次（不再重新抓取）。
    if (pendingRedraw) {
      pendingRedraw = false;
      drawAll();
    }
    return cache;
  }

  /**
   * 触发一轮刷新。同一时刻只跑一轮，重复触发直接复用进行中的那一轮。
   *
   * 如果这一轮带着新的配置，而当前已经有刷新在跑，就把新配置排队，
   * 等当前这轮结束后再跑一次——否则配置变更会被正在进行的刷新悄悄吞掉。
   *
   * 返回的 Promise 永远不会 reject，避免宿主事件回调里出现未捕获异常。
   */
  function refresh(reason = "定时刷新", storedConfig) {
    if (refreshPromise) {
      if (storedConfig !== undefined) queuedRefresh = { reason, storedConfig };
      return refreshPromise;
    }
    refreshPromise = performRefresh(reason, storedConfig)
      .catch((error) => {
        logError(`刷新失败：${safeError(error)}`);
        return cache;
      })
      .finally(() => {
        refreshPromise = null;
        const queued = queuedRefresh;
        queuedRefresh = null;
        if (queued) {
          void refresh(queued.reason, queued.storedConfig);
        } else if (refreshDirty) {
          // 上一轮抓取期间需求变了，补一轮。
          refreshDirty = false;
          void refresh("需求变更刷新");
        }
      });
    return refreshPromise;
  }

  /** 等待当前这轮刷新（含排队中的刷新）全部结束。 */
  async function whenIdle() {
    while (refreshPromise) {
      await refreshPromise.catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------

  function prepareUpdate(device, key) {
    const width = Number(key.width || key.style?.width || RENDER_WIDTH);
    const keyData = key.data || {};
    let view;
    try {
      view = buildView(key.cid, cache, config, keyData);
    } catch (error) {
      logError(`生成按键视图失败：${safeError(error)}`);
      return null;
    }
    const signature = fingerprintFor(key.cid, width, view);
    const id = `${device.serial}:${keyIdentifier(key)}`;
    // desired 记录"这一格应该显示什么"，排队中和画成功的都算。
    // 只看画成功的签名会漏掉"正在画"的那一次，从而重复排队。
    if (desiredSignatures.get(id) === signature) return null;

    let rendered;
    try {
      rendered = renderKeyFn(key.cid, cache, config, width, keyData);
    } catch (error) {
      logError(`渲染按键失败：${safeError(error)}`);
      return null;
    }
    key.style = {
      ...(key.style || {}),
      width: rendered.width,
      showTitle: false,
      showIcon: false,
      showImage: true,
    };
    key.title = viewTitle(view);
    desiredSignatures.set(id, signature);
    return {
      id,
      serial: device.serial,
      generation: device.generation,
      key,
      image: rendered.dataUrl,
      signature,
    };
  }

  async function drawOne(update) {
    const device = devices.get(update.serial);
    if (!device || device.generation !== update.generation) return;
    try {
      await withTimeout(plugin.draw(update.serial, update.key, "base64", update.image), drawTimeoutMs);
      confirmedSignatures.set(update.id, update.signature);
    } catch (error) {
      // 失败时把期望值清掉，下一轮会重试。
      if (desiredSignatures.get(update.id) === update.signature) {
        desiredSignatures.delete(update.id);
        confirmedSignatures.delete(update.id);
      }
      logError(`更新 Flexbar 按键失败：${safeError(error)}`);
    }
  }

  async function drainDevice(serial) {
    if (draining.has(serial)) return;
    draining.add(serial);
    try {
      while (true) {
        const queue = pending.get(serial);
        if (!queue || !queue.size) break;
        const [id, update] = queue.entries().next().value;
        queue.delete(id);
        await drawOne(update);
      }
    } finally {
      draining.delete(serial);
    }
  }

  function enqueue(update) {
    const serial = update.serial;
    if (!pending.has(serial)) pending.set(serial, new Map());
    pending.get(serial).set(update.id, update);
    void drainDevice(serial);
  }

  function drawAll() {
    for (const device of devices.values()) {
      if (!device.connected) continue;
      for (const key of device.keys.values()) {
        const update = prepareUpdate(device, key);
        if (update) enqueue(update);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 定时器
  // -------------------------------------------------------------------------

  function clearTimer() {
    if (refreshTimer) clearIntervalFn(refreshTimer);
    refreshTimer = null;
  }

  function backoffDelay() {
    const base = Math.max(15, config.refreshIntervalSeconds || 60) * 1000;
    if (failures <= 0) return 0;
    return Math.min(base * MAX_BACKOFF_FACTOR, base * (2 ** Math.min(failures, 3)));
  }

  function scheduleTimer() {
    clearTimer();
    const base = Math.max(15, config.refreshIntervalSeconds || 60) * 1000;
    refreshTimer = setIntervalFn(() => {
      // 失败后进入退避，避免接口持续不可用时反复打满。
      const wait = backoffDelay();
      if (wait > 0 && now() - lastFailureAt < wait) return;
      if (!connectedDevices().length) return;
      void refresh("定时刷新");
    }, base);
  }

  // -------------------------------------------------------------------------
  // 宿主事件
  // -------------------------------------------------------------------------

  const handlers = {
    /**
     * 宿主下发按键列表。
     *
     * 这里必须立刻返回：宿主会等待处理结果才回复，一个网络往返就能把
     * 启动流程卡住几十秒。
     */
    async alive(payload) {
      const serial = payload?.serialNumber;
      if (!serial) return { status: "success" };
      const device = deviceFor(serial);
      device.connected = true;
      const keys = new Map();
      for (const key of payload.keys || []) {
        if (KEY_CIDS.has(key.cid)) keys.set(keyIdentifier(key), key);
      }
      applyKeys(device, keys);
      // 如果这轮抓取已经在跑，它的绘制可能没轮到新接上的设备，记下来补画一次。
      // 这里不直接渲染，避免在宿主事件回调里做耗时的画布编码。
      if (refreshPromise) pendingRedraw = true;
      void refresh("启动刷新");
      return { status: "success" };
    },

    /** 按键点击：立刻回复，数据刷新在后台进行。 */
    async data(payload) {
      const key = payload?.data?.key;
      if (!key || !KEY_CIDS.has(key.cid)) return { status: "error", message: "未知按键" };
      const serial = payload?.serialNumber;
      if (serial) {
        deviceFor(serial).keys.set(keyIdentifier(key), key);
      }
      void refresh("点击刷新");
      return { status: "success", message: "正在刷新" };
    },

    /** 宿主配置变更。 */
    async configUpdated(payload) {
      const storedConfig = payload?.config || payload?.data?.config || {};
      const next = normalizedConfig(storedConfig);
      writeConfigBackup(configStorePath, next);
      const { identityChanged } = applyConfig(next);
      if (identityChanged) {
        // 服务端换了，旧数据没有意义，但按键不会因此变空白。
        cache = { ...emptyCache(), stale: true };
        forgetSignaturesForAll();
      }
      void refresh("配置更新", next);
      return { status: "success" };
    },

    /** 设备插拔。 */
    async deviceStatus(payload) {
      const items = Array.isArray(payload) ? payload : payload ? [payload] : [];
      let reconnected = false;
      for (const item of items) {
        const serial = item?.serialNumber || item?.serial;
        if (!serial) continue;
        if (item?.status === "disconnected") {
          markDisconnected(serial);
        } else if (item?.status === "connected") {
          const device = devices.get(serial);
          if (device) {
            if (!device.connected) {
              // 重新插上：主机不一定重发按键列表，沿用旧按键重画一次。
              device.connected = true;
              device.generation += 1;
              forgetSignatures(serial);
              reconnected = true;
            }
          } else {
            deviceFor(serial);
          }
        }
      }
      if (reconnected) void refresh("设备重连");
      return { status: "success" };
    },

    /** 配置页与宿主之间的消息。 */
    async uiMessage(payload) {
      const message = payload?.data?.data && typeof payload.data.data === "object"
        ? { ...payload, ...payload.data, ...payload.data.data }
        : payload?.data && typeof payload.data === "object"
          ? { ...payload, ...payload.data }
          : payload || {};
      if (message.action === "getConfig") {
        // 不无限等待宿主读配置：读不到就返回当前已有的值。
        await Promise.race([
          ensureConfig(),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 4000);
            if (typeof timer.unref === "function") timer.unref();
          }),
        ]);
        return { status: "success", config: { ...config } };
      }
      if (message.action === "applyConfig") {
        const nextConfig = normalizedConfig(findMessageConfig(message) || {});
        if (!hasConfig(nextConfig)) return { status: "error", message: "请填写 CC Hub URL 和 API Key" };
        writeConfigBackup(configStorePath, nextConfig);
        await handlers.configUpdated({ config: nextConfig });
        return { status: "success", message: "配置已应用，按键正在刷新" };
      }
      if (message.action !== "testConnection") return { status: "error", message: "未知操作" };
      const testConfig = normalizedConfig(
        findMessageConfig(message) || await plugin.getConfig().catch(() => ({})),
      );
      if (!testConfig.cchUrl || !testConfig.apiKey) {
        return { status: "error", message: "请填写 CC Hub URL 和 API Key" };
      }
      try {
        // 只做一次轻量连通性检查，不再跑完整的一轮抓取。
        const testClient = new HubClientClass(testConfig);
        if (typeof testClient.ping === "function") await testClient.ping();
        else await testClient.load();
        return { status: "success", message: "连接成功" };
      } catch (error) {
        return { status: "error", message: redactSecrets(error?.message || "连接失败", [testConfig.apiKey]) };
      }
    },
  };

  function forgetSignaturesForAll() {
    desiredSignatures.clear();
    confirmedSignatures.clear();
  }

  function register() {
    if (registered) return;
    plugin.on("plugin.alive", handlers.alive);
    plugin.on("plugin.data", handlers.data);
    plugin.on("plugin.config.updated", handlers.configUpdated);
    plugin.on("device.status", handlers.deviceStatus);
    plugin.on("ui.message", handlers.uiMessage);
    registered = true;
  }

  function start() {
    register();
    if (!started) {
      // FlexDesigner SDK 1.0.x schedules transport.start as an unbound callback
      // on disconnect, which loses the port and retries ws://localhost:undefined.
      hardenTransport(plugin.transport, logger);
      try {
        plugin.start();
      } catch (error) {
        logger.error(`插件启动失败：${error?.message || error}`);
      }
      started = true;
    }
    void ensureConfig();
    scheduleTimer();
  }

  function stop() {
    clearTimer();
  }

  function getState() {
    return {
      config: { ...config, apiKey: config.apiKey ? "[已配置]" : "" },
      cache: { ...cache },
      deviceCount: devices.size,
      fingerprintCount: confirmedSignatures.size,
      refreshing: Boolean(refreshPromise),
      failures,
    };
  }

  return { start, stop, register, refresh, whenIdle, handlers, getState };
}

module.exports = {
  KEY_CIDS,
  USAGE_METRICS,
  createPluginRuntime,
  emptyCache,
  findMessageConfig,
  keyMetric,
  summarizeRecentLogs,
  hardenTransport,
};
