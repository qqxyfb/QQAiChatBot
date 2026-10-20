import { Database } from '../index';
import type {
  ConnectionConfig,
  ConnectionStatus,
  FinishReason,
  MessageMetric,
  LlmCallMetric,
  Persona,
} from '../../types';
import { nowMs, dayStr } from '../../utils/time';

export * from './sticker.repo';

// ---------------- connection ----------------
export interface ConnectionRow {
  connection_id: string;
  name: string;
  type: string;
  status: string;
  persona_id: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

export class ConnectionRepo {
  constructor(private db: Database) {}

  list(): ConnectionRow[] {
    return this.db.prepare('SELECT * FROM connection ORDER BY created_at ASC').all() as unknown as ConnectionRow[];
  }

  get(id: string): ConnectionRow | undefined {
    return this.db.prepare('SELECT * FROM connection WHERE connection_id = ?').get(id) as unknown as
      | ConnectionRow
      | undefined;
  }

  listByStatus(status: string): ConnectionRow[] {
    return this.db.prepare('SELECT * FROM connection WHERE status = ?').all(status) as unknown as ConnectionRow[];
  }

  upsert(cfg: ConnectionConfig, status: ConnectionStatus): void {
    const now = nowMs();
    const existing = this.get(cfg.connectionId);
    const json = JSON.stringify(cfg);
    if (existing) {
      this.db
        .prepare(
          'UPDATE connection SET name=?, type=?, status=?, persona_id=?, config_json=?, updated_at=? WHERE connection_id=?'
        )
        .run(cfg.name, cfg.type, status, cfg.personaId, json, now, cfg.connectionId);
    } else {
      this.db
        .prepare(
          'INSERT INTO connection(connection_id,name,type,status,persona_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(cfg.connectionId, cfg.name, cfg.type, status, cfg.personaId, json, now, now);
    }
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE connection SET status=?, updated_at=? WHERE connection_id=?').run(status, nowMs(), id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM connection WHERE connection_id = ?').run(id);
  }
}

// ---------------- persona ----------------
export interface PersonaRow {
  id: string;
  name: string;
  content_json: string;
  builtin: number;
  created_at: number;
  updated_at: number;
}

export class PersonaRepo {
  constructor(private db: Database) {}

  list(): PersonaRow[] {
    return this.db.prepare('SELECT * FROM persona ORDER BY builtin DESC, updated_at DESC').all() as unknown as PersonaRow[];
  }

  get(id: string): PersonaRow | undefined {
    return this.db.prepare('SELECT * FROM persona WHERE id = ?').get(id) as unknown as PersonaRow | undefined;
  }

  upsert(p: Persona, builtin: boolean): void {
    const now = nowMs();
    const existing = this.get(p.id);
    if (existing) {
      this.db
        .prepare('UPDATE persona SET name=?, content_json=?, builtin=?, updated_at=? WHERE id=?')
        .run(p.name, JSON.stringify(p), builtin ? 1 : 0, now, p.id);
    } else {
      this.db
        .prepare('INSERT INTO persona(id,name,content_json,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(p.id, p.name, JSON.stringify(p), builtin ? 1 : 0, now, now);
    }
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM persona WHERE id = ?').run(id);
  }

  listReferencedBy(personaId: string): ConnectionRow[] {
    return this.db.prepare('SELECT * FROM connection WHERE persona_id = ?').all(personaId) as unknown as ConnectionRow[];
  }
}

// ---------------- banword（含内存缓存） ----------------
export interface CachedBanwords {
  in: Set<string>;
  out: Set<string>;
  both: Set<string>;
}

export interface BanwordRow {
  id: number;
  word: string;
  direction: string;
  enabled: number;
  created_at: number;
}

export class BanwordRepo {
  private cache: CachedBanwords | null = null;

  constructor(private db: Database) {}

  load(): void {
    const rows = this.db.prepare('SELECT word, direction FROM banword WHERE enabled = 1').all() as unknown as Array<{
      word: string;
      direction: string;
    }>;
    const c: CachedBanwords = { in: new Set(), out: new Set(), both: new Set() };
    for (const r of rows) {
      const dir = r.direction || 'both';
      if (dir === 'in' || dir === 'both') c.in.add(r.word);
      if (dir === 'out' || dir === 'both') c.out.add(r.word);
      if (dir === 'both') c.both.add(r.word);
    }
    this.cache = c;
  }

  getCache(): CachedBanwords {
    if (!this.cache) this.load();
    return this.cache!;
  }

  list(): BanwordRow[] {
    return this.db.prepare('SELECT * FROM banword ORDER BY id DESC').all() as unknown as BanwordRow[];
  }

  add(word: string, direction = 'both'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO banword(word,direction,enabled,created_at) VALUES(?,?,1,?)')
      .run(word, direction, nowMs());
    this.load();
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM banword WHERE id = ?').run(id);
    this.load();
  }
}

// ---------------- message_log ----------------
export interface MessageFilter {
  connectionId?: string;
  fromHash?: string;
  keyword?: string;
  finishReason?: string;
  fromTs?: number;
  toTs?: number;
  page?: number;
  pageSize?: number;
}

export class MessageRepo {
  constructor(private db: Database) {}

  insert(m: MessageMetric): void {
    this.db
      .prepare(
        `INSERT INTO message_log(connection_id,session_id,ts,channel,from_hash,group_hash,direction,content,reply,finish_reason,latency_ms,llm_ms,llm_attempts,prompt_tokens,completion_tokens,msg_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        m.connectionId,
        m.sessionId ?? null,
        nowMs(),
        m.channel,
        m.fromHash,
        m.groupHash,
        m.direction,
        m.content,
        m.reply,
        m.finishReason,
        m.latencyMs,
        m.llmMs,
        m.llmAttempts,
        m.promptTokens,
        m.completionTokens,
        m.msgId
      );
  }

  query(f: MessageFilter): { rows: unknown[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.connectionId) { where.push('connection_id = ?'); args.push(f.connectionId); }
    if (f.fromHash) { where.push('from_hash = ?'); args.push(f.fromHash); }
    if (f.finishReason) { where.push('finish_reason = ?'); args.push(f.finishReason); }
    if (f.fromTs) { where.push('ts >= ?'); args.push(f.fromTs); }
    if (f.toTs) { where.push('ts <= ?'); args.push(f.toTs); }
    if (f.keyword) { where.push('(content LIKE ? OR reply LIKE ?)'); args.push(`%${f.keyword}%`, `%${f.keyword}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM message_log ${clause}`).get(...(args as never[])) as { c: number }).c;
    const page = Math.max(1, f.page ?? 1);
    const size = Math.min(200, Math.max(1, f.pageSize ?? 50));
    const rows = this.db
      .prepare(`SELECT * FROM message_log ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...(args as never[]), size, (page - 1) * size);
    return { rows, total };
  }

  removeByObject(connectionId: string, fromHash: string): void {
    this.db.prepare('DELETE FROM message_log WHERE connection_id = ? AND from_hash = ?').run(connectionId, fromHash);
  }

  cleanupBefore(ts: number): void {
    this.db.prepare('DELETE FROM message_log WHERE ts < ?').run(ts);
  }
}

// ---------------- llm_call ----------------
export class LlmCallRepo {
  constructor(private db: Database) {}

  insert(c: LlmCallMetric): void {
    this.db
      .prepare(
        'INSERT INTO llm_call(connection_id,session_id,ts,model,prompt_tokens,completion_tokens,latency_ms,status,retry_cnt,error) VALUES(?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        c.connectionId,
        c.sessionId ?? null,
        nowMs(),
        c.model,
        c.promptTokens,
        c.completionTokens,
        c.latencyMs,
        c.status,
        c.retryCnt,
        c.error ?? null
      );
  }

  cleanupBefore(ts: number): void {
    this.db.prepare('DELETE FROM llm_call WHERE ts < ?').run(ts);
  }
}

// ---------------- connection_event ----------------
export class ConnectionEventRepo {
  constructor(private db: Database) {}

  insert(connectionId: string, event: string, connectorType: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO connection_event(connection_id,ts,event,connector_type,detail) VALUES(?,?,?,?,?)')
      .run(connectionId, nowMs(), event, connectorType, detail ?? null);
  }
}

// ---------------- abuse_event ----------------
export class AbuseRepo {
  constructor(private db: Database) {}

  insert(connectionId: string, fromHash: string, reason: string, kind: string): void {
    this.db
      .prepare('INSERT INTO abuse_event(connection_id,ts,from_hash,reason,kind) VALUES(?,?,?,?,?)')
      .run(connectionId, nowMs(), fromHash, reason, kind);
  }
}

// ---------------- token_budget ----------------
export class TokenBudgetRepo {
  constructor(private db: Database) {}

  get(connectionId: string, fromHash: string, day = dayStr()): number {
    const row = this.db
      .prepare('SELECT tokens FROM token_budget WHERE connection_id=? AND from_hash=? AND day=?')
      .get(connectionId, fromHash, day) as { tokens?: number } | undefined;
    return Number(row?.tokens ?? 0);
  }

  add(connectionId: string, fromHash: string, tokens: number, day = dayStr()): void {
    this.db
      .prepare(
        `INSERT INTO token_budget(connection_id,from_hash,day,tokens) VALUES(?,?,?,?)
         ON CONFLICT(connection_id,from_hash,day) DO UPDATE SET tokens = tokens + excluded.tokens`
      )
      .run(connectionId, fromHash, day, tokens);
  }

  cleanupBeforeDay(day: string): void {
    this.db.prepare('DELETE FROM token_budget WHERE day < ?').run(day);
  }
}

// ---------------- snapshots ----------------
export class SnapshotRepo {
  constructor(private db: Database) {}

  insertConfig(scope: string, json: string, note: string): void {
    this.db.prepare('INSERT INTO config_snapshot(ts,scope,json,note) VALUES(?,?,?,?)').run(nowMs(), scope, json, note);
  }

  insertPersona(personaId: string, name: string, note: string): void {
    this.db.prepare('INSERT INTO persona_snapshot(ts,persona_id,name,note) VALUES(?,?,?,?)').run(nowMs(), personaId, name, note);
  }
}
