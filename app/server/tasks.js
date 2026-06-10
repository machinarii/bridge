/* Bridge — persisted per-project task store. One JSON file in the state dir,
 * same load/save pattern as projects.js. A "task" is one unit of agent work
 * the executor drives: queued → in_progress → done | blocked_on_user | failed.
 *
 * API:
 *   createTask({projectId, agentId, description, from?}) → task
 *   getTask(id) / listTasks(projectId) / tasksForAgent(agentId, status?)
 *   updateTask(id, patch) → task | null
 *   nextQueued(projectId) → oldest queued task | null
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function stateDir() { return process.env.BRIDGE_STATE_DIR || resolve(__dirname, '..', 'state'); }
function tasksFile() { return join(stateDir(), 'tasks.json'); }

let cache = null;

function load() {
  if (cache) return cache;
  mkdirSync(stateDir(), { recursive: true });
  if (existsSync(tasksFile())) {
    try { cache = JSON.parse(readFileSync(tasksFile(), 'utf8')); }
    catch { cache = { nextId: 1, tasks: [] }; }
  } else cache = { nextId: 1, tasks: [] };
  return cache;
}

function save() {
  if (!cache) return;
  writeFileSync(tasksFile(), JSON.stringify(cache, null, 2), 'utf8');
}

export function createTask({ projectId, agentId, description, from = null }) {
  const data = load();
  const task = {
    id: `t_${data.nextId++}`,
    projectId, agentId,
    description: String(description || '').slice(0, 400),
    from,                      // { agentId, name, role } | null (null = PM/lead)
    status: 'queued',          // queued | in_progress | blocked_on_user | done | failed
    attempts: 0,
    output: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  data.tasks.push(task);
  save();
  return { ...task };
}

export function getTask(id) {
  const t = load().tasks.find(t => t.id === id);
  return t ? { ...t } : null;
}

export function listTasks(projectId) {
  return load().tasks.filter(t => t.projectId === projectId).map(t => ({ ...t }));
}

export function tasksForAgent(agentId, status = null) {
  return load().tasks
    .filter(t => t.agentId === agentId && (!status || t.status === status))
    .map(t => ({ ...t }));
}

export function updateTask(id, patch) {
  const t = load().tasks.find(t => t.id === id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now() });
  save();
  return { ...t };
}

export function nextQueued(projectId) {
  const t = load().tasks.find(t => t.projectId === projectId && t.status === 'queued');
  return t ? { ...t } : null;
}

export function _resetForTests() { cache = null; }
