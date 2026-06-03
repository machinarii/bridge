/* Bridge — PM auto-kickoff. After a project is created the PM posts a
 * plan-first kickoff to the lead chat; on approval it generates a PRD +
 * supporting docs and assigns topology-shaped starting tasks to the team.
 * See docs/superpowers/specs/2026-06-03-pm-kickoff-design.md. */

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
