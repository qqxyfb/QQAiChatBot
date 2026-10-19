import WebSocket from 'ws';
import type { Connector } from './types';
import type { ConnectionConfig, ConnectorStatus, NormalizedMessage, ReplyPayload } from '../types';
import { SeenMessages } from './seen';

const WS_OPEN = 1;

/** 登录 QQ 号连接器：OneBot v11 正向 WebSocket（对接 NapCat） */
export class AccountLoginConnector implements Connector {
  readonly type = 'account' as const;
  private ws: WebSocket | null = null;
  private statusVal: ConnectorStatus = 'disconnected';
  private msgHandler: ((m: NormalizedMessage) => void) | null = null;
  private statusHandler: ((s: ConnectorStatus) => void) | null = null;
  private seen = new SeenMessages();
  private cfg: ConnectionConfig | null = null;
  private manualClose = false;

  onMessage(h: (m: NormalizedMessage) => void): void {
    this.msgHandler = h;
  }
  onStatus(h: (s: ConnectorStatus) => void): void {
    this.statusHandler = h;
  }
  status(): ConnectorStatus {
    return this.statusVal;
  }

  private setStatus(s: ConnectorStatus): void {
    this.statusVal = s;
    this.statusHandler?.(s);
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    const host = cfg.account?.host?.trim();
    const port = cfg.account?.port;
    if (!host || !port) throw new Error('缺少 OneBot 地址 / 端口');
    if (cfg.account?.wsMode === 'reverse') {
      throw new Error('反向 WS 模式暂未实现，请使用正向 WS（连接 NapCat）');
    }
    this.cfg = cfg;
    this.manualClose = false;
    this.setStatus('connecting');

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}`, {
        headers: cfg.account?.accessToken ? { Authorization: `Bearer ${cfg.account.accessToken}` } : {},
      });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.setStatus('connected');
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (raw) => {
        try {
          this.handleEvent(JSON.parse(raw.toString()));
        } catch {
          /* ignore malformed */
        }
      });

      ws.on('close', () => {
        this.setStatus('disconnected');
        if (!settled) {
          settled = true;
          reject(new Error('OneBot 连接关闭'));
        }
        if (!this.manualClose) {
          setTimeout(() => this.connect(cfg).catch(() => undefined), 5000);
        }
      });

      ws.on('error', (e) => {
        this.setStatus('error');
        if (!settled) {
          settled = true;
          reject(e as Error);
        }
      });
    });
  }

  private handleEvent(m: Record<string, unknown>): void {
    if (m?.post_type !== 'message' || !this.cfg) return;
    const id = String(m.message_id ?? '');
    if (!this.seen.firstTime(id)) return;
    const isGroup = m.message_type === 'group';
    const raw = String(m.raw_message ?? '');
    this.msgHandler?.({
      connectionId: this.cfg.connectionId,
      channel: isGroup ? 'group' : 'c2c',
      fromId: String(m.user_id ?? ''),
      groupId: isGroup ? String(m.group_id ?? '') : undefined,
      messageId: id,
      content: extractText(m.message ?? raw),
      atBot: isGroup ? raw.includes('[CQ:at,qq=') : true,
    });
  }

  async sendReply(r: ReplyPayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error('连接未就绪');
    const action = r.channel === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params =
      r.channel === 'group'
        ? { group_id: Number(r.groupId), message: r.content }
        : { user_id: Number(r.fromId), message: r.content };
    this.ws.send(JSON.stringify({ action, params, echo: `s-${Date.now()}` }));
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }
}

function extractText(message: unknown): string {
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  if (Array.isArray(message)) {
    return message
      .filter((s) => (s as { type?: string }).type === 'text')
      .map((s) => String((s as { data?: { text?: string } }).data?.text ?? ''))
      .join('')
      .trim();
  }
  return '';
}
