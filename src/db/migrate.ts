import fs from 'node:fs';
import path from 'node:path';
import { Database } from './index';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 读取 migrations 目录下 001_xxx.sql 形式的脚本，按版本号排序 */
export function loadMigrations(dir: string): Migration[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => {
      const version = Number(f.split('_')[0]);
      return { version, name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * 执行迁移：
 * - 已执行版本（user_version）跳过；
 * - 升级前备份旧库；
 * - 单个脚本在事务中执行，失败回滚并抛出（不进入运行态）。
 */
export function migrate(db: Database, migrations: Migration[], dbFile: string): void {
  const current = db.getUserVersion();
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  // 只在真的要升级时备份：否则每次启动都全量拷一份，磁盘很快被 .bak 撑满
  if (pending.length > 0 && current > 0 && fs.existsSync(dbFile)) {
    const backup = `${dbFile}.bak.${Date.now()}`;
    fs.copyFileSync(dbFile, backup);
    console.log(`[migrate] 已备份旧库 -> ${backup}`);
  }

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.setUserVersion(m.version);
      db.exec('COMMIT');
      console.log(`[migrate] applied ${m.name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.name} 失败：${(e as Error).message}`);
    }
  }
}
