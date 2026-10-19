import type { RateLimitConfig } from '../types';
import type { TokenBudgetRepo } from '../db/repos';
import { dayStr } from '../utils/time';

/** 频率限制：单位时间最大回复次数 + 最小间隔 */
export class RateLimiter {
  private hits: number[] = [];
  private lastAt = 0;

  constructor(private cfg: RateLimitConfig) {}

  allow(): boolean {
    const now = Date.now();
    const minInterval = this.cfg?.minIntervalMs ?? 0;
    if (minInterval > 0 && now - this.lastAt < minInterval) return false;

    this.hits = this.hits.filter((t) => now - t < 60_000);
    const maxPerMinute = this.cfg?.maxPerMinute ?? 0;
    if (maxPerMinute > 0 && this.hits.length >= maxPerMinute) return false;

    this.hits.push(now);
    this.lastAt = now;
    return true;
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
