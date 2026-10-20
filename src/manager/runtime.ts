import type {
  ConnectionConfig,
  ConnectionStatus,
  LlmConfig,
  MetricEvent,
  Persona,
  Segment,
  TtsConfig,
} from '../types';
import type { BanwordRepo, PersonaRepo, TokenBudgetRepo, StickerIndex } from '../db/repos';
import type { Connector } from '../connectors/types';
import { OfficialBotConnector } from '../connectors/official';
import { AccountLoginConnector } from '../connectors/account';
import { ContextManager } from '../pipeline/context';
import { RateLimiter, TokenBudget } from '../pipeline/limits';
import { Pipeline } from '../pipeline';
import { LlmGateway } from '../llm/gateway';
import { SerialQueue } from '../utils/serial-queue';

export interface RuntimeDeps {
  personaRepo: PersonaRepo;
  banwordRepo: BanwordRepo;
  tokenBudgetRepo: TokenBudgetRepo;
  /** 全局 LLM 配置用读取器而非快照：核心配置改了无需重启即可生效 */
  getGlobalLlm: () => LlmConfig;
  emit: (e: MetricEvent) => void;
  getStickerTags: (setId: string) => string[];
  getStickerIndex: () => StickerIndex;
  getGlobalTts: () => TtsConfig;
  synthesizeVoice: (text: string, cfg: TtsConfig) => Promise<Segment | null>;
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

  /** 同会话串行队列：防止并发跑 LLM 导致回复乱序、上下文交错 */
  private queues = new SerialQueue(5, (key, depth) => {
    this.deps.emit({
      kind: 'log',
      connectionId: this.connectionId,
      level: 'WARN',
      source: 'pipeline',
      msg: `会话 ${key} 已积压 ${depth} 条待处理消息，丢弃新消息`,
    });
  });

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

    this.pipeline = this.createPipeline();

    this.connector.onMessage((m) => {
      const key = `${m.channel}:${m.groupId ?? m.fromId}`;
      void this.queues.run(key, () => this.pipeline.handle(m));
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

  private createPipeline(): Pipeline {
    return new Pipeline({
      connectionId: this.config.connectionId,
      chat: this.config.chat,
      context: this.context,
      limiter: this.limiter,
      tokenBudget: this.tokenBudget,
      sendReply: (r) => this.connector.sendReply(r),
      getPersona: () => this.resolvePersona(),
      getBanwords: () => this.deps.banwordRepo.getCache(),
      // llmOverride / 全局 LLM 都在调用时实时读取，改配置后下一条消息即生效
      createLlm: () =>
        new LlmGateway(
          this.config.llmOverride ?? this.deps.getGlobalLlm(),
          this.config.connectionId,
          this.sessionId,
          this.deps.emit
        ),
      sessionId: () => this.sessionId,
      emit: this.deps.emit,
      getStickerTags: (setId) => this.deps.getStickerTags(setId),
      getStickerIndex: () => this.deps.getStickerIndex(),
      getGlobalTts: () => this.deps.getGlobalTts(),
      synthesizeVoice: (text, cfg) => this.deps.synthesizeVoice(text, cfg),
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

  /**
   * 更新配置（运行时热生效）。
   * chat 相关参数就地刷新（上下文内容、当日 token 计数、限流分桶都保留）；
   * llmOverride / 全局 LLM 由 createLlm 的闭包实时读取，无需额外处理。
   */
  updateConfig(config: ConnectionConfig): void {
    const prev = this.config;
    this.config = config;

    const chatChanged = JSON.stringify(prev.chat) !== JSON.stringify(config.chat);
    const personaChanged = prev.personaId !== config.personaId;
    if (!chatChanged && !personaChanged) return;

    if (chatChanged) {
      this.context.reconfigure(config.chat.contextMaxMessages, config.chat.contextTtlMinutes);
      this.limiter.updateConfig(config.chat.rateLimit);
      this.tokenBudget.updateLimit(config.chat.dailyTokenBudget);
      this.pipeline.setChat(config.chat);
    }

    this.deps.emit({
      kind: 'log',
      connectionId: this.connectionId,
      level: 'INFO',
      source: 'server',
      msg: `配置已热更新（${chatChanged ? '聊天参数' : ''}${personaChanged ? ' 人格绑定' : ''}），无需重启连接`,
    });
  }
}
