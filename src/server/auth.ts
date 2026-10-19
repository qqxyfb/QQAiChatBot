import type { FastifyReply, FastifyRequest } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 外网访问鉴权：allowLan 开启时，非回环请求必须携带 Bearer token */
export function makeAuthHook(getToken: () => string, isLanAllowed: () => boolean) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLanAllowed()) return;
    if (LOOPBACK.has(req.ip)) return;
    if (req.url.startsWith('/api/health')) return;

    const expected = getToken();
    if (!expected) {
      reply.code(401).send({ code: 401, data: null, message: '外网访问未配置访问令牌' });
      return;
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== expected) {
      reply.code(401).send({ code: 401, data: null, message: '未授权' });
    }
  };
}
