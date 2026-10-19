/**
 * 消息去重：TTL + 容量双重限制，惰性淘汰（无定时器，均摊 O(1)）。
 * 每次 firstTime() 先弹队首过期项，超容量再淘汰最旧项。
 */
export class SeenMessages {
  private map = new Map<string, number>();

  constructor(private ttlMs = 600_000, private maxSize = 5000) {}

  firstTime(id: string): boolean {
    if (!id) return true;
    const now = Date.now();

    while (this.map.size > 0) {
      const first = this.map.entries().next();
      if (first.done) break;
      const [key, ts] = first.value;
      const expired = now - ts > this.ttlMs;
      const overCapacity = this.map.size >= this.maxSize;
      if (!expired && !overCapacity) break;
      this.map.delete(key);
    }

    if (this.map.has(id)) return false;
    this.map.set(id, now);
    return true;
  }

  get size(): number {
    return this.map.size;
  }
}
