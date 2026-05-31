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

const { app, BrowserWindow, shell, Menu, Notification, session, systemPreferences } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const { spawn } = require('node:child_process');
const { ensureStt } = require('./setup-stt');

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
  //
  // server.js is an ES module ("type":"module"), so it MUST be loaded with
  // dynamic import() — require() throws ERR_REQUIRE_ESM, which previously left
  // the server unstarted and the window blank (black screen). It's unpacked
  // from the asar (see build.asarUnpack) so its relative imports + bundled
  // express resolve on disk.
  // server.js always sits next to main.js at ../server/server.js — true in dev
  // and in the packaged app (asar disabled), so one path covers both.
  const serverPath = path.resolve(__dirname, '..', 'server', 'server.js');
  process.env.PORT = String(PORT);
  const { pathToFileURL } = require('node:url');
  serverModule = await import(pathToFileURL(serverPath).href);

  // Don't return until the server is actually accepting connections, so the
  // window never loads a dead port.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  console.error('[bridge] server did not become healthy on port', PORT);
}

/* Cheap synchronous check for whether local STT can run — used to
 * decide if LOCAL_STT_URL should be auto-defaulted before the window
 * loads. Dev: app/stt/.venv. Packaged: bundled python (+ either
 * bundled stt-packages or a previously-installed user-data set). */
function sttIsAvailable() {
  if (isDev()) {
    return fs.existsSync(path.resolve(__dirname, '..', 'stt', '.venv', 'bin', 'python'));
  }
  return fs.existsSync(path.join(process.resourcesPath, 'python', 'bin', 'python3'))
      && fs.existsSync(path.join(process.resourcesPath, 'stt', 'parakeet_server.py'));
}

/* Boots the local Parakeet STT service.
 *
 * Two paths:
 *   - Packaged app: uses the bundled python-build-standalone Python
 *     under resourcesPath/python/. The first launch pip-installs the
 *     deps into userData/stt-packages/, subsequent launches skip
 *     straight to spawning. We notify the user once via the OS
 *     notification center when setup finishes.
 *   - Dev mode: still honors the legacy app/stt/.venv/ workflow so
 *     `npm run dev` works without a packaged Python.
 */
async function startSttIfAvailable() {
  // Dev mode: keep the legacy venv path so developers can iterate
  // without building the embedded Python.
  if (isDev()) {
    const sttDir = path.resolve(__dirname, '..', 'stt');
    const venvPython = path.join(sttDir, '.venv', 'bin', 'python');
    const script     = path.join(sttDir, 'parakeet_server.py');
    if (!fs.existsSync(venvPython) || !fs.existsSync(script)) {
      console.log('[bridge] dev: parakeet venv not found at app/stt/.venv — skipping');
      return;
    }
    return spawnParakeet({ cmd: venvPython, args: [script], cwd: sttDir });
  }

  // Packaged: bundled Python + first-run pip install into userData.
  try {
    const userDataDir = app.getPath('userData');
    const result = await ensureStt({
      resourcesPath: process.resourcesPath,
      userDataDir,
      log: (line) => process.stdout.write(typeof line === 'string' ? line : String(line)),
    });
    if (!result) return; // bundled python not present
    // Detect Option-A "first run pip install just happened" so we can
    // fire a one-time notification. Option-B bundled builds skip the
    // marker entirely since deps are already in Resources.
    const markerPath = path.join(result.pythonPath, 'stt-packages.ready');
    const isBundled = result.pythonPath.startsWith(process.resourcesPath);
    const setupTriggered = !isBundled && !fs.existsSync(markerPath);
    spawnParakeet({
      cmd: result.python,
      args: [result.script],
      cwd: path.join(process.resourcesPath, 'stt'),
      env: { ...(result.env || {}), PARAKEET_PORT: String(STT_PORT) },
    });
    if (setupTriggered && Notification.isSupported()) {
      new Notification({
        title: 'Bridge — Local STT ready',
        body: 'Parakeet is set up and running locally.',
      }).show();
    }
  } catch (err) {
    console.warn('[bridge] STT setup failed:', err.message);
  }
}

function spawnParakeet({ cmd, args, cwd, env = {} }) {
  console.log('[bridge] launching parakeet at', args[0]);
  sttChild = spawn(cmd, args, {
    cwd,
    env: { ...process.env, PARAKEET_PORT: String(STT_PORT), ...env },
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

  // Grant microphone (and general media) permission requests from the
  // renderer — Electron denies these by default, which silently breaks
  // getUserMedia / MediaRecorder. The macOS-level prompt still appears
  // the first time (gated by NSMicrophoneUsageDescription in Info.plist).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture' || permission === 'microphone');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'media' || permission === 'audioCapture' || permission === 'microphone');
  // Proactively trigger the macOS mic-access prompt so the user grants
  // it up front rather than on first PTT.
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }

  await startServer();
  // Default LOCAL_STT_URL to the bundled Parakeet endpoint *before*
  // the window loads, so the renderer routes voice through it instead
  // of the browser's webkitSpeechRecognition (which is a no-op inside
  // Electron — no Google speech API key is shipped). Only set it when
  // STT is actually available and the user hasn't overridden it.
  if (sttIsAvailable() && !process.env.LOCAL_STT_URL) {
    process.env.LOCAL_STT_URL = `http://127.0.0.1:${STT_PORT}/transcribe`;
    console.log('[bridge] defaulting LOCAL_STT_URL to', process.env.LOCAL_STT_URL);
  }
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
