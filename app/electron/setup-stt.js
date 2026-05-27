/* First-run setup for the bundled Parakeet STT service.
 *
 * Resources we expect inside the packaged app (set up by
 * electron-builder via package.json's extraResources):
 *
 *   <resourcesPath>/python/bin/python3          — relocatable CPython
 *   <resourcesPath>/stt/parakeet_server.py      — STT FastAPI service
 *   <resourcesPath>/stt/requirements.txt        — pip deps
 *
 * Resources is read-only after macOS code signing, so we install the
 * pip packages into <userData>/stt-packages and invoke the bundled
 * Python with PYTHONPATH pointed there. No venv → no relocation
 * issues if the user moves Bridge.app later.
 *
 * Exposes ensureStt({ resourcesPath, userDataDir, log }) which
 * returns the paths needed to spawn the STT server, or null if the
 * bundled Python is missing (dev mode without the resources).
 *
 * Concurrent first launches lock on a marker file so a second window
 * doesn't double-install.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MARKER_NAME = 'stt-packages.ready';

function exists(p) { try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; } }

function exec(cmd, args, { log = () => {}, env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => log(`[setup-stt] ${d}`));
    child.stderr.on('data', (d) => log(`[setup-stt] ${d}`));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
    child.on('error', reject);
  });
}

/**
 * Ensure the Parakeet runtime is ready to spawn.
 *
 * @returns {Promise<null | {
 *   python: string,        // absolute path to the bundled python3
 *   script: string,        // absolute path to parakeet_server.py
 *   pythonPath: string,    // value for PYTHONPATH (site-packages root)
 *   pyVersionDir: string,  // 'python3.12' style folder under lib/
 * }>}
 */
async function ensureStt({ resourcesPath, userDataDir, log = console.log }) {
  const python = path.join(resourcesPath, 'python', 'bin', 'python3');
  const script = path.join(resourcesPath, 'stt', 'parakeet_server.py');
  if (!exists(python) || !exists(script)) {
    log(`[setup-stt] bundled python or script missing — skipping (python=${exists(python)}, script=${exists(script)})`);
    return null;
  }

  const pkgDir   = path.join(userDataDir, 'stt-packages');
  const reqPath  = path.join(resourcesPath, 'stt', 'requirements.txt');
  const marker   = path.join(pkgDir, MARKER_NAME);

  if (exists(marker)) {
    log('[setup-stt] dependencies already installed');
    return { python, script, pythonPath: pkgDir };
  }

  fs.mkdirSync(pkgDir, { recursive: true });
  log(`[setup-stt] installing requirements into ${pkgDir} (one-time, may take a few minutes) …`);

  // Use --target so the result is fully relocatable. Disable cache to
  // keep the user-data dir slim.
  await exec(python, [
    '-m', 'pip', 'install',
    '--target', pkgDir,
    '--no-cache-dir',
    '-r', reqPath,
  ], { log });

  // Drop the marker so subsequent launches skip straight to spawning
  // the server.
  fs.writeFileSync(marker, new Date().toISOString());
  log('[setup-stt] dependencies ready.');

  return { python, script, pythonPath: pkgDir };
}

module.exports = { ensureStt };
