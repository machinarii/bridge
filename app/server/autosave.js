/* Periodic + on-change git auto-save of project state. Per-project
 * git repo lives at app/state/<projectId>/. Each commit captures
 * charters, notes, project.md, and any scratchpad files written there.
 *
 * Triggered by:
 *   - server.js endpoints calling notifyStateChange(projectId) after a
 *     successful mutation (debounced ~5 s to coalesce bursts);
 *   - a periodic interval (GIT_AUTOSAVE_INTERVAL_MIN, default 5) that
 *     sweeps every project repo and commits any drift.
 *
 * Controlled by env: GIT_AUTOSAVE = "on"|"off",
 *                    GIT_AUTOSAVE_INTERVAL_MIN = integer.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects } from './projects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');

function git(repoDir, args) {
  return new Promise((resolveP, rejectP) => {
    execFile('git', args, { cwd: repoDir }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        rejectP(err);
      } else resolveP(stdout.trim());
    });
  });
}

function autosaveEnabled() {
  return (process.env.GIT_AUTOSAVE || 'off') === 'on';
}

export async function initProjectRepo(projectId) {
  const dir = resolve(STATE_DIR, projectId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(resolve(dir, '.git'))) return;
  try {
    await git(dir, ['init', '-q']);
    await git(dir, ['config', 'user.email', 'bridge@local']);
    await git(dir, ['config', 'user.name', 'Bridge Autosave']);
  } catch (err) {
    console.warn(`[autosave] init failed for ${projectId}:`, err.message);
  }
}

async function isDirty(repoDir) {
  try {
    const out = await git(repoDir, ['status', '--porcelain']);
    return out.length > 0;
  } catch { return false; }
}

export async function commitProject(projectId, message = 'Autosave') {
  if (!autosaveEnabled()) return false;
  const dir = resolve(STATE_DIR, projectId);
  if (!existsSync(resolve(dir, '.git'))) await initProjectRepo(projectId);
  try {
    if (!(await isDirty(dir))) return false;
    await git(dir, ['add', '-A']);
    const stamp = new Date().toISOString();
    await git(dir, ['commit', '-q', '-m', `${message} — ${stamp}`]);
    return true;
  } catch (err) {
    console.warn(`[autosave] commit failed for ${projectId}:`, err.message);
    return false;
  }
}

export async function commitAllDirty(reason = 'Periodic autosave') {
  if (!autosaveEnabled()) return;
  for (const p of listProjects()) {
    try { await commitProject(p.id, reason); }
    catch (err) { console.warn(`[autosave] sweep ${p.id}:`, err.message); }
  }
}

/* Debounced per-project commit triggered from API mutation handlers. */
const pendingTimers = new Map();
export function notifyStateChange(projectId, message = 'State change') {
  if (!autosaveEnabled()) return;
  if (pendingTimers.has(projectId)) clearTimeout(pendingTimers.get(projectId));
  const t = setTimeout(() => {
    pendingTimers.delete(projectId);
    commitProject(projectId, message).catch(() => {});
  }, 5000);
  pendingTimers.set(projectId, t);
}

let intervalHandle = null;
export function rescheduleAutosave() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  if (!autosaveEnabled()) return;
  const minutes = Math.max(1, Math.min(120, Number(process.env.GIT_AUTOSAVE_INTERVAL_MIN || 5)));
  intervalHandle = setInterval(() => {
    commitAllDirty(`Periodic autosave (${minutes}m)`).catch(() => {});
  }, minutes * 60 * 1000);
}

/* Status helper for the UI. */
export async function autosaveStatus(projectId) {
  const dir = resolve(STATE_DIR, projectId);
  const hasRepo = existsSync(resolve(dir, '.git'));
  let dirty = false;
  let lastCommit = null;
  if (hasRepo) {
    try { dirty = (await git(dir, ['status', '--porcelain'])).length > 0; } catch {}
    try { lastCommit = await git(dir, ['log', '-1', '--format=%H %s %ci']); } catch {}
  }
  return { enabled: autosaveEnabled(), hasRepo, dirty, lastCommit };
}
