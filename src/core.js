const USAGE_RANGES = ["5h", "1d", "7d", "1m"];
const USAGE_METRICS = ["callsCost", "tokens", "cache", "recent", "summary"];
const DEFAULTS = { refreshIntervalSeconds: 60, usageRange: "1d" };

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textNumber(value) {
  return number(value) === null ? "-" : number(value).toLocaleString("en-US");
}

function money(value, currency = "USD") {
  if (value === null) return "无限制";
  return number(value) === null ? "-" : `${value.toFixed(2)} ${currency || "USD"}`;
}

function compactMoney(value, currency = "USD") {
  if (value === null) return "∞";
  if (number(value) === null) return "-";
  return currency === "USD" || !currency ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

// 当前用量和成本为 null 时表示服务端没有可用数值，不应与“限制未设置”混淆。
function amount(value, currency = "USD") {
  if (number(value) === null) return "-";
  return `${value.toFixed(2)} ${currency || "USD"}`;
}

function compactAmount(value, currency = "USD") {
  if (number(value) === null) return "-";
  return currency === "USD" || !currency ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

function normalizeUsageRange(value, fallback = DEFAULTS.usageRange) {
  return USAGE_RANGES.includes(value) ? value : fallback;
}

function normalizeMetric(value, fallback = "callsCost") {
  const aliases = {
    calls: "callsCost",
    cost: "callsCost",
    calls_cost: "callsCost",
    callsAndCost: "callsCost",
    token: "tokens",
    caching: "cache",
    latest: "recent",
    overview: "summary",
    quota: "quotaStatus",
  };
  const candidate = typeof value === "string" ? value.trim() : "";
  if (USAGE_METRICS.includes(candidate) || candidate === "quotaStatus") return candidate;
  return aliases[candidate] || fallback;
}

function safeConfigValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizedConfig(value = {}) {
  const interval = Number(value.refreshIntervalSeconds);
  return {
    cchUrl: safeConfigValue(value.cchUrl || value.CCH_URL).replace(/\/+$/, ""),
    apiKey: safeConfigValue(value.apiKey || value.CCH_API_KEY),
    refreshIntervalSeconds: Number.isFinite(interval)
      ? Math.max(15, Math.min(3600, Math.round(interval)))
      : DEFAULTS.refreshIntervalSeconds,
  };
}

function finiteOrNull(value) {
  return number(value);
}

function firstNumber(...values) {
  for (const value of values) {
    const normalized = finiteOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function sumNumbers(...values) {
  const numbers = values.map(finiteOrNull).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

function safeCurrency(value) {
  return typeof value === "string" && /^[A-Za-z]{1,6}$/.test(value) ? value : null;
}

function usageDataForRange(state = {}, range = "1d") {
  const normalizedRange = normalizeUsageRange(range);
  if (!state || typeof state !== "object") return {};
  if (normalizedRange === "5h") return state.quota && typeof state.quota === "object" ? state.quota : {};
  const summaries = state.summaries && typeof state.summaries === "object" ? state.summaries : {};
  if (normalizedRange === "1d" && summaries["1d"] && typeof summaries["1d"] === "object") return summaries["1d"];
  if (normalizedRange === "1d") return state.today && typeof state.today === "object" ? state.today : {};
  return summaries[normalizedRange] && typeof summaries[normalizedRange] === "object"
    ? summaries[normalizedRange]
    : {};
}

/**
 * 将 today/stats-summary 的字段归一化为按键可消费的指标。
 * 输入可以是单个接口响应，也可以是包含 today/summaries 的缓存对象。
 */
function aggregateUsageMetrics(value = {}, range = "1d") {
  const source = value && typeof value === "object"
    && (value.today || value.summaries || value.quota)
    ? usageDataForRange(value, range)
    : value && typeof value === "object" ? value : {};
  const inputTokens = firstNumber(source.inputTokens, source.totalInputTokens);
  const outputTokens = firstNumber(source.outputTokens, source.totalOutputTokens);
  const totalTokens = firstNumber(source.totalTokens, sumNumbers(inputTokens, outputTokens));
  const cacheCreationTokens = firstNumber(
    source.cacheCreationTokens,
    source.totalCacheCreationTokens,
    source.cacheCreationInputTokens,
  );
  const cacheReadTokens = firstNumber(
    source.cacheReadTokens,
    source.totalCacheReadTokens,
    source.cacheReadInputTokens,
  );
  const cacheCreation5mTokens = firstNumber(
    source.cacheCreation5mTokens,
    source.totalCacheCreation5mTokens,
    source.cacheCreation5mInputTokens,
  );
  const cacheCreation1hTokens = firstNumber(
    source.cacheCreation1hTokens,
    source.totalCacheCreation1hTokens,
    source.cacheCreation1hInputTokens,
  );
  return {
    calls: firstNumber(source.calls, source.totalRequests, source.requests),
    cost: firstNumber(source.costUsd, source.totalCost, source.cost),
    currencyCode: safeCurrency(source.currencyCode),
    inputTokens,
    outputTokens,
    totalTokens,
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheReadTokens,
    cacheTokens: sumNumbers(cacheCreationTokens, cacheReadTokens),
  };
}

function recentItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.logs)) return value.logs;
  return [];
}

function statusFailed(value) {
  const status = number(value);
  return status !== null && (status < 200 || status >= 300);
}

function normalizeCacheRate(value) {
  const rate = number(value);
  if (rate === null || rate < 0) return null;
  if (rate > 1 && rate <= 100) return rate / 100;
  return rate <= 1 ? rate : null;
}

/**
 * 汇总最近调用记录。只保留稳定的数值和最新记录摘要，不把原始请求内容带到按键。
 */
function aggregateRecentSummary(value = {}) {
  const supplied = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const items = recentItems(value).filter((item) => item && typeof item === "object");
  if (!items.length && (number(supplied.count) !== null || supplied.latest)) {
    const latest = supplied.latest && typeof supplied.latest === "object" ? supplied.latest : {};
    return {
      count: firstNumber(supplied.count, supplied.totalRequests),
      failed: firstNumber(supplied.failed),
      unknown: firstNumber(supplied.unknown),
      avgDuration: firstNumber(supplied.avgDuration),
      lastModel: typeof supplied.lastModel === "string" ? supplied.lastModel : typeof latest.model === "string" ? latest.model : null,
      lastStatus: firstNumber(supplied.lastStatus, latest.statusCode),
      lastCreatedAt: typeof supplied.lastCreatedAt === "string" ? supplied.lastCreatedAt : typeof latest.createdAt === "string" ? latest.createdAt : null,
      cacheHitRate: normalizeCacheRate(supplied.cacheHitRate),
      totalCost: firstNumber(supplied.totalCost),
      totalInputTokens: firstNumber(supplied.totalInputTokens),
      totalOutputTokens: firstNumber(supplied.totalOutputTokens),
      totalCacheReadTokens: firstNumber(supplied.totalCacheReadTokens),
      totalCacheCreationTokens: firstNumber(supplied.totalCacheCreationTokens),
      latest: latest && Object.keys(latest).length ? {
        model: typeof latest.model === "string" ? latest.model : null,
        billingModel: typeof latest.billingModel === "string" ? latest.billingModel : null,
        statusCode: firstNumber(latest.statusCode),
        createdAt: typeof latest.createdAt === "string" ? latest.createdAt : null,
      } : null,
    };
  }

  let failed = 0;
  let unknown = 0;
  let durationTotal = 0;
  let durationCount = 0;
  let totalCost = 0;
  let costCount = 0;
  let totalInputTokens = 0;
  let inputCount = 0;
  let totalOutputTokens = 0;
  let outputCount = 0;
  let totalCacheReadTokens = 0;
  let cacheReadCount = 0;
  let totalCacheCreationTokens = 0;
  let cacheCreationCount = 0;
  let cacheRateNumerator = 0;
  let cacheRateDenominator = 0;
  let latest = null;
  let latestTime = -Infinity;

  for (const item of items) {
    if (number(item.statusCode) === null) unknown += 1;
    else if (statusFailed(item.statusCode)) failed += 1;
    const duration = number(item.duration);
    if (duration !== null && duration >= 0) {
      durationTotal += duration;
      durationCount += 1;
    }
    const cost = firstNumber(item.cost, item.costUsd);
    if (cost !== null) {
      totalCost += cost;
      costCount += 1;
    }
    const input = firstNumber(item.inputTokens);
    if (input !== null) {
      totalInputTokens += input;
      inputCount += 1;
    }
    const output = firstNumber(item.outputTokens);
    if (output !== null) {
      totalOutputTokens += output;
      outputCount += 1;
    }
    const cacheRead = firstNumber(item.cacheReadInputTokens, item.cacheReadTokens);
    if (cacheRead !== null) {
      totalCacheReadTokens += cacheRead;
      cacheReadCount += 1;
    }
    const cacheCreation = firstNumber(item.cacheCreationInputTokens, item.cacheCreationTokens);
    if (cacheCreation !== null) {
      totalCacheCreationTokens += cacheCreation;
      cacheCreationCount += 1;
    }
    const cacheInput = firstNumber(item.cacheInputTotal);
    const actualRate = normalizeCacheRate(item.actualCacheRate);
    const cacheReadInput = firstNumber(item.cacheReadInputTokens, item.cacheReadTokens);
    if (actualRate !== null) {
      // actualCacheRate 已由服务端按缓存 Token 定义，优先于本地推导值。
      const weight = cacheInput !== null && cacheInput > 0 ? cacheInput : 1;
      cacheRateNumerator += actualRate * weight;
      cacheRateDenominator += weight;
    } else if (cacheReadInput !== null && cacheInput !== null && cacheInput > 0) {
      cacheRateNumerator += cacheReadInput;
      cacheRateDenominator += cacheInput;
    } else if (cacheInput !== null && input !== null && input + cacheInput > 0) {
      cacheRateNumerator += cacheInput;
      cacheRateDenominator += input + cacheInput;
    }
    const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
    const time = createdAt ? Date.parse(createdAt) : NaN;
    if (!latest || (Number.isFinite(time) && time >= latestTime)) {
      latest = item;
      latestTime = Number.isFinite(time) ? time : latestTime;
    }
  }

  const latestSummary = latest ? {
    model: typeof latest.model === "string" ? latest.model : null,
    billingModel: typeof latest.billingModel === "string" ? latest.billingModel : null,
    statusCode: firstNumber(latest.statusCode),
    createdAt: typeof latest.createdAt === "string" ? latest.createdAt : null,
  } : null;
  return {
    count: items.length,
    failed,
    unknown,
    avgDuration: durationCount ? durationTotal / durationCount : null,
    lastModel: latestSummary?.model || null,
    lastStatus: latestSummary?.statusCode ?? null,
    lastCreatedAt: latestSummary?.createdAt || null,
    cacheHitRate: cacheRateDenominator ? cacheRateNumerator / cacheRateDenominator : null,
    totalCost: costCount ? totalCost : null,
    totalInputTokens: inputCount ? totalInputTokens : null,
    totalOutputTokens: outputCount ? totalOutputTokens : null,
    totalCacheReadTokens: cacheReadCount ? totalCacheReadTokens : null,
    totalCacheCreationTokens: cacheCreationCount ? totalCacheCreationTokens : null,
    latest: latestSummary,
  };
}

module.exports = {
  DEFAULTS,
  USAGE_RANGES,
  USAGE_METRICS,
  localDate,
  number,
  textNumber,
  money,
  compactMoney,
  amount,
  compactAmount,
  normalizeUsageRange,
  normalizeMetric,
  usageDataForRange,
  aggregateUsageMetrics,
  aggregateRecentSummary,
  normalizedConfig,
};
