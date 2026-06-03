/* Bridge — PM auto-kickoff. After a project is created the PM posts a
 * plan-first kickoff to the lead chat; on approval it generates a PRD +
 * supporting docs and assigns topology-shaped starting tasks to the team.
 * See docs/superpowers/specs/2026-06-03-pm-kickoff-design.md. */

import { getRole } from './roles.js';

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
