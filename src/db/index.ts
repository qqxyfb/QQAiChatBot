import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from '../config';

/** SQLite 单例封装（node:sqlite 同步 API） */
export class Database {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(file: string): Database {
    ensureDir(path.dirname(file));
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    return new Database(raw);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  getUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  setUserVersion(v: number): void {
    this.db.exec(`PRAGMA user_version = ${Math.floor(v)}`);
  }

  close(): void {
    this.db.close();
  }
}
