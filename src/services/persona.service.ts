import fs from 'node:fs';
import path from 'node:path';
import type { Persona, PersonaListItem } from '../types';
import type { ConnectionRepo, PersonaRepo } from '../db/repos';
import type { ConfigService } from './config.service';
import { LlmGateway } from '../llm/gateway';

export class PersonaService {
  constructor(
    private repo: PersonaRepo,
    private connRepo: ConnectionRepo,
    private config: ConfigService,
    private resourceDir: string
  ) {}

  list(): PersonaListItem[] {
    const all = this.repo.list();
    return all.map((row) => {
      const p = safeParse(row.content_json) ?? { id: row.id, name: row.name, profilePrompt: '' };
      return {
        ...p,
        builtin: row.builtin === 1,
        referencedBy: this.repo.listReferencedBy(row.id).map((c) => c.name),
        updatedAt: row.updated_at,
      };
    });
  }

  get(id: string): Persona | undefined {
    const row = this.repo.get(id);
    if (!row) return undefined;
    return safeParse(row.content_json) ?? undefined;
  }

  /** 导入人格（JSON 文本），返回校验结果 */
  import(content: string): { ok: boolean; id?: string; error?: string } {
    let p: Persona;
    try {
      p = JSON.parse(content) as Persona;
    } catch {
      return { ok: false, error: 'JSON 解析失败' };
    }
    const err = validatePersona(p);
    if (err) return { ok: false, error: err };
    p.id = p.id || `persona_${Date.now()}`;
    this.repo.upsert(p, false);
    return { ok: true, id: p.id };
  }

  remove(id: string): { ok: boolean; error?: string } {
    const row = this.repo.get(id);
    if (!row) return { ok: false, error: '人格不存在' };
    if (row.builtin === 1) return { ok: false, error: '内置人格不可删除' };
    if (this.repo.listReferencedBy(id).length > 0) {
      return { ok: false, error: '该人格正被连接引用，请先解除引用' };
    }
    this.repo.remove(id);
    return { ok: true };
  }

  export(id: string): Persona | undefined {
    return this.get(id);
  }

  update(id: string, patch: Partial<Persona>): { ok: boolean; error?: string } {
    const cur = this.get(id);
    if (!cur) return { ok: false, error: '人格不存在' };
    const next = { ...cur, ...patch, id };
    const err = validatePersona(next);
    if (err) return { ok: false, error: err };
    const row = this.repo.get(id);
    this.repo.upsert(next, row?.builtin === 1);
    return { ok: true };
  }

  /** 在线生成人格（无鉴权）：调用已配置 LLM 产出结构化 JSON */
  async generate(description: string): Promise<Persona> {
    const llmCfg = this.config.load().llm;
    const gateway = new LlmGateway(llmCfg, 'system', null, () => undefined);
    const prompt = [
      '你是人格设计助手。请根据用户描述生成一个聊天人格，只输出 JSON，不要解释。',
      'JSON 字段：id, name, profile, profilePrompt（必须包含 {user_message} 占位）, tags（数组）, emotionStyle, sampleDialogues（数组，元素 {user,bot}）, bannedWords（数组）。',
      '用户描述：',
      description,
    ].join('\n');
    const res = await gateway.complete(prompt);
    const parsed = extractJson(res.text);
    if (parsed) {
      const p = parsed as Persona;
      if (!validatePersona(p)) {
        p.id = p.id || `persona_${Date.now()}`;
        this.repo.upsert(p, false);
        return p;
      }
    }
    // 兜底：生成基础人格
    const fallback: Persona = {
      id: `persona_${Date.now()}`,
      name: '自定义人格',
      profile: description.slice(0, 200),
      profilePrompt: `你要扮演以下人设：${description}\n\n当前对话：\n用户：{user_message}\n请以该人设回复：`,
      tags: ['自定义'],
      emotionStyle: '自然',
      sampleDialogues: [],
      bannedWords: [],
    };
    this.repo.upsert(fallback, false);
    return fallback;
  }

  help(): string {
    const file = path.join(this.resourceDir, 'persona-help.md');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    return '# 人格格式\n\n必填字段：name、profilePrompt（含 {user_message}）。';
  }

  /** 启动时确保内置默认人格存在 */
  ensureDefaults(): void {
    const id = 'persona_default';
    if (this.repo.get(id)) return;
    const p: Persona = {
      id,
      name: '默认人格 · 小助手',
      profile: '友善、简洁、乐于助人的通用聊天助手。',
      profilePrompt:
        '你是一个友善、简洁的聊天助手。回复自然口语化，不啰嗦，不输出违规内容。\n\n当前对话：\n用户：{user_message}\n请回复：',
      tags: ['通用', '友善', '简洁'],
      emotionStyle: '自然',
      sampleDialogues: [
        { user: '在吗', bot: '在的，有什么事吗？' },
        { user: '今天好累', bot: '辛苦了，记得休息一下。' },
      ],
      bannedWords: [],
    };
    this.repo.upsert(p, true);
  }
}

function safeParse(s: string): Persona | null {
  try {
    return JSON.parse(s) as Persona;
  } catch {
    return null;
  }
}

function validatePersona(p: Persona): string | null {
  if (!p || typeof p !== 'object') return '人格数据格式错误';
  if (!p.name || typeof p.name !== 'string') return '缺少必需字段 name';
  if (!p.profilePrompt || typeof p.profilePrompt !== 'string') return '缺少必需字段 profilePrompt';
  if (!p.profilePrompt.includes('{user_message}')) return 'profilePrompt 必须包含 {user_message} 占位符';
  return null;
}

function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
