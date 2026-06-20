/* Bridge — PM auto-kickoff. After a project is created the PM posts a
 * plan-first kickoff to the lead chat; on approval it generates a PRD +
 * supporting docs and assigns topology-shaped starting tasks to the team.
 * See docs/superpowers/specs/2026-06-03-pm-kickoff-design.md. */

import { getRole, listRoles, kickoffPriority } from './roles.js';
import { getProject, setKickoff, getKickoff, TOPOLOGIES, addAgent } from './projects.js';
import { appendTurn, getContext, setLastSpec } from './scratchpad.js';
import { getModelForRole, getRouterModel } from './models.js';
import { emitNotification, emitActivity, emitDelegate, emitStatus, publish as publishEvent } from './events.js';
import { writeNote, readNote } from './backends/notes.js';
import { commitIfChanged } from './workspace.js';
import { generateBuildPlan, runScaffold } from './scaffold.js';
import { deepenCharters } from './charters.js';
import { startTeamReview, currentReviewAgent, recordPlan, teamReviewQuestion } from './team-review.js';
import { enqueueTask } from './executor.js';
import { runAndFix, classifyFailure } from './run-fix.js';
import { startPreview } from './preview.js';

// After kickoff Q&A, the PM proposes a build plan as a selectable question.
const BUILD_CHOICES = ['Build it', 'Hold off — let me adjust'];
// Accept the exact choice OR a natural affirmative ("yes", "go", "do it", …) so
// a typed/spoken "Yes" actually scaffolds instead of falling through to a prose
// reply. AFFIRM/NEGATE are defined below (resolved at call time, not load time).
function isBuildApproval(text) {
  const t = String(text || '').trim();
  return t === BUILD_CHOICES[0] || (AFFIRM.test(t) && !NEGATE.test(t));
}

const RUN_CHOICES = ['Run it', 'Not now'];
function isRunApproval(text) {
  const t = String(text || '').trim();
  return t === RUN_CHOICES[0] || (AFFIRM.test(t) && !NEGATE.test(t));
}

// "Skip for now" on a question bubble: advance past the question without
// recording an answer. The client sends this exact literal; question specs flag
// themselves `skippable` so the renderer shows the Skip button.
export const SKIP_TOKEN = 'Skip for now';
export function isSkip(text) { return String(text || '').trim() === SKIP_TOKEN; }

/** A build-plan turn: the proposed stack + file tree, as a choice bubble. */
function buildPlanSpec(plan) {
  const tree = plan.files.map(f => `- \`${f.path}\` — ${f.purpose}`).join('\n');
  const body = `Here's the build plan (${plan.stack || 'app'}): ${plan.summary || ''}\n\n` +
    `**Files I'll scaffold:**\n${tree}\n\nReady to scaffold these into the project repo?`;
  return JSON.stringify({
    intent: 'answer', template: 'reader', context: 'Build plan', title: 'Build plan',
    body, choices: BUILD_CHOICES,
  });
}

/** A team-planning turn: one specialist's question relayed to the user, as a
 * choice bubble (n of total for the round). */
/** Annotate any teammate's bare name in `text` with their role, so a mention
 * reads "Hollis (Legal)" not just "Hollis". Skips the asker (already labeled in
 * the prefix) and names already followed by "(". */
export function annotateAgentMentions(text, agents = [], askerId = null) {
  let out = String(text || '');
  for (const a of agents) {
    if (a.id === askerId) continue;
    const label = getRole(a.role)?.label;
    if (!label || !a.name) continue;
    const name = a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'), `${a.name} (${label})`);
  }
  return out;
}

function teamReviewQuestionSpec(agent, tq, n, total, agents = []) {
  // Another agent is asking — name them by role ("Iris (Designer) asks: …") so
  // the user knows which specialist needs input. Teammates mentioned INSIDE the
  // question are likewise role-tagged ("…honest with Hollis (Legal)?").
  const roleLabel = getRole(agent.role)?.label;
  const who = `**${agent.name}**${roleLabel ? ` (${roleLabel})` : ''}`;
  const q = annotateAgentMentions(tq?.q || 'Anything I should know for my part?', agents, agent.id);
  const spec = {
    intent: 'answer', template: 'reader',
    context: total > 1 ? `Team planning · ${n} of ${total}` : 'Team planning',
    title: 'Team planning',
    body: `${who} asks: ${q}`,
    skippable: true,
  };
  // Only real, model-produced options become buttons — no hollow placeholders.
  // With none, the bubble is a plain question answered by typing / "Other".
  if (tq?.options?.length) spec.choices = tq.options.map(o => annotateAgentMentions(o, agents, agent.id)).slice(0, 4);
  return JSON.stringify(spec);
}

/** Advance the team-planning queue to the next specialist that has a genuine
 * question, SKIPPING any whose model call yields nothing usable (their turn is
 * captured so the round still completes). Returns {agent, spec} or null when the
 * queue is exhausted. */
async function nextTeamReviewQuestion(projectId, ct, apiKey) {
  let agent = currentReviewAgent(projectId);
  while (agent) {
    const tq = await teamReviewQuestion(projectId, agent.id, { callText: ct, apiKey });
    if (tq) {
      const proj = getProject(projectId);
      return { agent, spec: teamReviewQuestionSpec(agent, tq, proj.teamReview.idx + 1, proj.teamReview.order.length, proj.agents) };
    }
    // No usable question → skip this specialist (capture their turn, advance).
    recordPlan(projectId, agent.id, '', { answered: true });
    emitActivity(projectId, `${agent.name}: no question — skipped`, getProject(projectId)?.leadAgentId);
    agent = currentReviewAgent(projectId);
  }
  return null;
}

/** Round complete (or skipped) → propose a build plan to approve, or, with no
 * plan (e.g. no API key), close the kickoff and let the team work. */
/** The software engineer who owns build / scaffold / run. Returns an existing
 * sw_engineer agent, or adds one so the build always has an owner. null only if
 * adding fails (caller then keeps the build in the lead chat as a fallback). */
async function ensureBuildAgent(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  const existing = p.agents.find(a => a.role === 'sw_engineer');
  if (existing) return existing;
  try { await addAgent(projectId, 'sw_engineer'); }
  catch (err) { console.warn(`[kickoff] could not add a software engineer: ${err?.message || err}`); return null; }
  publishEvent({ type: 'team_changed', projectId });
  return getProject(projectId)?.agents.find(a => a.role === 'sw_engineer') || null;
}

async function proposeBuildOrClose(projectId, ct, apiKey, project, opts) {
  let plan = null;
  try { plan = await generateBuildPlan(projectId, { callText: ct, apiKey }); } catch { /* no plan */ }
  if (plan && plan.files?.length) {
    const spec = buildPlanSpec(plan);
    // Build + scaffolding is engineering work: hand it off to the software
    // engineer. The PM announces the handoff in the lead chat; the build plan
    // and its "Build it" approval live in the engineer's chat.
    const swe = await ensureBuildAgent(projectId);
    if (swe && swe.id !== project.leadAgentId) {
      appendTurn(swe.id, 'assistant', spec);
      setLastSpec(swe.id, JSON.parse(spec));
      setKickoff(projectId, { status: 'build_pending', buildAgentId: swe.id });
      emitDelegate(projectId, project.leadAgentId, swe.id, 'Build plan & scaffolding');
      emitStatus(projectId, swe.id, 'idle');
      emitActivity(projectId, `${swe.name}: build plan ready`, swe.id, { awaitKind: 'reply' });
      const roleLabel = getRole('sw_engineer')?.label || 'Software Engineer';
      // `handoffTo` makes the renderer add a "Talk to <name> (<role>)" button on
      // the bubble (bottom-right) that jumps straight to the engineer's chat.
      const handoff = JSON.stringify({
        intent: 'answer', template: 'reader', context: 'Kickoff', title: 'Handoff',
        body: `The build plan and scaffolding are engineering work, so I've handed this off to ` +
              `**${swe.name}** (${roleLabel}). Open ${swe.name}'s screen to review the build plan and start the build.`,
        handoffTo: { agentId: swe.id, label: `${swe.name} (${roleLabel})` },
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      });
      appendTurn(project.leadAgentId, 'assistant', handoff);
      emitNotification({ kind: 'info', projectId, title: 'Build handed to engineering',
                         body: `${swe.name} has the build plan for ${project.name}.` });
      // The build is the engineer's (it still awaits the user's "Build it"). The
      // REST of the team starts their tasks now, in parallel — they don't wait
      // for the build. Exclude the engineer (already has the build handoff).
      startTeamWork(projectId, opts, { excludeAgentId: swe.id });
      return { handled: true, intent: 'build_handoff', spec: handoff };
    }
    // No separate engineer available — keep the plan in the lead chat (fallback).
    appendTurn(project.leadAgentId, 'assistant', spec);
    setKickoff(projectId, { status: 'build_pending', buildAgentId: project.leadAgentId });
    emitActivity(projectId, 'PM: build plan ready', project.leadAgentId, { awaitKind: 'reply' });
    // Still delegate the rest of the team in parallel (lead owns the build here).
    startTeamWork(projectId, opts, { excludeAgentId: project.leadAgentId });
    return { handled: true, intent: 'build_plan', spec };
  }
  const spec = closingSpec("Thanks — that's everything I needed. Kickoff is complete: the docs are up to date and the team has its starting tasks. Ask me anything from here.");
  appendTurn(project.leadAgentId, 'assistant', spec);
  setKickoff(projectId, { status: 'done' });
  emitNotification({ kind: 'info', projectId, title: 'Kickoff complete',
                     body: `${project.name}: questions answered and the team is moving.` });
  emitActivity(projectId, 'PM: kickoff complete', project.leadAgentId);
  startTeamWork(projectId, opts);
  return { handled: true, intent: 'questions_done', spec };
}
import { RESPONSE_STYLE } from './orchestrator.js';

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

/** The user-stated top features as a prompt line, or '' if none were given. */
function featuresLine(project) {
  return project.features ? `Top features the user asked for: "${project.features}".\n` : '';
}

export function buildPlanPrompt(project) {
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  return (
    `You are ${lead?.name || 'the PM'}, the Product Manager and lead of project "${project.name}".\n` +
    `Project goal: "${project.goal}".\n` +
    featuresLine(project) +
    `Team:\n${roster(project)}\n\n` +
    `Write a SHORT kickoff plan (first person, speakable). Format it as:\n` +
    `1) One or two sentences: you'll draft a PRD, a roadmap, team operating notes, and an open-questions doc.\n` +
    `2) A lead-in line like "Then I'll set a starting task for each teammate:" followed by a MARKDOWN BULLET LIST — ` +
    `one "- " bullet per teammate, each formatted "<Name>: <one short task clause>". Do NOT pack the per-teammate ` +
    `tasks into a run-on sentence.\n` +
    `3) Optionally one closing sentence flagging the single biggest risk or gating concern.\n` +
    `Do NOT ask the user any question in this message and do NOT end with a question — this bubble is the plan only. ` +
    `The user will pick from the approval buttons below; any clarifying questions you have get asked AFTERWARD, ` +
    `one at a time. No lettered options, no JSON, no markdown headings. Use the bullet list ONLY for the ` +
    `per-teammate tasks; everything else is plain prose.` +
    RESPONSE_STYLE
  );
}

/** Markdown/text chat-completion call (no JSON response_format). Returns the
 *  assistant string, or '' on failure. Exposed via opts.callText for tests. */
export { callOpenRouterText } from './llm.js';
import { callOpenRouterText } from './llm.js';

// The kickoff plan is presented as a selectable question (the question-bubble
// module) rather than an Approve/Reject gate. The first two options proceed;
// the last lets the user hold the plan to adjust it. Submitting a choice routes
// through handleLeadMessageDuringKickoff (awaiting_approval) like any reply.
const PLAN_CHOICES = [
  'Go ahead with this plan',
  'Go ahead, but ask me clarifying questions first',
  'Let me adjust the plan first',
];
/** True when a submitted plan choice means "proceed" (vs. hold to adjust). */
function isApprovingChoice(text) {
  const t = String(text || '').trim();
  return t === PLAN_CHOICES[0] || t === PLAN_CHOICES[1];
}

function planSpec(body, choices = PLAN_CHOICES) {
  return JSON.stringify({
    intent: 'answer', template: 'reader', context: 'Kickoff', title: 'Kickoff plan',
    body,
    // Selectable choices — no Approve/Reject buttons. The renderer's choice
    // module shows them with a Submit; the chosen option drives the kickoff.
    ...(choices && choices.length ? { choices } : {}),
  });
}

export async function startKickoff(projectId, opts = {}) {
  const project = getProject(projectId);
  if (!project) return;
  // Idempotency: kickoff posts exactly one plan, ever. A double create-POST (or
  // any re-trigger) must not post a second plan. Claim the slot SYNCHRONOUSLY
  // (before the first await) so concurrent calls can't both pass the check.
  if (getKickoff(projectId).status !== 'idle') return;
  setKickoff(projectId, { status: 'drafting' });
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
  const rawBody = (await callText({ apiKey, model: getModelForRole('pm'), prompt: buildPlanPrompt(project) }))
    || 'I\'ll draft a PRD, a roadmap, team operating notes, and an open-questions doc, then assign each teammate a starting task.';
  // Always pair a teammate's name with their role ("Kade (Software Engineer)").
  // Deterministic + idempotent — won't double-tag a name the model already labeled.
  const body = annotateAgentMentions(rawBody, project.agents);
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
  const head = `Project "${project.name}". Goal: "${project.goal}". ${project.features ? `Top features: "${project.features}". ` : ''}Team: ${roster(project).replace(/\n- /g, ', ').replace(/^- /, '')}.`;
  const topo = project.topology ? TOPOLOGIES[project.topology] : null;
  switch (kind) {
    case 'prd': {
      const seed = readNote(project.id, 'PRD') || '';
      return `${head}\n` +
        (seed ? `Here is the current PRD seed — KEEP its Goal, Top features, and Team sections, then expand:\n\n${seed}\n\n` : '') +
        `Write the complete PRD in markdown: keep Goal / Top features / Team, and add Problem, Goals / Non-goals, Scope (in/out), Milestones, Success metrics. Be specific to the goal. Markdown only.`;
    }
    case 'roadmap':
      return `${head}\nWrite a short markdown roadmap: 3-5 milestones with one-line descriptions, ordered by sequence only. Do NOT assign week numbers, dates, or durations — assume the whole project fits in roughly 1-2 weeks. Markdown only.`;
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
    const raw = String(await callText({ apiKey, model, prompt: docPrompt(kind, project), timeoutMs: 30_000 }) || '').trim();
    const title = DOC_TITLES[kind] + (kind === 'operating' && project.topology ? ` (${TOPOLOGIES[project.topology]?.label || project.topology})` : '');
    if (!raw) {
      // The model returned nothing for this doc. NEVER clobber a doc that already
      // has real content — especially the PRD, seeded at creation with the
      // goal / top features / team. Keep what's on disk; only write a placeholder
      // when the doc doesn't exist yet.
      const existing = readNote(projectId, DOC_FILENAMES[kind]);
      if (existing && existing.trim() && !/_not generated_/i.test(existing)) continue;
      const note = writeNote(projectId, DOC_FILENAMES[kind], `# ${title}\n\n_not generated_`);
      publishEvent({ type: 'note_added', projectId, noteId: note.id });
      continue;
    }
    // Deterministic first line so the explorer label is always the doc title
    // (don't trust the model's own heading).
    const body = `# ${title}\n\n${raw.replace(/^#+\s.*\n+/, '')}`;
    const note = writeNote(projectId, DOC_FILENAMES[kind], body);
    publishEvent({ type: 'note_added', projectId, noteId: note.id });
  }
  // Deepen each role's charter now that the PRD exists — the richest context
  // we'll have. Per-role failures keep the baseline; an empty PRD is a no-op.
  const fresh = getProject(projectId);
  if (fresh) {
    try {
      const prd = readNote(projectId, DOC_FILENAMES.prd);   // DOC_FILENAMES.prd === 'PRD'
      await deepenCharters(fresh, { prd, callText, apiKey });
    } catch (err) { console.warn(`[kickoff] deepenCharters failed: ${err.message}`); }
  }
  // Commit the planning docs so the repo keeps clean history.
  try { const repo = getProject(projectId)?.repoPath; if (repo) commitIfChanged(repo, 'Add kickoff planning docs'); } catch {}
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
export async function startTeamWork(projectId, opts = {}, { excludeAgentId = null } = {}) {
  if (opts.callText && !opts.interpret) return;   // injected/unit-test mode — don't hit the network
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
  if (!opts.interpret && (!apiKey || apiKey.includes('replace-me'))) return;
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

  // Fan out through the executor: each assignment becomes a persisted task the
  // drain loop runs (handoff bubble + delegate event happen inside runTask, and
  // the agent's reply settles the task — done / blocked_on_user / delegated).
  for (const r of resolved) {
    if (r.agentId === excludeAgentId) continue;   // e.g. the engineer already has the build handoff
    enqueueTask({ projectId, agentId: r.agentId, description: r.task }, opts);
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
    skippable: true,
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
      `For each question give 2-4 short, distinct answer options the user can pick from — even for ` +
      `either/or or open-ended questions, offer concrete options they can choose or refine (e.g. for a ` +
      `name/goal conflict: "Hiking trail routing" | "Tide-pool creature ID" | "Both"). ` +
      `EVERY line MUST contain the question AND at least two pipe-separated options. ` +
      `Never output a note, preamble, or a question with no options. ` +
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
    // Drop malformed lines with no real options — they would render as a bare
    // "Other" bubble with nothing to pick. A kickoff question must offer choices.
    .filter(item => item && item.q && item.options.length >= 2)
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
    // Ask in order of importance (high → low): a role-clarify is ranked by its
    // role (foundational/regulatory first, QA/marketing last); the PM's general
    // questions are broadly important, so they rank high too. Stable sort keeps
    // same-priority questions in their generated order.
    const importance = (q) => (q.role ? kickoffPriority(q.role) : 85);
    const questions = [...clarifyQuestions, ...(await generateQuestions(project, opts))]
      .sort((a, b) => importance(b) - importance(a));
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
    // "Skip for now" advances without recording an answer.
    if (answered && text.trim() && !isSkip(text)) {
      const qDir = (typeof answered === 'string') ? answered : (answered.q || '');
      const qa = [...(getKickoff(projectId).qa || []), { q: qDir, a: text.trim() }];
      setKickoff(projectId, { qa });
      writeDecisionsDoc(projectId, qa);
    }
    // If the question being answered was a "clarify" for a specific role, the
    // user's answer becomes that role's starting task (skip leaves it gap-filled).
    if (answered?.role && text.trim() && !isSkip(text)) {
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
    // Out of PM questions — start the team planning round: each specialist asks
    // the user ONE question, one at a time. Send the first now.
    setKickoff(projectId, { qIdx: nextIdx });
    const ct = opts.callText || callOpenRouterText;
    const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
    startTeamReview(projectId);
    const first = await nextTeamReviewQuestion(projectId, ct, apiKey);
    if (first) {
      appendTurn(project.leadAgentId, 'assistant', first.spec);
      setKickoff(projectId, { status: 'team_review' });
      emitActivity(projectId, `${first.agent.name}: has a question`, project.leadAgentId, { awaitKind: 'reply' });
      return { handled: true, intent: 'team_review_question', spec: first.spec };
    }
    // No specialists with a usable question → straight to the build plan.
    return await proposeBuildOrClose(projectId, ct, apiKey, project, opts);
  }

  // Team planning round: record the current specialist's answer, then ask the
  // next one — or, when everyone has weighed in, propose the build plan.
  if (k.status === 'team_review') {
    const project = getProject(projectId);
    if (!project) return { handled: false };
    appendTurn(project.leadAgentId, 'user', text);
    const ct = opts.callText || callOpenRouterText;
    const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
    const agent = currentReviewAgent(projectId);
    if (agent && isSkip(text)) {
      // Skip: advance the review queue (mark captured) without writing a plan doc.
      recordPlan(projectId, agent.id, '', { answered: true });
    } else if (agent && text.trim()) {
      recordPlan(projectId, agent.id, `# ${agent.name} — planning input\n\n${text.trim()}\n`, { answered: true });
    }
    const next = await nextTeamReviewQuestion(projectId, ct, apiKey);
    if (next) {
      appendTurn(project.leadAgentId, 'assistant', next.spec);
      emitActivity(projectId, `${next.agent.name}: has a question`, project.leadAgentId, { awaitKind: 'reply' });
      return { handled: true, intent: 'team_review_question', spec: next.spec };
    }
    // Everyone has weighed in → commit the planning notes, then propose the build.
    const repo = getProject(projectId)?.repoPath;
    if (repo) { try { commitIfChanged(repo, 'Add team planning notes'); } catch {} }
    return await proposeBuildOrClose(projectId, ct, apiKey, project, opts);
  }

  // Build-plan approval: "Build it" → scaffold the repo; the result is posted
  // back in the build owner's (software engineer's) chat.
  if (k.status === 'build_pending') {
    const project = getProject(projectId);
    if (!project) return { handled: false };
    const buildAgentId = k.buildAgentId || project.leadAgentId;
    // Only the build owner drives this phase; a message from anyone else (e.g.
    // the PM) falls through to a normal reply.
    if ((opts.agentId || buildAgentId) !== buildAgentId) return { handled: false };
    const sweName = project.agents.find(a => a.id === buildAgentId)?.name || 'Engineer';
    if (!isBuildApproval(text)) {
      // "Hold off / adjust" → let the normal /interpret reply handle it (it
      // appends the user turn and generates the engineer's conversational reply).
      return { handled: true, intent: 'build_hold', awaiting: true };
    }
    appendTurn(buildAgentId, 'user', text);
    emitStatus(projectId, buildAgentId, 'scaffolding');
    emitActivity(projectId, `${sweName}: scaffolding…`, buildAgentId);
    const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
    let r;
    try { r = await runScaffold(projectId, { callText: opts.callText || callOpenRouterText, apiKey }); }
    catch (e) { r = { ok: false, reason: String(e?.message || e) }; }
    const issueNote = r.ok && r.issues?.length
      ? ` ⚠️ ${r.issues.length} file${r.issues.length === 1 ? '' : 's'} have syntax issues I'd fix in a follow-up pass: ${r.issues.map(i => '`' + i.path + '`').join(', ')}.`
      : '';
    if (r.ok) {
      const body = `Done — scaffolded ${r.fileCount} file${r.fileCount === 1 ? '' : 's'} and committed them (${r.commitSha}).${issueNote} Want me to install, build, and test it in a sandbox to make sure it runs?`;
      const spec = JSON.stringify({ intent: 'answer', template: 'reader', context: 'Scaffold', title: 'Scaffolded', body, choices: RUN_CHOICES });
      appendTurn(buildAgentId, 'assistant', spec);
      setKickoff(projectId, { status: 'run_pending' });
      emitStatus(projectId, buildAgentId, 'idle');
      emitActivity(projectId, `${sweName}: scaffold complete — offered to run`, buildAgentId, { awaitKind: 'reply' });
      return { handled: true, intent: 'scaffolded', spec };
    }
    // failure case (closingSpec, status build_pending, intent 'scaffold_failed')
    const spec = closingSpec(`Scaffold didn't complete: ${r.reason || 'unknown error'}. The plan is still ready — say "Build it" to retry.`);
    appendTurn(buildAgentId, 'assistant', spec);
    setKickoff(projectId, { status: 'build_pending' });
    emitStatus(projectId, buildAgentId, 'idle');
    emitActivity(projectId, `${sweName}: scaffold failed`, buildAgentId);
    return { handled: true, intent: 'scaffold_failed', spec };
  }

  // Run the project in a sandbox: install/build/test, fix failures, report —
  // driven from the build owner's (software engineer's) chat.
  if (k.status === 'run_pending') {
    const project = getProject(projectId);
    if (!project) return { handled: false };
    const buildAgentId = k.buildAgentId || project.leadAgentId;
    if ((opts.agentId || buildAgentId) !== buildAgentId) return { handled: false };
    const sweName = project.agents.find(a => a.id === buildAgentId)?.name || 'Engineer';
    appendTurn(buildAgentId, 'user', text);
    if (!isRunApproval(text)) {
      const spec = closingSpec("No problem — the code's committed in the project repo. Ask me anything from here.");
      appendTurn(buildAgentId, 'assistant', spec);
      setKickoff(projectId, { status: 'done' });
      return { handled: true, intent: 'run_declined', spec };
    }
    emitStatus(projectId, buildAgentId, 'testing');
    emitActivity(projectId, `${sweName}: running install / build / test…`, buildAgentId);
    const apiKey = 'apiKey' in opts ? opts.apiKey : process.env.OPENROUTER_API_KEY;
    const r = await runAndFix(projectId, { callText: opts.callText || callOpenRouterText, runner: opts.runner, apiKey });
    let body;
    if (r.daemonDown) body = "I couldn't reach the Docker engine — start it (e.g. `colima start`) and say \"Run it\" again.";
    else if (r.ok) {
      body = `✅ It runs — install, build, and tests all pass${r.rounds ? ` (after ${r.rounds} fix round${r.rounds === 1 ? '' : 's'})` : ''}. Everything's committed in the project repo.`;
      // Keep the app running in a preview container and hand the user a link to
      // verify it themselves. Best-effort: a preview failure never spoils the
      // green report. Skipped in unit-test mode (injected runner, no previewer).
      const previewer = opts.startPreview || (opts.runner ? null : startPreview);
      if (previewer) {
        try {
          const prev = await previewer(projectId);
          if (prev.ok) {
            body += `\n\nTry it yourself: [${prev.url}](${prev.url})` +
                    (prev.ready ? '' : ' — still booting, give it a few seconds') + '.';
          }
        } catch (e) { console.warn('[preview]', e?.message); }
      }
    }
    else {
      const cls = classifyFailure(r.lastStep, r.lastOutput);
      const note = cls.kind === 'environment'
        ? ` This looks like ${cls.hint} — I've adjusted the sandbox setup; another "Run it" may clear it.`
        : cls.kind === 'dependency' ? ` This looks like ${cls.hint}.` : '';
      body = `Couldn't get it green after ${r.rounds} round${r.rounds === 1 ? '' : 's'} — the \`${r.lastStep}\` step still fails.${note} Latest output:\n\n\`\`\`\n${String(r.lastOutput || '').slice(-1200)}\n\`\`\`\n\nSay "Run it" to try again.`;
    }
    const spec = closingSpec(body);
    appendTurn(buildAgentId, 'assistant', spec);
    setKickoff(projectId, { status: r.ok ? 'verified' : (r.daemonDown ? 'run_pending' : 'built') });
    emitStatus(projectId, buildAgentId, 'idle');
    emitActivity(projectId, r.ok ? `${sweName}: build + test green` : `${sweName}: still failing`, buildAgentId);
    return { handled: true, intent: r.ok ? 'verified' : 'run_failed', spec };
  }

  if (k.status !== 'awaiting_approval') return { handled: false };
  const intent = classifyApproval(text);
  const project = getProject(projectId);
  // A submitted plan choice ("Go ahead…") proceeds, same as an affirmative reply.
  if (intent === 'approve' || isApprovingChoice(text)) {
    appendTurn(project.leadAgentId, 'user', text);
    await executeKickoff(projectId, opts);
    return { handled: true, intent: 'approve' };
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
