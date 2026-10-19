import type {
  ConnectionConfig,
  ConnectorStatus,
  ConnectorType,
  NormalizedMessage,
  ReplyPayload,
} from '../types';

/** 连接器统一接口（渠道无关） */
export interface Connector {
  readonly type: ConnectorType;
  connect(cfg: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  status(): ConnectorStatus;
  onMessage(h: (m: NormalizedMessage) => void): void;
  onStatus(h: (s: ConnectorStatus) => void): void;
  sendReply(r: ReplyPayload): Promise<void>;
}
