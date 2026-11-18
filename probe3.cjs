const { createPluginRuntime } = require("/Users/upkiry/Code/flexbar-cch-usage/src/runtime");
const { HubClient } = require("/Users/upkiry/Code/flexbar-cch-usage/src/hub-client");

function response(status, body, headers = {}) {
  const values = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, ok: status >= 200 && status < 300,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      get: (n) => values[n.toLowerCase()] || null,
      getSetCookie: () => values["set-cookie"] ? [values["set-cookie"]] : [],
    },
  };
}

// ---------------------------------------------------------------------------
// PROBE A: draw 失败之后，指纹是否被记录（按键是否被永久冻结）
// ---------------------------------------------------------------------------
async function probeA() {
  const handlers = new Map();
  let attempts = 0;
  const plugin = {
    on: (e, h) => handlers.set(e, h),
    start: () => {},
    getConfig: async () => ({ cchUrl: "https://hub.example", apiKey: "k", refreshIntervalSeconds: 15 }),
    draw: async () => { attempts += 1; throw new Error("host refused the draw"); },
  };
  class Ok { async load() { return { quota: {}, today: { calls: 1 }, summaries: {} }; } }
  const runtime = createPluginRuntime({
    plugin, logger: { error: () => {}, warn: () => {} }, HubClientClass: Ok,
    renderKeyFn: (c, s) => ({ width: 240, dataUrl: `img-${c}-${s.today?.calls}`, fingerprint: "f" }),
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  await runtime.handlers.alive({ serialNumber: "A", keys: [
    { cid: "com.upkiry.flexbarcchusage.usage", uid: "u", width: 240, style: {}, data: { range: "1d" } },
  ] });
  await runtime.whenIdle();
  await new Promise((r) => setTimeout(r, 30));
  const afterFail = attempts;
  // 绘制恢复
  plugin.draw = async () => { attempts += 1; };
  await runtime.refresh("retry");
  await new Promise((r) => setTimeout(r, 30));
  console.log("PROBE A: 失败后尝试次数 =", afterFail,
    " 恢复后再尝试 =", attempts - afterFail,
    " fingerprintCount =", runtime.getState().fingerprintCount);
}

// ---------------------------------------------------------------------------
// PROBE B: hub-client 整轮 deadline 是否真的取消请求
// ---------------------------------------------------------------------------
async function probeB() {
  let aborted = 0;
  let finished = 0;
  const client = new HubClient({
    cchUrl: "https://hub.example",
    apiKey: "k",
    timeoutMs: 60_000,
    deadlineMs: 300,
    fetchImpl: (url, options = {}) => new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) { aborted += 1; reject(new Error("aborted")); return; }
        signal.addEventListener("abort", () => { aborted += 1; reject(new Error("aborted")); });
      }
      setTimeout(() => { finished += 1; resolve(response(200, { calls: 1 })); }, 5000);
    }),
    timeoutSignal: () => undefined,
  });
  const started = Date.now();
  const result = await client.load(["1d"]);
  console.log("PROBE B: 耗时 =", Date.now() - started, "ms  被取消 =", aborted,
    " 正常结束 =", finished, " errors =", JSON.stringify(result.errors));
}

// ---------------------------------------------------------------------------
// PROBE C: 全部接口失败时的 errors / fresh / 退避
// ---------------------------------------------------------------------------
async function probeC() {
  const handlers = new Map();
  const plugin = {
    on: (e, h) => handlers.set(e, h),
    start: () => {},
    getConfig: async () => ({ cchUrl: "https://hub.example", apiKey: "k", refreshIntervalSeconds: 15 }),
    draw: async () => {},
  };
  class AllFail { async load() { return { errors: { quota: "500", today: "500" } }; } }
  let ticks = 0;
  let timerFn = null;
  const runtime = createPluginRuntime({
    plugin, logger: { error: () => {}, warn: () => {} }, HubClientClass: AllFail,
    renderKeyFn: (c) => ({ width: 240, dataUrl: "x", fingerprint: "f" }),
    setIntervalFn: (fn) => { timerFn = fn; return {}; }, clearIntervalFn: () => {},
  });
  runtime.start();
  await runtime.handlers.alive({ serialNumber: "A", keys: [
    { cid: "com.upkiry.flexbarcchusage.usage", uid: "u", width: 240, style: {}, data: { range: "1d" } },
  ] });
  await runtime.whenIdle();
  console.log("PROBE C: failures =", runtime.getState().failures,
    " cache.stale =", runtime.getState().cache.stale,
    " fresh =", JSON.stringify(runtime.getState().cache.fresh));
  // 手动触发定时器若干次，看是否退避
  let loads = 0;
  class Counting { async load() { loads += 1; return { errors: { quota: "500" } }; } }
  const rt2 = createPluginRuntime({
    plugin, logger: { error: () => {}, warn: () => {} }, HubClientClass: Counting,
    renderKeyFn: (c) => ({ width: 240, dataUrl: "x", fingerprint: "f" }),
    setIntervalFn: (fn) => { timerFn = fn; return {}; }, clearIntervalFn: () => {},
    now: () => Date.now(),
  });
  rt2.start();
  await rt2.handlers.alive({ serialNumber: "A", keys: [
    { cid: "com.upkiry.flexbarcchusage.usage", uid: "u", width: 240, style: {}, data: { range: "1d" } },
  ] });
  await rt2.whenIdle();
  for (let i = 0; i < 5; i += 1) { timerFn && timerFn(); await new Promise((r) => setTimeout(r, 5)); }
  await rt2.whenIdle();
  console.log("PROBE C: 定时器连点 5 次后的实际抓取次数 =", loads, "(退避生效时应为 1)");
}

// ---------------------------------------------------------------------------
// PROBE D: 断连后点击 -> 什么都不发生（已确认，再量化）
// ---------------------------------------------------------------------------
async function probeD() {
  const handlers = new Map();
  let loads = 0;
  const plugin = {
    on: (e, h) => handlers.set(e, h),
    start: () => {},
    getConfig: async () => ({ cchUrl: "https://hub.example", apiKey: "k", refreshIntervalSeconds: 15 }),
    draw: async () => {},
  };
  class Ok { async load() { loads += 1; return { quota: {}, today: { calls: 1 }, summaries: {} }; } }
  const runtime = createPluginRuntime({
    plugin, logger: { error: () => {}, warn: () => {} }, HubClientClass: Ok,
    renderKeyFn: (c) => ({ width: 240, dataUrl: "x", fingerprint: "f" }),
    setIntervalFn: () => ({}), clearIntervalFn: () => {},
  });
  await runtime.handlers.alive({ serialNumber: "A", keys: [
    { cid: "com.upkiry.flexbarcchusage.usage", uid: "u", width: 240, style: {}, data: { range: "1d" } },
  ] });
  await runtime.whenIdle();
  const before = loads;
  await runtime.handlers.deviceStatus([{ serialNumber: "A", status: "disconnected" }]);
  await runtime.handlers.data({ serialNumber: "A", data: { key: { cid: "com.upkiry.flexbarcchusage.usage", uid: "u", width: 240, style: {}, data: { range: "1d" } } } });
  await runtime.whenIdle();
  console.log("PROBE D: 断连后点击触发的抓取次数 =", loads - before, "(应为 1)");
  // 期间宿主没有再发 connected
  await runtime.refresh("manual");
  await runtime.whenIdle();
  console.log("PROBE D: 手动 refresh 抓取次数 =", loads - before, "(断连设备不应参与)");
}

(async () => {
  await probeA();
  await probeB();
  await probeC();
  await probeD();
})().catch((e) => { console.error("PROBE ERROR", e); process.exit(1); });
