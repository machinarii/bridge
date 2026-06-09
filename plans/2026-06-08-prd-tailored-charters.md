# PRD-tailored, skill-seeded role charters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make role charters high-quality from first render (seeded from best-in-class Claude skills) and deeply re-tailored to the project once the PRD exists.

**Architecture:** Three integration points, all existing files. `charters.js` gains an optional override in `loadBaseCharter`, a no-API `writeBaselineCharters`, and a PRD-aware `deepenCharters` (preserves any `## Plan`, per-role fallback). `projects.js` writes baselines at creation (no network) and tailors a newly-added agent from the PRD if one exists. `kickoff.js` runs `deepenCharters` right after the PRD doc is generated. The 11 baseline templates are rewritten, distilled from mapped skills.

**Tech Stack:** Node ESM (`"type":"module"`), `node --test`, OpenRouter via injected `callText`. Tests isolate state with `BRIDGE_STATE_DIR` + `BRIDGE_PROJECTS_BASE` temp dirs.

**Spec:** `specs/2026-06-08-prd-tailored-charters-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/server/charters.js` | charter load/customize/write | add override to `loadBaseCharter`; add `writeBaselineCharters`, `deepenCharters` + helpers |
| `app/server/role-charters/role-*.md` | bundled baseline templates (11 active roles) | rewrite content, distilled from mapped skills |
| `app/server/projects.js` | project + agent lifecycle | `createProject` → baselines (no API); `addAgent` → PRD-aware |
| `app/server/kickoff.js` | kickoff state machine + docs | `generateKickoffDocs` → call `deepenCharters` after PRD |
| `app/server/charters.test.js` | charter unit tests | add override, baseline-write, deepen tailoring/plan-preserve/fallback |
| `app/server/project-docs.test.js` | project doc/charter integration | add creation-API-free + addAgent tests |
| `HANDOFF.md`, `docs/design.md` | living docs | add provenance table + behavior notes |

**Constraints (must preserve):**
- Tests MUST set `BRIDGE_STATE_DIR` + `BRIDGE_PROJECTS_BASE` to temp dirs (a past test wiped real data). Assert `app/state/projects.json` is unchanged where relevant.
- `charters.js` must NOT import `kickoff.js` (cycle). `projects.js` must NOT import `backends/notes.js` (cycle: notes.js imports `docsDir` from projects.js) — read `PRD.md` directly.
- `charters.js` MAY import `getModelForRole` from `models.js` (no cycle).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Stage only named files. Never `git add -A`.
- `docs/` is gitignored except `docs/design.md` (tracked, grandfathered). Spec/plan live at repo root `specs/` and `plans/`.

---

## Task 1: Optional override in `loadBaseCharter`

**Files:**
- Modify: `app/server/charters.js` (the `loadBaseCharter` function, ~lines 65-72)
- Test: `app/server/charters.test.js`

- [ ] **Step 1: Write the failing test**

Add to `app/server/charters.test.js`:

```js
import { mkdtempSync, writeFileSync as wfs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loadBaseCharter prefers a valid BRIDGE_CHARTERS_DIR override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-charters-'));
  const prev = process.env.BRIDGE_CHARTERS_DIR;
  process.env.BRIDGE_CHARTERS_DIR = dir;
  // pm → role-pm.md (CHARTER_SLUG_OVERRIDE)
  wfs(join(dir, 'role-pm.md'),
    '# Override PM\n## Role\nr\n## Typical tasks\n- t\n## Areas of expertise\n- e\n', 'utf8');
  try {
    assert.match(loadBaseCharter('pm'), /^# Override PM/);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_CHARTERS_DIR; else process.env.BRIDGE_CHARTERS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBaseCharter ignores an invalid override and uses the bundled template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-charters-'));
  const prev = process.env.BRIDGE_CHARTERS_DIR;
  process.env.BRIDGE_CHARTERS_DIR = dir;
  wfs(join(dir, 'role-pm.md'), '# Bad\n## Role only\n', 'utf8'); // missing headings
  try {
    assert.match(loadBaseCharter('pm'), /^# Product Manager/); // bundled wins
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_CHARTERS_DIR; else process.env.BRIDGE_CHARTERS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/server/charters.test.js`
Expected: FAIL — override test gets `# Product Manager`, not `# Override PM` (override not yet read).

- [ ] **Step 3: Implement the override in `loadBaseCharter`**

Replace the existing `loadBaseCharter` in `app/server/charters.js`:

```js
export function loadBaseCharter(roleId) {
  const role = getRole(roleId);
  if (!role) throw new Error(`unknown role: ${roleId}`);
  const fname = charterFileName(role);
  // Optional drop-in override: a folder of charter-format files the user can
  // regenerate from newer skills offline. A present, VALID override wins; an
  // invalid/unreadable one is ignored (fall through to the bundled template).
  const dir = process.env.BRIDGE_CHARTERS_DIR || '';
  if (dir) {
    const op = resolve(dir, fname);
    if (existsSync(op)) {
      try {
        const md = readFileSync(op, 'utf8');
        if (validateCharterMarkdown(md).ok) return md;
        console.warn(`[charters] override ${fname} failed validation; using bundled`);
      } catch (err) {
        console.warn(`[charters] override ${fname} unreadable: ${err.message}; using bundled`);
      }
    }
  }
  const path = resolve(CHARTERS_DIR, fname);
  if (!existsSync(path)) throw new Error(`missing base charter: ${fname}`);
  return readFileSync(path, 'utf8');
}
```

(`validateCharterMarkdown` is a hoisted function declaration later in the file — safe to call here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/server/charters.test.js`
Expected: PASS (all charter tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add app/server/charters.js app/server/charters.test.js
git commit -m "feat(charters): optional BRIDGE_CHARTERS_DIR override in loadBaseCharter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `writeBaselineCharters` + API-free project creation

**Files:**
- Modify: `app/server/charters.js` (add `writeBaselineCharters`)
- Modify: `app/server/projects.js` (import line 16; `createProject` line ~232)
- Test: `app/server/project-docs.test.js`

- [ ] **Step 1: Write the failing test**

Add to `app/server/project-docs.test.js` (it already sets `BRIDGE_STATE_DIR` at top and imports `createProject`, `deleteProject`):

```js
test('createProject writes baseline charters WITHOUT any model call', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  // A throwing global fetch proves creation makes no network/charter API call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('no network at create'); };
  let p;
  try {
    p = await createProject({ name: 'Baseline Create', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
    const roles = join(base, 'baseline-create', 'docs', 'roles');
    assert.match(readFileSync(join(roles, 'role-pm.md'), 'utf8'), /## Role/);
    assert.match(readFileSync(join(roles, 'role-designer.md'), 'utf8'), /## Areas of expertise/);
  } finally {
    globalThis.fetch = realFetch;
    if (p) deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE; else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});
```

Ensure the file's import line includes `readFileSync` (it imports from `node:fs` already at line 3 — add `readFileSync` if absent; the existing line is `import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';` so `readFileSync` is present).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/server/project-docs.test.js`
Expected: FAIL — `createProject` currently calls `generateProjectCharters`, which calls `fetch` (throws), so creation rejects.

- [ ] **Step 3: Add `writeBaselineCharters` to `charters.js`**

Add after `generateProjectCharters` in `app/server/charters.js`:

```js
/** Write each agent's BASELINE charter verbatim to <repo>/docs/roles/ — no
 *  network call. Used at project creation so role files populate instantly; the
 *  deep, PRD-aware pass (deepenCharters) upgrades them during kickoff. Pass
 *  `agents` to write only a subset (e.g. a newly-added agent). */
export function writeBaselineCharters(project, { agents } = {}) {
  const targets = agents || project.agents;
  const rolesDir = resolve(project.repoPath, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  for (const a of targets) {
    const path = resolve(rolesDir, charterFileName(getRole(a.role)));
    writeFileSync(path, loadBaseCharter(a.role), 'utf8');
  }
  return targets.map(a => ({ agentId: a.id, roleId: a.role }));
}
```

(`mkdirSync`, `writeFileSync`, `resolve` are already imported at the top of `charters.js`.)

- [ ] **Step 4: Switch `createProject` to baselines**

In `app/server/projects.js`, change the import on line 16 from:

```js
import { generateProjectCharters, charterFileNameFor, legacyCharterFileNames } from './charters.js';
```

to (import ONLY `writeBaselineCharters` for now — `deepenCharters` is added to this import in Task 5, after `charters.js` exports it in Task 3; importing a not-yet-exported name throws at module load):

```js
import { writeBaselineCharters, charterFileNameFor, legacyCharterFileNames } from './charters.js';
```

Then replace the create-time charter call (lines ~231-232):

```js
  // Generate per-project charters (falls back to base verbatim on failure).
  await generateProjectCharters(project);
```

with:

```js
  // Write baseline charters verbatim — no model call at creation. The deep,
  // PRD-aware pass (deepenCharters) tailors them during kickoff.
  writeBaselineCharters(project);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test app/server/project-docs.test.js`
Expected: PASS. (Only `writeBaselineCharters` is imported here; `deepenCharters` is wired into `projects.js` in Task 5, after Task 3 exports it — so no missing-export load error at this stage.)

- [ ] **Step 6: Commit**

```bash
git add app/server/charters.js app/server/projects.js app/server/project-docs.test.js
git commit -m "feat(charters): write baseline charters at creation (no API call)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `deepenCharters` — PRD-aware re-tailoring with plan preservation

**Files:**
- Modify: `app/server/charters.js` (add import + helpers + `deepenCharters`)
- Test: `app/server/charters.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `app/server/charters.test.js`:

```js
import { deepenCharters } from './charters.js';
import { mkdirSync } from 'node:fs';

function fakeProject(dir) {
  return {
    id: 'p_test', name: 'Test Co', goal: 'ship it', features: 'feat A; feat B',
    repoPath: dir,
    agents: [{ id: 'p_test__pm', role: 'pm', name: 'Cassidy' }],
  };
}

test('deepenCharters rewrites the charter and preserves a ## Plan section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  const rolesDir = join(dir, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  wfs(join(rolesDir, 'role-pm.md'),
    '# Product Manager\n## Role\nbase\n## Typical tasks\n- base\n## Areas of expertise\n- base\n\n## Plan\n\n- ship the MVP\n', 'utf8');
  const callText = async () =>
    '# Product Manager\n## Role\nTAILORED to Test Co\n## Typical tasks\n- TAILORED task\n## Areas of expertise\n- TAILORED area\n';
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '# PRD\n\nrich context', callText, apiKey: 'k' });
    const md = readFileSync(join(rolesDir, 'role-pm.md'), 'utf8');
    assert.equal(res[0].deepened, true);
    assert.match(md, /TAILORED to Test Co/);     // body rewritten
    assert.match(md, /## Plan/);                  // plan preserved
    assert.match(md, /ship the MVP/);             // plan content preserved
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deepenCharters keeps the existing charter on a failed/invalid model reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  const rolesDir = join(dir, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  const original = '# Product Manager\n## Role\nKEEP ME\n## Typical tasks\n- t\n## Areas of expertise\n- e\n';
  wfs(join(rolesDir, 'role-pm.md'), original, 'utf8');
  const callText = async () => 'garbage with no headings';
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '# PRD', callText, apiKey: 'k' });
    assert.equal(res[0].deepened, false);
    assert.equal(readFileSync(join(rolesDir, 'role-pm.md'), 'utf8'), original);  // unchanged
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deepenCharters skips entirely when the PRD is empty/not-generated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deepen-'));
  mkdirSync(join(dir, 'docs', 'roles'), { recursive: true });
  let called = false;
  const callText = async () => { called = true; return 'x'; };
  try {
    const res = await deepenCharters(fakeProject(dir), { prd: '_not generated_', callText, apiKey: 'k' });
    assert.deepEqual(res, []);
    assert.equal(called, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test app/server/charters.test.js`
Expected: FAIL — `deepenCharters` is not exported yet (`SyntaxError`/import error or assertion failures).

- [ ] **Step 3: Implement `deepenCharters` + helpers**

At the TOP of `app/server/charters.js`, add the model import after the existing `import { getRole } from './roles.js';`:

```js
import { getModelForRole } from './models.js';
```

Then add, near the bottom of `app/server/charters.js` (after `generateProjectCharters` / `writeBaselineCharters`):

```js
const DEEPEN_TIMEOUT_MS = 30_000;

/* Split a role file into its charter body and any trailing "## Plan" section
 * (written by team-review). Lets the deep pass rewrite the charter while
 * preserving a specialist's plan. Returns plan WITHOUT a leading blank line. */
function splitPlan(content) {
  const m = content.match(/\n## Plan\b[\s\S]*$/i);
  if (!m) return { body: content.replace(/\s+$/, ''), plan: '' };
  return { body: content.slice(0, m.index).replace(/\s+$/, ''), plan: m[0].replace(/^\n+/, '') };
}

function buildDeepenPrompt({ agentName, roleLabel, projectName, goal, features, prd, current }) {
  return (
    `${agentName} is the ${roleLabel} on project "${projectName}" (goal: "${goal}").\n` +
    (features ? `Top features: ${features}\n` : '') +
    `Here is the project's PRD:\n\n${prd}\n\n` +
    `Here is ${agentName}'s current charter:\n\n${current}\n\n` +
    `Rewrite the charter so the three sections are concretely tailored to THIS ` +
    `project and THIS role's part in it. Keep the exact markdown structure — the ` +
    `headings ## Role, ## Typical tasks, ## Areas of expertise must remain. Replace ` +
    `generic items with project-specific ones drawn from the PRD. 220 words max. ` +
    `Output only markdown — no code fences, no commentary.`
  );
}

/* String-returning wrapper over the module's callOpenRouter, so deepenCharters
 * has a no-arg default while staying injectable (tests pass their own callText). */
async function defaultCallText({ apiKey, model, prompt }) {
  const r = await callOpenRouter({ apiKey, model, prompt });
  return r.ok ? r.content : '';
}

/** Re-tailor each agent's charter using the full PRD as context, AFTER the PRD
 *  exists (kickoff). Overwrites the three charter sections in place, preserving
 *  any "## Plan" section. Per-role failures keep the existing charter unchanged
 *  (never clobber with garbage). Empty/"not generated" PRD → no-op. Returns a
 *  per-agent result list ({agentId, roleId, deepened}). */
export async function deepenCharters(project, { prd, callText, apiKey, agents } = {}) {
  const text = String(prd || '').trim();
  if (!text || /^_?not generated_?$/i.test(text)) return [];   // no useful context → keep baselines
  const key = apiKey != null ? apiKey : process.env.OPENROUTER_API_KEY;
  const call = callText || defaultCallText;
  const targets = agents || project.agents;
  const rolesDir = resolve(project.repoPath, 'docs', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  const results = [];
  for (const a of targets) {
    const role = getRole(a.role);
    const path = resolve(rolesDir, charterFileName(role));
    const current = existsSync(path) ? readFileSync(path, 'utf8') : loadBaseCharter(a.role);
    const { body, plan } = splitPlan(current);
    let md = '';
    try {
      md = String(await call({
        apiKey: key, model: getModelForRole(a.role), timeoutMs: DEEPEN_TIMEOUT_MS,
        prompt: buildDeepenPrompt({
          agentName: a.name, roleLabel: role?.label || a.role,
          projectName: project.name, goal: project.goal, features: project.features,
          prd: text, current: body,
        }),
      }) || '').trim();
    } catch (err) {
      console.warn(`[charters] deepen failed for ${a.name} (${a.role}): ${err.message}`);
      md = '';
    }
    if (md && validateCharterMarkdown(md).ok) {
      const out = plan ? `${md}\n\n${plan}\n` : `${md}\n`;
      writeFileSync(path, out, 'utf8');
      results.push({ agentId: a.id, roleId: a.role, deepened: true });
    } else {
      results.push({ agentId: a.id, roleId: a.role, deepened: false });   // leave file untouched
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test app/server/charters.test.js`
Expected: PASS (all charter tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/charters.js app/server/charters.test.js
git commit -m "feat(charters): deepenCharters re-tailors charters from the PRD, preserving Plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `deepenCharters` into kickoff

**Files:**
- Modify: `app/server/kickoff.js` (add import; `generateKickoffDocs` after the docs loop, ~lines 359-370)
- Test: `app/server/kickoff.test.js`

- [ ] **Step 1: Write the failing test**

Add to `app/server/kickoff.test.js` (it sets `BRIDGE_PROJECTS_BASE` at top and imports `createProject`, `deleteProject`, `generateKickoffDocs`):

```js
import { readFileSync as rfs } from 'node:fs';
import { rolesDir as kRolesDir } from './projects.js';
import { join as kjoin } from 'node:path';

test('generateKickoffDocs deepens charters using the generated PRD', async () => {
  const p = await createProject({ name: 'Deepen KO', goal: 'do Z', roleIds: ['pm'], topology: 'hub-and-spoke' });
  try {
    // callText returns the PRD/doc bodies AND a valid tailored charter — the same
    // injected fn services both doc generation and the deepen pass.
    const callText = async ({ prompt }) =>
      /Rewrite the charter/.test(prompt)
        ? '# Product Manager\n## Role\nDEEPENED\n## Typical tasks\n- t\n## Areas of expertise\n- e\n'
        : 'PRD body about the product';
    await generateKickoffDocs(p.id, { apiKey: 'k', callText });
    const md = rfs(kjoin(kRolesDir(p.id), 'role-pm.md'), 'utf8');
    assert.match(md, /DEEPENED/);
  } finally { deleteProject(p.id); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/server/kickoff.test.js`
Expected: FAIL — `role-pm.md` still holds the baseline (`generateKickoffDocs` doesn't deepen yet).

- [ ] **Step 3: Implement the wiring**

In `app/server/kickoff.js`, add to the import block (after line 13, `import { generateBuildPlan, runScaffold } from './scaffold.js';`):

```js
import { deepenCharters } from './charters.js';
```

Then in `generateKickoffDocs`, after the `for (const kind of Object.keys(DOC_TITLES))` loop closes and BEFORE the final `commitIfChanged` block, insert:

```js
  // Deepen each role's charter now that the PRD exists — the richest context
  // we'll have. Per-role failures keep the baseline; an empty PRD is a no-op.
  const fresh = getProject(projectId);
  if (fresh) {
    try {
      const prd = readNote(projectId, DOC_FILENAMES.prd);   // DOC_FILENAMES.prd === 'PRD'
      await deepenCharters(fresh, { prd, callText, apiKey });
    } catch (err) { console.warn(`[kickoff] deepenCharters failed: ${err.message}`); }
  }
```

(`getProject`, `readNote`, `callText`, `apiKey`, and `DOC_FILENAMES` are all already in scope in this function/module.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/server/kickoff.test.js`
Expected: PASS (all kickoff tests, incl. the existing "writes four titled notes").

- [ ] **Step 5: Commit**

```bash
git add app/server/kickoff.js app/server/kickoff.test.js
git commit -m "feat(kickoff): deepen role charters from the PRD during generateKickoffDocs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PRD-aware `addAgent`

**Files:**
- Modify: `app/server/projects.js` (`addAgent`, lines ~264-267)
- Test: `app/server/project-docs.test.js`

- [ ] **Step 1: Write the failing test**

Add to `app/server/project-docs.test.js`:

```js
import { addAgent } from './projects.js';   // add to existing imports if not present

test('addAgent writes the baseline when no PRD exists yet', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-ws-'));
  const prev = process.env.BRIDGE_PROJECTS_BASE;
  process.env.BRIDGE_PROJECTS_BASE = base;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('no network'); };
  let p;
  try {
    p = await createProject({ name: 'Add NoPrd', goal: 'g', roleIds: ['pm'], topology: 'hub-and-spoke' });
    // Remove the seeded PRD.md so "no PRD" holds.
    rmSync(join(base, 'add-noprd', 'docs', 'PRD.md'), { force: true });
    await addAgent(p.id, 'designer');
    assert.match(readFileSync(join(base, 'add-noprd', 'docs', 'roles', 'role-designer.md'), 'utf8'), /## Role/);
  } finally {
    globalThis.fetch = realFetch;
    if (p) deleteProject(p.id);
    rmSync(base, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BRIDGE_PROJECTS_BASE; else process.env.BRIDGE_PROJECTS_BASE = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/server/project-docs.test.js`
Expected: FAIL — `addAgent` calls `generateProjectCharters` (→ `fetch`, throws), so the call rejects.

- [ ] **Step 3: Implement PRD-aware `addAgent`**

In `app/server/projects.js`, replace the charter block in `addAgent` (lines ~264-267):

```js
  // Only generate the new agent's charter — the rest are unchanged, so
  // regenerating the whole team was N redundant OpenRouter calls per add.
  try { await generateProjectCharters(p, { agents: [agent] }); }
  catch (err) { console.warn(`[addAgent] charter generation failed: ${err.message}`); }
```

with:

```js
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
```

Also update the `charters.js` import in `projects.js` (line 16) to add `deepenCharters` (now that Task 3 exports it):

```js
import { writeBaselineCharters, deepenCharters, charterFileNameFor, legacyCharterFileNames } from './charters.js';
```

Note: the seeded `PRD.md` at creation is a short stub ending with "_The PM will expand this into a full PRD during kickoff._" — it does NOT match the `_not generated_` sentinel, so post-creation `addAgent` will attempt to deepen from that stub. That is acceptable (the stub still carries goal/features/team). If you want adds before kickoff to use the baseline instead, that is a deliberate product choice — out of scope here; the current behavior tailors from whatever PRD content exists.

(`resolve`, `existsSync`, `readFileSync` are already imported at the top of `projects.js`; `writeBaselineCharters` and `deepenCharters` were imported in Task 2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/server/project-docs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server/projects.js app/server/project-docs.test.js
git commit -m "feat(projects): addAgent tailors a new agent's charter from the PRD when present

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite the 11 baseline charter templates (skill-distilled)

**Files:**
- Modify: `app/server/role-charters/role-pm.md`, `role-sw-eng.md`, `role-hw-eng.md`, `role-designer.md`, `role-qa.md`, `role-ds.md`, `role-security.md`, `role-researcher.md`, `role-copywriter.md`, `role-marketing.md`, `role-legal.md`
- Test: `app/server/charters.test.js`

This task produces richer baseline CONTENT. For the skill-mapped roles, READ the source skill(s) and distill their substance into the three charter sections; for the rest, hand-author to the same bar. The mapping (from the spec's provenance table):

- `role-pm.md` ← read `~/.claude/plugins/cache/pm-skills/{jobs-to-be-done,opportunity-solution-tree,roadmap-planning,prioritization-advisor,problem-framing-canvas}/SKILL.md`
- `role-designer.md` ← read `~/.claude/skills/{impeccable,layout,typeset,polish,critique}/SKILL.md`
- `role-researcher.md` ← read `~/.claude/plugins/cache/pm-skills/{discovery-process,customer-journey-mapping-workshop,jobs-to-be-done,problem-statement}/SKILL.md`
- `role-marketing.md` ← read `~/.claude/plugins/cache/pm-skills/{positioning-statement,positioning-workshop,acquisition-channel-advisor}/SKILL.md`
- `role-copywriter.md` ← read `~/.claude/skills/{distill,clarify,quieter}/SKILL.md`
- `role-legal.md` ← read `~/.claude/skills/provisional-patent/SKILL.md` (IP) + hand-author privacy/ToS/compliance/licensing
- `role-sw-eng.md`, `role-hw-eng.md`, `role-qa.md`, `role-ds.md`, `role-security.md` ← hand-author to the same standard (no skill match)

**Hard requirement:** every file keeps the exact headings `## Role`, `## Typical tasks`, `## Areas of expertise` (and a leading `# <Label>` line), so `validateCharterMarkdown` passes. NO provenance comments in the files (provenance lives in docs — Task 7). Keep each file focused (~120-220 words).

- [ ] **Step 1: Write the failing test (all baselines valid)**

Add to `app/server/charters.test.js`:

```js
import { listRoles } from './roles.js';

test('every active role baseline has the three required charter headings', () => {
  for (const r of listRoles()) {
    const md = loadBaseCharter(r.id);
    const v = validateCharterMarkdown(md);
    assert.equal(v.ok, true, `role ${r.id} invalid: ${v.reason || ''}`);
    assert.match(md, /^# /, `role ${r.id} missing top-level title`);
  }
});
```

- [ ] **Step 2: Run test to verify it passes for the CURRENT files (guard before edits)**

Run: `node --test app/server/charters.test.js`
Expected: PASS — this is a regression guard. It must stay green through the rewrite (it fails the moment any rewritten file drops a required heading).

- [ ] **Step 3: Read the mapped skills**

For each skill-mapped role, read the listed `SKILL.md` files (and any short `reference/*.md` that captures the core method). Note the discipline's real practices, vocabulary, and decision framing.

Example:
Run: `cat ~/.claude/skills/impeccable/SKILL.md ~/.claude/skills/layout/SKILL.md`
Expected: the design-craft guidance to distill into `role-designer.md` (typography scale, bold aesthetic direction, avoiding generic AI aesthetics, layout structure).

- [ ] **Step 4: Rewrite each baseline file**

Replace the contents of each `app/server/role-charters/role-*.md`. Concrete example for the designer (distilled from impeccable/layout/typeset/polish/critique) — write the analogous depth for every role:

```markdown
# Designer

## Role
You own the product's look, feel, and interaction — working in written specs and code, not visual tools. You set a bold, intentional aesthetic direction (not generic defaults), define the design principles and system, then the flows and screens, confirming direction with the team at each stage before building the UI in code.

## Typical tasks
- Commit to one clear aesthetic direction (tone, type, color, motion) and write it down before pixels.
- Define a modular type scale and a small, high-contrast set of UI sizes; pair a distinctive display face with a refined body face.
- Lay out screens with deliberate hierarchy, spacing rhythm, and alignment; design the empty/loading/error states, not just the happy path.
- Specify components and tokens so engineering can build consistently.
- Critique work against the principles and tighten the details that make it feel crafted.

## Areas of expertise
- Aesthetic direction and avoiding generic, templated UI
- Typography, layout, color, and spacing systems
- Interaction and state design (loading, empty, error, edge)
- Design systems, tokens, and design-to-code handoff
- Self-critique and detail polish
```

Then do `role-pm.md`, `role-sw-eng.md`, `role-hw-eng.md`, `role-qa.md`, `role-ds.md`, `role-security.md`, `role-researcher.md`, `role-copywriter.md`, `role-marketing.md`, `role-legal.md` to the same standard, distilling from the mapped skills (or hand-authoring for the unmapped engineering/QA/security/data roles). Keep the exact three headings in each.

- [ ] **Step 5: Run the validity test + full suite**

Run: `node --test app/server/charters.test.js`
Expected: PASS — every active role still validates.

Run: `node --test`
Expected: PASS for the charter/kickoff/project suites (pre-existing unrelated failures, if any, are unchanged — see Task 8).

- [ ] **Step 6: Commit**

```bash
git add app/server/role-charters/role-pm.md app/server/role-charters/role-sw-eng.md app/server/role-charters/role-hw-eng.md app/server/role-charters/role-designer.md app/server/role-charters/role-qa.md app/server/role-charters/role-ds.md app/server/role-charters/role-security.md app/server/role-charters/role-researcher.md app/server/role-charters/role-copywriter.md app/server/role-charters/role-marketing.md app/server/role-charters/role-legal.md app/server/charters.test.js
git commit -m "feat(charters): richer skill-distilled baseline charters for the 11 active roles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Provenance docs

**Files:**
- Modify: `HANDOFF.md` (add a "Charter baseline sources" subsection + behavior note)
- Modify: `docs/design.md` (add the provenance table + the deepen-at-PRD behavior)

- [ ] **Step 1: Add the provenance table to `docs/design.md`**

Append a subsection under the charters/kickoff area of `docs/design.md` titled `### Charter baseline sources` containing the exact provenance table from `specs/2026-06-08-prd-tailored-charters-design.md` (role → charter file → distilled-from skills → on-disk path → license/attribution, with the impeccable Apache-2.0 / "Based on Anthropic's frontend-design skill" line). Add a short paragraph describing the new behavior: baselines written verbatim at creation (no API), deepened from the PRD during kickoff (preserving `## Plan`), and the optional `BRIDGE_CHARTERS_DIR` override.

- [ ] **Step 2: Add the pointer + behavior note to `HANDOFF.md`**

In `HANDOFF.md`, under "What's new (latest session)", add a bullet:

```markdown
- **Skill-seeded, PRD-tailored charters.** Baselines (`app/server/role-charters/role-*.md`) are now distilled from best-in-class skills (designer←impeccable, pm←pm-skills, etc.); they're written verbatim at project creation (no API call) and deeply re-tailored from the PRD during kickoff (`deepenCharters`, preserves any `## Plan`). Optional `BRIDGE_CHARTERS_DIR` drops in override charters. Provenance/attribution table lives in `docs/design.md` and `specs/2026-06-08-prd-tailored-charters-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/design.md
git commit -m "docs: charter baseline provenance table + deepen-at-PRD behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(`docs/design.md` is tracked despite `docs/` being gitignored — it predates the ignore. `git add docs/design.md` may print an ignore warning but stages the tracked file.)

---

## Task 8: Full suite + hermeticity check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: the charter/kickoff/project suites PASS. Baseline is "106/107" with the single known pre-existing failure (`listRoles returns all 14 roles` — the catalog has 11). Confirm the count did not regress and no NEW failures appeared.

- [ ] **Step 2: Verify state hermeticity**

Run: `shasum app/state/projects.json`
Expected: identical before and after the suite run — the tests use temp `BRIDGE_STATE_DIR`/`BRIDGE_PROJECTS_BASE` and must never touch real state.

- [ ] **Step 3: Smoke-check the renderer is unaffected**

Run: `node --check app/renderer/main.js`
Expected: parses (this plan does not touch the renderer).

---

## Self-Review

**Spec coverage:**
- Hybrid baselines distilled once → Task 6 (mapping + rewrite). ✓
- Optional live override (`BRIDGE_CHARTERS_DIR`, drop-in folder, validated) → Task 1. ✓
- Baseline-now (creation, no API) → Task 2. ✓
- Deepen-at-PRD (full PRD context, preserve `## Plan`, per-role fallback, empty-PRD skip) → Tasks 3 + 4. ✓
- addAgent PRD-aware → Task 5. ✓
- Provenance in docs only (not in user-visible files) → Task 6 (no comments) + Task 7 (table). ✓
- Error handling layers (override→bundled→stub; deep fallback; deleted-mid-run guard) → Tasks 1, 3, 4. ✓
- Tests (baselines valid; override wins; creation API-free; deepen tailors+preserves plan; deepen fallback; empty-PRD skip; addAgent) → Tasks 1, 2, 3, 5, 6. ✓
- Out of scope respected (no team-review change beyond plan preservation; no SKILL.md parsing; orphan files untouched; no UI change) → honored. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Task 6 is the one content-generation task; it gives the exact files, the exact skill sources to read, a complete worked example (designer), and the invariant (3 headings) with a guard test — not a placeholder.

**Type/name consistency:** `writeBaselineCharters(project, {agents})`, `deepenCharters(project, {prd, callText, apiKey, agents})`, `splitPlan`, `buildDeepenPrompt`, `defaultCallText`, `DOC_FILENAMES.prd === 'PRD'`, charter filenames (`role-pm.md`, `role-sw-eng.md`, `role-hw-eng.md`, `role-ds.md`, `role-researcher.md`) all consistent across tasks and match the existing `CHARTER_SLUG_OVERRIDE` in `charters.js`. Import edits (projects.js line 16; kickoff.js after line 13; charters.js `getModelForRole`) are explicit. Cycle constraints honored (charters↛kickoff; projects↛notes).
