# QQ AI ChatBot 后台客户端

基于 LLM 的 QQ 聊天机器人**多连接管理后台**：一个控制台管理多个 QQ 连接（官方机器人 / 登录 QQ 号），每个连接独立配置人格、白黑名单、上下文与 token 预算。

> 文档：[需求文档](docs/需求文档.md) · [概要设计](docs/概要设计文档.md) · [详细设计](docs/详细设计文档.md)

## 功能（P0）

- **多连接管理**：新建 / 删除 / 启停 / 全部启停；官方 Bot 与登录 QQ 号（OneBot v11）可并存
- **连接级配置**：连接属性、人格绑定、白/黑名单、上下文条数、每日 token 预算、限流
- **人格资源库**：导入 / 展示 / 在线生成 / 删除；内置默认人格；无需授权鉴权
- **运行日志**：服务 / 连接器 / LLM / 管道四源，实时推送 + 按连接/级别/关键字筛选
- **数据统计**：消息、Token、费用、延迟分位、结果分布、Top 对象（全局 / 单连接）
- **使用消耗**：今日 / 7 天 / 30 天费用与时段 Token 消耗
- **聊天记录**：按连接/对象/关键字检索，CSV/JSON 导出
- **更新检测**：GitHub Release

## 快速开始

```bash
# 环境：Node.js 24 LTS（node:sqlite 稳定）
npm install

# 开发（后端 + 前端分离）
npm run dev            # 后端 http://127.0.0.1:8700
npm run build:web      # 构建前端到 web/dist（后端会自动托管）

# 生产
npm run build
npm start              # node --experimental-sqlite dist/main.js
```

浏览器访问 `http://127.0.0.1:8700`。

### 打包

```bash
npm run pack          # NSIS 安装版 + portable → release/
```

产物：

- `release/QQAiChatBot-Setup-<ver>-x64.exe` — NSIS 安装版（安装向导 / 快捷方式 / 卸载项）
- `release/QQAiChatBot-Portable-<ver>.exe` — 便携版单文件

> **Electron 版本硬性要求**：`electron-builder.yml` 已锁定 `electronVersion: 37.10.3`（内置 Node 22.21）。Electron 33/34 内置 Node 20，**不支持 `node:sqlite`**，打出的包服务进程会启动即崩溃。升级 Electron 时务必确认内置 Node ≥ 22.5。
>
> 无管理员权限环境已设置 `signAndEditExecutable: false`：exe 使用默认 Electron 图标且未签名（SmartScreen 可能提示）。有签名证书后可移除该配置。
>
> 发布前建议跑 `node scripts/verify-asar.cjs <app.asar>`，确认 `dist/`、`web/dist/`、迁移脚本都已打进包内。

## 冒烟验证

```bash
node scripts/smoke-pipeline.cjs   # 上下文/安全过滤/LLM 演示/打点
curl http://127.0.0.1:8700/api/health
```

### 前端托管回归验证（必跑）

```bash
npm run verify        # build + 从临时目录启动，断言 / 与 /config 返回 index.html
```

该脚本故意把工作目录切到系统临时目录再启动 `dist/main.js`，专门防止「打包后 cwd 不可控导致前端 404」的问题回归。

## 常见问题

### 安装后打开是黑屏，窗口里显示 `{"message":"Route GET:/ not found",...}`

服务已在监听，但没找到前端产物 `web/dist/index.html`，于是 Fastify 用默认 404 JSON 应答根路径。

历史原因：`src/server/app.ts` 曾用 `process.cwd()` 拼 `web/dist`。Electron 以子进程拉起服务核心时 cwd 由启动方式决定（快捷方式、便携版解压目录、命令行），并不等于安装目录，打包版必然找不到前端。

现已改为：Electron 主进程通过 `QQAICHATBOT_WEB_DIR` / `QQAICHATBOT_APP_ROOT` 显式下发目录，服务端再用 `__dirname` 兜底，完全不再依赖 cwd；同时缺失产物时返回可读的 503 诊断页而不是裸 JSON。

排查顺序：

1. 看 `%APPDATA%\QQAiChatBot\electron.log`（桌面端启动全过程：端口、健康检查、加载结果）。
2. 浏览器访问 `http://127.0.0.1:8700`；能打开说明是桌面端问题，打不开看 `data\logs\server\*.log`。
3. `node scripts/verify-asar.cjs release/win-unpacked/resources/app.asar` 确认 `/web/dist/index.html` 已打进包内。
4. 端口被占用时桌面端会自动从 8700 向后顺延，实际端口见 `electron.log`。

## 目录结构

```
src/
  server/        HTTP（Fastify）+ 路由 + WS + 外网鉴权
  services/      config/connection/persona/log/stats/history/update
  manager/       连接管理器 + 连接运行时
  pipeline/      核心链路（触发→名单→上下文→安全→LLM→回复）
  connectors/    官方 Bot / OneBot v11 连接器
  llm/           OpenAI 兼容网关
  db/            node:sqlite + 迁移 + Repo
  events/        事件总线
web/             React + AntD + ECharts
resources/       人格格式帮助
data/            运行时数据（gitignore）
```

## 数据与安全

- 数据默认存于 `data/`（开发）或 `%APPDATA%/QQAiChatBot`（安装版）
- 密钥使用 AES-256-GCM 加密（`data/secrets.key`，0600）
- 对象标识（openid / QQ 号）以 sha256 短哈希落库
- 服务默认仅监听 `127.0.0.1`；开启外网访问必须配置访问令牌

## P1（二期）

聊天记录下钻、分连接对比、触发规则（关键词/概率）、LLM 覆盖、人格在线编辑、自动下载升级、OneBot 反向 WS。

