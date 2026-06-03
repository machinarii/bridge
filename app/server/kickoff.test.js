import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApproval, topologyGuidance, DOC_TITLES, buildPlanPrompt, startKickoff } from './kickoff.js';
import { createProject, getKickoff, deleteProject } from './projects.js';
import { getContext } from './scratchpad.js';

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
    assert.ok(spec.actions.some(a => a.action?.type === 'approve_kickoff'));
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

test('assignKickoffTasks posts a task into each named agent history', async () => {
  const p = await createProject({ name: 'Assign KO', goal: 'build a hub', roleIds: ['pm', 'designer', 'sw_engineer'], topology: 'hub-and-spoke' });
  try {
    const designer = p.agents.find(a => a.role === 'designer');
    const engineer = p.agents.find(a => a.role === 'sw_engineer');
    const stub = async () => JSON.stringify({ assignments: [
      { agentId: designer.id, task: 'Draft the main screen wireframe.' },
      { agentId: engineer.id, task: 'Stand up the project skeleton.' },
    ] });
    const assigned = await assignKickoffTasks(p.id, { apiKey: 'k', callJSON: stub });
    assert.equal(assigned.length, 2);
    assert.match(getContext(designer.id).messages.at(-1).content, /wireframe/);
    assert.match(getContext(engineer.id).messages.at(-1).content, /skeleton/);
  } finally { deleteProject(p.id); }
});
