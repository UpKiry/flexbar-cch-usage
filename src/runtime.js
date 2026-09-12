const fs = require("node:fs");
const path = require("node:path");
const { USAGE_RANGES, number, textNumber, compactMoney, normalizedConfig, normalizeUsageRange } = require("./core");
const { HubClient, redactSecrets } = require("./hub-client");
const { WIDTH: RENDER_WIDTH, renderKey } = require("./render");

const KEY_CIDS = new Set([
  "com.upkiry.flexbarcchusage.quota",
  "com.upkiry.flexbarcchusage.usage",
]);

function emptyCache() {
  return { quota: null, today: null, summaries: {}, fetchedAt: null, stale: true, error: null };
}

function keyRange(key) {
  if (key?.cid?.endsWith("quota")) return "5h";
  return normalizeUsageRange(key?.data?.range, "1d");
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

function hasConfig(value) {
  return Boolean(value && typeof value.cchUrl === "string" && value.cchUrl.trim()
    && typeof value.apiKey === "string" && value.apiKey.trim());
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

function createPluginRuntime({
  plugin,
  logger,
  HubClientClass = HubClient,
  renderKeyFn = renderKey,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
  configStorePath,
} = {}) {
  const keysByDevice = new Map();
  const renderedFingerprints = new Map();
  const pendingFingerprints = new Map();
  const drawQueues = new Map();
  const deviceGenerations = new Map();
  let config = {};
  let client;
  let cache = emptyCache();
  let refreshPromise;
  let refreshTimer;
  let configUpdatePromise = Promise.resolve();
  let registered = false;
  let started = false;
  let backupRestoreAttempted = false;

  function safeError(error) {
    return redactSecrets(error?.message || "查询失败", [config.apiKey, client?.cookie]);
  }

  function keyView(key, state = cache) {
    if (!config.cchUrl || !config.apiKey) return "请配置 CC Hub";
    const cid = key.cid;
    const suffix = state.stale ? " · 数据过期" : "";
    if (cid.endsWith("quota")) {
      const current = state.quota?.keyCurrent5hUsd;
      const limit = state.quota?.keyLimit5hUsd;
      const percent = number(current) !== null && number(limit) > 0
        ? ` ${Math.min(999, current / limit * 100).toFixed(0)}%`
        : "";
      return `配额 5 小时 ${compactMoney(current)}/${compactMoney(limit)}${percent}${suffix}`;
    }
    const range = keyRange(key);
    if (range === "5h") return `用量 5 小时 ${compactMoney(state.quota?.keyCurrent5hUsd, state.quota?.currencyCode)}${suffix}`;
    const data = range === "1d" ? state.today : state.summaries?.[range];
    const rangeLabel = { "1d": "1 天", "7d": "7 天", "1m": "30 天" }[range] || range;
    return `用量 ${rangeLabel} ${textNumber(data?.calls ?? data?.totalRequests)}次 ${compactMoney(data?.costUsd ?? data?.totalCost, data?.currencyCode)}${suffix}`;
  }

  function requiredRanges() {
    const ranges = new Set();
    for (const keys of keysByDevice.values()) {
      for (const key of keys.values()) {
        ranges.add(keyRange(key));
      }
    }
    return USAGE_RANGES.filter((range) => ranges.has(range));
  }

  function prepareKey(serialNumber, key) {
    if (!key || !KEY_CIDS.has(key.cid)) return null;
    const width = Number(key.width || key.style?.width || RENDER_WIDTH);
    const rendered = renderKeyFn(key.cid, cache, config, width, key.data || {});
    const fingerprintKey = `${serialNumber}:${key.uid || key.cid}`;
    if (renderedFingerprints.get(fingerprintKey) === rendered.fingerprint
      || pendingFingerprints.get(fingerprintKey) === rendered.fingerprint) return null;
    key.style = {
      ...(key.style || {}),
      width: rendered.width,
      showTitle: false,
      showIcon: false,
      showImage: true,
    };
    key.title = keyView(key);
    pendingFingerprints.set(fingerprintKey, rendered.fingerprint);
    return {
      serialNumber,
      generation: deviceGenerations.get(serialNumber) || 0,
      key,
      image: rendered.dataUrl,
      fingerprintKey,
      fingerprint: rendered.fingerprint,
    };
  }

  function sendDraws(updates) {
    return Promise.all(updates.map((update) => {
      const previous = drawQueues.get(update.serialNumber) || Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        if (!keysByDevice.has(update.serialNumber)
          || (deviceGenerations.get(update.serialNumber) || 0) !== update.generation) {
          pendingFingerprints.delete(update.fingerprintKey);
          return;
        }
        try {
          await plugin.draw(update.serialNumber, update.key, "base64", update.image);
          renderedFingerprints.set(update.fingerprintKey, update.fingerprint);
        } catch (error) {
          pendingFingerprints.delete(update.fingerprintKey);
          logger.error("更新 Flexbar 按键失败", error);
        }
      });
      drawQueues.set(update.serialNumber, next);
      return next;
    }));
  }

  function drawAll() {
    const updates = [];
    for (const [serial, keys] of keysByDevice) {
      for (const key of keys.values()) {
        const update = prepareKey(serial, key);
        if (update) updates.push(update);
      }
    }
    return sendDraws(updates);
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

  async function loadConfig(storedOverride) {
    let stored = storedOverride;
    if (stored === undefined) {
      try {
        stored = await readStoredConfig();
      } catch (error) {
        logger.warn(`读取 CC Hub 插件配置失败，将保留当前配置并稍后重试：${safeError(error)}`);
        return config;
      }
    }
    let next = normalizedConfig(stored);
    const backup = readConfigBackup(configStorePath);
    if (!hasConfig(next) && backup) {
      next = backup;
      if (!backupRestoreAttempted && typeof plugin.setConfig === "function") {
        backupRestoreAttempted = true;
        plugin.setConfig(next).catch((error) => logger.warn(`恢复插件配置失败：${safeError(error)}`));
      }
    }
    if (hasConfig(next)) writeConfigBackup(configStorePath, next);
    const changed = next.cchUrl !== config.cchUrl
      || next.apiKey !== config.apiKey
      || next.refreshIntervalSeconds !== config.refreshIntervalSeconds;
    config = next;
    if (changed || !client) client = config.cchUrl && config.apiKey ? new HubClientClass(config) : null;
    return config;
  }

  async function performRefresh(reason, storedConfig) {
    await loadConfig(storedConfig);
    if (!client) {
      cache = { ...cache, stale: true, error: "请在插件配置中设置 CC Hub URL 和 API Key" };
      await drawAll();
      return cache;
    }
    try {
      const data = await client.load(requiredRanges());
      cache = {
        ...emptyCache(),
        ...data,
        summaries: data.summaries || {},
        fetchedAt: now(),
        stale: false,
        error: null,
      };
      await drawAll();
      return cache;
    } catch (error) {
      cache = { ...cache, stale: true, error: safeError(error) };
      logger.error(`CC Hub ${reason}失败：${cache.error}`);
      await drawAll();
      return cache;
    }
  }

  function refresh(reason = "定时刷新", storedConfig) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = performRefresh(reason, storedConfig).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function restartTimer() {
    if (refreshTimer) clearIntervalFn(refreshTimer);
    refreshTimer = setIntervalFn(() => refresh(), config.refreshIntervalSeconds * 1000);
  }

  function forgetDevice(serialNumber) {
    deviceGenerations.set(serialNumber, (deviceGenerations.get(serialNumber) || 0) + 1);
    keysByDevice.delete(serialNumber);
    drawQueues.delete(serialNumber);
    for (const key of renderedFingerprints.keys()) {
      if (key.startsWith(`${serialNumber}:`)) {
        renderedFingerprints.delete(key);
        pendingFingerprints.delete(key);
      }
    }
  }

  const handlers = {
    async alive(payload) {
      const serial = payload?.serialNumber;
      if (!serial) return;
      forgetDevice(serial);
      const keys = new Map();
      for (const key of payload.keys || []) {
        if (KEY_CIDS.has(key.cid)) keys.set(key.uid || key.cid, key);
      }
      keysByDevice.set(serial, keys);
      await refresh("启动刷新");
      restartTimer();
    },

    async data(payload) {
      const key = payload?.data?.key;
      if (!key || !KEY_CIDS.has(key.cid)) return { status: "error", message: "未知按键" };
      const serial = payload?.serialNumber;
      if (serial && keysByDevice.has(serial)) {
        keysByDevice.get(serial).set(key.uid || key.cid, key);
        renderedFingerprints.delete(`${serial}:${key.uid || key.cid}`);
        pendingFingerprints.delete(`${serial}:${key.uid || key.cid}`);
      }
      await refresh("点击刷新");
      return cache.error
        ? { status: "error", message: cache.error }
        : { status: "success", message: "已刷新" };
    },

    configUpdated(payload) {
      const storedConfig = payload?.config || payload?.data?.config || {};
      writeConfigBackup(configStorePath, storedConfig);
      const update = configUpdatePromise.then(async () => {
        if (refreshPromise) await refreshPromise;
        client = null;
        cache = emptyCache();
        renderedFingerprints.clear();
        await refresh("配置更新", storedConfig);
        restartTimer();
      });
      configUpdatePromise = update.catch(() => {});
      return update;
    },

    async deviceStatus(devices) {
      let connected = false;
      const list = Array.isArray(devices) ? devices : devices ? [devices] : [];
      for (const device of list) {
        const serial = device?.serialNumber || device?.serial;
        if (device?.status === "disconnected" && serial) forgetDevice(serial);
        if (device?.status === "connected") connected = true;
      }
      if (connected) await refresh("设备连接");
    },

    async uiMessage(payload) {
      const message = payload?.data?.data && typeof payload.data.data === "object"
        ? { ...payload, ...payload.data, ...payload.data.data }
        : payload?.data && typeof payload.data === "object"
          ? { ...payload, ...payload.data }
          : payload || {};
      if (message.action === "getConfig") {
        const current = await loadConfig();
        return { status: "success", config: { ...current } };
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
        const testClient = new HubClientClass(testConfig);
        await testClient.load();
        return { status: "success", message: "连接成功" };
      } catch (error) {
        return { status: "error", message: redactSecrets(error?.message || "连接失败", [testConfig.apiKey]) };
      }
    },
  };

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
      // Bind it once so device/plugin reconnects do not terminate the backend.
      if (plugin.transport && typeof plugin.transport.start === "function" && !plugin.transport.start.__flexbarBound) {
        const boundStart = plugin.transport.start.bind(plugin.transport);
        Object.defineProperty(boundStart, "__flexbarBound", { value: true });
        plugin.transport.start = boundStart;
      }
      plugin.start();
      started = true;
    }
  }

  function stop() {
    if (refreshTimer) clearIntervalFn(refreshTimer);
    refreshTimer = null;
  }

  function getState() {
    return {
      config: { ...config, apiKey: config.apiKey ? "[已配置]" : "" },
      cache: { ...cache },
      deviceCount: keysByDevice.size,
      fingerprintCount: renderedFingerprints.size,
      refreshing: Boolean(refreshPromise),
    };
  }

  return { start, stop, register, refresh, handlers, getState };
}

module.exports = { KEY_CIDS, createPluginRuntime, emptyCache, findMessageConfig };
