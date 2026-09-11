const DEFAULTS = { refreshIntervalSeconds: 60, dateRangeDays: 7 };

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

function safeConfigValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizedConfig(value = {}) {
  const interval = Number(value.refreshIntervalSeconds);
  const days = Number(value.dateRangeDays);
  return {
    cchUrl: safeConfigValue(value.cchUrl || value.CCH_URL).replace(/\/+$/, ""),
    apiKey: safeConfigValue(value.apiKey || value.CCH_API_KEY),
    refreshIntervalSeconds: Number.isFinite(interval)
      ? Math.max(15, Math.min(3600, Math.round(interval)))
      : DEFAULTS.refreshIntervalSeconds,
    dateRangeDays: Number.isFinite(days)
      ? Math.max(1, Math.min(90, Math.round(days)))
      : DEFAULTS.dateRangeDays,
  };
}

module.exports = {
  DEFAULTS,
  localDate,
  number,
  textNumber,
  money,
  compactMoney,
  normalizedConfig,
};
