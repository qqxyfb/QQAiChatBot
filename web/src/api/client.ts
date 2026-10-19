const BASE = '';

/**
 * 统一请求封装。
 *
 * 注意：只有当请求真的带 body 时才声明 Content-Type。
 * Fastify v5 对「Content-Type: application/json + 空 body」会直接返回
 * 400 FST_ERR_CTP_EMPTY_JSON_BODY（"Body cannot be empty when content-type is set to
 * 'application/json'"），而 /start、/stop、/update/download 这类操作本来就没有 body。
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const init: RequestInit = { ...options };
  if (init.body !== undefined && init.body !== null) {
    init.headers = { 'Content-Type': 'application/json', ...(options?.headers || {}) };
  } else if (options?.headers) {
    init.headers = options.headers;
  }

  const resp = await fetch(BASE + path, init);
  const text = await resp.text();

  let json: { code: number; data: T; message: string } | null = null;
  try {
    json = text ? (JSON.parse(text) as { code: number; data: T; message: string }) : null;
  } catch {
    json = null;
  }

  if (!resp.ok || !json || json.code !== 0) {
    // 非 JSON 响应（代理错误页 / HTML）也要给出可读信息，而不是 SyntaxError
    const detail = json?.message || text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200) || `HTTP ${resp.status}`;
    throw new Error(detail);
  }
  return json.data;
}

function jsonBody(body: unknown): string | undefined {
  return body === undefined ? undefined : JSON.stringify(body);
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: jsonBody(body) }),
  put: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: jsonBody(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
