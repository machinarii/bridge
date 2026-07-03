/* Bridge — autonomous task executor. Drains the per-project task queue: each
 * task is one agent turn (interpretIntent). The reply settles the task:
 *   - delegate intent      → enqueue a task for the target teammate (async)
 *   - question (choices)   → try a PM auto-answer; else blocked_on_user
 *   - anything else        → done; deliverable reported to the PM + saved as a doc
 * Transient errors retry once; repeated failure marks the task failed and
 * surfaces in the activity feed. All model calls are DI-injectable for tests
 * (opts.interpret, opts.callText), mirroring the kickoff callText idiom. */

import { createTask, getTask, updateTask, nextQueued, tasksForAgent } from './tasks.js';
import { getProject, addAgent } from './projects.js';
import { getRole } from './roles.js';
import { charterFileNameFor } from './charters.js';
import { interpretIntent, kickoffDecisionsBlock } from './orchestrator.js';
import { setLastSpec, appendTurn } from './scratchpad.js';
import { emitActivity, emitDelegate, emitNotification, emitStatus, publish as publishEvent } from './events.js';
import { readNote, writeNote } from './backends/notes.js';
import { getModelForRole } from './models.js';
import { callOpenRouterText } from './llm.js';

const MAX_ACTIVE = 3;     // concurrent agent turns per project
const MAX_ATTEMPTS = 2;   // 1 retry on a thrown turn
const TURN_TIMEOUT_MS = 240_000;  // a hung turn fails instead of freezing the queue
// A blocked task doesn't wait on the user forever: after this window the PM
// directs the agent to proceed on best judgment (once per task). Set
// BRIDGE_BLOCKED_TIMEOUT_MIN=0 to disable the fallback.
const BLOCKED_FALLBACK_MS = Number(process.env.BRIDGE_BLOCKED_TIMEOUT_MIN ?? 10) * 60_000;

const draining = new Map();  // projectId → in-flight drain promise

/** Reject after `ms` so a turn whose connection stalled forever fails the task
 * (and retries/reports through the normal path) instead of wedging its worker. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}

/** Queue a task and kick the project's drain loop (idempotent). Returns the task. */
export function enqueueTask({ projectId, agentId, description, from = null }, opts = {}) {
  const task = createTask({ projectId, agentId, description, from });
  drain(projectId, opts).catch(err => console.warn(`[executor] drain ${projectId}:`, err?.message));
  return task;
}

/** Run queued tasks for a project, up to MAX_ACTIVE at a time, until the queue
 * is empty. Re-entrant: a second call while running returns the same promise.
 * A work-stealing POOL (not a batch): every task completion and every enqueue
 * pumps the scheduler, so a free slot picks up new work immediately — one slow
 * turn never holds up the others, and tasks enqueued mid-drain (delegations)
 * start as soon as a slot frees (the old batch model waited for the whole
 * batch before starting more). */
export function drain(projectId, opts = {}) {
  const existing = draining.get(projectId);
  if (existing) { pump(projectId); return existing.promise; }
  const state = { active: 0, opts, max: opts.maxActive || MAX_ACTIVE };
  state.promise = new Promise(r => { state.resolve = r; });
  draining.set(projectId, state);
  pump(projectId);
  maybeSettle(projectId);   // nothing queued at all → settle immediately
  return state.promise;
}

function pump(projectId) {
  const state = draining.get(projectId);
  if (!state) return;
  while (state.active < state.max) {
    const t = nextQueued(projectId);
    if (!t) break;
    // Claiming (queued → in_progress) is synchronous, so two pumps can never
    // grab the same task.
    updateTask(t.id, { status: 'in_progress', attempts: t.attempts + 1 });
    state.active++;
    runTask(getTask(t.id), state.opts)
      .catch(err => console.warn(`[executor] runTask ${t.id}:`, err?.message))
      .finally(() => { state.active--; pump(projectId); maybeSettle(projectId); });
  }
}

function maybeSettle(projectId) {
  const state = draining.get(projectId);
  if (!state) return;
  if (state.active === 0 && !nextQueued(projectId)) {
    draining.delete(projectId);
    state.resolve();
  }
}

/** The user messaged an agent that was blocked waiting on them — the agent
 * continues in chat, so the executor's claim on those tasks closes. */
export function resolveBlockedForAgent(agentId) {
  let n = 0;
  for (const t of tasksForAgent(agentId, 'blocked_on_user')) {
    updateTask(t.id, { status: 'done', output: 'continued in chat with the user' });
    n++;
  }
  return n;
}

async function runTask(task, opts = {}) {
  const project = getProject(task.projectId);
  const agent = project?.agents.find(a => a.id === task.agentId);
  if (!project || !agent) {
    updateTask(task.id, { status: 'failed', output: 'project or agent no longer exists' });
    return;
  }
  const interpret = opts.interpret || interpretIntent;
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  const fromName = task.from?.name || lead?.name || 'PM';
  const fromRole = task.from?.role || getRole('pm').label;
  try {
    emitDelegate(task.projectId, task.from?.agentId || project.leadAgentId, agent.id, task.description);
    const spec = await withTimeout(interpret({
      projectId: task.projectId, agentId: agent.id, text: task.description, effort: 'high',
      handoff: { from: fromName, fromRole, to: agent.name, toRole: getRole(agent.role).label },
    }), opts.turnTimeoutMs || TURN_TIMEOUT_MS, `${agent.name} turn`);
    setLastSpec(agent.id, spec);
    // Keep the agent visibly working through the settle phase: interpretIntent
    // ends on 'idle', but settleReply may still run a PM auto-answer + a second
    // turn — a status gap that made the L2 "…" bubble vanish on re-entry.
    emitStatus(task.projectId, agent.id, 'analyzing');
    try { await settleReply(task, project, agent, spec, opts); }
    finally { emitStatus(task.projectId, agent.id, 'idle'); }
  } catch (err) {
    if (task.attempts < MAX_ATTEMPTS) {
      updateTask(task.id, { status: 'queued' });   // the drain loop picks it up again
      return;
    }
    updateTask(task.id, { status: 'failed', output: String(err?.message || err) });
    emitActivity(task.projectId, `${agent.name}: task failed — ${String(err?.message || err).slice(0, 80)}`, agent.id);
    emitNotification({ kind: 'warn', projectId: task.projectId, title: `${agent.name}: task failed`,
                       body: task.description.slice(0, 140) });
  }
}

/** Classify an agent reply and settle the task accordingly. */
async function settleReply(task, project, agent, spec, opts) {
  // 1. Delegate → the work belongs to a teammate. Enqueue THEIR task (async,
  //    not nested inside this turn) and close this one.
  if (spec?.intent === 'delegate') {
    const toRole = String(spec.to_role || '').trim();
    let target = getProject(project.id)?.agents.find(a => a.enabled && a.role === toRole);
    if (!target && toRole !== 'pm' && getRole(toRole)) {
      try {
        const p2 = await addAgent(project.id, toRole);
        target = p2.agents.find(a => a.role === toRole);
        publishEvent({ type: 'team_changed', projectId: project.id });
      } catch (err) { console.warn(`[executor] could not add ${toRole}:`, err?.message); }
    }
    if (!target) {
      updateTask(task.id, { status: 'failed', output: `delegate to unknown role "${toRole}"` });
      emitActivity(project.id, `${agent.name}: task failed — delegate to unknown role "${toRole}"`, agent.id);
      emitNotification({ kind: 'warn', projectId: project.id, title: `${agent.name}: delegation failed`,
                         body: `No agent for role "${toRole}" — task: ${task.description.slice(0, 100)}` });
      return;
    }
    const desc = (String(spec.task || '').trim() || `Help with: ${spec.body || ''}`).slice(0, 400);
    enqueueTask({ projectId: project.id, agentId: target.id, description: desc,
                  from: { agentId: agent.id, name: agent.name, role: getRole(agent.role)?.label || '' } }, opts);
    updateTask(task.id, { status: 'done', output: `delegated to ${target.name}: ${desc}` });
    return;
  }

  // 2. A question → let the PM try to answer from project context before the
  //    task blocks on the user. One attempt per task (pmAnswered guard).
  const asksUser = Array.isArray(spec?.choices) && spec.choices.length > 0;
  if (asksUser && !task.pmAnswered) {
    const answer = await tryPmAnswer(project, agent, spec, opts);
    if (answer) {
      updateTask(task.id, { pmAnswered: true });
      const lead = project.agents.find(a => a.id === project.leadAgentId);
      const interpret = opts.interpret || interpretIntent;
      emitDelegate(project.id, project.leadAgentId, agent.id, answer);
      const spec2 = await withTimeout(interpret({
        projectId: project.id, agentId: agent.id, text: answer, effort: 'high',
        handoff: { from: lead?.name || 'PM', fromRole: getRole('pm').label, to: agent.name, toRole: getRole(agent.role).label },
      }), opts.turnTimeoutMs || TURN_TIMEOUT_MS, `${agent.name} turn`);
      setLastSpec(agent.id, spec2);
      return settleReply(getTask(task.id), project, agent, spec2, opts);
    }
  }
  if (asksUser) {
    updateTask(task.id, { status: 'blocked_on_user' });
    emitActivity(project.id, `${agent.name}: needs your input`, agent.id, { awaitKind: 'reply' });
    emitNotification({ kind: 'info', projectId: project.id, title: `${agent.name} needs input`,
                       body: String(spec.title || spec.body || '').slice(0, 140) });
    scheduleBlockedFallback(task, opts);
    return;
  }

  // 3. Deliverable → done. Report to the PM + persist the artifact as a doc.
  const body = String(spec?.body || spec?.title || '').trim();
  updateTask(task.id, { status: 'done', output: body.slice(0, 2000) });
  reportToLead(project, agent, task, body);
}

/** After the fallback window, a task still blocked on the user resumes on the
 * PM's best-judgment directive — once per task (autoResumed guard), so a
 * repeat question blocks permanently and genuinely waits for the human. */
function scheduleBlockedFallback(task, opts = {}) {
  const ms = opts.blockTimeoutMs ?? BLOCKED_FALLBACK_MS;
  if (!(ms > 0)) return;
  if (getTask(task.id)?.autoResumed) return;
  const timer = setTimeout(() => {
    resumeBlockedTask(task.id, opts)
      .catch(err => console.warn(`[executor] blocked fallback ${task.id}:`, err?.message));
  }, ms);
  timer.unref?.();
}

/** Resume a blocked task with a best-judgment directive from the PM. No-op if
 * the user already answered (status changed) or the task is gone. */
export async function resumeBlockedTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task || task.status !== 'blocked_on_user') return;
  const project = getProject(task.projectId);
  const agent = project?.agents.find(a => a.id === task.agentId);
  if (!project || !agent) return;
  const directive = 'No reply from the user — use your best judgment: pick the option that best serves the ' +
    'project goal, state your assumption briefly, and complete the task in this reply.';
  updateTask(task.id, { status: 'in_progress', autoResumed: true });
  emitActivity(project.id, `${agent.name}: no reply — proceeding on best judgment`, agent.id);
  const interpret = opts.interpret || interpretIntent;
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  emitStatus(project.id, agent.id, 'analyzing');
  try {
    emitDelegate(project.id, project.leadAgentId, agent.id, directive);
    const spec = await withTimeout(interpret({
      projectId: project.id, agentId: agent.id, text: directive, effort: 'high',
      handoff: { from: lead?.name || 'PM', fromRole: getRole('pm').label, to: agent.name, toRole: getRole(agent.role).label },
    }), opts.turnTimeoutMs || TURN_TIMEOUT_MS, `${agent.name} turn`);
    setLastSpec(agent.id, spec);
    await settleReply(getTask(task.id), project, agent, spec, opts);
  } catch (err) {
    updateTask(task.id, { status: 'failed', output: String(err?.message || err) });
    emitActivity(project.id, `${agent.name}: task failed — ${String(err?.message || err).slice(0, 80)}`, agent.id);
  } finally { emitStatus(project.id, agent.id, 'idle'); }
}

/** PM answers a specialist's question from the PRD/goal, or returns null to
 * escalate to the user. Replies "ASK USER" → null. */
async function tryPmAnswer(project, agent, spec, opts = {}) {
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) return null;
  const ct = opts.callText || callOpenRouterText;
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  const prd = (() => { try { return readNote(project.id, 'PRD') || ''; } catch { return ''; } })();
  const question = [spec.title, spec.body].filter(Boolean).join('\n');
  const prompt =
    `You are ${lead?.name || 'the PM'}, PM of project "${project.name}". Goal: "${project.goal}".\n` +
    `Your teammate ${agent.name} (${getRole(agent.role)?.label}) asked this while working on their task:\n` +
    `---\n${question}\nOptions offered: ${spec.choices.join(' / ')}\n---\n` +
    (prd ? `Project PRD:\n---\n${String(prd).slice(0, 4000)}\n---\n` : '') +
    kickoffDecisionsBlock(project.id) +
    `If the PRD, the kickoff decisions, the goal, or sound product judgment determines the answer, reply with ONLY that answer ` +
    `(short and direct; picking one of the options is fine). ` +
    `If this genuinely needs the human's preference or information you don't have, reply with exactly: ASK USER`;
  const raw = await ct({ apiKey, model: getModelForRole('pm'), prompt, timeoutMs: 20_000 });
  const t = String(raw || '').trim();
  if (!t || /^ASK USER\b/i.test(t)) return null;
  return t.slice(0, 400);
}

/* Preview of a deliverable for the report bubble. Preserves the markdown
 * structure (lists, headings, line breaks) so it renders readably instead of a
 * flattened run-on line, and truncates at a line/sentence boundary — never
 * mid-word — noting that the full deliverable is saved as a project doc. */
function reportSnippet(body) {
  const text = String(body || '').trim();
  const LIMIT = 1200;
  if (text.length <= LIMIT) return text;
  let cut = text.slice(0, LIMIT);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  if (boundary > LIMIT * 0.5) cut = cut.slice(0, boundary);
  return cut.trimEnd() + '\n\n*…full deliverable saved to the project docs.*';
}

/** Surface a finished deliverable: foreign-author bubble in the PM chat, a
 * "Deliverable — <agent>" project doc, and an activity entry. */
function reportToLead(project, agent, task, body) {
  const snippet = reportSnippet(body);
  if (project.leadAgentId && project.leadAgentId !== agent.id) {
    appendTurn(project.leadAgentId, 'assistant',
      JSON.stringify({ body: `Finished: ${task.description}\n\n${snippet}` }),
      { author: { id: agent.id, name: agent.name, role: getRole(agent.role)?.label || '' } });
  }
  if (body) {
    // Land deliverables in a deliverables/ folder, named by ROLE slug (the same
    // short slug as the charters) — e.g. deliverables/deliverables-designer.md,
    // deliverables/deliverables-sw-eng.md.
    const roleSlug = charterFileNameFor(agent.role).replace(/^role-/, '').replace(/\.md$/i, '');
    try { writeNote(project.id, `deliverables/deliverables-${roleSlug}`, body); }
    catch (err) { console.warn(`[executor] deliverable doc:`, err?.message); }
  }
  emitActivity(project.id, `${agent.name}: task complete — ${task.description.slice(0, 60)}`, agent.id, { awaitKind: 'view' });
}
