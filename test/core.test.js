const test = require("node:test");
const assert = require("node:assert/strict");
const {
  localDate,
  textNumber,
  money,
  compactMoney,
  amount,
  compactAmount,
  aggregateRecentSummary,
  aggregateUsageMetrics,
  normalizeMetric,
  normalizedConfig,
  normalizeUsageRange,
} = require("../src/core");

test("normalizes defaults, aliases, URL slashes and numeric bounds", () => {
  assert.deepEqual(normalizedConfig({}), {
    cchUrl: "",
    apiKey: "",
    refreshIntervalSeconds: 60,
  });
  assert.deepEqual(normalizedConfig({
    CCH_URL: " https://hub.example/// ",
    CCH_API_KEY: " key ",
    refreshIntervalSeconds: 1,
  }), {
    cchUrl: "https://hub.example",
    apiKey: "key",
    refreshIntervalSeconds: 15,
  });
});

test("formats finite values and safe fallbacks", () => {
  assert.equal(textNumber(128), "128");
  assert.equal(textNumber("128"), "-");
  assert.equal(money(1.2), "1.20 USD");
  assert.equal(money(null), "无限制");
  assert.equal(compactMoney(1.2), "$1.20");
  assert.equal(amount(null), "-");
  assert.equal(compactAmount(null), "-");
  assert.equal(compactMoney(Number.NaN), "-");
});

test("calculates Shanghai calendar dates deterministically", () => {
  assert.equal(localDate(new Date("2026-09-11T00:00:00.000Z")), "2026-09-11");
});

test("normalizes per-key usage ranges", () => {
  assert.equal(normalizeUsageRange("5h"), "5h");
  assert.equal(normalizeUsageRange("1m"), "1m");
  assert.equal(normalizeUsageRange("invalid"), "1d");
});

test("规范化显示指标及其别名", () => {
  assert.equal(normalizeMetric("tokens"), "tokens");
  assert.equal(normalizeMetric("calls"), "callsCost");
  assert.equal(normalizeMetric("latest"), "recent");
  assert.equal(normalizeMetric("unknown"), "callsCost");
});

test("按配置范围聚合接口返回的 Token 和缓存字段", () => {
  const state = {
    today: { calls: 3, costUsd: 0.4, inputTokens: 100, outputTokens: 25, currencyCode: "USD" },
    summaries: {
      "7d": {
        totalRequests: 10,
        totalCost: 1.2,
        totalInputTokens: 700,
        totalOutputTokens: 200,
        totalCacheReadTokens: 80,
        totalCacheCreationTokens: 20,
        currencyCode: "USD",
      },
    },
  };
  assert.deepEqual(aggregateUsageMetrics(state, "1d"), {
    calls: 3,
    cost: 0.4,
    currencyCode: "USD",
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    cacheCreationTokens: null,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    cacheReadTokens: null,
    cacheTokens: null,
  });
  assert.deepEqual(aggregateUsageMetrics(state, "7d"), {
    calls: 10,
    cost: 1.2,
    currencyCode: "USD",
    inputTokens: 700,
    outputTokens: 200,
    totalTokens: 900,
    cacheCreationTokens: 20,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    cacheReadTokens: 80,
    cacheTokens: 100,
  });
});

test("汇总最近调用且不保留原始请求内容", () => {
  const summary = aggregateRecentSummary({
    items: [
      { model: "model-a", statusCode: 200, duration: 100, inputTokens: 100, outputTokens: 20, cacheInputTotal: 40, createdAt: "2026-09-12T00:00:00.000Z" },
      { model: "model-b", statusCode: 503, duration: 300, inputTokens: 50, outputTokens: 10, createdAt: "2026-09-12T01:00:00.000Z", prompt: "不要出现在摘要" },
    ],
  });
  assert.equal(summary.count, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 0);
  assert.equal(summary.avgDuration, 200);
  assert.equal(summary.lastModel, "model-b");
  assert.equal(summary.lastStatus, 503);
  assert.equal(summary.totalInputTokens, 150);
  assert.equal(summary.totalOutputTokens, 30);
  assert.equal(summary.cacheHitRate, 40 / 140);
  assert.equal(Object.hasOwn(summary, "prompt"), false);
});

test("优先采用接口提供的实际缓存比例并保留缓存分段字段", () => {
  const summary = aggregateRecentSummary({
    items: [{
      inputTokens: 100,
      cacheInputTotal: 1_000,
      cacheReadInputTokens: 100,
      actualCacheRate: 0.8,
    }],
  });
  assert.equal(summary.cacheHitRate, 0.8);
  assert.deepEqual(aggregateUsageMetrics({
    totalCacheCreationTokens: 30,
    totalCacheCreation5mTokens: 10,
    totalCacheCreation1hTokens: 20,
    totalCacheReadTokens: 40,
  }), {
    calls: null,
    cost: null,
    currencyCode: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheCreationTokens: 30,
    cacheCreation5mTokens: 10,
    cacheCreation1hTokens: 20,
    cacheReadTokens: 40,
    cacheTokens: 70,
  });
});

test("把非 2xx 状态计为失败并单独记录缺失状态", () => {
  const summary = aggregateRecentSummary({
    items: [
      { statusCode: 302 },
      { statusCode: null },
      { statusCode: 200 },
    ],
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 1);
});
