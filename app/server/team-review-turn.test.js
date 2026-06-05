// app/server/team-review-turn.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, docsDir } = await import('./projects.js');
const { startTeamReview, currentReviewAgent, teamReviewReady, planAgentTurn } = await import('./team-review.js');

test('planAgentTurn generates a plan for the current agent, records it, advances', async () => {
  const p = await createProject({ name: 'Turn One', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const a0 = currentReviewAgent(p.id);
    let seenModel = null;
    const callText = async ({ model }) => { seenModel = model; return '# Plan\n\nmy domain plan\n'; };
    await planAgentTurn(p.id, a0.id, { callText });
    assert.ok(existsSync(resolve(docsDir(p.id), `plan-${a0.role}.md`)), 'plan doc written');
    assert.equal(getProject(p.id).teamReview.captured[a0.id].planned, true);
    assert.notEqual(currentReviewAgent(p.id)?.id, a0.id, 'advanced past a0');
    assert.ok(seenModel, 'used a role model');
  } finally { deleteProject(p.id); }
});

test('planAgentTurn falls back to a stub plan when the model returns empty', async () => {
  const p = await createProject({ name: 'Turn Empty', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const a0 = currentReviewAgent(p.id);
    await planAgentTurn(p.id, a0.id, { callText: async () => '' });
    assert.equal(getProject(p.id).teamReview.captured[a0.id].planned, true);
  } finally { deleteProject(p.id); }
});

const { writeNote } = await import('./backends/notes.js');
const { maybeFinishTeamReview } = await import('./team-review.js');

test('maybeFinishTeamReview: null until ready, then proposes a build plan (phase=build_pending)', async () => {
  const p = await createProject({ name: 'Finish Round', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    writeNote(p.id, 'PRD', '# PRD\n');
    startTeamReview(p.id);
    const planText = async () => '# Plan\n\nok\n';
    // not ready yet
    assert.equal(await maybeFinishTeamReview(p.id, { callText: planText }), null);
    // plan both specialists
    await planAgentTurn(p.id, currentReviewAgent(p.id).id, { callText: planText });
    await planAgentTurn(p.id, currentReviewAgent(p.id).id, { callText: planText });
    assert.equal(teamReviewReady(p.id), true);
    // now finishing proposes a build plan (stubbed JSON)
    const buildPlanJson = async () => JSON.stringify({ stack: 'node', summary: 's', files: [{ path: 'a.js', purpose: 'p' }] });
    const plan = await maybeFinishTeamReview(p.id, { callText: buildPlanJson });
    assert.ok(plan && plan.files.length === 1);
    assert.equal(getProject(p.id).phase, 'build_pending');
  } finally { deleteProject(p.id); }
});
