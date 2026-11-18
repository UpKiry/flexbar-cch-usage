const test = require("node:test");
const assert = require("node:assert/strict");
const { HubClient } = require("../src/hub-client");

function response(status, body, headers = {}) {
  const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      get: (name) => values[name.toLowerCase()] || null,
      getSetCookie: () => values["set-cookie"] ? [values["set-cookie"]] : [],
    },
  };
}

const baseConfig = {
  cchUrl: "https://hub.example",
  apiKey: "secret-api-key",
  now: () => Date.parse("2026-09-12T01:00:00.000Z"),
  timeoutSignal: () => undefined,
};

test("loads requested endpoints with Shanghai date ranges", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/login")) return response(200, { ok: true }, { "set-cookie": "auth-token=session-1; Path=/" });
    if (url.endsWith("/api/v1/me/quota")) return response(200, { keyCurrent5hUsd: 1 });
    if (url.endsWith("/api/v1/me/today")) return response(200, { calls: 2 });
    return response(200, { totalRequests: 3 });
  };
  const client = new HubClient({ ...baseConfig, fetchImpl });
  const result = await client.load(["1d", "7d", "1m"]);

  assert.deepEqual(result.today, { calls: 2 });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  const summary = calls.find((call) => call.url.includes("stats-summary"));
  assert.match(summary.url, /startDate=2026-09-06&endDate=2026-09-12/);
  assert.ok(calls.some((call) => call.url.includes("startDate=2026-08-14&endDate=2026-09-12")));
  for (const call of calls.filter((item) => !item.url.endsWith("/api/auth/login"))) {
    assert.equal(call.options.headers.Cookie, "auth-token=session-1");
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), { key: "secret-api-key" });
});

test("only requests data needed by configured ranges", async () => {
  const urls = [];
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/api/auth/login")) return response(200, {}, { "set-cookie": "auth-token=session-1; Path=/" });
      return response(200, { keyCurrent5hUsd: 1 });
    },
  });
  const result = await client.load(["5h", "5h"]);
  assert.deepEqual(result.summaries, {});
  assert.equal(result.today, undefined);
  assert.equal(urls.filter((url) => url.includes("stats-summary")).length, 0);
  assert.equal(urls.filter((url) => url.endsWith("/api/v1/me/quota")).length, 1);
});

test("deduplicates concurrent login and re-authenticates once after 401", async () => {
  let loginCount = 0;
  let quotaCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/auth/login")) {
      loginCount += 1;
      return response(200, {}, { "set-cookie": `auth-token=session-${loginCount}; Path=/` });
    }
    if (url.endsWith("/api/v1/me/quota")) {
      quotaCount += 1;
      if (quotaCount === 1) return response(401, { detail: "expired" });
    }
    return response(200, {});
  };
  const client = new HubClient({ ...baseConfig, fetchImpl });
  client.cookie = "auth-token=old";
  await client.request("/api/v1/me/quota");
  assert.equal(loginCount, 1);
  assert.equal(quotaCount, 2);
  assert.equal(client.cookie, "auth-token=session-1");
});

test("retries transient failures once and redacts API key and cookie", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new HubClient({
    ...baseConfig,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      return response(attempts === 1 ? 503 : 200, attempts === 1 ? { detail: "secret-api-key auth-token=abc" } : { ok: true });
    },
  });
  assert.deepEqual(await client.request("/api/v1/me/today"), { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [250]);

  client.cookie = "auth-token=abc";
  client.fetchImpl = async () => response(400, { detail: "secret-api-key auth-token=abc" });
  await assert.rejects(
    client.request("/api/v1/me/today", { headers: { "X-Test": "1" } }, true),
    (error) => !error.message.includes("secret-api-key") && !error.message.includes("auth-token=abc"),
  );
});

test("GET 网络错误按指数退避最多重试两次并限制 Retry-After", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new HubClient({
    ...baseConfig,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        if (attempts === 1) throw new Error("socket secret-api-key");
        return response(429, { error: "busy" }, { "retry-after": "99" });
      }
      return response(200, { calls: 1 });
    },
  });
  assert.deepEqual(await client.request("/api/v1/me/today"), { calls: 1 });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [250, 5000]);
});

test("登录 POST 失败不重试并校验对象响应", async () => {
  let attempts = 0;
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      attempts += 1;
      if (url.endsWith("/api/auth/login")) return response(503, { message: "temporary" });
      return response(200, []);
    },
  });
  await assert.rejects(client.login(), /temporary/);
  assert.equal(attempts, 1);
  client.cookie = "auth-token=session";
  await assert.rejects(client.request("/api/v1/me/today"), /顶层不是对象/);
});

test("调用日志支持分页并拒绝无效或重复游标", async () => {
  const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-09-12T00:00:00.000Z", id: 2 })).toString("base64url");
  const urls = [];
  let page = 0;
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      page += 1;
      return page === 1
        ? response(200, { items: [{ id: 1 }], pageInfo: { hasMore: true, nextCursor: cursor, limit: 1 } })
        : response(200, { items: [{ id: 2 }], pageInfo: { hasMore: false, nextCursor: null, limit: 1 } });
    },
  });
  client.cookie = "auth-token=session";
  const result = await client.getAllUsageLogs("2026-09-11", "2026-09-12", { pageSize: 1 });
  assert.deepEqual(result.items, [{ id: 1 }, { id: 2 }]);
  assert.equal(urls[1].searchParams.get("cursorId"), "2");
  assert.equal(result.pageInfo.fetchedPages, 2);

  const malformed = new HubClient({
    ...baseConfig,
    fetchImpl: async () => response(200, { items: [], pageInfo: { hasMore: true, nextCursor: "bad" } }),
  });
  malformed.cookie = "auth-token=session";
  await assert.rejects(malformed.getAllUsageLogs("2026-09-11", "2026-09-12"), /无法解析/);

  const invalidAlphabet = new HubClient({
    ...baseConfig,
    fetchImpl: async () => response(200, { items: [], pageInfo: { hasMore: true, nextCursor: "eyJpZCI6MX0+" } }),
  });
  invalidAlphabet.cookie = "auth-token=session";
  await assert.rejects(invalidAlphabet.getAllUsageLogs("2026-09-11", "2026-09-12"), /无法解析/);
});

test("最近日志限制为一页且不会把剩余页误判为失败", async () => {
  const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-09-12T00:00:00.000Z", id: 8 })).toString("base64url");
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async () => response(200, {
      items: [{ id: 1 }, { id: 2 }],
      pageInfo: { hasMore: true, nextCursor: cursor, limit: 2 },
    }),
  });
  client.cookie = "auth-token=session";
  const result = await client.getRecentUsageLogs({ limit: 2, maxPages: 1 });
  assert.deepEqual(result.items.map((item) => item.id), [1, 2]);
  assert.equal(result.pageInfo.partial, true);
  assert.equal(result.pageInfo.hasMore, true);
});

test("load 可按需请求受限最近日志且不改变旧返回结构", async () => {
  const calls = [];
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      if (url.endsWith("/api/auth/login")) return response(200, {}, { "set-cookie": "auth-token=session-1" });
      if (url.includes("/usage-logs?")) return response(200, {
        items: [{ id: 1 }], pageInfo: { hasMore: false, nextCursor: null, limit: 8 },
      });
      if (url.endsWith("/api/v1/me/quota")) return response(200, {});
      return response(200, {});
    },
  });
  const legacy = await client.load(["5h"]);
  assert.equal(Object.hasOwn(legacy, "recentLogs"), false);
  const result = await client.load(["5h"], { recentLogs: true, recentLimit: 8, recentDays: 1 });
  assert.equal(result.recentLogs.items.length, 1);
  const logsUrl = calls.find((url) => url.pathname.endsWith("/usage-logs"));
  assert.equal(logsUrl.searchParams.get("limit"), "8");
});

test("可选最近日志失败时仍保留核心数据", async () => {
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/v1/me/quota")) return response(200, { keyCurrent5hUsd: 1 });
      if (url.includes("/usage-logs?")) return response(400, { error: "recent unavailable" });
      return response(200, {});
    },
  });
  client.cookie = "auth-token=session";
  const result = await client.load(["5h"], { includeRecentLogs: true });
  assert.equal(result.quota.keyCurrent5hUsd, 1);
  assert.equal(result.recentLogs, undefined);
  assert.equal(result.recentError, "recent unavailable");
});

test("只有缓存指标需要时才请求每日汇总", async () => {
  const urls = [];
  const client = new HubClient({
    ...baseConfig,
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      if (url.endsWith("/api/v1/me/quota")) return response(200, {});
      if (url.endsWith("/api/v1/me/today")) return response(200, { calls: 1, inputTokens: 2, outputTokens: 3 });
      return response(200, { totalRequests: 1, totalCacheReadTokens: 4, totalCacheCreationTokens: 5 });
    },
  });
  client.cookie = "auth-token=session";
  const result = await client.load(["1d"], { includeDailySummary: true });
  const daily = urls.find((url) => url.pathname.endsWith("/stats-summary"));
  assert.equal(daily.searchParams.get("startDate"), "2026-09-12");
  assert.equal(daily.searchParams.get("endDate"), "2026-09-12");
  assert.equal(result.summaries["1d"].totalCacheReadTokens, 4);
});
