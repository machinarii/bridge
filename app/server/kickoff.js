/* Bridge — PM auto-kickoff. After a project is created the PM posts a
 * plan-first kickoff to the lead chat; on approval it generates a PRD +
 * supporting docs and assigns topology-shaped starting tasks to the team.
 * See docs/superpowers/specs/2026-06-03-pm-kickoff-design.md. */

import { getRole } from './roles.js';
import { getProject, setKickoff, TOPOLOGIES } from './projects.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getModelForRole, getRouterModel } from './models.js';
import { emitNotification, emitActivity, emitDelegate, publish as publishEvent } from './events.js';
import { appendNote } from './backends/notes.js';

export const DOC_TITLES = {
  prd:       'PRD',
  roadmap:   'Roadmap & Milestones',
  operating: 'Team Operating Notes',
  questions: 'Open Questions',
};

const AFFIRM = /\b(yes|yep|yeah|yup|sure|ok|okay|go|proceed|approve[d]?|do it|sounds good|looks good|lgtm|ship it|let'?s go)\b/i;
const NEGATE = /\b(no|not yet|hold|wait|stop|change|revise|instead|different|don'?t)\b/i;

/** Cheap heuristic classifier for the approval reply. Returns
 *  'approve' | 'revise' | 'unsure'. The caller may escalate 'unsure' to a
 *  model classification. */
export function classifyApproval(text) {
  const t = String(text || '').trim();
  if (!t) return 'unsure';
  if (NEGATE.test(t)) return 'revise';
  if (AFFIRM.test(t)) return 'approve';
  return 'unsure';
}

/** One-line instruction telling the assignment pass how to shape tasks for
 *  the chosen work topology. */
export function topologyGuidance(topologyId) {
  switch (topologyId) {
    case 'hub-and-spoke':
      return 'Assign one discrete task to each relevant specialist; they report back to the PM, not to each other.';
    case 'feature-teams':
      return 'Partition the goal into parallel end-to-end workstreams; give each pod one cohesive task.';
    case 'mesh-mob':
      return 'Assign the whole team the same first-milestone task to swarm together.';
    case 'rotating-lead':
      return 'Assign tasks and name the current rotating lead who coordinates this sprint.';
    case 'async-pull':
      return 'Produce a short backlog of independent tasks members can self-assign; push only the highest-priority one or two.';
    default:
      return 'Assign one clear starting task to each relevant specialist based on the goal.';
  }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_TIMEOUT_MS = 20_000;

function roster(project) {
  return project.agents
    .filter(a => a.enabled && a.id !== project.leadAgentId)
    .map(a => `- ${a.name} (${getRole(a.role).label})`)
    .join('\n') || '(no other agents)';
}

export function buildPlanPrompt(project) {
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  return (
    `You are ${lead?.name || 'the PM'}, the Product Manager and lead of project "${project.name}".\n` +
    `Project goal: "${project.goal}".\n` +
    `Team:\n${roster(project)}\n\n` +
    `Write a SHORT kickoff plan (2-4 sentences, first person, speakable) telling the user how you'll start: ` +
    `you'll draft a PRD plus a roadmap, team operating notes, and an open-questions doc, then assign a starting ` +
    `task to each relevant teammate. If the goal is vague, instead ask 1-2 clarifying questions. ` +
    `Plain prose only — no JSON, no markdown headings.`
  );
}

/** Markdown/text chat-completion call (no JSON response_format). Returns the
 *  assistant string, or '' on failure. Exposed via opts.callText for tests. */
export async function callOpenRouterText({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - kickoff' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) return '';
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

function planSpec(body) {
  return JSON.stringify({
    intent: 'answer', template: 'reader', context: 'Kickoff', title: 'Kickoff plan',
    body,
    actions: [
      { verb: 'Approve', glyph: 'cross',  action: { type: 'approve_kickoff' } },
      { verb: 'Revise',  glyph: 'circle', action: { type: 'cancel' } },
    ],
  });
}

export async function startKickoff(projectId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return;
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  // Only check the key when callText is NOT overridden (i.e. a real network call
  // would be made). When the caller injects callText, they own the whole call path.
  const needsKeyCheck = !opts.callText;
  if (needsKeyCheck && (!apiKey || apiKey.includes('replace-me'))) {
    appendTurn(project.leadAgentId, 'assistant',
      planSpec('Add OPENROUTER_API_KEY to enable an automatic project kickoff. I can still help if you prompt me.'));
    setKickoff(projectId, { status: 'skipped_no_key' });
    return;
  }
  // Explicit empty key always skips, even with an injected callText.
  if ('apiKey' in opts && (!apiKey || apiKey.includes('replace-me'))) {
    appendTurn(project.leadAgentId, 'assistant',
      planSpec('Add OPENROUTER_API_KEY to enable an automatic project kickoff. I can still help if you prompt me.'));
    setKickoff(projectId, { status: 'skipped_no_key' });
    return;
  }
  const callText = opts.callText || callOpenRouterText;
  const body = (await callText({ apiKey, model: getModelForRole('pm'), prompt: buildPlanPrompt(project) }))
    || 'I\'ll draft a PRD, a roadmap, team operating notes, and an open-questions doc, then assign each teammate a starting task. Approve to begin.';
  appendTurn(project.leadAgentId, 'assistant', planSpec(body));
  const planTurnIndex = getContext(project.leadAgentId).messages.length - 1;
  setKickoff(projectId, { status: 'awaiting_approval', planTurnIndex });
  emitActivity(projectId, `${project.agents.find(a => a.id === project.leadAgentId)?.name || 'PM'}: kickoff plan ready`, project.leadAgentId);
  emitNotification({ kind: 'info', projectId, title: 'Kickoff plan ready',
                     body: `Open ${project.name} → PM to approve the kickoff.` });
}

function docPrompt(kind, project) {
  const head = `Project "${project.name}". Goal: "${project.goal}". Team: ${roster(project).replace(/\n- /g, ', ').replace(/^- /, '')}.`;
  const topo = project.topology ? TOPOLOGIES[project.topology] : null;
  switch (kind) {
    case 'prd':
      return `${head}\nWrite a concise PRD in markdown with sections: Problem, Goals / Non-goals, Scope (in/out), Milestones, Success metrics. Be specific to the goal. Markdown only.`;
    case 'roadmap':
      return `${head}\nWrite a short markdown roadmap: 3-5 milestones with one-line descriptions and rough sequencing. Markdown only.`;
    case 'operating':
      return `${head}\nTeam operating model: ${topo ? topo.label + ' — ' + topo.rule : 'standard PM-led'}. Write short markdown operating notes describing how this team coordinates and who owns what. Markdown only.`;
    case 'questions':
      return `${head}\nList 4-8 open questions / decisions you need from the user before the team can go far. Markdown bullet list only.`;
  }
}

export async function generateKickoffDocs(projectId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return;
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  const callText = opts.callText || callOpenRouterText;
  const model = getModelForRole('pm');
  for (const kind of Object.keys(DOC_TITLES)) {
    if (!getProject(projectId)) return; // deleted mid-run
    const md = (await callText({ apiKey, model, prompt: docPrompt(kind, project), timeoutMs: 30_000 })) || '_not generated_';
    const title = DOC_TITLES[kind] + (kind === 'operating' && project.topology ? ` (${TOPOLOGIES[project.topology]?.label || project.topology})` : '');
    // Deterministic first line so the explorer label is always the doc title
    // (don't trust the model's own heading).
    const body = `# ${title}\n\n${md.replace(/^#+\s.*\n+/, '')}`;
    const note = appendNote(projectId, body);
    publishEvent({ type: 'note_added', projectId, noteId: note.id });
  }
}

const FANOUT_CAP = 5;

async function callOpenRouterJSON({ apiKey, model, prompt, timeoutMs = 20_000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - kickoff' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) return '{"assignments":[]}';
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '{"assignments":[]}';
  } catch { return '{"assignments":[]}'; }
  finally { clearTimeout(timer); }
}

export async function assignKickoffTasks(projectId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return [];
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  const callJSON = opts.callJSON || callOpenRouterJSON;
  const others = project.agents.filter(a => a.enabled && a.id !== project.leadAgentId);
  const rosterLines = others.map(a => `- ${a.name} (${getRole(a.role).label}) [id:${a.id}]`).join('\n') || '(none)';
  const prompt =
    `You are the PM of project "${project.name}". Goal: "${project.goal}".\n` +
    `Operating model: ${topologyGuidance(project.topology)}\n` +
    `Team:\n${rosterLines}\n\n` +
    `Return JSON {"assignments":[{"agentId":"<id from roster>","task":"<one concrete starting task>"}]}. ` +
    `Use exact agent ids. Assign only roles that apply. Max ${FANOUT_CAP} assignments.`;
  let parsed;
  try { parsed = JSON.parse(await callJSON({ apiKey, model: getRouterModel(), prompt })); }
  catch { parsed = { assignments: [] }; }
  const assignments = (parsed.assignments || []).slice(0, FANOUT_CAP);
  const out = [];
  for (const a of assignments) {
    const target = others.find(o => o.id === a.agentId);
    if (!target || !a.task) continue;
    const task = String(a.task).slice(0, 400);
    appendTurn(target.id, 'user', task);
    emitDelegate(projectId, project.leadAgentId, target.id, task);
    out.push({ agentId: target.id, name: target.name, role: getRole(target.role).label, task });
  }
  return out;
}
