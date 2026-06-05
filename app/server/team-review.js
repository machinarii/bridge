/* The sequential team planning round (Phase A, §4 steps 2–3). After kickoff,
 * each enabled specialist (non-lead) records a domain plan before the PM
 * proposes a build plan. Deterministic state machine only — model-driven plan
 * generation and live kickoff wiring land in Plan 4. */
import { getProject, setProjectState } from './projects.js';
import { writeNote } from './backends/notes.js';

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
