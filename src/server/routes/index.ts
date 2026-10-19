import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigService } from '../../services/config.service';
import type { ConnectionService } from '../../services/connection.service';
import type { PersonaService } from '../../services/persona.service';
import type { LogService } from '../../services/log.service';
import type { StatsService } from '../../services/stats.service';
import type { HistoryService } from '../../services/history.service';
import type { UpdateService } from '../../services/update.service';
import type { BanwordRepo } from '../../db/repos';
import type { ConnectorType, GlobalConfig, LogLevel, LogSource } from '../../types';

export interface RouteDeps {
  config: ConfigService;
  connection: ConnectionService;
  persona: PersonaService;
  log: LogService;
  stats: StatsService;
  history: HistoryService;
  update: UpdateService;
  banword: BanwordRepo;
}

const ok = <T>(data: T) => ({ code: 0, data, message: 'ok' });
const fail = (code: number, message: string) => ({ code, data: null, message });

type Q = Record<string, string | undefined>;

function qid(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  // ---------------- health ----------------
  app.get('/api/health', async () => ok({ status: 'up', version: d.update.currentVersion() }));

  // ---------------- connections ----------------
  app.get('/api/connections', async () => ok(d.connection.list()));

  app.post('/api/connections', async (req, reply) => {
    try {
      const body = req.body as { name: string; type: ConnectorType };
      return ok(d.connection.create(body));
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });

  app.get('/api/connections/:id', async (req, reply) => {
    const cfg = d.connection.get(qid(req));
    if (!cfg) {
      reply.code(404);
      return fail(404, '连接不存在');
    }
    return ok(cfg);
  });

  app.put('/api/connections/:id', async (req, reply) => {
    try {
      return ok(d.connection.update(qid(req), req.body as never));
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });

  app.delete('/api/connections/:id', async (req, reply) => {
    try {
      await d.connection.remove(qid(req));
      return ok({ ok: true });
    } catch (e) {
      reply.code(409);
      return fail(409, (e as Error).message);
    }
  });

  app.post('/api/connections/start-all', async () => ok(await d.connection.startAll()));
  app.post('/api/connections/stop-all', async () => {
    await d.connection.stopAll();
    return ok({ ok: true });
  });

  app.post('/api/connections/:id/start', async (req, reply) => {
    try {
      const r = await d.connection.start(qid(req));
      return ok(r);
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });

  app.post('/api/connections/:id/stop', async (req) => ok(await d.connection.stop(qid(req))));
  app.post('/api/connections/:id/test', async (req) => ok(d.connection.test(qid(req))));
  app.get('/api/connections/:id/status', async (req) => ok(d.connection.status(qid(req))));
  app.get('/api/connections/:id/precheck', async (req) => ok(d.connection.precheck(qid(req))));

  // ---------------- config ----------------
  app.get('/api/config', async () => ok(maskConfig(d.config.load())));

  app.put('/api/config', async (req, reply) => {
    try {
      const cfg = req.body as GlobalConfig;
      const errors = d.config.validate(cfg);
      if (errors.length) {
        reply.code(400);
        return fail(400, errors.join('；'));
      }
      d.config.save(cfg);
      return ok(maskConfig(d.config.load()));
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });

  app.post('/api/config/test-llm', async (req) => {
    const body = req.body as { baseUrl: string; apiKey: string; model: string; temperature?: number; maxTokens?: number };
    return ok(await d.config.testLlm({ ...body, temperature: body.temperature ?? 0.8, maxTokens: body.maxTokens ?? 512 }));
  });

  app.get('/api/config/export', async (_req, reply) => {
    reply.type('application/json').header('Content-Disposition', 'attachment; filename="qqaichatbot-config.json"');
    return JSON.stringify(maskConfig(d.config.load()), null, 2);
  });

  app.post('/api/config/import', async (req, reply) => {
    try {
      const cfg = req.body as GlobalConfig;
      const errors = d.config.validate(cfg);
      if (errors.length) {
        reply.code(400);
        return fail(400, errors.join('；'));
      }
      d.config.save(cfg);
      return ok(maskConfig(d.config.load()));
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });

  // ---------------- persona ----------------
  app.get('/api/persona', async () => ok(d.persona.list()));
  app.get('/api/persona/help', async (_req, reply) => {
    reply.type('text/markdown; charset=utf-8');
    return d.persona.help();
  });

  app.get('/api/persona/:id', async (req, reply) => {
    const p = d.persona.get(qid(req));
    if (!p) {
      reply.code(404);
      return fail(404, '人格不存在');
    }
    return ok(p);
  });

  app.post('/api/persona/import', async (req, reply) => {
    const body = req.body as { content?: string } | string;
    const content = typeof body === 'string' ? body : body?.content ?? '';
    const r = d.persona.import(content);
    if (!r.ok) {
      reply.code(400);
      return fail(2001, r.error || '导入失败');
    }
    return ok(r);
  });

  app.post('/api/persona/generate', async (req, reply) => {
    try {
      const body = req.body as { description?: string };
      if (!body?.description) {
        reply.code(400);
        return fail(400, '请填写人格描述');
      }
      return ok(await d.persona.generate(body.description));
    } catch (e) {
      reply.code(500);
      return fail(5000, (e as Error).message);
    }
  });

  app.put('/api/persona/:id', async (req, reply) => {
    const r = d.persona.update(qid(req), req.body as never);
    if (!r.ok) {
      reply.code(400);
      return fail(2001, r.error || '更新失败');
    }
    return ok({ ok: true });
  });

  app.delete('/api/persona/:id', async (req, reply) => {
    const r = d.persona.remove(qid(req));
    if (!r.ok) {
      reply.code(409);
      return fail(409, r.error || '删除失败');
    }
    return ok({ ok: true });
  });

  // ---------------- banword（全局词库） ----------------
  app.get('/api/banword', async () => ok(d.banword.list()));
  app.post('/api/banword', async (req, reply) => {
    const body = req.body as { word?: string; direction?: string };
    if (!body?.word) {
      reply.code(400);
      return fail(400, '词不能为空');
    }
    d.banword.add(body.word, body.direction || 'both');
    return ok({ ok: true });
  });
  app.delete('/api/banword/:id', async (req) => {
    d.banword.remove(Number((req.params as { id: string }).id));
    return ok({ ok: true });
  });

  // ---------------- logs ----------------
  app.get('/api/logs', async (req) => {
    const q = req.query as Q;
    return ok(
      d.log.query({
        connectionId: q.connectionId,
        level: q.level as LogLevel | undefined,
        source: q.source as LogSource | undefined,
        keyword: q.keyword,
        since: q.since ? Number(q.since) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      })
    );
  });

  app.get('/api/logs/export', async (req, reply) => {
    const q = req.query as Q;
    reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="logs.log"');
    return d.log.export({
      connectionId: q.connectionId,
      level: q.level as LogLevel | undefined,
      source: q.source as LogSource | undefined,
      keyword: q.keyword,
    });
  });

  // ---------------- stats ----------------
  app.get('/api/stats/overview', async (req) => ok(d.stats.overview((req.query as Q).connectionId)));
  app.get('/api/stats/timeseries', async (req) => {
    const q = req.query as Q;
    return ok(d.stats.timeseries(q.connectionId, (q.granularity as 'hour' | 'day') || 'day', Number(q.days || 7)));
  });
  app.get('/api/stats/hourly-tokens', async (req) => ok(d.stats.hourlyTokens((req.query as Q).connectionId)));
  app.get('/api/stats/latency', async (req) => ok(d.stats.latency((req.query as Q).connectionId)));
  app.get('/api/stats/result-dist', async (req) => ok(d.stats.resultDist((req.query as Q).connectionId)));
  app.get('/api/stats/top-objects', async (req) => {
    const q = req.query as Q;
    return ok(d.stats.topObjects(q.connectionId, Number(q.limit || 10)));
  });
  app.get('/api/stats/cost', async (req) => ok(d.stats.cost((req.query as Q).connectionId)));
  app.get('/api/stats/per-connection', async () => ok(d.stats.perConnection()));

  // ---------------- history ----------------
  app.get('/api/history/sessions', async (req) => ok(d.history.sessions((req.query as Q).connectionId)));

  app.get('/api/history/messages', async (req) => {
    const q = req.query as Q;
    return ok(
      d.history.messages({
        connectionId: q.connectionId,
        fromHash: q.fromHash,
        keyword: q.keyword,
        finishReason: q.finishReason,
        page: q.page ? Number(q.page) : 1,
        pageSize: q.pageSize ? Number(q.pageSize) : 50,
      })
    );
  });

  app.get('/api/history/export', async (req, reply) => {
    const q = req.query as Q;
    const format = q.format === 'json' ? 'json' : 'csv';
    const content = d.history.export(
      {
        connectionId: q.connectionId,
        fromHash: q.fromHash,
        keyword: q.keyword,
        finishReason: q.finishReason,
      },
      format
    );
    reply
      .type(format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="history.${format}"`);
    return content;
  });

  app.delete('/api/history/object/:hash', async (req) => {
    const q = req.query as Q;
    if (!q.connectionId) return fail(400, '缺少 connectionId');
    d.history.removeByObject(q.connectionId, (req.params as { hash: string }).hash);
    return ok({ ok: true });
  });

  // ---------------- update ----------------
  app.get('/api/update/check', async () => {
    const info = await d.update.check();
    return ok({ current: d.update.currentVersion(), latest: info });
  });

  app.post('/api/update/download', async (_req, reply) => {
    try {
      return ok(await d.update.download());
    } catch (e) {
      reply.code(400);
      return fail(400, (e as Error).message);
    }
  });
}

/** 全局配置脱敏：密钥字段置空，避免前端回显明文 */
function maskConfig(cfg: GlobalConfig): GlobalConfig {
  const c = JSON.parse(JSON.stringify(cfg)) as GlobalConfig;
  c.llm.apiKey = c.llm.apiKey ? '***' : '';
  c.server.accessToken = c.server.accessToken ? '***' : '';
  c.update.pat = c.update.pat ? '***' : '';
  return c;
}
