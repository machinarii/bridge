import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'bridge-loops-'));
const loops = await import('./loops.js');

beforeEach(() => loops._resetForTests());

test('a loop runs when due and is skipped until its cadence elapses', async () => {
  const runs = [];
  loops.registerLoop({ id: 'l', everyMs: 60_000, run: async ({ now }) => { runs.push(now); } });

  await loops.runDueLoops({ now: 1_000_000 });          // never run → due
  await loops.runDueLoops({ now: 1_030_000 });          // +30s → not due
  await loops.runDueLoops({ now: 1_060_000 });          // +60s → due again
  assert.deepEqual(runs, [1_000_000, 1_060_000]);
});

test('run() receives the PREVIOUS stamp as lastRun, so it can report on the gap', async () => {
  const seen = [];
  loops.registerLoop({ id: 'gap', everyMs: 10, run: async ({ lastRun }) => { seen.push(lastRun); } });
  await loops.runLoop('gap', { now: 500 });
  await loops.runLoop('gap', { now: 900 });
  assert.deepEqual(seen, [0, 500], 'first run sees 0, second sees the first run');
});

test('the stamp is written before run(), so a thrower does not re-fire every tick', async () => {
  let calls = 0;
  loops.registerLoop({ id: 'boom', everyMs: 60_000, run: async () => { calls++; throw new Error('nope'); } });
  const [r] = await loops.runDueLoops({ now: 2_000_000 });
  assert.equal(r.ran, false);
  assert.match(r.error, /nope/);
  await loops.runDueLoops({ now: 2_010_000 });
  assert.equal(calls, 1, 'a failing loop waits out its cadence like any other');
});

test('a loop never overlaps itself', async () => {
  let active = 0, maxActive = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  loops.registerLoop({ id: 'slow', everyMs: 0, run: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await gate;
    active--;
  } });
  const first = loops.runLoop('slow', { now: 1 });
  const second = await loops.runLoop('slow', { now: 2 });
  assert.equal(second.ran, false);
  assert.equal(second.skipped, 'already running');
  release();
  await first;
  assert.equal(maxActive, 1);
});

test('stamps persist across a module reload (a restart does not re-fire everything)', async () => {
  loops.registerLoop({ id: 'persisted', everyMs: 60_000, run: async () => {} });
  await loops.runLoop('persisted', { now: 5_000_000 });

  const fresh = await import(`./loops.js?reload=${Date.now()}`);
  fresh.registerLoop({ id: 'persisted', everyMs: 60_000, run: async () => {} });
  assert.equal(fresh.lastRun('persisted'), 5_000_000);
  assert.equal(fresh.isDue('persisted', 5_030_000), false, 'still on cooldown after a restart');
  assert.equal(fresh.isDue('persisted', 5_060_000), true);
  fresh._resetForTests();
});

test('registerLoop rejects a malformed loop', () => {
  assert.throws(() => loops.registerLoop({ id: 'x' }), /needs \{ id, run \}/);
  assert.throws(() => loops.registerLoop({ run: () => {} }), /needs \{ id, run \}/);
});
