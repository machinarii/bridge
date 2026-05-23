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

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRole, listRoles } from './roles.js';
import { generateProjectCharters } from './charters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');
const FILE = join(STATE_DIR, 'projects.json');

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

function pickName(roleId, usedByRole) {
  const role = getRole(roleId);
  const used = usedByRole.get(roleId) || new Set();
  for (const n of role.namePool) {
    if (!used.has(n)) { used.add(n); usedByRole.set(roleId, used); return n; }
  }
  // Exhausted pool (shouldn't happen with single-instance roles)
  return role.namePool[0];
}

export function listProjects() { return load().projects.slice(); }

export function getProject(id) {
  return load().projects.find(p => p.id === id) || null;
}

export async function createProject({ name, goal, roleIds }) {
  if (!name) throw new Error('name required');
  if (!goal) throw new Error('goal required');
  if (!Array.isArray(roleIds) || roleIds.length === 0) throw new Error('at least one role required');

  // Dedup, validate
  const seen = new Set();
  const chosen = roleIds.filter(r => {
    if (seen.has(r) || !getRole(r)) return false;
    seen.add(r); return true;
  });

  // Auto-add TPM if no lead role chosen
  const hasLead = chosen.includes('pm') || chosen.includes('tpm');
  if (!hasLead) chosen.push('tpm');

  const id = uniqueProjectId(name);
  const usedByRole = new Map();
  const agents = chosen.map(roleId => {
    const r = getRole(roleId);
    return {
      id: `${id}__${roleId}`,
      role: roleId,
      name: pickName(roleId, usedByRole),
      color: r.color,
      persona: r.personaSeed,
      enabled: true,
    };
  });

  const leadRoleId = chosen.includes('pm') ? 'pm' : 'tpm';
  const leadAgentId = agents.find(a => a.role === leadRoleId).id;

  const project = { id, name, goal, createdAt: Date.now(), leadAgentId, agents };

  // Scaffold folder
  const projDir = resolve(STATE_DIR, id);
  mkdirSync(resolve(projDir, 'roles'), { recursive: true });
  mkdirSync(resolve(projDir, 'notes'), { recursive: true });
  writeFileSync(
    resolve(projDir, 'project.md'),
    `# ${name}\n\n## Goal\n${goal}\n\n## Team\n${agents.map(a => `- ${a.name} — ${getRole(a.role).label}`).join('\n')}\n\n## Created\n${new Date(project.createdAt).toISOString()}\n`,
    'utf8'
  );

  const data = load();
  data.projects.push(project);
  save();

  // Generate per-project charters (falls back to base verbatim on failure).
  await generateProjectCharters(project);
  return project;
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

// For tests — clear in-memory cache so tests re-reading disk see fresh state
export function _resetCacheForTests() { cache = null; }
