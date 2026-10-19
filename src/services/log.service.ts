import fs from 'node:fs';
import path from 'node:path';
import type { LogEvent, LogLevel, LogSource } from '../types';
import { ensureDir } from '../config';
import { dayStr } from '../utils/time';

export interface LogRow {
  seq: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  connectionId?: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface LogQuery {
  connectionId?: string;
  level?: LogLevel;
  source?: LogSource;
  keyword?: string;
  since?: number;
  limit?: number;
}

/** 结构化日志：内存环形缓冲 + 文件滚动 + 写失败降级 */
export class LogService {
  private buffer: LogRow[] = [];
  private seq = 0;
  private listeners = new Set<(row: LogRow) => void>();
  private failCount = 0;
  private fileDisabled = false;
  private lastRetryAt = 0;

  constructor(private logDir: string) {
    ensureDir(logDir);
  }

  ingest(ev: LogEvent): void {
    const row: LogRow = {
      seq: ++this.seq,
      ts: Date.now(),
      level: ev.level,
      source: ev.source,
      connectionId: ev.connectionId,
      msg: ev.msg,
      meta: ev.meta,
    };
    this.buffer.push(row);
    if (this.buffer.length > 4000) this.buffer.shift();

    this.writeFile(row);

    for (const fn of this.listeners) {
      try {
        fn(row);
      } catch {
        /* ignore */
      }
    }
  }

  /** 文件写入失败降级：连续失败 ≥10 次暂停，5 分钟后重试；不影响主流程 */
  private writeFile(row: LogRow): void {
    if (this.fileDisabled) {
      if (Date.now() - this.lastRetryAt < 300_000) return;
      this.fileDisabled = false;
      this.failCount = 0;
    }
    try {
      const dir = path.join(this.logDir, row.connectionId || 'server', row.source);
      ensureDir(dir);
      fs.appendFileSync(path.join(dir, `${dayStr(row.ts)}.log`), `${JSON.stringify(row)}\n`, 'utf8');
      this.failCount = 0;
    } catch (e) {
      this.failCount += 1;
      if (this.failCount >= 10) {
        this.fileDisabled = true;
        this.lastRetryAt = Date.now();
        this.buffer.push({
          seq: ++this.seq,
          ts: Date.now(),
          level: 'ERROR',
          source: 'server',
          msg: `日志文件写入已暂停（磁盘满/权限不足）：${(e as Error).message}`,
        });
      }
    }
  }

  query(f: LogQuery): LogRow[] {
    let rows = this.buffer;
    if (f.connectionId) rows = rows.filter((r) => r.connectionId === f.connectionId);
    if (f.level) rows = rows.filter((r) => r.level === f.level);
    if (f.source) rows = rows.filter((r) => r.source === f.source);
    if (f.keyword) {
      const k = f.keyword.toLowerCase();
      rows = rows.filter((r) => r.msg.toLowerCase().includes(k));
    }
    if (f.since) rows = rows.filter((r) => r.seq > f.since!);
    const limit = Math.min(2000, Math.max(1, f.limit ?? 500));
    return rows.slice(-limit);
  }

  subscribe(fn: (row: LogRow) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  export(f: LogQuery): string {
    return this.query(f)
      .map((r) => JSON.stringify(r))
      .join('\n');
  }

  info(source: LogSource, msg: string, connectionId?: string, meta?: Record<string, unknown>): void {
    this.ingest({ kind: 'log', level: 'INFO', source, msg, connectionId, meta });
  }

  warn(source: LogSource, msg: string, connectionId?: string, meta?: Record<string, unknown>): void {
    this.ingest({ kind: 'log', level: 'WARN', source, msg, connectionId, meta });
  }

  error(source: LogSource, msg: string, connectionId?: string, meta?: Record<string, unknown>): void {
    this.ingest({ kind: 'log', level: 'ERROR', source, msg, connectionId, meta });
  }
}
