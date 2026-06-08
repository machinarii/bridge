// app/server/team-review-turn.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const { createProject, getProject, deleteProject, docsDir } = await import('./projects.js');
const { charterFileNameFor } = await import('./charters.js');
const { startTeamReview, currentReviewAgent, teamReviewReady, planAgentTurn } = await import('./team-review.js');

test('planAgentTurn generates a plan for the current agent, records it, advances', async () => {
  const p = await createProject({ name: 'Turn One', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const a0 = currentReviewAgent(p.id);
    let seenModel = null;
    const callText = async ({ model }) => { seenModel = model; return '# Plan\n\nmy domain plan\n'; };
    await planAgentTurn(p.id, a0.id, { callText });
    const roleFile = resolve(docsDir(p.id), 'roles', charterFileNameFor(a0.role));
    assert.ok(existsSync(roleFile) && /## Plan/.test(readFileSync(roleFile, 'utf8')), 'plan section written into role file');
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

import { handleLeadMessageDuringKickoff } from './kickoff.js';
test('interactive team round: each specialist asks a question, then build plan', async () => {
  const p = await createProject({ name: 'Round Live', goal: 'g', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    // jump straight to the team round
    const { startTeamReview } = await import('./team-review.js');
    const { setKickoff, getProject } = await import('./projects.js');
    startTeamReview(p.id);
    // post first question manually via the handler path: simulate being in team_review
    setKickoff(p.id, { status: 'team_review' });
    // Specialist questions are JSON {question, options}.
    const qJson = async () => JSON.stringify({ question: 'Q?', options: ['a', 'b'] });
    // answer specialist 1 → should ask specialist 2 (another question)
    const r1 = await handleLeadMessageDuringKickoff(p.id, 'use a clean minimal UI', { callText: qJson });
    assert.equal(r1.intent, 'team_review_question');
    // answer specialist 2 → round done → build plan attempt (stub isn't a valid plan → close)
    const r2 = await handleLeadMessageDuringKickoff(p.id, 'node + sqlite', { callText: qJson });
    assert.ok(['build_plan', 'questions_done'].includes(r2.intent));
  } finally { deleteProject(p.id); }
});

test('teamReviewQuestion: parses JSON, retries, and returns null (skip) when unusable', async () => {
  const { teamReviewQuestion, parseReviewQuestion, startTeamReview, currentReviewAgent } = await import('./team-review.js');
  // pure parser
  assert.deepEqual(parseReviewQuestion('```json\n{"question":"What DB?","options":["sqlite","postgres"]}\n```'), { q: 'What DB?', options: ['sqlite', 'postgres'] });
  assert.equal(parseReviewQuestion('not json at all'), null);
  assert.equal(parseReviewQuestion('{"question":"","options":[]}'), null);   // empty question → null
  const p = await createProject({ name: 'Q Skip', goal: 'g', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    startTeamReview(p.id);
    const a = currentReviewAgent(p.id);
    // a real JSON question parses
    const ok = await teamReviewQuestion(p.id, a.id, { callText: async () => '{"question":"Scope?","options":["x","y"]}' });
    assert.deepEqual(ok, { q: 'Scope?', options: ['x', 'y'] });
    // a non-JSON / empty reply → null after retry (caller will skip the agent)
    assert.equal(await teamReviewQuestion(p.id, a.id, { callText: async () => 'sorry, no idea' }), null);
    assert.equal(await teamReviewQuestion(p.id, a.id, { callText: async () => '' }), null);
  } finally { deleteProject(p.id); }
});

import { annotateAgentMentions } from './kickoff.js';

test('annotateAgentMentions: tags a mentioned teammate with their role', () => {
  const agents = [
    { id: 'p__pm', role: 'pm', name: 'Cassidy' },
    { id: 'p__marketing', role: 'marketing', name: 'Brio' },
    { id: 'p__legal', role: 'legal', name: 'Hollis' },
  ];
  // Brio (the asker) mentions Hollis → Hollis gets role-tagged, Brio does not.
  assert.equal(
    annotateAgentMentions('How do I stay legally honest with Hollis?', agents, 'p__marketing'),
    'How do I stay legally honest with Hollis (Legal)?'
  );
  // Already-tagged names and the asker's own name are left alone (no doubling).
  assert.equal(
    annotateAgentMentions('Brio asks Hollis (Legal) for review', agents, 'p__marketing'),
    'Brio asks Hollis (Legal) for review'
  );
});
