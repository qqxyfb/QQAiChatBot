/**
 * 回归验证：确认服务端托管前端的路径解析不依赖进程 cwd。
 *
 * 打包后 Electron 以子进程拉起服务核心，cwd 不可控（可能是 System32 / 用户目录）。
 * 本脚本故意从一个临时目录启动 dist/main.js，断言：
 *   GET /            → 200 text/html（不是 Fastify 的 404 JSON）
 *   GET /config      → 200 text/html（SPA 深层链接回落 index.html）
 *   GET /api/health  → web=true
 *   GET /api/unknown → 404 JSON
 *
 * 用法：npm run build && node scripts/verify-web-serve.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 8891);

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    req.on('error', () => resolve({ status: 0, type: '', body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, type: '', body: '' });
    });
  });
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const r = await get('/api/health');
    if (r.status === 200) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return false;
}

(async () => {
  const entry = path.join(root, 'dist', 'main.js');
  if (!fs.existsSync(entry)) {
    console.error('缺少 dist/main.js，请先执行 npm run build');
    process.exit(2);
  }

  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qqab-cwd-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqab-data-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', entry], {
    cwd: tmpCwd, // 关键：故意使用与项目无关的工作目录
    env: { ...process.env, QQAICHATBOT_DATA_DIR: dataDir, QQAICHATBOT_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));

  const failures = [];
  try {
    if (!(await waitReady(30000))) failures.push('服务未在 30s 内就绪');
    else {
      const home = await get('/');
      if (home.status !== 200 || !home.type.includes('text/html')) {
        failures.push(`GET / 期望 200 text/html，实际 ${home.status} ${home.type} ${home.body.slice(0, 120)}`);
      }
      const deep = await get('/config');
      if (deep.status !== 200 || !deep.type.includes('text/html')) {
        failures.push(`GET /config 期望 200 text/html，实际 ${deep.status} ${deep.type}`);
      }
      const health = await get('/api/health');
      if (!health.body.includes('"web":true')) failures.push(`/api/health 未报告前端就绪：${health.body}`);
      const unknown = await get('/api/unknown');
      if (unknown.status !== 404) failures.push(`GET /api/unknown 期望 404，实际 ${unknown.status}`);
    }
  } finally {
    child.kill();
  }

  if (stderr.includes('[fatal]')) console.error('服务端错误输出：\n' + stderr);
  if (failures.length) {
    console.error('验证失败：\n- ' + failures.join('\n- '));
    process.exit(1);
  }
  console.log('验证通过：cwd 无关的前端托管正常（/ 与 SPA 深层链接均返回 index.html）');
  process.exit(0);
})();
