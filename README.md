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

