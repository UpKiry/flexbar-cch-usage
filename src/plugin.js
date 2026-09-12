const os = require("node:os");
const path = require("node:path");
const { plugin, logger } = require("@eniac/flexdesigner");
const { createPluginRuntime } = require("./runtime");
const { localDate, money, normalizedConfig } = require("./core");

const configStorePath = path.join(os.homedir(), ".flexbar-cch-usage", "config.json");

createPluginRuntime({ plugin, logger, configStorePath }).start();

// Keep the small formatting surface available to existing integrations.
module.exports = { localDate, money, normalizedConfig };
