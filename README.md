# Flexbar CC Hub 用量插件

这是一个用于 Flexbar/FlexDesigner 的 Claude Code Hub 用量仪表盘插件。它通过 CC Hub 的登录 API 获取配额、今日用量和日期汇总，并在 Flexbar 上显示配额和用量两个固定按键。按键使用插件自绘 PNG 和内嵌 CJK 字体，避免原生标题布局重叠或中文缺字：

当前版本：`1.3.0`

- 配额（固定 5 小时周期）
- 用量（按键配置可选 5h、1d、7d、1m，默认 1d）

插件启动、设备连接和按键点击时会刷新数据，默认每 60 秒自动刷新一次。网络或 API 失败时保留最后一次成功数据，并标记“数据过期”。

## 配置

在 FlexDesigner 的插件配置页填写：

- `CC Hub URL`：你的 CC Hub 部署地址
- `API Key`：可用于网页登录的用户 API Key
- 刷新间隔（秒）：范围 15～3600，默认 60

在 FlexDesigner 中打开“用量”按键配置，可以为每个按键单独选择时间范围：

- `5h`：显示 quota 当前消费金额
- `1d`：今日调用次数和金额
- `7d`：最近 7 天调用次数和金额
- `1m`：最近 30 天调用次数和金额

API Key 只保存在 FlexDesigner 配置中，不会写入按键数据或日志。插件是自包含的，不依赖上一级 `cch-usage` 目录。

## 开发

环境要求：Node.js 18+、FlexDesigner 1.3+、Flexbar。自绘渲染使用 `@napi-rs/canvas`，按键目标尺寸为 240×60；设备返回 180px 宽度时自动使用紧凑布局。构建时会把当前 Node 平台对应的 canvas 原生模块同步到插件包；当前发布包同时包含 macOS arm64 与 Windows x64 原生模块。

~~~bash
npm install
npm run build
npm run plugin:validate
npm run dev
~~~

打包和安装：

~~~bash
npm run plugin:pack
npm run plugin:install
~~~

## API 行为

插件使用以下 CC Hub 接口：

- `POST /api/auth/login`
- `GET /api/v1/me/quota`
- `GET /api/v1/me/today`
- `GET /api/v1/me/usage-logs/stats-summary`

`today`、`7d` 和 `1m` 只会在存在对应范围的用量按键时请求；相同范围的请求会在一次刷新中合并。

登录 Cookie 在插件进程内复用；401 会重新登录一次，临时错误会进行一次退避重试。

## 验证

V1 的客户端、刷新并发、缓存保留、多设备按键隔离、事件处理和 PNG 绘制均有 Node.js mock 测试覆盖。提交前运行：

~~~bash
npm test
npm run build
npm run plugin:validate
npm run plugin:pack
~~~
