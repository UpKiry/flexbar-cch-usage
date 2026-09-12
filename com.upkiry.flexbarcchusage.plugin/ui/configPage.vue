<template>
  <v-container>
    <v-text-field v-model.trim="form.cchUrl" label="CC Hub URL" placeholder="https://your-cc-hub.example.com" :error-messages="urlError" outlined />
    <v-text-field v-model="form.apiKey" label="API Key" type="password" :error-messages="apiKeyError" outlined />
    <v-text-field v-model.number="form.refreshIntervalSeconds" label="刷新间隔（秒）" type="number" min="15" max="3600" :error-messages="intervalError" outlined />
    <v-btn :loading="saving" :disabled="!isValid" color="primary" @click="saveConfig">保存配置</v-btn>
    <v-btn :loading="testing" :disabled="!isValid || saving" color="secondary" class="ml-3" @click="testConnection">测试连接</v-btn>
    <span class="result" :class="{ error: saveError || testError }">{{ saveResult || testResult }}</span>
  </v-container>
</template>

<script>
const DEFAULT_CONFIG = { cchUrl: "", apiKey: "", refreshIntervalSeconds: 60 };

export default {
  data() {
    return { form: { ...DEFAULT_CONFIG }, loading: true, saving: false, saveResult: "", saveError: false, testing: false, testResult: "", testError: false };
  },
  computed: {
    urlError() {
      if (!this.form.cchUrl) return "请填写 CC Hub URL";
      try { const url = new URL(this.form.cchUrl); return ["http:", "https:"].includes(url.protocol) ? "" : "URL 必须使用 HTTP 或 HTTPS"; }
      catch { return "请输入有效的 URL"; }
    },
    apiKeyError() { return typeof this.form.apiKey === "string" && this.form.apiKey.trim() ? "" : "请填写 API Key"; },
    intervalError() { const value = Number(this.form.refreshIntervalSeconds); return Number.isFinite(value) && value >= 15 && value <= 3600 ? "" : "请输入 15～3600"; },
    isValid() { return !this.urlError && !this.apiKeyError && !this.intervalError; },
  },
  watch: {
  },
  methods: {
    serializableConfig() {
      return {
        cchUrl: String(this.form.cchUrl || "").trim(),
        apiKey: String(this.form.apiKey || ""),
        refreshIntervalSeconds: Number(this.form.refreshIntervalSeconds),
      };
    },
    async loadConfig() {
      try {
        const stored = await this.$fd.getConfig();
        this.form = { ...DEFAULT_CONFIG, ...(stored || {}) };
      } catch (error) {
        this.saveResult = error?.message || "读取配置失败";
        this.saveError = true;
      } finally {
        this.loading = false;
      }
    },
    async saveConfig() {
      if (!this.isValid) return;
      this.saving = true; this.saveResult = ""; this.saveError = false;
      try {
        await this.$fd.setConfig(this.serializableConfig());
        this.saveResult = "配置已保存";
      } catch (error) {
        this.saveResult = error?.message || "保存配置失败";
        this.saveError = true;
      } finally {
        this.saving = false;
      }
    },
    async testConnection() {
      if (!this.isValid) return;
      this.testing = true; this.testResult = ""; this.testError = false;
      try {
        await this.saveConfig();
        if (this.saveError) return;
        const result = await this.$fd.sendToBackend({ action: "testConnection", config: this.serializableConfig() });
        this.testResult = result?.message || "连接成功"; this.testError = result?.status !== "success";
      } catch (error) { this.testResult = error?.message || "连接失败"; this.testError = true; }
      finally { this.testing = false; }
    },
  },
  mounted() {
    this.loadConfig();
  },
};
</script>

<style scoped>
.result { margin-left: 12px; color: #2e7d32; }
.result.error { color: #c62828; }
.ml-3 { margin-left: 12px; }
</style>
