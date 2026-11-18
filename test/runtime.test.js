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
    draw: async (serial, key, format, image) => draws.push({ serial, uid: key.uid, format, image, title: key.title, style: { ...key.style } }),
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

/** 造一个假的宿主和收集日志用的 logger，具体运行时由各测试自己创建。 */
function makeRuntime() {
  const plugin = makePlugin({ cchUrl: "https://hub.example", apiKey: "secret", refreshIntervalSeconds: 15 });
  const logs = { errors: [], warns: [] };
  const logger = {
    error: (...args) => logs.errors.push(args.join(" ")),
    warn: (...args) => logs.warns.push(args.join(" ")),
  };
  return { plugin, logger, logs };
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
    logger: {
      error: (...args) => logs.errors.push(args.join(" ")),
      warn: (...args) => logs.warns.push(args.join(" ")),
    },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  runtime.start();
  assert.equal(plugin.handlers.size, 5);
  await plugin.handlers.get("plugin.alive")({ serialNumber: "A", keys: keys() });
  await plugin.handlers.get("plugin.alive")({ serialNumber: "B", keys: keys() });
  await runtime.whenIdle();
  assert.equal(plugin.draws[0].style?.showImage, true);
  // 两台设备的请求范围相同，一轮抓取就够了。
  assert.equal(loads, 1);
  assert.equal(runtime.getState().deviceCount, 2);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "A").length, 2);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "B").length, 2);
  // 数据没变就不该再画一次。
  const before = plugin.draws.length;
  await runtime.refresh("再次刷新");
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, before);
  await plugin.handlers.get("plugin.data")({ data: { key: keys()[0] } });
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, before);
  await plugin.handlers.get("device.status")([{ serialNumber: "A", status: "disconnected" }]);
  assert.equal(runtime.getState().deviceCount, 2);
  assert.deepEqual(logs.errors, []);
  runtime.stop();
});

test("宿主事件不等待网络，按键在数据到位后再绘制", async () => {
  const { plugin } = makeRuntime();
  const events = [];
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  class FakeClient {
    async load() {
      events.push("load");
      await loadGate;
      return { quota: {}, today: { calls: 42 }, summaries: {} };
    }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn: (keyCid, state, currentConfig, width) => {
      events.push(`render:${state.today?.calls ?? "null"}`);
      return renderKeyFn(keyCid, state, currentConfig, width);
    },
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });

  // 事件处理器必须立刻返回，否则宿主会一直等下去。
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  assert.equal(plugin.draws.length, 0);
  assert.equal(events.includes("render:42"), false);

  releaseLoad();
  await runtime.whenIdle();
  assert.deepEqual(events, ["load", "render:42", "render:42"]);
  assert.equal(plugin.draws.length, 2);
  runtime.stop();
});

test("requests the union of configured usage ranges", async () => {
  const { plugin } = makeRuntime();
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
  await runtime.whenIdle();
  assert.deepEqual(requested, [["5h", "7d", "1m"]]);
  runtime.stop();
});

test("只有最近调用指标才启用受限日志采集，窗口跟随按键范围", async () => {
  const { plugin } = makeRuntime();
  const calls = [];
  class FakeClient {
    async load(ranges, options) {
      calls.push({ ranges, options });
      return {
        quota: {},
        summaries: {},
        recentLogs: {
          items: [{ model: "claude-sonnet-4", statusCode: 200, duration: 120, createdAt: "2026-09-12T00:00:00.000Z" }],
          pageInfo: { hasMore: false },
        },
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
  await runtime.handlers.alive({
    serialNumber: "A",
    keys: [{ cid: cid("usage"), uid: "recent", width: 240, style: {}, data: { range: "7d", metric: "recent" } }],
  });
  await runtime.whenIdle();
  assert.deepEqual(calls, [{
    ranges: [],
    options: { includeRecentLogs: true, recentLimit: 8, recentDays: 7 },
  }]);
  assert.equal(runtime.getState().cache.recentSummary.count, 1);
  assert.equal(runtime.getState().cache.recentSummary.lastModel, "claude-sonnet-4");
  runtime.stop();
});

test("一天缓存指标会请求每日汇总", async () => {
  const { plugin } = makeRuntime();
  const calls = [];
  class FakeClient {
    async load(ranges, options) {
      calls.push({ ranges, options });
      return { quota: {}, today: {}, summaries: { "1d": { totalCacheReadTokens: 4, totalCacheCreationTokens: 5 } } };
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
  await runtime.handlers.alive({
    serialNumber: "A",
    keys: [{ cid: cid("usage"), uid: "cache", width: 240, style: {}, data: { range: "1d", metric: "cache" } }],
  });
  await runtime.whenIdle();
  assert.deepEqual(calls, [{
    ranges: ["1d"],
    options: { includeRecentLogs: false, recentLimit: 8, recentDays: 1, includeDailySummary: true },
  }]);
  runtime.stop();
});

test("单个接口失败只让对应按键过期，其它按键照常更新", async () => {
  const { plugin } = makeRuntime();
  class FakeClient {
    async load() {
      return {
        quota: { keyCurrent5hUsd: 1, keyLimit5hUsd: 2 },
        summaries: {},
        errors: { "7d": "统计接口超时" },
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
  await runtime.handlers.alive({
    serialNumber: "A",
    keys: [
      { cid: cid("quota"), uid: "quota", width: 240, style: {}, data: {} },
      { cid: cid("usage"), uid: "usage-7d", width: 240, style: {}, data: { range: "7d" } },
    ],
  });
  await runtime.whenIdle();
  const state = runtime.getState().cache;
  assert.equal(state.stale, false);
  assert.equal(state.fresh.quota, true);
  assert.equal(state.fresh["7d"], false);
  assert.equal(state.errors["7d"], "统计接口超时");
  runtime.stop();
});

test("最近日志临时失败时保留上一轮摘要并标记局部错误", async () => {
  const { plugin } = makeRuntime();
  let failed = false;
  class FakeClient {
    async load() {
      if (failed) return { quota: {}, summaries: {}, recentError: "查询失败" };
      return {
        quota: {},
        summaries: {},
        recentLogs: { items: [{ model: "model-a", statusCode: 200, createdAt: "2026-09-12T00:00:00.000Z" }] },
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
  await runtime.handlers.alive({
    serialNumber: "A",
    keys: [{ cid: cid("usage"), uid: "recent", width: 240, style: {}, data: { metric: "recent" } }],
  });
  await runtime.whenIdle();
  failed = true;
  await runtime.refresh("再次刷新");
  await runtime.whenIdle();
  assert.equal(runtime.getState().cache.recentSummary.lastModel, "model-a");
  assert.equal(runtime.getState().cache.recentError, "查询失败");
  runtime.stop();
});

test("配置更新不会被正在进行的刷新吞掉", async () => {
  const configA = { cchUrl: "https://a.example", apiKey: "key-a", refreshIntervalSeconds: 15 };
  const configB = { cchUrl: "https://b.example", apiKey: "key-b", refreshIntervalSeconds: 20 };
  const plugin = makePlugin(configA);
  let resolveA;
  const firstLoad = new Promise((resolve) => { resolveA = resolve; });
  const instances = [];
  let calls = 0;
  class FakeClient {
    constructor(config) { this.config = config; instances.push(this); }
    load() {
      calls += 1;
      // 第二次开始挂住，用来模拟"刷新进行中又改了配置"。
      if (this.config.cchUrl === configA.cchUrl && calls > 1) return firstLoad;
      return Promise.resolve({ quota: {}, today: { calls: 1 }, summaries: {} });
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
  await runtime.refresh("initial");
  const inFlight = runtime.refresh("slow");
  await Promise.resolve();
  await runtime.handlers.configUpdated({ config: configB });
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  resolveA({ quota: {}, today: { calls: 1 }, summaries: {} });
  await inFlight;
  await runtime.whenIdle();
  assert.deepEqual(instances.map((item) => item.config.cchUrl), [configA.cchUrl, configB.cchUrl]);
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  assert.equal(runtime.getState().cache.today.calls, 1);
  runtime.stop();
});

test("后台读取的旧配置不会覆盖更新的配置", async () => {
  const configA = { cchUrl: "https://a.example", apiKey: "key-a", refreshIntervalSeconds: 15 };
  const configB = { cchUrl: "https://b.example", apiKey: "key-b", refreshIntervalSeconds: 20 };
  const plugin = makePlugin(configA);
  let releaseConfig;
  const configGate = new Promise((resolve) => { releaseConfig = resolve; });
  plugin.getConfig = async () => {
    await configGate;
    return configA;
  };
  class FakeClient {
    async load() { return { quota: {}, today: { calls: 1 }, summaries: {} }; }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  const pending = runtime.refresh("initial");
  await Promise.resolve();
  await runtime.handlers.configUpdated({ config: configB });
  releaseConfig();
  await pending;
  await runtime.whenIdle();
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
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
  await runtime.whenIdle();
  const result = await runtime.handlers.uiMessage({ action: "applyConfig", config: configB });
  assert.equal(result.status, "success");
  assert.equal(runtime.getState().config.cchUrl, configB.cchUrl);
  assert.equal(instances.at(-1).config.cchUrl, configB.cchUrl);
  await runtime.whenIdle();
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

test("设备拔出后重新插入可以恢复绘制", async () => {
  const { plugin } = makeRuntime();
  class FakeClient {
    async load() { return { quota: { keyCurrent5hUsd: 1 }, today: { calls: 3 }, summaries: {} }; }
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
  await runtime.whenIdle();
  const afterFirst = plugin.draws.length;
  assert.equal(afterFirst, 2);

  await runtime.handlers.deviceStatus([{ serialNumber: "A", status: "disconnected" }]);
  assert.equal(runtime.getState().deviceCount, 1);

  // 宿主不一定重发按键列表，重新插上后要能自己画回来。
  await runtime.handlers.deviceStatus([{ serialNumber: "A", status: "connected" }]);
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, afterFirst + 2);
  runtime.stop();
});

test("绘制卡住不会永久冻结按键", async () => {
  const { plugin } = makeRuntime();
  plugin.draw = () => new Promise(() => {});
  class FakeClient {
    async load() { return { quota: { keyCurrent5hUsd: 1 }, today: { calls: 3 }, summaries: {} }; }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    drawTimeoutMs: 20,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  await runtime.whenIdle();
  // 签名没有落库，下一轮仍然会重画。
  assert.equal(runtime.getState().fingerprintCount, 0);
  runtime.stop();
});

test("绑定并加固 SDK 的重连回调", async () => {
  const plugin = makePlugin({});
  let sockets = 0;
  plugin.transport = {
    port: 55950,
    ws: null,
    start() { sockets += 1; this.ws = { readyState: 0 }; return this.port; },
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
  // 已经有一个正在连接的 socket 时不应该再建一条。
  plugin.transport.start();
  assert.equal(sockets, 1);
  runtime.stop();
});

test("同一轮刷新不会把同一个按键画两遍", async () => {
  const { plugin } = makeRuntime();
  class FakeClient {
    async load() { return { quota: { keyCurrent5hUsd: 1 }, today: { calls: 3 }, summaries: {} }; }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  // 第二台设备在第一轮抓取还没结束时接入。
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  await runtime.handlers.alive({ serialNumber: "B", keys: keys() });
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, 4);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "A").length, 2);
  assert.equal(plugin.draws.filter((draw) => draw.serial === "B").length, 2);
  runtime.stop();
});

test("完整生命周期：启动、拔插、配置变更、接口失败都不丢按键", async () => {
  const { plugin } = makeRuntime();
  let failing = false;
  let generation = 0;
  class FakeClient {
    async load() {
      if (failing) throw new Error("接口不可用");
      generation += 1;
      return { quota: { keyCurrent5hUsd: generation }, today: { calls: generation }, summaries: {} };
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
  runtime.start();

  // 1. 设备接入，按键应当被画出。
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, 2);
  assert.equal(runtime.getState().cache.today.calls, 1);

  // 2. 拔出：不再画新图，但按键列表还在。
  await runtime.handlers.deviceStatus([{ serialNumber: "A", status: "disconnected" }]);
  const afterUnplug = plugin.draws.length;
  await runtime.refresh("拔出后");
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, afterUnplug);

  // 3. 重新插入：沿用记住的按键自己画回来。
  await runtime.handlers.deviceStatus([{ serialNumber: "A", status: "connected" }]);
  await runtime.whenIdle();
  assert.equal(plugin.draws.length, afterUnplug + 2);

  // 4. 接口挂掉：保留上一次的数据并标记过期。
  const beforeFailure = runtime.getState().cache.today.calls;
  failing = true;
  await runtime.refresh("失败");
  await runtime.whenIdle();
  assert.equal(runtime.getState().cache.today.calls, beforeFailure);
  assert.equal(runtime.getState().cache.stale, true);

  // 5. 配置变更：换成新的服务端并重新取数。
  failing = false;
  await runtime.handlers.configUpdated({
    config: { cchUrl: "https://other.example", apiKey: "key-2", refreshIntervalSeconds: 30 },
  });
  await runtime.whenIdle();
  assert.equal(runtime.getState().config.cchUrl, "https://other.example");
  assert.equal(runtime.getState().cache.stale, false);
  assert.ok(runtime.getState().cache.today.calls > 1);
  runtime.stop();
});

test("读取宿主配置失败时不会每轮刷新都重试", async () => {
  const plugin = makePlugin({});
  let reads = 0;
  plugin.getConfig = async () => {
    reads += 1;
    throw new Error("宿主没响应");
  };
  class FakeClient {
    async load() { return { quota: {}, today: { calls: 1 }, summaries: {} }; }
  }
  const runtime = createPluginRuntime({
    plugin,
    logger: { error: () => {}, warn: () => {} },
    HubClientClass: FakeClient,
    renderKeyFn,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
  });
  await runtime.refresh("第一次");
  await runtime.refresh("第二次");
  await runtime.whenIdle();
  // 只做了一轮读取（内部重试一次），不能把每轮刷新都拖慢。
  assert.equal(reads, 2);
  assert.equal(runtime.getState().cache.error, "请在插件配置中设置 CC Hub URL 和 API Key");
  runtime.stop();
});

test("全部接口失败后标记过期并增加退避计数", async () => {
  const { plugin } = makeRuntime();
  class FakeClient {
    async load() { return { summaries: {}, errors: { quota: "服务不可用" } }; }
  }
  const runtime = createPluginRuntime({ plugin, logger: { error() {}, warn() {} }, HubClientClass: FakeClient,
    renderKeyFn, setIntervalFn: () => ({}), clearIntervalFn() {} });
  await runtime.handlers.alive({ serialNumber: "A", keys: keys() });
  await runtime.whenIdle();
  assert.equal(runtime.getState().failures, 1);
  assert.equal(runtime.getState().cache.stale, true);
  runtime.stop();
});

test("更换账号时丢弃旧账号尚未完成的请求", async () => {
  const first = { cchUrl: "https://first.example", apiKey: "a", refreshIntervalSeconds: 30 };
  const second = { cchUrl: "https://second.example", apiKey: "b", refreshIntervalSeconds: 30 };
  const plugin = makePlugin(first);
  let release;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class FakeClient {
    constructor(config) { this.config = config; }
    async load() {
      if (this.config.cchUrl === first.cchUrl) { signalStarted(); await gate; return { quota: {}, today: { calls: 99 }, summaries: {} }; }
      return { quota: {}, today: { calls: 2 }, summaries: {} };
    }
  }
  const runtime = createPluginRuntime({ plugin, logger: { error() {}, warn() {} }, HubClientClass: FakeClient,
    renderKeyFn, setIntervalFn: () => ({}), clearIntervalFn() {} });
  void runtime.refresh();
  await started;
  await runtime.handlers.configUpdated({ config: second });
  release();
  await runtime.whenIdle();
  assert.equal(runtime.getState().cache.today.calls, 2);
  runtime.stop();
});
