import WebSocket, { WebSocketServer } from 'ws';
import type { Connector } from './types';
import type { ConnectionConfig, ConnectorStatus, NormalizedMessage, ReplyPayload } from '../types';
import { SeenMessages } from './seen';

const WS_OPEN = 1;

/** 握手被服务端拒绝（非 101）：带状态码，便于给出可操作的提示 */
class HandshakeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/** 登录 QQ 号连接器：OneBot v11 正向 / 反向 WebSocket（对接 NapCat） */
export class AccountLoginConnector implements Connector {
  readonly type = 'account' as const;
  private ws: WebSocket | null = null;
  private wss: WebSocketServer | null = null;
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
    const port = cfg.account?.port;
    if (!port) throw new Error('缺少 OneBot 端口');
    this.cfg = cfg;
    this.manualClose = false;

    // 反向 WS：本地监听，等待 NapCat 主动连接
    if (cfg.account?.wsMode === 'reverse') {
      await this.startReverse(port, cfg.account?.accessToken);
      return;
    }

    const host = cfg.account?.host?.trim();
    if (!host) throw new Error('缺少 OneBot 地址');
    this.setStatus('connecting');

    const token = cfg.account?.accessToken?.trim();
    const url = buildWsUrl(host, port, cfg.account?.path);

    /**
     * 不同 NapCat / OneBot 实现对 token 的读取方式不一样：
     *  - 多数版本认 Authorization: Bearer <token>
     *  - 一部分版本（以及经过反向代理时）只认 ?access_token=<token>
     * 所以依次尝试两种握手方式，任一成功即可，避免「token 明明填对了还是 401」。
     */
    const attempts: Array<{ url: string; headers?: Record<string, string> }> = token
      ? [
          { url, headers: { Authorization: `Bearer ${token}` } },
          { url: withTokenQuery(url, token) },
        ]
      : [{ url }];

    let lastError: Error | null = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      try {
        await this.openOnce(attempt.url, attempt.headers, cfg);
        return;
      } catch (e) {
        lastError = describeConnectError(e, { url: attempt.url, token, host, port });
        // 仅鉴权类失败才换下一种 token 传递方式；地址/端口/超时问题重试没有意义
        if (isAuthFailure(e) && i < attempts.length - 1) continue;
        throw lastError;
      }
    }
    throw lastError ?? new Error('OneBot 连接失败');
  }

  /** 建立单次 WS 连接（含握手错误识别、断线自动重连） */
  private openOnce(url: string, headers: Record<string, string> | undefined, cfg: ConnectionConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      this.ws = ws;
      let settled = false;
      let opened = false;

      ws.on('unexpected-response', (req, res) => {
        const statusCode = res.statusCode ?? 0;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (body.length < 400) body += c;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          this.setStatus('error');
          reject(new HandshakeError(`Unexpected server response: ${statusCode}`, statusCode, body.trim()));
        });
        res.on('error', () => {
          if (settled) return;
          settled = true;
          this.setStatus('error');
          reject(new HandshakeError(`Unexpected server response: ${statusCode}`, statusCode, body.trim()));
        });
        // 主动断开底层连接，避免 ws 继续等待或再抛一次 error
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      });

      ws.on('open', () => {
        opened = true;
        if (this.ws === ws) this.setStatus('connected');
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
        // 第一次握手失败后可能紧接着发起第二次连接，旧 socket 的 close 不能把新连接状态改掉
        const current = this.ws === ws;
        if (current) this.setStatus('disconnected');
        if (!settled) {
          settled = true;
          reject(new Error('OneBot 连接在握手阶段被关闭'));
        }
        // 只有「曾经连通过」才自动重连，避免 401/端口不对时无限空转
        if (current && opened && !this.manualClose) {
          setTimeout(() => this.connect(cfg).catch(() => undefined), 5000);
        }
      });

      ws.on('error', (e) => {
        if (this.ws === ws) this.setStatus('error');
        if (!settled) {
          settled = true;
          reject(e as Error);
        }
      });
    });
  }

  private startReverse(port: number, token?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setStatus('connecting');
      const wss = new WebSocketServer({ port, host: '0.0.0.0' });
      this.wss = wss;
      let settled = false;
      const expected = token?.trim();

      wss.on('listening', () => {
        this.setStatus('connected');
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      wss.on('error', (e) => {
        this.setStatus('error');
        if (!settled) {
          settled = true;
          reject(e as Error);
        }
      });

      wss.on('connection', (ws, req) => {
        if (expected && !reverseTokenMatches(req, expected)) {
          // 握手层没有鉴权机会，只能在升级后立即关闭；记录一次状态便于排查
          this.statusHandler?.('error');
          ws.close(1008, 'unauthorized');
          return;
        }
        this.ws = ws;
        this.setStatus('connected');
        ws.on('message', (raw) => {
          try {
            this.handleEvent(JSON.parse(raw.toString()));
          } catch {
            /* ignore */
          }
        });
        ws.on('close', () => {
          this.ws = null;
          this.setStatus('disconnected');
        });
        ws.on('error', () => undefined);
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
    const message = buildMessage(r);
    const params =
      r.channel === 'group'
        ? { group_id: Number(r.groupId), message }
        : { user_id: Number(r.fromId), message };
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
    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        /* ignore */
      }
      this.wss = null;
    }
    this.setStatus('disconnected');
  }
}

/**
 * 拼接 OneBot WebSocket 地址：
 *  - host 支持 "127.0.0.1"、"127.0.0.1:3001"、"ws://127.0.0.1:3001/onebot/v11/ws"
 *  - path 单独配置时优先使用（默认 /）
 */
export function buildWsUrl(hostRaw: string, port: number, pathRaw?: string): string {
  let host = (hostRaw || '').trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
  let path = (pathRaw || '').trim();
  const slash = host.indexOf('/');
  if (slash >= 0) {
    // 地址里已经带了路径（老用户常常直接粘贴完整 ws 地址）
    const inline = host.slice(slash);
    host = host.slice(0, slash);
    if (!path) path = inline;
  }
  if (!/:\d+$/.test(host)) host = `${host}:${port}`;
  if (!path) path = '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return `ws://${host}${path}`;
}

export function withTokenQuery(url: string, token: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

/** 401 / 403 视为「token 问题」，值得换另一种传递方式再试 */
function isAuthFailure(e: unknown): boolean {
  return e instanceof HandshakeError && (e.statusCode === 401 || e.statusCode === 403);
}

interface ConnectContext {
  url: string;
  token?: string;
  host: string;
  port: number;
}

/** 把 URL 里的 access_token 打码，避免错误提示/截图泄露 token */
function maskTokenInUrl(url: string): string {
  return url.replace(/([?&]access_token=)[^&]*/i, '$1***');
}

/** 把底层错误翻译成用户能照着做的提示 */
export function describeConnectError(err: unknown, ctx: ConnectContext): Error {
  const shownUrl = maskTokenInUrl(ctx.url);
  if (err instanceof HandshakeError) {
    const { statusCode, body } = err;
    const tail = body ? `\n服务端返回：${body.slice(0, 200)}` : '';
    if (statusCode === 401 || statusCode === 403) {
      const msg = ctx.token
        ? `NapCat 拒绝了连接（HTTP ${statusCode}：Access Token 不被接受）。\n` +
          `请核对「连接配置 → Access Token」与 NapCat「OneBot 11 / WebSocket 服务器」里的 Token 完全一致` +
          `（区分大小写，不要带 “Bearer ” 前缀）。\n目标地址：${shownUrl}`
        : `NapCat 拒绝了连接（HTTP ${statusCode}：服务端开启了 Access Token 校验，但连接配置里没有填写）。\n` +
          `请复制 NapCat「网络配置 → WebSocket 服务器」中的 Token，填入「连接配置 → Access Token」后重试。\n` +
          `目标地址：${shownUrl}`;
      return new Error(msg + tail);
    }
    if (statusCode === 404) {
      return new Error(
        `WebSocket 路径不存在（HTTP 404）。\n请检查「连接配置 → 路径」是否与 NapCat WebSocket 服务端的路径一致（默认 /）。\n目标地址：${shownUrl}${tail}`
      );
    }
    if (statusCode === 502 || statusCode === 503) {
      return new Error(`NapCat 尚未就绪（HTTP ${statusCode}）。请确认 NapCat 已登录、OneBot 服务已启动后重试。${tail}`);
    }
    return new Error(`WebSocket 握手失败（HTTP ${statusCode}）。目标地址：${shownUrl}${tail}`);
  }

  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code || e?.code || '';
  const msg = e?.cause?.message || e?.message || '未知错误';
  if (code === 'ECONNREFUSED') {
    return new Error(
      `无法连接 ${shownUrl}（连接被拒绝）。\n请确认：NapCat 已启动；「OneBot 11 → WebSocket 服务器」已开启并监听 ${ctx.port} 端口；端口与连接配置一致。`
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`无法解析地址 ${ctx.host}。请检查「OneBot 地址」是否填写正确。`);
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) {
    return new Error(`连接 ${shownUrl} 超时。请确认 NapCat 正在运行，且本机防火墙未拦截该端口。`);
  }
  return new Error(`${code ? `${code}: ` : ''}${msg}（目标地址：${shownUrl}）`);
}

/** 反向 WS 的 token 兼容：Authorization 头 / access_token 查询参数都认 */
function reverseTokenMatches(req: { headers: Record<string, unknown>; url?: string }, expected: string): boolean {
  const auth = String(req.headers.authorization || '').trim();
  const plain = auth.replace(/^Bearer\s+/i, '').trim();
  if (plain === expected) return true;
  try {
    const q = new URL(req.url || '/', 'http://127.0.0.1');
    return (q.searchParams.get('access_token') || '').trim() === expected;
  } catch {
    return false;
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

/**
 * 将富媒体段拼装为 OneBot message 段数组；无 segments 时回退纯文本字符串。
 * 带 quoteMessageId 时在最前面加 `reply` 段（OneBot v11 的引用回复），
 * NapCat / Lagrange 等实现都支持，客户端会显示成「引用某条消息」。
 */
function buildMessage(r: ReplyPayload): unknown {
  const segments: unknown[] = [];
  if (r.quoteMessageId) segments.push({ type: 'reply', data: { id: String(r.quoteMessageId) } });

  if (r.segments && r.segments.length > 0) {
    for (const seg of r.segments) {
      if (seg.type === 'text') segments.push({ type: 'text', data: { text: seg.text } });
      else if (seg.type === 'sticker') segments.push({ type: 'image', data: { file: seg.path } });
      else if (seg.type === 'voice') segments.push({ type: 'record', data: { file: seg.path } });
    }
  } else if (r.content) {
    segments.push({ type: 'text', data: { text: r.content } });
  }

  // 空消息（无正文也无媒体）原样返回，交给上层报错
  if (segments.length === 0) return r.content;
  // 单段纯文字且不需要引用时，仍用最简的字符串格式，兼容性最好
  if (!r.quoteMessageId && r.segments?.length === 1 && r.segments[0].type === 'text') return r.content;
  return segments;
}
