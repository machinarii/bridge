/* Bridge — the Chief of Staff loop.
 *
 * Every agent in Bridge is scoped to one project; Layer 0 (the project list)
 * has no agent at all, so nobody holds the whole board. The Chief of Staff is
 * that missing seat: on a cadence it reads every project and every task and
 * writes ONE brief — what needs you, what moved, what's stuck.
 *
 * It is deliberately read-only. It reports and escalates; it never reassigns
 * work or answers on your behalf. The PM already covers the in-project version
 * of that (executor.js's blocked-task fallback); acting across projects
 * unsupervised is a bigger call than a background timer should make.
 *
 * The brief is a named artifact: <stateDir>/briefs/<iso>.md, latest served by
 * GET /brief. It surfaces live as a cross-project activity entry + notification
 * (a projectId-less event reaches every subscriber — see events.js).
 *
 * It is NOT an entry in roles.js on purpose: everything there becomes a
 * selectable project role, and this seat is cross-project by definition.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';
import { listProjects } from './projects.js';
import { listAllTasks } from './tasks.js';
import { getRole } from './roles.js';
import { getModelForRole } from './models.js';
import { callOpenRouterText } from './llm.js';
import { emitActivity, emitNotification } from './events.js';

// An in_progress task older than this is stalled, not working. A turn is capped
// at 4 minutes (executor.js TURN_TIMEOUT_MS), so anything past an hour is stuck.
const STALE_MS = Number(process.env.BRIDGE_STALE_TASK_MIN || 60) * 60_000;
const BRIEF_TIMEOUT_MS = 60_000;
const MAX_PER_SECTION = 12;   // keep the digest (and the prompt) bounded

function briefsDir() { return join(stateDir(), 'briefs'); }

/** The whole board, bucketed. `since` splits "moved" from "already known". */
export function boardSnapshot({ now = Date.now(), since = 0 } = {}) {
  const projects = new Map();
  for (const p of listProjects()) {
    projects.set(p.id, {
      id: p.id, name: p.name, goal: p.goal,
      agents: new Map((p.agents || []).map(a => [a.id, a])),
      queued: 0, active: 0, needsYou: [], stalled: [], failed: [], finished: [],
    });
  }
  for (const t of listAllTasks()) {
    const p = projects.get(t.projectId);
    if (!p) continue;   // task from a deleted project
    const agent = p.agents.get(t.agentId);
    const entry = {
      id: t.id,
      agent: agent?.name || t.agentId,
      role: getRole(agent?.role)?.label || '',
      description: t.description,
      output: t.output,
      ageMin: Math.round((now - t.updatedAt) / 60_000),
    };
    if (t.status === 'queued') p.queued++;
    else if (t.status === 'in_progress') {
      p.active++;
      if (now - t.updatedAt > STALE_MS) p.stalled.push(entry);
    }
    else if (t.status === 'blocked_on_user') p.needsYou.push(entry);
    else if (t.status === 'failed' && t.updatedAt > since) p.failed.push(entry);
    else if (t.status === 'done' && t.updatedAt > since) p.finished.push(entry);
  }
  const list = [...projects.values()].map(p => ({ ...p, agents: undefined }));
  const totals = ['needsYou', 'stalled', 'failed', 'finished'].reduce((acc, k) => {
    acc[k] = list.reduce((n, p) => n + p[k].length, 0);
    return acc;
  }, { queued: list.reduce((n, p) => n + p.queued, 0), active: list.reduce((n, p) => n + p.active, 0) });
  return { at: now, since, projects: list, totals };
}

/** Nothing to say → no brief, no model call. A quiet board stays quiet. */
export function isNotable(snap) {
  const t = snap.totals;
  return t.needsYou > 0 || t.stalled > 0 || t.failed > 0 || t.finished > 0;
}

/** The one-line summary that rides the activity feed + notification. */
export function headline(snap) {
  const t = snap.totals;
  const bits = [];
  if (t.needsYou) bits.push(`${t.needsYou} need${t.needsYou === 1 ? 's' : ''} you`);
  if (t.stalled)  bits.push(`${t.stalled} stalled`);
  if (t.failed)   bits.push(`${t.failed} failed`);
  if (t.finished) bits.push(`${t.finished} finished`);
  if (t.active)   bits.push(`${t.active} running`);
  return bits.join(' · ') || 'board quiet';
}

function section(label, entries) {
  if (!entries.length) return '';
  return `  ${label}:\n` + entries.slice(0, MAX_PER_SECTION)
    .map(e => `    - ${e.agent} (${e.role}): ${e.description}` +
              (e.ageMin ? ` [${e.ageMin}m ago]` : '') +
              (e.output ? ` — ${String(e.output).replace(/\s+/g, ' ').slice(0, 200)}` : ''))
    .join('\n') + '\n';
}

export function digest(snap) {
  return snap.projects.map(p =>
    `- ${p.name} — goal: ${p.goal || '(none)'} · ${p.active} running, ${p.queued} queued\n` +
    section('BLOCKED ON THE HUMAN', p.needsYou) +
    section('STALLED', p.stalled) +
    section('FAILED', p.failed) +
    section('FINISHED since last brief', p.finished)
  ).join('\n');
}

export function buildPrompt(snap) {
  const instructions = String(process.env.AI_INSTRUCTIONS || '').trim();
  return (
    `You are the Chief of Staff to someone running ${snap.projects.length} project(s), each staffed by a team ` +
    `of AI agents. You are the only one who sees the whole board. Write their brief — the thing they read to ` +
    `know where to spend the next hour.\n\n` +
    `THE BOARD (as of ${new Date(snap.at).toISOString()}${snap.since ? `; "since last brief" = since ${new Date(snap.since).toISOString()}` : ''}):\n` +
    `${digest(snap)}\n\n` +
    `Write markdown, no preamble, under 250 words:\n` +
    `## Needs you — tasks blocked on the human. Name project, agent, and the actual question. Most consequential first.\n` +
    `## Moving — what progressed since the last brief, one line each, grouped by project.\n` +
    `## Stalled — stuck or failed work, each with what you'd do about it.\n` +
    `Close with one line: **Next:** the single highest-leverage thing they should do right now.\n` +
    `Omit any section that would be empty. Be specific and telegraphic — no filler, no praise, and don't read ` +
    `the board back to them. You report and escalate; you do not reassign work.` +
    (instructions ? `\n\nThe user's standing instructions (honor them):\n${instructions}` : '')
  );
}

/** Persist the brief as a timestamped artifact. Returns its id. */
export function writeBrief(markdown, at = Date.now()) {
  ensureStateDir();
  mkdirSync(briefsDir(), { recursive: true });
  const id = new Date(at).toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(briefsDir(), `${id}.md`), markdown, 'utf8');
  return id;
}

/** The most recent brief, or null. Filenames are ISO stamps, so last = latest. */
export function latestBrief() {
  if (!existsSync(briefsDir())) return null;
  const files = readdirSync(briefsDir()).filter(f => f.endsWith('.md')).sort();
  const f = files.at(-1);
  if (!f) return null;
  return { id: f.replace(/\.md$/, ''), body: readFileSync(join(briefsDir(), f), 'utf8') };
}

/** One pass: read the board, write the brief, surface it. Returns null when
 * there was nothing worth saying (or no key configured). */
export async function runChiefOfStaff(opts = {}) {
  const now = opts.now || Date.now();
  const snap = boardSnapshot({ now, since: opts.lastRun || opts.since || 0 });
  if (!isNotable(snap)) return null;
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) return null;
  const ct = opts.callText || callOpenRouterText;
  const markdown = String(await ct({
    apiKey,
    model: getModelForRole('pm'),
    prompt: buildPrompt(snap),
    timeoutMs: BRIEF_TIMEOUT_MS,
    meta: { role: 'pm', kind: 'chief_of_staff' },
    signal: opts.signal || null,
  }) || '').trim();
  if (!markdown) return null;
  const line = headline(snap);
  const id = writeBrief(markdown, now);
  emitActivity(null, `Chief of Staff: ${line}`, null, { brief: id });
  emitNotification({ kind: 'info', title: 'Chief of Staff brief', body: line.slice(0, 140) });
  return { id, headline: line, body: markdown, totals: snap.totals };
}

export const chiefOfStaffLoop = {
  id: 'chief-of-staff',
  everyMs: Math.max(1, Number(process.env.BRIDGE_BRIEF_INTERVAL_MIN || 30)) * 60_000,
  run: runChiefOfStaff,
};
