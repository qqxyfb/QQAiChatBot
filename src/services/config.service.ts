import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig, LlmConfig } from '../types';
import type { SnapshotRepo } from '../db/repos';
import type { SecretStore } from '../secret/secret-store';
import { ensureDir } from '../config';
import { redact } from '../utils/hash';
import { describeError, httpFetch } from './http';

/** 把用户填的 Base URL 归一成「不带 /chat/completions 的根」 */
export function normalizeLlmBase(baseUrl: string): string {
  let base = (baseUrl || '').trim();
  if (!base) return '';
  if (base.toLowerCase().endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  return base.replace(/\/+$/, '');
}

export interface LlmProbe {
  status: 'pass' | 'fail' | 'skip';
  message: string;
}

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
    // 兜底：接口已改为回显真实值，正常路径不会出现 ***。
    // 若仍命中，说明存在旧调用方或直接导入的脱敏文件，这里保持旧值并留痕。
    const cur = this.load();
    if (cfg.llm.apiKey === '***') {
      cfg.llm.apiKey = cur.llm.apiKey;
      console.warn('[config] 收到脱敏占位 ***，已沿用原值；请检查调用方');
    }
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
    // 配置快照只是审计用，写失败（磁盘只读/库被锁）不应该让「保存」整体失败
    try {
      this.snapshotRepo.insertConfig('global', JSON.stringify(redact(cfg)), 'save');
    } catch (e) {
      console.warn(`[config] 配置快照写入失败（已忽略）：${(e as Error).message}`);
    }
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
    const base = normalizeLlmBase(cfg.baseUrl);
    const url = `${base}/chat/completions`;
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

  /**
   * 启动前置探测：LLM 端点连通性 + 模型是否真实存在。
   * 目的：把「running 但完全静默」提前变成「启动失败 + 明确原因」。
   * 未配置 API Key 时跳过（演示模式）；代理不支持 /models 时降级为仅探通。
   */
  async probeLlm(cfg: LlmConfig): Promise<LlmProbe> {
    const base = normalizeLlmBase(cfg.baseUrl);
    if (!base) return { status: 'fail', message: 'LLM Base URL 为空' };
    if (!cfg.apiKey) return { status: 'skip', message: '未配置 LLM API Key，将使用演示模式' };

    try {
      const resp = await httpFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        timeoutMs: 8000,
      });
      if (resp.status === 404 || resp.status === 405) {
        return { status: 'pass', message: `LLM 端点可达（${base}，不支持 /models，跳过模型校验）` };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { status: 'fail', message: `LLM 鉴权失败：HTTP ${resp.status}，请检查 API Key` };
      }
      if (!resp.ok) return { status: 'fail', message: `LLM 请求失败：HTTP ${resp.status}` };

      let models: string[] = [];
      try {
        const j = (await resp.json()) as { data?: Array<{ id?: string }> };
        models = (j.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
      } catch {
        /* 非 JSON 响应视为端点可达 */
      }
      if (models.length && cfg.model && !models.includes(cfg.model)) {
        const shown = models.slice(0, 8).join(', ');
        return {
          status: 'fail',
          message: `模型 ${cfg.model} 不存在，可选：${shown}${models.length > 8 ? ' …' : ''}`,
        };
      }
      return { status: 'pass', message: `LLM 可用（${base}，模型 ${cfg.model}）` };
    } catch (e) {
      return { status: 'fail', message: `LLM 不可达：${describeError(e)}` };
    }
  }
}
