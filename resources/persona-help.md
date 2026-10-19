# 人格数据格式规范

人格档案是一个 JSON 文件，导入即用（**无需授权鉴权**）。

## 最小示例

```json
{
  "id": "persona_luna",
  "name": "示例人格 · Luna",
  "profile": "温柔黏人、爱撒娇的陪伴型人格，说话简短。",
  "profilePrompt": "你要完全模仿「Luna」的说话方式：温柔、简短，常用「呀/呢/嘛」收尾。\n\n当前对话：\n用户：{user_message}\n请回复：",
  "tags": ["温柔", "句短"],
  "emotionStyle": "温柔",
  "sampleDialogues": [
    { "user": "在吗", "bot": "在的呀～" },
    { "user": "今天好累", "bot": "辛苦啦，早点休息" }
  ],
  "bannedWords": ["政治敏感话题", "露骨色情描写", "辱骂攻击他人"]
}
```

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 否 | 唯一标识；留空则自动生成 |
| `name` | **是** | 显示名 |
| `profile` | 否 | 人格画像（页面展示用，200 字内） |
| `profilePrompt` | **是** | 核心系统提示词，**必须包含 `{user_message}` 占位符** |
| `tags` | 否 | 标签数组 |
| `emotionStyle` | 否 | 情绪风格（温柔 / 高冷 / 沙雕 / 理性 等） |
| `sampleDialogues` | 否 | 示例对话，元素为 `{ user, bot }` |
| `bannedWords` | 否 | 安全红线词，命中即拒绝/兜底 |

## 校验规则

- `name`、`profilePrompt` 缺失 → 导入失败。
- `profilePrompt` 不含 `{user_message}` → 导入失败（请补齐占位符）。

## 在线生成

在「人格管理 → 在线生成」输入人设描述（如：温柔、说话简短、喜欢用「呀」结尾），
系统会调用已配置的 LLM 生成符合上述格式的人格 JSON，预览后保存。
