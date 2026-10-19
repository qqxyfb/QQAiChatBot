import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import { makeAuthHook } from './auth';
import { registerRoutes, type RouteDeps } from './routes';
import { registerWs } from './ws';
import type { LogService } from '../services/log.service';

export interface AppOptions {
  allowLan: boolean;
  accessToken: string;
}

export async function buildApp(deps: RouteDeps, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(fastifyWebsocket);
  app.addHook('onRequest', makeAuthHook(() => opts.accessToken, () => opts.allowLan));

  registerRoutes(app, deps);
  registerWs(app, deps.log);

  const webDist = path.join(process.cwd(), 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        reply.code(404).send({ code: 404, data: null, message: 'Not Found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
