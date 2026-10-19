import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 是否运行在 asar 归档内（Electron 打包后的安装版 / 便携版）。
 * 打包后 __dirname 形如 C:\...\resources\app.asar\dist。
 */
const IN_ASAR = __dirname.toLowerCase().includes('app.asar');

/**
 * 应用根目录：dist/xxx.js 的上一级。
 * 打包后是 app.asar，开发/未打包时是项目根目录。
 *
 * 注意：这里绝不能依赖 process.cwd()。Electron 以子进程方式拉起服务核心时，
 * cwd 取决于用户如何启动（安装版快捷方式 / 便携版双击 / 从其它目录命令行），
 * 可能是 System32、桌面或任意目录；用 cwd 拼 web/dist 会找不到前端产物，
 * 表现为窗口黑屏并显示 Fastify 的 404 JSON。
 */
export function resolveAppRoot(): string {
  const fromEnv = process.env.QQAICHATBOT_APP_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(__dirname, '..');
}

/** 逐个探测候选目录，返回第一个存在者 */
function firstExistingDir(candidates: Array<string | undefined | null>): string | null {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 忽略无权限 / 不存在的候选 */
    }
  }
  return null;
}

/** Electron 主进程注入的 resources 目录（纯 Node 运行时不存在） */
function electronResourcesPath(): string | undefined {
  const p = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return typeof p === 'string' ? p : undefined;
}

/**
 * 前端静态资源目录（vite 构建产物，必须包含 index.html）。
 * 找不到返回 null，由调用方给出可读的诊断信息，而不是静默 404。
 */
export function resolveWebDir(): string | null {
  const explicit = process.env.QQAICHATBOT_WEB_DIR;
  const root = resolveAppRoot();
  const res = electronResourcesPath();
  const candidates = [
    explicit ? path.resolve(explicit) : null, // Electron 主进程注入，最可靠
    path.join(root, 'web', 'dist'), // 开发 / 未打包 / asar 内的常规布局
    res ? path.join(res, 'web') : null, // extraResources 布局
    path.join(process.cwd(), 'web', 'dist'), // 兜底：从项目根目录直接启动
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      /* 忽略无权限 / 不存在的候选 */
    }
  }
  return null;
}

/** 诊断用：列出前端产物的所有候选路径（打包后排查白屏时很有用） */
export function webDirCandidates(): string[] {
  const root = resolveAppRoot();
  const res = electronResourcesPath();
  return [
    process.env.QQAICHATBOT_WEB_DIR ? path.resolve(process.env.QQAICHATBOT_WEB_DIR) : '',
    path.join(root, 'web', 'dist'),
    res ? path.join(res, 'web') : '',
    path.join(process.cwd(), 'web', 'dist'),
  ].filter(Boolean);
}

/** 数据目录：优先 Electron 注入；未打包用项目根 data/；便携版用 exe 同级 data/；安装版用 %APPDATA% */
export function resolveDataDir(): string {
  if (process.env.QQAICHATBOT_DATA_DIR) {
    return path.resolve(process.env.QQAICHATBOT_DATA_DIR);
  }
  const root = resolveAppRoot();
  const isDev = !IN_ASAR && fs.existsSync(path.join(root, 'package.json'));
  if (isDev) return path.join(root, 'data');

  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'portable.marker'))) {
    return path.join(exeDir, 'data');
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), '.qqaichatbot');
  return path.join(appData, 'QQAiChatBot');
}

/** 资源目录（内置人格/帮助文档/图标）：优先 Electron 注入，其次 asar 内 resources/ */
export function resolveResourceDir(): string {
  const explicit = process.env.QQAICHATBOT_RESOURCE_DIR;
  if (explicit) return path.resolve(explicit);

  const root = resolveAppRoot();
  const res = electronResourcesPath();
  const found = firstExistingDir([
    path.join(root, 'resources'),
    res ? path.join(res, 'app', 'resources') : null,
    path.join(path.dirname(process.execPath), 'resources'),
    path.join(process.cwd(), 'resources'),
  ]);
  return found ?? path.join(root, 'resources');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function paths(dataDir: string) {
  return {
    dataDir,
    dbFile: path.join(dataDir, 'client.db'),
    logDir: path.join(dataDir, 'logs'),
    exportDir: path.join(dataDir, 'export'),
    configFile: path.join(dataDir, 'config.json'),
    secretsFile: path.join(dataDir, 'secrets.json'),
  };
}
