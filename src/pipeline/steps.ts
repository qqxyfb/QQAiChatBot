import type { ChatConfig, NormalizedMessage } from '../types';
import type { CachedBanwords } from '../db/repos';

export const FALLBACK_REPLY = '（嗯…我现在有点忙，稍后再聊）';

/** 判定结果：除布尔值外附带原因，便于日志定位「为什么没回」 */
export interface Decision {
  ok: boolean;
  reason: string;
}

/**
 * 触发决策：仅 @ / 关键词 / 概率闲聊 / 静默
 *
 * 注意私聊（c2c）没有「@」语义：`at` 模式下 C2C 消息的 atBot 恒为 false，
 * 若不放行会导致私聊被静默丢弃（历史 bug）。keyword / random 在私聊里语义成立，
 * 仍按用户配置执行，不额外放行。
 */
export class TriggerDecision {
  static should(m: NormalizedMessage, chat: ChatConfig): boolean {
    return TriggerDecision.evaluate(m, chat).ok;
  }

  static evaluate(m: NormalizedMessage, chat: ChatConfig): Decision {
    const mode = chat.trigger ?? 'at';
    if (mode === 'silent') return { ok: false, reason: '触发未通过：mode=silent（静默模式）' };

    if (mode === 'keyword') {
      const keywords = chat.triggerKeywords ?? [];
      const hit = keywords.find((k) => k && m.content.includes(k));
      if (hit) return { ok: true, reason: `关键词命中：${hit}` };
      if (m.atBot) return { ok: true, reason: '被 @' };
      return { ok: false, reason: '触发未通过：mode=keyword 且未命中关键词、未 @' };
    }

    if (mode === 'random') {
      if (m.atBot) return { ok: true, reason: '被 @' };
      const p = chat.randomProbability ?? 0;
      if (Math.random() < p) return { ok: true, reason: `概率命中（p=${p}）` };
      return { ok: false, reason: `触发未通过：mode=random 且未命中概率（p=${p}）` };
    }

    // mode === 'at'
    if (m.atBot) return { ok: true, reason: '被 @' };
    if (m.channel === 'c2c') return { ok: true, reason: '私聊直通（c2c 无 @ 语义）' };
    return { ok: false, reason: '触发未通过：mode=at 且未 @' };
  }
}

export interface QuoteDecision extends Decision {
  quote: boolean;
}

/**
 * 引用回复决策：群聊里「回谁」必须看得见，否则 @ 之后发出的消息像是凭空插话。
 * 默认 auto = 被 @ 才引用，避免每句话都拖着一条引用；私聊永远不引用。
 */
export class ReplyQuote {
  static should(m: NormalizedMessage, chat: ChatConfig): boolean {
    return ReplyQuote.evaluate(m, chat).quote;
  }

  static evaluate(m: NormalizedMessage, chat: ChatConfig): QuoteDecision {
    const mode = chat.replyQuote ?? 'auto';
    if (mode === 'off') return { ok: false, quote: false, reason: '引用回复已关闭（off）' };
    if (m.channel !== 'group') return { ok: false, quote: false, reason: '私聊无引用语义，直接发送' };
    if (mode === 'always') return { ok: true, quote: true, reason: '群聊引用回复（always）' };
    return m.atBot
      ? { ok: true, quote: true, reason: '被 @，使用引用回复' }
      : { ok: false, quote: false, reason: '群聊未被 @，不引用' };
  }
}

/** 白 / 黑名单（群 + 对象两级） */export class AccessControl {
  static allow(m: NormalizedMessage, chat: ChatConfig): boolean {
    return AccessControl.evaluate(m, chat).ok;
  }

  static evaluate(m: NormalizedMessage, chat: ChatConfig): Decision {
    const groups = new Set(chat.groupList ?? []);
    const users = new Set(chat.userList ?? []);
    const hit = Boolean((m.groupId && groups.has(m.groupId)) || users.has(m.fromId));
    if (chat.mode === 'whitelist') {
      return hit ? { ok: true, reason: '名单通过：白名单命中' } : { ok: false, reason: '名单拦截：不在白名单' };
    }
    return hit ? { ok: false, reason: '名单拦截：黑名单命中' } : { ok: true, reason: '名单通过：黑名单未命中' };
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
  ): { text: string; rejected: boolean; hit?: string } {
    const clean = this.redactPii(text);
    const hit = this.find(clean, global.in, persona);
    return { text: clean, rejected: Boolean(hit), hit };
  }

  static checkOut(text: string, global: CachedBanwords, persona: string[]): string {
    return this.find(text, global.out, persona) ? FALLBACK_REPLY : text;
  }

  private static find(text: string, globalSet: Set<string>, persona: string[]): string | undefined {
    for (const w of persona) if (w && text.includes(w)) return w;
    for (const w of globalSet) if (w && text.includes(w)) return w;
    return undefined;
  }
}

/** 组装系统提示词（替换 {user_message}） */
export class PromptBuilder {
  static build(
    profilePrompt: string,
    history: Array<{ role: string; content: string }>,
    userText: string,
    stickerTags?: string[],
    stickerHint?: string
  ): string {
    const base = profilePrompt.includes('{user_message}')
      ? profilePrompt.replace(/\{user_message\}/g, userText)
      : `${profilePrompt}\n\n当前对话：\n用户：${userText}\n请回复：`;
    let out = history.length
      ? `${base}\n\n【最近对话】\n${history.map((h) => `${h.role === 'user' ? '用户' : '你'}：${h.content}`).join('\n')}`
      : base;
    if (stickerTags && stickerTags.length > 0) {
      // 只把表情包说成「文字后面的点缀」：既不发空消息，也避免每条都甩图。
      out +=
        `\n\n【表情包】表情包是可选点缀，${stickerHint || '多数回复不要用，只在情绪明显时偶尔用一次'}。` +
        `用法：先正常写出文字回复，再在末尾追加 [sticker:标签]，例如「好呀，我也这么觉得[sticker:开心]」。` +
        `不要只输出标记而不写文字，也不要连续多条都带。可选标签仅限：${stickerTags.join('、')}；不合适就不输出该标记。`;
    }
    return out;
  }
}
