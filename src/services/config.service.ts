import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig, LlmConfig } from '../types';
import type { SnapshotRepo } from '../db/repos';
import type { SecretStore } from '../secret/secret-store';
import { ensureDir } from '../config';
import { redact } from '../utils/hash';

export class ConfigService {
  private cache: GlobalConfig | null = null;

  constructor(
    private configFile: string,
    private secret: SecretStore,
    private snapshotRepo: SnapshotRepo
  ) {}

  private defaults(): GlobalConfig {
    return {
      llm: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        temperature: 0.8,
        maxTokens: 512,
      },
      storage: { dataDir: '', historyRetentionDays: 180, logRetentionDays: 30 },
      server: { port: 8700, allowLan: false, accessToken: '' },
      update: { owner: 'qqxyfb', repo: 'QQAiChatBot', autoCheck: true, pat: '' },
      pricing: {},
      maxConnections: 20,
    };
  }

  load(): GlobalConfig {
    if (this.cache) return this.cache;
    const def = this.defaults();
    let raw: Partial<GlobalConfig> = {};
    if (fs.existsSync(this.configFile)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as Partial<GlobalConfig>;
      } catch {
        raw = {};
      }
    }
    const cfg: GlobalConfig = {
      ...def,
      ...raw,
      llm: { ...def.llm, ...(raw.llm ?? {}) },
      storage: { ...def.storage, ...(raw.storage ?? {}) },
      server: { ...def.server, ...(raw.server ?? {}) },
      update: { ...def.update, ...(raw.update ?? {}) },
      pricing: { ...def.pricing, ...(raw.pricing ?? {}) },
      maxConnections: raw.maxConnections ?? def.maxConnections,
    };
    cfg.llm.apiKey = this.secret.decrypt(cfg.llm.apiKey || '');
    cfg.server.accessToken = this.secret.decrypt(cfg.server.accessToken || '');
    cfg.update.pat = this.secret.decrypt(cfg.update.pat || '');
    this.cache = cfg;
    return cfg;
  }

  save(cfg: GlobalConfig): void {
    // 前端回显的 *** 表示「保持不变」，用旧值填充，避免覆盖真实密钥
    const cur = this.load();
    if (cfg.llm.apiKey === '***') cfg.llm.apiKey = cur.llm.apiKey;
    if (cfg.server.accessToken === '***') cfg.server.accessToken = cur.server.accessToken;
    if (cfg.update.pat === '***') cfg.update.pat = cur.update.pat;

    if (cfg.server.allowLan && (!cfg.server.accessToken || cfg.server.accessToken.length < 8)) {
      throw new Error('开启外网访问必须配置至少 8 位的访问令牌');
    }
    if (cfg.maxConnections < 1 || cfg.maxConnections > 100) {
      throw new Error('最大连接数需在 1~100 之间');
    }
    const toStore: GlobalConfig = JSON.parse(JSON.stringify(cfg));
    toStore.llm.apiKey = this.secret.encrypt(cfg.llm.apiKey || '');
    toStore.server.accessToken = this.secret.encrypt(cfg.server.accessToken || '');
    toStore.update.pat = this.secret.encrypt(cfg.update.pat || '');

    ensureDir(path.dirname(this.configFile));
    fs.writeFileSync(this.configFile, JSON.stringify(toStore, null, 2), 'utf8');
    this.cache = cfg;
    this.snapshotRepo.insertConfig('global', JSON.stringify(redact(cfg)), 'save');
  }

  validate(cfg: GlobalConfig): string[] {
    const errors: string[] = [];
    if (!cfg || typeof cfg !== 'object') return ['配置内容为空'];
    if (!cfg.llm || typeof cfg.llm !== 'object') return ['缺少 llm 配置'];
    if (!cfg.server || typeof cfg.server !== 'object') return ['缺少 server 配置'];
    if (!cfg.llm.baseUrl) errors.push('LLM Base URL 不能为空');
    if (!cfg.llm.model) errors.push('LLM 模型不能为空');
    if (!Number.isFinite(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
      errors.push('端口需在 1~65535 之间');
    }
    if (cfg.server.allowLan) {
      const token = cfg.server.accessToken === '***' ? this.load().server.accessToken : cfg.server.accessToken;
      if (!token || token.length < 8) errors.push('开启外网访问必须配置至少 8 位的访问令牌');
    }
    return errors;
  }

  /** 测试 LLM 连接（最小请求） */
  async testLlm(cfg: LlmConfig): Promise<{ ok: boolean; status?: number; latencyMs: number; message: string }> {
    const t0 = Date.now();
    if (!cfg.apiKey) return { ok: false, latencyMs: 0, message: '未配置 API Key' };
    let base = (cfg.baseUrl || '').trim();
    if (base.toLowerCase().endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
    const url = base.replace(/\/+$/, '') + '/chat/completions';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      return {
        ok: resp.status === 200,
        status: resp.status,
        latencyMs: Date.now() - t0,
        message: resp.status === 200 ? '连接成功' : `HTTP ${resp.status}`,
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, message: (e as Error).message };
    }
  }
}
