/* Bridge — PM auto-kickoff. After a project is created the PM posts a
 * plan-first kickoff to the lead chat; on approval it generates a PRD +
 * supporting docs and assigns topology-shaped starting tasks to the team.
 * See docs/superpowers/specs/2026-06-03-pm-kickoff-design.md. */

import { getRole, listRoles } from './roles.js';
import { getProject, setKickoff, getKickoff, TOPOLOGIES, addAgent } from './projects.js';
import { appendTurn, getContext, setLastSpec } from './scratchpad.js';
import { getModelForRole, getRouterModel } from './models.js';
import { emitNotification, emitActivity, emitDelegate, emitStatus, publish as publishEvent } from './events.js';
import { writeNote } from './backends/notes.js';
import { RESPONSE_STYLE, interpretIntent } from './orchestrator.js';

export const DOC_TITLES = {
  prd:       'PRD',
  roadmap:   'Roadmap & Milestones',
  operating: 'Team Operating Notes',
  questions: 'Open Questions',
};

// Human-readable filenames so docs land as PRD.md, milestones.md, etc.
const DOC_FILENAMES = {
  prd:       'PRD',
  roadmap:   'milestones',
  operating: 'op-notes',
  questions: 'open-questions',
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
    `Plain prose only — no JSON, no markdown headings.` +
    RESPONSE_STYLE
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
    // Approve only. There's no "Revise" button: a Revise→cancel action just
    // exited the agent view (a dead no-op for the label). To revise, the user
    // simply types/speaks their change — the server's /interpret interception
    // already routes 'revise'/'unsure' replies while the PM keeps waiting.
    actions: [
      { verb: 'Approve', glyph: 'cross', action: { type: 'approve_kickoff' } },
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
  // PM is now actively drafting the plan — light up the L1 tile ("Drafting")
  // and the L2 thinking bubble while the model works.
  emitStatus(projectId, project.leadAgentId, 'drafting');
  const body = (await callText({ apiKey, model: getModelForRole('pm'), prompt: buildPlanPrompt(project) }))
    || 'I\'ll draft a PRD, a roadmap, team operating notes, and an open-questions doc, then assign each teammate a starting task. Approve to begin.';
  appendTurn(project.leadAgentId, 'assistant', planSpec(body));
  const planTurnIndex = getContext(project.leadAgentId).messages.length - 1;
  setKickoff(projectId, { status: 'awaiting_approval', planTurnIndex });
  emitActivity(projectId, `${project.agents.find(a => a.id === project.leadAgentId)?.name || 'PM'}: kickoff plan ready`, project.leadAgentId, { awaitKind: 'reply' });
  // Plan delivered — PM is no longer working; it's now waiting on the user.
  // (idle + the unseen activity above paints the tile "Waiting for response".)
  emitStatus(projectId, project.leadAgentId, 'idle');
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
    const note = writeNote(projectId, DOC_FILENAMES[kind], body);
    publishEvent({ type: 'note_added', projectId, noteId: note.id });
  }
}

/* As the user answers the kickoff questions, fold each Q→answer into
 * open-questions.md so the doc becomes a resolved decisions log (the PM
 * promises "I'll update them as I get more info"). Rebuilt in full from the
 * accumulated pairs on every answer, so it's deterministic and idempotent. */
function writeDecisionsDoc(projectId, qa) {
  if (!getProject(projectId) || !qa?.length) return;
  const body = `# ${DOC_TITLES.questions}\n\n` +
    `_Resolved during kickoff Q&A._\n\n` +
    qa.map((p, i) => `## ${i + 1}. ${p.q}\n\n**Answer:** ${p.a}\n`).join('\n');
  const note = writeNote(projectId, DOC_FILENAMES.questions, body);
  publishEvent({ type: 'note_added', projectId, noteId: note.id });
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

/* Decide who builds what. Returns { assignments, clarify }:
 *  - assignments: [{ role, task }] — concrete starting tasks (the PM may pick
 *    roles not yet on the team; startTeamWork adds them).
 *  - clarify: [{ role, question, options }] — on-team roles the PM couldn't
 *    confidently task; surfaced to the user as a choice question whose answer
 *    becomes that role's task.
 * Uses the capable PM model (the cheap router was returning empty assignments). */
export async function assignKickoffTasks(projectId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return { assignments: [], clarify: [] };
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  const callJSON = opts.callJSON || callOpenRouterJSON;
  const present = new Set(project.agents.filter(a => a.enabled).map(a => a.role));
  const catalog = listRoles().filter(r => r.id !== 'pm')
    .map(r => `- ${r.id}: ${r.label}${present.has(r.id) ? ' (already on team)' : ''}`).join('\n');
  const prompt =
    `You are the PM of project "${project.name}". Goal: "${project.goal}".\n` +
    `Operating model (every assignment must fit this): ${topologyGuidance(project.topology)}\n` +
    `Available roles — assign the best-fit role to each task. You MAY use roles not yet on the team; they will be added:\n${catalog}\n\n` +
    `Assign a concrete starting task to EVERY role already on the team. You may also add other roles with tasks. ` +
    `Only when you genuinely cannot determine a useful first task for an on-team role, put it in "clarify" with a short question and 2-4 short options for the user instead of guessing.\n` +
    `Return JSON {"assignments":[{"role":"<roleId>","task":"<concrete starting task that follows the operating model>"}],` +
    `"clarify":[{"role":"<roleId>","question":"<short question>","options":["<opt>","<opt>"]}]}. ` +
    `Use exact role ids, one entry per role. Max ${FANOUT_CAP} assignments.`;
  let parsed;
  try { parsed = JSON.parse(await callJSON({ apiKey, model: getModelForRole('pm'), prompt })); }
  catch { parsed = {}; }
  const seen = new Set();
  const assignments = [];
  for (const a of (parsed.assignments || []).slice(0, FANOUT_CAP)) {
    if (!a?.task || !getRole(a.role) || a.role === 'pm' || seen.has(a.role)) continue;
    seen.add(a.role);
    assignments.push({ role: a.role, task: String(a.task).slice(0, 400) });
  }
  const clarify = [];
  for (const c of (parsed.clarify || [])) {
    if (!getRole(c?.role) || c.role === 'pm' || seen.has(c.role)) continue;
    seen.add(c.role);
    clarify.push({
      role: c.role,
      question: String(c.question || `What should the ${getRole(c.role).label} focus on first?`).slice(0, 200),
      options: Array.isArray(c.options) ? c.options.map(o => String(o).trim()).filter(Boolean).slice(0, 4) : [],
    });
  }
  return { assignments, clarify };
}

/* When kickoff completes, the assigned specialists actually start building. For
 * each role-based assignment we resolve (or auto-add) the agent, announce any
 * additions, then fan out — each agent runs its task so its tile lights up and
 * it produces a first deliverable, all shaped by the project topology. */
async function startTeamWork(projectId, opts = {}) {
  if (opts.callText) return;   // injected/unit-test mode — don't hit the network
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) return;
  let project = getProject(projectId);
  if (!project) return;
  const assignments = getKickoff(projectId).assignments || [];
  if (!assignments.length) return;

  const resolved = [];
  const added = [];
  for (const a of assignments) {
    let agent = project.agents.find(o => o.enabled && o.role === a.role);
    if (!agent) {
      // Needed specialist isn't on the team — add it automatically.
      try {
        project = await addAgent(projectId, a.role);
        agent = project.agents.find(o => o.role === a.role);
        if (agent) added.push({ agent, task: a.task });
      } catch (err) { console.warn(`[kickoff] could not add ${a.role}:`, err?.message); continue; }
    }
    if (agent) resolved.push({ agentId: agent.id, name: agent.name, roleLabel: getRole(a.role).label, task: a.task });
  }

  // Announce auto-added teammates so the user knows who joined and why.
  if (added.length) {
    publishEvent({ type: 'team_changed', projectId });
    const lines = added.map(x => `- **${x.agent.name}** (${getRole(x.agent.role).label}) — ${x.task}`).join('\n');
    appendTurn(project.leadAgentId, 'assistant', JSON.stringify({
      intent: 'answer', template: 'reader', context: 'Team', title: 'Added teammates',
      body: `I didn't have the right specialist for ${added.length === 1 ? 'one task' : 'some tasks'}, so I added ${added.length === 1 ? 'a teammate' : 'teammates'} to the team:\n\n${lines}`,
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    }));
    emitActivity(projectId, `PM: added ${added.length} teammate${added.length === 1 ? '' : 's'}`, project.leadAgentId);
  }

  // Fan out: each agent starts on its task. Fire-and-forget so completion isn't
  // blocked; interpretIntent emits status (analyzing/drafting) on its own.
  const pmName = project.agents.find(a => a.id === project.leadAgentId)?.name || 'PM';
  const pmRole = getRole('pm').label;
  for (const r of resolved) {
    // The assignment itself sets no pending state; the agent's reply decides it
    // ("Task complete" for a deliverable, "Waiting for response" for a question).
    // The task records as a PM→agent handoff bubble, not a "you" bubble.
    emitDelegate(projectId, project.leadAgentId, r.agentId, r.task);
    interpretIntent({
      projectId, agentId: r.agentId, text: r.task, effort: 'high',
      handoff: { from: pmName, fromRole: pmRole, to: r.name, toRole: r.roleLabel },
    })
      .then(spec => setLastSpec(r.agentId, spec))
      .catch(err => console.warn(`[kickoff] ${r.name} failed to start:`, err?.message));
  }
}

function reportSpec(docCount, assigned, project) {
  const taskLine = assigned.length ? ` I've also seeded each teammate a starting task.` : '';
  const body =
    `Kickoff has started. I created ${docCount} starter project docs in the explorer: PRD, roadmap, operating notes, and open questions. I'll update them as I get more info.${taskLine}\n\n` +
    `Let's start with a series of questions so I can capture more details.`;
  return JSON.stringify({
    intent: 'answer', template: 'reader', context: 'Kickoff', title: 'Kickoff started', body,
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
  });
}

/* A single kickoff question, asked one at a time. Accepts either a plain string
 * or a { q, options } object; options render as a selectable choice list (the
 * user picks one or more, or uses Other to free-form). `lead` is an optional
 * The body is numbered "Q1: …", "Q2: …". */
function questionSpec(question, n, total) {
  const counter = total > 1 ? `Question ${n} of ${total}` : 'A question';
  const q = typeof question === 'string' ? question : (question?.q || '');
  const options = (question && Array.isArray(question.options)) ? question.options.filter(Boolean) : [];
  const body = `Q${n}: ${String(q).trim()}`;
  const spec = {
    intent: 'answer', template: 'reader', context: counter, title: 'Kickoff',
    body,
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
  };
  if (options.length) spec.choices = options.slice(0, 4);
  return JSON.stringify(spec);
}

function closingSpec(body) {
  return JSON.stringify({
    intent: 'answer', template: 'reader', context: 'Kickoff', title: 'All set',
    body,
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
  });
}

/* Generate the kickoff follow-up questions, each with 2-4 short answer options
 * the user can pick from (Other lets them free-form). Returns an array of
 * { q, options }. Empty on no key / failure so the caller degrades gracefully.
 *
 * Wire format: one question per line, fields separated by " | ":
 *   Who is the target user? | Solo travelers | Families | Business
 * The first field is the question; the rest are options (may be absent). */
async function generateQuestions(project, opts = {}) {
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) return [];
  const callText = opts.callText || callOpenRouterText;
  const who = project.agents.find(a => a.id === project.leadAgentId)?.name || 'the PM';
  const raw = await callText({
    apiKey, model: getModelForRole('pm'), timeoutMs: 30_000,
    prompt: `You are ${who}, PM of project "${project.name}". Goal: "${project.goal}". ` +
      `The kickoff is approved. List the 3-5 most important questions you genuinely need answered ` +
      `to move forward (scope, priorities, constraints, unknowns), ordered most-important first. ` +
      `For each question, give 2-4 short, distinct answer options the user can choose from. ` +
      `Output ONLY one question per line as "Question? | option one | option two | option three" ` +
      `— pipe-separated, the question first then its options, no numbering, no bullets, no preamble.` + RESPONSE_STYLE,
  });
  return String(raw || '')
    .split('\n')
    .map(line => {
      const parts = line.split('|')
        .map(s => s.replace(/^\s*(?:[-*\d.)]+\s*)/, '').trim())
        .filter(Boolean);
      if (!parts.length) return null;
      const [q, ...options] = parts;
      return { q, options: options.slice(0, 4) };
    })
    .filter(Boolean)
    .slice(0, 5);
}

export async function executeKickoff(projectId, opts = {}) {
  const k = getKickoff(projectId);
  if (['running', 'done', 'asking'].includes(k.status)) return { ran: false };
  const project = getProject(projectId);
  if (!project) return { ran: false };
  setKickoff(projectId, { status: 'running', startedAt: Date.now() });
  // PM is working — docs, task assignment, drafting questions. Light up
  // "Drafting" on L1 + the L2 thinking bubble for the whole stretch.
  emitStatus(projectId, project.leadAgentId, 'drafting');
  emitActivity(projectId, 'PM: kickoff in progress…', project.leadAgentId);
  await generateKickoffDocs(projectId, opts);
  const { assignments, clarify } = await assignKickoffTasks(projectId, opts);

  // Coverage guarantee: every on-team specialist must end up with a task. Any
  // the PM left out of both assignments and clarify gets a role-based starter.
  const onTeam = project.agents.filter(a => a.enabled && a.id !== project.leadAgentId);
  const covered = new Set([...assignments.map(a => a.role), ...clarify.map(c => c.role)]);
  for (const a of onTeam) {
    if (covered.has(a.role)) continue;
    assignments.push({ role: a.role, task: `Begin the core ${getRole(a.role).label.toLowerCase()} work toward the goal: "${project.goal}". Propose your first concrete deliverable.` });
    covered.add(a.role);
  }
  const assigned = assignments;

  if (getProject(projectId)) {
    appendTurn(project.leadAgentId, 'assistant', reportSpec(Object.keys(DOC_TITLES).length, assigned, project));
    // Follow-up questions, asked ONE AT A TIME. Clarify questions (whose answers
    // become that role's task) come first, then the PM's general questions.
    const clarifyQuestions = clarify.map(c => ({ q: c.question, options: c.options, role: c.role }));
    const questions = [...clarifyQuestions, ...(await generateQuestions(project, opts))];
    if (questions.length && getProject(projectId)) {
      appendTurn(project.leadAgentId, 'assistant', questionSpec(questions[0], 1, questions.length));
      // Stash the assignments so the team starts building once Q&A wraps up.
      setKickoff(projectId, { status: 'asking', questions, qIdx: 0, assignments: assigned, finishedAt: Date.now() });
      // A question is pending → the PM is waiting on the user. Kickoff is NOT
      // complete yet — it's complete only once the questions are answered.
      emitStatus(projectId, project.leadAgentId, 'idle');
      emitNotification({ kind: 'info', projectId, title: 'Kickoff started',
                         body: `${project.name}: starter docs created. The PM has a few questions for you.` });
      emitActivity(projectId, 'PM: first question ready', project.leadAgentId, { awaitKind: 'reply' });
    } else {
      // No questions — kickoff is done now, so the team starts building.
      setKickoff(projectId, { status: 'done', assignments: assigned, finishedAt: Date.now() });
      emitStatus(projectId, project.leadAgentId, 'idle');
      emitNotification({ kind: 'info', projectId, title: 'Kickoff complete',
                         body: `${project.name}: starter docs created; the team is starting on its tasks.` });
      emitActivity(projectId, 'PM: kickoff complete', project.leadAgentId);
      startTeamWork(projectId, opts);   // fire-and-forget
    }
  }
  return { ran: true, assigned };
}

export async function handleLeadMessageDuringKickoff(projectId, text, opts = {}) {
  const k = getKickoff(projectId);

  // Post-approval Q&A: serve the kickoff questions one at a time. Each user
  // reply is recorded as their answer and advances to the next question.
  if (k.status === 'asking') {
    const project = getProject(projectId);
    if (!project) return { handled: false };
    appendTurn(project.leadAgentId, 'user', text);
    const questions = k.questions || [];
    const answered = questions[k.qIdx ?? 0];
    // Fold this Q→answer into open-questions.md as a resolved decisions log.
    if (answered && text.trim()) {
      const qDir = (typeof answered === 'string') ? answered : (answered.q || '');
      const qa = [...(getKickoff(projectId).qa || []), { q: qDir, a: text.trim() }];
      setKickoff(projectId, { qa });
      writeDecisionsDoc(projectId, qa);
    }
    // If the question being answered was a "clarify" for a specific role, the
    // user's answer becomes that role's starting task.
    if (answered?.role && text.trim()) {
      const next = (getKickoff(projectId).assignments || []).filter(x => x.role !== answered.role);
      next.push({ role: answered.role, task: text.trim().slice(0, 400) });
      setKickoff(projectId, { assignments: next });
    }
    const nextIdx = (k.qIdx ?? 0) + 1;
    if (nextIdx < questions.length) {
      const spec = questionSpec(questions[nextIdx], nextIdx + 1, questions.length);
      appendTurn(project.leadAgentId, 'assistant', spec);
      setKickoff(projectId, { qIdx: nextIdx });
      emitActivity(projectId, `PM: question ${nextIdx + 1} ready`, project.leadAgentId, { awaitKind: 'reply' });
      return { handled: true, intent: 'next_question', spec };
    }
    // Out of questions — kickoff is now genuinely complete.
    const spec = closingSpec("Thanks — that's everything I needed. Kickoff is complete: docs are up to date and the team has its starting tasks. Ask me anything from here.");
    appendTurn(project.leadAgentId, 'assistant', spec);
    setKickoff(projectId, { status: 'done', qIdx: nextIdx });
    emitNotification({ kind: 'info', projectId, title: 'Kickoff complete',
                       body: `${project.name}: questions answered and the team is moving.` });
    // Terminal message — the PM isn't awaiting a reply, so don't glow "Waiting".
    emitActivity(projectId, 'PM: kickoff complete', project.leadAgentId);
    // Kickoff is complete → the specialists start building (auto-adding any
    // missing roles). Fire-and-forget so the closing returns promptly.
    startTeamWork(projectId, opts);
    return { handled: true, intent: 'questions_done', spec };
  }

  if (k.status !== 'awaiting_approval') return { handled: false };
  const intent = classifyApproval(text);
  const project = getProject(projectId);
  if (intent === 'approve') {
    appendTurn(project.leadAgentId, 'user', text);
    await executeKickoff(projectId, opts);
    return { handled: true, intent };
  }
  // revise / unsure: record the message and let the PM keep waiting. The
  // normal /interpret path will produce the PM's conversational reply.
  return { handled: true, intent, awaiting: true };
}

/* Disapprove: dismiss a pending kickoff so the PM won't auto-run it. The user
 * can still drive the team conversationally afterward. */
export function declineKickoff(projectId) {
  if (getKickoff(projectId).status !== 'awaiting_approval') return { ok: false };
  const project = getProject(projectId);
  if (project) {
    appendTurn(project.leadAgentId, 'user', 'Reject');
    appendTurn(project.leadAgentId, 'assistant', JSON.stringify({
      intent: 'answer', template: 'reader', context: 'Kickoff', title: 'Kickoff held',
      body: "Okay — I'll hold off on the kickoff. Tell me what to change and I'll re-plan.",
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    }));
  }
  setKickoff(projectId, { status: 'declined' });
  return { ok: true };
}
