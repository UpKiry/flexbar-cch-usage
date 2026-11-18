const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const UI_DIR = path.join(__dirname, "..", "com.upkiry.flexbarcchusage.plugin", "ui");
const read = (name) => fs.readFileSync(path.join(UI_DIR, name), "utf8");

test("用量设置页不会在挂载时发出修改", () => {
  const usage = read("usage.vue");
  assert.doesNotMatch(usage, /mounted\(\)[\s\S]*emitUpdate\(\)/);
  assert.doesNotMatch(usage, /mounted\(/);
  for (const label of ["5 小时", "1 天", "7 天", "30 天"]) assert.match(usage, new RegExp(label));
  for (const label of ["调用次数与成本", "输入与输出 Token", "缓存读写", "最近调用", "日期汇总"]) {
    assert.match(usage, new RegExp(label));
  }
  assert.match(usage, /data:\s*\{\s*\.\.\.data,\s*range:\s*this\.range,\s*metric:\s*this\.metric/);
  // 5 小时范围下其它指标没有数据，应当禁用。
  assert.match(usage, /metricAvailable/);
  assert.match(usage, /FIVE_HOUR_METRICS/);
});

test("用量设置页会忽略宿主回推的旧值，不把用户选择弹回去", () => {
  const usage = read("usage.vue");
  assert.match(usage, /this\.applied/);
  assert.match(usage, /if \(this\.applied && this\.applied\.range === range && this\.applied\.metric === metric\)/);
});

test("配额设置页不提供任何可编辑项", () => {
  const quota = read("quota.vue");
  assert.doesNotMatch(quota, /mounted\(|emitUpdate\(|v-radio/);
});

test("没有遗留的示例页面", () => {
  assert.equal(fs.existsSync(path.join(UI_DIR, "counter.vue")), false);
});

test("连接测试不落盘配置", () => {
  const source = read("configPage.vue");
  const testMethod = source.match(/async testConnection\(\)\s*\{([\s\S]*?)\n\s*\},\n\s*\},\n/);
  assert.ok(testMethod, "testConnection method should be present");
  assert.doesNotMatch(testMethod[1], /saveConfig\(|setConfig\(/);
  assert.match(testMethod[1], /sendToBackend\(\{\s*action:\s*"testConnection"/);
});

test("保存配置会检查宿主写入结果并保留失败信息", () => {
  const source = read("configPage.vue");
  assert.match(source, /await this\.\$fd\.setConfig\(config\)/);
  assert.match(source, /result\.status !== "success"/);
  assert.match(source, /action:\s*"applyConfig"/);
  assert.match(source, /const restart = globalThis\.window\?\.electronAPI\?\.pluginOperation/);
  assert.match(source, /restart\(\{\s*type:\s*"restart"/);
});

test("配置页不会用后台读到的旧配置覆盖用户输入", () => {
  const source = read("configPage.vue");
  assert.match(source, /if \(this\.dirty\) return;/);
  assert.match(source, /BACKEND_TIMEOUT_MS/);
});

test("留空的刷新间隔按默认值处理，不会变成 15 秒", () => {
  const source = read("configPage.vue");
  const serializable = source.match(/serializableConfig\(\)\s*\{([\s\S]*?)\n\s*\},\n/);
  assert.ok(serializable, "serializableConfig should be present");
  assert.match(serializable[1], /Number\.isFinite\(raw\) && raw > 0/);
  assert.match(serializable[1], /DEFAULT_CONFIG\.refreshIntervalSeconds/);
});
