import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateTileSpec, validateRouting, validateReviewQuestion } = await import('./schema.js');

test('validateTileSpec accepts and sanitizes an answer spec', () => {
  const spec = validateTileSpec('{"intent":"answer","template":"reader","title":"t","body":"b","choices":["A","B","","C","D","E"],"actions":[{"verb":"Back","glyph":"circle","action":{"type":"cancel"}}]}');
  assert.equal(spec.intent, 'answer');
  assert.deepEqual(spec.choices, ['A', 'B', 'C', 'D']);
  assert.equal(spec.actions[0].glyph, 'circle');
});

test('validateTileSpec requires delegate role/task', () => {
  assert.equal(validateTileSpec('{"intent":"delegate","to_role":"","task":"x"}'), null);
  const spec = validateTileSpec('{"intent":"delegate","to_role":"qa","task":"do qa"}');
  assert.equal(spec.to_role, 'qa');
});

test('validateRouting caps sharedFrom and strips invalid assignments', () => {
  const raw = JSON.stringify({
    assignments: [
      { agentId: 'a1', task: 't1', sharedFrom: [{ fromAgentName: 'n', fromRole: 'r', snippet: 'x'.repeat(500) }, { fromAgentName: 'n2', fromRole: 'r2', snippet: 'ok' }, { fromAgentName: 'n3', fromRole: 'r3', snippet: 'ok2' }, { fromAgentName: 'n4', fromRole: 'r4', snippet: 'drop' }] },
      { agentId: '', task: 'bad' },
    ],
  });
  const v = validateRouting(raw, { sharedFromMax: 3, sharedSnippetMax: 20 });
  assert.equal(v.assignments.length, 1);
  assert.equal(v.assignments[0].sharedFrom.length, 3);
  assert.equal(v.assignments[0].sharedFrom[0].snippet.length, 20);
});

test('validateReviewQuestion requires non-empty question', () => {
  assert.equal(validateReviewQuestion('{"question":"","options":["a"]}'), null);
  const q = validateReviewQuestion('{"question":"Q?","options":["A","B","C","D","E"]}');
  assert.deepEqual(q.options, ['A', 'B', 'C', 'D']);
});
