const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { buildView, fingerprintFor } = require("./core");

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
const PAINT_CACHE_LIMIT = 64;

// 字体状态只计算一次。旧实现在字体缺失时直接抛异常，导致每一轮刷新都失败。
let fontState = null;
// 按指纹缓存 PNG，避免同一个视图重复编码。
const paintCache = new Map();

function ensureFont() {
  if (fontState) return fontState;
  const fontPath = FONT_PATHS.find((candidate) => fs.existsSync(candidate));
  const missing = [];
  let registered = false;
  if (fontPath) {
    try {
      GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
      registered = true;
    } catch {
      registered = false;
    }
  }
  if (registered) {
    for (const glyph of REQUIRED_GLYPHS) {
      if (!GlobalFonts.has(FONT_FAMILY, glyph)) missing.push(glyph);
    }
  }
  fontState = {
    family: registered ? FONT_FAMILY : "sans-serif",
    registered,
    missing,
    path: fontPath || null,
  };
  return fontState;
}

function fontFamily() {
  return ensureFont().family;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const family = fontFamily();
  let current = size;
  while (current > 9) {
    ctx.font = `${weight} ${current}px ${family}, sans-serif`;
    if (ctx.measureText(value).width <= maxWidth) return { text: value, size: current };
    current -= 1;
  }
  ctx.font = `${weight} 9px ${family}, sans-serif`;
  if (ctx.measureText(value).width <= maxWidth) return { text: value, size: 9 };
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return { text: text.length < value.length ? `${text}…` : text, size: 9 };
}

function paintView(view, cid, width) {
  const palette = colors(view.tone);
  const canvas = createCanvas(width, HEIGHT);
  const ctx = canvas.getContext("2d");
  const family = fontFamily();
  ctx.fillStyle = "#111923";
  ctx.fillRect(0, 0, width, HEIGHT);
  drawIcon(ctx, cid, width >= WIDTH ? 20 : 15, HEIGHT / 2, palette.accent, width >= WIDTH ? 1 : 0.82);

  const left = width >= WIDTH ? 42 : 32;
  const maxText = width - left - 10;
  let statusWidth = 0;
  if (view.status) {
    const statusLimit = width >= WIDTH ? Math.min(112, maxText * 0.48) : Math.min(76, maxText * 0.45);
    const statusView = fitText(ctx, view.status, statusLimit, width >= WIDTH ? 9 : 8, "500");
    ctx.font = `500 ${statusView.size}px ${family}, sans-serif`;
    statusWidth = ctx.measureText(statusView.text).width;
    ctx.fillStyle = palette.accent;
    ctx.fillText(statusView.text, width - statusWidth - 9, 12);
  }
  const labelMax = Math.max(36, maxText - (statusWidth ? statusWidth + 8 : 0));
  const label = fitText(ctx, view.label, labelMax, width >= WIDTH ? 13 : 11, "600");
  ctx.font = `600 ${label.size}px ${family}, sans-serif`;
  ctx.fillStyle = "#aeb9c8";
  ctx.fillText(label.text, left, 19);
  const value = fitText(ctx, view.value, maxText, width >= WIDTH ? 20 : 16, "700");
  ctx.font = `700 ${value.size}px ${family}, sans-serif`;
  ctx.fillStyle = palette.value;
  ctx.fillText(value.text, left, 47);
  if (typeof view.percent === "number") {
    ctx.fillStyle = "#263342";
    ctx.fillRect(left, 53, maxText, 3);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(left, 53, maxText * Math.min(100, view.percent) / 100, 3);
  }
  return canvas.toDataURL("image/png");
}

function fallbackImage(width) {
  const canvas = createCanvas(width, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111923";
  ctx.fillRect(0, 0, width, HEIGHT);
  return canvas.toDataURL("image/png");
}

function cachePaint(fingerprint, dataUrl) {
  if (paintCache.has(fingerprint)) paintCache.delete(fingerprint);
  paintCache.set(fingerprint, dataUrl);
  while (paintCache.size > PAINT_CACHE_LIMIT) {
    const oldest = paintCache.keys().next().value;
    paintCache.delete(oldest);
  }
  return dataUrl;
}

/**
 * 生成按键图片。
 *
 * 视图模型来自 core.buildView，与按键标题共用同一份数据；
 * 这里只负责把视图画成 PNG，并且任何异常都不会向上抛出——
 * 渲染失败最多让按键显示一张空图，不应该让整轮刷新崩掉。
 */
function renderKey(cid, state = {}, config = {}, requestedWidth = WIDTH, keyData = {}) {
  const width = Number(requestedWidth) >= 220 ? WIDTH : COMPACT_WIDTH;
  let view;
  try {
    view = buildView(cid, state, config, keyData);
  } catch {
    view = { label: "用量", value: "-", tone: "muted", status: "", percent: null };
  }
  const fingerprint = fingerprintFor(cid, width, view);
  const cached = paintCache.get(fingerprint);
  if (cached) {
    // 重新插入，保持最近使用的条目不被淘汰。
    paintCache.delete(fingerprint);
    paintCache.set(fingerprint, cached);
    return { width, height: HEIGHT, fingerprint, dataUrl: cached, view };
  }
  let dataUrl;
  try {
    dataUrl = paintView(view, cid, width);
  } catch {
    dataUrl = fallbackImage(width);
  }
  cachePaint(fingerprint, dataUrl);
  return { width, height: HEIGHT, fingerprint, dataUrl, view };
}

/** 兼容旧名字：视图模型现在由 core.buildView 提供。 */
function metric(cid, state, config, keyData = {}) {
  return buildView(cid, state, config, keyData);
}

module.exports = {
  WIDTH,
  COMPACT_WIDTH,
  HEIGHT,
  REQUIRED_GLYPHS,
  renderKey,
  metric,
  ensureFont,
};
