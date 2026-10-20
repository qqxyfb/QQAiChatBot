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

/** 递归收集指定文件名的日志文件（深度上限 4，避免异常目录结构拖死启动） */
function collectLogFiles(root: string, name: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) collectLogFiles(p, name, out, depth + 1);
    else if (e.name === name) out.push(p);
  }
  return out;
}

/** 结构化日志：内存环形缓冲 + 文件滚动 + 写失败降级 */
export class LogService {
  private buffer: LogRow[] = [];
  private seq = 0;
  private listeners = new Set<(row: LogRow) => void>();
  private failCount = 0;
  private fileDisabled = false;
  private lastRetryAt = 0;
  private static readonly REPLAY_LIMIT = 2000;
  private static readonly REPLAY_MAX_FILE_BYTES = 8 * 1024 * 1024;

  constructor(private logDir: string) {
    ensureDir(logDir);
    this.replayToday();
  }

  /**
   * 启动时回灌当日日志文件到内存缓冲。
   * 否则重启后「运行日志」页面必然全空，用户会误判为「日志功能坏了」。
   * 回灌只填 buffer、不触发 listeners，避免启动瞬间刷屏 WS。
   */
  private replayToday(): void {
    try {
      const files = collectLogFiles(this.logDir, `${dayStr()}.log`);
      const rows: LogRow[] = [];
      for (const file of files) {
        let text: string;
        try {
          const size = fs.statSync(file).size;
          if (size > LogService.REPLAY_MAX_FILE_BYTES) {
            // 超大文件只读尾部，避免历史日志拖慢启动
            const fd = fs.openSync(file, 'r');
            try {
              const buf = Buffer.alloc(LogService.REPLAY_MAX_FILE_BYTES);
              const read = fs.readSync(fd, buf, 0, buf.length, size - buf.length);
              text = buf.subarray(0, read).toString('utf8');
            } finally {
              fs.closeSync(fd);
            }
          } else {
            text = fs.readFileSync(file, 'utf8');
          }
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as LogRow;
            if (typeof row.ts === 'number' && typeof row.msg === 'string') rows.push(row);
          } catch {
            /* 跳过损坏行 */
          }
        }
      }
      if (!rows.length) return;
      rows.sort((a, b) => a.ts - b.ts);
      const tail = rows.slice(-LogService.REPLAY_LIMIT);
      // 重排 seq：每次进程启动 seq 都从 1 开始，沿用旧值会与前端 since 游标冲突
      tail.forEach((r, i) => {
        r.seq = i + 1;
      });
      this.buffer = tail;
      this.seq = tail.length;
    } catch {
      /* 回灌失败不影响启动 */
    }
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
      // 服务级日志（无 connectionId）直接落 logs/{source}/，避免出现 logs/server/server/ 的嵌套
      const dir = row.connectionId
        ? path.join(this.logDir, row.connectionId, row.source)
        : path.join(this.logDir, row.source);
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
