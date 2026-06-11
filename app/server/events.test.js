import test from 'node:test';
import assert from 'node:assert/strict';
import { publish, subscribe, emitActivity, emitDelegate, emitStatus, statusSnapshot, _feedBufferSize } from './events.js';

test('subscribe backfills recent activity/delegate events, flagged backfill:true', () => {
  emitActivity('p1', 'Iris: replied', 'p1__designer', { awaitKind: 'view' });
  emitDelegate('p1', 'p1__pm', 'p1__designer', 'Draft the screen');
  emitStatus('p1', 'p1__designer', 'drafting');   // live-only — must NOT be buffered

  const got = [];
  const unsub = subscribe(null, (ev) => got.push(ev));
  try {
    // The new subscriber receives the buffered feed up front.
    const types = got.map(e => e.type);
    assert.ok(types.includes('activity'), 'activity backfilled');
    assert.ok(types.includes('delegate'), 'delegate backfilled');
    assert.ok(!types.includes('status'), 'status is live-only, not buffered');
    // Every backfilled event is flagged so the renderer skips live side effects.
    assert.ok(got.every(e => e.backfill === true), 'backfill flag set on replay');
    // Each carries its original id (renderer dedupes on reconnect).
    assert.ok(got.every(e => typeof e.id === 'number'), 'ids preserved');
  } finally { unsub(); }
});

test('live events reach subscribers without the backfill flag', () => {
  const got = [];
  const unsub = subscribe(null, (ev) => { if (!ev.backfill) got.push(ev); });
  try {
    emitActivity('p2', 'Kade: built it', 'p2__sw_engineer', { awaitKind: 'view' });
    const live = got.find(e => e.projectId === 'p2');
    assert.ok(live, 'live activity delivered');
    assert.equal(live.backfill, undefined, 'live events are not flagged backfill');
  } finally { unsub(); }
});

test('a project-scoped subscriber only backfills its own project', () => {
  emitActivity('alpha', 'A: x', 'alpha__pm');
  emitActivity('beta', 'B: y', 'beta__pm');
  const got = [];
  const unsub = subscribe('alpha', (ev) => got.push(ev));
  try {
    assert.ok(got.some(e => e.projectId === 'alpha'), 'own-project event backfilled');
    assert.ok(!got.some(e => e.projectId === 'beta'), 'other-project event excluded');
  } finally { unsub(); }
});

test('_feedBufferSize reflects buffered feed events', () => {
  assert.equal(typeof _feedBufferSize(), 'number');
});

test('statusSnapshot tracks live non-idle verbs per project; idle clears', () => {
  emitStatus('pSnap', 'a1', 'drafting');
  emitStatus('pSnap', 'a2', 'analyzing');
  emitStatus('pSnap', 'a2', 'idle');
  emitStatus('pOther', 'b1', 'building');
  assert.deepEqual(statusSnapshot('pSnap'), { a1: 'drafting' }, 'non-idle kept, idle cleared, other projects excluded');
  emitStatus('pSnap', 'a1', 'idle');
  assert.deepEqual(statusSnapshot('pSnap'), {}, 'all idle → empty snapshot');
  assert.deepEqual(statusSnapshot('pNever'), {}, 'unknown project → empty');
});
