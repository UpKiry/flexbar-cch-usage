const { USAGE_RANGES, localDate, normalizeUsageRange } = require("./core");

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

function redactSecrets(value, secrets = []) {
  let message;
  if (value instanceof Error) message = value.message;
  else if (typeof value === "string") message = value;
  else {
    try {
      message = JSON.stringify(value);
    } catch {
      message = String(value || "未知错误");
    }
  }
  message = String(message || "未知错误");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) {
      for (const candidate of [secret, encodeURIComponent(secret)]) {
        message = message.split(candidate).join("[已隐藏]");
      }
    }
  }
  return message.replace(/auth-token\s*=\s*[^;,\s]+/gi, "auth-token=[已隐藏]");
}

function asErrorDetail(body, fallback = "请求失败") {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fallback;
  return body.detail || body.message || body.error || fallback;
}

function ensureObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} 返回的 JSON 顶层不是对象`);
  }
  return value;
}

function validateOptionalFields(value, context, schema) {
  const validators = {
    array: Array.isArray,
    boolean: (item) => typeof item === "boolean",
    number: (item) => typeof item === "number" && Number.isFinite(item),
    numberOrNull: (item) => item === null || (typeof item === "number" && Number.isFinite(item)),
    stringOrNull: (item) => item === null || typeof item === "string",
  };
  for (const [field, type] of Object.entries(schema)) {
    if (value[field] !== undefined && !validators[type](value[field])) {
      throw new Error(`${context} 字段 ${field} 的类型无效，应为 ${type}`);
    }
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) || null;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === wanted);
  return key ? headers[key] : null;
}

function extractAuthCookie(headers) {
  let setCookies = [];
  if (headers) {
    if (typeof headers.getSetCookie === "function") {
      const values = headers.getSetCookie();
      setCookies = Array.isArray(values) ? values : (values ? [values] : []);
    }
    if (!setCookies.length) {
      const value = getHeader(headers, "set-cookie");
      if (value) setCookies = Array.isArray(value) ? value : [value];
    }
  }
  for (const setCookie of setCookies) {
    const match = /(?:^|[,;]\s*)auth-token\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i.exec(String(setCookie));
    const token = match && (match[1] || match[2]);
    if (token) return `auth-token=${token}`;
  }
  return undefined;
}

function decodeCursor(token) {
  try {
    if (typeof token !== "string" || !token) throw new Error("empty cursor");
    // 允许标准 Base64URL 的可选末尾填充，拒绝空白和普通 Base64 字符，避免把错误游标当成有效 JSON。
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token) || token.replace(/=+$/, "").length % 4 === 1) {
      throw new Error("invalid base64url cursor");
    }
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const numericId = Number(value?.id);
    if (value && typeof value === "object" && !Array.isArray(value)
      && typeof value.createdAt === "string" && value.createdAt
      && Number.isSafeInteger(numericId) && numericId > 0) {
      return { createdAt: value.createdAt, id: String(numericId) };
    }
  } catch {
    // 游标由服务端生成，无法解码时必须停止分页。
  }
  throw new Error("调用日志返回了无法解析的分页游标");
}

function retryAfterDelay(headers, attempt, baseDelay, maxDelay, now = () => Date.now()) {
  const value = getHeader(headers, "retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(maxDelay, Math.max(0, seconds * 1_000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(maxDelay, Math.max(0, date - now()));
  }
  return Math.min(maxDelay, baseDelay * (2 ** attempt));
}

function headersToObject(input) {
  if (!input) return {};
  if (typeof input === "object" && typeof input.entries === "function") return Object.fromEntries(input.entries());
  return { ...input };
}

class HubClient {
  constructor({
    cchUrl,
    baseUrl,
    apiKey,
    fetchImpl = globalThis.fetch,
    sleep,
    sleepImpl,
    now = () => Date.now(),
    timeoutSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
  }) {
    this.baseUrl = String(cchUrl || baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep || sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = now;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.timeoutSignal = timeoutSignal || (() => {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(this.timeoutMs);
      return undefined;
    });
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES;
    this.retryDelayMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = Number.isFinite(maxRetryDelayMs) && maxRetryDelayMs >= 0
      ? Math.min(MAX_RETRY_DELAY_MS, maxRetryDelayMs) : MAX_RETRY_DELAY_MS;
    this.cookie = null;
    this.loginPromise = null;
  }

  errorMessage(value) {
    return redactSecrets(value, [this.apiKey, this.cookie]);
  }

  buildUrl(path, searchParams) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (searchParams) url.search = new URLSearchParams(searchParams).toString();
    return url;
  }

  async fetchResponse(url, options, method, requestCookie) {
    const headers = headersToObject(options.headers);
    headers.Accept = headers.Accept || headers.accept || "application/json";
    if (requestCookie) headers.Cookie = requestCookie;
    const fetchOptions = { ...options, method, headers };
    if (!fetchOptions.signal) fetchOptions.signal = this.timeoutSignal(this.timeoutMs);
    const response = await this.fetchImpl(url.toString(), fetchOptions);
    let bodyText;
    try {
      bodyText = await response.text();
    } catch (error) {
      error.isResponseReadError = true;
      throw error;
    }
    return { response, bodyText };
  }

  async reauthenticate(requestCookie) {
    if (this.cookie === requestCookie) this.cookie = null;
    if (!this.cookie) await this.login();
  }

  async request(path, options = {}, legacyAttempt = 0) {
    const url = this.buildUrl(path);
    const method = String(options.method || "GET").toUpperCase();
    const canRetry = RETRYABLE_METHODS.has(method);
    let attempt = legacyAttempt === true ? this.maxRetries
      : (Number.isInteger(legacyAttempt) && legacyAttempt >= 0 ? legacyAttempt : 0);
    let reauthenticated = legacyAttempt === true;
    while (true) {
      const requestCookie = this.cookie;
      let result;
      try {
        result = await this.fetchResponse(url, options, method, requestCookie);
      } catch (error) {
        if (canRetry && !options.signal?.aborted && attempt < this.maxRetries) {
          await this.sleep(Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** attempt)));
          attempt += 1;
          continue;
        }
        throw new Error(`无法连接 CC Hub：${this.errorMessage(error.message || "网络错误")}`);
      }
      const { response, bodyText } = result;
      if (canRetry && RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await this.sleep(retryAfterDelay(response.headers, attempt, this.retryDelayMs, this.maxRetryDelayMs, this.now));
        attempt += 1;
        continue;
      }
      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new Error(`CC Hub 返回了无效 JSON（HTTP ${response.status}）`);
      }
      if (response.status === 401 && !reauthenticated && !url.pathname.endsWith("/api/auth/login")) {
        await this.reauthenticate(requestCookie);
        reauthenticated = true;
        continue;
      }
      if (!response.ok) {
        throw new Error(this.errorMessage(asErrorDetail(body, `请求失败（HTTP ${response.status}）`)));
      }
      return ensureObject(body, url.pathname);
    }
  }

  async performLogin() {
    const url = this.buildUrl("/api/auth/login");
    let result;
    try {
      result = await this.fetchResponse(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.apiKey }),
      }, "POST", null);
    } catch (error) {
      throw new Error(`无法连接 CC Hub：${this.errorMessage(error.message || "网络错误")}`);
    }
    const { response, bodyText } = result;
    const contentType = getHeader(response.headers, "content-type") || "";
    if (getHeader(response.headers, "cf-mitigated") === "challenge"
      || /text\/html/i.test(contentType)
      || /Just a moment|challenge-platform|Enable JavaScript and cookies/i.test(bodyText)) {
      throw new Error("CC Hub 被 Cloudflare 浏览器验证拦截，请为 API 路径关闭 Challenge 或配置 WAF 放行。");
    }
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new Error(`CC Hub 返回了无效 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(this.errorMessage(asErrorDetail(body, `登录失败（HTTP ${response.status}）`)));
    ensureObject(body, "/api/auth/login");
    const cookie = extractAuthCookie(response.headers);
    if (!cookie) throw new Error("登录响应缺少 auth-token Cookie");
    this.cookie = cookie;
    return body;
  }

  async login() {
    if (!this.loginPromise) this.loginPromise = this.performLogin().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  async getJson(path, searchParams) {
    return this.request(this.buildUrl(path, searchParams).toString());
  }

  async getQuota() {
    const body = await this.getJson("/api/v1/me/quota");
    validateOptionalFields(body, "/api/v1/me/quota", {
      keyIsEnabled: "boolean", keyCurrent5hUsd: "numberOrNull", keyLimit5hUsd: "numberOrNull",
      keyCurrentDailyUsd: "numberOrNull", keyLimitDailyUsd: "numberOrNull", keyCurrentWeeklyUsd: "numberOrNull",
      keyLimitWeeklyUsd: "numberOrNull", keyCurrentMonthlyUsd: "numberOrNull", keyLimitMonthlyUsd: "numberOrNull",
      keyCurrentTotalUsd: "numberOrNull", keyLimitTotalUsd: "numberOrNull",
    });
    return body;
  }

  async getToday() {
    const body = await this.getJson("/api/v1/me/today");
    validateOptionalFields(body, "/api/v1/me/today", {
      calls: "number", costUsd: "numberOrNull", inputTokens: "number", outputTokens: "number", modelBreakdown: "array",
    });
    return body;
  }

  async getStatsSummary(startDate, endDate) {
    const body = await this.getJson("/api/v1/me/usage-logs/stats-summary", { startDate, endDate });
    validateOptionalFields(body, "/api/v1/me/usage-logs/stats-summary", {
      totalRequests: "number", totalCost: "numberOrNull", totalTokens: "number", totalInputTokens: "number",
      totalOutputTokens: "number", totalCacheCreationTokens: "number", totalCacheReadTokens: "number",
      totalCacheCreation5mTokens: "number", totalCacheCreation1hTokens: "number",
    });
    return body;
  }

  async getAllUsageLogs(startDate, endDate, {
    pageSize = 100,
    maxPages = 1_000,
    allowPartial = false,
  } = {}) {
    const normalizedPageSize = Number.isInteger(Number(pageSize)) && Number(pageSize) > 0 ? Number(pageSize) : 100;
    const normalizedMaxPages = Number.isInteger(Number(maxPages)) && Number(maxPages) > 0 ? Number(maxPages) : 1_000;
    const items = [];
    const seenCursors = new Set();
    let cursor;
    let pageInfo;
    let fetchedPages = 0;
    while (true) {
      const params = { startDate, endDate, limit: String(normalizedPageSize) };
      if (cursor) {
        const decoded = decodeCursor(cursor);
        params.cursorCreatedAt = decoded.createdAt;
        params.cursorId = decoded.id;
      }
      const page = await this.getJson("/api/v1/me/usage-logs", params);
      if (!Array.isArray(page.items)) throw new Error("/api/v1/me/usage-logs 响应缺少 items 数组");
      if (!page.pageInfo || typeof page.pageInfo !== "object" || Array.isArray(page.pageInfo)) {
        throw new Error("/api/v1/me/usage-logs 响应缺少 pageInfo 对象");
      }
      pageInfo = page.pageInfo;
      validateOptionalFields(pageInfo, "/api/v1/me/usage-logs", { hasMore: "boolean", nextCursor: "stringOrNull", limit: "number" });
      if (typeof pageInfo.hasMore !== "boolean") throw new Error("/api/v1/me/usage-logs 响应缺少 pageInfo.hasMore 布尔值");
      items.push(...page.items);
      fetchedPages += 1;
      if (!pageInfo.hasMore) break;
      cursor = pageInfo.nextCursor;
      if (!cursor || seenCursors.has(cursor)) throw new Error("调用日志分页游标缺失或重复，已停止抓取以避免死循环");
      seenCursors.add(cursor);
      decodeCursor(cursor);
      if (fetchedPages >= normalizedMaxPages) {
        if (allowPartial) {
          return {
            items,
            pageInfo: {
              ...pageInfo,
              fetchedItems: items.length,
              fetchedPages,
              partial: true,
            },
          };
        }
        throw new Error(`调用日志超过 ${normalizedMaxPages} 页，已停止抓取`);
      }
    }
    return {
      items,
      pageInfo: { ...pageInfo, hasMore: false, nextCursor: null, fetchedItems: items.length, fetchedPages },
    };
  }

  async getRecentUsageLogs(options = {}, legacyRecentDays) {
    if (typeof options === "number") options = { limit: options, recentDays: legacyRecentDays };
    if (!options || typeof options !== "object" || Array.isArray(options)) options = {};
    const { limit = 8, recentDays = options.days || 1, maxPages = 1 } = options;
    const count = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 8;
    const days = Number.isInteger(Number(recentDays)) && Number(recentDays) > 0 ? Number(recentDays) : 1;
    const endTime = this.now();
    const endDate = localDate(new Date(endTime));
    const startDate = localDate(new Date(endTime - (days - 1) * 86400000));
    const result = await this.getAllUsageLogs(startDate, endDate, {
      pageSize: count,
      maxPages,
      allowPartial: true,
    });
    if (result.items.length > count) {
      result.items = result.items.slice(0, count);
      result.pageInfo = { ...result.pageInfo, fetchedItems: result.items.length };
    }
    return result;
  }

  async load(ranges = USAGE_RANGES, options = {}) {
    if (ranges && typeof ranges === "object" && !Array.isArray(ranges)) {
      options = { ...ranges, ...(options && typeof options === "object" ? options : {}) };
      ranges = options.ranges || USAGE_RANGES;
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) options = {};
    if (!this.cookie) await this.login();
    const requested = new Set((Array.isArray(ranges) ? ranges : [ranges]).map((range) => normalizeUsageRange(range)).filter(Boolean));
    const endTime = this.now();
    const end = localDate(new Date(endTime));
    const requests = [this.getQuota()];
    if (requested.has("1d")) requests.push(this.getToday());
    const requestedSummaryRanges = new Set(
      (Array.isArray(options.summaryRanges) ? options.summaryRanges : [])
        .map((range) => normalizeUsageRange(range, null))
        .filter(Boolean),
    );
    if (options.includeDailySummary) requestedSummaryRanges.add("1d");
    const summaryRanges = [["1d", 1], ["7d", 7], ["1m", 30]]
      .filter(([range]) => requestedSummaryRanges.has(range) || (range !== "1d" && requested.has(range)));
    for (const [range, days] of summaryRanges) {
      const start = localDate(new Date(endTime - (days - 1) * 86400000));
      requests.push(this.getStatsSummary(start, end));
    }
    const wantsRecentLogs = Boolean(options.recentLogs || options.includeRecentLogs);
    const recentPromise = wantsRecentLogs
      ? this.getRecentUsageLogs({
        limit: options.recentLimit, recentDays: options.recentDays,
        maxPages: options.recentMaxPages || options.maxPages || 1,
      }).then((value) => ({ value }), (error) => ({ error }))
      : null;
    const results = await Promise.all(requests);
    const quota = results[0];
    let resultIndex = 1;
    const today = requested.has("1d") ? results[resultIndex++] : undefined;
    const summaries = Object.fromEntries(summaryRanges.map(([range]) => [range, results[resultIndex++]]));
    let recentLogs;
    let recentError;
    if (recentPromise) {
      const recentResult = await recentPromise;
      if (recentResult.error) recentError = this.errorMessage(recentResult.error?.message || "最近调用查询失败");
      else recentLogs = recentResult.value;
    }
    return {
      quota,
      ...(requested.has("1d") ? { today } : {}),
      summaries,
      ...(recentLogs ? { recentLogs } : {}),
      ...(recentError ? { recentError } : {}),
    };
  }
}

module.exports = { HubClient, redactSecrets, decodeCursor, extractAuthCookie };
