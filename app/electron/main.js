/* Bridge — Electron host.
 *
 * On launch this process:
 *   1. Boots the Node Express server (app/server/server.js) inline by
 *      requiring it. The server listens on PORT (default 4317).
 *   2. Optionally spawns the local Parakeet STT service if the user
 *      has installed it at app/stt/.venv/. Failure is non-fatal —
 *      Bridge still works with the browser's webkitSpeechRecognition.
 *   3. Opens a BrowserWindow pointing at http://127.0.0.1:<PORT>/.
 *
 * Quitting the app cleans up the spawned child processes.
 */

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 4317);
const STT_PORT = Number(process.env.PARAKEET_PORT || 8123);

let serverModule = null;
let sttChild = null;
let mainWin = null;

function isDev() { return !app.isPackaged; }

function resolveBundled(rel) {
  // In dev: relative to the repo root.
  // Packaged: resources/<rel>.
  if (isDev()) return path.resolve(__dirname, '..', '..', rel);
  return path.join(process.resourcesPath, rel);
}

async function startServer() {
  // Boot the Express server in-process. It registers routes against
  // its own express() instance and calls app.listen on PORT.
  const serverPath = isDev()
    ? path.resolve(__dirname, '..', 'server', 'server.js')
    : path.join(process.resourcesPath, 'app.asar', 'app', 'server', 'server.js');
  process.env.PORT = String(PORT);
  // require() will execute server.js — its top-level app.listen runs.
  serverModule = require(serverPath);
}

function startSttIfAvailable() {
  // Look for an installed venv at app/stt/.venv/. If present, spawn
  // parakeet_server.py. Anyone who hasn't run the one-time install
  // just keeps using webkitSpeechRecognition.
  const sttDir = isDev()
    ? path.resolve(__dirname, '..', 'stt')
    : path.join(process.resourcesPath, 'stt');
  const venvPython = path.join(sttDir, '.venv', 'bin', 'python');
  const script     = path.join(sttDir, 'parakeet_server.py');
  if (!fs.existsSync(venvPython) || !fs.existsSync(script)) {
    console.log('[bridge] parakeet venv not found — skipping local STT spawn');
    return;
  }
  console.log('[bridge] launching parakeet at', script);
  sttChild = spawn(venvPython, [script], {
    cwd: sttDir,
    env: { ...process.env, PARAKEET_PORT: String(STT_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sttChild.stdout.on('data', (d) => process.stdout.write(`[parakeet] ${d}`));
  sttChild.stderr.on('data', (d) => process.stderr.write(`[parakeet] ${d}`));
  sttChild.on('exit', (code) => {
    console.log('[bridge] parakeet exited code', code);
    sttChild = null;
  });
}

function killStt() {
  if (sttChild && !sttChild.killed) {
    try { sttChild.kill('SIGTERM'); } catch {}
    sttChild = null;
  }
}

async function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    title: 'Bridge',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Open external links in the user's default browser, not inside
  // the Electron window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  // Wait briefly for the server to finish setup, then load.
  await new Promise(r => setTimeout(r, 250));
  await mainWin.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWin.on('closed', () => { mainWin = null; });
}

// Single-instance lock so launching twice surfaces the existing window
// instead of starting another server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

app.whenReady().then(async () => {
  // Minimal app menu (Quit / DevTools).
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: isMac ? 'Bridge' : '&File',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
  ]));

  await startServer();
  startSttIfAvailable();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', killStt);
process.on('exit', killStt);
