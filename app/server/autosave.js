/* Periodic + on-change git auto-save of project state. Commits the project's
 * own repo (~/bridge-projects/<slug>/, i.e. project.repoPath) — the single
 * home for docs, charters, and code. Each commit captures any drift the
 * synchronous commitIfChanged calls missed.
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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listProjects, getProject, ensureRepoPath } from './projects.js';
import { emitNotification } from './events.js';

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

/* Make sure the project's repo exists and is git-initialized. Identity is NOT
 * written into the repo's local config — it belongs to the user — commits use
 * an inline -c identity instead (same approach as workspace.js commitAll). */
export async function initProjectRepo(projectId) {
  try {
    ensureRepoPath(projectId);
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
  let dir;
  try { dir = ensureRepoPath(projectId); } catch { return false; }
  if (!dir) return false;
  try {
    if (!(await isDirty(dir))) return false;
    await git(dir, ['add', '-A']);
    const stamp = new Date().toISOString();
    await git(dir, [
      '-c', 'user.name=Bridge Autosave', '-c', 'user.email=bridge@local',
      'commit', '-q', '-m', `${message} — ${stamp}`,
    ]);
    return true;
  } catch (err) {
    console.warn(`[autosave] commit failed for ${projectId}:`, err.message);
    emitNotification({
      kind: 'error',
      projectId,
      title: 'Autosave failed',
      body: err.message || 'Could not commit project state.',
    });
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
  const dir = getProject(projectId)?.repoPath || null;
  const hasRepo = !!dir && existsSync(resolve(dir, '.git'));
  let dirty = false;
  let lastCommit = null;
  if (hasRepo) {
    try { dirty = (await git(dir, ['status', '--porcelain'])).length > 0; } catch {}
    try { lastCommit = await git(dir, ['log', '-1', '--format=%H %s %ci']); } catch {}
  }
  return { enabled: autosaveEnabled(), hasRepo, dirty, lastCommit };
}
