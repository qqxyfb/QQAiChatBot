import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 数据目录：开发模式用项目根 data/；打包后安装版用 %APPDATA%/QQAiChatBot，便携版用 exe 同级 data/ */
export function resolveDataDir(): string {
  if (process.env.QQAICHATBOT_DATA_DIR) {
    return path.resolve(process.env.QQAICHATBOT_DATA_DIR);
  }
  const isDev = fs.existsSync(path.join(process.cwd(), 'package.json'));
  if (isDev) return path.join(process.cwd(), 'data');

  const portable = path.join(path.dirname(process.execPath), 'data');
  if (fs.existsSync(path.join(path.dirname(process.execPath), 'portable.marker'))) {
    return portable;
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), '.qqaichatbot');
  return path.join(appData, 'QQAiChatBot');
}

/** 资源目录（内置人格/帮助文档/图标）：开发模式项目 resources/；打包后 exe 同级 resources/ */
export function resolveResourceDir(): string {
  const dev = path.join(process.cwd(), 'resources');
  if (fs.existsSync(dev)) return dev;
  return path.join(path.dirname(process.execPath), 'resources');
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
