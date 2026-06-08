import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject } = await import('./projects.js');
const { startTeamReview, currentReviewAgent, teamReviewReady } = await import('./team-review.js');
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { docsDir } = await import('./projects.js');
const { charterFileNameFor } = await import('./charters.js');
const { recordPlan } = await import('./team-review.js');

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

test('recordPlan writes the plan doc, marks captured, advances, and completes the round', async () => {
  const p = await createProject({ name: 'Record Plan', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const a0 = currentReviewAgent(p.id);
    recordPlan(p.id, a0.id, '# Plan\n\ndesign the thing\n');
    const roleFile = resolve(docsDir(p.id), 'roles', charterFileNameFor(a0.role));
    assert.ok(existsSync(roleFile) && /## Plan/.test(readFileSync(roleFile, 'utf8')), 'plan section written into role file');
    let tr = getProject(p.id).teamReview;
    assert.equal(tr.captured[a0.id].planned, true);
    assert.equal(tr.idx, 1);
    assert.equal(teamReviewReady(p.id), false);
    const a1 = currentReviewAgent(p.id);
    recordPlan(p.id, a1.id, '# Plan\n\nbuild the thing\n');
    assert.equal(teamReviewReady(p.id), true);
    assert.equal(currentReviewAgent(p.id), null);
  } finally { deleteProject(p.id); }
});
