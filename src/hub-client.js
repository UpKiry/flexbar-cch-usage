const { USAGE_RANGES, localDate, normalizeUsageRange, resolveTimeZone } = require("./core");

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// 单次请求的上限。旧实现是 60 秒，恰好等于默认刷新间隔：一个卡住的请求
// 会把整轮刷新拖到 3 分钟（60 秒 × 3 次尝试），期间所有按键都停止更新。
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
// 整轮抓取的上限，超过后剩余请求被主动取消。
const DEFAULT_DEADLINE_MS = 40_000;
// 登录失败后的冷却时间，避免每轮刷新都重复撞一次登录接口。
const DEFAULT_LOGIN_COOLDOWN_MS = 30_000;

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

const FIELD_VALIDATORS = {
  array: Array.isArray,
  boolean: (item) => typeof item === "boolean",
  number: (item) => typeof item === "number" && Number.isFinite(item),
  numberOrNull: (item) => item === null || (typeof item === "number" && Number.isFinite(item)),
  stringOrNull: (item) => item === null || typeof item === "string",
};

/**
 * 校验可选字段并丢弃类型不符的字段，而不是抛异常。
 *
 * 旧实现遇到类型不符会 throw，一个服务端字段类型变化就能让整轮刷新失败、
 * 所有按键一起过期。字段级问题只应影响那一个字段。
 */
function sanitizeOptionalFields(value, context, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, problems: [] };
  const result = { ...value };
  const problems = [];
  for (const [field, type] of Object.entries(schema)) {
    if (result[field] === undefined) continue;
    const validator = FIELD_VALIDATORS[type];
    if (validator && !validator(result[field])) {
      problems.push(`${context} 字段 ${field} 类型无效，已忽略`);
      delete result[field];
    }
  }
  return { value: result, problems };
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

/**
 * CC Hub 数据抓取客户端。
 *
 * 设计要点：
 * - 每个接口独立失败，一个接口挂掉不会连累其它按键；
 * - 每次请求都有超时，整轮抓取还有总时限；
 * - 登录失败有冷却，不会每轮都去撞登录接口；
 * - 日期窗口按用户本地时区计算。
 */
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
    deadlineMs = DEFAULT_DEADLINE_MS,
    loginCooldownMs = DEFAULT_LOGIN_COOLDOWN_MS,
    timeZone = resolveTimeZone(),
  }) {
    this.baseUrl = String(cchUrl || baseUrl || "").replace(/\/+$/, "");
    // 保留 URL 里的路径前缀，例如 https://host/cc-hub。
    this.basePath = (() => {
      try {
        return new URL(this.baseUrl).pathname.replace(/\/+$/, "");
      } catch {
        return "";
      }
    })();
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep || sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = now;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.timeoutSignal = timeoutSignal || (() => {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(this.timeoutMs);
      }
      return undefined;
    });
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES;
    this.retryDelayMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = Number.isFinite(maxRetryDelayMs) && maxRetryDelayMs >= 0
      ? Math.min(MAX_RETRY_DELAY_MS, maxRetryDelayMs) : MAX_RETRY_DELAY_MS;
    this.deadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEFAULT_DEADLINE_MS;
    this.loginCooldownMs = Number.isFinite(loginCooldownMs) && loginCooldownMs >= 0
      ? loginCooldownMs : DEFAULT_LOGIN_COOLDOWN_MS;
    this.timeZone = typeof timeZone === "string" && timeZone ? timeZone : resolveTimeZone();
    this.cookie = null;
    this.loginPromise = null;
    this.loginFailure = null;
    this.problems = [];
  }

  errorMessage(value) {
    return redactSecrets(value, [this.apiKey, this.cookie]);
  }

  /** 拼接基础地址与接口路径，保留 CC Hub 部署在子路径下的情况。 */
  buildUrl(path, searchParams) {
    const raw = String(path || "");
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (searchParams) url.search = new URLSearchParams(searchParams).toString();
      return url;
    }
    const suffix = raw.startsWith("/") ? raw : `/${raw}`;
    const url = new URL(`${this.basePath}${suffix}`, `${this.baseUrl}/`);
    if (searchParams) url.search = new URLSearchParams(searchParams).toString();
    return url;
  }

  /** 合并请求级超时信号与整轮抓取的超时信号。 */
  createSignal(options = {}) {
    const signals = [];
    const timeout = this.timeoutSignal(this.timeoutMs);
    if (timeout) signals.push(timeout);
    if (options.signal) signals.push(options.signal);
    if (!signals.length) return undefined;
    if (signals.length === 1) return signals[0];
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
      return AbortSignal.any(signals);
    }
    return signals[0];
  }

  async fetchResponse(url, options, method, requestCookie, signal) {
    const headers = headersToObject(options.headers);
    headers.Accept = headers.Accept || headers.accept || "application/json";
    if (requestCookie) headers.Cookie = requestCookie;
    const fetchOptions = { ...options, method, headers };
    fetchOptions.signal = signal || this.createSignal(options);
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
      const signal = this.createSignal(options);
      let result;
      try {
        result = await this.fetchResponse(url, options, method, requestCookie, signal);
      } catch (error) {
        // 超时导致的 abort 不再重试：重试只会把 15 秒拖成 30 秒。
        if (canRetry && !signal?.aborted && attempt < this.maxRetries) {
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
      // 401 必须先于 JSON 解析处理：反向代理返回的 401 页面常常是 HTML，
      // 旧实现会先抛"无效 JSON"，导致永远不会触发重新登录。
      if (response.status === 401 && !reauthenticated && !url.pathname.endsWith("/api/auth/login")) {
        reauthenticated = true;
        await this.reauthenticate(requestCookie);
        continue;
      }
      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new Error(`CC Hub 返回了无效 JSON（HTTP ${response.status}）`);
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
      }, "POST", null, this.createSignal());
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
    if (this.loginPromise) return this.loginPromise;
    if (this.loginFailure && this.now() - this.loginFailure.at < this.loginCooldownMs) {
      throw new Error(this.loginFailure.message);
    }
    this.loginPromise = this.performLogin()
      .then((body) => {
        this.loginFailure = null;
        return body;
      })
      .catch((error) => {
        this.loginFailure = { message: error.message, at: this.now() };
        throw error;
      })
      .finally(() => {
        this.loginPromise = null;
      });
    return this.loginPromise;
  }

  async getJson(path, searchParams, options = {}) {
    return this.request(this.buildUrl(path, searchParams).toString(), options);
  }

  async getQuota(options = {}) {
    const body = await this.getJson("/api/v1/me/quota", null, options);
    const { value, problems } = sanitizeOptionalFields(body, "/api/v1/me/quota", {
      keyIsEnabled: "boolean", keyCurrent5hUsd: "numberOrNull", keyLimit5hUsd: "numberOrNull",
      keyCurrentDailyUsd: "numberOrNull", keyLimitDailyUsd: "numberOrNull", keyCurrentWeeklyUsd: "numberOrNull",
      keyLimitWeeklyUsd: "numberOrNull", keyCurrentMonthlyUsd: "numberOrNull", keyLimitMonthlyUsd: "numberOrNull",
      keyCurrentTotalUsd: "numberOrNull", keyLimitTotalUsd: "numberOrNull",
    });
    this.problems.push(...problems);
    return value;
  }

  async getToday(options = {}) {
    const body = await this.getJson("/api/v1/me/today", null, options);
    const { value, problems } = sanitizeOptionalFields(body, "/api/v1/me/today", {
      calls: "numberOrNull", costUsd: "numberOrNull", inputTokens: "numberOrNull",
      outputTokens: "numberOrNull", modelBreakdown: "array",
    });
    this.problems.push(...problems);
    return value;
  }

  async getStatsSummary(startDate, endDate, options = {}) {
    const body = await this.getJson("/api/v1/me/usage-logs/stats-summary", { startDate, endDate }, options);
    const { value, problems } = sanitizeOptionalFields(body, "/api/v1/me/usage-logs/stats-summary", {
      totalRequests: "numberOrNull", totalCost: "numberOrNull", totalTokens: "numberOrNull",
      totalInputTokens: "numberOrNull", totalOutputTokens: "numberOrNull",
      totalCacheCreationTokens: "numberOrNull", totalCacheReadTokens: "numberOrNull",
      totalCacheCreation5mTokens: "numberOrNull", totalCacheCreation1hTokens: "numberOrNull",
    });
    this.problems.push(...problems);
    return value;
  }

  async getAllUsageLogs(startDate, endDate, {
    pageSize = 100,
    maxPages = 1_000,
    allowPartial = false,
    signal,
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
      const page = await this.getJson("/api/v1/me/usage-logs", params, { signal });
      if (!Array.isArray(page.items)) throw new Error("/api/v1/me/usage-logs 响应缺少 items 数组");
      if (!page.pageInfo || typeof page.pageInfo !== "object" || Array.isArray(page.pageInfo)) {
        throw new Error("/api/v1/me/usage-logs 响应缺少 pageInfo 对象");
      }
      pageInfo = page.pageInfo;
      const { value: safeInfo, problems } = sanitizeOptionalFields(
        pageInfo,
        "/api/v1/me/usage-logs",
        { hasMore: "boolean", nextCursor: "stringOrNull", limit: "number" },
      );
      this.problems.push(...problems);
      if (typeof safeInfo.hasMore !== "boolean") {
        throw new Error("/api/v1/me/usage-logs 响应缺少 pageInfo.hasMore 布尔值");
      }
      items.push(...page.items);
      fetchedPages += 1;
      if (!safeInfo.hasMore) break;
      cursor = safeInfo.nextCursor;
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error("调用日志分页游标缺失或重复，已停止抓取以避免死循环");
      }
      seenCursors.add(cursor);
      decodeCursor(cursor);
      if (fetchedPages >= normalizedMaxPages) {
        if (allowPartial) {
          return {
            items,
            pageInfo: {
              ...safeInfo,
              fetchedItems: items.length,
              fetchedPages,
              partial: true,
              truncated: true,
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

  async getRecentUsageLogs(options = {}, legacyRecentDays, extra = {}) {
    if (typeof options === "number") options = { limit: options, recentDays: legacyRecentDays };
    if (!options || typeof options !== "object" || Array.isArray(options)) options = {};
    const { limit = 8, recentDays = options.days || 1, maxPages = 1 } = options;
    const count = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 8;
    const days = Number.isInteger(Number(recentDays)) && Number(recentDays) > 0 ? Number(recentDays) : 1;
    const endTime = this.now();
    const endDate = localDate(new Date(endTime), this.timeZone);
    const startDate = localDate(new Date(endTime - (days - 1) * 86400000), this.timeZone);
    const result = await this.getAllUsageLogs(startDate, endDate, {
      pageSize: count,
      maxPages,
      allowPartial: true,
      signal: extra.signal,
    });
    let truncated = Boolean(result.pageInfo?.truncated) || Boolean(result.pageInfo?.hasMore);
    if (result.items.length > count) {
      result.items = result.items.slice(0, count);
      result.pageInfo = { ...result.pageInfo, fetchedItems: result.items.length };
      truncated = true;
    }
    return { ...result, truncated };
  }

  /**
   * 构造本轮要抓取的接口清单。
   * 每个条目对应一个数据分片，失败时只影响这一个分片。
   */
  buildPlan(ranges, options = {}) {
    const requested = new Set((Array.isArray(ranges) ? ranges : [ranges])
      .map((range) => normalizeUsageRange(range, null))
      .filter(Boolean));
    const endTime = this.now();
    const plan = [{ slice: "quota", run: (signal) => this.getQuota({ signal }) }];
    if (requested.has("1d")) plan.push({ slice: "today", run: (signal) => this.getToday({ signal }) });
    const requestedSummaryRanges = new Set(
      (Array.isArray(options.summaryRanges) ? options.summaryRanges : [])
        .map((range) => normalizeUsageRange(range, null))
        .filter(Boolean),
    );
    if (options.includeDailySummary) requestedSummaryRanges.add("1d");
    const summaryRanges = [["1d", 1], ["7d", 7], ["1m", 30]]
      .filter(([range]) => requestedSummaryRanges.has(range) || (range !== "1d" && requested.has(range)));
    for (const [range, days] of summaryRanges) {
      const start = localDate(new Date(endTime - (days - 1) * 86400000), this.timeZone);
      const end = localDate(new Date(endTime), this.timeZone);
      plan.push({ slice: range, run: (signal) => this.getStatsSummary(start, end, { signal }) });
    }
    if (options.recentLogs || options.includeRecentLogs) {
      plan.push({
        slice: "recent",
        run: (signal) => this.getRecentUsageLogs({
          limit: options.recentLimit,
          recentDays: options.recentDays,
          maxPages: options.recentMaxPages || options.maxPages || 1,
        }, undefined, { signal }),
      });
    }
    return plan;
  }

  /**
   * 抓取一轮数据。
   * 返回值里 errors 按分片记录失败原因，调用方据此决定哪一段数据过期。
   */
  async load(ranges = USAGE_RANGES, options = {}) {
    if (ranges && typeof ranges === "object" && !Array.isArray(ranges)) {
      options = { ...ranges, ...(options && typeof options === "object" ? options : {}) };
      ranges = options.ranges || USAGE_RANGES;
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) options = {};
    this.problems = [];
    // 登录失败属于整体性故障：没有会话就一个接口都取不到，直接抛给调用方。
    if (!this.cookie) await this.login();
    const plan = this.buildPlan(ranges, options);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const deadlineTimer = controller
      ? setTimeout(() => controller.abort(), this.deadlineMs)
      : null;
    if (deadlineTimer && typeof deadlineTimer.unref === "function") deadlineTimer.unref();
    let settled;
    try {
      settled = await Promise.all(plan.map(async (item) => {
        try {
          const value = await item.run(controller?.signal);
          return { slice: item.slice, value };
        } catch (error) {
          return { slice: item.slice, error: this.errorMessage(error?.message || "查询失败") };
        }
      }));
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    const quota = settled.find((item) => item.slice === "quota");
    const today = settled.find((item) => item.slice === "today");
    const summaries = {};
    const errors = {};
    for (const item of settled) {
      if (item.slice === "quota" || item.slice === "today" || item.slice === "recent") continue;
      if (item.error) errors[item.slice] = item.error;
      else summaries[item.slice] = item.value;
    }
    if (quota?.error) errors.quota = quota.error;
    if (today?.error) errors.today = today.error;
    if (settled.find((item) => item.slice === "recent")?.error) {
      errors.recent = settled.find((item) => item.slice === "recent").error;
    }
    const recentItem = settled.find((item) => item.slice === "recent");
    const recentLogs = recentItem && !recentItem.error ? recentItem.value : undefined;
    return {
      quota: quota && !quota.error ? quota.value : undefined,
      ...(today && !today.error ? { today: today.value } : {}),
      summaries,
      ...(recentLogs ? { recentLogs } : {}),
      ...(recentLogs?.truncated ? { recentTruncated: true } : {}),
      ...(errors.recent ? { recentError: errors.recent } : {}),
      errors,
      ...(this.problems.length ? { problems: [...this.problems] } : {}),
    };
  }

  /** 轻量连通性检查：登录成功即代表地址与密钥可用，配额接口缺失也不算失败。 */
  async ping() {
    if (!this.cookie) await this.login();
    try {
      await this.getQuota();
    } catch (error) {
      if (/HTTP 404/.test(error?.message || "")) return true;
      throw error;
    }
    return true;
  }
}

module.exports = { HubClient, redactSecrets, decodeCursor, extractAuthCookie, sanitizeOptionalFields };
