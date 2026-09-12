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
  dateRangeDays: 7,
  now: () => Date.parse("2026-09-12T01:00:00.000Z"),
  timeoutSignal: () => undefined,
};

test("loads all V1 endpoints with one login and Shanghai date range", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/auth/login")) return response(200, { ok: true }, { "set-cookie": "auth-token=session-1; Path=/" });
    if (url.endsWith("/api/v1/me/quota")) return response(200, { keyCurrent5hUsd: 1 });
    if (url.endsWith("/api/v1/me/today")) return response(200, { calls: 2 });
    return response(200, { totalRequests: 3 });
  };
  const client = new HubClient({ ...baseConfig, fetchImpl });
  const result = await client.load();

  assert.deepEqual(result.today, { calls: 2 });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  const summary = calls.find((call) => call.url.includes("stats-summary"));
  assert.match(summary.url, /startDate=2026-09-06&endDate=2026-09-12/);
  for (const call of calls.filter((item) => !item.url.endsWith("/api/auth/login"))) {
    assert.equal(call.options.headers.Cookie, "auth-token=session-1");
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), { key: "secret-api-key" });
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
  assert.deepEqual(sleeps, [500]);

  client.cookie = "auth-token=abc";
  client.fetchImpl = async () => response(400, { detail: "secret-api-key auth-token=abc" });
  await assert.rejects(
    client.request("/api/v1/me/today", { headers: { "X-Test": "1" } }, true),
    (error) => !error.message.includes("secret-api-key") && !error.message.includes("auth-token=abc"),
  );
});
