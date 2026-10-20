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
  /** block=阻断启动；warn=仅提示，允许继续启动 */
  severity: 'block' | 'warn';
}

export interface LlmModelsResult {
  ok: boolean;
  models: string[];
  message: string;
  latencyMs: number;
  baseUrl: string;
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
      tts: { provider: 'edge', baseUrl: '', apiKey: '', voice: 'zh-CN-XiaoxiaoNeural', model: 'tts-1' },
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
      tts: { ...def.tts, ...(raw.tts ?? {}) },
      storage: { ...def.storage, ...(raw.storage ?? {}) },
      server: { ...def.server, ...(raw.server ?? {}) },
      update: { ...def.update, ...(raw.update ?? {}) },
      pricing: { ...def.pricing, ...(raw.pricing ?? {}) },
      maxConnections: raw.maxConnections ?? def.maxConnections,
    };
    cfg.llm.apiKey = this.secret.decrypt(cfg.llm.apiKey || '');
    cfg.tts.apiKey = this.secret.decrypt(cfg.tts.apiKey || '');
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
    if (cfg.tts?.apiKey === '***') cfg.tts.apiKey = cur.tts.apiKey;
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
    toStore.tts.apiKey = this.secret.encrypt(cfg.tts?.apiKey || '');
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

  /**
   * 测试 LLM 连接（最小请求）。
   * 失败时把上游的完整报错带回来 —— 只回 "HTTP 400" 用户根本不知道是模型名写错还是额度不足。
   */
  async testLlm(
    cfg: LlmConfig
  ): Promise<{ ok: boolean; status?: number; latencyMs: number; message: string; detail?: string; models?: string[] }> {
    const t0 = Date.now();
    if (!cfg.apiKey) return { ok: false, latencyMs: 0, message: '未配置 API Key' };
    const base = normalizeLlmBase(cfg.baseUrl);
    if (!base) return { ok: false, latencyMs: 0, message: 'LLM Base URL 为空' };
    const url = `${base}/chat/completions`;
    try {
      const resp = await httpFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        timeoutMs: 12000,
      });
      if (resp.ok) {
        return { ok: true, status: resp.status, latencyMs: Date.now() - t0, message: '连接成功' };
      }
      const raw = await resp.text().catch(() => '');
      const detail = extractUpstreamError(raw);
      const latencyMs = Date.now() - t0;
      const hint = statusHint(resp.status);

      // 模型相关报错时顺手拉一次模型列表，直接把「可选项」摆到用户面前
      let models: string[] | undefined;
      if (resp.status === 400 || resp.status === 404) {
        const listed = await this.listModels(cfg).catch(() => null);
        if (listed?.ok && listed.models.length) models = listed.models;
      }
      const optionText =
        models?.length && !/可选/.test(detail)
          ? `\n可选模型（${models.length}）：${models.slice(0, 12).join(', ')}${models.length > 12 ? ' …' : ''}`
          : '';
      return {
        ok: false,
        status: resp.status,
        latencyMs,
        message: `${hint}${detail ? `：${detail}` : ''}${optionText}`,
        detail: raw.slice(0, 1200) || undefined,
        models,
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, message: `请求失败：${describeError(e)}` };
    }
  }

  /**
   * 拉取模型列表（OpenAI 兼容 /v1/models）。
   * 前端用它做「可选模型」下拉，避免用户凭记忆手填模型名。
   */
  async listModels(cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey'>): Promise<LlmModelsResult> {
    const t0 = Date.now();
    const base = normalizeLlmBase(cfg.baseUrl);
    const fail = (message: string): LlmModelsResult => ({
      ok: false,
      models: [],
      message,
      latencyMs: Date.now() - t0,
      baseUrl: base,
    });
    if (!base) return fail('LLM Base URL 为空');
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    try {
      const resp = await httpFetch(`${base}/models`, { headers, timeoutMs: 10000 });
      const raw = await resp.text().catch(() => '');
      if (resp.status === 404 || resp.status === 405) {
        return fail(`该服务未提供 /models 接口（HTTP ${resp.status}），请手动填写模型名`);
      }
      if (resp.status === 401 || resp.status === 403) {
        return fail(`鉴权失败（HTTP ${resp.status}）：API Key 不正确或已失效`);
      }
      if (!resp.ok) {
        return fail(`获取模型失败（HTTP ${resp.status}）${extractUpstreamError(raw) ? `：${extractUpstreamError(raw)}` : ''}`);
      }
      let models: string[] = [];
      try {
        const j = JSON.parse(raw) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string } | string> };
        if (Array.isArray(j.data)) {
          models = j.data.map((m) => String(m?.id ?? '')).filter(Boolean);
        } else if (Array.isArray(j.models)) {
          models = j.models.map((m) => (typeof m === 'string' ? m : String(m?.id ?? ''))).filter(Boolean);
        }
      } catch {
        return fail('服务返回的不是 JSON，无法解析模型列表');
      }
      if (!models.length) return fail('服务返回的模型列表为空');
      models = [...new Set(models)].sort((a, b) => a.localeCompare(b));
      return {
        ok: true,
        models,
        message: `已获取 ${models.length} 个模型`,
        latencyMs: Date.now() - t0,
        baseUrl: base,
      };
    } catch (e) {
      return fail(`请求失败：${describeError(e)}`);
    }
  }

  /**
   * 启动前置探测：LLM 端点连通性 + 模型是否真实存在。
   * 目的：把「running 但完全静默」提前变成「启动失败 + 明确原因」。
   * 未配置 API Key 时跳过（演示模式）；代理不支持 /models 时降级为仅探通。
   *
   * 注意：模型名不在 /models 列表里只作为「警告」，不阻断启动。
   * 很多中转站（含本地 wb2api）的 /models 并不完整，或者用别名映射，
   * 严格拦截会把能用的情况也挡在门外。
   */
  async probeLlm(cfg: LlmConfig): Promise<LlmProbe> {
    const base = normalizeLlmBase(cfg.baseUrl);
    if (!base) return { status: 'fail', severity: 'block', message: 'LLM Base URL 为空' };
    if (!cfg.apiKey) {
      return { status: 'skip', severity: 'warn', message: '未配置 LLM API Key，将使用演示模式' };
    }

    try {
      const resp = await httpFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        timeoutMs: 8000,
      });
      if (resp.status === 404 || resp.status === 405) {
        return {
          status: 'pass',
          severity: 'warn',
          message: `LLM 端点可达（${base}，不支持 /models，跳过模型校验）`,
        };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { status: 'fail', severity: 'block', message: `LLM 鉴权失败：HTTP ${resp.status}，请检查 API Key` };
      }
      if (!resp.ok) {
        return { status: 'fail', severity: 'block', message: `LLM 请求失败：HTTP ${resp.status}` };
      }

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
          severity: 'warn',
          message:
            `模型 ${cfg.model} 不在服务端模型列表中（仍可尝试启动，若回复异常请改成下面的名字）\n` +
            `可选：${shown}${models.length > 8 ? ` …（共 ${models.length} 个）` : ''}`,
        };
      }
      return { status: 'pass', severity: 'warn', message: `LLM 可用（${base}，模型 ${cfg.model}）` };
    } catch (e) {
      return { status: 'fail', severity: 'block', message: `LLM 不可达：${describeError(e)}` };
    }
  }
}

/** 从 OpenAI 兼容错误响应里取出可读信息 */
function extractUpstreamError(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; type?: string; code?: string } | string;
      message?: string;
    };
    if (typeof j.error === 'string') return j.error.slice(0, 500);
    if (j.error?.message) return j.error.message.slice(0, 500);
    if (j.message) return j.message.slice(0, 500);
  } catch {
    /* 非 JSON，直接截断原文 */
  }
  return text.slice(0, 500);
}

function statusHint(status: number): string {
  if (status === 400) return '请求被拒（HTTP 400，常见原因：模型名不存在 / 参数不被支持）';
  if (status === 401) return '鉴权失败（HTTP 401）：API Key 不正确或已失效';
  if (status === 403) return '无权限（HTTP 403）：Key 没有该模型的访问权限';
  if (status === 404) return '接口或模型不存在（HTTP 404）：请检查 Base URL 是否以 /v1 结尾、模型名是否正确';
  if (status === 429) return '触发限流（HTTP 429）：请求过快或额度用尽';
  if (status >= 500) return `服务端错误（HTTP ${status}）`;
  return `请求失败（HTTP ${status}）`;
}
