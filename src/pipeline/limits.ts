import type { RateLimitConfig } from '../types';
import type { TokenBudgetRepo } from '../db/repos';
import type { Decision } from './steps';
import { dayStr } from '../utils/time';

interface Bucket {
  hits: number[];
  lastAt: number;
}

/**
 * 频率限制：单位时间最大回复次数 + 最小间隔。
 *
 * 默认按「对象」分桶（scope='user'），群聊里 A 刷屏不会把 B、C 的正常消息一起挤掉；
 * scope='connection' 时退化为整连接共享配额（旧行为）。
 * 分桶表用惰性淘汰（无定时器），避免长期运行后 Map 无限增长。
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private static readonly MAX_BUCKETS = 5000;

  constructor(private cfg: RateLimitConfig) {}

  updateConfig(cfg: RateLimitConfig): void {
    this.cfg = cfg;
    this.buckets.clear();
  }

  private bucketKey(key: string): string {
    return (this.cfg?.scope ?? 'user') === 'connection' ? '*' : key || '*';
  }

  allow(key = ''): boolean {
    return this.evaluate(key).ok;
  }

  evaluate(key = ''): Decision {
    const now = Date.now();
    const maxPerMinute = this.cfg?.maxPerMinute ?? 0;
    const minInterval = this.cfg?.minIntervalMs ?? 0;
    if (maxPerMinute <= 0 && minInterval <= 0) return { ok: true, reason: '未启用限流' };

    const bk = this.bucketKey(key);
    const bucket = this.buckets.get(bk) ?? { hits: [], lastAt: 0 };

    if (minInterval > 0 && bucket.lastAt > 0 && now - bucket.lastAt < minInterval) {
      const wait = minInterval - (now - bucket.lastAt);
      return { ok: false, reason: `频率限制：距上次回复不足 ${minInterval}ms（还需 ${wait}ms）` };
    }

    const hits = bucket.hits.filter((t) => now - t < 60_000);
    if (maxPerMinute > 0 && hits.length >= maxPerMinute) {
      return { ok: false, reason: `频率限制：每分钟最多 ${maxPerMinute} 条，已用满` };
    }

    hits.push(now);
    this.buckets.set(bk, { hits, lastAt: now });
    this.evictIfNeeded();
    return { ok: true, reason: '限流通过' };
  }

  /** 分桶超上限时淘汰最久未活跃的桶（惰性，均摊 O(n) 且仅在超限时触发） */
  private evictIfNeeded(): void {
    if (this.buckets.size <= RateLimiter.MAX_BUCKETS) return;
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    const removeCount = entries.length - RateLimiter.MAX_BUCKETS;
    for (let i = 0; i < removeCount; i += 1) this.buckets.delete(entries[i][0]);
  }
}

/**
 * 每对象每日 token 预算：
 * - 内存缓存（快速判断）+ 同步 UPSERT 落库；
 * - 缓存未命中时从 token_budget 表读取，服务重启后自动恢复当日计数。
 */
export class TokenBudget {
  private cache = new Map<string, number>();
  private lastDay = dayStr();

  constructor(
    private repo: TokenBudgetRepo,
    private connectionId: string,
    private limit: number
  ) {}

  /** 配置热更新：只换上限，已用量继续沿用 */
  updateLimit(limit: number): void {
    this.limit = limit;
  }

  /** 跨天自动清空内存计数（懒触发，无需外部定时器） */
  private ensureDay(): void {
    const today = dayStr();
    if (today !== this.lastDay) {
      this.cache.clear();
      this.lastDay = today;
    }
  }

  private used(fromHash: string): number {
    this.ensureDay();
    const cached = this.cache.get(fromHash);
    if (cached !== undefined) return cached;
    const fromDb = this.repo.get(this.connectionId, fromHash, dayStr());
    this.cache.set(fromHash, fromDb);
    return fromDb;
  }

  check(fromHash: string, tokens: number): boolean {
    if (this.limit <= 0) return true;
    return this.used(fromHash) + tokens <= this.limit;
  }

  add(fromHash: string, tokens: number): void {
    if (tokens <= 0) return;
    const next = this.used(fromHash) + tokens;
    this.cache.set(fromHash, next);
    this.repo.add(this.connectionId, fromHash, tokens, dayStr());
  }

  rollDay(): void {
    this.cache.clear();
  }
}
