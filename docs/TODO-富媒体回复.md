# QQAiChatBot 富媒体回复 · 剩余项代办（2026-10-20）

> 富媒体回复（表情包 + 语音）已实现并合入 `v0.1.4`。以下为**发布后仍需联调 / 验证 / 补全的剩余项**，
> 均不影响文字回复主链路（失败自动降级），但要在真实 QQ 环境里收尾确认。

---

## R1 · 官方 Bot 富媒体消息体结构联调（P1，需真实 AppID/AppSecret）

- **现状**：`src/connectors/official.ts` 的图片/语音发送按 QQ 开放平台常规写法实现：
  - 上传：`POST /v2/groups|users/{id}/files`，`file_type=1`（图片）/`3`（语音）；
  - 发送：富媒体消息 `msg_type:7 + media.file_info`。
- **风险**：`msg_type` / `media` 字段结构是据文档推断，**未用真实 Bot 联调**，可能需按当前官方文档微调。
- **待办**：
  - [ ] 用真实 AppID/AppSecret 启动连接，验证表情包（图片）能正常发出。
  - [ ] 验证语音（`file_type=3` 上传 mp3）能否被 QQ 接受；若不接受 mp3，需确认需 silk 并补转码。
  - [ ] 核对官方「富媒体消息」与「文件上传」接口的字段名（`file_info` / `media` 结构），以官方文档为准。
- **验收**：官方 Bot 在群里 @ 后，表情包按图片正常显示；语音消息可播放。

## R2 · Edge TTS 非官方接口验证（P1）

- **现状**：`src/tts/gateway.ts` 的 `EdgeTtsProvider` 用 WebSocket + 固定 `TrustedClientToken`（`6A5AA1D4…`）实现。
- **风险**：Edge 为**非官方接口**，token / 协议可能变化；本开发环境实测返回 `403`，无法验证合成成功。
- **待办**：
  - [ ] 在用户本地网络验证 Edge 语音能否合成；`403/404` 时改用 openai-compatible 厂商。
  - [ ] 若 Edge 长期不可用，考虑移除或替换为其他免费 TTS（如硅基流动免费额度、MiniMax 等）。
- **建议**：**openai-compatible 为稳定主路径**，Edge 仅作免费兜底。
- **验收**：任一 TTS 厂商能在人格开启「语音回复」后，回复附带可播放语音。

## R3 · 官方 Bot 语音精确 silk 格式（P2，可选）

- **现状**：本版 TTS 直接输出 mp3，未做 silk 转码；OneBot 渠道由 NapCat 自动转码，官方 Bot 渠道需 QQ 接受 mp3。
- **待办**（仅在 R1 确认 mp3 不被官方 Bot 接受时做）：
  - [ ] `TtsGateway` 增加 ffmpeg → silk 转码步骤（已预留位置），并随包附带或声明 ffmpeg 运行依赖。

## R4 · 打包验收（P1）

- **待办**：
  - [ ] `npm run pack` 打包后，`node scripts/verify-asar.cjs <app.asar>` 确认 `002_sticker.sql` 迁移脚本、`dist/`、`web/dist/` 已进包。
  - [ ] 安装版覆盖安装到旧目录，验证旧 `data/` 数据可读、迁移 `user_version 1→2` 正常执行、表情包管理页可导入图片。
- **验收**：打包版上「表情包管理」页可正常建组/导入/打标签；人格绑定表情包组后，命中 `[sticker:标签]` 能发图。
