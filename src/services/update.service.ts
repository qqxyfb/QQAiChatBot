import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigService } from './config.service';
import { ensureDir } from '../config';

export interface ReleaseInfo {
  version: string;
  changelog: string;
  assets: Array<{ name: string; url: string }>;
}

/** 更新检测 / 下载：GitHub Release（公开仓库无需 token；私有仓库可配 PAT） */
export class UpdateService {
  constructor(private config: ConfigService, private dataDir: string) {}

  currentVersion(): string {
    return process.env.npm_package_version || '0.1.0';
  }

  async check(): Promise<ReleaseInfo | null> {
    const { owner, repo, pat } = this.config.load().update;
    if (!owner || !repo) return null;

    const headers: Record<string, string> = {
      'User-Agent': 'QQAiChatBot',
      Accept: 'application/vnd.github+json',
    };
    if (pat) headers.Authorization = `token ${pat}`;

    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      const j = (await resp.json()) as {
        tag_name?: string;
        body?: string;
        assets?: Array<{ name: string; browser_download_url: string }>;
      };
      return {
        version: j.tag_name || '',
        changelog: j.body || '',
        assets: (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })),
      };
    } catch {
      return null; // 超时/网络失败不阻塞
    }
  }

  /** [P1] 下载当前平台安装包并校验 SHA256（若 Release 附带 .sha256） */
  async download(): Promise<{ path: string; version: string; verified: boolean }> {
    const info = await this.check();
    if (!info) throw new Error('未获取到更新信息（更新源不可达或无 Release）');
    const asset = pickAsset(info.assets);
    if (!asset) throw new Error('Release 中未找到当前平台的安装包');

    const dir = path.join(this.dataDir, 'updates');
    ensureDir(dir);
    const file = path.join(dir, asset.name);

    const resp = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(file, buf);

    let verified = false;
    const shaAsset = info.assets.find((a) => a.name === `${asset.name}.sha256`);
    if (shaAsset) {
      const shaResp = await fetch(shaAsset.url, { signal: AbortSignal.timeout(10000) });
      const expected = (await shaResp.text()).trim().split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (expected && expected.toLowerCase() !== actual) {
        throw new Error('SHA256 校验失败，已中止');
      }
      verified = true;
    }

    return { path: file, version: info.version, verified };
  }
}

/** 按当前平台选择产物：Windows 优先安装版，其次便携版；Linux 取 tar.gz */
function pickAsset(assets: Array<{ name: string; url: string }>): { name: string; url: string } | undefined {
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  const candidates = assets.filter((a) => !a.name.endsWith('.sha256'));
  if (isWin) {
    return (
      candidates.find((a) => /setup|installer/i.test(a.name) && a.name.endsWith('.exe')) ||
      candidates.find((a) => a.name.endsWith('.exe'))
    );
  }
  if (isLinux) {
    return candidates.find((a) => /\.(tar\.gz|AppImage|deb)$/i.test(a.name));
  }
  return candidates[0];
}
