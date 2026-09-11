# 仓库指南

## 项目结构与模块组织

- `src/plugin.js` 包含 FlexDesigner 事件处理、CC Hub 客户端、刷新流程和按键渲染逻辑。
- `src/core.js` 存放无外部依赖的配置与格式化工具。可复用逻辑应放在这里，以便脱离 FlexDesigner 运行时进行测试。
- `test/*.test.js` 存放 Node.js 单元测试。
- `com.upkiry.flexbarcchusage.plugin/` 是插件发布目录：`manifest.json` 定义元数据和按键，`ui/` 包含 Vue 配置页面，`resources/` 存放静态资源。
- `rollup.config.mjs` 将源码打包至已忽略的 `com.upkiry.flexbarcchusage.plugin/backend/` 目录。不要直接修改生成的后端文件。
- `PLAN.md` 记录项目范围、验收标准和真机验证状态。

## 构建、测试与开发命令

- `npm install`：安装开发依赖。
- `npm test`：使用 Node.js 内置的 `node:test` 运行全部测试。
- `npm run build`：使用 Rollup 生成生产环境插件包。
- `npm run plugin:validate`：使用 `flexcli` 校验插件目录。
- `npm run dev`：链接插件、监听源码与 UI 文件、在构建后重启插件并输出调试日志。
- `npm run plugin:pack`：生成 `com.upkiry.flexbarcchusage.flexplugin`；`npm run plugin:install`：将该插件包安装至 FlexDesigner。

## 编码风格与命名约定

使用两个空格缩进、分号以及 `const`/`let`。`src/` 沿用现有 CommonJS 风格，`rollup.config.mjs` 使用 ESM。函数和变量使用 `camelCase`，类使用 `PascalCase`，常量使用大写蛇形命名，如 `KEY_CIDS`。面向用户的文字应简洁，并与现有中文界面保持一致。项目未配置格式化或检查工具，因此请遵循相邻代码风格并保持改动集中。

## 测试指南

测试应放在 `test/` 下，以 `*.test.js` 结尾，并使用 `node:assert/strict`。重点覆盖配置边界、回退值、日期与时区行为，以及容易出错的格式化逻辑。项目暂未设定覆盖率门槛。提交前请运行 `npm test`、`npm run build` 和 `npm run plugin:validate`。涉及渲染、配置持久化、设备重连或定时器的改动还需在 FlexDesigner/Flexbar 上手动验证；未完成的硬件验证必须明确记录。

## 提交与拉取请求指南

当前历史中只有简短提交 `初始化项目`，尚未形成正式规范。提交主题应简短、清晰且语言统一，每个提交只处理一类改动。拉取请求应说明行为变化、列出验证命令、关联相关问题，并为配置页或按键布局改动附上截图。同时注明清单或版本变化，以及尚未完成的真机验证。

## 安全与配置

切勿提交 API Key、认证 Cookie、运行日志或已填写的本地配置。不要将密钥写入日志、按键数据、错误信息、截图或插件发布包。
