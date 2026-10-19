/**
 * Electron 入口：拉起服务核心子进程 + 打开原生窗口 + 托盘常驻。
 * 打包后 dist/main.js 位于 asar 内，通过 ELECTRON_RUN_AS_NODE 以 Node 模式运行。
 *
 * 启动顺序很关键：先起服务 → 探测 /api/health → 再加载界面。
 * 旧实现直接 loadURL，服务刚监听但静态资源未就绪时会拿到 Fastify 的 404 JSON，
 * 而 loadURL 对 404 也算“成功”，于是窗口停在黑屏 + JSON 上。
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 打包后 __dirname = <install>/resources/app.asar/electron
const APP_ROOT = path.join(__dirname, '..');
const WEB_DIST = path.join(APP_ROOT, 'web', 'dist');
const RESOURCE_DIR = path.join(APP_ROOT, 'resources');
const BASE_PORT = Number(process.env.QQAICHATBOT_PORT) || 8700;

let serverProcess = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let port = BASE_PORT;
let serverExitInfo = null;
let booted = false;

/** 服务进程输出环形缓冲：启动失败时直接展示在窗口里，便于用户反馈 */
const logRing = [];
function pushLog(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) logRing.push(line);
  }
  if (logRing.length > 200) logRing.splice(0, logRing.length - 200);
}

/**
 * 桌面端启动日志（%APPDATA%/QQAiChatBot/electron.log）。
 * 打包后没有控制台，出问题时这是唯一的现场；只记启动关键节点，不记业务数据。
 */
function trace(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'electron.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 日志失败不影响运行 */
  }
}

function toDataUrl(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---------------------------------------------------------------- 端口 / 服务

function probePort(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '127.0.0.1');
  });
}

/** 默认端口被占用时（例如同时开着开发服务器）自动向后寻找，避免服务进程启动即崩溃 */
async function pickPort(start) {
  for (let i = 0; i < 20; i += 1) {
    const p = start + i;
    // eslint-disable-next-line no-await-in-loop
    if (await probePort(p)) return p;
  }
  return start;
}

function startServer(p) {
  const entry = path.join(APP_ROOT, 'dist', 'main.js');
  const dataDir = path.join(app.getPath('userData'), 'data');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    QQAICHATBOT_DATA_DIR: dataDir,
    QQAICHATBOT_PORT: String(p),
    // 显式下发目录，服务端不再依赖 process.cwd()（打包后 cwd 不可控）
    QQAICHATBOT_APP_ROOT: APP_ROOT,
    QQAICHATBOT_WEB_DIR: WEB_DIST,
    QQAICHATBOT_RESOURCE_DIR: RESOURCE_DIR,
  };
  if (!fs.existsSync(entry)) {
    pushLog(`[electron] 缺少服务入口：${entry}`);
    trace(`缺少服务入口：${entry}`);
    serverExitInfo = { code: -1, signal: null };
    return;
  }

  serverProcess = spawn(process.execPath, ['--experimental-sqlite', entry], {
    cwd: app.getPath('userData'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trace(`spawn server pid=${serverProcess.pid} port=${p} entry=${entry}`);

  serverProcess.stdout.on('data', pushLog);
  serverProcess.stderr.on('data', pushLog);
  serverProcess.on('error', (err) => {
    pushLog(`[electron] 服务进程启动失败：${err.message}`);
    serverExitInfo = { code: -1, signal: null };
  });
  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    serverExitInfo = { code, signal };
    pushLog(`[electron] 服务进程退出 code=${code} signal=${signal}`);
    trace(`server exit code=${code} signal=${signal} booted=${booted}`);
    if (!isQuitting && booted) showBootError().catch(() => undefined);
  });
}

function healthOnce(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/health', timeout: 1200 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await healthOnce(p)) return true;
    if (serverExitInfo) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------- 窗口 / 页面

const LOADING_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>QQ AI ChatBot</title>
<style>
  html,body{margin:0;height:100%;background:#141414;color:#d9d9d9;
    font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .dot{width:10px;height:10px;border-radius:50%;background:#1677ff;margin:0 auto 18px;
    animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
  .sub{color:#8c8c8c;font-size:12.5px;margin-top:6px}
</style></head>
<body><div class="box"><div class="dot"></div><div>正在启动服务…</div>
<div class="sub">首次启动需要初始化数据库，请稍候</div></div></body></html>`;

function errorPage() {
  const tail = logRing.slice(-40).join('\n') || '(服务进程无输出)';
  const dataDir = path.join(app.getPath('userData'), 'data');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>QQ AI ChatBot · 启动失败</title>
<style>
  html,body{margin:0;height:100%;background:#141414;color:#e6e6e6;
    font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:820px;margin:0 auto;padding:48px 24px}
  h1{font-size:19px;margin:0 0 6px}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;background:#3b1d1d;color:#ff7875;font-size:12px}
  p{color:#bfbfbf;margin:10px 0}
  pre{background:#1b1b1b;border:1px solid #303030;border-radius:6px;padding:12px;
    max-height:300px;overflow:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
  a.btn{display:inline-block;margin-top:8px;padding:6px 16px;border-radius:6px;background:#1677ff;
    color:#fff;text-decoration:none;font-size:13px}
  code{background:#1f1f1f;border:1px solid #303030;border-radius:4px;padding:1px 5px;font-size:12.5px}
  .kv{color:#8c8c8c;font-size:12.5px}
</style></head>
<body><div class="wrap">
  <div class="tag">启动失败</div>
  <h1>服务核心未能就绪</h1>
  <p>桌面端已等待约 40 秒仍未收到 <code>/api/health</code> 的响应。下面是服务进程的输出：</p>
  <pre>${escapeHtml(tail)}</pre>
  <p class="kv">端口：127.0.0.1:${port} · 数据目录：<code>${escapeHtml(dataDir)}</code></p>
  <p>常见原因：端口被占用、程序目录缺少文件（未完整解压 / 杀毒软件拦截）、数据库文件损坏。</p>
  <a class="btn" href="http://127.0.0.1:${port}/">重试连接</a>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'QQ AI ChatBot',
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  mainWindow.loadURL(toDataUrl(LOADING_HTML));

  // 关闭窗口 → 最小化到托盘（托盘创建失败时直接退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function loadApp() {
  if (!mainWindow) return;
  try {
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    booted = true;
    trace(`界面已加载 http://127.0.0.1:${port}/`);
  } catch (err) {
    pushLog(`[electron] 加载界面失败：${err.message}`);
    trace(`loadURL 失败：${err.message}`);
    await showBootError();
  }
}

async function showBootError() {
  if (!mainWindow) return;
  trace('显示启动失败页');
  try {
    await mainWindow.loadURL(toDataUrl(errorPage()));
    if (!mainWindow.isVisible()) mainWindow.show();
  } catch {
    /* 窗口已销毁 */
  }
}

function createTray() {
  try {
    const preferred = path.join(RESOURCE_DIR, 'icon.png');
    const fallback = path.join(RESOURCE_DIR, 'tray.png');
    let icon = nativeImage.createFromPath(fs.existsSync(preferred) ? preferred : fallback);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(fallback);
    if (icon.isEmpty()) {
      tray = null;
      return;
    }
    tray = new Tray(icon);
    tray.setToolTip('QQ AI ChatBot');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示窗口',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        {
          label: '退出',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    console.warn('[electron] 托盘创建失败，关闭窗口将直接退出：', e.message);
    tray = null;
  }
}

// ---------------------------------------------------------------- 生命周期

async function boot() {
  createTray();
  trace(`boot 开始 appRoot=${APP_ROOT} webDir=${WEB_DIST} webExists=${fs.existsSync(WEB_DIST)}`);
  port = await pickPort(BASE_PORT);
  startServer(port);
  createWindow();

  const ready = await waitForHealth(port, 40000);
  trace(`health ready=${ready} port=${port}`);
  if (ready) {
    await loadApp();
    return;
  }
  pushLog(
    serverExitInfo
      ? '[electron] 服务进程已退出，无法连接'
      : '[electron] 等待 /api/health 超时（40s）'
  );
  await showBootError();
}

// 单实例：避免两次启动争抢同一端口 / 重复托盘图标
if (!app.requestSingleInstanceLock()) {
  trace('单实例锁被占用，退出本次启动');
  app.quit();
} else {
  trace('单实例锁获取成功');
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch((e) => {
    pushLog(`[electron] 启动异常：${e && e.message}`);
    trace(`boot 异常：${e && e.stack}`);
    showBootError().catch(() => undefined);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    trace('window-all-closed');
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    trace('before-quit，结束服务进程');
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });
}
