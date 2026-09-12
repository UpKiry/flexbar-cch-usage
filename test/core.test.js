const test = require("node:test");
const assert = require("node:assert/strict");
const {
  localDate,
  textNumber,
  money,
  compactMoney,
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
