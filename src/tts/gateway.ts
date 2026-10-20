import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { TtsConfig } from '../types';
import { httpFetch } from '../services/http';

export interface TtsResult {
  ok: boolean;
  filePath: string;
  format: 'mp3';
  duration: number; // 秒；不精确计算，暂为 0
  error?: string;
}

interface Synthesized {
  audio: Buffer;
  format: 'mp3';
}

interface TtsProvider {
  readonly type: string;
  synthesize(text: string, cfg: TtsConfig): Promise<Synthesized>;
}

/** OpenAI 兼容 /audio/speech：覆盖多数云厂商（含硅基流动、MiniMax 等兼容网关） */
class OpenAICompatibleTtsProvider implements TtsProvider {
  readonly type = 'openai-compatible';

  async synthesize(text: string, cfg: TtsConfig): Promise<Synthesized> {
    const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('缺少 TTS Base URL');
    const url = base.toLowerCase().endsWith('/audio/speech') ? base : `${base}/audio/speech`;
    const resp = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || ''}` },
      body: JSON.stringify({ model: cfg.model || 'tts-1', input: text, voice: cfg.voice }),
      timeoutMs: 30000,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`TTS HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return { audio: Buffer.from(await resp.arrayBuffer()), format: 'mp3' };
  }
}

/** Edge TTS：微软 Edge 浏览器背后的在线语音服务，免费无需 key，输出 mp3（WebSocket 协议，非官方接口） */
class EdgeTtsProvider implements TtsProvider {
  readonly type = 'edge';

  synthesize(text: string, cfg: TtsConfig): Promise<Synthesized> {
    const voice = cfg.voice || 'zh-CN-XiaoxiaoNeural';
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
      `<voice name='${escapeXml(voice)}'>${escapeXml(text)}</voice></speak>`;
    return new Promise((resolve, reject) => {
      const connId = crypto.randomUUID().replace(/-/g, '');
      const reqId = crypto.randomUUID().replace(/-/g, '');
      const url =
        'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
        `?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connId}`;
      const ws = new WebSocket(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        },
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve({ audio: Buffer.concat(chunks), format: 'mp3' });
      };
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
                },
              },
            },
          })
        );
        ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          // 二进制帧前 2 字节为 header 长度，跳过
          if (buf.length > 2) chunks.push(buf.subarray(2));
        } else if (data.toString().includes('Path:turn.end')) {
          finish();
        }
      });
      ws.on('error', (e) => finish(e));
      ws.on('close', () => finish(new Error('Edge TTS 连接提前关闭')));
    });
  }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string
  );
}

/** TTS 网关：选 provider → 合成 → 落盘，返回本地文件路径（失败不抛，只记 error） */
export class TtsGateway {
  constructor(private cfg: TtsConfig, private outDir: string) {}

  async synthesize(text: string): Promise<TtsResult> {
    const result: TtsResult = { ok: false, filePath: '', format: 'mp3', duration: 0 };
    try {
      const provider: TtsProvider =
        this.cfg.provider === 'edge' ? new EdgeTtsProvider() : new OpenAICompatibleTtsProvider();
      const { audio } = await provider.synthesize(text, this.cfg);
      fs.mkdirSync(this.outDir, { recursive: true });
      const filePath = path.join(this.outDir, `tts_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.mp3`);
      fs.writeFileSync(filePath, audio);
      result.ok = true;
      result.filePath = filePath;
    } catch (e) {
      result.error = (e as Error).message;
    }
    return result;
  }
}
