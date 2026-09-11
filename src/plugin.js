const { plugin, logger } = require("@eniac/flexdesigner");
const { DEFAULTS, localDate, number, textNumber, money, compactMoney, normalizedConfig } = require("./core");
const { WIDTH: RENDER_WIDTH, renderKey } = require("./render");

const KEY_CIDS = new Set([
  "com.upkiry.flexbarcchusage.overview",
  "com.upkiry.flexbarcchusage.quota",
  "com.upkiry.flexbarcchusage.today",
  "com.upkiry.flexbarcchusage.range",
]);
const keysByDevice = new Map();
const renderedFingerprints = new Map();
let config = {};
let client;
let cache = { quota: null, today: null, summary: null, fetchedAt: null, stale: true, error: null };
let refreshPromise;
let refreshTimer;

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

class HubClient {
  constructor({ cchUrl, baseUrl, apiKey, dateRangeDays = DEFAULTS.dateRangeDays }) {
    this.baseUrl = cchUrl || baseUrl;
    this.apiKey = apiKey;
    this.dateRangeDays = dateRangeDays;
    this.cookie = null;
  }
  async request(path, options = {}, retried = false) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    let response;
    try { response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, signal: AbortSignal.timeout(30000) }); }
    catch (error) { throw new Error(`无法连接 CC Hub：${error.message || "网络错误"}`); }
    const bodyText = await response.text();
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { throw new Error(`CC Hub 返回了无效 JSON（HTTP ${response.status}）`); }
    if (response.status === 401 && !retried && path !== "/api/auth/login") {
      this.cookie = null; await this.login(); return this.request(path, options, true);
    }
    if ([429, 500, 502, 503, 504].includes(response.status) && !retried) {
      await new Promise((resolve) => setTimeout(resolve, 500)); return this.request(path, options, true);
    }
    if (!response.ok) throw new Error(body.detail || body.message || `CC Hub 请求失败（HTTP ${response.status}）`);
    return body;
  }
  async login() {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.apiKey }), signal: AbortSignal.timeout(30000),
      });
    } catch (error) { throw new Error(`无法连接 CC Hub：${error.message || "网络错误"}`); }
    const bodyText = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const cfChallenge = response.headers.get("cf-mitigated") === "challenge"
      || /text\/html/i.test(contentType)
      || /Just a moment|challenge-platform|Enable JavaScript and cookies/i.test(bodyText);
    if (cfChallenge) {
      throw new Error("CC Hub 被 Cloudflare 浏览器验证拦截，请为 API 路径关闭 Challenge 或配置 WAF 放行。");
    }
    let body = {}; try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { /* handled by status */ }
    if (!response.ok) throw new Error(body.detail || body.message || `登录失败（HTTP ${response.status}）`);
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
    this.cookie = cookies.map((item) => item.split(";", 1)[0]).find((item) => item.startsWith("auth-token="));
    if (!this.cookie) throw new Error("登录响应缺少 auth-token Cookie");
  }
  async load() {
    if (!this.cookie) await this.login();
    const end = localDate();
    const start = localDate(new Date(Date.now() - (this.dateRangeDays - 1) * 86400000));
    const [quota, today, summary] = await Promise.all([
      this.request("/api/v1/me/quota"),
      this.request("/api/v1/me/today"),
      this.request(`/api/v1/me/usage-logs/stats-summary?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`),
    ]);
    return { quota, today, summary };
  }
}

function keyView(cid, state = cache) {
  if (!config.cchUrl || !config.apiKey) return "请配置 CC Hub";
  const suffix = state.stale ? " · 数据过期" : "";
  if (cid.endsWith("overview")) return `总览 ${textNumber(state.today?.calls)}次 ${compactMoney(state.today?.costUsd, state.today?.currencyCode)}${suffix}`;
  if (cid.endsWith("quota")) {
    const current = state.quota?.keyCurrent5hUsd; const limit = state.quota?.keyLimit5hUsd;
    const percent = number(current) !== null && number(limit) > 0 ? ` ${Math.min(999, current / limit * 100).toFixed(0)}%` : "";
    return `配额 ${compactMoney(current)}/${compactMoney(limit)}${percent}${suffix}`;
  }
  if (cid.endsWith("today")) return `今日 ${textNumber(state.today?.calls)}次 ${compactMoney(state.today?.costUsd, state.today?.currencyCode)}${suffix}`;
  return `近${config.dateRangeDays}天 ${textNumber(state.summary?.totalRequests)}次 ${compactMoney(state.summary?.totalCost, state.summary?.currencyCode)}${suffix}`;
}
function prepareKey(serialNumber, key) {
  if (!key || !KEY_CIDS.has(key.cid)) return null;
  const width = Number(key.width || key.style?.width || RENDER_WIDTH);
  const rendered = renderKey(key.cid, cache, config, width);
  const fingerprintKey = `${serialNumber}:${key.uid}`;
  if (renderedFingerprints.get(fingerprintKey) === rendered.fingerprint) return null;
  key.style = { ...(key.style || {}), width: rendered.width, showTitle: false, showIcon: false, showImage: false };
  key.title = keyView(key.cid);
  return { serialNumber, key, image: rendered.dataUrl, fingerprintKey, fingerprint: rendered.fingerprint };
}
function sendDraws(updates) {
  return Promise.all(updates.map(({ serialNumber, key, image, fingerprintKey, fingerprint }) =>
    plugin.draw(serialNumber, key, "base64", image)
      .then(() => renderedFingerprints.set(fingerprintKey, fingerprint))
      .catch((error) => logger.error("更新 Flexbar 按键失败", error))));
}
function drawKey(serialNumber, key) {
  const update = prepareKey(serialNumber, key);
  return update ? sendDraws([update]) : Promise.resolve([]);
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
  if (!stored) {
    try {
      stored = await readStoredConfig();
    } catch (error) {
      logger.warn(`读取 CC Hub 插件配置失败，将保留当前配置并稍后重试：${error.message || "未知错误"}`);
      return config;
    }
  }
  const next = normalizedConfig(stored);
  const changed = next.cchUrl !== config.cchUrl || next.apiKey !== config.apiKey
    || next.dateRangeDays !== config.dateRangeDays;
  config = next;
  if (changed || !client) client = config.cchUrl && config.apiKey ? new HubClient(config) : null;
  return config;
}
async function refresh(reason = "定时刷新", storedConfig) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await loadConfig(storedConfig);
    if (!client) { cache = { ...cache, stale: true, error: "请在插件配置中设置 CC Hub URL 和 API Key" }; drawAll(); return cache; }
    try {
      const data = await client.load();
      cache = { ...data, fetchedAt: Date.now(), stale: false, error: null }; drawAll(); return cache;
    } catch (error) {
      cache = { ...cache, stale: true, error: error.message || "查询失败" };
      logger.error(`CC Hub ${reason}失败：${cache.error}`); drawAll(); return cache;
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
function restartTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refresh(), config.refreshIntervalSeconds * 1000);
}

plugin.on("plugin.alive", async (payload) => {
  const serial = payload?.serialNumber; if (!serial) return;
  for (const key of renderedFingerprints.keys()) if (key.startsWith(`${serial}:`)) renderedFingerprints.delete(key);
  const keys = new Map();
  for (const key of payload.keys || []) if (KEY_CIDS.has(key.cid)) keys.set(key.uid, key);
  keysByDevice.set(serial, keys);
  for (const key of keys.values()) drawKey(serial, key);
  await refresh("启动刷新"); restartTimer();
});
plugin.on("plugin.data", async (payload) => {
  const key = payload?.data?.key;
  if (!key || !KEY_CIDS.has(key.cid)) return { status: "error", message: "未知按键" };
  await refresh("点击刷新");
  return cache.error ? { status: "error", message: cache.error } : { status: "success", message: "已刷新" };
});
plugin.on("plugin.config.updated", async (payload) => {
  const storedConfig = payload?.config || payload?.data?.config;
  client = null; cache = { quota: null, today: null, summary: null, fetchedAt: null, stale: true, error: null };
  renderedFingerprints.clear();
  await refresh("配置更新", storedConfig); restartTimer();
});
plugin.on("device.status", (devices) => {
  for (const device of devices || []) if (device?.status === "connected") refresh("设备连接");
});
plugin.on("ui.message", async (payload) => {
  // Accept the documented direct payload and the wrapper used by older hosts.
  const message = payload?.data?.data && typeof payload.data.data === "object"
    ? { ...payload, ...payload.data, ...payload.data.data }
    : payload?.data && typeof payload.data === "object"
      ? { ...payload, ...payload.data }
      : payload || {};
  if (message.action !== "testConnection") return { status: "error", message: "未知操作" };
  const testConfig = normalizedConfig(
    findMessageConfig(message) || await plugin.getConfig().catch(() => ({})),
  );
  if (!testConfig.cchUrl || !testConfig.apiKey) return { status: "error", message: "请填写 CC Hub URL 和 API Key" };
  try {
    const testClient = new HubClient({
      baseUrl: testConfig.cchUrl,
      apiKey: testConfig.apiKey,
      dateRangeDays: testConfig.dateRangeDays,
    });
    await testClient.load();
    return { status: "success", message: "连接成功" };
  }
  catch (error) { return { status: "error", message: error.message || "连接失败" }; }
});
plugin.start();
module.exports = { localDate, money, normalizedConfig };
