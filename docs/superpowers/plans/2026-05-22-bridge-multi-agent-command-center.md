# Bridge — Multi-Agent Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Bridge's single 4×2 grid of 8 hardcoded agents into Bridge — a multi-project workspace where each project is a hand-picked, role-typed team with its own folder, customized role charters, file explorer, and a lead-delegated team voice on top of the existing single-agent prompt UI.

**Architecture:** Three-level UI (project picker → project grid → agent zoom) layered on the existing Node/Express server + vanilla-JS renderer. Server owns projects.json (one record per project), per-project folders under `app/state/<projectId>/` containing role charters and notes, and an orchestrator that injects each agent's project-customized charter into every system prompt. Team voice runs router → parallel fan-out (cap 5) → synthesizer through the lead agent. Renderer adds three modes above the existing zoom view; file explorer is a togglable left drawer; history is a Triangle-summoned drawer at L2.

**Tech Stack:** Node 20+, Express 4, ES Modules, `node:test`, `node:fs`, vanilla JS (no framework), Web Speech API, Gamepad API, OpenRouter (claude-sonnet-4.5 default).

**Spec:** `docs/superpowers/specs/2026-05-22-projects-and-roles-design.md`

---

## File Structure

**New server files (this plan creates):**
- `app/server/roles.js` — 14-role catalog (id, label, color, namePool, personaSeed)
- `app/server/projects.js` — CRUD + name-pool walker + lead resolution + folder scaffolding
- `app/server/charters.js` — base charter loading + LLM customization + validator
- `app/server/team.js` — team-voice pipeline (router → fan-out → synthesizer)
- `app/server/role-charters/<roleId>.md` × 14 — base charter templates
- `app/server/projects.test.js`, `app/server/charters.test.js`, `app/server/team.test.js` — `node:test` unit tests

**Server files modified:**
- `app/server/server.js` — route surface swap (8 new routes, 8 removed)
- `app/server/orchestrator.js` — accept project+agent identity, inject charter into system prompt
- `app/server/scratchpad.js` — first-boot wipe for legacy keys
- `app/server/backends/notes.js` — add `projectId` parameter throughout

**Server files deleted:**
- `app/server/agents.js`
- `app/notes/` directory

**Renderer files modified:**
- `app/renderer/main.js` — add MODE_PROJECTS / MODE_NEW_PROJECT_ROLES / MODE_NEW_PROJECT_NAME / MODE_NEW_PROJECT_GOAL; wire team voice; wire file explorer toggle; wire history drawer; wire enable/disable
- `app/renderer/tiles.js` — add `role_picker`, `name_capture`, `goal_capture`, `team_summary`, `history_drawer`, `file_explorer` templates
- `app/renderer/style.css` — reflow grid, picker tile, disabled state, file drawer, history drawer, team summary banner, pulse animation
- `app/renderer/gamepad.js` — no behavioral change (Square + Triangle + Options already mapped)
- `app/renderer/index.html` — add containers for file drawer and history drawer

**State migration:**
- On first boot: rewrite `app/state/scratchpad.json` if it contains legacy keys (`nova`, `atlas`, …). Create `app/state/projects.json` if missing.

---

## Phase 0 — Test infrastructure & legacy teardown

Sets up `node:test` and removes the legacy agent surface so subsequent phases build on a clean foundation. App is intentionally broken at the end of this phase (no UI works); Phase 1 restores it.

### Task 0.1 — Add test runner to server package

**Files:**
- Modify: `app/server/package.json`

- [ ] **Step 1: Add a test script**

Edit `app/server/package.json`'s `scripts` block to:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "test": "node --test --test-reporter=spec"
}
```

- [ ] **Step 2: Verify `npm test` runs (and reports zero tests)**

Run: `cd app/server && npm test`
Expected: exits 0 with `tests 0`, no errors.

- [ ] **Step 3: Commit**

```bash
git add app/server/package.json
git commit -m "chore(server): add node:test runner"
```

### Task 0.2 — Delete legacy agents module and routes

**Files:**
- Delete: `app/server/agents.js`
- Modify: `app/server/server.js`
- Modify: `app/server/orchestrator.js`

- [ ] **Step 1: Delete `app/server/agents.js`**

```bash
rm app/server/agents.js
```

- [ ] **Step 2: Strip all legacy routes and imports from server.js**

In `app/server/server.js`, replace lines 5–8 (imports) and lines 27–71 (legacy routes) so the file looks like:

```js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 4317);
const RENDERER_DIR = resolve(__dirname, '..', 'renderer');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(RENDERER_DIR));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[bridge] orchestrator listening on http://localhost:${PORT}`);
  console.log(`[bridge] renderer at http://localhost:${PORT}/`);
});
```

- [ ] **Step 3: Stub orchestrator imports**

In `app/server/orchestrator.js`, replace line 3 (`import { getAgent } from './agents.js';`) with:

```js
// agent identity now comes from projects.js (added in Phase 1)
```

Leave the rest of `orchestrator.js` alone for now — Phase 1 rewires it.

- [ ] **Step 4: Verify server still boots**

Run: `cd app/server && node --check server.js && node --check orchestrator.js && echo OK`
Expected: prints `OK` with no errors. The server will fail at runtime if started — that's fine.

- [ ] **Step 5: Commit**

```bash
git add app/server/server.js app/server/orchestrator.js
git rm app/server/agents.js
git commit -m "chore(server): remove legacy agent surface"
```

### Task 0.3 — Wipe legacy scratchpad and notes

**Files:**
- Modify: `app/server/scratchpad.js`
- Delete: `app/notes/` (contents preserved on disk but stop reading from it)
- Modify: `app/state/scratchpad.json` (wiped on first run via boot migration)

- [ ] **Step 1: Add boot-migration helper to scratchpad.js**

Append to `app/server/scratchpad.js`:

```js
const LEGACY_KEYS = new Set(['nova','atlas','sage','echo','vesper','halo','lyra','ember']);

/** Wipe legacy 8-agent records on first boot under the new schema. */
export function migrateLegacyOnce() {
  const data = load();
  let touched = false;
  for (const key of Object.keys(data)) {
    if (LEGACY_KEYS.has(key)) { delete data[key]; touched = true; }
  }
  if (touched) {
    cache = data;
    save();
    console.log('[migrate] wiped legacy scratchpad keys');
  }
}
```

Note: the `cache` variable used here is the existing module-local `let cache` at line 26 — same scope.

- [ ] **Step 2: Call migration on server boot**

In `app/server/server.js`, add this import after the existing imports:

```js
import { migrateLegacyOnce } from './scratchpad.js';
```

And immediately before `app.listen(PORT, …)`, add:

```js
migrateLegacyOnce();
```

- [ ] **Step 3: Run server briefly to confirm migration**

Run: `cd app/server && node server.js & SERVER_PID=$!; sleep 1; kill $SERVER_PID; cat ../state/scratchpad.json`
Expected: `scratchpad.json` no longer contains any of `nova`/`atlas`/`sage`/`echo`/`vesper`/`halo`/`lyra`/`ember` keys (file may be `{}` if those were the only entries). One log line "[migrate] wiped legacy scratchpad keys" appears.

- [ ] **Step 4: Commit**

```bash
git add app/server/scratchpad.js app/server/server.js app/state/scratchpad.json
git commit -m "chore(server): wipe legacy scratchpad on boot"
```

---

## Phase 1 — Server foundation: roles, projects, charters

Builds the server-side data layer end-to-end with tests. App still has no UI at the end of this phase (Phase 2 wires the renderer); endpoints are exercised by `curl` and `node:test`.

### Task 1.1 — Role catalog

**Files:**
- Create: `app/server/roles.js`
- Create: `app/server/roles.test.js`

- [ ] **Step 1: Write the failing test**

Create `app/server/roles.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, getRole, listRoles } from './roles.js';

test('listRoles returns all 14 roles', () => {
  const ids = listRoles().map(r => r.id);
  assert.equal(ids.length, 14);
  assert.deepEqual(new Set(ids).size, 14, 'all ids unique');
});

test('every role has id, label, color, namePool, personaSeed', () => {
  for (const r of listRoles()) {
    assert.ok(r.id);
    assert.ok(r.label);
    assert.ok(r.color);
    assert.ok(Array.isArray(r.namePool) && r.namePool.length >= 4);
    assert.ok(r.personaSeed);
  }
});

test('getRole(id) returns the role or null', () => {
  assert.equal(getRole('pm').label, 'Product Manager');
  assert.equal(getRole('nope'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/server && npm test`
Expected: FAIL — `roles.js` cannot be resolved.

- [ ] **Step 3: Implement roles.js**

Create `app/server/roles.js`:

```js
/* Bridge — 14-role catalog. The single source of truth for which roles can
 * appear on a project and what their default name pool, color, and persona
 * seed are. Name pools are short (4 each) because no project picks the same
 * role twice. */

export const ROLES = [
  { id: 'pm',          label: 'Product Manager',  color: '#ffb86b',
    namePool: ['Cassidy','Marlowe','Quinn','Linden'],
    personaSeed: 'organizing, strategic' },
  { id: 'engineer',    label: 'Engineer',         color: '#6ea8ff',
    namePool: ['Kade','Reese','Forge','Birch'],
    personaSeed: 'builder, precise' },
  { id: 'designer',    label: 'Designer',         color: '#c08bff',
    namePool: ['Iris','Mira','Cove','Juno'],
    personaSeed: 'visual, intuitive' },
  { id: 'qa',          label: 'QA',               color: '#ffd35a',
    namePool: ['Audrey','Tess','Roan','Vail'],
    personaSeed: 'methodical, sharp' },
  { id: 'data_sci',    label: 'Data Scientist',   color: '#9cf2c1',
    namePool: ['Theo','Nori','Banks','Soren'],
    personaSeed: 'analytical' },
  { id: 'devops',      label: 'DevOps / SRE',     color: '#5fdcd6',
    namePool: ['Ridge','Beacon','Atlas','Cairn'],
    personaSeed: 'infrastructure-minded' },
  { id: 'security',    label: 'Security',         color: '#ff7b86',
    namePool: ['Sentry','Cyrus','Onyx','Vault'],
    personaSeed: 'vigilant' },
  { id: 'tpm',         label: 'TPM / PgM',        color: '#ff8ec7',
    namePool: ['Cadence','Lennox','Pace','Halden'],
    personaSeed: 'coordinating' },
  { id: 'ux_research', label: 'UX Research',      color: '#bda4ff',
    namePool: ['Wren','Story','Iona','Sable'],
    personaSeed: 'curious' },
  { id: 'ml_eng',      label: 'ML Engineer',      color: '#7be0a8',
    namePool: ['Vector','Tessa','Helix','Axon'],
    personaSeed: 'tensor-minded' },
  { id: 'data_eng',    label: 'Data Engineer',    color: '#88c0ff',
    namePool: ['Brook','Delta','Reine','Conduit'],
    personaSeed: 'pipeline flow' },
  { id: 'tech_writer', label: 'Technical Writer', color: '#e0c98a',
    namePool: ['Quill','Proser','Hadley','Mark'],
    personaSeed: 'clarifying' },
  { id: 'marketing',   label: 'Marketing',        color: '#ffa1b8',
    namePool: ['Brio','Lark','Verve','Echo'],
    personaSeed: 'energetic' },
  { id: 'support',     label: 'Support',          color: '#9cb8ff',
    namePool: ['Haven','Bay','Solace','Lior'],
    personaSeed: 'helpful' },
];

const BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r]));

export function listRoles() { return ROLES.slice(); }
export function getRole(id) { return BY_ID[id] || null; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/server && npm test`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/roles.js app/server/roles.test.js
git commit -m "feat(server): add 14-role catalog"
```

### Task 1.2 — Base charter templates

**Files:**
- Create: `app/server/role-charters/<roleId>.md` × 14

- [ ] **Step 1: Create the charters directory**

```bash
mkdir -p app/server/role-charters
```

- [ ] **Step 2: Write the 14 base charter files**

Each file uses this exact template structure (the customizer and validator rely on these three headings):

`app/server/role-charters/pm.md`:

```markdown
# Product Manager

## Role
You translate user needs and business goals into a sequenced plan the team can build. You own scope, sequencing, and the definition of done — not the implementation. You keep the team aligned on what matters now and what can wait.

## Typical tasks
- Frame the problem in one or two sentences before solutioning.
- Cut scope ruthlessly when the goal is at risk.
- Coordinate handoffs between Engineering, Design, QA, and GTM.
- Decide what ships and what waits.

## Areas of expertise
- Product strategy and tradeoffs
- Roadmap sequencing and dependency management
- Stakeholder communication
- Outcome-oriented requirements
```

Create the remaining 13 files with the same three-heading structure (`## Role`, `## Typical tasks`, `## Areas of expertise`). Suggested content per role:

| File | Role one-liner |
|---|---|
| `engineer.md` | You build the thing. Precise, durable, testable code. |
| `designer.md` | You shape how it looks, feels, and flows for the user. |
| `qa.md` | You find the failure modes before users do. |
| `data_sci.md` | You turn data into decisions. |
| `devops.md` | You make the systems that run the systems reliable. |
| `security.md` | You make sure nothing leaks and nothing breaks under attack. |
| `tpm.md` | You orchestrate cross-team execution and unblock people. |
| `ux_research.md` | You learn what users actually need. |
| `ml_eng.md` | You ship models into production. |
| `data_eng.md` | You move data from source to insight reliably. |
| `tech_writer.md` | You make complex systems understandable. |
| `marketing.md` | You shape how the product enters the world. |
| `support.md` | You keep customers successful and feed pain back upstream. |

For each, write 3–4 bullets under Typical tasks and 3–4 under Areas of expertise. Keep each file under 200 words.

- [ ] **Step 3: Verify the files**

Run: `ls app/server/role-charters/ | wc -l`
Expected: `14`

Run: `for f in app/server/role-charters/*.md; do grep -c '^## ' "$f"; done | sort -u`
Expected: `3` (every file has exactly 3 H2 headings).

- [ ] **Step 4: Commit**

```bash
git add app/server/role-charters/
git commit -m "feat(server): add 14 base role charter templates"
```

### Task 1.3 — Projects CRUD with folder scaffolding

**Files:**
- Create: `app/server/projects.js`
- Create: `app/server/projects.test.js`
- Modify: `app/server/scratchpad.js` (already supports composite ids; no change needed)

- [ ] **Step 1: Write the failing test**

Create `app/server/projects.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');

// Isolate each run — delete projects.json before importing
rmSync(resolve(STATE_DIR, 'projects.json'), { force: true });
for (const sub of ['p_test_alpha', 'p_test_alpha_2', 'p_test_beta']) {
  rmSync(resolve(STATE_DIR, sub), { recursive: true, force: true });
}

const { createProject, listProjects, getProject } = await import('./projects.js');

test('listProjects starts empty', () => {
  assert.deepEqual(listProjects(), []);
});

test('createProject builds a project with auto-named agents', async () => {
  const p = await createProject({ name: 'Test Alpha', goal: 'Ship a test', roleIds: ['pm','engineer','qa'] });
  assert.match(p.id, /^p_/);
  assert.equal(p.name, 'Test Alpha');
  assert.equal(p.goal, 'Ship a test');
  assert.equal(p.agents.length, 3);
  assert.deepEqual(p.agents.map(a => a.role).sort(), ['engineer','pm','qa']);
  // Lead is PM if present
  assert.equal(p.leadAgentId, p.agents.find(a => a.role === 'pm').id);
  // All enabled by default
  assert.ok(p.agents.every(a => a.enabled));
  // Names from each role's pool
  const pm = p.agents.find(a => a.role === 'pm');
  assert.ok(['Cassidy','Marlowe','Quinn','Linden'].includes(pm.name));
});

test('createProject without pm or tpm auto-adds TPM as lead', async () => {
  const p = await createProject({ name: 'Test Beta', goal: 'No leads picked', roleIds: ['engineer','qa'] });
  assert.equal(p.agents.length, 3, 'TPM auto-added');
  assert.equal(p.agents.find(a => a.id === p.leadAgentId).role, 'tpm');
});

test('createProject creates the project folder with roles/ and notes/', async () => {
  const p = await createProject({ name: 'Test Alpha', goal: 'collision', roleIds: ['pm'] });
  const projDir = resolve(STATE_DIR, p.id);
  assert.ok(existsSync(resolve(projDir, 'project.md')));
  assert.ok(existsSync(resolve(projDir, 'roles')));
  assert.ok(existsSync(resolve(projDir, 'notes')));
  // project.md mentions goal
  assert.match(readFileSync(resolve(projDir, 'project.md'), 'utf8'), /collision/);
});

test('slug collision adds _2 suffix', async () => {
  const list = listProjects().filter(p => p.name === 'Test Alpha');
  assert.ok(list.length >= 2);
  assert.ok(list.some(p => p.id.endsWith('_2')));
});

test('getProject returns null for unknown', () => {
  assert.equal(getProject('p_does_not_exist'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/server && npm test`
Expected: FAIL — `projects.js` not found.

- [ ] **Step 3: Implement projects.js**

Create `app/server/projects.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/server && npm test`
Expected: PASS — 6 tests in `projects.test.js` pass; `roles.test.js` still passes.

- [ ] **Step 5: Commit**

```bash
git add app/server/projects.js app/server/projects.test.js
git commit -m "feat(server): add projects store with folder scaffolding"
```

### Task 1.4 — Charter loading and customization

**Files:**
- Create: `app/server/charters.js`
- Create: `app/server/charters.test.js`

- [ ] **Step 1: Write the failing test**

Create `app/server/charters.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseCharter, validateCharterMarkdown, FALLBACK_REASON } from './charters.js';

test('loadBaseCharter returns the file contents for a known role', () => {
  const md = loadBaseCharter('pm');
  assert.match(md, /^# Product Manager/);
  assert.match(md, /## Role/);
  assert.match(md, /## Typical tasks/);
  assert.match(md, /## Areas of expertise/);
});

test('loadBaseCharter throws for unknown role', () => {
  assert.throws(() => loadBaseCharter('nope'));
});

test('validateCharterMarkdown accepts complete charter', () => {
  const md = '# X\n## Role\nfoo\n## Typical tasks\n- bar\n## Areas of expertise\n- baz\n';
  assert.equal(validateCharterMarkdown(md).ok, true);
});

test('validateCharterMarkdown rejects when heading missing', () => {
  const md = '# X\n## Role\nfoo\n## Typical tasks\n- bar\n';
  const r = validateCharterMarkdown(md);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Areas of expertise/);
});

test('FALLBACK_REASON is exported', () => {
  assert.ok(FALLBACK_REASON);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/server && npm test`
Expected: FAIL — `charters.js` not found.

- [ ] **Step 3: Implement charters.js**

Create `app/server/charters.js`:

```js
/* Bridge — charter customization. Loads base templates, calls OpenRouter to
 * rewrite them against a project's goal, validates the result, falls back
 * to the base verbatim on any failure. Written to <projectId>/roles/<roleId>.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRole } from './roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARTERS_DIR = resolve(__dirname, 'role-charters');
const STATE_DIR = resolve(__dirname, '..', 'state');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUIRED_HEADINGS = ['## Role', '## Typical tasks', '## Areas of expertise'];
const CHARTER_TIMEOUT_MS = 20_000;

export const FALLBACK_REASON = {
  NO_KEY:   'no_openrouter_key',
  TIMEOUT:  'request_timeout',
  HTTP:     'http_error',
  INVALID:  'invalid_markdown',
  EXCEPTION:'exception',
};

export function loadBaseCharter(roleId) {
  if (!getRole(roleId)) throw new Error(`unknown role: ${roleId}`);
  const path = resolve(CHARTERS_DIR, `${roleId}.md`);
  if (!existsSync(path)) throw new Error(`missing base charter: ${roleId}.md`);
  return readFileSync(path, 'utf8');
}

export function validateCharterMarkdown(md) {
  for (const h of REQUIRED_HEADINGS) {
    if (!md.includes(h)) return { ok: false, reason: `missing heading: ${h}` };
  }
  return { ok: true };
}

async function callOpenRouter({ apiKey, model, prompt }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHARTER_TIMEOUT_MS);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost/bridge',
        'X-Title': 'Bridge — charter',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, reason: FALLBACK_REASON.HTTP, status: resp.status };
    const data = await resp.json();
    return { ok: true, content: data?.choices?.[0]?.message?.content || '' };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: FALLBACK_REASON.TIMEOUT };
    return { ok: false, reason: FALLBACK_REASON.EXCEPTION, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Customize one role's charter for a project. Always returns the markdown
 *  that should be written to disk — falling back to base on any failure. */
export async function customizeCharter({ projectName, goal, agentName, roleId }) {
  const base = loadBaseCharter(roleId);
  const role = getRole(roleId);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return { markdown: base, customized: false, reason: FALLBACK_REASON.NO_KEY };
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  const prompt =
    `${agentName} (the ${role.label} on project "${projectName}") has this base charter:\n\n` +
    `${base}\n\n` +
    `The project goal is:\n"${goal}"\n\n` +
    `Rewrite the charter so it reflects this project's specifics. Keep the same markdown structure ` +
    `(the headings ## Role, ## Typical tasks, ## Areas of expertise must remain). Replace generic ` +
    `items with project-specific ones. 200 words max. Output only markdown — no code fences, no commentary.`;
  const r = await callOpenRouter({ apiKey, model, prompt });
  if (!r.ok) return { markdown: base, customized: false, reason: r.reason };
  const v = validateCharterMarkdown(r.content);
  if (!v.ok)   return { markdown: base, customized: false, reason: FALLBACK_REASON.INVALID };
  return { markdown: r.content, customized: true };
}

/** Customize every role for a project in parallel, with a hard cap on
 *  concurrent in-flight requests. Writes results to disk. */
export async function generateProjectCharters(project, { concurrency = 5 } = {}) {
  const tasks = project.agents.map(a => async () => {
    const r = await customizeCharter({
      projectName: project.name,
      goal: project.goal,
      agentName: a.name,
      roleId: a.role,
    });
    const path = resolve(STATE_DIR, project.id, 'roles', `${a.role}.md`);
    writeFileSync(path, r.markdown, 'utf8');
    return { agentId: a.id, roleId: a.role, customized: r.customized, reason: r.reason };
  });
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      results.push(await tasks[i]());
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/** Read a project's customized charter (or base if not yet written). */
export function readProjectCharter(projectId, roleId) {
  const path = resolve(STATE_DIR, projectId, 'roles', `${roleId}.md`);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return loadBaseCharter(roleId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/server && npm test`
Expected: PASS — 5 charter tests pass; all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/charters.js app/server/charters.test.js
git commit -m "feat(server): add charter customization with validator + fallback"
```

### Task 1.5 — Wire create-project to charter generation

**Files:**
- Modify: `app/server/projects.js`
- Modify: `app/server/projects.test.js`

- [ ] **Step 1: Update test to assert charters are written**

In `app/server/projects.test.js`, replace the "createProject creates the project folder…" test with:

```js
test('createProject writes charter markdown for each role', async () => {
  const p = await createProject({ name: 'Test Charters', goal: 'verify charter pipeline', roleIds: ['pm','engineer'] });
  const projDir = resolve(STATE_DIR, p.id);
  for (const a of p.agents) {
    const charterPath = resolve(projDir, 'roles', `${a.role}.md`);
    assert.ok(existsSync(charterPath), `charter exists for ${a.role}`);
    const md = readFileSync(charterPath, 'utf8');
    assert.match(md, /## Role/);
    assert.match(md, /## Typical tasks/);
    assert.match(md, /## Areas of expertise/);
  }
});
```

Also add to the cleanup block at top:

```js
for (const sub of ['p_test_alpha', 'p_test_alpha_2', 'p_test_beta', 'p_test_charters']) {
  rmSync(resolve(STATE_DIR, sub), { recursive: true, force: true });
}
```

(Adjust the existing list rather than duplicating — final list should be all four entries.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/server && npm test`
Expected: FAIL — charters not yet wired in createProject.

- [ ] **Step 3: Wire charter generation into createProject**

In `app/server/projects.js`, add this import near the top (after `getRole, listRoles` import):

```js
import { generateProjectCharters } from './charters.js';
```

At the end of `createProject` (just before `return project;`), insert:

```js
  // Generate per-project charters (falls back to base verbatim on failure).
  await generateProjectCharters(project);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/server && npm test`
Expected: PASS — all tests pass. Charter customization will use fallback (no API key in test env), but the base-charter content satisfies the heading assertions.

- [ ] **Step 5: Commit**

```bash
git add app/server/projects.js app/server/projects.test.js
git commit -m "feat(server): generate per-project charters on project creation"
```

### Task 1.6 — Project + role HTTP routes

**Files:**
- Modify: `app/server/server.js`

- [ ] **Step 1: Add the routes**

In `app/server/server.js`, add these imports after the existing top-level imports:

```js
import { listRoles } from './roles.js';
import { listProjects, getProject, createProject, setAgentEnabled } from './projects.js';
```

After the `app.get('/health', ...)` line, insert:

```js
app.get('/roles', (_req, res) => {
  res.json({ roles: listRoles() });
});

app.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

app.get('/projects/:pid', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  res.json(p);
});

app.post('/projects', async (req, res) => {
  try {
    const { name, goal, roleIds } = req.body || {};
    const p = await createProject({ name, goal, roleIds });
    res.json(p);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.patch('/projects/:pid/agents/:aid', (req, res) => {
  try {
    const r = setAgentEnabled(req.params.pid, req.params.aid, !!req.body?.enabled);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json(r.agent);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});
```

- [ ] **Step 2: Boot and smoke-test routes**

Run:

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
echo "=== /roles ==="; curl -s http://localhost:4317/roles | head -c 200; echo
echo "=== /projects (empty) ==="; curl -s http://localhost:4317/projects
echo "=== POST /projects ==="; curl -s -X POST http://localhost:4317/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","goal":"smoke test","roleIds":["pm","engineer"]}'
echo "=== /projects (after) ==="; curl -s http://localhost:4317/projects | head -c 400
kill $SERVER_PID
```

Expected: `/roles` returns 14 roles; `/projects` is `{projects:[]}` initially; POST returns the created project; subsequent GET shows it.

- [ ] **Step 3: Clean up the smoke-test project**

```bash
rm -rf app/state/p_*_smoke app/state/projects.json
```

- [ ] **Step 4: Commit**

```bash
git add app/server/server.js
git commit -m "feat(server): add /roles and /projects routes"
```

### Task 1.7 — Note routes scoped to project

**Files:**
- Modify: `app/server/backends/notes.js`
- Modify: `app/server/server.js`

- [ ] **Step 1: Read current notes backend**

Run: `cat app/server/backends/notes.js`
Goal: understand existing signatures (`listNotes`, `readNote`, `appendNote`) so the project-scoped rewrite preserves them.

- [ ] **Step 2: Rewrite notes backend to be project-scoped**

Replace `app/server/backends/notes.js` with:

```js
/* Bridge — project-scoped markdown notes. One file per note under
 * app/state/<projectId>/notes/. */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', '..', 'state');

function notesDir(projectId) {
  const dir = resolve(STATE_DIR, projectId, 'notes');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function deriveLabel(body) {
  const firstLine = String(body).split('\n')[0].trim();
  return firstLine.slice(0, 60) || 'note';
}

export function listNotes(projectId) {
  const dir = notesDir(projectId);
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .map(f => {
      const body = readFileSync(join(dir, f), 'utf8');
      return { id: f.replace(/\.md$/, ''), label: deriveLabel(body) };
    });
}

export function readNote(projectId, id) {
  const path = join(notesDir(projectId), `${id}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function appendNote(projectId, body) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(notesDir(projectId), `${id}.md`), body, 'utf8');
  return { id, label: deriveLabel(body) };
}
```

- [ ] **Step 3: Add project-scoped notes routes**

In `app/server/server.js`, add this import:

```js
import { listNotes, readNote, appendNote } from './backends/notes.js';
```

(Replace any existing import of these — none currently in the post-Phase-0 file.)

After the existing `/projects/:pid/agents/:aid` route, add:

```js
app.get('/projects/:pid/notes', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  res.json({ items: listNotes(req.params.pid) });
});

app.get('/projects/:pid/notes/:nid', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const body = readNote(req.params.pid, req.params.nid);
  if (body == null) return res.status(404).json({ error: 'not found' });
  res.json({ id: req.params.nid, body });
});

app.post('/projects/:pid/notes', (req, res) => {
  if (!getProject(req.params.pid)) return res.status(404).json({ error: 'unknown project' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty note' });
  res.json(appendNote(req.params.pid, body));
});
```

- [ ] **Step 4: Smoke-test note flow**

Run:

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
PID=$(curl -s -X POST http://localhost:4317/projects -H 'Content-Type: application/json' \
  -d '{"name":"NoteTest","goal":"notes work","roleIds":["pm"]}' | node -e 'process.stdin.on("data",d=>{const j=JSON.parse(d);console.log(j.id)})')
echo "project: $PID"
curl -s -X POST "http://localhost:4317/projects/$PID/notes" -H 'Content-Type: application/json' -d '{"body":"buy milk"}'
echo
curl -s "http://localhost:4317/projects/$PID/notes"
kill $SERVER_PID
rm -rf "app/state/$PID" app/state/projects.json
```

Expected: POST returns `{id,label:"buy milk"}`; GET returns one item.

- [ ] **Step 5: Commit**

```bash
git add app/server/backends/notes.js app/server/server.js
git commit -m "feat(server): scope notes per-project"
```

### Task 1.8 — Per-agent interpret with charter-aware system prompt

**Files:**
- Modify: `app/server/orchestrator.js`
- Modify: `app/server/server.js`

- [ ] **Step 1: Rewrite orchestrator to take project+agent identity and inject charter**

Replace the contents of `app/server/orchestrator.js` with:

```js
import { listNotes } from './backends/notes.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getProject } from './projects.js';
import { readProjectCharter } from './charters.js';
import { getRole } from './roles.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* Tile-spec contract is unchanged from Bridge MVP — see prior README. */

function systemPrompt({ project, agent, sharedFrom }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project.id, agent.role);
  const sharedBlock = (Array.isArray(sharedFrom) && sharedFrom.length)
    ? `\nContext shared with you by your teammates:\n` +
      sharedFrom.map(s => `- ${s.fromAgentName} (${s.fromRole}): "${String(s.snippet).slice(0, 240)}"`).join('\n') +
      `\nUse this only if it bears on the user's request. Do not summarise it back unless asked.\n`
    : '';
  return `You are ${agent.name}, the ${role.label} on project "${project.name}". Project goal: "${project.goal}".

Your charter for this project:
---
${charter}
---
${sharedBlock}
Stay in role and on-goal. Speak briefly, in first person when relevant. The user is talking to you specifically.

Your job: classify the user's intent and return a single JSON object describing the tile surface to render. No prose, no markdown, no code fences. JSON only.

There are exactly three intent kinds:

1. take_note — the user wants to save a note. Output:
   { "intent": "take_note", "template": "compose", "context": "New note", "title": "Save this note?",
     "body": "<extracted note>", "actions": [
       { "verb": "Save",   "glyph": "cross",  "action": { "type": "save_note" } },
       { "verb": "Cancel", "glyph": "circle", "action": { "type": "cancel" } } ] }

2. list_notes — the user wants to see notes. Output:
   { "intent": "list_notes", "template": "list", "context": "Your notes", "title": "Pick a note to read",
     "actions": [
       { "verb": "Open", "glyph": "cross",  "action": { "type": "open_note" } },
       { "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } } ] }
   (orchestrator fills items.)

3. answer — anything else. Output:
   { "intent": "answer", "template": "reader", "context": "Answer", "title": "<short>",
     "body": "<concise spoken-friendly answer>",
     "actions": [{ "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } }] }

Rules: single JSON object. No markdown, no commentary. "body" is read aloud — keep speakable. Allowed glyphs: cross | circle | square | triangle.`;
}

export async function interpretIntent({ projectId, agentId, text, sharedFrom }) {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const agent = project.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  appendTurn(agentId, 'user', text);

  if (!apiKey || apiKey.includes('replace-me')) {
    const spec = fallbackSpec(text, 'OPENROUTER_API_KEY missing — using local classifier.');
    return hydrateSpec(spec, { project, agent, text });
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';

  const history = getContext(agentId).messages.slice(0, -1);
  const messages = [
    { role: 'system', content: systemPrompt({ project, agent, sharedFrom }) },
    ...history,
    { role: 'user', content: text },
  ];

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost/bridge',
      'X-Title': `Bridge - ${agent.name}`,
    },
    body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  appendTurn(agentId, 'assistant', raw);
  const spec = parseSpec(raw);
  return hydrateSpec(spec, { project, agent, text });
}

function parseSpec(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('model did not return JSON');
  }
}

function hydrateSpec(spec, { project, text }) {
  if (spec.intent === 'list_notes') {
    spec.items = listNotes(project.id).map(n => ({ id: n.id, label: n.label }));
    if (spec.items.length === 0) {
      return {
        intent: 'answer', template: 'reader',
        context: 'Your notes', title: 'No notes yet',
        body: "You haven't saved any notes yet. Try saying: take a note, followed by what you want to remember.",
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      };
    }
  }
  spec._intentText = text;
  return spec;
}

function fallbackSpec(text, note) {
  const t = text.toLowerCase();
  if (/^(take a note|note|remember|jot|write down)/.test(t)) {
    const body = text.replace(/^(take a note[:,]?|note[:,]?|remember(?: that)?|jot(?: down)?|write down)\s*/i, '').trim() || text;
    return {
      intent: 'take_note', template: 'compose',
      context: 'New note', title: 'Save this note?', body,
      actions: [
        { verb: 'Save',   glyph: 'cross',  action: { type: 'save_note' } },
        { verb: 'Cancel', glyph: 'circle', action: { type: 'cancel' } },
      ],
      _intentText: text, _note: note,
    };
  }
  if (/(show|read|list|see).*(note|notes)/.test(t) || /^notes$/.test(t)) {
    return {
      intent: 'list_notes', template: 'list',
      context: 'Your notes', title: 'Pick a note to read',
      actions: [
        { verb: 'Open', glyph: 'cross',  action: { type: 'open_note' } },
        { verb: 'Back', glyph: 'circle', action: { type: 'cancel' } },
      ],
    };
  }
  return {
    intent: 'answer', template: 'reader',
    context: 'Answer', title: 'Bridge is offline',
    body: note + ' I need an API key to answer free-form questions. Try: "take a note" or "show my notes".',
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    _intentText: text, _note: note,
  };
}
```

- [ ] **Step 2: Add per-agent interpret routes**

In `app/server/server.js`, add this import:

```js
import { interpretIntent } from './orchestrator.js';
import { setLastSpec } from './scratchpad.js';
```

After the notes routes, add:

```js
app.post('/projects/:pid/agents/:aid/interpret', async (req, res) => {
  const { pid, aid } = req.params;
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const spec = await interpretIntent({ projectId: pid, agentId: aid, text });
    setLastSpec(aid, spec);
    res.json(spec);
  } catch (err) {
    console.error(`[interpret:${aid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/projects/:pid/agents/:aid/spec', (req, res) => {
  setLastSpec(req.params.aid, req.body?.spec || null);
  res.json({ ok: true });
});
```

- [ ] **Step 3: Smoke-test interpret end-to-end (no key — fallback path)**

Run:

```bash
cd app/server && unset OPENROUTER_API_KEY; node server.js &
SERVER_PID=$!
sleep 1
PID=$(curl -s -X POST http://localhost:4317/projects -H 'Content-Type: application/json' \
  -d '{"name":"InterpretTest","goal":"verify interpret","roleIds":["pm"]}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
AID="${PID}__pm"
echo "=== take a note (fallback) ==="
curl -s -X POST "http://localhost:4317/projects/$PID/agents/$AID/interpret" \
  -H 'Content-Type: application/json' -d '{"text":"take a note: buy milk"}'
echo
kill $SERVER_PID
rm -rf "app/state/$PID" app/state/projects.json
```

Expected: returns a JSON tile-spec with `intent:"take_note"`, `body:"buy milk"`.

- [ ] **Step 4: Commit**

```bash
git add app/server/orchestrator.js app/server/server.js
git commit -m "feat(server): project+agent-scoped interpret with charter injection"
```

---

## Phase 2 — Renderer foundation: project picker (L0)

App becomes usable again at this phase — empty project picker, "+ New" tile opens create flow (stubbed in Phase 3). Existing zoom UI is gutted; replaced by stub messages so the renderer parses and runs.

### Task 2.1 — Add nav modes scaffolding to main.js

**Files:**
- Modify: `app/renderer/main.js`

- [ ] **Step 1: Introduce the new modes and gut existing agent loading**

Replace the `App state` block (currently lines 17–27) in `app/renderer/main.js` with:

```js
/* ---------- App state ---------- */
const MODE_PROJECTS         = 'projects';          // L0
const MODE_NEW_PROJ_ROLES   = 'new_project_roles'; // create-flow step 1
const MODE_NEW_PROJ_NAME    = 'new_project_name';  // create-flow step 2
const MODE_NEW_PROJ_GOAL    = 'new_project_goal';  // create-flow step 3
const MODE_GRID             = 'grid';              // L1 (project grid)
const MODE_ZOOM             = 'zoom';              // L2 (agent zoom)

let mode = MODE_PROJECTS;
let projects = [];                // [{ id, name, agents, ... }]
let pickerIndex = 0;              // focus index on project picker (0..N where N = "+ New")
let activeProject = null;         // project record at L1/L2
let zoomedIndex = 0;
let gridIndex = 0;
let agentBusy = {};
let inflightController = null;
let pttActive = false;

// Create-project flow state
let newProjRoleIds = [];          // toggled during step 1
let newProjName    = '';          // captured during step 2
let newProjGoal    = '';          // captured during step 3
```

- [ ] **Step 2: Replace `loadAgents` with `loadProjects`**

Replace `loadAgents` (lines 30–34) with:

```js
async function loadProjects() {
  const r = await fetch('/projects');
  const data = await r.json();
  projects = data.projects || [];
}
```

Search the file for any remaining call to `loadAgents()` and replace it with `loadProjects()`. Also delete the line `let agents = [];` that no longer exists in the new state block (it's been replaced).

- [ ] **Step 3: Replace the boot block**

Replace the existing boot block (the final IIFE) with:

```js
(async () => {
  await loadProjects();
  renderProjects();
  setIndicator('idle', 'Ready');
  console.log('[bridge] L0 ready. ✕ open project, "+ New" to create.');
})();
```

- [ ] **Step 4: Stub renderProjects/renderGrid/renderZoom**

Above the existing `function summarizeLastSpec`, insert these stubs (Phase 2 will fill them; existing renderGrid/renderZoom get replaced fully in later tasks — for now we need the names to resolve):

```js
function renderProjects() { surfaceEl.innerHTML = '<p style="padding:2rem">Project picker — populated next task.</p>'; }
```

Delete the existing `renderGrid` body and replace with:

```js
function renderGrid() { surfaceEl.innerHTML = '<p style="padding:2rem">Project grid — Phase 3.</p>'; }
```

Delete the existing `renderZoom` body and replace with:

```js
function renderZoom() { surfaceEl.innerHTML = '<p style="padding:2rem">Agent zoom — Phase 3.</p>'; }
```

This will break button dispatch temporarily — that's expected; later tasks rewire it.

- [ ] **Step 5: Boot the app and confirm it loads**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
curl -sf http://localhost:4317/ >/dev/null && echo "renderer OK"
kill $SERVER_PID
```

Open `http://localhost:4317/` in Chrome — should show "Project picker — populated next task." with no console errors.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/main.js
git commit -m "feat(renderer): add nav-mode scaffolding for L0/L1/L2"
```

### Task 2.2 — Project picker rendering

**Files:**
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`
- Modify: `app/renderer/tiles.js` (only if a new template helper is needed; otherwise inline)

- [ ] **Step 1: Implement renderProjects**

Replace the `renderProjects` stub in `main.js` with:

```js
function renderProjects() {
  mode = MODE_PROJECTS;
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setContextLabel('Bridge — projects');
  surfaceEl.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'project-picker';

  const tileEls = [];
  for (const p of projects) {
    const tile = document.createElement('div');
    tile.className = 'project-tile';
    tile.dataset.projectId = p.id;
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(p.name)}</h2>
      <div class="meta">${p.agents.length} member${p.agents.length===1?'':'s'}</div>`;
    tile.addEventListener('click', () => { pickerIndex = tileEls.length; ring.set(tileEls); openFocused(); });
    grid.appendChild(tile);
    tileEls.push(tile);
  }
  // "+ New" tile
  const plus = document.createElement('div');
  plus.className = 'project-tile new-project';
  plus.innerHTML = `<h2 class="name">+ New project</h2><div class="meta">create a team</div>`;
  plus.addEventListener('click', () => { pickerIndex = tileEls.length; ring.set([...tileEls, plus]); openFocused(); });
  grid.appendChild(plus);
  tileEls.push(plus);

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(pickerIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([
    { verb: 'Open',   glyph: 'cross',  action: { type: '_picker_open' } },
  ]);
}

function openFocused() {
  const idx = ring.index;
  if (idx === tileCount() - 1) {
    // "+ New" — enter create flow
    newProjRoleIds = [];
    newProjName = '';
    newProjGoal = '';
    renderNewProjectRoles();
  } else {
    activeProject = projects[idx];
    gridIndex = 0;
    zoomedIndex = 0;
    renderGrid();
  }
}

function tileCount() { return projects.length + 1; }
```

- [ ] **Step 2: Stub the create-flow renderers (will be filled in Phase 3)**

Add to `main.js` (above the dispatch block):

```js
function renderNewProjectRoles() { surfaceEl.innerHTML = '<p style="padding:2rem">Role picker — Phase 3.</p>'; mode = MODE_NEW_PROJ_ROLES; }
function renderNewProjectName()  { surfaceEl.innerHTML = '<p style="padding:2rem">Name capture — Phase 3.</p>'; mode = MODE_NEW_PROJ_NAME; }
function renderNewProjectGoal()  { surfaceEl.innerHTML = '<p style="padding:2rem">Goal capture — Phase 3.</p>'; mode = MODE_NEW_PROJ_GOAL; }
```

- [ ] **Step 3: Update gamepad press dispatch for L0**

Replace the entire `gp.addEventListener('press', ...)` handler (lines around 424-439 pre-edit; verify with `grep -n "press'," app/renderer/main.js`) with:

```js
gp.addEventListener('press', (e) => {
  const b = e.detail.button;
  if (b === 'l2') { speakFocusedAgentName(); return; }

  if (mode === MODE_PROJECTS) {
    if (b === 'left' || b === 'right' || b === 'up' || b === 'down') {
      pickerMove(b);
    } else if (b === 'cross') {
      openFocused();
    }
    return;
  }

  if (mode === MODE_GRID) {
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') gridMove(b);
    else if (b === 'cross')   enterZoom();
    else if (b === 'circle')  exitToProjects();
    else if (b === 'square')  toggleFocusedAgentEnabled();
    return;
  }

  if (mode === MODE_ZOOM) {
    if (b === 'up' || b === 'left')      ring.move(-1);
    else if (b === 'down' || b === 'right') ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'triangle')           toggleHistoryDrawer();
    return;
  }

  // Create-flow modes wired in Phase 3
});

gp.addEventListener('press', (e) => {
  if (e.detail.button === 'options') toggleFileExplorer();
});
```

Add the helpers (some are stubs filled later, listed here so the file parses):

```js
function pickerMove(dir) {
  // Picker is a 1-row wrap. up/down treat as left/right for simplicity at MVP scale.
  const n = tileCount();
  if (n <= 1) return;
  if (dir === 'left' || dir === 'up')    ring.index = (ring.index + n - 1) % n;
  if (dir === 'right' || dir === 'down') ring.index = (ring.index + 1) % n;
  pickerIndex = ring.index;
  ring.paint();
}
function exitToProjects() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  activeProject = null;
  renderProjects();
}
function toggleFocusedAgentEnabled() { /* Phase 5 */ }
function toggleHistoryDrawer()       { /* Phase 6 */ }
function toggleFileExplorer()        { /* Phase 7 */ }
function speakFocusedAgentName() {
  // Phase-2 version: at L0 speak focused project name; later versions add grid/zoom cases.
  if (mode === MODE_PROJECTS) {
    const p = ring.index < projects.length ? projects[ring.index] : null;
    if (p) { stopSpeaking(); speak(p.name); }
  } else if (mode === MODE_GRID || mode === MODE_ZOOM) {
    const agent = mode === MODE_ZOOM ? currentAgent() : (activeProject?.agents?.[gridIndex] ?? null);
    if (agent) { stopSpeaking(); speak(agent.name); }
  }
}
function currentAgent() { return activeProject?.agents?.[zoomedIndex] || null; }
```

Delete the prior `currentAgent()` and `speakFocusedAgentName()` definitions earlier in the file so they're only defined once.

- [ ] **Step 4: Add picker CSS**

Append to `app/renderer/style.css`:

```css
.project-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  padding: 1rem;
}
.project-tile {
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  padding: 1.25rem;
  background: rgba(255,255,255,0.04);
  cursor: pointer;
  transition: transform 80ms ease, background 80ms ease;
}
.project-tile.new-project { border-style: dashed; opacity: 0.85; }
.project-tile .name { font-size: 1.4rem; margin: 0 0 0.5rem 0; }
.project-tile .meta { opacity: 0.6; font-size: 0.9rem; }
.project-tile.focused { background: rgba(110,168,255,0.16); transform: translateY(-2px); }
```

The existing focus ring sets the `focused` class on the element via `FocusRing.paint()`. Verify by reading `app/renderer/focus.js`.

- [ ] **Step 5: Boot and manually verify**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
```

Open `http://localhost:4317/`. Expected:
- Empty project picker showing only "+ New project" tile, focused.
- Pressing D-pad left/right (or arrow keys after wiring keyboard — see step 6) navigates focus.
- Pressing Cross / Enter on "+ New" shows "Role picker — Phase 3." stub.
- Console has no errors.

Stop the server: `kill $SERVER_PID`

- [ ] **Step 6: Wire keyboard analogs**

Replace the existing `window.addEventListener('keydown', ...)` block with:

```js
window.addEventListener('keydown', (e) => {
  if (document.activeElement === typedInput) {
    if (e.key === 'Enter') {
      const t = typedInput.value.trim();
      typedInput.value = ''; typedWrap.hidden = true;
      if (t) submitTypedText(t);
    } else if (e.key === 'Escape') {
      typedInput.value = ''; typedWrap.hidden = true;
    }
    return;
  }
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); return; }

  if (e.key === '\\') { e.preventDefault(); toggleFileExplorer(); return; }
  if (e.key === '/')  { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); return; }

  // Mode-specific keys
  const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const dir = dirMap[e.key];

  if (mode === MODE_PROJECTS) {
    if (dir) { e.preventDefault(); pickerMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); openFocused(); }
  } else if (mode === MODE_GRID) {
    if (dir) { e.preventDefault(); gridMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitToProjects(); }
  } else if (mode === MODE_ZOOM) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')      { e.preventDefault(); ring.move(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
    else if (e.key === 'Enter')      { e.preventDefault(); pressCross(); }
    else if (e.key === 'Escape')     { e.preventDefault(); pressCircle(); }
    else if (e.key === '[')          { e.preventDefault(); cycleAgent(-1); }
    else if (e.key === ']')          { e.preventDefault(); cycleAgent(+1); }
    else if (e.key === 't')          { e.preventDefault(); toggleHistoryDrawer(); }
  }
});

function submitTypedText(text) {
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = text; renderNewProjectGoal(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = text; finalizeNewProject(); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
}

// Placeholders — wired in later phases
function submitIntent(text) { /* Phase 3 */ }
function submitTeamIntent(text) { /* Phase 8 */ }
function finalizeNewProject() { /* Phase 3 */ }
```

- [ ] **Step 7: Commit**

```bash
git add app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): L0 project picker with empty state and + New tile"
```

---

## Phase 3 — Create-project flow (steps 1–3 + finalize)

End-state: user can navigate the role picker, capture a name and goal via PTT or typed, the project is persisted, and the user lands at L1 grid (rendered with reflow layout) with stub zoom on each tile.

### Task 3.1 — Role picker (step 1)

**Files:**
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Implement renderNewProjectRoles**

Replace the stub with:

```js
async function renderNewProjectRoles() {
  mode = MODE_NEW_PROJ_ROLES;
  setContextLabel('New project — pick roles');
  surfaceEl.innerHTML = '';

  // Lazy-load role catalog
  if (!window._roles) {
    const r = await fetch('/roles');
    const data = await r.json();
    window._roles = data.roles;
  }
  const roles = window._roles;

  const wrap = document.createElement('section');
  wrap.className = 'role-picker';
  const grid = document.createElement('div');
  grid.className = 'role-grid';

  const tileEls = [];
  for (const role of roles) {
    const sample = role.namePool[0];
    const t = document.createElement('div');
    t.className = 'role-tile';
    t.dataset.roleId = role.id;
    t.style.setProperty('--tile-color', role.color);
    t.innerHTML = `
      <div class="role-label">${role.label}</div>
      <div class="role-sample">${sample}</div>
      <div class="role-toggle">${newProjRoleIds.includes(role.id) ? '◉' : '○'}</div>`;
    t.addEventListener('click', () => { ring.moveTo(el => el === t); toggleFocusedRole(); });
    grid.appendChild(t);
    tileEls.push(t);
  }
  wrap.appendChild(grid);
  surfaceEl.appendChild(wrap);

  ring.set(tileEls);
  ring.index = 0;
  ring.paint();

  renderActionBar([
    { verb: 'Toggle', glyph: 'cross',    action: { type: '_role_toggle' } },
    { verb: 'Next',   glyph: 'triangle', action: { type: '_role_next' } },
    { verb: 'Back',   glyph: 'circle',   action: { type: '_role_back' } },
  ]);
}

function toggleFocusedRole() {
  const cur = ring.current();
  if (!cur) return;
  const id = cur.dataset.roleId;
  if (!id) return;
  const idx = newProjRoleIds.indexOf(id);
  if (idx >= 0) newProjRoleIds.splice(idx, 1);
  else newProjRoleIds.push(id);
  // Repaint the one tile
  cur.querySelector('.role-toggle').textContent = newProjRoleIds.includes(id) ? '◉' : '○';
}
```

- [ ] **Step 2: Extend press dispatch for role-picker mode**

Inside the existing `gp.addEventListener('press', ...)` handler, add a branch for `MODE_NEW_PROJ_ROLES` immediately above the `// Create-flow modes wired in Phase 3` comment, replacing that comment:

```js
  if (mode === MODE_NEW_PROJ_ROLES) {
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') {
      // Role grid uses 4-column layout — match gridMove logic
      roleGridMove(b);
    } else if (b === 'cross')    toggleFocusedRole();
    else if (b === 'triangle')   advanceFromRolePicker();
    else if (b === 'circle')     renderProjects();
    return;
  }
  if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    if (b === 'cross')   confirmCapture();
    else if (b === 'circle') goBackInCreateFlow();
    return;
  }
```

Add helpers:

```js
function roleGridMove(dir) {
  const cols = 4;
  const n = ring.elements.length;
  const i = ring.index;
  const r = Math.floor(i / cols), c = i % cols;
  const rows = Math.ceil(n / cols);
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  let next = nr * cols + nc;
  if (next >= n) next = n - 1;
  ring.index = next;
  ring.paint();
}

function advanceFromRolePicker() {
  if (newProjRoleIds.length === 0) {
    setIndicator('error', 'Pick at least one role');
    setTimeout(() => setIndicator('idle', 'Ready'), 1500);
    return;
  }
  renderNewProjectName();
}

function goBackInCreateFlow() {
  if (mode === MODE_NEW_PROJ_GOAL) renderNewProjectName();
  else if (mode === MODE_NEW_PROJ_NAME) renderNewProjectRoles();
  else renderProjects();
}

function confirmCapture() {
  if (mode === MODE_NEW_PROJ_NAME) {
    if (!newProjName.trim()) { setIndicator('error', 'Speak or type a name'); return; }
    renderNewProjectGoal();
  } else if (mode === MODE_NEW_PROJ_GOAL) {
    if (!newProjGoal.trim()) { setIndicator('error', 'Speak or type a goal'); return; }
    finalizeNewProject();
  }
}
```

Note: `ring.elements` may not exist on the current `FocusRing`. If `focus.js` only exposes `set/index/move/paint/current/moveTo`, expose elements by adding `this.els` reference in `set()`:

In `app/renderer/focus.js`, ensure `set(elements)` stores them as `this.els = elements;` and add a getter `get elements() { return this.els || []; }`. Read `focus.js` first to see what's there and adjust minimally.

- [ ] **Step 3: Add role-picker CSS**

Append to `style.css`:

```css
.role-picker { padding: 1rem; }
.role-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
}
.role-tile {
  border: 2px solid var(--tile-color, #555);
  border-radius: 10px;
  padding: 0.9rem;
  background: rgba(255,255,255,0.03);
  cursor: pointer;
}
.role-tile.focused { background: rgba(255,255,255,0.10); transform: translateY(-2px); }
.role-label  { font-weight: 600; }
.role-sample { font-size: 0.85rem; opacity: 0.7; margin-top: 0.2rem; }
.role-toggle { font-size: 1.4rem; margin-top: 0.5rem; }
```

- [ ] **Step 4: Manually verify**

Boot the server, open the app, press Cross/Enter on "+ New project". Verify:
- 14 role tiles render in a 4-column grid.
- D-pad / arrow keys navigate; focus ring follows.
- Cross/Enter toggles the focused tile (◉ ↔ ○).
- Triangle/T advances to "Name capture" stub.
- Circle/Esc goes back to project picker.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/main.js app/renderer/style.css app/renderer/focus.js
git commit -m "feat(renderer): role-picker step of create-project flow"
```

### Task 3.2 — Name and goal capture (PTT + typed)

**Files:**
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Implement the two capture screens**

Replace the `renderNewProjectName` and `renderNewProjectGoal` stubs with:

```js
function renderNewProjectName() {
  mode = MODE_NEW_PROJ_NAME;
  setContextLabel('New project — name');
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>Name this project</h2>
    <p class="hint">Hold <kbd>R2</kbd> and speak — or press <kbd>/</kbd> to type.</p>
    <div class="capture-value">${escapeHtml(newProjName) || '<span class="placeholder">(speak now)</span>'}</div>
    ${newProjRoleIds.includes('pm') || newProjRoleIds.includes('tpm')
      ? ''
      : '<div class="lead-badge">Cadence will lead this team.</div>'}`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Confirm', glyph: 'cross',  action: { type: '_capture_confirm' } },
    { verb: 'Back',    glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  ring.set([]);
}

function renderNewProjectGoal() {
  mode = MODE_NEW_PROJ_GOAL;
  setContextLabel('New project — goal');
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>What is this project's goal?</h2>
    <p class="hint">Hold <kbd>R2</kbd> and describe it — or press <kbd>/</kbd> to type.</p>
    <div class="capture-value">${escapeHtml(newProjGoal) || '<span class="placeholder">(speak now)</span>'}</div>`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Confirm', glyph: 'cross',  action: { type: '_capture_confirm' } },
    { verb: 'Back',    glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  ring.set([]);
}
```

- [ ] **Step 2: Route PTT speech results into capture state**

Find the existing `speech.addEventListener('end', ...)` handler and replace its body with:

```js
speech.addEventListener('end', (e) => {
  const text = e.detail;
  if (!text) {
    setIndicator('idle', 'No speech detected');
    setTimeout(() => setIndicator('idle', 'Ready'), 1500);
    return;
  }
  if (mode === MODE_NEW_PROJ_NAME) {
    newProjName = text;
    renderNewProjectName();
    setIndicator('idle', 'Ready');
    return;
  }
  if (mode === MODE_NEW_PROJ_GOAL) {
    newProjGoal = text;
    renderNewProjectGoal();
    setIndicator('idle', 'Ready');
    return;
  }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
});
```

Verify `startPTT` allows PTT in the new capture modes — find its guard `if (pttActive || mode !== MODE_ZOOM) return;` and replace with:

```js
const PTT_MODES = new Set([MODE_ZOOM, MODE_GRID, MODE_NEW_PROJ_NAME, MODE_NEW_PROJ_GOAL]);
function startPTT() {
  if (pttActive || !PTT_MODES.has(mode)) return;
  pttActive = true;
  stopSpeaking();
  if (!speech.supported) {
    setIndicator('error', 'Speech not supported — press / to type');
    typedWrap.hidden = false;
    typedInput.focus();
    pttActive = false;
    return;
  }
  setIndicator('listening', 'Listening…');
  speech.start();
}
```

- [ ] **Step 3: Implement finalizeNewProject**

Replace the stub with:

```js
async function finalizeNewProject() {
  setIndicator('thinking', 'Customizing team charters…');
  try {
    const r = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjName.trim(), goal: newProjGoal.trim(), roleIds: newProjRoleIds }),
    });
    if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
    const project = await r.json();
    await loadProjects();
    activeProject = project;
    pickerIndex = projects.findIndex(p => p.id === project.id);
    gridIndex = 0; zoomedIndex = 0;
    setIndicator('idle', 'Ready');
    renderGrid();
  } catch (err) {
    setIndicator('error', 'Create failed');
    console.error(err);
  }
}
```

- [ ] **Step 4: Add capture-tile CSS**

Append to `style.css`:

```css
.capture-tile {
  padding: 2rem;
  max-width: 720px;
  margin: 0 auto;
}
.capture-tile h2 { margin: 0 0 0.5rem; font-size: 1.6rem; }
.capture-tile .hint { opacity: 0.6; margin-bottom: 1.5rem; }
.capture-tile .capture-value {
  font-size: 1.4rem;
  min-height: 2.5em;
  padding: 1rem;
  background: rgba(255,255,255,0.06);
  border-radius: 8px;
}
.capture-tile .placeholder { opacity: 0.4; }
.capture-tile .lead-badge {
  margin-top: 1rem;
  font-size: 0.9rem;
  opacity: 0.75;
}
```

- [ ] **Step 5: Manually verify end-to-end**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
```

In the app: press "+ New" → toggle 2-3 roles (e.g., PM, Engineer, QA) → Triangle → PTT or type a name → Cross → PTT or type a goal → Cross. Expected:
- Indicator shows "Customizing team charters…" briefly.
- App lands at L1 stub showing the project name in the context label.
- `app/state/projects.json` contains the project.
- `app/state/<projectId>/roles/{pm,engineer,qa}.md` exist.

Stop server: `kill $SERVER_PID`

- [ ] **Step 6: Commit**

```bash
git add app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): name + goal capture steps with PTT/typed inputs"
```

### Task 3.3 — Project grid with reflow layout

**Files:**
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Implement renderGrid with reflow**

Replace the `renderGrid` stub with:

```js
function gridLayout(n) {
  // returns {cols, rows} for reflow
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 8) return { cols: 4, rows: 2 };
  if (n <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

function renderGrid() {
  if (!activeProject) return renderProjects();
  mode = MODE_GRID;
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setContextLabel(activeProject.name);
  surfaceEl.innerHTML = '';

  const { cols, rows } = gridLayout(activeProject.agents.length);
  const grid = document.createElement('div');
  grid.className = 'agent-grid';
  grid.style.setProperty('--grid-cols', cols);
  grid.style.setProperty('--grid-rows', rows);
  grid._cols = cols;
  grid._rows = rows;

  const tileEls = activeProject.agents.map((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    if (!a.enabled) tile.dataset.disabled = 'true';
    if (a.id === activeProject.leadAgentId) tile.dataset.lead = 'true';
    tile.style.setProperty('--tile-color', a.color);
    tile.dataset.agentId = a.id;
    tile.dataset.busy = agentBusy[a.id] ? 'true' : 'false';
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(a.name)}</h2>
      <div class="role">${escapeHtml(roleLabel(a.role))}</div>
      <div class="status"><span class="dot"></span><span>${agentBusy[a.id] ? 'thinking…' : 'idle'}</span></div>`;
    tile.addEventListener('click', () => { gridIndex = i; ring.set(tileEls); ring.index = i; ring.paint(); enterZoom(); });
    grid.appendChild(tile);
    return tile;
  });

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(gridIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([
    { verb: 'Open',     glyph: 'cross',  action: { type: '_grid_open' } },
    { verb: 'Disable',  glyph: 'square', action: { type: '_grid_toggle_enabled' } },
    { verb: 'Projects', glyph: 'circle', action: { type: '_grid_back' } },
  ]);
}

function roleLabel(roleId) {
  return (window._roles || []).find(r => r.id === roleId)?.label || roleId;
}
```

Also replace `gridMove` with one that reads cols/rows from the grid:

```js
function gridMove(dir) {
  if (mode !== MODE_GRID) return;
  const grid = surfaceEl.querySelector('.agent-grid');
  if (!grid) return;
  const cols = grid._cols, rows = grid._rows;
  const n = ring.elements.length;
  const i = ring.index;
  const r = Math.floor(i / cols), c = i % cols;
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  let next = nr * cols + nc;
  if (next >= n) next = n - 1;
  ring.index = next;
  gridIndex = next;
  ring.paint();
}
```

Ensure `window._roles` is loaded before `roleLabel` is called: in `loadProjects`, also fetch `/roles` once and cache it:

```js
async function loadProjects() {
  const [pj, rj] = await Promise.all([fetch('/projects'), fetch('/roles')]);
  projects = (await pj.json()).projects || [];
  window._roles = (await rj.json()).roles || [];
}
```

- [ ] **Step 2: Add agent-grid CSS with reflow**

Replace the existing `.agent-grid` block in `style.css` (if any) with:

```css
.agent-grid {
  display: grid;
  grid-template-columns: repeat(var(--grid-cols, 4), 1fr);
  grid-template-rows: repeat(var(--grid-rows, 2), 1fr);
  gap: 0.75rem;
  padding: 1rem;
  height: calc(100vh - 8rem);
}
.agent-tile {
  border-top: 4px solid var(--tile-color, #6ea8ff);
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
  padding: 1rem;
  display: flex; flex-direction: column; justify-content: space-between;
  cursor: pointer;
}
.agent-tile.focused { background: rgba(110,168,255,0.16); transform: translateY(-2px); }
.agent-tile .name { margin: 0; font-size: 1.4rem; }
.agent-tile .role { opacity: 0.65; font-size: 0.9rem; }
.agent-tile .status { font-size: 0.8rem; opacity: 0.6; }
.agent-tile[data-disabled="true"] { opacity: 0.4; }
.agent-tile[data-disabled="true"]::after {
  content: "off"; position: absolute; top: 0.4rem; right: 0.6rem;
  font-size: 0.7rem; opacity: 0.6; text-transform: uppercase;
}
.agent-tile[data-lead="true"] { box-shadow: inset 0 0 0 1px rgba(255,255,255,0.20); }
.agent-tile[data-busy="true"] { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.25); }
  50%      { box-shadow: 0 0 0 6px rgba(255,255,255,0.05); }
}
```

- [ ] **Step 3: Manually verify**

Boot the server, create a project with 3 roles. Verify the grid renders as 2x2 with 3 tiles populated, and D-pad/arrows navigate correctly. Repeat with 5, 8, and 14 roles to confirm reflow.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): project grid with reflow layout"
```

---

## Phase 4 — Agent zoom: per-agent prompt UI

End-state: pressing Cross on a tile opens the agent's prompt view; PTT or typed text submits an `interpret` call; responses render as the existing tile templates. L1/R1 cycles enabled agents.

### Task 4.1 — renderZoom with single-bubble + chat history scaffold

**Files:**
- Modify: `app/renderer/main.js`

- [ ] **Step 1: Implement renderZoom**

Replace the `renderZoom` stub with a port of the original Bridge version that uses `activeProject`:

```js
function enterZoom(specOverride) {
  if (!activeProject) return;
  const idx = mode === MODE_ZOOM ? zoomedIndex : gridIndex;
  zoomedIndex = idx;
  mode = MODE_ZOOM;
  renderZoom(specOverride);
}

function renderZoom(specOverride) {
  const agent = currentAgent();
  if (!agent) return renderGrid();
  document.documentElement.style.setProperty('--agent-color', agent.color);
  setContextLabel(`${agent.name} — ${roleLabel(agent.role)}`, agent.color);
  surfaceEl.innerHTML = '';

  const view = document.createElement('section');
  view.className = 'agent-view';
  view.innerHTML = `
    <div class="agent-header">
      <div class="name-large">${escapeHtml(agent.name)}</div>
      <div class="nav-hint">
        <span class="shoulder"><span>L1</span> prev</span>
        <span class="shoulder"><span>R1</span> next</span>
        <span class="shoulder"><span>△</span> history</span>
        <span class="shoulder"><span>○</span> grid</span>
      </div>
    </div>
    <div class="tile-surface"></div>`;
  surfaceEl.appendChild(view);
  const surfaceWrap = view.querySelector('.tile-surface');

  const spec = specOverride ?? agent.lastSpec;
  if (!spec) {
    surfaceWrap.innerHTML = `
      <div class="idle">
        <h3>${escapeHtml(agent.name)}</h3>
        <p>Hold <kbd>R2</kbd> or <kbd>Space</kbd> and speak.</p>
      </div>`;
    renderActionBar([{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }]);
    ring.set([]);
    return;
  }

  const { surface, focusables, autoSpeak } = renderTile(spec);
  surfaceWrap.appendChild(surface);
  const actionButtons = renderActionBar(spec.actions || []);
  ring.set([...focusables, ...actionButtons]);
  for (const btn of actionButtons) {
    btn.addEventListener('click', () => executeAction(btn._action, spec));
  }
  for (const f of focusables) {
    f.addEventListener('click', () => { ring.moveTo(el => el === f); pressCross(); });
  }
  if (autoSpeak && !specOverride?._silent) speak(autoSpeak);
}

function cycleAgent(delta) {
  if (mode !== MODE_ZOOM || !activeProject) return;
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  const n = activeProject.agents.length;
  let i = zoomedIndex;
  for (let k = 0; k < n; k++) {
    i = (i + delta + n) % n;
    if (activeProject.agents[i].enabled) break;
  }
  zoomedIndex = i;
  renderZoom();
}
```

- [ ] **Step 2: Implement submitIntent (per-agent)**

Replace the `submitIntent` stub with:

```js
async function submitIntent(text) {
  const agent = currentAgent();
  if (!agent || mode !== MODE_ZOOM) return;
  if (inflightController) inflightController.abort();
  inflightController = new AbortController();
  const myCtl = inflightController;
  const targetId = agent.id;

  agentBusy[targetId] = true;
  setIndicator('thinking', `${agent.name} is thinking…`);
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${targetId}/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: myCtl.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const spec = await r.json();
    const a = activeProject.agents.find(x => x.id === targetId);
    if (a) a.lastSpec = spec;
    if (mode === MODE_ZOOM && currentAgent()?.id === targetId) {
      setIndicator('idle', 'Ready');
      renderZoom(spec);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setIndicator('error', 'Request failed');
  } finally {
    agentBusy[targetId] = false;
    if (myCtl === inflightController) inflightController = null;
  }
}
```

- [ ] **Step 3: Re-implement executeAction for project-scoped notes**

Replace the existing `executeAction` body (it currently posts to `/notes` globally). Use:

```js
async function executeAction(action, sourceSpec) {
  if (!action) return;
  const type = action.action?.type || action.type;
  if (type === '_grid_open')   { enterZoom(); return; }
  if (type === '_grid_back')   { exitToProjects(); return; }
  if (type === '_grid_toggle_enabled') { toggleFocusedAgentEnabled(); return; }

  const agent = currentAgent();
  if (!agent || !activeProject) return;
  if (type === 'cancel') { exitZoom(); return; }

  if (type === 'save_note') {
    const body = sourceSpec?.body || agent.lastSpec?.body;
    if (!body) return;
    setIndicator('thinking', 'Saving…');
    try {
      const r = await fetch(`/projects/${activeProject.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      const summary = body.length > 60 ? body.slice(0, 60) + '…' : body;
      const ack = {
        intent: 'answer', template: 'reader',
        context: 'Note saved', title: 'Saved',
        body: `Saved your note: ${summary}`,
        actions: [{ verb: 'Done', glyph: 'circle', action: { type: 'cancel' } }],
      };
      agent.lastSpec = ack;
      setIndicator('idle', 'Ready');
      renderZoom(ack);
    } catch (err) {
      setIndicator('error', 'Save failed');
      console.error(err);
    }
    return;
  }

  if (type === 'open_note') {
    const focused = ring.current();
    const id = focused?.dataset?.id;
    if (!id) return;
    try {
      const r = await fetch(`/projects/${activeProject.id}/notes/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(await r.text());
      const { body } = await r.json();
      renderZoom({
        intent: 'answer', template: 'reader',
        context: 'Note', title: id.replace(/T/, ' ').slice(0, 16),
        body,
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      });
    } catch (err) { console.error(err); }
    return;
  }
  console.warn('[action] unknown type:', type, action);
}

function exitZoom() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  mode = MODE_GRID;
  renderGrid();
}

function pressCross() {
  if (mode !== MODE_ZOOM) return;
  const cur = ring.current();
  if (cur?.classList?.contains('action')) executeAction(cur._action, currentAgent()?.lastSpec);
  else if (cur?.classList?.contains('list-row')) {
    const crossBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'cross');
    if (crossBtn) executeAction(crossBtn._action, currentAgent()?.lastSpec);
  } else {
    const crossBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'cross');
    if (crossBtn) executeAction(crossBtn._action, currentAgent()?.lastSpec);
  }
}

function pressCircle() {
  if (mode !== MODE_ZOOM) return;
  const cur = ring.current();
  if (cur?.classList?.contains('action') && cur.dataset.glyph === 'circle') {
    executeAction(cur._action, currentAgent()?.lastSpec);
    return;
  }
  const circleBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'circle');
  if (circleBtn && currentAgent()?.lastSpec) {
    executeAction(circleBtn._action, currentAgent()?.lastSpec);
    return;
  }
  exitZoom();
}
```

- [ ] **Step 4: Smoke-test PTT in zoom**

Boot the server, create a project, open an agent, hold Space (or R2) and say "take a note: ship sunday". Expected: a compose tile appears with "ship sunday"; Cross saves; saved note visible at `app/state/<projectId>/notes/`.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/main.js
git commit -m "feat(renderer): per-agent prompt UI at L2 (zoom)"
```

---

## Phase 5 — Agent enable/disable

End-state: Square at L1 toggles a tile's enabled flag; visual feedback; cycling skips disabled; lead is protected.

### Task 5.1 — Wire toggle to server PATCH

**Files:**
- Modify: `app/renderer/main.js`

- [ ] **Step 1: Implement toggleFocusedAgentEnabled**

Replace the stub with:

```js
async function toggleFocusedAgentEnabled() {
  if (mode !== MODE_GRID || !activeProject) return;
  const agent = activeProject.agents[gridIndex];
  if (!agent) return;
  if (agent.id === activeProject.leadAgentId) {
    setIndicator('error', "Lead can't be disabled");
    setTimeout(() => setIndicator('idle', 'Ready'), 1500);
    return;
  }
  const next = !agent.enabled;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (!r.ok) throw new Error(await r.text());
    agent.enabled = next;
    // Re-render grid in place
    renderGrid();
  } catch (err) {
    setIndicator('error', 'Toggle failed');
    console.error(err);
  }
}
```

- [ ] **Step 2: Manually verify**

Boot the server, create a project with PM + Engineer + QA + Designer. At the grid, focus Engineer, press Square. Expected: tile desaturates, "off" badge appears. Press Square on the lead (PM): indicator shows "Lead can't be disabled". L1/R1 in zoom skip the disabled Engineer.

- [ ] **Step 3: Commit**

```bash
git add app/renderer/main.js
git commit -m "feat(renderer): per-agent enable/disable with lead protection"
```

---

## Phase 6 — History drawer at L2

End-state: Triangle at L2 toggles a right-side drawer showing prior turns; Cross on an entry opens it as a reader tile; Circle closes.

### Task 6.1 — Add a history endpoint

**Files:**
- Modify: `app/server/server.js`

- [ ] **Step 1: Add endpoint**

In `server.js`, after the per-agent spec route, add:

```js
app.get('/projects/:pid/agents/:aid/history', (req, res) => {
  try {
    const ctx = getContext(req.params.aid);
    res.json({ messages: ctx.messages || [] });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
```

And ensure `getContext` is imported from `./scratchpad.js` (if not already): add to the imports block.

- [ ] **Step 2: Smoke-test**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
PID=$(curl -s -X POST http://localhost:4317/projects -H 'Content-Type: application/json' \
  -d '{"name":"HistTest","goal":"history","roleIds":["pm"]}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
AID="${PID}__pm"
curl -s -X POST "http://localhost:4317/projects/$PID/agents/$AID/interpret" -H 'Content-Type: application/json' -d '{"text":"hello"}' >/dev/null
curl -s "http://localhost:4317/projects/$PID/agents/$AID/history"
kill $SERVER_PID
rm -rf "app/state/$PID" app/state/projects.json
```

Expected: `{messages:[{role:"user",content:"hello"},…]}`

- [ ] **Step 3: Commit**

```bash
git add app/server/server.js
git commit -m "feat(server): per-agent history endpoint"
```

### Task 6.2 — Drawer UI

**Files:**
- Modify: `app/renderer/index.html`
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Add drawer container to HTML**

In `app/renderer/index.html`, inside `<body>` (after the main `#surface` element), add:

```html
<aside id="history-drawer" class="drawer" hidden>
  <header><span>History</span><span class="hint">○ close</span></header>
  <ul class="history-list"></ul>
</aside>
```

- [ ] **Step 2: Implement toggleHistoryDrawer + rendering**

Replace the `toggleHistoryDrawer` stub:

```js
const drawerEl = document.getElementById('history-drawer');
const drawerListEl = drawerEl.querySelector('.history-list');

let drawerOpen = false;
let drawerFocus = 0;
let drawerEntries = [];

async function toggleHistoryDrawer() {
  if (mode !== MODE_ZOOM) return;
  if (drawerOpen) { closeHistoryDrawer(); return; }
  await openHistoryDrawer();
}

async function openHistoryDrawer() {
  const agent = currentAgent();
  if (!agent) return;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history`);
    if (!r.ok) throw new Error(await r.text());
    const { messages } = await r.json();
    drawerEntries = messages.slice().reverse(); // newest first
    drawerListEl.innerHTML = '';
    drawerEntries.forEach((m, i) => {
      const li = document.createElement('li');
      li.className = 'history-entry';
      li.dataset.idx = String(i);
      li.innerHTML = `<div class="role">${m.role}</div><div class="snippet">${escapeHtml(String(m.content).slice(0, 120))}</div>`;
      drawerListEl.appendChild(li);
    });
    drawerEl.hidden = false;
    drawerOpen = true;
    drawerFocus = 0;
    paintDrawerFocus();
    // Auto-close file explorer if it's open
    if (fileExplorerOpen) closeFileExplorer();
  } catch (err) {
    setIndicator('error', 'History failed');
    console.error(err);
  }
}

function closeHistoryDrawer() {
  drawerEl.hidden = true;
  drawerOpen = false;
}

function paintDrawerFocus() {
  const entries = drawerListEl.querySelectorAll('.history-entry');
  entries.forEach((el, i) => el.classList.toggle('focused', i === drawerFocus));
}
```

Extend the L2 press branch in the gamepad handler to route navigation to the drawer when it's open. Replace the current zoom branch with:

```js
  if (mode === MODE_ZOOM) {
    if (drawerOpen) {
      if (b === 'up' || b === 'left')   { drawerFocus = Math.max(0, drawerFocus - 1); paintDrawerFocus(); return; }
      if (b === 'down' || b === 'right'){ drawerFocus = Math.min(drawerEntries.length - 1, drawerFocus + 1); paintDrawerFocus(); return; }
      if (b === 'cross')                { openHistoryEntry(drawerEntries[drawerFocus]); return; }
      if (b === 'circle')               { closeHistoryDrawer(); return; }
      if (b === 'triangle')             { closeHistoryDrawer(); return; }
    }
    if (b === 'up' || b === 'left')      ring.move(-1);
    else if (b === 'down' || b === 'right') ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'triangle')           toggleHistoryDrawer();
    return;
  }
```

Add the helper:

```js
function openHistoryEntry(entry) {
  if (!entry) return;
  closeHistoryDrawer();
  renderZoom({
    intent: 'answer', template: 'reader',
    context: `${entry.role} turn`,
    title: entry.role === 'user' ? 'You said' : `${currentAgent()?.name || 'Agent'} said`,
    body: String(entry.content),
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    _silent: true,
  });
}

let fileExplorerOpen = false; // shared with Phase 7
```

- [ ] **Step 3: Drawer CSS**

Append:

```css
#history-drawer.drawer {
  position: fixed; top: 4rem; right: 0; bottom: 4rem;
  width: 360px; background: rgba(20,22,28,0.96);
  border-left: 1px solid rgba(255,255,255,0.12);
  overflow-y: auto; padding: 0;
  z-index: 60;
}
#history-drawer header {
  display: flex; justify-content: space-between;
  padding: 0.75rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.08);
  font-weight: 600;
}
#history-drawer header .hint { opacity: 0.5; font-weight: 400; font-size: 0.85rem; }
.history-list { list-style: none; margin: 0; padding: 0; }
.history-entry { padding: 0.75rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
.history-entry.focused { background: rgba(110,168,255,0.16); }
.history-entry .role { font-size: 0.75rem; text-transform: uppercase; opacity: 0.5; }
.history-entry .snippet { font-size: 0.9rem; margin-top: 0.2rem; }
```

- [ ] **Step 4: Verify manually**

In the app, open an agent, run a few PTT/typed prompts, then press Triangle / T. Drawer opens with prior turns newest-first. D-pad navigates; Cross opens full; Circle closes.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/index.html app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): per-agent history drawer (Triangle)"
```

---

## Phase 7 — File explorer (left drawer)

End-state: Options/`\` toggles a left drawer at L1 and L2 showing the project folder contents (Charters, Notes, project.md). Cross opens a file inline as a reader tile.

### Task 7.1 — Server endpoint for the folder tree

**Files:**
- Modify: `app/server/server.js`

- [ ] **Step 1: Add /projects/:pid/files endpoint**

In `server.js`, add to the imports:

```js
import { readdirSync, statSync } from 'node:fs';
```

And add the route:

```js
app.get('/projects/:pid/files', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const projDir = resolve(STATE_DIR, p.id);
  function fileEntry(absPath, kind) {
    const stat = statSync(absPath);
    return { path: absPath.replace(projDir + '/', ''), kind, mtime: stat.mtimeMs };
  }
  const charters = readdirSync(resolve(projDir, 'roles'))
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const roleId = f.replace(/\.md$/, '');
      const agent = p.agents.find(a => a.role === roleId);
      return { ...fileEntry(resolve(projDir, 'roles', f), 'charter'), roleId, agentName: agent?.name || '' };
    });
  const notes = readdirSync(resolve(projDir, 'notes'))
    .filter(f => f.endsWith('.md'))
    .sort().reverse()
    .map(f => ({ ...fileEntry(resolve(projDir, 'notes', f), 'note') }));
  res.json({ projectMd: 'project.md', charters, notes });
});

app.get('/projects/:pid/file/*', (req, res) => {
  const p = getProject(req.params.pid);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const rel = req.params[0];
  if (rel.includes('..')) return res.status(400).json({ error: 'bad path' });
  const path = resolve(STATE_DIR, p.id, rel);
  if (!existsSync(path)) return res.status(404).json({ error: 'not found' });
  res.json({ path: rel, body: readFileSync(path, 'utf8') });
});
```

Add `import { resolve as _resolve } from 'node:path';` only if `resolve` isn't already imported — it is, near the top. Add `STATE_DIR` constant after the existing `__dirname`/`PORT`/`RENDERER_DIR` constants:

```js
const STATE_DIR = resolve(__dirname, '..', 'state');
```

- [ ] **Step 2: Smoke-test**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
PID=$(curl -s -X POST http://localhost:4317/projects -H 'Content-Type: application/json' \
  -d '{"name":"FilesTest","goal":"files","roleIds":["pm","engineer"]}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
echo "=== files ==="; curl -s "http://localhost:4317/projects/$PID/files"
echo "=== read pm charter ==="; curl -s "http://localhost:4317/projects/$PID/file/roles/pm.md" | head -c 200
kill $SERVER_PID
rm -rf "app/state/$PID" app/state/projects.json
```

Expected: file list includes pm and engineer charters; reading the file returns markdown.

- [ ] **Step 3: Commit**

```bash
git add app/server/server.js
git commit -m "feat(server): project file-tree and file-read endpoints"
```

### Task 7.2 — File explorer drawer UI

**Files:**
- Modify: `app/renderer/index.html`
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Add drawer container**

In `index.html`, after the history drawer (or before `#surface`), add:

```html
<aside id="file-drawer" class="drawer left" hidden>
  <header><span>Files</span><span class="hint">Options · \</span></header>
  <div class="file-tree"></div>
</aside>
```

- [ ] **Step 2: Implement toggleFileExplorer**

Replace the stub with:

```js
const fileDrawerEl = document.getElementById('file-drawer');
const fileTreeEl   = fileDrawerEl.querySelector('.file-tree');
let fileTree = null;
let fileFocus = 0;
let fileEntries = []; // flat focusable list

async function toggleFileExplorer() {
  if (mode === MODE_PROJECTS) return; // not visible at L0
  if (!activeProject) return;
  if (fileExplorerOpen) { closeFileExplorer(); return; }
  await openFileExplorer();
}

async function openFileExplorer() {
  try {
    const r = await fetch(`/projects/${activeProject.id}/files`);
    if (!r.ok) throw new Error(await r.text());
    fileTree = await r.json();
  } catch (err) {
    setIndicator('error', 'Files failed');
    console.error(err);
    return;
  }
  fileTreeEl.innerHTML = '';
  fileEntries = [];

  if (fileTree.charters.length) {
    const h = document.createElement('div'); h.className = 'file-section'; h.textContent = '▾ Charters';
    fileTreeEl.appendChild(h);
    for (const c of fileTree.charters) {
      const li = document.createElement('div');
      li.className = 'file-entry';
      li.innerHTML = `<span>${escapeHtml(c.roleId)}.md</span><span class="who">${escapeHtml(c.agentName)}</span>`;
      li.dataset.path = c.path;
      fileTreeEl.appendChild(li);
      fileEntries.push(li);
    }
  }
  if (fileTree.notes.length) {
    const h = document.createElement('div'); h.className = 'file-section'; h.textContent = '▾ Notes';
    fileTreeEl.appendChild(h);
    for (const n of fileTree.notes) {
      const li = document.createElement('div');
      li.className = 'file-entry';
      li.textContent = n.path.replace(/^notes\//,'').replace(/\.md$/,'');
      li.dataset.path = n.path;
      fileTreeEl.appendChild(li);
      fileEntries.push(li);
    }
  }
  // project.md singleton
  const pm = document.createElement('div');
  pm.className = 'file-entry';
  pm.textContent = 'project.md';
  pm.dataset.path = 'project.md';
  fileTreeEl.appendChild(pm);
  fileEntries.push(pm);

  fileDrawerEl.hidden = false;
  fileExplorerOpen = true;
  fileFocus = 0;
  paintFileFocus();
  document.body.dataset.fileDrawer = 'open';
}

function closeFileExplorer() {
  fileDrawerEl.hidden = true;
  fileExplorerOpen = false;
  document.body.dataset.fileDrawer = 'closed';
}

function paintFileFocus() {
  fileEntries.forEach((el, i) => el.classList.toggle('focused', i === fileFocus));
}

async function openFocusedFile() {
  const e = fileEntries[fileFocus];
  if (!e) return;
  const path = e.dataset.path;
  try {
    const r = await fetch(`/projects/${activeProject.id}/file/${path}`);
    if (!r.ok) throw new Error(await r.text());
    const { body } = await r.json();
    const spec = {
      intent: 'answer', template: 'reader',
      context: 'File', title: path,
      body,
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      _silent: true,
    };
    if (mode === MODE_ZOOM) renderZoom(spec);
    else {
      // At L1: enter zoom-mode tile temporarily without choosing an agent.
      // Simpler: take user to lead agent and render this spec.
      zoomedIndex = activeProject.agents.findIndex(a => a.id === activeProject.leadAgentId);
      mode = MODE_ZOOM;
      renderZoom(spec);
    }
  } catch (err) {
    setIndicator('error', 'File read failed');
  }
}
```

Wire navigation when the drawer is open. Extend the gamepad handler's L1 and L2 branches; add at the top of each branch:

```js
    if (fileExplorerOpen) {
      if (b === 'up' || b === 'left')   { fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return; }
      if (b === 'down' || b === 'right'){ fileFocus = Math.min(fileEntries.length - 1, fileFocus + 1); paintFileFocus(); return; }
      if (b === 'cross')                { openFocusedFile(); return; }
      if (b === 'circle')               { closeFileExplorer(); return; }
    }
```

- [ ] **Step 3: File drawer CSS**

Append:

```css
#file-drawer.drawer.left {
  position: fixed; top: 4rem; left: 0; bottom: 4rem;
  width: 280px; background: rgba(20,22,28,0.96);
  border-right: 1px solid rgba(255,255,255,0.12);
  overflow-y: auto; padding: 0; z-index: 60;
}
#file-drawer header {
  display: flex; justify-content: space-between;
  padding: 0.75rem 1rem; border-bottom: 1px solid rgba(255,255,255,0.08);
  font-weight: 600;
}
#file-drawer header .hint { opacity: 0.5; font-weight: 400; font-size: 0.85rem; }
.file-section { padding: 0.5rem 1rem; opacity: 0.6; font-size: 0.8rem; text-transform: uppercase; }
.file-entry {
  display: flex; justify-content: space-between;
  padding: 0.5rem 1rem; cursor: pointer;
  border-left: 3px solid transparent;
}
.file-entry .who { opacity: 0.5; font-size: 0.85rem; }
.file-entry.focused { background: rgba(110,168,255,0.16); border-left-color: var(--agent-color, #6ea8ff); }
body[data-file-drawer="open"] #surface { margin-left: 280px; }
```

- [ ] **Step 4: Verify manually**

In the app, create a project, press Options (or `\`). Drawer slides in on the left showing Charters / Notes / project.md. D-pad navigates; Cross opens a file inline; Circle closes.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/index.html app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): project file explorer drawer"
```

---

## Phase 8 — Team voice (L1 PTT) with context-efficient routing

End-state: holding R2 at L1 routes through the lead agent (router → fan-out → synthesizer), tiles pulse while assignees work, a team-summary banner shows the lead's synthesis. The lead works from a **team activity digest** (one line per agent, ≤120 chars from `lastSpec.body`) — not raw scratchpads — and can forward bounded peer-context snippets via `sharedFrom` per assignment. Agents only see peer context through these explicit forwards.

### Task 8.1 — Team-voice pipeline on the server

**Files:**
- Create: `app/server/team.js`
- Create: `app/server/team.test.js`
- Modify: `app/server/server.js`

- [ ] **Step 1: Write failing tests for input validation and cost cap**

Create `app/server/team.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingOutput, applyCostCap } from './team.js';

test('parseRoutingOutput accepts the JSON shape', () => {
  const r = parseRoutingOutput('{"assignments":[{"agentId":"a1","task":"x"}],"summary_intent":"ok"}');
  assert.equal(r.assignments.length, 1);
  assert.equal(r.summary_intent, 'ok');
});

test('parseRoutingOutput strips code fences', () => {
  const r = parseRoutingOutput('```json\n{"assignments":[],"summary_intent":"none"}\n```');
  assert.deepEqual(r.assignments, []);
});

test('parseRoutingOutput throws on garbage', () => {
  assert.throws(() => parseRoutingOutput('this is not json'));
});

test('applyCostCap drops assignees past cap', () => {
  const xs = [1,2,3,4,5,6,7].map(i => ({ agentId: `a${i}`, task: 't' }));
  const r = applyCostCap(xs, 5);
  assert.equal(r.kept.length, 5);
  assert.equal(r.dropped.length, 2);
});

test('parseRoutingOutput sanitizes sharedFrom (cap count, truncate snippet)', () => {
  const longSnippet = 'x'.repeat(500);
  const raw = JSON.stringify({
    assignments: [{
      agentId: 'a1', task: 't',
      sharedFrom: [
        { fromAgentName: 'Kade', fromRole: 'Engineer', snippet: longSnippet },
        { fromAgentName: 'Iris', fromRole: 'Designer', snippet: 'short' },
        { fromAgentName: 'Tess', fromRole: 'QA',       snippet: 'also short' },
        { fromAgentName: 'Vex',  fromRole: 'Sec',      snippet: 'dropped past cap' },
      ],
    }],
    summary_intent: 'ok',
  });
  const r = parseRoutingOutput(raw);
  assert.equal(r.assignments[0].sharedFrom.length, 3);
  assert.equal(r.assignments[0].sharedFrom[0].snippet.length, 240);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app/server && npm test`
Expected: FAIL — `team.js` not found.

- [ ] **Step 3: Implement team.js**

Create `app/server/team.js`:

```js
/* Bridge — team voice pipeline.
 *
 * pipeline(project, userText, opts) →
 *    { routing: {assignments, summary_intent},
 *      perAgent: { [agentId]: spec },
 *      summary: spec }
 */

import { getProject } from './projects.js';
import { getRole } from './roles.js';
import { interpretIntent } from './orchestrator.js';
import { appendTurn, getContext } from './scratchpad.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FANOUT_CAP = 5;
const ROUTING_TIMEOUT_MS = 20_000;
const SYNTHESIS_TIMEOUT_MS = 20_000;
const ASSIGNEE_TIMEOUT_MS = 20_000;

const SHARED_FROM_MAX = 3;
const SHARED_SNIPPET_MAX_CHARS = 240;
const DIGEST_MAX_CHARS = 120;

export function parseRoutingOutput(raw) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object') throw new Error('routing not object');
  if (!Array.isArray(obj.assignments)) obj.assignments = [];
  // Sanitize sharedFrom on each assignment
  for (const a of obj.assignments) {
    if (Array.isArray(a.sharedFrom)) {
      a.sharedFrom = a.sharedFrom.slice(0, SHARED_FROM_MAX).map(s => ({
        fromAgentName: String(s.fromAgentName || '').slice(0, 40),
        fromRole:      String(s.fromRole || '').slice(0, 40),
        snippet:       String(s.snippet || '').slice(0, SHARED_SNIPPET_MAX_CHARS),
      })).filter(s => s.snippet);
    } else {
      delete a.sharedFrom;
    }
  }
  return obj;
}

export function applyCostCap(assignments, cap = FANOUT_CAP) {
  const kept = assignments.slice(0, cap);
  const dropped = assignments.slice(cap);
  return { kept, dropped };
}

/** Build a per-agent digest line from scratchpad's lastSpec. */
export function digestLineFor(agent) {
  const ctx = getContext(agent.id);
  const last = ctx?.lastSpec;
  if (!last) return '—';
  const src = last.body || last.title || '';
  const t = String(src).replace(/\s+/g, ' ').trim();
  return t.slice(0, DIGEST_MAX_CHARS) || '—';
}

async function callOpenRouterJSON({ apiKey, model, prompt, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - team' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' },
                             messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0,200)}`);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(t); }
}

export async function runTeamVoice({ projectId, text }) {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return {
      blocked: true,
      reason: 'no_key',
      summary: {
        intent: 'answer', template: 'reader',
        context: 'Team voice',
        title: 'Team voice needs an API key',
        body: 'Add OPENROUTER_API_KEY to .env to use team voice. Single-agent prompts still work.',
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      },
    };
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  const others = project.agents.filter(a => a.id !== lead.id && a.enabled);

  // 1. Routing — lead sees roster + per-agent one-line digest (NOT full scratchpads)
  const rosterWithDigest = others.map(a =>
    `- ${a.name} (${getRole(a.role).label}) [id:${a.id}] — last work: ${digestLineFor(a)}`
  ).join('\n');
  const routingPrompt =
    `You are ${lead.name}, lead of project "${project.name}". The project goal is: "${project.goal}".\n\n` +
    `Active team:\n${rosterWithDigest || '(no other members)'}\n\n` +
    `The user said: "${text}".\n\n` +
    `Return a single JSON object: ` +
    `{"assignments":[{"agentId":"...","task":"...","sharedFrom":[{"fromAgentName":"...","fromRole":"...","snippet":"..."}]}],"summary_intent":"..."}. ` +
    `The sharedFrom field is OPTIONAL per assignment — include it only when another teammate's "last work" line above gives useful context for this task. ` +
    `Max ${SHARED_FROM_MAX} sharedFrom entries per assignment; each snippet ≤ ${SHARED_SNIPPET_MAX_CHARS} characters. ` +
    `Use exact agent ids from the roster. Assign only agents whose role applies. Maximum ${FANOUT_CAP} assignments. ` +
    `If no one applies, return assignments:[] and put your direct answer in summary_intent.`;

  appendTurn(lead.id, 'user', `[team-voice] ${text}`);
  const routingRaw = await callOpenRouterJSON({ apiKey, model, prompt: routingPrompt, timeoutMs: ROUTING_TIMEOUT_MS });
  const routing = parseRoutingOutput(routingRaw);
  const { kept, dropped } = applyCostCap(routing.assignments, FANOUT_CAP);
  if (dropped.length) console.log(`[team] cost cap dropped ${dropped.length} assignments`);

  // 2. Fan-out — each assignee receives only their task + any sharedFrom snippets
  const perAgent = {};
  await Promise.all(kept.map(async (asg) => {
    try {
      const spec = await Promise.race([
        interpretIntent({
          projectId,
          agentId: asg.agentId,
          text: asg.task,
          sharedFrom: asg.sharedFrom, // may be undefined — orchestrator handles
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('assignee timeout')), ASSIGNEE_TIMEOUT_MS)),
      ]);
      perAgent[asg.agentId] = spec;
    } catch (err) {
      console.warn(`[team] assignee ${asg.agentId} failed:`, err.message);
      perAgent[asg.agentId] = null;
    }
  }));

  // 3. Synthesis
  const perAgentText = Object.entries(perAgent).map(([aid, spec]) => {
    const a = project.agents.find(x => x.id === aid);
    if (!a) return '';
    if (!spec) return `${a.name} (${getRole(a.role).label}): did not respond.`;
    return `${a.name} (${getRole(a.role).label}): ${spec.body || JSON.stringify(spec)}`;
  }).join('\n');

  const synthPrompt =
    `You are ${lead.name}. Project goal: "${project.goal}". The team replied to "${text}":\n${perAgentText || '(no assignees)'}\n` +
    `Compose a single response to the user that synthesizes their work. 1-3 sentences, spoken-friendly. ` +
    `Output the standard answer tile-spec JSON: ` +
    `{"intent":"answer","template":"reader","context":"Team","title":"<short>","body":"<text>","actions":[{"verb":"Back","glyph":"circle","action":{"type":"cancel"}}]}`;
  const synthRaw = await callOpenRouterJSON({ apiKey, model, prompt: synthPrompt, timeoutMs: SYNTHESIS_TIMEOUT_MS });
  let summary;
  try { summary = JSON.parse(synthRaw.trim().replace(/^```(?:json)?/i,'').replace(/```$/, '')); }
  catch {
    summary = {
      intent: 'answer', template: 'reader',
      context: 'Team', title: lead.name,
      body: routing.summary_intent || 'Team is on it.',
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    };
  }
  appendTurn(lead.id, 'assistant', summary.body || '');

  return { routing: { assignments: kept, summary_intent: routing.summary_intent, dropped: dropped.length },
           perAgent, summary };
}
```

- [ ] **Step 4: Add HTTP route**

In `server.js`, add import:

```js
import { runTeamVoice } from './team.js';
```

Add route:

```js
app.post('/projects/:pid/team/interpret', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty intent' });
  try {
    const result = await runTeamVoice({ projectId: req.params.pid, text });
    res.json(result);
  } catch (err) {
    console.error(`[team:${req.params.pid}]`, err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});
```

- [ ] **Step 5: Run tests**

Run: `cd app/server && npm test`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/server/team.js app/server/team.test.js app/server/server.js
git commit -m "feat(server): team-voice pipeline (router → fan-out → synthesizer)"
```

### Task 8.2 — Renderer: submitTeamIntent + summary banner + pulse

**Files:**
- Modify: `app/renderer/main.js`
- Modify: `app/renderer/style.css`

- [ ] **Step 1: Implement submitTeamIntent**

Replace the stub:

```js
async function submitTeamIntent(text) {
  if (mode !== MODE_GRID || !activeProject) return;
  if (inflightController) inflightController.abort();
  inflightController = new AbortController();
  const myCtl = inflightController;

  // Mark lead busy during routing
  const leadId = activeProject.leadAgentId;
  agentBusy[leadId] = true;
  setIndicator('thinking', 'Lead is delegating…');
  renderGrid(); // repaint to show pulse on lead

  try {
    const r = await fetch(`/projects/${activeProject.id}/team/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: myCtl.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const result = await r.json();

    if (result.blocked) {
      setIndicator('error', 'Team voice blocked');
      speak(result.summary.body || '');
      showTeamSummary(result.summary);
      return;
    }

    // Mark assignees busy
    for (const asg of (result.routing?.assignments || [])) {
      agentBusy[asg.agentId] = true;
    }
    renderGrid();

    // Store per-agent specs and stop busy
    for (const [aid, spec] of Object.entries(result.perAgent || {})) {
      const a = activeProject.agents.find(x => x.id === aid);
      if (a && spec) a.lastSpec = spec;
      agentBusy[aid] = false;
    }
    agentBusy[leadId] = false;
    renderGrid();
    showTeamSummary(result.summary);
    if (result.summary?.body) speak(result.summary.body);
    setIndicator('idle', 'Ready');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setIndicator('error', 'Team voice failed');
    console.error(err);
  } finally {
    for (const a of activeProject.agents) agentBusy[a.id] = false;
    if (myCtl === inflightController) inflightController = null;
  }
}

function showTeamSummary(spec) {
  if (!spec) return;
  // Remove old banner
  document.querySelectorAll('.team-summary').forEach(el => el.remove());
  const banner = document.createElement('section');
  banner.className = 'team-summary';
  banner.innerHTML = `
    <div class="ts-title">${escapeHtml(spec.title || 'Team')}</div>
    <div class="ts-body">${escapeHtml(spec.body || '')}</div>
    <button class="ts-close" type="button">Dismiss</button>`;
  banner.querySelector('.ts-close').addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 25_000);
}
```

- [ ] **Step 2: Route PTT at L1 to submitTeamIntent**

The speech `end` handler from Task 3.2 already routes `MODE_GRID` to `submitTeamIntent` — verify by reading `main.js` at the speech handler. If it's still calling something else, ensure the branch is:

```js
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
```

- [ ] **Step 3: Team-summary CSS**

Append:

```css
.team-summary {
  position: fixed; top: 5rem; left: 50%; transform: translateX(-50%);
  width: min(640px, 80vw);
  padding: 1rem 1.25rem;
  background: rgba(20,22,28,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  z-index: 70;
}
.team-summary .ts-title { font-weight: 600; margin-bottom: 0.4rem; }
.team-summary .ts-body { opacity: 0.85; }
.team-summary .ts-close {
  margin-top: 0.75rem; background: transparent; color: inherit;
  border: 1px solid rgba(255,255,255,0.2); border-radius: 6px;
  padding: 0.2rem 0.6rem; cursor: pointer;
}
```

- [ ] **Step 4: Manually verify (key required)**

With a valid `OPENROUTER_API_KEY` in `app/server/.env`:

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
```

In the app, create a project with PM + Engineer + QA. At L1, hold Space and say "prep the v2 launch". Expected:
- Lead tile pulses during routing.
- Multiple tiles pulse during fan-out.
- A team-summary banner appears with the synthesis.
- TTS reads the body aloud.

Without a key: banner appears with "Team voice needs an API key" message and nothing pulses beyond the lead.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/main.js app/renderer/style.css
git commit -m "feat(renderer): L1 team voice with pulse and summary banner"
```

---

## Phase 9 — Final cleanup and verification

### Task 9.1 — Remove legacy notes directory

**Files:**
- Delete: `app/notes/` (if it still exists)

- [ ] **Step 1: Check whether anything references it**

Run: `grep -RIn "app/notes" app/ --exclude-dir=state || echo "no references"`
Expected: only doc/comment references remain.

- [ ] **Step 2: Delete the directory**

```bash
rm -rf app/notes
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove legacy app/notes directory"
```

### Task 9.2 — Update README

**Files:**
- Modify: `app/README.md`

- [ ] **Step 1: Rewrite the README to describe Bridge**

Replace `app/README.md` contents with a brief, accurate description of Bridge (project picker → grid → zoom, role catalog, team voice, file explorer). Keep the existing "Run it" instructions (env file, npm install, npm run dev) — they're unchanged. Add: "see `docs/superpowers/specs/2026-05-22-projects-and-roles-design.md` for the architecture."

- [ ] **Step 2: Commit**

```bash
git add app/README.md
git commit -m "docs: update README for Bridge"
```

### Task 9.3 — End-to-end smoke test

- [ ] **Step 1: Wipe state for a clean run**

```bash
rm -rf app/state/p_* app/state/projects.json
> app/state/scratchpad.json
echo "{}" > app/state/scratchpad.json
```

- [ ] **Step 2: Boot and walk the flow manually**

```bash
cd app/server && node server.js &
SERVER_PID=$!
sleep 1
```

In the browser:
1. Empty project picker shows "+ New project" only.
2. Create a project: PM, Engineer, QA → "Falcon" → "Ship v2 by EOQ".
3. Land at L1 grid (2×2, 3 tiles, PM tile marked as lead).
4. Press Square on Engineer tile → desaturates; press Square on PM → toast "Lead can't be disabled".
5. Press Cross on PM → enters zoom. PTT "show my notes" → "no notes yet" tile.
6. PTT "take a note: ship sunday" → compose tile → Cross → save → ack.
7. Press Triangle → history drawer with 4 entries.
8. Press Circle → close drawer. Press Circle → back to grid.
9. Press Options → file explorer slides in left; shows Charters (pm, engineer, qa) + Notes (1) + project.md.
10. Press Cross on `pm.md` → reader tile renders the charter.
11. Press Circle → back to zoom. Press Options to close drawer.
12. Press Circle → back to grid. Hold Space → "what's the launch plan" → team voice pipeline (with key); fallback message (without).
13. Press Circle → back to picker; project visible.

- [ ] **Step 3: Verify state on disk**

```bash
ls app/state/
ls app/state/p_*_falcon*/
cat app/state/p_*_falcon*/project.md
```

Expected: project folder exists with `project.md`, `roles/`, `notes/`.

- [ ] **Step 4: Stop server**

```bash
kill $SERVER_PID
```

- [ ] **Step 5: Commit any leftover work**

If any incidental fixes were made during the smoke test, commit them with a message describing what was fixed.

---

## Self-review checklist (run at end)

- [ ] Every spec section maps to one or more tasks:
  - Goal/non-goals → covered by overall plan
  - Navigation model (L0/L1/L2) → Phases 2, 3, 4
  - Button map → distributed across press handlers in Phases 2–7
  - Role catalog → Phase 1 Task 1.1
  - Data model (projects.json, ids, scratchpad, project folder) → Phase 1 Tasks 1.3, 1.5
  - Role charters → Phase 1 Tasks 1.2, 1.4, 1.5; Phase 1 Task 1.8 injects into prompt
  - Create-project flow (5 steps) → Phase 3 Tasks 3.1, 3.2; charter generation in 1.5
  - Agent zoom + history drawer → Phase 4 + Phase 6
  - Team voice → Phase 8
  - Context efficiency (lead = digest only; agents = own charter + sharedFrom; no global transcript) → Task 1.8 (`systemPrompt({sharedFrom})`), Task 8.1 (`digestLineFor`, `parseRoutingOutput` sanitiser, routing prompt with digest, fan-out forwards `sharedFrom`)
  - Enable/disable → Phase 5
  - File explorer → Phase 7
  - Server surface (8 new, 8 removed) → Phase 0 removes, Phases 1, 6, 7, 8 add
  - State migration → Phase 0 Task 0.3
  - Testing approach → `node:test` files in Phase 1; manual smoke in Phase 9 Task 9.3
  - Risks/decisions → addressed in Phases 1.4 (no-key fallback), 6.2 (drawer auto-close), 5 (lead protection), 8.1 (cost cap)
