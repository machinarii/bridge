import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'bridge-learn-')); process.env.BRIDGE_STATE_DIR = tmp; });

let learn;
before(async () => { learn = await import('./learnings.js'); });

const PID = 'p_test_proj';
beforeEach(() => { learn.clearLearnings(PID); });

test('addLearning stores and getLearnings reads back', () => {
  learn.addLearning(PID, { insight: 'Use Postgres for the cost model', type: 'decision', confidence: 9, role: 'pm' });
  const list = learn.getLearnings(PID);
  assert.equal(list.length, 1);
  assert.equal(list[0].insight, 'Use Postgres for the cost model');
  assert.equal(list[0].type, 'decision');
  assert.equal(list[0].confidence, 9);
  assert.equal(list[0].role, 'pm');
});

test('empty insight or missing projectId is ignored', () => {
  assert.equal(learn.addLearning(PID, { insight: '   ' }), null);
  assert.equal(learn.addLearning(null, { insight: 'x' }), null);
  assert.equal(learn.getLearnings(PID).length, 0);
});

test('latest write wins for the same key', () => {
  learn.addLearning(PID, { key: 'db', insight: 'Use Postgres', confidence: 6, ts: 1 });
  learn.addLearning(PID, { key: 'db', insight: 'Switched to SQLite for the demo', confidence: 8, ts: 2 });
  const list = learn.getLearnings(PID);
  assert.equal(list.length, 1);
  assert.equal(list[0].insight, 'Switched to SQLite for the demo');
  assert.equal(list[0].confidence, 8);
});

test('dedupe keys off the insight prefix when no explicit key', () => {
  learn.addLearning(PID, { insight: 'Auth flow has a token-refresh race', confidence: 7, ts: 1 });
  learn.addLearning(PID, { insight: 'Auth flow has a token-refresh race', confidence: 9, ts: 2 });
  assert.equal(learn.getLearnings(PID).length, 1);
  assert.equal(learn.getLearnings(PID)[0].confidence, 9);
});

test('confidence clamps to 1..10 (rounded), defaults to 5', () => {
  assert.equal(learn.addLearning(PID, { key: 'a', insight: 'hi', confidence: 99 }).confidence, 10);
  assert.equal(learn.addLearning(PID, { key: 'b', insight: 'hi', confidence: -3 }).confidence, 1);
  assert.equal(learn.addLearning(PID, { key: 'c', insight: 'hi' }).confidence, 5);
  assert.equal(learn.addLearning(PID, { key: 'd', insight: 'hi', confidence: 7.6 }).confidence, 8);
});

test('getLearnings filters by minConfidence, role-scope, and limit; sorts by confidence then recency', () => {
  learn.addLearning(PID, { key: 'a', insight: 'global low',  confidence: 4, ts: 1 });
  learn.addLearning(PID, { key: 'b', insight: 'global high', confidence: 9, ts: 2 });
  learn.addLearning(PID, { key: 'c', insight: 'pm only',     confidence: 8, ts: 3, role: 'pm' });
  learn.addLearning(PID, { key: 'd', insight: 'designer only', confidence: 8, ts: 4, role: 'designer' });

  // Designer sees: global ones + designer-scoped, not pm-scoped.
  const forDesigner = learn.getLearnings(PID, { role: 'designer', minConfidence: 7 });
  assert.deepEqual(forDesigner.map(l => l.key), ['b', 'd']); // 9 before 8
  assert.ok(!forDesigner.some(l => l.key === 'c'));          // pm-scoped excluded
  assert.ok(!forDesigner.some(l => l.key === 'a'));          // below minConfidence

  assert.equal(learn.getLearnings(PID, { minConfidence: 7, limit: 1 }).length, 1);
});

test('learningsBlock injects only confidence>=7, capped, role-aware; empty when none', () => {
  assert.equal(learn.learningsBlock(PID, 'pm'), '');
  learn.addLearning(PID, { insight: 'low conf note', confidence: 5 });
  assert.equal(learn.learningsBlock(PID, 'pm'), '', 'below-threshold learnings are not injected');
  learn.addLearning(PID, { insight: 'Ship target is Friday', type: 'fact', confidence: 9 });
  const block = learn.learningsBlock(PID, 'pm');
  assert.match(block, /Project learnings/);
  assert.match(block, /\[fact\] Ship target is Friday/);
  assert.doesNotMatch(block, /low conf note/);
});

test('clearLearnings empties the project', () => {
  learn.addLearning(PID, { insight: 'something', confidence: 9 });
  assert.equal(learn.getLearnings(PID).length, 1);
  learn.clearLearnings(PID);
  assert.equal(learn.getLearnings(PID).length, 0);
});

import { after } from 'node:test';
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
