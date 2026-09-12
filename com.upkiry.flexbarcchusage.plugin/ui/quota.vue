<template>
  <v-container>
    <v-radio-group v-model="range" label="时间范围" hide-details @update:modelValue="emitUpdate">
      <v-radio v-for="item in ranges" :key="item.value" :label="item.label" :value="item.value" />
    </v-radio-group>
  </v-container>
</template>

<script>
const RANGES = [
  { value: "5h", label: "5h（配额上限）" },
  { value: "1d", label: "1d（今日成本）" },
  { value: "7d", label: "7d（最近 7 天成本）" },
  { value: "1m", label: "1m（最近 30 天成本）" },
];

export default {
  name: "QuotaSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
  data() { return { range: "5h", ranges: RANGES }; },
  watch: { modelValue: { deep: true, handler() { this.range = this.readRange(); } } },
  methods: {
    readRange() {
      const value = this.modelValue?.data?.range;
      return RANGES.some((item) => item.value === value) ? value : "5h";
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.$emit("update:modelValue", { ...model, data: { ...data, range: this.range } });
    },
  },
  mounted() { this.range = this.readRange(); this.emitUpdate(); },
};
</script>
