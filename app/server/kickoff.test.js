import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApproval, topologyGuidance, DOC_TITLES, buildPlanPrompt, startKickoff, executeKickoff, handleLeadMessageDuringKickoff } from './kickoff.js';
import { createProject, getKickoff, setKickoff, deleteProject } from './projects.js';
import { getContext } from './scratchpad.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Isolate state + repos to throwaway temp dirs — never touch app/state or ~/bridge-projects.
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
process.env.BRIDGE_PROJECTS_BASE = mkdtempSync(join(tmpdir(), 'bridge-test-'));

test('classifyApproval recognizes clear yes/no', () => {
  assert.equal(classifyApproval('yes'), 'approve');
  assert.equal(classifyApproval('Yes, go ahead'), 'approve');
  assert.equal(classifyApproval('looks good, proceed'), 'approve');
  assert.equal(classifyApproval('no, change the scope'), 'revise');
  assert.equal(classifyApproval('what about security?'), 'unsure');
});

test('topologyGuidance returns a non-empty string per known topology and a default', () => {
  for (const t of ['hub-and-spoke', 'feature-teams', 'mesh-mob', 'rotating-lead', 'async-pull']) {
    assert.ok(topologyGuidance(t).length > 0);
  }
  assert.ok(topologyGuidance(null).length > 0);
});

test('DOC_TITLES has the four kickoff docs', () => {
  assert.deepEqual(Object.keys(DOC_TITLES), ['prd', 'roadmap', 'operating', 'questions']);
});

test('buildPlanPrompt includes goal, topology rule, and roster names', () => {
  const project = {
    name: 'City Builder', goal: 'an urban sim', topology: 'hub-and-spoke',
    leadAgentId: 'p__pm',
    agents: [
      { id: 'p__pm', role: 'pm', name: 'Cassidy', enabled: true },
      { id: 'p__designer', role: 'designer', name: 'Iris', enabled: true },
    ],
  };
  const prompt = buildPlanPrompt(project);
  assert.match(prompt, /City Builder/);
  assert.match(prompt, /urban sim/);
  assert.match(prompt, /Iris/);
  assert.match(prompt, /Designer/i);
});

test('startKickoff posts a plan turn and sets awaiting_approval', async () => {
  const p = await createProject({ name: 'Start KO', goal: 'do X', roleIds: ['pm', 'designer'], topology: 'mesh-mob' });
  try {
    await startKickoff(p.id, { callText: async () => 'Here is my plan: draft a PRD then assign tasks.' });
    const k = getKickoff(p.id);
    assert.equal(k.status, 'awaiting_approval');
    const lead = getContext(p.leadAgentId).messages;
    const planTurn = lead[k.planTurnIndex];
    assert.equal(planTurn.role, 'assistant');
    const spec = JSON.parse(planTurn.content);
    assert.match(spec.body, /plan/i);
    // The plan is now a selectable question (choices), not an Approve/Reject gate.
    assert.ok(Array.isArray(spec.choices) && spec.choices.length >= 2, 'plan offers choices');
    assert.ok(!spec.actions || !spec.actions.some(a => a.action?.type === 'approve_kickoff'), 'no approve_kickoff action');
  } finally { deleteProject(p.id); }
});

test('startKickoff with no api key skips and marks skipped_no_key', async () => {
  const p = await createProject({ name: 'NoKey KO', goal: 'do Y', roleIds: ['pm'], topology: null });
  try {
    await startKickoff(p.id, { apiKey: '', callText: async () => 'should not be called' });
    assert.equal(getKickoff(p.id).status, 'skipped_no_key');
  } finally { deleteProject(p.id); }
});

import { generateKickoffDocs, assignKickoffTasks } from './kickoff.js';
import { listNotes } from './backends/notes.js';

test('generateKickoffDocs writes four titled notes', async () => {
  const p = await createProject({ name: 'Docs KO', goal: 'do Z', roleIds: ['pm', 'designer'], topology: 'feature-teams' });
  try {
    let n = 0;
    await generateKickoffDocs(p.id, { apiKey: 'k', callText: async () => `body ${n++}` });
    const labels = listNotes(p.id).map(x => x.label).join(' | ');
    for (const title of ['PRD', 'Roadmap & Milestones', 'Team Operating Notes', 'Open Questions']) {
      assert.ok(labels.includes(title), `missing doc: ${title} in ${labels}`);
    }
  } finally { deleteProject(p.id); }
});

test('assignKickoffTasks returns role-based assignments, including roles not on the team', async () => {
  const p = await createProject({ name: 'Assign KO', goal: 'build a hub', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const stub = async () => JSON.stringify({ assignments: [
      { role: 'designer', task: 'Draft the main screen wireframe.' },
      { role: 'sw_engineer', task: 'Stand up the project skeleton.' },  // not yet on the team
    ] });
    const { assignments } = await assignKickoffTasks(p.id, { apiKey: 'k', callJSON: stub });
    assert.equal(assignments.length, 2);
    assert.deepEqual(assignments.map(a => a.role).sort(), ['designer', 'sw_engineer']);
    assert.match(assignments.find(a => a.role === 'designer').task, /wireframe/);
    assert.match(assignments.find(a => a.role === 'sw_engineer').task, /skeleton/);
  } finally { deleteProject(p.id); }
});

test('executeKickoff runs once and is idempotent', async () => {
  const p = await createProject({ name: 'Exec KO', goal: 'do W', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const designer = p.agents.find(a => a.role === 'designer');
    const deps = {
      apiKey: 'k',
      callText: async () => 'body',
      callJSON: async () => JSON.stringify({ assignments: [{ agentId: designer.id, task: 'Sketch the UI.' }] }),
    };
    const first = await executeKickoff(p.id, deps);
    assert.equal(first.ran, true);
    // With questions generated (callText yields one), the PM moves into the
    // one-at-a-time Q&A state rather than straight to 'done'.
    assert.equal(getKickoff(p.id).status, 'asking');
    assert.equal(listNotes(p.id).length, 4);
    const second = await executeKickoff(p.id, deps);
    assert.equal(second.ran, false);
    assert.equal(listNotes(p.id).length, 4);
  } finally { deleteProject(p.id); }
});

test('approval routing: yes runs, question replies, not-awaiting passes through', async () => {
  const p = await createProject({ name: 'Approve KO', goal: 'do V', roleIds: ['pm', 'designer'], topology: 'hub-and-spoke' });
  try {
    const deps = { apiKey: 'k', callText: async () => 'b',
      callJSON: async () => JSON.stringify({ assignments: [] }) };
    assert.equal((await handleLeadMessageDuringKickoff(p.id, 'hi', deps)).handled, false);
    setKickoff(p.id, { status: 'awaiting_approval', planTurnIndex: 0 });
    const q = await handleLeadMessageDuringKickoff(p.id, 'what is the budget?', deps);
    assert.equal(q.handled, true);
    assert.equal(q.intent, 'unsure');
    assert.equal(getKickoff(p.id).status, 'awaiting_approval');
    const yes = await handleLeadMessageDuringKickoff(p.id, 'yes go ahead', deps);
    assert.equal(yes.handled, true);
    assert.equal(yes.intent, 'approve');
    // Approval runs the kickoff, which lands in the Q&A ('asking') state.
    assert.equal(getKickoff(p.id).status, 'asking');

    // Each subsequent reply advances through the questions, then closes out.
    const a1 = await handleLeadMessageDuringKickoff(p.id, 'answer one', deps);
    assert.equal(a1.handled, true);
    assert.ok(['next_question', 'questions_done', 'team_review_question'].includes(a1.intent));
    // Drain remaining PM questions AND the team planning round (each specialist
    // asks one question) until the PM wraps up. With a non-JSON stub the build
    // plan can't be parsed, so it closes at 'done'.
    let guard = 0;
    while (['asking', 'team_review'].includes(getKickoff(p.id).status) && guard++ < 20) {
      await handleLeadMessageDuringKickoff(p.id, 'another answer', deps);
    }
    assert.equal(getKickoff(p.id).status, 'done');
  } finally { deleteProject(p.id); }
});
