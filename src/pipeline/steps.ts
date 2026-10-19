import type { ChatConfig, NormalizedMessage, TriggerMode } from '../types';
import type { CachedBanwords } from '../db/repos';

export const FALLBACK_REPLY = '（嗯…我现在有点忙，稍后再聊）';

/** 触发决策：P0 固定「仅 @ 回复」；keyword/random 为 P1 占位 */
export class TriggerDecision {
  static should(m: NormalizedMessage, mode: TriggerMode): boolean {
    if (mode === 'silent') return false;
    if (mode === 'keyword' || mode === 'random') return m.atBot; // [P1]
    return m.atBot;
  }
}

/** 白 / 黑名单（群 + 对象两级） */
export class AccessControl {
  static allow(m: NormalizedMessage, chat: ChatConfig): boolean {
    const groups = new Set(chat.groupList ?? []);
    const users = new Set(chat.userList ?? []);
    const hit = Boolean((m.groupId && groups.has(m.groupId)) || users.has(m.fromId));
    return chat.mode === 'whitelist' ? hit : !hit;
  }
}

/** 内容安全：输入脱敏 + 双向违禁词（全局词库 + 人格红线词） */
export class SafetyFilter {
  static redactPii(text: string): string {
    return text.replace(/1[3-9]\d{9}/g, '***').replace(/\d{17}[\dXx]/g, '***');
  }

  static checkIn(
    text: string,
    global: CachedBanwords,
    persona: string[]
  ): { text: string; rejected: boolean } {
    const clean = this.redactPii(text);
    return { text: clean, rejected: this.hit(clean, global.in, persona) };
  }

  static checkOut(text: string, global: CachedBanwords, persona: string[]): string {
    return this.hit(text, global.out, persona) ? FALLBACK_REPLY : text;
  }

  private static hit(text: string, globalSet: Set<string>, persona: string[]): boolean {
    for (const w of persona) if (w && text.includes(w)) return true;
    for (const w of globalSet) if (w && text.includes(w)) return true;
    return false;
  }
}

/** 组装系统提示词（替换 {user_message}） */
export class PromptBuilder {
  static build(
    profilePrompt: string,
    history: Array<{ role: string; content: string }>,
    userText: string
  ): string {
    const base = profilePrompt.includes('{user_message}')
      ? profilePrompt.replace(/\{user_message\}/g, userText)
      : `${profilePrompt}\n\n当前对话：\n用户：${userText}\n请回复：`;
    if (!history.length) return base;
    const ctx = history.map((h) => `${h.role === 'user' ? '用户' : '你'}：${h.content}`).join('\n');
    return `${base}\n\n【最近对话】\n${ctx}`;
  }
}
