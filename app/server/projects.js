/* Bridge — projects store. Owns projects.json plus per-project folders.
 *
 * Project record:
 *   { id, name, goal, createdAt, leadAgentId, agents: [{ id, role, name, color, persona, enabled }] }
 *
 * Folder layout (created in createProject):
 *   app/state/<projectId>/project.md
 *   app/state/<projectId>/roles/    (charter customization writes here later)
 *   app/state/<projectId>/notes/
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRole, listRoles } from './roles.js';
import { generateProjectCharters } from './charters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');
const FILE = join(STATE_DIR, 'projects.json');

/* Work topologies — how the team operates. The `rule` is written into the
 * project's project.md so the orchestrator and the user share one source of
 * truth for how work should flow. */
export const TOPOLOGIES = {
  'hub-and-spoke': { label: 'Hub-and-spoke', rule: 'One coordinator (the lead/PM) holds the most context and routes work to specialists; specialists report back to the coordinator rather than to each other.' },
  'feature-teams': { label: 'Feature teams', rule: 'Work splits into parallel pods that each own a workstream end-to-end. Pods run independently and coordinate only at integration points.' },
  'mesh-mob':      { label: 'Mesh / mob', rule: 'Everyone works on everything together with no fixed ownership; the whole team swarms the current problem.' },
  'rotating-lead': { label: 'Rotating lead', rule: 'Leadership rotates each sprint. The current lead coordinates and sets direction, then hands off to build team-wide ownership.' },
  'async-pull':    { label: 'Async pull / queue', rule: 'Work flows from a shared backlog. Members self-assign the next item asynchronously, with no synchronous coordination required.' },
};

let cache = null;

function load() {
  if (cache) return cache;
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(FILE)) {
    try { cache = JSON.parse(readFileSync(FILE, 'utf8')); }
    catch { cache = { projects: [] }; }
  } else cache = { projects: [] };
  return cache;
}

function save() {
  if (!cache) return;
  writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

function todayDateSlug() {
  const d = new Date();
  return `${d.getFullYear()}_${String(d.getMonth()+1).padStart(2,'0')}_${String(d.getDate()).padStart(2,'0')}`;
}

function uniqueProjectId(name) {
  const base = `p_${todayDateSlug()}_${slugify(name)}`;
  const taken = new Set(listProjects().map(p => p.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}_${i}`;
    if (!taken.has(cand)) return cand;
  }
  throw new Error('too many id collisions');
}

/* All agent names already in use across every project — used to
 * keep names globally unique so two agents never share a name. */
function namesInUseAcrossProjects() {
  const out = new Set();
  for (const p of load().projects) {
    for (const a of (p.agents || [])) {
      if (a?.name) out.add(a.name);
    }
  }
  return out;
}

/* Pick an unused name for `roleId`. Skips:
 *   - names already taken by another agent on THIS project (usedLocal)
 *   - names already taken on any OTHER project (usedGlobal)
 * If the role's namePool is exhausted, fall back to "<first> N" with
 * a numeric suffix so the result is still unique. */
function pickName(roleId, usedLocal, usedGlobal) {
  const role = getRole(roleId);
  const used = usedLocal.get(roleId) || new Set();
  const taken = (n) => used.has(n) || (usedGlobal && usedGlobal.has(n));
  for (const n of role.namePool) {
    if (!taken(n)) {
      used.add(n); usedLocal.set(roleId, used);
      if (usedGlobal) usedGlobal.add(n);
      return n;
    }
  }
  // Pool exhausted — suffix with the lowest free integer.
  const base = role.namePool[0];
  for (let i = 2; i < 9999; i++) {
    const cand = `${base} ${i}`;
    if (!taken(cand)) {
      used.add(cand); usedLocal.set(roleId, used);
      if (usedGlobal) usedGlobal.add(cand);
      return cand;
    }
  }
  return base;
}

export function listProjects() { return load().projects.slice(); }

export function getProject(id) {
  return load().projects.find(p => p.id === id) || null;
}

export async function createProject({ name, goal, roleIds, topology }) {
  if (!name) throw new Error('name required');
  if (!goal) throw new Error('goal required');
  if (!Array.isArray(roleIds) || roleIds.length === 0) throw new Error('at least one role required');
  const topo = TOPOLOGIES[topology] || null;

  // Dedup, validate
  const seen = new Set();
  const chosen = roleIds.filter(r => {
    if (seen.has(r) || !getRole(r)) return false;
    seen.add(r); return true;
  });

  // PM is the lead role for every project; auto-add if missing.
  if (!chosen.includes('pm')) chosen.unshift('pm');

  const id = uniqueProjectId(name);
  const usedByRole = new Map();
  // Names taken by every agent on every existing project — passed to
  // pickName so the new project doesn't pick anyone else's name.
  const usedGlobal = namesInUseAcrossProjects();
  const agents = chosen.map(roleId => {
    const r = getRole(roleId);
    return {
      id: `${id}__${roleId}`,
      role: roleId,
      name: pickName(roleId, usedByRole, usedGlobal),
      color: r.color,
      persona: r.personaSeed,
      enabled: true,
    };
  });

  const leadAgentId = agents.find(a => a.role === 'pm').id;

  const project = { id, name, goal, topology: topo ? topology : null, createdAt: Date.now(), leadAgentId, agents };

  // Scaffold folder
  const projDir = resolve(STATE_DIR, id);
  mkdirSync(resolve(projDir, 'roles'), { recursive: true });
  mkdirSync(resolve(projDir, 'notes'), { recursive: true });
  const topoSection = topo ? `\n\n## Work topology\n**${topo.label}** — ${topo.rule}` : '';
  writeFileSync(
    resolve(projDir, 'project.md'),
    `# ${name}\n\n## Goal\n${goal}\n\n## Team\n${agents.map(a => `- ${a.name} — ${getRole(a.role).label}`).join('\n')}${topoSection}\n\n## Created\n${new Date(project.createdAt).toISOString()}\n`,
    'utf8'
  );

  const data = load();
  data.projects.push(project);
  save();

  // Generate per-project charters (falls back to base verbatim on failure).
  await generateProjectCharters(project);
  return project;
}

export async function addAgent(projectId, roleId) {
  const p = getProject(projectId);
  if (!p) throw new Error('unknown project');
  const role = getRole(roleId);
  if (!role) throw new Error(`unknown role: ${roleId}`);
  if (p.agents.some(a => a.role === roleId)) {
    throw new Error(`role already on project: ${roleId}`);
  }
  const usedByRole = new Map();
  for (const a of p.agents) {
    const used = usedByRole.get(a.role) || new Set();
    used.add(a.name);
    usedByRole.set(a.role, used);
  }
  // Global uniqueness: include every other project's agent names too.
  const usedGlobal = namesInUseAcrossProjects();
  const agent = {
    id: `${p.id}__${roleId}`,
    role: roleId,
    name: pickName(roleId, usedByRole, usedGlobal),
    color: role.color,
    persona: role.personaSeed,
    enabled: true,
  };
  p.agents.push(agent);
  save();
  // Only generate the new agent's charter — the rest are unchanged, so
  // regenerating the whole team was N redundant OpenRouter calls per add.
  try { await generateProjectCharters(p, { agents: [agent] }); }
  catch (err) { console.warn(`[addAgent] charter generation failed: ${err.message}`); }
  return p;
}

export function removeAgent(projectId, agentId) {
  const p = getProject(projectId);
  if (!p) throw new Error('unknown project');
  if (agentId === p.leadAgentId) throw new Error('cannot remove the lead');
  const before = p.agents.length;
  p.agents = p.agents.filter(a => a.id !== agentId);
  if (p.agents.length === before) throw new Error('unknown agent');
  p.updatedAt = Date.now();
  save();
  return p;
}

export function setAgentEnabled(projectId, agentId, enabled) {
  const p = getProject(projectId);
  if (!p) throw new Error('unknown project');
  const a = p.agents.find(x => x.id === agentId);
  if (!a) throw new Error('unknown agent');
  if (a.id === p.leadAgentId && !enabled) {
    return { ok: false, reason: 'lead cannot be disabled' };
  }
  a.enabled = !!enabled;
  save();
  return { ok: true, agent: a };
}

export function renameProject(id, name) {
  const p = getProject(id);
  if (!p) throw new Error('unknown project');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('name required');
  p.name = clean;
  save();
  return p;
}

export function deleteProject(id) {
  const data = load();
  const idx = data.projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('unknown project');
  const [removed] = data.projects.splice(idx, 1);
  save();
  // Remove the project's on-disk state (project.md, notes, charters, git repo).
  try { rmSync(resolve(STATE_DIR, id), { recursive: true, force: true }); } catch {}
  return { ok: true, id, name: removed.name };
}

// For tests — clear in-memory cache so tests re-reading disk see fresh state
export function _resetCacheForTests() { cache = null; }
