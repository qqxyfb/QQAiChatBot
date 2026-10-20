/**
 * 全局共享类型（前后端同源）。
 * 后端 src 直接引用；前端 web/src/types.ts 通过 re-export 引用。
 */

// ---------- 枚举 ----------
export type ConnectionStatus = 'stopped' | 'starting' | 'running' | 'error';
export type ConnectorStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type ConnectorType = 'official' | 'account';
export type Channel = 'group' | 'c2c';
export type FinishReason = 'normal' | 'refuse' | 'limit' | 'abuse' | 'error' | 'unauthorized' | 'stub';
export type TriggerMode = 'at' | 'keyword' | 'random' | 'silent'; // [P1]
export type ListMode = 'whitelist' | 'blacklist';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogSource = 'server' | 'connector' | 'llm' | 'pipeline';

// ---------- 全局配置 ----------
export interface LlmConfig {
  baseUrl: string;
  apiKey: string; // SecretStore 加密存储
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface StorageConfig {
  dataDir: string;
  historyRetentionDays: number; // <=0 永久
  logRetentionDays: number;
}

export interface ServerConfig {
  port: number;
  allowLan: boolean;
  accessToken: string; // allowLan 时必填，>=8 位
}

export interface UpdateConfig {
  owner: string;
  repo: string;
  autoCheck: boolean;
  pat?: string;
}

export interface PricingConfig {
  inputPrice: number; // 元 / 百万 token
  outputPrice: number;
}

export interface GlobalConfig {
  llm: LlmConfig;
  storage: StorageConfig;
  server: ServerConfig;
  update: UpdateConfig;
  pricing: Record<string, PricingConfig>;
  maxConnections: number;
}

// ---------- 连接配置 ----------
export interface OfficialConfig {
  appId: string;
  appSecret: string;
  apiDomain?: string;
  botToken?: string;
}

export interface AccountConfig {
  host: string;
  port: number;
  accessToken?: string;
  wsMode: 'forward' | 'reverse';
}

export type RateLimitScope = 'connection' | 'user';

export interface RateLimitConfig {
  maxPerMinute: number;
  minIntervalMs: number;
  /** 限流维度：user=按对象分桶（默认），connection=整连接共享 */
  scope?: RateLimitScope;
}

export interface ChatConfig {
  mode: ListMode;
  groupList: string[];
  userList: string[];
  contextMaxMessages: number;
  contextTtlMinutes: number;
  dailyTokenBudget: number;
  maxInputLen: number;
  floodThreshold: number;
  rateLimit: RateLimitConfig;
  budgetAlertPct: number;
  trigger: TriggerMode;
  triggerKeywords?: string[]; // [P1] 关键词触发
  randomProbability?: number; // [P1] 概率闲聊 0~1
}

export interface ConnectionConfig {
  connectionId: string;
  name: string;
  type: ConnectorType;
  official?: OfficialConfig;
  account?: AccountConfig;
  riskConfirmed: boolean;
  personaId: string;
  chat: ChatConfig;
  llmOverride?: LlmConfig; // [P1]
}

// ---------- 运行时消息 ----------
export interface NormalizedMessage {
  connectionId: string;
  channel: Channel;
  fromId: string;
  groupId?: string;
  messageId: string;
  content: string;
  atBot: boolean;
}

export interface ReplyPayload {
  messageId: string;
  content: string;
  channel: Channel;
  fromId?: string;
  groupId?: string;
}

// ---------- 预检 ----------
export type PrecheckKey = 'credential' | 'dependency' | 'persona' | 'llm';
export interface PrecheckItem {
  key: PrecheckKey;
  level: 'block' | 'warn';
  status: 'pass' | 'fail';
  message: string;
}
export interface PrecheckResult {
  ok: boolean;
  items: PrecheckItem[];
}

// ---------- 事件 ----------
export interface MessageMetric {
  kind: 'message';
  connectionId: string;
  sessionId: number | null;
  channel: Channel;
  fromHash: string;
  groupHash: string;
  direction: 'in' | 'out';
  content: string;
  reply: string;
  finishReason: FinishReason;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  llmMs: number;
  llmAttempts: number;
  persona: string;
  msgId: string;
}

export interface LlmCallMetric {
  kind: 'llm_call';
  connectionId: string;
  sessionId: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: 'ok' | '5xx' | 'timeout' | 'error';
  retryCnt: number;
  error?: string;
}

export interface ConnectionMetric {
  kind: 'connection';
  connectionId: string;
  event: 'connect' | 'disconnect' | 'heartbeat' | 'error';
  connectorType: ConnectorType;
  detail?: string;
}

export interface AbuseMetric {
  kind: 'abuse';
  connectionId: string;
  fromHash: string;
  reason: string;
  abuseKind: 'flood' | 'over_len' | 'budget' | 'rate';
}

export interface LogEvent {
  kind: 'log';
  connectionId?: string;
  level: LogLevel;
  source: LogSource;
  msg: string;
  meta?: Record<string, unknown>;
}

export type MetricEvent = MessageMetric | LlmCallMetric | ConnectionMetric | AbuseMetric | LogEvent;

// ---------- 人格 ----------
export interface Persona {
  id: string;
  name: string;
  profile?: string;
  profilePrompt: string;
  tags?: string[];
  emotionStyle?: string;
  sampleDialogues?: Array<{ user: string; bot: string }>;
  bannedWords?: string[];
  stats?: Record<string, unknown>;
}

export interface PersonaListItem extends Persona {
  builtin: boolean;
  referencedBy: string[];
  updatedAt: number;
}

// ---------- API 响应 ----------
export interface ApiResp<T = unknown> {
  code: number;
  data: T;
  message: string;
}
