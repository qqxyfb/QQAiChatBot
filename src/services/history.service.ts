import type { Database } from '../db';
import type { MessageFilter, MessageRepo } from '../db/repos';

export class HistoryService {
  constructor(private db: Database, private repo: MessageRepo) {}

  /** 会话列表：按对象分组 */
  sessions(connectionId?: string): Array<{ fromHash: string; lastTs: number; messages: number; tokens: number }> {
    const where = connectionId ? 'WHERE connection_id = ?' : '';
    const args = connectionId ? [connectionId] : [];
    return this.db
      .prepare(
        `SELECT from_hash AS fromHash, MAX(ts) AS lastTs, COUNT(*) AS messages,
                COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
         FROM message_log ${where}
         GROUP BY from_hash ORDER BY lastTs DESC LIMIT 200`
      )
      .all(...(args as never[])) as unknown as Array<{
      fromHash: string;
      lastTs: number;
      messages: number;
      tokens: number;
    }>;
  }

  messages(f: MessageFilter): { rows: unknown[]; total: number } {
    return this.repo.query(f);
  }

  export(f: MessageFilter, format: 'csv' | 'json'): string {
    const { rows } = this.repo.query({ ...f, page: 1, pageSize: 200 });
    if (format === 'json') return JSON.stringify(rows, null, 2);
    const list = rows as Array<Record<string, unknown>>;
    if (!list.length) return '\ufeff';
    const cols = Object.keys(list[0]);
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    for (const r of list) lines.push(cols.map((c) => escape(r[c])).join(','));
    return `\ufeff${lines.join('\n')}`;
  }

  removeByObject(connectionId: string, fromHash: string): void {
    this.repo.removeByObject(connectionId, fromHash);
  }
}
