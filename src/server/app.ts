import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { makeAuthHook } from './auth';
import { registerRoutes, type RouteDeps } from './routes';
import { registerWs } from './ws';
import { resolveWebDir, webDirCandidates } from '../config';

export interface AppOptions {
  allowLan: boolean;
  accessToken: string;
}

/**
 * Fastify 应用：API + WebSocket + 前端静态资源。
 *
 * 前端目录必须与进程 cwd 解耦（见 config.resolveWebDir）：
 * 打包后 cwd 可能是用户目录、桌面甚至 System32，用 cwd 拼 web/dist 会找不到产物，
 * 结果是窗口黑屏 + `{"message":"Route GET:/ not found",...}`。
 */
export async function buildApp(deps: RouteDeps, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  const webDist = resolveWebDir();

  await app.register(fastifyWebsocket);
  app.addHook('onRequest', makeAuthHook(() => opts.accessToken, () => opts.allowLan));

  registerRoutes(app, { ...deps, webReady: () => webDist !== null });
  registerWs(app, deps.log);

  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        // index.html 不能长缓存，否则升级后仍加载旧入口
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    });
    deps.log.info('server', `前端静态资源目录：${webDist}`);
  } else {
    deps.log.error(
      'server',
      `未找到前端产物（web/dist/index.html），候选路径：${webDirCandidates().join(' | ')}`
    );
  }

  // SPA 兜底：非 API/WS 的 GET 一律回 index.html；产物缺失时给可读的诊断页，而不是裸 404 JSON
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.code(404).send({ code: 404, data: null, message: 'Not Found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply.code(404).send({ code: 404, data: null, message: 'Not Found' });
      return;
    }
    if (!webDist) {
      reply.code(503).type('text/html; charset=utf-8').send(missingWebPage());
      return;
    }
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache');
    // resolveWebDir 已确认 index.html 存在
    reply.sendFile('index.html', webDist, { maxAge: 0 });
  });

  return app;
}

/** 前端产物缺失时的诊断页：说清楚缺什么、去哪儿找、怎么修 */
function missingWebPage(): string {
  const candidates = webDirCandidates()
    .map((p) => `<li><code>${escapeHtml(p)}</code></li>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>QQ AI ChatBot · 前端资源缺失</title>
<style>
  html,body{margin:0;height:100%;background:#141414;color:#e6e6e6;
    font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:56px 24px}
  h1{font-size:20px;margin:0 0 16px}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;background:#3b1d1d;color:#ff7875;font-size:12px;margin-bottom:12px}
  code{background:#1f1f1f;border:1px solid #303030;border-radius:4px;padding:1px 5px;font-size:12.5px;word-break:break-all}
  ul{padding-left:20px;margin:8px 0 20px}
  li{margin:4px 0}
  p{margin:10px 0;color:#bfbfbf}
  .kv{color:#8c8c8c}
</style>
</head>
<body>
<div class="wrap">
  <div class="tag">503 · 服务已启动，但前端未加载</div>
  <h1>找不到前端构建产物 web/dist/index.html</h1>
  <p>后端 API 正常，仅静态资源缺失。已尝试以下路径：</p>
  <ul>${candidates}</ul>
  <p>排查建议：</p>
  <p>1）开发/源码运行：执行 <code>npm run build:web</code> 后再启动。</p>
  <p>2）安装包：重新执行 <code>npm run pack</code>，并用 <code>node scripts/verify-asar.cjs &lt;app.asar&gt;</code> 确认
     <code>/web/dist/index.html</code> 已打进包内。</p>
  <p>3）便携版：确认压缩包已完整解压，且未修改包内目录结构。</p>
  <p class="kv">数据目录：${escapeHtml(process.env.QQAICHATBOT_DATA_DIR || '(未指定)')} ·
     工作目录：${escapeHtml(process.cwd())} ·
     程序目录：<code>${escapeHtml(__dirname)}</code></p>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}
