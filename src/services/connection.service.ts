import type { Database } from '../db';
import net from 'node:net';
import type { ConnectionRepo, PersonaRepo } from '../db/repos';
import type { ConnectionManager } from '../manager/connection-manager';
import type { SecretStore } from '../secret/secret-store';
import type { ConfigService } from './config.service';
import type {
  ConnectionConfig,
  ConnectionStatus,
  ConnectorType,
  PrecheckItem,
  PrecheckResult,
} from '../types';
import { dayStartMs } from '../utils/time';

/** TCP 探活：只判断端口能否连上，用来区分「NapCat 没开」和「token 不对」 */
function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const target = (host || '').trim().replace(/^wss?:\/\//i, '').split('/')[0];
    const socket = net.connect({ host: target, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function defaultConnectionConfig(name: string, type: ConnectorType): ConnectionConfig {
  return {
    connectionId: `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    type,
    official:
      type === 'official'
        ? { appId: '', appSecret: '', apiDomain: 'https://api.sgroup.qq.com' }
        : undefined,
    account:
      type === 'account'
        ? { host: '127.0.0.1', port: 3001, wsMode: 'forward' }
        : undefined,
    riskConfirmed: false,
    personaId: 'persona_default',
    chat: {
      mode: 'blacklist',
      groupList: [],
      userList: [],
      contextMaxMessages: 12,
      contextTtlMinutes: 5,
      dailyTokenBudget: 50000,
      maxInputLen: 2000,
      floodThreshold: 10,
      rateLimit: { maxPerMinute: 20, minIntervalMs: 1000 },
      budgetAlertPct: 80,
      trigger: 'at',
      triggerKeywords: [],
      randomProbability: 0.1,
      replyQuote: 'auto',
    },
  };
}

export class ConnectionService {
  constructor(
    private db: Database,
    private repo: ConnectionRepo,
    private personaRepo: PersonaRepo,
    private manager: ConnectionManager,
    private secret: SecretStore,
    private config: ConfigService
  ) {}

  private decrypt(cfg: ConnectionConfig): ConnectionConfig {
    const c = JSON.parse(JSON.stringify(cfg)) as ConnectionConfig;
    if (c.official?.appSecret) c.official.appSecret = this.secret.decrypt(c.official.appSecret);
    if (c.account?.accessToken) c.account.accessToken = this.secret.decrypt(c.account.accessToken);
    return c;
  }

  private encrypt(cfg: ConnectionConfig): ConnectionConfig {
    const c = JSON.parse(JSON.stringify(cfg)) as ConnectionConfig;
    if (c.official?.appSecret) c.official.appSecret = this.secret.encrypt(c.official.appSecret);
    if (c.account?.accessToken) c.account.accessToken = this.secret.encrypt(c.account.accessToken);
    return c;
  }

  list(): Array<ConnectionConfig & { status: string; personaName: string; todayMessages: number; todayTokens: number }> {
    return this.repo.list().map((row) => {
      const cfg = this.decrypt(JSON.parse(row.config_json) as ConnectionConfig);
      const persona = this.personaRepo.get(cfg.personaId);
      const stat = this.db
        .prepare(
          'SELECT COUNT(*) AS m, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS t FROM message_log WHERE connection_id=? AND ts>=?'
        )
        .get(cfg.connectionId, dayStartMs()) as { m: number; t: number };
      return {
        ...cfg,
        status: row.status,
        personaName: persona?.name ?? '(未绑定)',
        todayMessages: stat.m,
        todayTokens: stat.t,
      };
    });
  }

  create(input: { name: string; type: ConnectorType; copyFrom?: string }): ConnectionConfig {
    if (!input.name?.trim()) throw new Error('连接名称不能为空');
    const max = this.config.load().maxConnections;
    if (this.repo.list().length >= max) throw new Error(`已达最大连接数 ${max}`);

    let cfg: ConnectionConfig;
    if (input.copyFrom) {
      const src = this.get(input.copyFrom);
      if (!src) throw new Error('源连接不存在');
      cfg = JSON.parse(JSON.stringify(src)) as ConnectionConfig;
      cfg.connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      cfg.name = input.name.trim();
    } else {
      cfg = defaultConnectionConfig(input.name.trim(), input.type);
    }
    this.repo.upsert(this.encrypt(cfg), 'stopped');
    return cfg;
  }

  get(id: string): ConnectionConfig | undefined {
    const row = this.repo.get(id);
    if (!row) return undefined;
    return this.decrypt(JSON.parse(row.config_json) as ConnectionConfig);
  }

  update(id: string, input: Partial<ConnectionConfig>): ConnectionConfig {
    const cur = this.get(id);
    if (!cur) throw new Error('连接不存在');
    const next: ConnectionConfig = { ...cur, ...input, connectionId: id };
    this.validate(next);
    const row = this.repo.get(id);
    this.repo.upsert(this.encrypt(next), (row?.status as ConnectionStatus) ?? 'stopped');
    this.manager.get(id)?.updateConfig(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    const rt = this.manager.get(id);
    if (rt && (rt.status === 'running' || rt.status === 'starting')) {
      throw new Error('运行中的连接需先停止');
    }
    await this.manager.remove(id);
    this.repo.remove(id);
  }

  private validate(cfg: ConnectionConfig): void {
    if (!cfg.name?.trim()) throw new Error('连接名称不能为空');
    if (cfg.type === 'account' && !cfg.riskConfirmed) {
      throw new Error('选择登录 QQ 号需确认知晓封号风险');
    }
    if (!cfg.personaId) throw new Error('必须绑定人格');
    if (cfg.chat.contextMaxMessages < 1) throw new Error('上下文条数至少为 1');
    if (cfg.chat.maxInputLen < 0) throw new Error('输入长度限制不能为负');
  }

  precheck(id: string): PrecheckResult {
    const cfg = this.get(id);
    if (!cfg) throw new Error('连接不存在');
    const items: PrecheckItem[] = [];

    if (cfg.type === 'official') {
      const ok = Boolean(cfg.official?.appId && cfg.official?.appSecret);
      items.push({
        key: 'credential',
        level: 'block',
        status: ok ? 'pass' : 'fail',
        message: ok ? '凭据完整' : '连接凭据不完整：请填写 AppID / AppSecret',
      });
    } else {
      const ok = Boolean(cfg.account?.host && cfg.account?.port);
      items.push({
        key: 'credential',
        level: 'block',
        status: ok ? 'pass' : 'fail',
        message: ok ? 'OneBot 地址/端口已填写' : '连接凭据不完整：请填写 OneBot 地址 / 端口',
      });
    }

    items.push({ key: 'dependency', level: 'block', status: 'pass', message: '依赖可用' });

    const persona = this.personaRepo.get(cfg.personaId);
    items.push({
      key: 'persona',
      level: 'block',
      status: persona ? 'pass' : 'fail',
      message: persona ? '人格有效' : '绑定人格无效：请重新选择人格',
    });

    const llm = cfg.llmOverride ?? this.config.load().llm;
    items.push({
      key: 'llm',
      level: 'warn',
      status: llm.apiKey ? 'pass' : 'fail',
      message: llm.apiKey ? 'LLM 已配置' : '未配置 LLM API Key，将使用演示模式',
    });

    return { ok: !items.some((i) => i.level === 'block' && i.status === 'fail'), items };
  }

  /**
   * 异步预检：在同步预检之上补 OneBot 端口探活与 LLM 连通性/模型探测。
   *
   * 分级原则：
   *  - 端口连不上、LLM 不可达、LLM 鉴权失败 → 阻塞（这些情况下启动必然静默失败）
   *  - 模型名不在 /models 列表 → 仅警告（中转站列表常不完整，不该把人挡在门外）
   */
  async precheckAsync(id: string): Promise<PrecheckResult> {
    const pre = this.precheck(id);
    const cfg = this.get(id);
    if (!cfg) throw new Error('连接不存在');

    const items = pre.items.filter((i) => i.key !== 'llm');

    // OneBot 端口探活：区分「NapCat 没启动/端口不对」和「token 不对」
    if (cfg.type === 'account' && cfg.account?.wsMode !== 'reverse' && cfg.account?.host && cfg.account?.port) {
      const reachable = await probeTcp(cfg.account.host, cfg.account.port);
      items.push({
        key: 'onbot',
        level: 'block',
        status: reachable ? 'pass' : 'fail',
        message: reachable
          ? `NapCat 端口可达（${cfg.account.host}:${cfg.account.port}）`
          : `无法连接 ${cfg.account.host}:${cfg.account.port}：请确认 NapCat 已启动，OneBot 11 的 WebSocket 服务端已开启且端口一致`,
      });
    }

    const llm = cfg.llmOverride ?? this.config.load().llm;
    const probe = await this.config.probeLlm(llm);
    items.push({
      key: 'llm',
      level: probe.severity,
      status: probe.status === 'fail' ? 'fail' : 'pass',
      message: probe.message,
    });

    return { ok: !items.some((i) => i.level === 'block' && i.status === 'fail'), items };
  }

  async start(id: string): Promise<{ ok: boolean; code: number; precheck: PrecheckResult; message: string }> {
    const pre = await this.precheckAsync(id);
    if (!pre.ok) {
      const reasons = pre.items
        .filter((i) => i.level === 'block' && i.status === 'fail')
        .map((i) => i.message)
        .join('；');
      return { ok: false, code: 1001, precheck: pre, message: `预检未通过：${reasons || '存在阻塞项'}` };
    }
    try {
      await this.manager.start(id);
      return { ok: true, code: 0, precheck: pre, message: '已启动' };
    } catch (e) {
      return { ok: false, code: 1002, precheck: pre, message: (e as Error).message };
    }
  }

  async stop(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.manager.stop(id);
      return { ok: true, message: '已停止' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async startAll(): Promise<{ started: string[]; failed: Array<{ id: string; message: string }> }> {
    const started: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const row of this.repo.list()) {
      const r = await this.start(row.connection_id);
      if (r.ok) started.push(row.connection_id);
      else failed.push({ id: row.connection_id, message: r.message });
    }
    return { started, failed };
  }

  async stopAll(): Promise<void> {
    await this.manager.stopAll();
  }

  status(id: string): { status: ConnectionStatus; connectorStatus: string; heartbeatAt: number | null } {
    const rt = this.manager.get(id);
    const row = this.repo.get(id);
    return {
      status: (rt?.status ?? (row?.status as ConnectionStatus) ?? 'stopped') as ConnectionStatus,
      connectorStatus: rt?.connector.status() ?? 'disconnected',
      heartbeatAt: null,
    };
  }

  test(id: string): { ok: boolean; message: string } {
    const pre = this.precheck(id);
    const failed = pre.items.filter((i) => i.status === 'fail');
    return {
      ok: failed.length === 0,
      message: failed.length ? failed.map((i) => i.message).join('；') : '配置检查通过',
    };
  }
}
