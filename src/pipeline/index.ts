import type {
  ChatConfig,
  FinishReason,
  MetricEvent,
  NormalizedMessage,
  Persona,
  ReplyPayload,
} from '../types';
import type { CachedBanwords } from '../db/repos';
import type { ContextManager } from './context';
import type { RateLimiter, TokenBudget } from './limits';
import { AccessControl, FALLBACK_REPLY, PromptBuilder, SafetyFilter, TriggerDecision } from './steps';
import type { LlmGateway, LlmResult } from '../llm/gateway';
import { shortHash } from '../utils/hash';

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
}

/** 核心链路：每连接一个独立实例 */
export class Pipeline {
  constructor(private d: PipelineDeps) {}

  async handle(m: NormalizedMessage): Promise<void> {
    const d = this.d;
    const t0 = Date.now();
    const persona = d.getPersona();
    const banwords = d.getBanwords();
    const personaBanned = persona.bannedWords ?? [];
    const fromHash = shortHash(m.fromId);
    const groupHash = shortHash(m.groupId);

    // ① 触发决策（P0 固定仅 @ 回复）
    if (!TriggerDecision.should(m, d.chat.trigger)) return;

    // ② 白 / 黑名单
    if (!AccessControl.allow(m, d.chat)) return;

    // 频率限制
    if (!d.limiter.allow()) {
      d.emit({ kind: 'abuse', connectionId: d.connectionId, fromHash, reason: '频率限制', abuseKind: 'rate' });
      return;
    }

    // 输入长度
    if (d.chat.maxInputLen > 0 && m.content.length > d.chat.maxInputLen) {
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
      await this.reply(m, FALLBACK_REPLY, 'refuse', null, t0);
      return;
    }

    // ⑤ 组装 prompt
    const prompt = PromptBuilder.build(persona.profilePrompt, history, checked.text);

    // ⑥ LLM 调用
    const llm = d.createLlm();
    const res = await llm.complete(prompt);

    // token 预算（超限则兜底，不再消耗）
    const totalTokens = res.promptTokens + res.completionTokens;
    if (totalTokens > 0 && !d.tokenBudget.check(fromHash, totalTokens)) {
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

    // ⑦ 安全（出）
    const out = res.ok ? SafetyFilter.checkOut(res.text, banwords, personaBanned) : res.text;

    // ⑧ 回复 + 打点
    const finish: FinishReason = res.stub ? 'stub' : res.ok ? 'normal' : 'error';
    await this.reply(m, out, finish, res, t0);

    // 上下文更新（写入已 getOrCreate 的 buffer）
    buf.push({ role: 'user', content: m.content }, { role: 'assistant', content: out });
  }

  private async reply(
    m: NormalizedMessage,
    text: string,
    finishReason: FinishReason,
    llm: LlmResult | null,
    t0: number
  ): Promise<void> {
    const d = this.d;
    try {
      await d.sendReply({
        messageId: m.messageId,
        content: text,
        channel: m.channel,
        fromId: m.fromId,
        groupId: m.groupId,
      });
    } catch (e) {
      d.emit({
        kind: 'log',
        connectionId: d.connectionId,
        level: 'WARN',
        source: 'pipeline',
        msg: `回复发送失败：${(e as Error).message}`,
      });
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
      reply: text,
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
