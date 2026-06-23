/* Per-project council transcript persistence.
 *
 * The council routes (/council/intake, /council/member, /council/synthesis) are
 * stateless — they compute and return. So a council conversation (the user's
 * prompt, their intake decisions, the members' answers, the chair's synthesis)
 * lived only in the renderer's in-memory `councilState` and was lost the moment
 * you left the council view. This stores the renderer's council state per
 * project so it can be restored on re-entry, mirroring how agent chat history
 * persists. One JSON file: <stateDir>/council.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';

function councilFile() { return join(stateDir(), 'council.json'); }

let cache = null;

function load() {
  if (cache) return cache;
  ensureStateDir();
  const file = councilFile();
  if (existsSync(file)) {
    try { cache = JSON.parse(readFileSync(file, 'utf8')); }
    catch { cache = {}; }
  } else cache = {};
  return cache;
}

function save() {
  if (!cache) return;
  writeFileSync(councilFile(), JSON.stringify(cache, null, 2), 'utf8');
}

/** The saved council state for a project, or null if none. */
export function getCouncil(projectId) {
  if (!projectId) return null;
  return load()[projectId] || null;
}

/** Persist (replace) a project's council state. Passing a null/empty state
 *  clears it — leaving the council fresh next time. */
export function saveCouncil(projectId, state) {
  if (!projectId) return null;
  const data = load();
  if (state == null) { delete data[projectId]; save(); return null; }
  data[projectId] = { ...state, updatedAt: Date.now() };
  save();
  return data[projectId];
}

/** Drop a project's council transcript (on project create/delete, like the
 *  scratchpad and learnings) so a reused project id never inherits a prior
 *  council conversation. */
export function clearCouncil(projectId) {
  if (!projectId) return;
  const data = load();
  if (data[projectId]) { delete data[projectId]; save(); }
}
