<template>
  <v-container>
    <v-radio-group v-model="range" label="时间范围" hide-details @update:modelValue="emitUpdate">
      <v-radio v-for="item in ranges" :key="item.value" :label="item.label" :value="item.value" />
    </v-radio-group>
    <v-radio-group v-model="metric" label="显示指标" hide-details @update:modelValue="emitUpdate">
      <v-radio v-for="item in metrics" :key="item.value" :label="item.label" :value="item.value" />
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

export default {
  name: "UsageSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
  data() { return { range: "1d", metric: "callsCost", ranges: RANGES, metrics: METRICS }; },
  watch: {
    modelValue: {
      deep: true,
      handler() {
        this.range = this.readRange();
        this.metric = this.readMetric();
      },
    },
  },
  methods: {
    readRange() {
      const value = this.modelValue?.data?.range;
      return RANGES.some((item) => item.value === value) ? value : "1d";
    },
    readMetric() {
      const value = this.modelValue?.data?.metric;
      return METRICS.some((item) => item.value === value) ? value : "callsCost";
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.$emit("update:modelValue", {
        ...model,
        data: { ...data, range: this.range, metric: this.metric },
      });
    },
  },
  created() { this.metric = this.readMetric(); },
  mounted() { this.range = this.readRange(); },
};
</script>
