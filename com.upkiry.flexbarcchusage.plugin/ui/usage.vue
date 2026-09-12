<template>
  <v-container>
    <v-select
      v-model="range"
      :items="ranges"
      item-title="label"
      item-value="value"
      label="时间范围"
      outlined
      hide-details
      @update:modelValue="emitUpdate"
    />
  </v-container>
</template>

<script>
const RANGES = [
  { value: "5h", label: "5h（最近 5 小时配额）" },
  { value: "1d", label: "1d（今日）" },
  { value: "7d", label: "7d（最近 7 天）" },
  { value: "1m", label: "1m（最近 30 天）" },
];

export default {
  name: "UsageSettings",
  props: {
    modelValue: { type: Object, required: true },
  },
  emits: ["update:modelValue"],
  data() {
    return { range: "1d", ranges: RANGES };
  },
  watch: {
    modelValue: {
      deep: true,
      handler() {
        this.range = this.readRange();
      },
    },
  },
  methods: {
    readRange() {
      const value = this.modelValue?.data?.range;
      return RANGES.some((item) => item.value === value) ? value : "1d";
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.$emit("update:modelValue", { ...model, data: { ...data, range: this.range } });
    },
  },
  mounted() {
    this.range = this.readRange();
    this.emitUpdate();
  },
};
</script>
