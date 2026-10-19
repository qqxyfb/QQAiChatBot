import type { Database } from '../db';
import type { ConfigService } from './config.service';
import { dayStartMs } from '../utils/time';

export interface Overview {
  messages: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  activeObjects: number;
  avgLatencyMs: number;
  errorRate: number;
  blocked: number;
  connectionCount: number;
  runningCount: number;
  cost: number;
}

export interface SeriesPoint {
  bucket: string;
  messages: number;
  prompt: number;
  completion: number;
}

export interface HourPoint {
  hour: string;
  prompt: number;
  completion: number;
}

/** 指标聚合：全部走 SQL，connectionId 缺省=全局汇总 */
export class StatsService {
  constructor(private db: Database, private config: ConfigService) {}

  private where(connectionId: string | undefined, since: number): { clause: string; args: unknown[] } {
    if (connectionId) return { clause: 'WHERE ts >= ? AND connection_id = ?', args: [since, connectionId] };
    return { clause: 'WHERE ts >= ?', args: [since] };
  }

  overview(connectionId?: string): Overview {
    const since = dayStartMs();
    const { clause, args } = this.where(connectionId, since);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS messages,
                COALESCE(SUM(prompt_tokens),0) AS prompt,
                COALESCE(SUM(completion_tokens),0) AS completion,
                COALESCE(AVG(latency_ms),0) AS avgLatency,
                COUNT(DISTINCT from_hash) AS objects,
                COALESCE(SUM(CASE WHEN finish_reason IN ('error','refuse','limit','abuse') THEN 1 ELSE 0 END),0) AS blocked
         FROM message_log ${clause}`
      )
      .get(...(args as never[])) as {
      messages: number;
      prompt: number;
      completion: number;
      avgLatency: number;
      objects: number;
      blocked: number;
    };

    const conn = this.db
      .prepare(
        connectionId
          ? 'SELECT COUNT(*) AS total, SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS running FROM connection WHERE connection_id=?'
          : 'SELECT COUNT(*) AS total, SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS running FROM connection'
      )
      .get(...((connectionId ? ['running', connectionId] : ['running']) as never[])) as {
      total: number;
      running: number;
    };

    const totalTokens = row.prompt + row.completion;
    return {
      messages: row.messages,
      promptTokens: row.prompt,
      completionTokens: row.completion,
      totalTokens,
      activeObjects: row.objects,
      avgLatencyMs: Math.round(row.avgLatency || 0),
      errorRate: row.messages ? Number((row.blocked / row.messages).toFixed(4)) : 0,
      blocked: row.blocked,
      connectionCount: conn.total || 0,
      runningCount: conn.running || 0,
      cost: this.costFor(connectionId, since),
    };
  }

  timeseries(connectionId: string | undefined, granularity: 'hour' | 'day' = 'day', days = 7): SeriesPoint[] {
    const since = Date.now() - days * 86400_000;
    const { clause, args } = this.where(connectionId, since);
    const fmt = granularity === 'hour' ? '%Y-%m-%d %H' : '%Y-%m-%d';
    return this.db
      .prepare(
        `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket,
                COUNT(*) AS messages,
                COALESCE(SUM(prompt_tokens),0) AS prompt,
                COALESCE(SUM(completion_tokens),0) AS completion
         FROM message_log ${clause}
         GROUP BY bucket ORDER BY bucket`
      )
      .all(...(args as never[])) as unknown as SeriesPoint[];
  }

  hourlyTokens(connectionId?: string): HourPoint[] {
    const since = dayStartMs();
    const { clause, args } = this.where(connectionId, since);
    return this.db
      .prepare(
        `SELECT strftime('%H', ts/1000, 'unixepoch', 'localtime') AS hour,
                COALESCE(SUM(prompt_tokens),0) AS prompt,
                COALESCE(SUM(completion_tokens),0) AS completion
         FROM llm_call ${clause}
         GROUP BY hour ORDER BY hour`
      )
      .all(...(args as never[])) as unknown as HourPoint[];
  }

  latency(connectionId?: string): { p50: number; p95: number; p99: number; hist: number[] } {
    const since = Date.now() - 7 * 86400_000;
    const { clause, args } = this.where(connectionId, since);
    const rows = this.db
      .prepare(`SELECT latency_ms AS v FROM message_log ${clause} AND latency_ms IS NOT NULL ORDER BY v ASC`)
      .all(...(args as never[])) as unknown as Array<{ v: number }>;
    const values = rows.map((r) => r.v);
    const pick = (p: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0);
    const hist = new Array(10).fill(0);
    for (const v of values) hist[Math.min(9, Math.floor(v / 1000))] += 1;
    return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), hist };
  }

  resultDist(connectionId?: string): Record<string, number> {
    const since = Date.now() - 7 * 86400_000;
    const { clause, args } = this.where(connectionId, since);
    const rows = this.db
      .prepare(`SELECT finish_reason AS k, COUNT(*) AS c FROM message_log ${clause} GROUP BY finish_reason`)
      .all(...(args as never[])) as unknown as Array<{ k: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.k || 'unknown'] = r.c;
    return out;
  }

  topObjects(connectionId?: string, limit = 10): Array<{ fromHash: string; messages: number; tokens: number }> {
    const since = Date.now() - 7 * 86400_000;
    const { clause, args } = this.where(connectionId, since);
    return this.db
      .prepare(
        `SELECT from_hash AS fromHash, COUNT(*) AS messages,
                COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
         FROM message_log ${clause}
         GROUP BY from_hash ORDER BY tokens DESC LIMIT ?`
      )
      .all(...(args as never[]), limit) as unknown as Array<{ fromHash: string; messages: number; tokens: number }>;
  }

  cost(connectionId?: string): { today: number; week: number; month: number; monthEstimate: number } {
    const now = Date.now();
    const today = this.costFor(connectionId, dayStartMs());
    const week = this.costFor(connectionId, now - 7 * 86400_000);
    const month = this.costFor(connectionId, now - 30 * 86400_000);
    return { today, week, month, monthEstimate: Number((week / 7 * 30).toFixed(4)) };
  }

  /** [P1] 分连接对比（今日） */
  perConnection(): Array<{ connectionId: string; name: string; messages: number; tokens: number; cost: number }> {
    const since = dayStartMs();
    const conns = this.db
      .prepare('SELECT connection_id, name FROM connection ORDER BY created_at ASC')
      .all() as unknown as Array<{ connection_id: string; name: string }>;
    const rows = this.db
      .prepare(
        `SELECT connection_id AS cid, COUNT(*) AS messages,
                COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
         FROM message_log WHERE ts >= ? GROUP BY connection_id`
      )
      .all(since) as unknown as Array<{ cid: string; messages: number; p: number; c: number }>;
    const map = new Map(rows.map((r) => [r.cid, r]));
    return conns.map((c) => {
      const r = map.get(c.connection_id);
      const tokens = (r?.p ?? 0) + (r?.c ?? 0);
      return {
        connectionId: c.connection_id,
        name: c.name,
        messages: r?.messages ?? 0,
        tokens,
        cost: this.costFor(c.connection_id, since),
      };
    });
  }

  private costFor(connectionId: string | undefined, since: number): number {
    const { clause, args } = this.where(connectionId, since);
    const rows = this.db
      .prepare(
        `SELECT model, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
         FROM llm_call ${clause} GROUP BY model`
      )
      .all(...(args as never[])) as unknown as Array<{ model: string; p: number; c: number }>;
    const pricing = this.config.load().pricing || {};
    let total = 0;
    for (const r of rows) {
      const price = pricing[r.model];
      if (!price) continue;
      total += (r.p * price.inputPrice + r.c * price.outputPrice) / 1_000_000;
    }
    return Number(total.toFixed(4));
  }
}
