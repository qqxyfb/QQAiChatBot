import crypto from 'node:crypto';

/** sha256 前 12 位短哈希，用于 openid / QQ 号脱敏 */
export function shortHash(s: string | undefined | null): string {
  if (!s) return '';
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

const SECRET_KEYS = new Set(['apiKey', 'appSecret', 'accessToken', 'botToken', 'pat', 'password']);

/** 配置快照脱敏：密钥类替换 ***，其余保留 */
export function redact<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map((v) => redact(v)) as unknown as T;
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k) && typeof v === 'string' && v) out[k] = '***';
      else out[k] = redact(v);
    }
    return out as T;
  }
  return obj;
}
