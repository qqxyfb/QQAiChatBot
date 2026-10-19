import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * 出站 HTTP 封装：直连失败时按需回退到环境变量里的代理。
 *
 * Node 原生 fetch（undici）不会读取 HTTPS_PROXY，所以「受限网络 + 已开代理」的用户
 * 在检查更新时会直接拿到 `fetch failed`。这里采用「先直连、失败再走代理」的策略：
 * 直连能通的环境行为完全不变，只有直连失败时才用代理重试一次。
 */

let cache: { proxy: string; dispatcher: Dispatcher } | null = null;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（大小写都认） */
export function envProxy(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const raw of candidates) {
    const v = raw?.trim();
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

function proxyDispatcher(proxy: string): Dispatcher | undefined {
  if (cache?.proxy === proxy) return cache.dispatcher;
  try {
    const dispatcher = new ProxyAgent(proxy);
    cache = { proxy, dispatcher };
    return dispatcher;
  } catch {
    return undefined;
  }
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** 发起请求：直连优先，失败且存在代理时再走代理 */
export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { method, headers, body, timeoutMs = 30000 } = opts;
  const init: RequestInit = { method, headers, body, signal: timeoutSignal(timeoutMs) };

  let directError: unknown = null;
  try {
    return await fetch(url, init);
  } catch (err) {
    directError = err;
  }

  const proxy = envProxy();
  const dispatcher = proxy ? proxyDispatcher(proxy) : undefined;
  if (!proxy || !dispatcher) throw directError;

  try {
    return (await undiciFetch(url, {
      method,
      headers,
      body,
      signal: timeoutSignal(timeoutMs),
      dispatcher,
    } as never)) as unknown as Response;
  } catch (proxyError) {
    const e = new Error(
      `直连失败（${describeError(directError)}），经代理 ${proxy} 也失败（${describeError(proxyError)}）`
    );
    throw e;
  }
}

/** 把 fetch 的嵌套错误压成一句人话 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const code = e?.cause?.code || e?.code || '';
  const msg = e?.cause?.message || e?.message || '未知错误';
  return code ? `${code}: ${msg}` : msg;
}

/** 网络类错误才提示代理，业务错误保持原样 */
export function isNetworkError(err: unknown): boolean {
  const text = describeError(err);
  return /UND_ERR|CONNECT_TIMEOUT|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|aborted due to timeout|TimeoutError|operation was aborted/i.test(
    text
  );
}

/** 超时单独识别：多数情况下是网络被限速，提示用户手动下载更实际 */
export function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError' ||
    /aborted due to timeout|TimeoutError|operation was aborted/i.test(e?.message || '')
  );
}

export function networkHint(err: unknown): string {
  const base = describeError(err);
  if (!isNetworkError(err)) return base;
  return `${base}（网络无法访问 GitHub：请检查网络，或在受限网络下设置 HTTPS_PROXY 后重启应用）`;
}
