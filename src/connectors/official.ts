import WebSocket from 'ws';
import type { Connector } from './types';
import type { ConnectionConfig, ConnectorStatus, NormalizedMessage, ReplyPayload } from '../types';
import { SeenMessages } from './seen';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const DEFAULT_API = 'https://api.sgroup.qq.com';
const WS_OPEN = 1;

/** QQ 官方机器人 API v2 连接器（WS + REST，自研轻量实现） */
export class OfficialBotConnector implements Connector {
  readonly type = 'official' as const;
  private ws: WebSocket | null = null;
  private token = '';
  private apiBase = DEFAULT_API;
  private statusVal: ConnectorStatus = 'disconnected';
  private msgHandler: ((m: NormalizedMessage) => void) | null = null;
  private statusHandler: ((s: ConnectorStatus) => void) | null = null;
  private seen = new SeenMessages();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seq: number | null = null;
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
    this.cfg = cfg;
    this.manualClose = false;
    const appId = cfg.official?.appId?.trim();
    const secret = cfg.official?.appSecret?.trim();
    if (!appId || !secret) throw new Error('缺少 AppID / AppSecret');
    this.apiBase = (cfg.official?.apiDomain || DEFAULT_API).replace(/\/+$/, '');
    this.setStatus('connecting');

    const tr = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: AbortSignal.timeout(10000),
    });
    const tj = (await tr.json()) as { access_token?: string; message?: string };
    if (!tj.access_token) throw new Error(`获取 access_token 失败：${tj.message || tr.status}`);
    this.token = tj.access_token;

    const gr = await fetch(`${this.apiBase}/gateway`, {
      headers: { Authorization: `QQBot ${this.token}` },
      signal: AbortSignal.timeout(10000),
    });
    const gj = (await gr.json()) as { url?: string };
    if (!gj.url) throw new Error('获取 gateway 地址失败');

    await this.openWs(gj.url);
  }

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on('message', (raw) => {
        let msg: { op?: number; t?: string; d?: unknown; s?: number };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (typeof msg.s === 'number') this.seq = msg.s;

        if (msg.op === 10) {
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${this.token}`,
                intents: (1 << 25) | (1 << 30),
                properties: { $os: process.platform, $browser: 'qqaichatbot', $device: 'qqaichatbot' },
              },
            })
          );
          this.startHeartbeat(ws);
          this.setStatus('connected');
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (msg.op === 0) this.handleDispatch(msg.t, msg.d);
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        this.setStatus('disconnected');
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket 连接关闭'));
        }
        if (!this.manualClose) this.scheduleReconnect();
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

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ op: 1, d: this.seq }));
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleDispatch(t: string | undefined, d: unknown): void {
    if (!d || !this.cfg) return;
    const data = d as {
      id?: string;
      content?: string;
      group_openid?: string;
      author?: { member_openid?: string; user_openid?: string };
    };
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      const id = String(data.id || '');
      if (!this.seen.firstTime(id)) return;
      this.msgHandler?.({
        connectionId: this.cfg.connectionId,
        channel: 'group',
        fromId: String(data.author?.member_openid || ''),
        groupId: String(data.group_openid || ''),
        messageId: id,
        content: stripAt(String(data.content || '')),
        atBot: true,
      });
    } else if (t === 'C2C_MESSAGE_CREATE') {
      const id = String(data.id || '');
      if (!this.seen.firstTime(id)) return;
      this.msgHandler?.({
        connectionId: this.cfg.connectionId,
        channel: 'c2c',
        fromId: String(data.author?.user_openid || ''),
        messageId: id,
        content: String(data.content || ''),
        atBot: false,
      });
    }
  }

  async sendReply(r: ReplyPayload): Promise<void> {
    const path =
      r.channel === 'group'
        ? `/v2/groups/${encodeURIComponent(r.groupId || '')}/messages`
        : `/v2/users/${encodeURIComponent(r.fromId || '')}/messages`;
    const body = { content: r.content, msg_type: 0, msg_id: r.messageId, msg_seq: 1 };
    const resp = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`发送失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.stopHeartbeat();
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

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.manualClose || !this.cfg) return;
      this.connect(this.cfg).catch(() => this.scheduleReconnect());
    }, 5000);
  }
}

function stripAt(s: string): string {
  return s.replace(/<@!?\d+>/g, '').trim();
}
