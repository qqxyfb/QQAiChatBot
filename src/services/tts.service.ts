import type { Segment, TtsConfig } from '../types';
import { TtsGateway } from '../tts/gateway';

/** 常用中文音色（供前端下拉参考；用户也可手动输入任意音色名） */
const BUILTIN_VOICES: Array<{ id: string; name: string }> = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男声）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男声）' },
  { id: 'zh-CN-XiaoxiaoMultilingualNeural', name: '晓晓多语（女声）' },
];

export class TtsService {
  constructor(private outDir: string) {}

  listVoices(): Array<{ id: string; name: string }> {
    return BUILTIN_VOICES;
  }

  /** 合成为语音段；失败返回 null（调用方降级为纯文字，不阻塞回复） */
  async synthesizeToSegment(text: string, cfg: TtsConfig): Promise<Segment | null> {
    const r = await new TtsGateway(cfg, this.outDir).synthesize(text);
    if (!r.ok) return null;
    return { type: 'voice', path: r.filePath, duration: r.duration };
  }

  /** 试听/连通性测试 */
  async test(cfg: TtsConfig): Promise<{ ok: boolean; message: string }> {
    const r = await new TtsGateway(cfg, this.outDir).synthesize('你好，这是一条语音测试。');
    if (!r.ok) return { ok: false, message: r.error ?? '生成失败' };
    return { ok: true, message: '语音生成成功' };
  }
}
