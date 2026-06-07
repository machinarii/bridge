/* The sequential team planning round (Phase A, §4 steps 2–3). After kickoff,
 * each enabled specialist (non-lead) records a domain plan before the PM
 * proposes a build plan. Deterministic state machine only — model-driven plan
 * generation and live kickoff wiring land in Plan 4. */
import { getProject, setProjectState } from './projects.js';
import { writeNote, listNotes, readNote } from './backends/notes.js';
import { getModelForRole } from './models.js';
import { getRole } from './roles.js';
import { generateBuildPlan } from './scaffold.js';

/** The enabled, non-lead agents in tile order — the round's queue. */
export function teamReviewAgents(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  return p.agents.filter(a => a.enabled && a.id !== p.leadAgentId);
}

/** Begin the round: phase → team_review, queue the specialists, reset capture. */
export function startTeamReview(projectId) {
  const agents = teamReviewAgents(projectId);
  const captured = {};
  for (const a of agents) captured[a.id] = { planned: false, answered: false };
  setProjectState(projectId, {
    phase: 'team_review',
    teamReview: { order: agents.map(a => a.id), idx: 0, captured },
  });
  return getProject(projectId)?.teamReview || null;
}

/** The agent whose turn it is, or null when the queue is exhausted. */
export function currentReviewAgent(projectId) {
  const p = getProject(projectId);
  const tr = p?.teamReview;
  if (!tr || tr.idx >= tr.order.length) return null;
  const id = tr.order[tr.idx];
  return p.agents.find(a => a.id === id) || null;
}

/** True once every queued agent has been captured (planned or answered). */
export function teamReviewReady(projectId) {
  const tr = getProject(projectId)?.teamReview;
  if (!tr || !tr.order.length) return false;
  return tr.order.every(id => {
    const c = tr.captured[id];
    return !!c && (c.planned || c.answered);
  });
}

/** Capture an agent's domain plan: write it to the repo docs as plan-<role>.md,
 * mark the agent captured, and advance the queue if it was the current turn.
 * `answered` flags that the agent's question was answered (vs. only planned). */
export function recordPlan(projectId, agentId, planMarkdown, { answered = false } = {}) {
  const p = getProject(projectId);
  const tr = p?.teamReview;
  if (!tr || !tr.captured[agentId]) return null;
  const agent = p.agents.find(a => a.id === agentId);
  if (planMarkdown && agent) writeNote(projectId, `plan-${agent.role}`, planMarkdown);
  tr.captured[agentId] = { planned: true, answered: !!answered };
  if (tr.order[tr.idx] === agentId) tr.idx += 1;
  setProjectState(projectId, { teamReview: tr });
  return tr;
}

/** Captured planning docs as model context. */
function reviewDocs(projectId) {
  return listNotes(projectId)
    .map(n => `### ${n.id}\n${readNote(projectId, n.id) || ''}`)
    .join('\n\n');
}

/** Generate one agent's domain plan from the captured docs and record it. */
export async function planAgentTurn(projectId, agentId, { callText, apiKey } = {}) {
  const p = getProject(projectId);
  const agent = p?.agents.find(a => a.id === agentId);
  if (!agent) return null;
  const roleLabel = getRole(agent.role)?.label || agent.role;
  const prompt =
    `You are ${agent.name}, the ${roleLabel} on project "${p.name}" (goal: "${p.goal}"). ` +
    `Review the captured planning docs and write YOUR short domain plan in markdown: ` +
    `what you'll own and your first 3-5 concrete steps toward the goal. Markdown only.\n\n` +
    `Docs:\n${reviewDocs(projectId)}`;
  let md = '';
  try { md = String(await callText({ apiKey, model: getModelForRole(agent.role), prompt, timeoutMs: 30_000 }) || '').trim(); }
  catch { md = ''; }
  if (!md) md = `# ${agent.name} — ${roleLabel} plan\n\n_(plan not generated)_\n`;
  recordPlan(projectId, agentId, md);
  return getProject(projectId)?.teamReview || null;
}

/** When the round is complete, propose the PM build plan (→ phase build_pending).
 * Returns the plan, or null if the round isn't ready yet. */
export async function maybeFinishTeamReview(projectId, { callText, apiKey } = {}) {
  if (!teamReviewReady(projectId)) return null;
  return generateBuildPlan(projectId, { callText, apiKey });
}

/** Parse a specialist question reply: tolerant JSON ({question, options}) —
 * handles fenced blocks and surrounding prose. Returns {q, options} with a
 * real, non-empty question, or null if there's nothing usable. */
export function parseReviewQuestion(raw) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fenced ? fenced[1]
    : (s.indexOf('{') >= 0 ? s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1) : '');
  try {
    const o = JSON.parse(cand);
    const q = String(o?.question || '').trim();
    if (!q) return null;
    const options = Array.isArray(o?.options)
      ? o.options.map(x => String(x).trim()).filter(Boolean).slice(0, 4)
      : [];
    return { q, options };
  } catch { return null; }
}

/** Generate ONE focused domain question (with 2-4 short options) from a
 * specialist, to ask the user during the round. Returns {q, options} on success,
 * or null when the model yields nothing usable — the caller then SKIPS this
 * specialist rather than showing a hollow, generic bubble. Retries once on an
 * empty/unparseable reply and logs failures (never silently degrades). */
export async function teamReviewQuestion(projectId, agentId, { callText, apiKey, retries = 2 } = {}) {
  const p = getProject(projectId);
  const agent = p?.agents.find(a => a.id === agentId);
  if (!agent) return null;
  const role = getRole(agent.role);
  const roleLabel = role?.label || agent.role;
  const persona = role?.personaSeed ? `\nYour perspective as ${roleLabel}: ${role.personaSeed}` : '';
  const prompt =
    `You are ${agent.name}, the ${roleLabel} on project "${p.name}".\nGoal: "${p.goal}".${persona}\n\n` +
    `Here is everything the team has planned so far:\n${reviewDocs(projectId) || '(no docs yet)'}\n\n` +
    `As the ${roleLabel}, there is a REAL, concrete decision you need from the user before you can do ` +
    `your part well. Ask the single most important such question — specific to THIS project and YOUR ` +
    `domain (never generic, never "what matters most"). Give 2-4 short, distinct answer options that ` +
    `are genuine, mutually-exclusive choices. Output ONLY JSON: ` +
    `{"question": "<your specific question>", "options": ["<choice>", "<choice>", ...]}. No prose.`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw = '';
    try { raw = String(await callText({ apiKey, model: getModelForRole(agent.role), prompt, timeoutMs: 30_000 }) || ''); }
    catch (err) { console.warn(`[team-review] question call failed for ${agent.name} (${agent.role}):`, err?.message || err); continue; }
    const parsed = parseReviewQuestion(raw);
    if (parsed) return parsed;
    if (attempt < retries) console.warn(`[team-review] empty/unparseable question for ${agent.name} (${agent.role}); retrying`);
  }
  console.warn(`[team-review] no usable question for ${agent.name} (${agent.role}); skipping their turn`);
  return null;
}
