const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvas } = require("@napi-rs/canvas");
const { WIDTH, COMPACT_WIDTH, HEIGHT, REQUIRED_GLYPHS, renderKey, fontFamily } = require("../src/render");

const config = { cchUrl: "https://hub.example", apiKey: "configured" };
const state = {
  quota: { keyCurrent5hUsd: 8.4, keyLimit5hUsd: 10 },
  today: { calls: 128, costUsd: 3.2, currencyCode: "USD" },
  summaries: {
    "7d": { totalRequests: 1024, totalCost: 24.8, currencyCode: "USD" },
    "1m": { totalRequests: 4096, totalCost: 64.8, currencyCode: "USD" },
  },
  stale: false,
};

test("renders every fixed key as a bounded PNG at full and compact widths", () => {
  for (const width of [WIDTH, COMPACT_WIDTH]) {
    for (const [cid, data] of [
      ["com.upkiry.flexbarcchusage.quota", {}],
      ["com.upkiry.flexbarcchusage.usage", { range: "5h" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "1d" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "7d" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "1m" }],
    ]) {
      const image = renderKey(cid, state, config, width, data);
      assert.equal(image.width, width);
      assert.equal(image.height, HEIGHT);
      assert.match(image.dataUrl, /^data:image\/png;base64,/);
      assert.ok(image.dataUrl.length > 1000);
      assert.ok(image.fingerprint.includes(cid));
    }
  }
});

test("系统字体实际画出渲染器用到的每个字形", () => {
  // 元数据检查（如 GlobalFonts.has）发现不了空字形，纯像素非空检查又发现不了
  // 豆腐块占位框，这里逐像素对比：每个字形必须真的画出内容，且不能等于
  // 未分配码位 U+0378 渲染出的 .notdef 占位框。
  const paint = (glyph) => {
    const canvas = createCanvas(64, 64);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 64, 64);
    ctx.font = `700 40px ${fontFamily()}, sans-serif`;
    ctx.fillStyle = "#fff";
    ctx.fillText(glyph, 8, 48);
    return Buffer.from(ctx.getImageData(0, 0, 64, 64).data);
  };
  const lit = (data) => {
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 40) count += 1;
    return count;
  };
  const notdef = paint("\u0378");
  assert.ok(lit(notdef) >= 5, "占位框基线没有画出来，检查方式失效");
  const seen = new Set();
  for (const glyph of REQUIRED_GLYPHS) {
    if (glyph === " " || seen.has(glyph)) continue;
    seen.add(glyph);
    const data = paint(glyph);
    assert.ok(lit(data) >= 5, `字形没有画出来: ${glyph}`);
    assert.equal(data.equals(notdef), false, `字形画成了占位框: ${glyph}`);
  }
});

test("renders safe fixed states without arbitrary API error text", () => {
  const unconfigured = renderKey("com.upkiry.flexbarcchusage.usage", { stale: true, error: "secret upstream response" }, {}, WIDTH, { range: "1d" });
  assert.equal(unconfigured.view.status, "未配置");
  assert.equal(unconfigured.view.value, "请配置 CC Hub");
  assert.ok(!unconfigured.dataUrl.includes("secret upstream response"));

  const critical = renderKey("com.upkiry.flexbarcchusage.quota", {
    ...state,
    quota: { keyCurrent5hUsd: 9.8, keyLimit5hUsd: 10 },
    stale: true,
  }, config, WIDTH);
  assert.equal(critical.view.tone, "critical");
  assert.equal(critical.view.status, "数据过期");
});

test("quota renders current usage and limit together", () => {
  const rendered = renderKey("com.upkiry.flexbarcchusage.quota", state, config, WIDTH, { range: "7d" });
  assert.equal(rendered.view.label, "配额 · 5 小时");
  assert.match(rendered.view.value, /\$8\.40\/\$10\.00/);
  assert.match(rendered.view.value, /84%/);
});

test("区分未知金额与未设置的额度限制", () => {
  const quota = renderKey("com.upkiry.flexbarcchusage.quota", {
    quota: { keyCurrent5hUsd: null, keyLimit5hUsd: 1 },
    stale: false,
  }, config, WIDTH);
  assert.match(quota.view.value, /^-\/\$1\.00/);

  const usage = renderKey("com.upkiry.flexbarcchusage.usage", {
    today: { calls: 1, costUsd: null },
    stale: false,
  }, config, WIDTH, { range: "1d" });
  assert.match(usage.view.value, /1 次 · -/);
});

test("根据接口字段渲染 Token、缓存、最近调用和配额状态指标", () => {
  const metricState = {
    quota: {
      keyCurrent5hUsd: 8.4,
      keyLimit5hUsd: 10,
      keyIsEnabled: false,
      keyCurrentConcurrentSessions: 2,
      keyLimitConcurrentSessions: 4,
    },
    today: { inputTokens: 1000, outputTokens: 200, calls: 3, costUsd: 0.4, currencyCode: "USD" },
    summaries: {
      "7d": { totalRequests: 10, totalCost: 1.2, totalInputTokens: 700, totalOutputTokens: 200, totalCacheReadTokens: 80, totalCacheCreationTokens: 20, totalCacheCreation5mTokens: 12, totalCacheCreation1hTokens: 8, currencyCode: "USD" },
    },
    recentLogs: {
      items: [
        { model: "claude-haiku-4", statusCode: 200, duration: 100, cacheInputTotal: 100, actualCacheRate: 0.9, createdAt: "2026-09-12T00:00:00.000Z" },
        { model: "claude-sonnet-4", statusCode: 503, duration: 300, createdAt: "2026-09-12T01:00:00.000Z" },
      ],
    },
    stale: false,
  };
  const token = renderKey("com.upkiry.flexbarcchusage.usage", metricState, config, WIDTH, { range: "1d", metric: "tokens" });
  assert.match(token.view.label, /Token/);
  assert.match(token.view.value, /1K\+200 Token/);

  const cache = renderKey("com.upkiry.flexbarcchusage.usage", metricState, config, WIDTH, { range: "7d", metric: "cache" });
  assert.match(cache.view.value, /80读\/20写/);
  assert.match(cache.view.status, /5m 12/);
  assert.match(cache.view.status, /1h 8/);

  const summary = renderKey("com.upkiry.flexbarcchusage.usage", metricState, config, WIDTH, { range: "7d", metric: "summary" });
  assert.match(summary.view.label, /汇总/);
  assert.match(summary.view.value, /10次/);

  const recent = renderKey("com.upkiry.flexbarcchusage.usage", metricState, config, WIDTH, { range: "1d", metric: "recent" });
  assert.match(recent.view.value, /2次 claude-sonnet-4/);
  assert.match(recent.view.status, /失败 1/);
  assert.match(recent.view.status, /200ms/);
  assert.match(recent.view.status, /缓存/);

  const quota = renderKey("com.upkiry.flexbarcchusage.quota", metricState, config, WIDTH);
  assert.equal(quota.view.tone, "critical");
  assert.match(quota.view.status, /禁用/);
  assert.match(quota.view.status, /并发 2\/4/);

  const expiring = renderKey("com.upkiry.flexbarcchusage.quota", {
    quota: { keyCurrent5hUsd: 1, keyLimit5hUsd: 2, expiresAt: "2026-09-30T00:00:00.000Z" },
    stale: false,
  }, config, WIDTH);
  assert.match(expiring.view.status, /到期 09-30/);
});

test("keeps extreme values bounded across twenty data sets", () => {
  for (let index = 0; index < 20; index += 1) {
    const extreme = {
      quota: { keyCurrent5hUsd: index === 0 ? 0 : 10 ** (index % 6), keyLimit5hUsd: index % 4 === 0 ? null : 10 ** ((index + 1) % 6) },
      today: { calls: index % 3 === 0 ? 10 ** 12 : index * 17, costUsd: index % 5 === 0 ? 0 : 10 ** (index % 5), currencyCode: "USD" },
      summaries: {
        "7d": { totalRequests: index * 1000000, totalCost: index % 2 ? 999999.99 : 0, currencyCode: "USD" },
        "1m": { totalRequests: index * 1000000, totalCost: index % 2 ? 999999.99 : 0, currencyCode: "USD" },
      },
      stale: index % 4 === 0,
    };
    for (const [cid, data] of [
      ["com.upkiry.flexbarcchusage.quota", {}],
      ["com.upkiry.flexbarcchusage.usage", { range: "5h" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "1d" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "7d" }],
      ["com.upkiry.flexbarcchusage.usage", { range: "1m" }],
    ]) {
      const image = renderKey(cid, extreme, config, index % 2 ? WIDTH : COMPACT_WIDTH, data);
      assert.equal(image.width, index % 2 ? WIDTH : COMPACT_WIDTH);
      assert.equal(image.height, HEIGHT);
      assert.match(image.dataUrl, /^data:image\/png;base64,/);
    }
  }
});

test("visual fingerprint excludes fetch timestamp and changes with displayed values", () => {
  const first = renderKey("com.upkiry.flexbarcchusage.usage", state, config, WIDTH, { range: "1d" });
  const same = renderKey("com.upkiry.flexbarcchusage.usage", { ...state, fetchedAt: Date.now() + 1 }, config, WIDTH, { range: "1d" });
  const changed = renderKey("com.upkiry.flexbarcchusage.usage", {
    ...state,
    today: { ...state.today, calls: 129 },
  }, config, WIDTH, { range: "1d" });
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});
