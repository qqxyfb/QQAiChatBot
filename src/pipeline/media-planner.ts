import type { Segment, StickerPolicy } from '../types';
import type { StickerIndex } from '../db/repos/sticker.repo';

export const DEFAULT_SET_ID = 'default';

/**
 * 表情包默认策略：偏克制。
 * 历史版本只靠 prompt 建议，LLM 几乎每条都带标记，观感就是「刷屏」；
 * 默认 30% 概率 + 同会话 2 分钟冷却，能把频率压下来，用户可在人格里调整。
 */
export const DEFAULT_STICKER_POLICY: StickerPolicy = {
  enabled: true,
  probability: 0.3,
  minIntervalSec: 120,
};

export interface PlanOptions {
  /** 人格级表情包策略（缺省 DEFAULT_STICKER_POLICY） */
  policy?: StickerPolicy;
  /** 同一会话上次发表情包的时间戳（ms），0/undefined 表示没有 */
  lastSentAt?: number;
  /** 当前时间（便于测试注入） */
  now?: number;
  /** 随机数源（便于测试注入） */
  random?: () => number;
}

export interface PlanResult {
  segments: Segment[];
  hasText: boolean;
  text: string; // 去标记后的纯文本（用于上下文与打点）
  /** 本条是否真的带了表情包 */
  sticker: boolean;
  /** 命中的表情包标签（仅 sticker=true 时存在），用于在聊天记录里还原「发了什么图」 */
  tag?: string;
  /** 没发/发了表情包的原因，写进链路日志便于排查频率问题 */
  reason?: string;
}

const STICKER_TAG_RE = /\[sticker:([^\]]+)\]/;

/** 从 LLM 回复文本中提取表情包标签标记 [sticker:标签]，无则返回 null */
export function parseStickerTag(text: string): string | null {
  const m = text.match(STICKER_TAG_RE);
  return m ? m[1].trim() : null;
}

/** 剥离表情包标记，返回纯文本 */
export function stripStickerTag(text: string): string {
  return text.replace(STICKER_TAG_RE, '').trim();
}

/** 归一化策略：缺失/越界都收敛到可用值，避免脏配置把表情包关死或拉满 */
export function normalizeStickerPolicy(p?: Partial<StickerPolicy> | null): StickerPolicy {
  const enabled = p?.enabled ?? DEFAULT_STICKER_POLICY.enabled;
  const rawP = typeof p?.probability === 'number' && Number.isFinite(p.probability) ? p.probability : DEFAULT_STICKER_POLICY.probability;
  const rawGap =
    typeof p?.minIntervalSec === 'number' && Number.isFinite(p.minIntervalSec)
      ? p.minIntervalSec
      : DEFAULT_STICKER_POLICY.minIntervalSec;
  return {
    enabled: Boolean(enabled),
    probability: Math.min(1, Math.max(0, rawP)),
    minIntervalSec: Math.max(0, rawGap),
  };
}

/** 冷却中返回剩余秒数，否则 0。用于决定要不要在 prompt 里给出标签 */
export function stickerCooldownLeft(policy: StickerPolicy, lastSentAt: number | undefined, now = Date.now()): number {
  if (!policy.minIntervalSec || !lastSentAt) return 0;
  const left = policy.minIntervalSec * 1000 - (now - lastSentAt);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** 按概率档位给出「用多少」的口径，写进 prompt；概率越低说得越明确 */
export function stickerPromptHint(policy: StickerPolicy): string {
  if (policy.probability <= 0.15) return '极少使用，十条回复里最多一条带表情包';
  if (policy.probability <= 0.4) return '偶尔用，多数回复只写文字，不要每条都带';
  return '可以用，但不要连续多条都带';
}

/**
 * 媒体决策与装配：两级选择表情包 + 频率闸门。
 *  - 第一级（LLM 语义决策）由 prompt 的 [sticker:标签] 标记给出；
 *  - 第二级（文件多样性）对命中标签的候选文件随机取一张；
 *  - 闸门（enable / 概率 / 冷却）在这里兜底，LLM 想发不等于真的发。
 * 非法/无候选一律降级纯文字，绝不抛错。
 */
export class MediaPlanner {
  static plan(text: string, set: string, index: StickerIndex, opts: PlanOptions = {}): PlanResult {
    const tag = parseStickerTag(text);
    const clean = stripStickerTag(text);
    const textSegments: Segment[] = clean ? [{ type: 'text', text: clean }] : [];
    /** 未发图的统一出口：带上命中的标签，聊天记录里仍能看到「本来想发什么图」 */
    const miss = (reason?: string): PlanResult => ({
      segments: textSegments,
      hasText: Boolean(clean),
      text: clean,
      sticker: false,
      ...(tag ? { tag } : {}),
      ...(reason ? { reason } : {}),
    });

    if (!tag) return miss();

    const policy = normalizeStickerPolicy(opts.policy);
    if (!policy.enabled) return miss('表情包已关闭');

    const now = opts.now ?? Date.now();
    const left = stickerCooldownLeft(policy, opts.lastSentAt, now);
    if (left > 0) return miss(`冷却中（还需 ${left}s）`);

    const candidates = index.get(set)?.get(tag);
    if (!candidates || candidates.length === 0) return miss(`标签「${tag}」没有可用图片`);

    const rand = opts.random ?? Math.random;
    const roll = rand();
    if (roll >= policy.probability) return miss(`概率未命中（p=${policy.probability}，roll=${roll.toFixed(2)}）`);

    const pick = candidates[Math.floor(rand() * candidates.length)] ?? candidates[0];
    return {
      segments: [...textSegments, { type: 'sticker', stickerId: pick.id, path: pick.path, alt: pick.alt }],
      hasText: Boolean(clean),
      text: clean,
      sticker: true,
      tag,
      reason: `命中标签「${tag}」`,
    };
  }
}
