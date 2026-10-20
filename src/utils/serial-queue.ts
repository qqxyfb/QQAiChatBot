/**
 * 按 key 串行执行异步任务：同 key 排队，不同 key 并行。
 *
 * 用途：同一个会话（群 / 私聊对象）的消息必须按到达顺序处理，
 * 否则并发跑 LLM 会让回复乱序、上下文交错。
 *
 * 实现要点（无定时器，避免泄漏）：
 * - 每个 key 维护一条 Promise 链（tail），任务天然串行；
 * - 维护 depth 计数，超过上限直接丢弃并回调 onDrop，防止 LLM 变慢时无限堆积；
 * - 任务结束（含异常）后回收空队列条目。
 */
export class SerialQueue {
  private tails = new Map<string, Promise<void>>();
  private depths = new Map<string, number>();

  constructor(
    private maxDepth = 5,
    private onDrop?: (key: string, depth: number) => void
  ) {}

  depth(key: string): number {
    return this.depths.get(key) ?? 0;
  }

  get size(): number {
    return this.tails.size;
  }

  run(key: string, task: () => Promise<void>): Promise<void> {
    const depth = this.depth(key);
    if (this.maxDepth > 0 && depth >= this.maxDepth) {
      this.onDrop?.(key, depth);
      return Promise.resolve();
    }
    this.depths.set(key, depth + 1);

    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => task())
      .catch(() => undefined)
      .then(() => {
        const left = (this.depths.get(key) ?? 1) - 1;
        if (left > 0) {
          this.depths.set(key, left);
          return;
        }
        this.depths.delete(key);
        if (this.tails.get(key) === next) this.tails.delete(key);
      });

    this.tails.set(key, next);
    return next;
  }
}
