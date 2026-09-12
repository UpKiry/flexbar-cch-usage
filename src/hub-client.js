const { USAGE_RANGES, localDate, normalizeUsageRange } = require("./core");

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function redactSecrets(value, secrets = []) {
  let message = String(value || "未知错误");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) {
      for (const candidate of [secret, encodeURIComponent(secret)]) {
        message = message.split(candidate).join("[已隐藏]");
      }
    }
  }
  return message.replace(/auth-token=[^;,\s]+/gi, "auth-token=[已隐藏]");
}

class HubClient {
  constructor({
    cchUrl,
    baseUrl,
    apiKey,
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    timeoutSignal = () => AbortSignal.timeout(30000),
  }) {
    this.baseUrl = cchUrl || baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.timeoutSignal = timeoutSignal;
    this.cookie = null;
    this.loginPromise = null;
  }

  errorMessage(value) {
    return redactSecrets(value, [this.apiKey, this.cookie]);
  }

  async fetchResponse(path, options) {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        signal: this.timeoutSignal(),
      });
      const bodyText = await response.text();
      return { response, bodyText };
    } catch (error) {
      throw new Error(`无法连接 CC Hub：${this.errorMessage(error.message || "网络错误")}`);
    }
  }

  async request(path, options = {}, retried = false) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    const requestCookie = this.cookie;
    if (requestCookie) headers.Cookie = requestCookie;

    let result;
    try {
      result = await this.fetchResponse(path, { ...options, headers });
    } catch (error) {
      if (!retried) {
        await this.sleep(500);
        return this.request(path, options, true);
      }
      throw error;
    }

    const { response, bodyText } = result;
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new Error(`CC Hub 返回了无效 JSON（HTTP ${response.status}）`);
    }

    if (response.status === 401 && !retried && path !== "/api/auth/login") {
      if (this.cookie === requestCookie) {
        this.cookie = null;
        await this.login();
      } else if (!this.cookie) {
        await this.login();
      }
      return this.request(path, options, true);
    }
    if (RETRYABLE_STATUSES.has(response.status) && !retried) {
      await this.sleep(500);
      return this.request(path, options, true);
    }
    if (!response.ok) {
      const detail = body.detail || body.message || `CC Hub 请求失败（HTTP ${response.status}）`;
      throw new Error(this.errorMessage(detail));
    }
    return body;
  }

  async performLogin() {
    const { response, bodyText } = await this.fetchResponse("/api/auth/login", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ key: this.apiKey }),
    });
    const contentType = response.headers.get("content-type") || "";
    const cfChallenge = response.headers.get("cf-mitigated") === "challenge"
      || /text\/html/i.test(contentType)
      || /Just a moment|challenge-platform|Enable JavaScript and cookies/i.test(bodyText);
    if (cfChallenge) {
      throw new Error("CC Hub 被 Cloudflare 浏览器验证拦截，请为 API 路径关闭 Challenge 或配置 WAF 放行。");
    }
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      // The status-specific fallback below is safer than exposing an HTML response.
    }
    if (!response.ok) {
      const detail = body.detail || body.message || `登录失败（HTTP ${response.status}）`;
      throw new Error(this.errorMessage(detail));
    }
    const cookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    this.cookie = cookies
      .map((item) => item.split(";", 1)[0].trim())
      .find((item) => item.startsWith("auth-token="));
    if (!this.cookie) throw new Error("登录响应缺少 auth-token Cookie");
  }

  async login() {
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  async load(ranges = USAGE_RANGES) {
    if (!this.cookie) await this.login();
    const requested = new Set((Array.isArray(ranges) ? ranges : [ranges]).map((range) => normalizeUsageRange(range)).filter(Boolean));
    const endTime = this.now();
    const end = localDate(new Date(endTime));
    const requests = [this.request("/api/v1/me/quota")];
    if (requested.has("1d")) requests.push(this.request("/api/v1/me/today"));
    const summaryRanges = [
      ["7d", 7],
      ["1m", 30],
    ].filter(([range]) => requested.has(range));
    for (const [range, days] of summaryRanges) {
      const start = localDate(new Date(endTime - (days - 1) * 86400000));
      requests.push(this.request(`/api/v1/me/usage-logs/stats-summary?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`));
    }
    const results = await Promise.all(requests);
    const quota = results[0];
    let resultIndex = 1;
    const today = requested.has("1d") ? results[resultIndex++] : undefined;
    return {
      quota,
      ...(requested.has("1d") ? { today } : {}),
      summaries: Object.fromEntries(summaryRanges.map(([range]) => [range, results[resultIndex++]])),
    };
  }
}

module.exports = { HubClient, redactSecrets };
