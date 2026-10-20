import path from 'node:path';
import { Database } from '../index';
import type { Sticker, StickerSet } from '../../types';
import { nowMs } from '../../utils/time';

export interface StickerIndexEntry {
  id: string;
  path: string; // 绝对路径（供连接器直接发送）
  alt: string;
}

/** 倒排索引：set_id -> tag -> entries */
export type StickerIndex = Map<string, Map<string, StickerIndexEntry[]>>;

interface StickerRow {
  id: string;
  set_id: string;
  file_name: string;
  file_path: string;
  tags: string;
  created_at: number;
}

export class StickerRepo {
  private cache: StickerIndex | null = null;

  constructor(private db: Database, private stickerDir: string) {}

  /** 启动/变更后全量重建内存倒排索引（表情包量级小，全量重载可接受） */
  load(): void {
    const rows = this.db.prepare('SELECT * FROM sticker').all() as unknown as StickerRow[];
    const idx: StickerIndex = new Map();
    for (const r of rows) {
      const entry: StickerIndexEntry = {
        id: r.id,
        path: this.resolve(r.file_path),
        alt: stripExt(r.file_name),
      };
      const setMap = idx.get(r.set_id) ?? new Map<string, StickerIndexEntry[]>();
      for (const t of safeTags(r.tags)) {
        const arr = setMap.get(t) ?? [];
        arr.push(entry);
        setMap.set(t, arr);
      }
      idx.set(r.set_id, setMap);
    }
    this.cache = idx;
  }

  getCache(): StickerIndex {
    if (!this.cache) this.load();
    return this.cache!;
  }

  private resolve(rel: string): string {
    return path.join(this.stickerDir, rel);
  }

  // ---- 组 ----
  listSets(): StickerSet[] {
    const rows = this.db.prepare('SELECT * FROM sticker_set ORDER BY is_default DESC, created_at ASC').all() as unknown as Array<{
      id: string;
      name: string;
      is_default: number;
      created_at: number;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, isDefault: r.is_default === 1, createdAt: r.created_at }));
  }

  getSet(id: string): StickerSet | undefined {
    const r = this.db.prepare('SELECT * FROM sticker_set WHERE id = ?').get(id) as
      | { id: string; name: string; is_default: number; created_at: number }
      | undefined;
    if (!r) return undefined;
    return { id: r.id, name: r.name, isDefault: r.is_default === 1, createdAt: r.created_at };
  }

  createSet(name: string): StickerSet {
    const id = `set_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare('INSERT INTO sticker_set(id,name,is_default,created_at) VALUES(?,?,0,?)')
      .run(id, name, nowMs());
    return { id, name, isDefault: false, createdAt: nowMs() };
  }

  removeSet(id: string): void {
    this.db.prepare('DELETE FROM sticker WHERE set_id = ?').run(id);
    this.db.prepare('DELETE FROM sticker_set WHERE id = ?').run(id);
    this.load();
  }

  // ---- 表情 ----
  listStickers(setId: string): Sticker[] {
    const rows = this.db
      .prepare('SELECT * FROM sticker WHERE set_id = ? ORDER BY created_at DESC')
      .all(setId) as unknown as StickerRow[];
    return rows.map((r) => ({
      id: r.id,
      setId: r.set_id,
      fileName: r.file_name,
      filePath: r.file_path,
      tags: safeTags(r.tags),
      createdAt: r.created_at,
    }));
  }

  getSticker(id: string): Sticker | undefined {
    const r = this.db.prepare('SELECT * FROM sticker WHERE id = ?').get(id) as StickerRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      setId: r.set_id,
      fileName: r.file_name,
      filePath: r.file_path,
      tags: safeTags(r.tags),
      createdAt: r.created_at,
    };
  }

  /** 组内全部标签（去重，用于注入 LLM prompt 的枚举） */
  getTags(setId: string): string[] {
    const setMap = this.getCache().get(setId);
    if (!setMap) return [];
    return [...setMap.keys()];
  }

  addSticker(setId: string, s: { id: string; fileName: string; filePath: string; tags: string[] }): void {
    this.db
      .prepare('INSERT INTO sticker(id,set_id,file_name,file_path,tags,created_at) VALUES(?,?,?,?,?,?)')
      .run(s.id, setId, s.fileName, s.filePath, JSON.stringify(s.tags), nowMs());
    this.load();
  }

  removeSticker(id: string): void {
    this.db.prepare('DELETE FROM sticker WHERE id = ?').run(id);
    this.load();
  }

  updateTags(id: string, tags: string[]): void {
    this.db.prepare('UPDATE sticker SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
    this.load();
  }
}

function safeTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function stripExt(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}
