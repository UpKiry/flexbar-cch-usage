<template>
  <v-container>
    <v-alert type="info" variant="tonal">
      配额周期固定为 5 小时，按键显示当前使用金额和配额上限。
    </v-alert>
  </v-container>
</template>

<script>
export default {
  name: "QuotaSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
};
</script>
