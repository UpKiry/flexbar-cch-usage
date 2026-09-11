const test = require("node:test");
const assert = require("node:assert/strict");
const { GlobalFonts } = require("@napi-rs/canvas");
const { WIDTH, COMPACT_WIDTH, HEIGHT, REQUIRED_GLYPHS, renderKey } = require("../src/render");

const config = { cchUrl: "https://hub.example", apiKey: "configured", dateRangeDays: 7 };
const state = {
  quota: { keyCurrent5hUsd: 8.4, keyLimit5hUsd: 10 },
  today: { calls: 128, costUsd: 3.2, currencyCode: "USD" },
  summary: { totalRequests: 1024, totalCost: 24.8, currencyCode: "USD" },
  stale: false,
};

test("renders every fixed key as a bounded PNG at full and compact widths", () => {
  for (const width of [WIDTH, COMPACT_WIDTH]) {
    for (const cid of [
      "com.upkiry.flexbarcchusage.overview",
      "com.upkiry.flexbarcchusage.quota",
      "com.upkiry.flexbarcchusage.today",
      "com.upkiry.flexbarcchusage.range",
    ]) {
      const image = renderKey(cid, state, config, width);
      assert.equal(image.width, width);
      assert.equal(image.height, HEIGHT);
      assert.match(image.dataUrl, /^data:image\/png;base64,/);
      assert.ok(image.dataUrl.length > 1000);
      assert.ok(image.fingerprint.includes(cid));
    }
  }
});

test("bundled font covers every glyph used by the renderer", () => {
  renderKey("com.upkiry.flexbarcchusage.overview", state, config, WIDTH);
  for (const glyph of REQUIRED_GLYPHS) assert.equal(GlobalFonts.has("FlexCJK", glyph), true, `missing glyph: ${glyph}`);
});

test("renders safe fixed states without arbitrary API error text", () => {
  const unconfigured = renderKey("com.upkiry.flexbarcchusage.overview", { stale: true, error: "secret upstream response" }, {}, WIDTH);
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

test("keeps extreme values bounded across twenty data sets", () => {
  for (let index = 0; index < 20; index += 1) {
    const extreme = {
      quota: { keyCurrent5hUsd: index === 0 ? 0 : 10 ** (index % 6), keyLimit5hUsd: index % 4 === 0 ? null : 10 ** ((index + 1) % 6) },
      today: { calls: index % 3 === 0 ? 10 ** 12 : index * 17, costUsd: index % 5 === 0 ? 0 : 10 ** (index % 5), currencyCode: "USD" },
      summary: { totalRequests: index * 1000000, totalCost: index % 2 ? 999999.99 : 0, currencyCode: "USD" },
      stale: index % 4 === 0,
    };
    for (const cid of [
      "com.upkiry.flexbarcchusage.overview",
      "com.upkiry.flexbarcchusage.quota",
      "com.upkiry.flexbarcchusage.today",
      "com.upkiry.flexbarcchusage.range",
    ]) {
      const image = renderKey(cid, extreme, config, index % 2 ? WIDTH : COMPACT_WIDTH);
      assert.equal(image.width, index % 2 ? WIDTH : COMPACT_WIDTH);
      assert.equal(image.height, HEIGHT);
      assert.match(image.dataUrl, /^data:image\/png;base64,/);
    }
  }
});

test("visual fingerprint excludes fetch timestamp and changes with displayed values", () => {
  const first = renderKey("com.upkiry.flexbarcchusage.today", state, config, WIDTH);
  const same = renderKey("com.upkiry.flexbarcchusage.today", { ...state, fetchedAt: Date.now() + 1 }, config, WIDTH);
  const changed = renderKey("com.upkiry.flexbarcchusage.today", {
    ...state,
    today: { ...state.today, calls: 129 },
  }, config, WIDTH);
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});
