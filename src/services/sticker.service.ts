import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Sticker, StickerSet } from '../types';
import type { StickerRepo } from '../db/repos/sticker.repo';
import { ensureDir } from '../config';

export interface ImportFile {
  name: string;
  data: string; // base64
}

export interface ImportResult {
  total: number;
  tagged: number;
  untagged: number;
  failed: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export class StickerService {
  constructor(private repo: StickerRepo, private stickerDir: string) {}

  listSets(): StickerSet[] {
    return this.repo.listSets();
  }

  createSet(name: string): StickerSet {
    const n = name?.trim();
    if (!n) throw new Error('组名称不能为空');
    return this.repo.createSet(n);
  }

  removeSet(id: string): void {
    const s = this.repo.getSet(id);
    if (!s) throw new Error('表情包组不存在');
    if (s.isDefault) throw new Error('默认组不可删除');
    this.repo.removeSet(id);
  }

  listStickers(setId: string): Sticker[] {
    return this.repo.listStickers(setId);
  }

  /** 绝对路径（供预览/发送用） */
  resolvePath(rel: string): string {
    return path.join(this.stickerDir, rel);
  }

  previewPath(id: string): string | null {
    const s = this.repo.getSticker(id);
    return s ? this.resolvePath(s.filePath) : null;
  }

  /** 导入表情文件：文件名约定自动打标签（<标签>_<任意>.<ext>），无约定则标签为空 */
  importFiles(setId: string, files: ImportFile[]): ImportResult {
    const set = this.repo.getSet(setId);
    if (!set) throw new Error('表情包组不存在');

    const result: ImportResult = { total: files.length, tagged: 0, untagged: 0, failed: [] };
    ensureDir(path.join(this.stickerDir, setId));

    for (const f of files) {
      try {
        const base = sanitizeName(f.name);
        if (!base || !IMAGE_EXT.test(base)) {
          result.failed.push(f.name);
          continue;
        }
        const tag = parseTag(base);
        const saved = saveFile(path.join(this.stickerDir, setId), base, Buffer.from(f.data, 'base64'));
        this.repo.addSticker(setId, {
          id: crypto.randomUUID(),
          fileName: saved,
          filePath: `${setId}/${saved}`,
          tags: tag ? [tag] : [],
        });
        if (tag) result.tagged += 1;
        else result.untagged += 1;
      } catch {
        result.failed.push(f.name);
      }
    }
    return result;
  }

  updateTags(id: string, tags: string[]): void {
    const clean = (tags ?? []).map((t) => String(t).trim()).filter(Boolean);
    this.repo.updateTags(id, clean);
  }

  removeSticker(id: string): void {
    const s = this.repo.getSticker(id);
    if (!s) throw new Error('表情不存在');
    this.repo.removeSticker(id);
    // 尽力删除物理文件（失败不阻塞）
    try {
      fs.unlinkSync(this.resolvePath(s.filePath));
    } catch {
      /* ignore */
    }
  }
}

/** 从文件名解析标签：<标签>_<任意>.ext → 标签；否则空 */
function parseTag(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  const i = withoutExt.indexOf('_');
  if (i <= 0) return '';
  const tag = withoutExt.slice(0, i).trim();
  return tag || '';
}

/** 去掉路径穿越与非法字符，只保留基础文件名 */
function sanitizeName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '').trim();
}

/** 落盘并处理重名（追加 _2/_3…），返回最终文件名 */
function saveFile(dir: string, base: string, buf: Buffer): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${stem}_${n}${ext}`;
    n += 1;
  }
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}
