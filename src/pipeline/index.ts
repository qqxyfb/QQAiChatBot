import type {
  ChatConfig,
  FinishReason,
  LogLevel,
  MetricEvent,
  NormalizedMessage,
  Persona,
  ReplyPayload,
  Segment,
  StickerPolicy,
  TtsConfig,
} from '../types';
import type { CachedBanwords, StickerIndex } from '../db/repos';
import type { ContextManager } from './context';
import type { RateLimiter, TokenBudget } from './limits';
import { AccessControl, FALLBACK_REPLY, PromptBuilder, ReplyQuote, SafetyFilter, TriggerDecision } from './steps';
import type { LlmGateway, LlmResult } from '../llm/gateway';
import { shortHash } from '../utils/hash';
import {
  DEFAULT_SET_ID,
  MediaPlanner,
  normalizeStickerPolicy,
  stickerCooldownLeft,
  stickerPromptHint,
} from './media-planner';

export interface PipelineDeps {
  connectionId: string;
  chat: ChatConfig;
  context: ContextManager;
  limiter: RateLimiter;
  tokenBudget: TokenBudget;
  sendReply: (r: ReplyPayload) => Promise<void>;
  getPersona: () => Persona;
  getBanwords: () => CachedBanwords;
  createLlm: () => LlmGateway;
  sessionId: () => number | null;
  emit: (e: MetricEvent) => void;
  /** 当前人格所绑表情包组的标签枚举（注入 LLM prompt） */
  getStickerTags: (setId: string) => string[];
  /** 表情包倒排索引（媒体决策随机取文件用） */
  getStickerIndex: () => StickerIndex;
  /** 全局默认 TTS 配置（人格未覆盖时使用） */
  getGlobalTts: () => TtsConfig;
  /** 文字合成为语音段；失败返回 null */
  synthesizeVoice: (text: string, cfg: TtsConfig) => Promise<Segment | null>;
}

/** 核心链路：每连接一个独立实例 */
export class Pipeline {
  private chat: ChatConfig;
  /** 每个会话（群 / 对象）上次发表情包的时间，用于冷却与 prompt 收敛 */
  private stickerLastAt = new Map<string, number>();

  constructor(private d: PipelineDeps) {
    this.chat = d.chat;
  }

  /** 配置热更新：替换聊天配置，无需重建 pipeline（上下文等运行态保留） */
  setChat(chat: ChatConfig): void {
    this.chat = chat;
  }

  /** 记录表情包发送时间，惰性淘汰老会话，避免长期运行 Map 无限增长 */
  private markStickerSent(key: string): void {
    this.stickerLastAt.set(key, Date.now());
    if (this.stickerLastAt.size <= 2000) return;
    const stale = [...this.stickerLastAt.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.stickerLastAt.size - 1500);
    for (const [k] of stale) this.stickerLastAt.delete(k);
  }

  /** 链路日志：统一出口，source 固定 pipeline，方便前端按来源筛选 */
  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    this.d.emit({
      kind: 'log',
      connectionId: this.d.connectionId,
      level,
      source: 'pipeline',
      msg,
      meta,
    });
  }

  async handle(m: NormalizedMessage): Promise<void> {
    const d = this.d;
    const t0 = Date.now();
    const persona = d.getPersona();
    const banwords = d.getBanwords();
    const personaBanned = persona.bannedWords ?? [];
    const fromHash = shortHash(m.fromId);
    const groupHash = shortHash(m.groupId);
    const where = m.channel === 'c2c' ? `私聊 from=${fromHash}` : `群 ${groupHash} from=${fromHash}`;

    this.log('INFO', `收到消息（${where}，${m.content.length} 字）`);

    // ① 触发决策（仅@ / 关键词 / 概率 / 静默）
    const trigger = TriggerDecision.evaluate(m, this.chat);
    if (!trigger.ok) return this.log('DEBUG', trigger.reason);
    this.log('DEBUG', `触发通过：${trigger.reason}`);

    // ② 白 / 黑名单
    const access = AccessControl.evaluate(m, this.chat);
    if (!access.ok) return this.log('DEBUG', access.reason);
    this.log('DEBUG', `名单通过：${access.reason}`);

    // 频率限制（按对象分桶）
    const rate = d.limiter.evaluate(fromHash);
    if (!rate.ok) {
      this.log('WARN', `已拦截：${rate.reason}`);
      d.emit({ kind: 'abuse', connectionId: d.connectionId, fromHash, reason: rate.reason, abuseKind: 'rate' });
      return;
    }

    // 输入长度
    if (this.chat.maxInputLen > 0 && m.content.length > this.chat.maxInputLen) {
      this.log('WARN', `已拦截：输入超长（${m.content.length} > ${this.chat.maxInputLen}）`);
      d.emit({ kind: 'abuse', connectionId: d.connectionId, fromHash, reason: '输入超长', abuseKind: 'over_len' });
      await this.reply(m, FALLBACK_REPLY, 'limit', null, t0);
      return;
    }

    // ③ 上下文（getOrCreate：首次对话也会创建 buffer，避免 push 丢失）
    const key = `${m.channel}:${m.groupId ?? m.fromId}`;
    const buf = d.context.getOrCreate(key);
    const history = buf.recent();

    // ④ 安全（入）
    const checked = SafetyFilter.checkIn(m.content, banwords, personaBanned);
    if (checked.rejected) {
      this.log('WARN', `已拦截：输入命中违禁词（${checked.hit ?? '未知'}）`);
      await this.reply(m, FALLBACK_REPLY, 'refuse', null, t0);
      return;
    }

    // ⑤ 组装 prompt（注入表情包标签枚举，让 LLM 可输出 [sticker:标签]）
    const stickerSet = persona.stickerSet ?? DEFAULT_SET_ID;
    const policy = normalizeStickerPolicy(persona.sticker);
    const chatKey = `${m.channel}:${m.groupId ?? m.fromId}`;
    const lastStickerAt = this.stickerLastAt.get(chatKey) ?? 0;
    /** 冷却中 / 关闭时干脆不给标签：LLM 看不到枚举就不会想发，这是最有效的降频手段 */
    const cooldownLeft = stickerCooldownLeft(policy, lastStickerAt);
    const stickerBlocked = !policy.enabled || cooldownLeft > 0;
    const stickerTags = stickerBlocked ? [] : d.getStickerTags(stickerSet);
    if (stickerBlocked) {
      this.log(
        'DEBUG',
        !policy.enabled
          ? '表情包已关闭，本条不在 prompt 中提供标签'
          : `表情包冷却中（剩余 ${cooldownLeft}s），本条不在 prompt 中提供标签`
      );
    }
    const prompt = PromptBuilder.build(
      persona.profilePrompt,
      history,
      checked.text,
      stickerTags,
      stickerPromptHint(policy)
    );

    // ⑥ LLM 调用
    const llm = d.createLlm();
    this.log('INFO', `调用 LLM：model=${llm.model}，上下文 ${history.length} 条，prompt ${prompt.length} 字`);
    const res = await llm.complete(prompt);

    // token 预算（超限则兜底，不再消耗）
    const totalTokens = res.promptTokens + res.completionTokens;
    if (totalTokens > 0 && !d.tokenBudget.check(fromHash, totalTokens)) {
      this.log('WARN', `已拦截：超出每日 token 预算（本次 ${totalTokens} token）`);
      d.emit({
        kind: 'abuse',
        connectionId: d.connectionId,
        fromHash,
        reason: '超出每日 token 预算',
        abuseKind: 'budget',
      });
      await this.reply(m, FALLBACK_REPLY, 'limit', res, t0);
      return;
    }
    if (totalTokens > 0) d.tokenBudget.add(fromHash, totalTokens);

    if (res.ok) {
      this.log(
        'INFO',
        `LLM 返回：${res.promptTokens}+${res.completionTokens} token，耗时 ${res.elapsedMs}ms${
          res.stub ? '（演示模式）' : ''
        }`
      );
    } else {
      this.log('ERROR', `LLM 调用失败：${res.error ?? '未知错误'}（已发送兜底语）`);
    }

    // ⑦ 安全（出）
    const out = res.ok ? SafetyFilter.checkOut(res.text, banwords, personaBanned) : res.text;

    // ⑧ 媒体决策与装配（两级选择表情包 + 频率闸门）
    const plan = MediaPlanner.plan(out, stickerSet, d.getStickerIndex(), {
      policy,
      lastSentAt: lastStickerAt,
    });
    if (plan.sticker) {
      this.markStickerSent(chatKey);
      this.log('DEBUG', `发表情包：${plan.reason ?? ''}`);
    } else if (plan.reason) {
      this.log('DEBUG', `本条不发图：${plan.reason}`);
    }

    // ⑧.1 语音附加（人格开启 voice 且本条为文字回复时，对文字做 TTS）
    if (plan.hasText && persona.voice?.enabled) {
      // 人格级覆盖与全局默认合并：人格可只填音色，厂商/baseUrl 继承全局
      const ttsCfg = { ...d.getGlobalTts(), ...(persona.voice.tts ?? {}) };
      const voiceSeg = await d.synthesizeVoice(plan.text, ttsCfg);
      if (voiceSeg) plan.segments.push(voiceSeg);
      else this.log('WARN', '语音生成失败，已降级为纯文字回复');
    }

    // ⑧.2 空消息兜底：模型只输出了 [sticker:标签] 且被频率闸门拦下时，
    // 绝不能发一条空消息出去（QQ 会报错/用户看不到任何东西）
    let replyText = plan.text;
    if (plan.segments.length === 0) {
      replyText = '……';
      plan.segments.push({ type: 'text', text: replyText });
      this.log('WARN', '本条只有表情包标记且被频率控制拦下，已改为文字占位（可在人格里调高表情包概率）');
    }

    // ⑨ 回复 + 打点
    const finish: FinishReason = res.stub ? 'stub' : res.ok ? 'normal' : 'error';
    // 聊天记录要能看出「发了哪张图」：表情包只存在于 segments，正文里已被剥掉，
    // 若不补标记，纯表情包回复在记录里就是一片空白
    const historyText =
      plan.sticker && plan.tag ? `${replyText}${replyText ? ' ' : ''}[表情包:${plan.tag}]` : replyText;
    await this.reply(m, replyText, finish, res, t0, plan.segments, historyText);

    // 上下文更新（写入已 getOrCreate 的 buffer；表情包不入上下文，只存纯文本）
    buf.push({ role: 'user', content: m.content }, { role: 'assistant', content: plan.text || '[表情包]' });
  }

  private async reply(
    m: NormalizedMessage,
    text: string,
    finishReason: FinishReason,
    llm: LlmResult | null,
    t0: number,
    segments?: Segment[],
    /** 落库用文本（可含 [表情包:标签] 标记），缺省等同 text */
    historyText?: string
  ): Promise<void> {
    const d = this.d;
    const quote = ReplyQuote.evaluate(m, this.chat);
    try {
      await d.sendReply({
        messageId: m.messageId,
        content: text,
        segments,
        // 群聊被 @ 时引用原消息，群里才看得出在回谁；私聊不带
        quoteMessageId: quote.quote ? m.messageId : undefined,
        channel: m.channel,
        fromId: m.fromId,
        groupId: m.groupId,
      });
      this.log(
        'INFO',
        `回复已发送（${text.length} 字，总耗时 ${Date.now() - t0}ms，${finishReason}${
          quote.quote ? '，引用回复' : ''
        }）`
      );
    } catch (e) {
      this.log('WARN', `回复发送失败：${(e as Error).message}`);
    }

    d.emit({
      kind: 'message',
      connectionId: d.connectionId,
      sessionId: d.sessionId(),
      channel: m.channel,
      fromHash: shortHash(m.fromId),
      groupHash: shortHash(m.groupId),
      direction: 'out',
      content: m.content,
      reply: historyText ?? text,
      finishReason,
      latencyMs: Date.now() - t0,
      promptTokens: llm?.promptTokens ?? 0,
      completionTokens: llm?.completionTokens ?? 0,
      llmMs: llm?.elapsedMs ?? 0,
      llmAttempts: llm?.attempts ?? 0,
      persona: d.getPersona().name,
      msgId: m.messageId,
    });
  }
}
