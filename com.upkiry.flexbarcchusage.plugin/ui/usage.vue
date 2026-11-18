<template>
  <v-container>
    <v-radio-group v-model="range" label="时间范围" hide-details @update:modelValue="onRangeChange">
      <v-radio v-for="item in ranges" :key="item.value" :label="item.label" :value="item.value" />
    </v-radio-group>
    <v-radio-group v-model="metric" label="显示指标" hide-details @update:modelValue="emitUpdate">
      <v-radio v-for="item in metrics" :key="item.value" :label="item.label" :value="item.value" :disabled="!metricAvailable(item.value)" />
    </v-radio-group>
  </v-container>
</template>

<script>
const RANGES = [
  { value: "5h", label: "5 小时" },
  { value: "1d", label: "1 天" },
  { value: "7d", label: "7 天" },
  { value: "1m", label: "30 天" },
];
const METRICS = [
  { value: "callsCost", label: "调用次数与成本" },
  { value: "tokens", label: "输入与输出 Token" },
  { value: "cache", label: "缓存读写" },
  { value: "recent", label: "最近调用" },
  { value: "summary", label: "日期汇总" },
];
// 5 小时范围只拿得到配额接口里的金额，其它指标没有对应数据。
const FIVE_HOUR_METRICS = new Set(["callsCost"]);

export default {
  name: "UsageSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
  data() { return { range: "1d", metric: "callsCost", ranges: RANGES, metrics: METRICS, applied: null }; },
  watch: {
    modelValue: {
      deep: true,
      handler(next) {
        const range = this.readRange(next);
        const metric = this.readMetric(next);
        // 忽略宿主回推的旧值，避免把用户刚选好的内容弹回去。
        if (this.applied && this.applied.range === range && this.applied.metric === metric) {
          this.applied = null;
          return;
        }
        this.range = range;
        this.metric = metric;
      },
    },
  },
  methods: {
    readRange(source = this.modelValue) {
      const value = source?.data?.range;
      return RANGES.some((item) => item.value === value) ? value : "1d";
    },
    readMetric(source = this.modelValue) {
      const value = source?.data?.metric;
      return METRICS.some((item) => item.value === value) ? value : "callsCost";
    },
    metricAvailable(value) {
      return this.range !== "5h" || FIVE_HOUR_METRICS.has(value);
    },
    onRangeChange() {
      // 切到 5 小时范围时把不可用的指标换回调用次数与成本。
      if (!this.metricAvailable(this.metric)) this.metric = "callsCost";
      this.emitUpdate();
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.applied = { range: this.range, metric: this.metric };
      this.$emit("update:modelValue", {
        ...model,
        data: { ...data, range: this.range, metric: this.metric },
      });
    },
  },
  created() {
    this.range = this.readRange();
    this.metric = this.readMetric();
  },
};
</script>
