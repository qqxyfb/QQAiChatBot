import type { ConfigService } from './config.service';

export interface ReleaseInfo {
  version: string;
  changelog: string;
  assets: Array<{ name: string; url: string }>;
}

/** 更新检测：GitHub Release（公开仓库无需 token；私有仓库可配 PAT） */
export class UpdateService {
  constructor(private config: ConfigService) {}

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
}
