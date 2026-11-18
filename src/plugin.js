const os = require("node:os");
const path = require("node:path");
const { plugin, logger } = require("@eniac/flexdesigner");
const { createPluginRuntime } = require("./runtime");
const { localDate, money, normalizedConfig } = require("./core");

const configStorePath = path.join(os.homedir(), ".flexbar-cch-usage", "config.json");

// 插件后端是一个独立进程，任何未捕获的异常都会让宿主认为插件崩溃并重启它。
// 这里把异常记录下来而不是让进程退出，长时间运行才不会莫名其妙地断开。
function reportFatal(scope) {
  return (error) => {
    const message = error?.message || String(error || "未知错误");
    try {
      logger.error(`${scope}：${message}`);
    } catch {
      // 日志通道本身不可用时忽略。
    }
  };
}

process.on("unhandledRejection", (reason) => {
  reportFatal("未处理的 Promise 拒绝")(reason);
});
process.on("uncaughtException", (error) => {
  reportFatal("未捕获的异常")(error);
});

const runtime = createPluginRuntime({ plugin, logger, configStorePath });

try {
  runtime.start();
} catch (error) {
  logger.error(`插件启动失败：${error?.message || error}`);
}

// Keep the small formatting surface available to existing integrations.
module.exports = { localDate, money, normalizedConfig, runtime };
