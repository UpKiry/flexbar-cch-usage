const { plugin, logger } = require("@eniac/flexdesigner");
const { createPluginRuntime } = require("./runtime");
const { localDate, money, normalizedConfig } = require("./core");

createPluginRuntime({ plugin, logger }).start();

// Keep the small formatting surface available to existing integrations.
module.exports = { localDate, money, normalizedConfig };
