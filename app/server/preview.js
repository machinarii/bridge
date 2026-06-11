// app/server/preview.js
/* Phase C preview: after a green sandbox run, keep the app RUNNING in a named,
 * detached container with its port published to localhost, so the user can
 * click a link in the engineer's chat and verify the app themselves. All
 * Docker specifics stay here; `_exec` and `probe` are injectable so the whole
 * module unit-tests without Docker. Containers are named bridge-preview-<pid>
 * and replaced (rm -f) on every restart, so at most one preview runs per
 * project and a stale one can never block the port. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProject, ensureRepoPath } from './projects.js';
import { provisionScript } from './verify.js';
import { listSourceFiles } from './run-fix.js';

const DEFAULT_IMAGE = 'node:20-slim';
const PORT_RANGE_BASE = 4500;   // preview host ports: 4500-4699, hashed per project
const PORT_RANGE_SIZE = 200;

/** Docker container name for a project's preview (sanitized, ≤63 chars). */
export function previewName(projectId) {
  return `bridge-preview-${String(projectId).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`.slice(0, 63);
}

/** Stable host port for a project's preview, hashed from its id. */
export function previewPortFor(projectId) {
  let h = 0;
  for (const c of String(projectId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PORT_RANGE_BASE + (h % PORT_RANGE_SIZE);
}

function readPkg(repoPath) {
  try { return JSON.parse(readFileSync(resolve(repoPath, 'package.json'), 'utf8')) || {}; }
  catch { return null; }
}

/** The port the scaffolded app listens on: the first `.listen(<num>)` or
 * `PORT || <num>` literal found in the repo source; 3000 otherwise. The
 * container also gets PORT=<this> so env-respecting apps agree with it. */
export function detectAppPort(repoPath) {
  for (const f of listSourceFiles(repoPath)) {
    if (!/\.(js|ts|mjs|cjs)$/.test(f.path)) continue;
    const m = f.contents.match(/\.listen\(\s*(\d{2,5})/)
           || f.contents.match(/PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/);
    if (m) return Number(m[1]);
  }
  return 3000;
}

/** Shell script the preview container runs: provision → install → (build) →
 * start. Returns null when the repo has no runnable entry (no preview then). */
export function previewScript(pkg) {
  if (!pkg) return null;
  const steps = ['npm install --no-audit --no-fund'];
  if (pkg.scripts?.build) steps.push('npm run build');
  if (pkg.scripts?.start) steps.push('npm start');
  else if (pkg.main) steps.push(`node ${pkg.main}`);
  else return null;
  const body = steps.join(' && ');
  const provision = provisionScript(pkg);
  return provision ? `${provision} && ${body}` : body;
}

/** `docker run` argv for the preview: detached + named (vs the sandbox's
 * --rm/foreground), same resource hardening, port published to localhost only. */
export function previewArgs(repoPath, { name, hostPort, appPort, image = DEFAULT_IMAGE, script }) {
  return [
    'run', '-d', '--name', name,
    '-v', `${repoPath}:/app`,
    '-v', '/app/node_modules',           // container-only node_modules overlay
    '-w', '/app',
    '--memory=2g', '--cpus=2',
    '--pids-limit=1024',
    '--security-opt', 'no-new-privileges',
    '-p', `127.0.0.1:${hostPort}:${appPort}`,
    '-e', `PORT=${appPort}`,
    image, 'sh', '-lc', script,
  ];
}

/** Run docker with argv; resolves { exitCode, output }. Never rejects. */
function execDocker(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(res); } };
    let child;
    try { child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { return resolvePromise({ exitCode: -1, output: String(err?.message || err) }); }
    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (err) => finish({ exitCode: -1, output: output + String(err?.message || err) }));
    child.on('close', (code) => finish({ exitCode: code ?? -1, output }));
  });
}

/** Poll the URL until anything answers (any HTTP status counts — the app is
 * up) or the deadline passes. Install + boot inside the container takes a
 * while, so the default deadline is generous. */
async function waitForHttp(url, { deadlineMs = 60_000, intervalMs = 1500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; }
    catch { await new Promise(r => setTimeout(r, intervalMs)); }
  }
  return false;
}

/** Start (or replace) the project's preview container. Returns
 * { ok:true, url, ready } or { ok:false, reason }. */
export async function startPreview(projectId, { _exec = execDocker, probe = waitForHttp, image } = {}) {
  const project = getProject(projectId);
  if (!project) return { ok: false, reason: 'unknown project' };
  const repoPath = ensureRepoPath(projectId);
  const pkg = readPkg(repoPath);
  const script = previewScript(pkg);
  if (!script) return { ok: false, reason: 'no start script or main entry in package.json' };
  const name = previewName(projectId);
  const hostPort = previewPortFor(projectId);
  const appPort = detectAppPort(repoPath);
  await _exec(['rm', '-f', name]);   // replace any previous preview for this project
  const r = await _exec(previewArgs(repoPath, { name, hostPort, appPort, image, script }));
  if (r.exitCode !== 0) return { ok: false, reason: String(r.output || '').slice(0, 300) };
  const url = `http://localhost:${hostPort}`;
  const ready = await probe(url);
  return { ok: true, url, ready };
}

/** Stop and remove the project's preview container (no-op if none). */
export async function stopPreview(projectId, { _exec = execDocker } = {}) {
  await _exec(['rm', '-f', previewName(projectId)]);
}
