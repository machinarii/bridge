import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingOutput, applyCostCap } from './team.js';

test('parseRoutingOutput accepts the JSON shape', () => {
  const r = parseRoutingOutput('{"assignments":[{"agentId":"a1","task":"x"}],"summary_intent":"ok"}');
  assert.equal(r.assignments.length, 1);
  assert.equal(r.summary_intent, 'ok');
});

test('parseRoutingOutput strips code fences', () => {
  const r = parseRoutingOutput('```json\n{"assignments":[],"summary_intent":"none"}\n```');
  assert.deepEqual(r.assignments, []);
});

test('parseRoutingOutput throws on garbage', () => {
  assert.throws(() => parseRoutingOutput('this is not json'));
});

test('applyCostCap drops assignees past cap', () => {
  const xs = [1,2,3,4,5,6,7].map(i => ({ agentId: `a${i}`, task: 't' }));
  const r = applyCostCap(xs, 5);
  assert.equal(r.kept.length, 5);
  assert.equal(r.dropped.length, 2);
});

test('parseRoutingOutput sanitizes sharedFrom (cap count, truncate snippet)', () => {
  const longSnippet = 'x'.repeat(500);
  const raw = JSON.stringify({
    assignments: [{
      agentId: 'a1', task: 't',
      sharedFrom: [
        { fromAgentName: 'Kade', fromRole: 'Engineer', snippet: longSnippet },
        { fromAgentName: 'Iris', fromRole: 'Designer', snippet: 'short' },
        { fromAgentName: 'Tess', fromRole: 'QA',       snippet: 'also short' },
        { fromAgentName: 'Vex',  fromRole: 'Sec',      snippet: 'dropped past cap' },
      ],
    }],
    summary_intent: 'ok',
  });
  const r = parseRoutingOutput(raw);
  assert.equal(r.assignments[0].sharedFrom.length, 3);
  assert.equal(r.assignments[0].sharedFrom[0].snippet.length, 240);
});
