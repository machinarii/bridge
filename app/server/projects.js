/* Bridge — projects store. Owns projects.json plus per-project folders.
 *
 * Project record:
 *   { id, name, goal, createdAt, leadAgentId, agents: [{ id, role, name, color, persona, enabled }] }
 *
 * Storage:
 *   stateDir()/projects.json                  — the cross-project registry
 *   ~/bridge-projects/<slug>/                 — the project's repo (project.repoPath)
 *   ~/bridge-projects/<slug>/docs/PRD.md      — single source-of-truth doc
 *   ~/bridge-projects/<slug>/docs/roles/      — per-project role charters
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getRole, listRoles, FALLBACK_NAMES } from './roles.js';
import { writeBaselineCharters, deepenCharters, charterFileNameFor, legacyCharterFileNames } from './charters.js';
import { resolveRepoPath, ensureRepo, commitIfChanged } from './workspace.js';
import { clearContext } from './scratchpad.js';
import { clearLearnings } from './learnings.js';
import { stateDir, ensureStateDir } from './state-dir.js';

function projectsFile() { return join(stateDir(), 'projects.json'); }

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
  ensureStateDir();
  const file = projectsFile();
  if (existsSync(file)) {
    try { cache = JSON.parse(readFileSync(file, 'utf8')); }
    catch { cache = { projects: [] }; }
  } else cache = { projects: [] };
  return cache;
}

function save() {
  if (!cache) return;
  writeFileSync(projectsFile(), JSON.stringify(cache, null, 2), 'utf8');
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
  const claim = (n) => { used.add(n); usedLocal.set(roleId, used); if (usedGlobal) usedGlobal.add(n); return n; };
  // Prefer the role's curated names, then draw a fresh, distinct name from the
  // large shared library — never "Cassidy 2".
  for (const n of [...role.namePool, ...FALLBACK_NAMES]) {
    if (!taken(n)) return claim(n);
  }
  // Both pools exhausted (140+ live projects with this role) — only then a
  // last-resort numeric suffix so name-assignment can't fail.
  const base = role.namePool[0];
  for (let i = 2; i < 9999; i++) {
    const cand = `${base} ${i}`;
    if (!taken(cand)) return claim(cand);
  }
  return base;
}

export function listProjects() { return load().projects.slice(); }

export function getProject(id) {
  return load().projects.find(p => p.id === id) || null;
}

export function getKickoff(id) {
  const p = getProject(id);
  return p?.kickoff || { status: 'idle' };
}

export function setKickoff(id, patch) {
  const p = getProject(id);
  if (!p) return null;
  p.kickoff = { ...(p.kickoff || { status: 'idle' }), ...patch };
  save();
  return p.kickoff;
}

/** Shallow-merge arbitrary top-level fields onto a project record and persist.
 * Used for lifecycle state like `phase` and `teamReview`. Returns the project,
 * or null if unknown. */
export function setProjectState(id, patch) {
  const p = getProject(id);
  if (!p) return null;
  Object.assign(p, patch);
  save();
  return p;
}

/** Resolve + persist the project's code-repo path on first use, and make sure
 * the git repo exists on disk. Stable thereafter (a rename won't move it). */
export function ensureRepoPath(id) {
  const p = getProject(id);
  if (!p) return null;
  if (!p.repoPath) { p.repoPath = resolveRepoPath(p.name); save(); }
  ensureRepo(p.repoPath);
  return p.repoPath;
}

/** The project's docs directory inside its repo (<repo>/docs/). Ensures the
 * repo + dir exist. Returns null if the project is unknown. */
export function docsDir(id) {
  const repo = ensureRepoPath(id);
  if (!repo) return null;
  const dir = resolve(repo, 'docs');
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** The project's role-charters directory (<repo>/docs/roles/). */
export function rolesDir(id) {
  const docs = docsDir(id);
  if (!docs) return null;
  const dir = resolve(docs, 'roles');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function createProject({ name, goal, features, roleIds, topology }) {
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

  // Agent ids are deterministic (`${id}__${role}`); if a same-named project was
  // created before (same date → same id), wipe any stale scratchpad so the new
  // project starts with empty chats (no inherited kickoff turns).
  for (const a of agents) clearContext(a.id);
  clearLearnings(id);   // a reused project id must not inherit a prior project's learnings

  const leadAgentId = agents.find(a => a.role === 'pm').id;

  const project = { id, name, goal, features: (features || '').trim(), topology: topo ? topology : null, createdAt: Date.now(), leadAgentId, agents };

  // The project repo is the single home for docs + (later) code.
  const repoPath = resolveRepoPath(name);
  ensureRepo(repoPath);
  project.repoPath = repoPath;
  const docs = resolve(repoPath, 'docs');
  mkdirSync(resolve(docs, 'roles'), { recursive: true });
  const topoSection = topo ? `\n\n## Work topology\n**${topo.label}** — ${topo.rule}` : '';
  // PRD.md is the project's single source-of-truth doc: seeded here with the
  // known facts, then expanded by the PM during kickoff (no separate project.md).
  writeFileSync(
    resolve(docs, 'PRD.md'),
    `# ${name} — PRD\n\n## Goal\n${goal}\n${project.features ? `\n## Top features\n${project.features}\n` : ''}\n## Team\n${agents.map(a => `- ${a.name} — ${getRole(a.role).label}`).join('\n')}${topoSection}\n\n## Created\n${new Date(project.createdAt).toISOString()}\n\n_The PM will expand this into a full PRD during kickoff._\n`,
    'utf8'
  );

  const data = load();
  data.projects.push(project);
  save();

  // Write baseline charters verbatim — no model call at creation. The deep,
  // PRD-aware pass (deepenCharters) tailors them during kickoff.
  writeBaselineCharters(project);
  // Start the repo's history with the initial docs (project.md + charters).
  try { commitIfChanged(repoPath, 'Initialize project docs'); } catch {}
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
  // Charter for the new agent: if a PRD already exists, tailor from it; else
  // write the baseline verbatim (the deep pass runs for everyone at kickoff).
  // Read PRD.md directly — importing backends/notes.js here would cycle.
  try {
    let prd = '';
    const prdPath = resolve(p.repoPath, 'docs', 'PRD.md');
    if (existsSync(prdPath)) prd = readFileSync(prdPath, 'utf8');
    if (prd && !/^_?not generated_?$/i.test(prd.trim())) {
      await deepenCharters(p, { prd, agents: [agent] });
    } else {
      writeBaselineCharters(p, { agents: [agent] });
    }
  } catch (err) { console.warn(`[addAgent] charter generation failed: ${err.message}`); }
  return p;
}

export function removeAgent(projectId, agentId) {
  const p = getProject(projectId);
  if (!p) throw new Error('unknown project');
  if (agentId === p.leadAgentId) throw new Error('cannot remove the lead');
  const agent = p.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('unknown agent');
  p.agents = p.agents.filter(a => a.id !== agentId);
  p.updatedAt = Date.now();
  save();
  // Remove the agent's charter file so the explorer doesn't show a stale entry.
  try {
    if (p.repoPath) {
      const charterPath = resolve(p.repoPath, 'docs', 'roles', charterFileNameFor(agent.role));
      if (existsSync(charterPath)) rmSync(charterPath);
    }
  } catch (err) { console.warn(`[removeAgent] charter cleanup failed: ${err.message}`); }
  return { project: p, removedRole: agent.role };
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
  // The project's code repo (~/bridge-projects/<slug>/) belongs to the user — we
  // do NOT delete it. Instead drop a top-sorted marker (the '#' sorts first) so
  // it's clear the project was removed from Bridge.
  try {
    if (removed.repoPath && existsSync(removed.repoPath)) {
      const when = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
      writeFileSync(
        resolve(removed.repoPath, '#PROJECT-REMOVED.md'),
        `# PROJECT REMOVED\n\nThis project was removed from the Bridge app by the user on ${when}.\n`,
        'utf8',
      );
    }
  } catch {}
  // Remove only Bridge's internal state for the project (registry folder /
  // scratchpad). The scratchpad is keyed by agent id in one shared file, so
  // clear each agent's entry explicitly — otherwise a reused id inherits it.
  try { rmSync(resolve(stateDir(), id), { recursive: true, force: true }); } catch {}
  for (const a of (removed.agents || [])) { try { clearContext(a.id); } catch {} }
  try { clearLearnings(id); } catch {}
  return { ok: true, id, name: removed.name };
}

/* Rename per-project charter files to the current canonical name. Charters
 * have been stored as <roleId>.md and later role-<label>.md; this brings any
 * such file up to whatever charterFileNameFor() now returns (e.g. the short
 * role-sw-eng.md). Safe and idempotent: only renames when a legacy file exists
 * and the canonical one doesn't, so re-running it is a no-op. */
export function migrateCharterFilenames() {
  let renamed = 0;
  for (const p of load().projects) {
    if (!p.repoPath) continue;
    const dir = resolve(p.repoPath, 'docs', 'roles');
    if (!existsSync(dir)) continue;
    for (const a of (p.agents || [])) {
      let canonical;
      try { canonical = charterFileNameFor(a.role); } catch { continue; }
      const newPath = resolve(dir, canonical);
      if (existsSync(newPath)) continue;              // already canonical
      for (const legacy of legacyCharterFileNames(a.role)) {
        if (legacy === canonical) continue;
        const oldPath = resolve(dir, legacy);
        if (!existsSync(oldPath)) continue;
        try { renameSync(oldPath, newPath); renamed++; }
        catch (err) { console.warn(`[migrateCharterFilenames] ${oldPath}: ${err.message}`); }
        break;
      }
    }
  }
  if (renamed) console.log(`[migrateCharterFilenames] renamed ${renamed} charter file(s) to canonical names`);
  return renamed;
}

// For tests — clear in-memory cache so tests re-reading disk see fresh state
export function _resetCacheForTests() { cache = null; }
