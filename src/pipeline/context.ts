export interface ContextItem {
  role: 'user' | 'assistant';
  content: string;
}

/** 单个会话（群/对象）的上下文环形缓冲 */
export class ContextBuffer {
  private buf: ContextItem[] = [];
  private lastAt = Date.now();

  constructor(private maxMessages: number) {}

  push(...items: ContextItem[]): void {
    this.buf.push(...items);
    if (this.maxMessages > 0 && this.buf.length > this.maxMessages) {
      this.buf = this.buf.slice(this.buf.length - this.maxMessages);
    }
    this.lastAt = Date.now();
  }

  recent(): ContextItem[] {
    return this.buf.slice();
  }

  expired(ttlMinutes: number): boolean {
    return Date.now() - this.lastAt > ttlMinutes * 60_000;
  }

  clear(): void {
    this.buf = [];
  }

  get length(): number {
    return this.buf.length;
  }
}

/** 每连接独立的上下文管理器 */
export class ContextManager {
  private store = new Map<string, ContextBuffer>();

  constructor(private maxMessages: number, private ttlMinutes: number) {}

  getOrCreate(key: string): ContextBuffer {
    let buf = this.store.get(key);
    if (!buf) {
      buf = new ContextBuffer(this.maxMessages);
      this.store.set(key, buf);
    }
    return buf;
  }

  get(key: string): ContextBuffer | undefined {
    return this.store.get(key);
  }

  /** 定时清理过期会话 */
  gc(): void {
    for (const [key, buf] of this.store) {
      if (buf.expired(this.ttlMinutes)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
