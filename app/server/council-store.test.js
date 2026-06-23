import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-state-'));
const { getCouncil, saveCouncil, clearCouncil } = await import('./council-store.js');

test('council transcript saves, restores, and clears per project', () => {
  const pid = 'p_test_council';
  assert.equal(getCouncil(pid), null, 'no transcript initially');

  const state = { phase: 'done', question: 'Which db?', answers: [{ q: 'scale?', a: 'small' }],
                  members: [{ model: 'm1', content: 'Postgres' }], synthesis: { model: 'm1', content: 'Use Postgres.' } };
  saveCouncil(pid, state);
  const got = getCouncil(pid);
  assert.equal(got.question, 'Which db?');
  assert.equal(got.synthesis.content, 'Use Postgres.');
  assert.equal(got.answers[0].a, 'small');
  assert.ok(got.updatedAt, 'stamps updatedAt');

  // Saving null clears it.
  saveCouncil(pid, null);
  assert.equal(getCouncil(pid), null, 'null state clears the transcript');

  // clearCouncil also removes it.
  saveCouncil(pid, state);
  clearCouncil(pid);
  assert.equal(getCouncil(pid), null, 'clearCouncil removes the transcript');
});
