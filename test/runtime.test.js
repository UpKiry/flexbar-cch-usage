const test = require("node:test");
const assert = require("node:assert/strict");
const { createPluginRuntime } = require("../src/runtime");

const IDS = ["overview", "quota", "today", "range"];
const cid = (name) => `com.upkiry.flexbarcchusage.${name}`;

function makePlugin(config) {
  const handlers = new Map();
  const draws = [];
  return {
    handlers,
    draws,
    on: (event, handler) => handlers.set(event, handler),
    start: () => {},
    getConfig: async () => config,
    draw: async (serial, key, format, image) => draws.push({ serial, uid: key.uid, format, image, title: key.title }),
  };
}

function renderKeyFn(keyCid, state, config, width) {
  return {
    width: Number(width) >= 220 ? 240 : 180,
    dataUrl: `data:image/png;base64,${Buffer.from(`${keyCid}:${state.today?.calls || 0}`).toString("base64")}`,
    fingerprint: `${keyCid}:${state.today?.calls || 0}:${config.cchUrl || ""}`,
  };
}

function keys() {
  return IDS.map((name, index) => ({ cid: cid(name), uid: `key-${index}`, width: 240, style: {} }));
}

test("registers FlexDesigner events, isolates devices, and deduplicates draws", async () => {
  const plugin = makePlugin({ cchUrl: "https://hub.example", apiKey: "secret", refreshIntervalSeconds: 15, dateRangeDays: 7 });
  const logs = { errors: [], warns: [] };
  let loads = 0;
  class FakeClient {
    async load() {
      loads += 1;
      return { quota: {}, today: { calls: 12, costUsd: 1 }, summary: { totalRequests: 12, totalCost: 1 } };
    }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: (...args) => logs.errors.push(args.join(" ")), warn: (...args) => logs.warns.push(args.join(" ")) },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  runtime.start();
  assert.equal(plugin.handlers.size, 5);
  await plugin.handlers.get("plugin.alive")({ serialNumber: "A", keys: keys() });
  await plugin.handlers.get("plugin.alive")({ serialNumber: "B", keys: keys() });
  assert.equal(loads, 2);
  assert.equal(runtime.getState().deviceCount, 2);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "A").length, 8);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "B").length, 4);
  const before = plugin.draws.length;
  await plugin.handlers.get("plugin.data")({ data: { key: keys()[0] } });
  assert.equal(plugin.draws.length, before);
  await plugin.handlers.get("device.status")([{ serialNumber: "A", status: "disconnected" }]);
  assert.equal(runtime.getState().deviceCount, 1);
  assert.deepEqual(logs.errors, []);
  runtime.stop();
});

test("serializes config updates behind an in-flight refresh", async () => {
  const configA = { cchUrl: "https://a.example", apiKey: "key-a", refreshIntervalSeconds: 15, dateRangeDays: 7 };
  const configB = { cchUrl: "https://b.example", apiKey: "key-b", refreshIntervalSeconds: 20, dateRangeDays: 3 };
  const plugin = makePlugin(configA);
  let resolveA;
  const firstLoad = new Promise((resolve) => { resolveA = resolve; });
  const instances = [];
  class FakeClient {
    constructor(config) { this.config = config; instances.push(this); }
    load() {
      if (this.config.cchUrl === configA.cchUrl) return firstLoad;
      return Promise.resolve({ quota: {}, today: { calls: 2 }, summary: {} });
    }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  const inFlight = runtime.refresh("initial");
  await Promise.resolve();
  const update = runtime.handlers.configUpdated({ config: configB });
  resolveA({ quota: {}, today: { calls: 1 }, summary: {} });
  await inFlight;
  await update;
  assert.deepEqual(instances.map((item) => item.config.cchUrl), [configA.cchUrl, configB.cchUrl]);
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  assert.equal(runtime.getState().cache.today.calls, 2);
  runtime.stop();
});

test("keeps successful cache and redacts secrets on API failure", async () => {
  const config = { cchUrl: "https://hub.example", apiKey: "secret-api-key", refreshIntervalSeconds: 15, dateRangeDays: 7 };
  const plugin = makePlugin(config);
  let shouldFail = false;
  const errors = [];
  class FakeClient {
    async load() {
      if (shouldFail) throw new Error("upstream secret-api-key auth-token=session-1");
      return { quota: {}, today: { calls: 9 }, summary: {} };
    }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: (...args) => errors.push(args.join(" ")), warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await runtime.refresh("first");
  shouldFail = true;
  await runtime.refresh("second");
  assert.equal(runtime.getState().cache.today.calls, 9);
  assert.equal(runtime.getState().cache.stale, true);
  assert.ok(!runtime.getState().cache.error.includes("secret-api-key"));
  assert.ok(errors.every((line) => !line.includes("secret-api-key")));
  runtime.stop();
});

test("binds the SDK transport reconnect callback", () => {
  const plugin = makePlugin({});
  plugin.transport = {
    port: 55950,
    start() { return this.port; },
  };
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  runtime.start();
  assert.equal(plugin.transport.start(), 55950);
  assert.equal(plugin.transport.start.__flexbarBound, true);
  runtime.stop();
});
