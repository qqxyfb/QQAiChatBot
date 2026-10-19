import type { FastifyInstance } from 'fastify';
import type { LogService } from '../services/log.service';

/** 日志实时推送：/ws/logs，前端按 since 游标续传 */
export function registerWs(app: FastifyInstance, logService: LogService): void {
  app.get('/ws/logs', { websocket: true }, (socket) => {
    const unsubscribe = logService.subscribe((row) => {
      try {
        socket.send(JSON.stringify(row));
      } catch {
        /* 客户端断开 */
      }
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
