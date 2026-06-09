/* Bridge — charter customization. Loads base templates, calls OpenRouter to
 * rewrite them against a project's goal, validates the result, falls back
 * to the base verbatim on any failure. Written to <projectId>/roles/<roleId>.md.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRole } from './roles.js';
import { getModelForRole } from './models.js';

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

/* A handful of roles use a short charter slug instead of the full kebab label
 * (keyed by role id). Everything else derives from the label. */
const CHARTER_SLUG_OVERRIDE = {
  hw_engineer: 'hw-eng',
  pm: 'pm',
  sw_engineer: 'sw-eng',
  data_sci: 'ds',
};

function kebab(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* Charter files are named role-<slug>.md — never with underscores. The slug is
 * the role's short override if it has one, else the kebab-cased label (e.g. the
 * 'designer' role → role-designer.md). This is the single naming convention for
 * both the base templates and each project's customized copies. */
function charterFileName(role) {
  const slug = CHARTER_SLUG_OVERRIDE[role.id] || kebab(role.label);
  return `role-${slug}.md`;
}

/** The charter filename for a role id (e.g. 'sw_engineer' → role-sw-eng.md). */
export function charterFileNameFor(roleId) {
  const role = getRole(roleId);
  if (!role) throw new Error(`unknown role: ${roleId}`);
  return charterFileName(role);
}

/** Charter filenames a role may have used on disk historically (for migration
 * to the current canonical name): the legacy <roleId>.md and the full kebab
 * role-<label>.md, in addition to any current override. */
export function legacyCharterFileNames(roleId) {
  const role = getRole(roleId);
  if (!role) return [];
  return [`${roleId}.md`, `role-${kebab(role.label)}.md`];
}

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
  if (existsSync(path)) return readFileSync(path, 'utf8');
  // Last resort: a minimal VALID stub (3 required headings) so charter writing
  // never hard-fails. All 11 active baselines ship committed, so this is
  // effectively unreachable — it only guards a deleted/corrupt bundled file.
  console.warn(`[charters] missing bundled charter ${fname}; using minimal stub`);
  return `# ${role.label}\n\n## Role\n_(charter unavailable)_\n\n## Typical tasks\n- _(to be defined)_\n\n## Areas of expertise\n- _(to be defined)_\n`;
}

export function validateCharterMarkdown(md) {
  for (const h of REQUIRED_HEADINGS) {
    if (!md.includes(h)) return { ok: false, reason: `missing heading: ${h}` };
  }
  return { ok: true };
}

async function callOpenRouter({ apiKey, model, prompt, timeoutMs = CHARTER_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

/** Customize roles for a project in parallel, with a hard cap on concurrent
 *  in-flight requests. Writes results to disk. Pass `agents` to regenerate only
 *  a subset (e.g. just the newly-added agent) instead of the whole team. */
export async function generateProjectCharters(project, { concurrency = 5, agents } = {}) {
  const targets = agents || project.agents;
  const tasks = targets.map(a => async () => {
    const r = await customizeCharter({
      projectName: project.name,
      goal: project.goal,
      agentName: a.name,
      roleId: a.role,
    });
    const rolesDir = resolve(project.repoPath, 'docs', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    const path = resolve(rolesDir, charterFileName(getRole(a.role)));
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

/** Read a project's customized charter (or base if not yet written). */
export function readProjectCharter(projectId, roleId) {
  const path = resolve(STATE_DIR, projectId, 'roles', charterFileNameFor(roleId));
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return loadBaseCharter(roleId);
}

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
async function defaultCallText({ apiKey, model, prompt, timeoutMs }) {
  const r = await callOpenRouter({ apiKey, model, prompt, timeoutMs });
  return r.ok ? r.content : '';
}

/** Re-tailor each agent's charter using the full PRD as context, AFTER the PRD
 *  exists (kickoff). Overwrites the three charter sections in place, preserving
 *  any "## Plan" section. Per-role failures keep the existing charter unchanged
 *  (never clobber with garbage). Empty/"not generated" PRD -> no-op. Returns a
 *  per-agent result list ({agentId, roleId, deepened}). */
export async function deepenCharters(project, { prd, callText, apiKey, agents } = {}) {
  const text = String(prd || '').trim();
  if (!text || /^_?not generated_?$/i.test(text)) return [];   // no useful context -> keep baselines
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
