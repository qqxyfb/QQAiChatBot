/**
 * Electron 入口：拉起服务核心子进程 + 打开原生窗口 + 托盘常驻。
 * 打包后 dist/main.js 位于 asar 内，通过 ELECTRON_RUN_AS_NODE 以 Node 模式运行。
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = process.env.QQAICHATBOT_PORT || '8700';
let serverProcess = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;

function startServer() {
  const entry = path.join(__dirname, '..', 'dist', 'main.js');
  const dataDir = path.join(app.getPath('userData'), 'data');
  serverProcess = spawn(process.execPath, ['--experimental-sqlite', entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      QQAICHATBOT_DATA_DIR: dataDir,
      QQAICHATBOT_PORT: PORT,
    },
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => {
    serverProcess = null;
    if (code && code !== 0) {
      console.error(`[electron] 服务进程退出，code=${code}`);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'QQ AI ChatBot',
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const url = `http://127.0.0.1:${PORT}`;
  let tries = 0;
  const tryLoad = () => {
    mainWindow.loadURL(url).catch(() => {
      tries += 1;
      if (tries < 60) setTimeout(tryLoad, 500);
    });
  };
  tryLoad();

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
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'resources', 'icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
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

app.whenReady().then(() => {
  startServer();
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
