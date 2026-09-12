const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const WIDTH = 240;
const COMPACT_WIDTH = 180;
const HEIGHT = 60;
const FONT_FAMILY = "FlexCJK";
const FONT_NAME = "SourceHanSansCJK-subset.woff2";
const REQUIRED_GLYPHS = "总览配额今日近期用量小时数据过期请配置未无限制次调用成本天刷新连接失败需要配置0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzCC Hub∞$%/.-,:·…";
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
  if (value === null) return "∞";
  const amount = finite(value);
  if (amount === null) return "-";
  const unit = typeof currency === "string" && /^[A-Za-z]{1,6}$/.test(currency) ? currency : "USD";
  return `${unit === "USD" ? "$" : `${unit} `}${amount.toFixed(2)}`;
}

function count(value) {
  const amount = finite(value);
  return amount === null ? "-" : amount.toLocaleString("en-US");
}

function metric(cid, state, config) {
  if (!config.cchUrl || !config.apiKey) {
    return { label: "需要配置", value: "请配置 CC Hub", tone: "muted", status: "未配置" };
  }
  const stale = Boolean(state.stale);
  const suffix = stale ? "数据过期" : "";
  if (cid.endsWith("overview")) {
    return {
      label: "用量总览",
      value: `${count(state.today?.calls)} 次 · ${money(state.today?.costUsd, state.today?.currencyCode)}`,
      tone: stale ? "stale" : "normal",
      status: suffix,
    };
  }
  if (cid.endsWith("quota")) {
    const current = finite(state.quota?.keyCurrent5hUsd);
    const limit = finite(state.quota?.keyLimit5hUsd);
    const percent = current !== null && limit > 0 ? Math.min(999, current / limit * 100) : null;
    return {
      label: "5小时配额",
      value: `${money(current)}/${money(limit)}${percent === null ? "" : ` ${percent.toFixed(0)}%`}`,
      tone: percent !== null && percent >= 95 ? "critical" : percent !== null && percent >= 80 ? "warning" : stale ? "stale" : "normal",
      status: suffix,
      percent,
    };
  }
  if (cid.endsWith("today")) {
    return {
      label: "今日用量",
      value: `${count(state.today?.calls)} 次 · ${money(state.today?.costUsd, state.today?.currencyCode)}`,
      tone: stale ? "stale" : "normal",
      status: suffix,
    };
  }
  return {
    label: `近${config.dateRangeDays}天用量`,
    value: `${count(state.summary?.totalRequests)} 次 · ${money(state.summary?.totalCost, state.summary?.currencyCode)}`,
    tone: stale ? "stale" : "normal",
    status: suffix,
  };
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
  } else if (cid.endsWith("today")) {
    ctx.strokeRect(-8, -7, 16, 15);
    ctx.beginPath(); ctx.moveTo(-5, -10); ctx.lineTo(-5, -5); ctx.moveTo(5, -10); ctx.lineTo(5, -5); ctx.moveTo(-8, -2); ctx.lineTo(8, -2); ctx.stroke();
  } else if (cid.endsWith("range")) {
    ctx.strokeRect(-9, -7, 18, 14);
    ctx.beginPath(); ctx.moveTo(-5, 3); ctx.lineTo(-1, -1); ctx.lineTo(2, 2); ctx.lineTo(7, -4); ctx.stroke();
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

function renderKey(cid, state = {}, config = {}, requestedWidth = WIDTH) {
  ensureFont();
  const width = Number(requestedWidth) >= 220 ? WIDTH : COMPACT_WIDTH;
  const view = metric(cid, state, config);
  const palette = colors(view.tone);
  const canvas = createCanvas(width, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111923";
  ctx.fillRect(0, 0, width, HEIGHT);
  drawIcon(ctx, cid, width >= WIDTH ? 20 : 15, HEIGHT / 2, palette.accent, width >= WIDTH ? 1 : 0.82);

  const left = width >= WIDTH ? 42 : 32;
  const maxText = width - left - 10;
  const label = fitText(ctx, view.label, maxText, width >= WIDTH ? 13 : 11, "600");
  ctx.font = `600 ${label.size}px ${FONT_FAMILY}, sans-serif`;
  ctx.fillStyle = "#aeb9c8";
  ctx.fillText(label.text, left, 19);
  const value = fitText(ctx, view.value, maxText, width >= WIDTH ? 20 : 16, "700");
  ctx.font = `700 ${value.size}px ${FONT_FAMILY}, sans-serif`;
  ctx.fillStyle = palette.value;
  ctx.fillText(value.text, left, 47);
  if (view.status) {
    ctx.font = `500 ${width >= WIDTH ? 9 : 8}px ${FONT_FAMILY}, sans-serif`;
    ctx.fillStyle = palette.accent;
    ctx.fillText(view.status, width - (ctx.measureText(view.status).width + 9), 12);
  }
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
