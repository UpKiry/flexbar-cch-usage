const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const UI_DIR = path.join(__dirname, "..", "com.upkiry.flexbarcchusage.plugin", "ui");
const read = (name) => fs.readFileSync(path.join(UI_DIR, name), "utf8");

test("usage and quota settings do not emit while mounting", () => {
  const usage = read("usage.vue");
  const quota = read("quota.vue");
  assert.match(usage, /mounted\(\)\s*\{\s*this\.range\s*=\s*this\.readRange\(\);\s*\}/);
  assert.doesNotMatch(usage, /mounted\(\)[\s\S]*emitUpdate\(\)/);
  assert.doesNotMatch(quota, /mounted\(|emitUpdate\(|v-radio/);
  for (const label of ["5 小时", "1 天", "7 天", "30 天"]) assert.match(usage, new RegExp(label));
});

test("connection test uses backend message without persisting config", () => {
  const source = read("configPage.vue");
  const testMethod = source.match(/async testConnection\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*\},/);
  assert.ok(testMethod, "testConnection method should be present");
  assert.doesNotMatch(testMethod[1], /saveConfig\(|setConfig\(/);
  assert.match(testMethod[1], /sendToBackend\(\{\s*action:\s*"testConnection"/);
  assert.match(source, /await this\.\$fd\.setConfig\(config\)/);
  assert.match(source, /action:\s*"applyConfig"/);
  assert.match(source, /const restart = globalThis\.window\?\.electronAPI\?\.pluginOperation/);
  assert.match(source, /restart\(\{\s*type:\s*"restart"/);
});
