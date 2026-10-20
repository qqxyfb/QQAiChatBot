import type { Segment } from '../types';
import type { StickerIndex } from '../db/repos/sticker.repo';

export const DEFAULT_SET_ID = 'default';

export interface PlanResult {
  segments: Segment[];
  hasText: boolean;
  text: string; // 去标记后的纯文本（用于上下文与打点）
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

/**
 * 媒体决策与装配：两级选择表情包。
 * 第一级（LLM 语义决策）已在 prompt 中通过 [sticker:标签] 标记完成；
 * 第二级（文件多样性）在此处对命中标签的候选文件随机取一张。
 * 非法/无候选一律降级纯文字，绝不抛错。
 */
export class MediaPlanner {
  static plan(text: string, set: string, index: StickerIndex): PlanResult {
    const tag = parseStickerTag(text);
    if (tag) {
      const candidates = index.get(set)?.get(tag);
      if (candidates && candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return {
          segments: [{ type: 'sticker', stickerId: pick.id, path: pick.path, alt: pick.alt }],
          hasText: false,
          text: '',
        };
      }
    }
    const clean = stripStickerTag(text);
    return { segments: [{ type: 'text', text: clean }], hasText: true, text: clean };
  }
}
