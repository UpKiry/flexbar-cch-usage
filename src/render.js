const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const {
  aggregateRecentSummary,
  aggregateUsageMetrics,
  normalizeMetric,
  normalizeUsageRange,
} = require("./core");

const WIDTH = 240;
const COMPACT_WIDTH = 180;
const HEIGHT = 60;
const FONT_FAMILY = "FlexCJK";
const FONT_NAME = "SourceHanSansCJK-subset.woff2";
const REQUIRED_GLYPHS = "配额用量小时天最近数据过期请配置未未知无限制次调用成本输入输出Token缓存读取创建模型状态耗时失败成功启用禁用并发到期暂无读写汇总查询刷新连接失败需要配置h d m0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzCC Hub∞$%/.-,:·…+";
const FONT_PATHS = [
  path.resolve(__dirname, "../resources/fonts", FONT_NAME),
  path.resolve(__dirname, "../com.upkiry.flexbarcchusage.plugin/resources/fonts", FONT_NAME),
];
let fontReady = false;

function ensureFont() {
  if (fontReady) return;
  const fontPath = FONT_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!fontPath) throw new Error(`找不到按键字体资源：${FONT_NAME}`);
  GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  for (const glyph of REQUIRED_GLYPHS) {
    if (!GlobalFonts.has(FONT_FAMILY, glyph)) throw new Error(`按键字体缺少字符：${glyph}`);
  }
  fontReady = true;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function money(value, currency = "USD") {
  const amount = finite(value);
  if (amount === null) return "-";
  const unit = typeof currency === "string" && /^[A-Za-z]{1,6}$/.test(currency) ? currency : "USD";
  return `${unit === "USD" ? "$" : `${unit} `}${amount.toFixed(2)}`;
}

function limitMoney(value, currency = "USD") {
  if (value === null) return "∞";
  return money(value, currency);
}

function count(value) {
  const amount = finite(value);
  return amount === null ? "-" : amount.toLocaleString("en-US");
}

function safeModel(value) {
  if (typeof value !== "string") return "未知模型";
  const normalized = value.trim().replace(/[^A-Za-z0-9._/@:+-]/g, "");
  return normalized ? normalized.slice(0, 18) : "未知模型";
}

function statusText(quota) {
  if (quota?.keyIsEnabled === false || quota?.userIsEnabled === false) return "禁用";
  if (quota?.keyIsEnabled === true || quota?.userIsEnabled === true) return "启用";
  return "";
}

function expiryText(quota) {
  const value = quota?.expiresAt || quota?.userExpiresAt;
  if (typeof value !== "string") return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return month && day ? `到期 ${month}-${day}` : "";
}

function quotaMetric(state, stale) {
  const quota = state.quota || {};
  const current = finite(quota.keyCurrent5hUsd);
  const limit = finite(quota.keyLimit5hUsd);
  const percent = current !== null && limit > 0 ? Math.min(999, current / limit * 100) : null;
  const status = statusText(quota);
  const expiry = expiryText(quota);
  const concurrent = finite(quota.keyCurrentConcurrentSessions);
  const concurrentLimit = finite(quota.keyLimitConcurrentSessions);
  const details = [];
  if (status === "禁用") details.push(status);
  if (concurrent !== null) details.push(`并发 ${count(concurrent)}${concurrentLimit === null ? "" : `/${count(concurrentLimit)}`}`);
  if (expiry) details.push(expiry);
  if (!details.length && status) details.push(status);
  return {
    label: "配额 · 5 小时",
    value: `${money(current)}/${limitMoney(limit)}${percent === null ? "" : ` ${percent.toFixed(0)}%`}`,
    tone: quota.keyIsEnabled === false || quota.userIsEnabled === false
      ? "critical"
      : percent !== null && percent >= 95
        ? "critical"
        : percent !== null && percent >= 80
          ? "warning"
          : stale ? "stale" : "normal",
    status: [...details, stale ? "数据过期" : ""].filter(Boolean).join(" "),
    percent,
  };
}

function usageMetric(state, range, selectedMetric, stale) {
  const rangeLabel = { "1d": "1 天", "7d": "7 天", "1m": "30 天", "5h": "5 小时" }[range] || range;
  const suffix = stale ? "数据过期" : "";
  if (selectedMetric === "recent") {
    const summary = state.recentSummary || aggregateRecentSummary(state.recentLogs);
    const latest = summary.latest || {};
    const model = summary.lastModel || latest.model || latest.billingModel;
    const details = [];
    if (state.recentError) details.push("最近数据失败");
    if (summary.failed !== null && summary.failed !== undefined) details.push(`失败 ${count(summary.failed)}`);
    if (finite(summary.unknown) !== null && summary.unknown > 0) details.push(`未知 ${count(summary.unknown)}`);
    if (finite(summary.avgDuration) !== null) details.push(`${Math.round(summary.avgDuration)}ms`);
    if (finite(summary.lastStatus) !== null) details.push(String(Math.round(summary.lastStatus)));
    if (finite(summary.cacheHitRate) !== null) details.push(`缓存 ${(summary.cacheHitRate * 100).toFixed(0)}%`);
    return {
      label: "最近调用",
      value: `${count(summary.count)}次${model ? ` ${safeModel(model)}` : ""}`,
      tone: summary.failed > 0 ? "warning" : stale ? "stale" : "normal",
      status: [...details, suffix].filter(Boolean).join(" "),
    };
  }
  if (range === "5h") {
    return {
      label: "用量 · 5 小时",
      value: selectedMetric === "callsCost"
        ? money(state.quota?.keyCurrent5hUsd, state.quota?.currencyCode)
        : selectedMetric === "cache" ? "缓存暂无" : selectedMetric === "summary" ? "汇总暂无" : "Token暂无",
      tone: stale ? "stale" : "normal",
      status: suffix,
    };
  }
  const data = aggregateUsageMetrics(state, range);
  if (selectedMetric === "tokens") {
    const tokenValue = data.inputTokens !== null || data.outputTokens !== null
      ? `${count(data.inputTokens)}+${count(data.outputTokens)}`
      : count(data.totalTokens);
    return {
      label: `Token · ${rangeLabel}`,
      value: `${tokenValue} Token`,
      tone: stale ? "stale" : "normal",
      status: suffix,
    };
  }
  if (selectedMetric === "cache") {
    const read = count(data.cacheReadTokens);
    const created = count(data.cacheCreationTokens);
    const cacheDetails = [
      data.cacheCreation5mTokens === null ? "" : `5m ${count(data.cacheCreation5mTokens)}`,
      data.cacheCreation1hTokens === null ? "" : `1h ${count(data.cacheCreation1hTokens)}`,
      suffix,
    ].filter(Boolean).join(" ");
    return {
      label: `缓存 · ${rangeLabel}`,
      value: `${read}读/${created}写`,
      tone: stale ? "stale" : "normal",
      status: cacheDetails,
    };
  }
  if (selectedMetric === "summary") {
    return {
      label: `汇总 · ${rangeLabel}`,
      value: `${count(data.calls)}次 ${money(data.cost, data.currencyCode)}`,
      tone: stale ? "stale" : "normal",
      status: suffix,
    };
  }
  return {
    label: `用量 · ${rangeLabel}`,
    value: `${count(data.calls)} 次 · ${money(data.cost, data.currencyCode)}`,
    tone: stale ? "stale" : "normal",
    status: suffix,
  };
}

function metric(cid, state, config, keyData = {}) {
  if (!config.cchUrl || !config.apiKey) {
    return { label: "需要配置", value: "请配置 CC Hub", tone: "muted", status: "未配置" };
  }
  const stale = Boolean(state.stale);
  const suffix = stale ? "数据过期" : "";
  if (cid.endsWith("quota")) return quotaMetric(state, stale);
  const range = normalizeUsageRange(keyData.range);
  return usageMetric(state, range, normalizeMetric(keyData.metric), stale);
}

function colors(tone) {
  return {
    normal: { accent: "#54d6a6", value: "#f4f7fb" },
    stale: { accent: "#f2b866", value: "#fff4df" },
    warning: { accent: "#f2b866", value: "#fff4df" },
    critical: { accent: "#ff6b7a", value: "#ffe7ea" },
    muted: { accent: "#8c9aad", value: "#d4dbe5" },
  }[tone] || { accent: "#54d6a6", value: "#f4f7fb" };
}

function drawIcon(ctx, cid, x, y, color, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (cid.endsWith("quota")) {
    ctx.beginPath(); ctx.arc(0, 0, 9, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(6, -5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
  } else if (cid.endsWith("usage")) {
    ctx.strokeRect(-8, -7, 16, 15);
    ctx.beginPath(); ctx.moveTo(-5, -10); ctx.lineTo(-5, -5); ctx.moveTo(5, -10); ctx.lineTo(5, -5); ctx.moveTo(-8, -2); ctx.lineTo(8, -2); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(-9, 7); ctx.lineTo(-9, -3); ctx.lineTo(-3, 1); ctx.lineTo(2, -6); ctx.lineTo(9, -1); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function fitText(ctx, value, maxWidth, size, weight = "400") {
  let current = size;
  while (current > 9) {
    ctx.font = `${weight} ${current}px ${FONT_FAMILY}, sans-serif`;
    if (ctx.measureText(value).width <= maxWidth) return { text: value, size: current };
    current -= 1;
  }
  ctx.font = `${weight} 9px ${FONT_FAMILY}, sans-serif`;
  if (ctx.measureText(value).width <= maxWidth) return { text: value, size: 9 };
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return { text: text.length < value.length ? `${text}…` : text, size: 9 };
}

function renderKey(cid, state = {}, config = {}, requestedWidth = WIDTH, keyData = {}) {
  ensureFont();
  const width = Number(requestedWidth) >= 220 ? WIDTH : COMPACT_WIDTH;
  const view = metric(cid, state, config, keyData);
  const palette = colors(view.tone);
  const canvas = createCanvas(width, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111923";
  ctx.fillRect(0, 0, width, HEIGHT);
  drawIcon(ctx, cid, width >= WIDTH ? 20 : 15, HEIGHT / 2, palette.accent, width >= WIDTH ? 1 : 0.82);

  const left = width >= WIDTH ? 42 : 32;
  const maxText = width - left - 10;
  let statusView;
  let statusWidth = 0;
  if (view.status) {
    const statusLimit = width >= WIDTH ? Math.min(112, maxText * 0.48) : Math.min(76, maxText * 0.45);
    statusView = fitText(ctx, view.status, statusLimit, width >= WIDTH ? 9 : 8, "500");
    ctx.font = `500 ${statusView.size}px ${FONT_FAMILY}, sans-serif`;
    statusWidth = ctx.measureText(statusView.text).width;
    ctx.fillStyle = palette.accent;
    ctx.fillText(statusView.text, width - statusWidth - 9, 12);
  }
  const labelMax = Math.max(36, maxText - (statusWidth ? statusWidth + 8 : 0));
  const label = fitText(ctx, view.label, labelMax, width >= WIDTH ? 13 : 11, "600");
  ctx.font = `600 ${label.size}px ${FONT_FAMILY}, sans-serif`;
  ctx.fillStyle = "#aeb9c8";
  ctx.fillText(label.text, left, 19);
  const value = fitText(ctx, view.value, maxText, width >= WIDTH ? 20 : 16, "700");
  ctx.font = `700 ${value.size}px ${FONT_FAMILY}, sans-serif`;
  ctx.fillStyle = palette.value;
  ctx.fillText(value.text, left, 47);
  if (typeof view.percent === "number") {
    ctx.fillStyle = "#263342";
    ctx.fillRect(left, 53, maxText, 3);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(left, 53, maxText * Math.min(100, view.percent) / 100, 3);
  }
  const fingerprint = JSON.stringify({ width, cid, view });
  return { width, height: HEIGHT, fingerprint, dataUrl: canvas.toDataURL("image/png"), view };
}

module.exports = { WIDTH, COMPACT_WIDTH, HEIGHT, REQUIRED_GLYPHS, renderKey, metric };
