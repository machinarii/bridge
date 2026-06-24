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
import { interpretIntent } from './orchestrator.js';
import { setLastSpec, appendTurn } from './scratchpad.js';
import { emitActivity, emitDelegate, emitNotification, emitStatus, publish as publishEvent } from './events.js';
import { readNote, writeNote } from './backends/notes.js';
import { getModelForRole } from './models.js';
import { callOpenRouterText } from './llm.js';

const MAX_ACTIVE = 3;     // concurrent agent turns per project
const MAX_ATTEMPTS = 2;   // 1 retry on a thrown turn

const draining = new Map();  // projectId → in-flight drain promise

/** Queue a task and kick the project's drain loop (idempotent). Returns the task. */
export function enqueueTask({ projectId, agentId, description, from = null }, opts = {}) {
  const task = createTask({ projectId, agentId, description, from });
  drain(projectId, opts).catch(err => console.warn(`[executor] drain ${projectId}:`, err?.message));
  return task;
}

/** Run queued tasks for a project, up to MAX_ACTIVE at a time, until the queue
 * is empty. Re-entrant: a second call while running returns the same promise. */
export function drain(projectId, opts = {}) {
  if (draining.has(projectId)) return draining.get(projectId);
  const p = (async () => {
    for (;;) {
      const batch = [];
      while (batch.length < (opts.maxActive || MAX_ACTIVE)) {
        const t = nextQueued(projectId);
        if (!t) break;
        updateTask(t.id, { status: 'in_progress', attempts: t.attempts + 1 });
        batch.push(runTask(getTask(t.id), opts));
      }
      if (!batch.length) break;
      await Promise.allSettled(batch);
    }
  })().finally(() => draining.delete(projectId));
  draining.set(projectId, p);
  return p;
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
    const spec = await interpret({
      projectId: task.projectId, agentId: agent.id, text: task.description, effort: 'high',
      handoff: { from: fromName, fromRole, to: agent.name, toRole: getRole(agent.role).label },
    });
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
      const spec2 = await interpret({
        projectId: project.id, agentId: agent.id, text: answer, effort: 'high',
        handoff: { from: lead?.name || 'PM', fromRole: getRole('pm').label, to: agent.name, toRole: getRole(agent.role).label },
      });
      setLastSpec(agent.id, spec2);
      return settleReply(getTask(task.id), project, agent, spec2, opts);
    }
  }
  if (asksUser) {
    updateTask(task.id, { status: 'blocked_on_user' });
    emitActivity(project.id, `${agent.name}: needs your input`, agent.id, { awaitKind: 'reply' });
    emitNotification({ kind: 'info', projectId: project.id, title: `${agent.name} needs input`,
                       body: String(spec.title || spec.body || '').slice(0, 140) });
    return;
  }

  // 3. Deliverable → done. Report to the PM + persist the artifact as a doc.
  const body = String(spec?.body || spec?.title || '').trim();
  updateTask(task.id, { status: 'done', output: body.slice(0, 2000) });
  reportToLead(project, agent, task, body);
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
    `If the PRD, the goal, or sound product judgment determines the answer, reply with ONLY that answer ` +
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
