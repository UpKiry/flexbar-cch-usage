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
const MIN_INTERVAL = 15;
const MAX_INTERVAL = 3600;
// 后端刚重启时可能暂时没有响应，不能让配置页一直转圈。
const BACKEND_TIMEOUT_MS = 8000;

export default {
  data() {
    return {
      form: { ...DEFAULT_CONFIG },
      loading: true,
      saving: false,
      saveResult: "",
      saveError: false,
      testing: false,
      testResult: "",
      testError: false,
      dirty: false,
    };
  },
  computed: {
    urlError() {
      if (!this.form.cchUrl) return "请填写 CC Hub URL";
      try { const url = new URL(this.form.cchUrl); return ["http:", "https:"].includes(url.protocol) ? "" : "URL 必须使用 HTTP 或 HTTPS"; }
      catch { return "请输入有效的 URL"; }
    },
    apiKeyError() { return typeof this.form.apiKey === "string" && this.form.apiKey.trim() ? "" : "请填写 API Key"; },
    intervalError() {
      const value = this.form.refreshIntervalSeconds;
      // 留空表示使用默认间隔，后端会回落到 60 秒，不应该拦着不让保存。
      if (value === "" || value === null || value === undefined) return "";
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return `请输入 ${MIN_INTERVAL}～${MAX_INTERVAL}`;
      if (numeric < MIN_INTERVAL || numeric > MAX_INTERVAL) return `请输入 ${MIN_INTERVAL}～${MAX_INTERVAL}`;
      return "";
    },
    isValid() { return !this.urlError && !this.apiKeyError && !this.intervalError; },
  },
  watch: {
    "form.cchUrl"() { this.dirty = true; },
    "form.apiKey"() { this.dirty = true; },
    "form.refreshIntervalSeconds"() { this.dirty = true; },
  },
  methods: {
    serializableConfig() {
      const raw = Number(this.form.refreshIntervalSeconds);
      const interval = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_CONFIG.refreshIntervalSeconds;
      return {
        cchUrl: String(this.form.cchUrl || "").trim(),
        apiKey: String(this.form.apiKey || ""),
        refreshIntervalSeconds: Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, interval)),
      };
    },
    async sendToBackend(payload) {
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("插件后端没有响应，请稍后重试")), BACKEND_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      });
      return Promise.race([this.$fd.sendToBackend(payload), timeout]);
    },
    async loadConfig() {
      try {
        let stored = await this.$fd.getConfig();
        if (!stored?.cchUrl || !stored?.apiKey) {
          const restored = await this.sendToBackend({ action: "getConfig" }).catch(() => null);
          if (restored?.status === "success" && restored.config) stored = restored.config;
        }
        // 用户已经动过表单时，不要用读回来的旧配置覆盖输入。
        if (this.dirty) return;
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
      let persisted = false;
      try {
        const config = this.serializableConfig();
        const result = await this.$fd.setConfig(config);
        // 宿主可能拒绝写入，这时不能再告诉用户"已保存"。
        if (result && result.status && result.status !== "success") {
          throw new Error(result.message || result.error || "保存配置失败");
        }
        persisted = true;
        const restart = globalThis.window?.electronAPI?.pluginOperation;
        if (typeof restart === "function") {
          this.saveResult = "配置已保存，插件正在重启";
          await restart({ type: "restart", uuid: "com.upkiry.flexbarcchusage" });
        } else {
          const applied = await this.sendToBackend({ action: "applyConfig", config });
          if (applied?.status !== "success") throw new Error(applied?.message || "刷新失败");
        }
        this.saveResult = "配置已保存";
      } catch (error) {
        this.saveResult = persisted
          ? `配置已保存，但插件重启失败：${error?.message || "请稍后手动重启插件"}`
          : (error?.message || "保存配置失败");
        this.saveError = true;
      } finally {
        this.saving = false;
      }
    },
    async testConnection() {
      if (!this.isValid) return;
      this.testing = true; this.testResult = ""; this.testError = false; this.saveResult = ""; this.saveError = false;
      try {
        const result = await this.sendToBackend({ action: "testConnection", config: this.serializableConfig() });
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
