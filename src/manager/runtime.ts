import type {
  ConnectionConfig,
  ConnectionStatus,
  LlmConfig,
  MetricEvent,
  Persona,
} from '../types';
import type { BanwordRepo, PersonaRepo, TokenBudgetRepo } from '../db/repos';
import type { Connector } from '../connectors/types';
import { OfficialBotConnector } from '../connectors/official';
import { AccountLoginConnector } from '../connectors/account';
import { ContextManager } from '../pipeline/context';
import { RateLimiter, TokenBudget } from '../pipeline/limits';
import { Pipeline } from '../pipeline';
import { LlmGateway } from '../llm/gateway';

export interface RuntimeDeps {
  personaRepo: PersonaRepo;
  banwordRepo: BanwordRepo;
  tokenBudgetRepo: TokenBudgetRepo;
  globalLlm: LlmConfig;
  emit: (e: MetricEvent) => void;
}

const FALLBACK_PERSONA: Persona = {
  id: 'fallback',
  name: '默认人格',
  profilePrompt: '你是一个友善、简洁的聊天助手。\n\n当前对话：\n用户：{user_message}\n请回复：',
};

/** 单个连接的运行态：连接器 + 独立 pipeline / 上下文 / 限流 / 预算 */
export class ConnectionRuntime {
  readonly connectionId: string;
  config: ConnectionConfig;
  connector: Connector;
  pipeline: Pipeline;
  context: ContextManager;
  limiter: RateLimiter;
  tokenBudget: TokenBudget;
  status: ConnectionStatus = 'stopped';
  sessionId: number | null = null;

  constructor(config: ConnectionConfig, private deps: RuntimeDeps) {
    this.connectionId = config.connectionId;
    this.config = config;
    this.connector =
      config.type === 'official' ? new OfficialBotConnector() : new AccountLoginConnector();

    this.context = new ContextManager(config.chat.contextMaxMessages, config.chat.contextTtlMinutes);
    this.limiter = new RateLimiter(config.chat.rateLimit);
    this.tokenBudget = new TokenBudget(
      deps.tokenBudgetRepo,
      config.connectionId,
      config.chat.dailyTokenBudget
    );

    this.pipeline = new Pipeline({
      connectionId: config.connectionId,
      chat: config.chat,
      context: this.context,
      limiter: this.limiter,
      tokenBudget: this.tokenBudget,
      sendReply: (r) => this.connector.sendReply(r),
      getPersona: () => this.resolvePersona(),
      getBanwords: () => deps.banwordRepo.getCache(),
      createLlm: () =>
        new LlmGateway(
          config.llmOverride ?? deps.globalLlm,
          config.connectionId,
          this.sessionId,
          deps.emit
        ),
      sessionId: () => this.sessionId,
      emit: deps.emit,
    });

    this.connector.onMessage((m) => {
      void this.pipeline.handle(m);
    });
    this.connector.onStatus((s) => {
      const event = s === 'connected' ? 'connect' : s === 'disconnected' ? 'disconnect' : s === 'error' ? 'error' : 'heartbeat';
      deps.emit({
        kind: 'connection',
        connectionId: config.connectionId,
        event,
        connectorType: config.type,
        detail: s,
      });
    });
  }

  private resolvePersona(): Persona {
    const row = this.deps.personaRepo.get(this.config.personaId);
    if (row) {
      try {
        return JSON.parse(row.content_json) as Persona;
      } catch {
        /* fallthrough */
      }
    }
    return FALLBACK_PERSONA;
  }

  /** 更新配置（用于运行时热更新，P0 仅重启生效） */
  updateConfig(config: ConnectionConfig): void {
    this.config = config;
  }
}
