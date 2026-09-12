const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPluginRuntime } = require("../src/runtime");

const IDS = ["quota", "usage"];
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
  return IDS.map((name, index) => ({
    cid: cid(name), uid: `key-${index}`, width: 240, style: {},
    data: name === "usage" ? { range: "1d" } : { query: name },
  }));
}

test("registers FlexDesigner events, isolates devices, and deduplicates draws", async () => {
  const plugin = makePlugin({ cchUrl: "https://hub.example", apiKey: "secret", refreshIntervalSeconds: 15 });
  const logs = { errors: [], warns: [] };
  let loads = 0;
  class FakeClient {
    async load() {
      loads += 1;
      return { quota: {}, today: { calls: 12, costUsd: 1 }, summaries: {} };
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
  assert.equal(plugin.draws.filter((draw) => draw.serial === "A").length, 4);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "B").length, 2);
  const before = plugin.draws.length;
  await plugin.handlers.get("plugin.data")({ data: { key: keys()[0] } });
  assert.equal(plugin.draws.length, before);
  await plugin.handlers.get("device.status")([{ serialNumber: "A", status: "disconnected" }]);
  assert.equal(runtime.getState().deviceCount, 1);
  assert.deepEqual(logs.errors, []);
  runtime.stop();
});

test("requests the union of configured usage ranges", async () => {
  const plugin = makePlugin({ cchUrl: "https://hub.example", apiKey: "secret", refreshIntervalSeconds: 15 });
  const requested = [];
  class FakeClient {
    async load(ranges) {
      requested.push(ranges);
      return {
        quota: { keyCurrent5hUsd: 1 },
        summaries: { "7d": { totalRequests: 7, totalCost: 2 }, "1m": { totalRequests: 30, totalCost: 3 } },
      };
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
  const configuredKeys = [
    { cid: cid("quota"), uid: "quota", width: 240, style: {}, data: { range: "7d" } },
    { cid: cid("usage"), uid: "usage-7d", width: 240, style: {}, data: { range: "7d" } },
    { cid: cid("usage"), uid: "usage-1m", width: 240, style: {}, data: { range: "1m" } },
  ];
  await runtime.handlers.alive({ serialNumber: "A", keys: configuredKeys });
  assert.deepEqual(requested, [["5h", "7d", "1m"]]);
  runtime.stop();
});

test("serializes config updates behind an in-flight refresh", async () => {
  const configA = { cchUrl: "https://a.example", apiKey: "key-a", refreshIntervalSeconds: 15 };
  const configB = { cchUrl: "https://b.example", apiKey: "key-b", refreshIntervalSeconds: 20 };
  const plugin = makePlugin(configA);
  let resolveA;
  const firstLoad = new Promise((resolve) => { resolveA = resolve; });
  const instances = [];
  class FakeClient {
    constructor(config) { this.config = config; instances.push(this); }
    load() {
      if (this.config.cchUrl === configA.cchUrl) return firstLoad;
      return Promise.resolve({ quota: {}, today: { calls: 2 }, summaries: {} });
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
  resolveA({ quota: {}, today: { calls: 1 }, summaries: {} });
  await inFlight;
  await update;
  assert.deepEqual(instances.map((item) => item.config.cchUrl), [configA.cchUrl, configB.cchUrl]);
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  assert.equal(runtime.getState().cache.today.calls, 2);
  runtime.stop();
});

test("applies a saved UI config immediately and refreshes the keys", async () => {
  const configA = { cchUrl: "https://a.example", apiKey: "key-a", refreshIntervalSeconds: 15 };
  const configB = { cchUrl: "https://b.example", apiKey: "key-b", refreshIntervalSeconds: 20 };
  const plugin = makePlugin(configA);
  const instances = [];
  class FakeClient {
    constructor(config) { this.config = config; instances.push(this); }
    async load() { return { quota: { keyCurrent5hUsd: 1, keyLimit5hUsd: 2 }, today: { calls: 2 }, summaries: {} }; }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  const result = await runtime.handlers.uiMessage({ action: "applyConfig", config: configB });
  assert.equal(result.status, "success");
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  assert.equal(instances.at(-1).config.cchUrl, configB.cchUrl);
  runtime.stop();
});

test("restores configuration from the user backup after a reinstall reset", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flexbar-cch-usage-"));
  const configStorePath = path.join(directory, "config.json");
  const config = { cchUrl: "https://saved.example", apiKey: "saved-key", refreshIntervalSeconds: 30 };
  class FakeClient { async load() { return { quota: {}, today: {}, summaries: {} }; } }
  const firstPlugin = makePlugin(config);
  const firstRuntime = createPluginRuntime({
    plugin: firstPlugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    configStorePath,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await firstRuntime.refresh("initial");
  firstRuntime.stop();

  let restored;
  const secondPlugin = makePlugin({});
  secondPlugin.setConfig = async (value) => { restored = value; };
  const secondRuntime = createPluginRuntime({
    plugin: secondPlugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    configStorePath,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await secondRuntime.refresh("reinstall");
  assert.equal(secondRuntime.getState().config.cchUrl, config.cchUrl);
  assert.equal(restored.apiKey, config.apiKey);
  secondRuntime.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("keeps successful cache and redacts secrets on API failure", async () => {
  const config = { cchUrl: "https://hub.example", apiKey: "secret-api-key", refreshIntervalSeconds: 15 };
  const plugin = makePlugin(config);
  let shouldFail = false;
  const errors = [];
  class FakeClient {
    async load() {
      if (shouldFail) throw new Error("upstream secret-api-key auth-token=session-1");
      return { quota: {}, today: { calls: 9 }, summaries: {} };
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
