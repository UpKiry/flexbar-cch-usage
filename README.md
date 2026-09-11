# Flexbar CC Hub 用量插件

这是一个用于 Flexbar/FlexDesigner 的 Claude Code Hub 用量仪表盘插件。它通过 CC Hub 的登录 API 获取配额、今日用量和日期汇总，并在 Flexbar 上显示四个固定按键。按键使用插件自绘 PNG 和内嵌 CJK 字体，避免原生标题布局重叠或中文缺字：

当前版本：`1.1.1`

- 用量总览
- 5 小时配额
- 今日用量
- 近期用量（默认 7 天）

插件启动、设备连接和按键点击时会刷新数据，默认每 60 秒自动刷新一次。网络或 API 失败时保留最后一次成功数据，并标记“数据过期”。

## 配置

在 FlexDesigner 的插件配置页填写：

- `CC Hub URL`：你的 CC Hub 部署地址
- `API Key`：可用于网页登录的用户 API Key
- 刷新间隔（秒）：范围 15～3600，默认 60
- 汇总天数：范围 1～90，默认 7

API Key 只保存在 FlexDesigner 配置中，不会写入按键数据或日志。插件是自包含的，不依赖上一级 `cch-usage` 目录。

## 开发

环境要求：Node.js 18+、FlexDesigner 1.3+、Flexbar。自绘渲染使用 `@napi-rs/canvas`，按键目标尺寸为 240×60；设备返回 180px 宽度时自动使用紧凑布局。

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

登录 Cookie 在插件进程内复用；401 会重新登录一次，临时错误会进行一次退避重试。
