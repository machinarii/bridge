import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject } = await import('./projects.js');
const { startTeamReview, currentReviewAgent, teamReviewReady } = await import('./team-review.js');

test('startTeamReview orders enabled non-lead agents; readiness flips when all captured', async () => {
  const p = await createProject({ name: 'Review Round', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const proj = getProject(p.id);
    assert.equal(proj.phase, 'team_review');
    const leadId = proj.leadAgentId;
    assert.equal(proj.teamReview.order.length, 2);
    assert.ok(!proj.teamReview.order.includes(leadId));
    assert.equal(proj.teamReview.idx, 0);
    assert.equal(teamReviewReady(p.id), false);
    assert.equal(currentReviewAgent(p.id).id, proj.teamReview.order[0]);
  } finally { deleteProject(p.id); }
});

test('a disabled specialist is excluded from the round', async () => {
  const p = await createProject({ name: 'Review Disabled', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const proj = getProject(p.id);
    proj.agents.find(a => a.role === 'sw_engineer').enabled = false;
    startTeamReview(p.id);
    assert.deepEqual(getProject(p.id).teamReview.order, [proj.agents.find(a => a.role === 'designer').id]);
  } finally { deleteProject(p.id); }
});
