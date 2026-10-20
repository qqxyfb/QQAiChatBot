import fs from 'node:fs';
import path from 'node:path';
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
    if (r.segments && r.segments.length > 0) {
      for (const seg of r.segments) {
        if (seg.type === 'text') await this.sendText(r, seg.text);
        else if (seg.type === 'sticker') await this.sendImage(r, seg.path);
        else if (seg.type === 'voice') await this.sendAudio(r, seg.path);
      }
      return;
    }
    await this.sendText(r, r.content);
  }

  private msgPath(r: ReplyPayload): string {
    return r.channel === 'group'
      ? `/v2/groups/${encodeURIComponent(r.groupId || '')}/messages`
      : `/v2/users/${encodeURIComponent(r.fromId || '')}/messages`;
  }

  private async post(r: ReplyPayload, body: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${this.apiBase}${this.msgPath(r)}`, {
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

  private sendText(r: ReplyPayload, content: string): Promise<void> {
    return this.post(r, { content, msg_type: 0, msg_id: r.messageId, msg_seq: 1 });
  }

  /** 表情包按图片发送：先上传拿 file_info，再发富媒体消息（官方 API 无原生表情类型） */
  private async sendImage(r: ReplyPayload, filePath: string): Promise<void> {
    const fileInfo = await this.uploadFile(r, filePath, 1);
    await this.post(r, { msg_type: 7, msg_id: r.messageId, msg_seq: 1, media: { file_info: fileInfo } });
  }

  private async sendAudio(r: ReplyPayload, filePath: string): Promise<void> {
    const fileInfo = await this.uploadFile(r, filePath, 3);
    await this.post(r, { msg_type: 7, msg_id: r.messageId, msg_seq: 1, media: { file_info: fileInfo } });
  }

  /**
   * 上传富媒体文件拿 file_info。
   * file_type：1=图片、2=视频、3=语音；具体字段与 msg_type/media 结构以 QQ 开放平台当前文档为准。
   */
  private async uploadFile(r: ReplyPayload, filePath: string, fileType: number): Promise<string> {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file_type', String(fileType));
    form.append('file', new Blob([buf]), path.basename(filePath));
    const url =
      r.channel === 'group'
        ? `${this.apiBase}/v2/groups/${encodeURIComponent(r.groupId || '')}/files`
        : `${this.apiBase}/v2/users/${encodeURIComponent(r.fromId || '')}/files`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `QQBot ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const j = (await resp.json()) as { file_info?: string; message?: string };
    if (!resp.ok || !j.file_info) {
      throw new Error(`上传文件失败 HTTP ${resp.status}: ${j.message || ''}`);
    }
    return j.file_info;
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
