import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyApproval, topologyGuidance, DOC_TITLES, buildPlanPrompt } from './kickoff.js';

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
