import type { LlmConfig, LogLevel, MetricEvent } from '../types';

export interface LlmResult {
  ok: boolean;
  stub: boolean;
  text: string;
  promptTokens: number;
  completionTokens: number;
  attempts: number;
  elapsedMs: number;
  error?: string;
}

/** LLM 网关：OpenAI 兼容 /chat/completions，含重试、超时、token 统计、打点 */
export class LlmGateway {
  constructor(
    private cfg: LlmConfig,
    private connectionId: string,
    private sessionId: number | null,
    private emit: (e: MetricEvent) => void
  ) {}

  /** 供链路日志展示当前模型名 */
  get model(): string {
    return this.cfg.model;
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    this.emit({ kind: 'log', connectionId: this.connectionId, level, source: 'llm', msg, meta });
  }

  private normalizeUrl(): string {
    let base = (this.cfg.baseUrl || '').trim();
    if (!base) return '';
    if (base.toLowerCase().endsWith('/chat/completions')) {
      base = base.slice(0, -'/chat/completions'.length);
    }
    return base.replace(/\/+$/, '') + '/chat/completions';
  }

  async complete(prompt: string): Promise<LlmResult> {
    const t0 = Date.now();
    const result: LlmResult = {
      ok: false,
      stub: false,
      text: '',
      promptTokens: 0,
      completionTokens: 0,
      attempts: 0,
      elapsedMs: 0,
    };

    if (!this.cfg.apiKey) {
      result.ok = true;
      result.stub = true;
      result.text = `（演示模式·未配置 LLM API Key）我收到你的消息了。`;
      result.elapsedMs = Date.now() - t0;
      this.report(result, 'ok');
      return result;
    }

    const url = this.normalizeUrl();
    const body = JSON.stringify({
      model: this.cfg.model,
      temperature: this.cfg.temperature ?? 0.8,
      max_tokens: this.cfg.maxTokens ?? 512,
      messages: [{ role: 'user', content: prompt }],
    });

    let lastStatus = 0;
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      result.attempts = attempt + 1;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(20000),
        });
        lastStatus = resp.status;
        const text = await resp.text();
        if (resp.status === 200) {
          const j = JSON.parse(text) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          result.ok = true;
          result.text = j.choices?.[0]?.message?.content ?? '';
          result.promptTokens = j.usage?.prompt_tokens ?? 0;
          result.completionTokens = j.usage?.completion_tokens ?? 0;
          result.elapsedMs = Date.now() - t0;
          this.report(result, 'ok');
          return result;
        }
        lastError = `HTTP ${resp.status} ${text.slice(0, 200)}`;
        if (resp.status < 500) break; // 4xx 不重试
      } catch (e) {
        lastStatus = -1;
        lastError = (e as Error).message;
      }
      if (attempt < 2) {
        this.log('WARN', `LLM 请求失败（第 ${attempt + 1} 次）：${lastError}，${800 * (attempt + 1)}ms 后重试`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }

    result.ok = false;
    result.text = '（我现在有点忙，请稍后再试）';
    result.error = lastError;
    result.elapsedMs = Date.now() - t0;
    this.report(result, lastStatus === -1 ? 'timeout' : lastStatus >= 500 ? '5xx' : 'error');
    return result;
  }

  private report(r: LlmResult, status: 'ok' | '5xx' | 'timeout' | 'error'): void {
    this.emit({
      kind: 'llm_call',
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      model: this.cfg.model,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      latencyMs: r.elapsedMs,
      status,
      retryCnt: Math.max(0, r.attempts - 1),
      error: r.error,
    });
    // 失败信息同步进运行日志：原来只落 llm_call 表，用户在前端看不到任何线索
    if (status !== 'ok') {
      this.log(
        'ERROR',
        `LLM 调用失败（model=${this.cfg.model}，${r.attempts} 次尝试，${r.elapsedMs}ms）：${r.error ?? status}`
      );
    }
  }
}
