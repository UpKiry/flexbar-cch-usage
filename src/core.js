/**
 * 纯逻辑层：配置归一化、接口数据归一化和按键视图模型。
 *
 * 这里不允许出现任何 I/O、计时器或宿主 API 调用，保证可以在没有
 * FlexDesigner 运行时的环境里直接单元测试。
 */

const USAGE_RANGES = ["5h", "1d", "7d", "1m"];
const USAGE_METRICS = ["callsCost", "tokens", "cache", "recent", "summary"];
const DEFAULTS = { refreshIntervalSeconds: 60, usageRange: "1d" };
const QUOTA_CID_SUFFIX = "quota";
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析宿主所在时区。CC Hub 的“今天”按用户本地日历计算，
 * 硬编码 Asia/Shanghai 会让其他时区的用户每天提前或滞后 8 小时切换。
 */
function resolveTimeZone() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof resolved === "string" && resolved) return resolved;
  } catch {
    // Intl 不可用时退回默认时区。
  }
  return DEFAULT_TIME_ZONE;
}

function localDate(date = new Date(), timeZone = resolveTimeZone()) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: DEFAULT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
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

function safeCurrency(value) {
  return typeof value === "string" && /^[A-Za-z]{1,6}$/.test(value) ? value : null;
}

/** 按键上显示用的金额：USD 用 $ 前缀，其他币种用代码前缀。 */
function displayMoney(value, currency = "USD") {
  if (number(value) === null) return "-";
  const unit = safeCurrency(currency) || "USD";
  return unit === "USD" ? `$${value.toFixed(2)}` : `${unit} ${value.toFixed(2)}`;
}

/** 上限为空表示“未设置限制”，与“金额未知”区分开。 */
function displayLimit(value, currency = "USD") {
  if (value === null) return "∞";
  return displayMoney(value, currency);
}

function displayCount(value) {
  return number(value) === null ? "-" : number(value).toLocaleString("en-US");
}

const COUNT_UNITS = [
  { unit: "K", scale: 1e3 },
  { unit: "M", scale: 1e6 },
  { unit: "B", scale: 1e9 },
  { unit: "T", scale: 1e12 },
];

/**
 * Token 数量显示：大数改用 K/M/B 缩写，按键上一眼可读。
 *
 * 小于 1000 保持精确数字；单位内小于 10 保留一位小数（如 1.2K），
 * 其余取整（如 12K）。四舍五入进位到 1000 时升到上一级单位（999500 → 1M），
 * 避免出现 "1000K" 这样的写法。
 */
function displayTokens(value) {
  const count = number(value);
  if (count === null) return "-";
  const abs = Math.abs(count);
  if (abs < 1000) return String(count);
  let index = 0;
  while (index + 1 < COUNT_UNITS.length && abs >= COUNT_UNITS[index + 1].scale) index += 1;
  const format = (step) => {
    const scaled = count / step.scale;
    return (scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled))).replace(/\.0$/, "");
  };
  let text = format(COUNT_UNITS[index]);
  if (Number(text) >= 1000 && index + 1 < COUNT_UNITS.length) {
    index += 1;
    text = format(COUNT_UNITS[index]);
  }
  return `${text}${COUNT_UNITS[index].unit}`;
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
  const source = isObject(value) ? value : {};
  const raw = source.refreshIntervalSeconds;
  // 空字符串、null 和 0 都不是合法的刷新间隔：Number("") 与 Number(null) 都等于 0，
  // 直接参与夹取会得到 15 秒的轮询频率，等于把 CC Hub 打满。
  const interval = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  return {
    cchUrl: safeConfigValue(source.cchUrl || source.CCH_URL).replace(/\/+$/, ""),
    apiKey: safeConfigValue(source.apiKey || source.CCH_API_KEY),
    refreshIntervalSeconds: Number.isFinite(interval) && interval > 0
      ? Math.max(15, Math.min(3600, Math.round(interval)))
      : DEFAULTS.refreshIntervalSeconds,
  };
}

function hasConfig(value) {
  return Boolean(value && typeof value.cchUrl === "string" && value.cchUrl.trim()
    && typeof value.apiKey === "string" && value.apiKey.trim());
}

function firstNumber(...values) {
  for (const value of values) {
    const normalized = number(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function sumNumbers(...values) {
  const numbers = values.map(finiteOrNull).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

function finiteOrNull(value) {
  return number(value);
}

/**
 * 找到某个时间范围实际使用的数据来源。
 *
 * "1 天"会同时用到 /me/today 和 stats-summary 两个来源：today 负责调用次数与
 * 成本，stats-summary 负责缓存字段。合并时 today 优先，这样放置其它按键
 * 不会改变"1 天"按键已经显示出来的调用次数。
 *
 * slices 列出全部参与的数据分片，调用方据此判断这一段数据是否过期。
 */
function usageSourceFor(state = {}, range = "1d") {
  const normalizedRange = normalizeUsageRange(range);
  const source = isObject(state) ? state : {};
  if (normalizedRange === "5h") {
    return {
      slice: "quota",
      slices: ["quota"],
      data: isObject(source.quota) ? source.quota : {},
    };
  }
  const summaries = isObject(source.summaries) ? source.summaries : {};
  if (normalizedRange === "1d") {
    const summary = isObject(summaries["1d"]) ? summaries["1d"] : null;
    const today = isObject(source.today) ? source.today : null;
    if (summary && today) {
      return { slice: "today", slices: ["today", "1d"], data: { ...summary, ...today } };
    }
    if (summary) return { slice: "1d", slices: ["1d"], data: summary };
    if (today) return { slice: "today", slices: ["today"], data: today };
    return { slice: "1d", slices: ["1d"], data: {} };
  }
  if (isObject(summaries[normalizedRange])) {
    return {
      slice: normalizedRange,
      slices: [normalizedRange],
      data: summaries[normalizedRange],
    };
  }
  return { slice: normalizedRange, slices: [normalizedRange], data: {} };
}

function usageDataForRange(state = {}, range = "1d") {
  return usageSourceFor(state, range).data;
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
  return aggregateUsageMetricsFrom(source);
}

/** 只针对一份已经定位好的汇总数据做归一化，避免再次按范围二次解析。 */
function aggregateUsageMetricsFrom(source = {}) {
  const input = isObject(source) ? source : {};
  const inputTokens = firstNumber(input.inputTokens, input.totalInputTokens);
  const outputTokens = firstNumber(input.outputTokens, input.totalOutputTokens);
  const totalTokens = firstNumber(input.totalTokens, sumNumbers(inputTokens, outputTokens));
  const cacheCreationTokens = firstNumber(
    input.cacheCreationTokens,
    input.totalCacheCreationTokens,
    input.cacheCreationInputTokens,
  );
  const cacheReadTokens = firstNumber(
    input.cacheReadTokens,
    input.totalCacheReadTokens,
    input.cacheReadInputTokens,
  );
  const cacheCreation5mTokens = firstNumber(
    input.cacheCreation5mTokens,
    input.totalCacheCreation5mTokens,
    input.cacheCreation5mInputTokens,
  );
  const cacheCreation1hTokens = firstNumber(
    input.cacheCreation1hTokens,
    input.totalCacheCreation1hTokens,
    input.cacheCreation1hInputTokens,
  );
  return {
    calls: firstNumber(input.calls, input.totalRequests, input.requests),
    cost: firstNumber(input.costUsd, input.totalCost, input.cost),
    currencyCode: safeCurrency(input.currencyCode),
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

// ---------------------------------------------------------------------------
// 视图模型：按键图片与按键标题共用同一份结果，避免两处逻辑漂移。
// ---------------------------------------------------------------------------

const RANGE_LABELS = { "1d": "1 天", "7d": "7 天", "1m": "30 天", "5h": "5 小时" };

function quotaStatusText(quota) {
  if (quota?.keyIsEnabled === false || quota?.userIsEnabled === false) return "禁用";
  if (quota?.keyIsEnabled === true || quota?.userIsEnabled === true) return "启用";
  return "";
}

function quotaExpiryText(quota) {
  const value = quota?.expiresAt || quota?.userExpiresAt;
  if (typeof value !== "string") return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(time));
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return month && day ? `到期 ${month}-${day}` : "";
  } catch {
    return "";
  }
}

/** 某个数据分片是否已经过期。整轮刷新失败时所有分片都算过期。 */
function sliceStale(state = {}, slices = []) {
  if (state?.stale) return true;
  const fresh = state?.fresh;
  if (!isObject(fresh)) return false;
  const list = Array.isArray(slices) ? slices : [slices];
  return list.some((slice) => fresh[slice] === false);
}

function quotaView(state = {}, quota = {}) {
  const stale = sliceStale(state, ["quota"]);
  const current = number(quota.keyCurrent5hUsd);
  const limit = number(quota.keyLimit5hUsd);
  const percent = current !== null && limit > 0 ? Math.min(999, current / limit * 100) : null;
  const status = quotaStatusText(quota);
  const expiry = quotaExpiryText(quota);
  const concurrent = number(quota.keyCurrentConcurrentSessions);
  const concurrentLimit = number(quota.keyLimitConcurrentSessions);
  const details = [];
  if (status === "禁用") details.push(status);
  if (concurrent !== null) {
    details.push(`并发 ${displayCount(concurrent)}${concurrentLimit === null ? "" : `/${displayCount(concurrentLimit)}`}`);
  }
  if (expiry) details.push(expiry);
  if (!details.length && status) details.push(status);
  const disabled = quota.keyIsEnabled === false || quota.userIsEnabled === false;
  return {
    label: "配额 · 5 小时",
    value: `${displayMoney(current, quota.currencyCode)}/${displayLimit(quota.keyLimit5hUsd, quota.currencyCode)}${percent === null ? "" : ` ${percent.toFixed(0)}%`}`,
    tone: disabled || (percent !== null && percent >= 95)
      ? "critical"
      : percent !== null && percent >= 80
        ? "warning"
        : stale ? "stale" : "normal",
    status: [...details, stale ? "数据过期" : ""].filter(Boolean).join(" "),
    percent,
  };
}

function recentView(state = {}) {
  const stale = sliceStale(state, ["recent"]);
  const summary = state.recentSummary || aggregateRecentSummary(state.recentLogs);
  const latest = summary.latest || {};
  const model = summary.lastModel || latest.model || latest.billingModel;
  const details = [];
  if (state.recentError) details.push("最近数据失败");
  if (finiteOrNull(summary.failed) !== null) details.push(`失败 ${displayCount(summary.failed)}`);
  if (finiteOrNull(summary.unknown) !== null && summary.unknown > 0) {
    details.push(`未知 ${displayCount(summary.unknown)}`);
  }
  if (finiteOrNull(summary.avgDuration) !== null) {
    details.push(`${Math.round(summary.avgDuration)}ms`);
  }
  if (finiteOrNull(summary.lastStatus) !== null) details.push(String(Math.round(summary.lastStatus)));
  if (finiteOrNull(summary.cacheHitRate) !== null) {
    details.push(`缓存 ${(summary.cacheHitRate * 100).toFixed(0)}%`);
  }
  return {
    label: "最近调用",
    value: `${displayCount(summary.count)}${state.recentTruncated ? "+" : ""}次${model ? ` ${safeModelName(model)}` : ""}`,
    tone: summary.failed > 0 ? "warning" : stale ? "stale" : "normal",
    status: [...details, stale ? "数据过期" : ""].filter(Boolean).join(" "),
    percent: null,
  };
}

function safeModelName(value) {
  if (typeof value !== "string") return "未知模型";
  const normalized = value.trim().replace(/[^A-Za-z0-9._/@:+-]/g, "");
  return normalized ? normalized.slice(0, 18) : "未知模型";
}

function usageView(state = {}, range = "1d", metric = "callsCost") {
  const rangeLabel = RANGE_LABELS[range] || range;
  if (metric === "recent") return recentView(state);
  if (range === "5h") {
    const stale = sliceStale(state, ["quota"]);
    const quota = isObject(state.quota) ? state.quota : {};
    const value = metric === "callsCost"
      ? displayMoney(quota.keyCurrent5hUsd, quota.currencyCode)
      : metric === "cache" ? "缓存暂无"
        : metric === "summary" ? "汇总暂无" : "Token暂无";
    return {
      label: "用量 · 5 小时",
      value,
      tone: stale ? "stale" : "normal",
      status: stale ? "数据过期" : "",
      percent: null,
    };
  }
  const { slices, data } = usageSourceFor(state, range);
  const relevantSlices = range === "1d" && slices.length > 1
    ? (metric === "cache" ? ["1d"] : ["today"])
    : slices;
  const stale = sliceStale(state, relevantSlices);
  const metrics = aggregateUsageMetricsFrom(data);
  const suffix = stale ? "数据过期" : "";
  if (metric === "tokens") {
    const tokenValue = metrics.inputTokens !== null || metrics.outputTokens !== null
      ? `${displayTokens(metrics.inputTokens)}+${displayTokens(metrics.outputTokens)}`
      : displayTokens(metrics.totalTokens);
    return {
      label: `Token · ${rangeLabel}`,
      value: `${tokenValue} Token`,
      tone: stale ? "stale" : "normal",
      status: suffix,
      percent: null,
    };
  }
  if (metric === "cache") {
    const details = [
      metrics.cacheCreation5mTokens === null ? "" : `5m ${displayTokens(metrics.cacheCreation5mTokens)}`,
      metrics.cacheCreation1hTokens === null ? "" : `1h ${displayTokens(metrics.cacheCreation1hTokens)}`,
      suffix,
    ].filter(Boolean).join(" ");
    return {
      label: `缓存 · ${rangeLabel}`,
      value: `${displayTokens(metrics.cacheReadTokens)}读/${displayTokens(metrics.cacheCreationTokens)}写`,
      tone: stale ? "stale" : "normal",
      status: details,
      percent: null,
    };
  }
  if (metric === "summary") {
    return {
      label: `汇总 · ${rangeLabel}`,
      value: `${displayCount(metrics.calls)}次 ${displayMoney(metrics.cost, metrics.currencyCode)}`,
      tone: stale ? "stale" : "normal",
      status: suffix,
      percent: null,
    };
  }
  return {
    label: `用量 · ${rangeLabel}`,
    value: `${displayCount(metrics.calls)} 次 · ${displayMoney(metrics.cost, metrics.currencyCode)}`,
    tone: stale ? "stale" : "normal",
    status: suffix,
    percent: null,
  };
}

/**
 * 生成按键的视图模型。图片和标题都从这里取数据，二者不会再出现分歧。
 */
function buildView(cid = "", state = {}, config = {}, keyData = {}) {
  if (!config || !config.cchUrl || !config.apiKey) {
    return {
      label: "需要配置",
      value: "请配置 CC Hub",
      tone: "muted",
      status: "未配置",
      percent: null,
    };
  }
  if (String(cid).endsWith(QUOTA_CID_SUFFIX)) {
    return quotaView(state, isObject(state?.quota) ? state.quota : {});
  }
  const range = normalizeUsageRange(keyData?.range);
  const metric = normalizeMetric(keyData?.metric);
  return usageView(state, range, metric);
}

/** 按键标题：与图片共用视图模型，只做安全截断。 */
function viewTitle(view = {}) {
  const label = typeof view.label === "string" ? view.label : "";
  const value = typeof view.value === "string" ? view.value : "";
  const title = [label, value].filter(Boolean).join(" ");
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

/** 视图指纹：只依赖真正显示出来的内容，刷新时间戳不参与。 */
function fingerprintFor(cid = "", width = 0, view = {}) {
  return JSON.stringify({ cid, width, view });
}

module.exports = {
  DEFAULTS,
  USAGE_RANGES,
  USAGE_METRICS,
  DEFAULT_TIME_ZONE,
  localDate,
  resolveTimeZone,
  number,
  textNumber,
  money,
  compactMoney,
  amount,
  compactAmount,
  displayMoney,
  displayLimit,
  displayCount,
  displayTokens,
  normalizeUsageRange,
  normalizeMetric,
  usageDataForRange,
  usageSourceFor,
  aggregateUsageMetrics,
  aggregateUsageMetricsFrom,
  aggregateRecentSummary,
  normalizedConfig,
  hasConfig,
  buildView,
  viewTitle,
  fingerprintFor,
  sliceStale,
};
