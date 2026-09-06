/* Bridge — the loop tick.
 *
 * The one recurring clock in the orchestrator. A "loop" is the shape autonomous
 * agent work keeps landing on: it fetches its own inputs, does the work, gates
 * the result, and writes a named artifact — then repeats. Every other path in
 * Bridge starts from a keystroke; this is the part that starts on its own.
 *
 * Registration is explicit (see server.js) so the set of loops stays greppable.
 * Cadence is per-loop, and the last-run stamp persists to <stateDir>/loops.json
 * so a restart — or `npm run dev`'s --watch — doesn't re-fire every loop and
 * burn a round of model calls.
 *
 * API:
 *   registerLoop({ id, everyMs?, run })  → void
 *   startLoops() / stopLoops()           → void
 *   runDueLoops(opts?)                   → Promise<result[]>
 *   runLoop(id, opts?)                   → Promise<result>   (manual trigger)
 *   listLoops()                          → [{ id, everyMs, lastRun }]
 *
 * A loop's run() receives { ...opts, now, lastRun } — lastRun being the PREVIOUS
 * stamp, so a loop can report on "what changed since I last looked".
 *
 * BRIDGE_LOOP_INTERVAL_MIN=0 turns the tick off; manual triggers still work.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';

const TICK_MS = Math.max(0, Number(process.env.BRIDGE_LOOP_INTERVAL_MIN ?? 5)) * 60_000;
const DEFAULT_EVERY_MS = 30 * 60_000;

const loops = new Map();     // id → { id, everyMs, run }
const running = new Set();   // ids with a run() in flight — never overlap a loop with itself
let handle = null;

function stampsFile() { return join(stateDir(), 'loops.json'); }

let cache = null;
function load() {
  if (cache) return cache;
  ensureStateDir();
  if (existsSync(stampsFile())) {
    try { cache = JSON.parse(readFileSync(stampsFile(), 'utf8')); } catch { cache = {}; }
  } else cache = {};
  return cache;
}
function setStamp(id, at) {
  const data = load();
  data[id] = at;
  try { writeFileSync(stampsFile(), JSON.stringify(data, null, 2), 'utf8'); }
  catch (err) { console.warn('[loops] stamp write failed:', err?.message); }
}

/** When the loop last started, or 0 if it never has. */
export function lastRun(id) { return Number(load()[id]) || 0; }

export function registerLoop(loop) {
  if (!loop?.id || typeof loop.run !== 'function') throw new Error('a loop needs { id, run }');
  loops.set(loop.id, { everyMs: DEFAULT_EVERY_MS, ...loop });
}

export function listLoops() {
  return [...loops.values()].map(l => ({ id: l.id, everyMs: l.everyMs, lastRun: lastRun(l.id) }));
}

export function isDue(id, now = Date.now()) {
  const loop = loops.get(id);
  if (!loop) return false;
  return now - lastRun(id) >= loop.everyMs;
}

/** Run one loop now, regardless of cadence. Never throws: a loop that blows up
 * logs and reports, it doesn't take the tick (or the server) with it. */
export async function runLoop(id, opts = {}) {
  const loop = loops.get(id);
  if (!loop) throw new Error(`unknown loop: ${id}`);
  if (running.has(id)) return { id, ran: false, skipped: 'already running' };
  running.add(id);
  const now = opts.now || Date.now();
  const prev = lastRun(id);
  setStamp(id, now);   // stamp BEFORE running: a slow or failing loop must not re-fire every tick
  try {
    return { id, ran: true, result: await loop.run({ ...opts, now, lastRun: prev }) };
  } catch (err) {
    console.warn(`[loops] ${id} failed:`, err?.message);
    return { id, ran: false, error: String(err?.message || err) };
  } finally { running.delete(id); }
}

/** One tick: run every loop whose cadence has come due. Sequential — loops are
 * model-heavy and there are a handful of them, so there's nothing to win by
 * racing them against each other for the LLM concurrency slots. */
export async function runDueLoops(opts = {}) {
  const now = opts.now || Date.now();
  const out = [];
  for (const loop of loops.values()) {
    if (!isDue(loop.id, now)) { out.push({ id: loop.id, ran: false, skipped: 'not due' }); continue; }
    out.push(await runLoop(loop.id, { ...opts, now }));
  }
  return out;
}

export function startLoops() {
  stopLoops();
  if (!(TICK_MS > 0)) { console.log('[loops] tick disabled (BRIDGE_LOOP_INTERVAL_MIN=0)'); return; }
  handle = setInterval(() => {
    runDueLoops().catch(err => console.warn('[loops] tick:', err?.message));
  }, TICK_MS);
  handle.unref?.();   // the tick must never be the reason the process stays alive
  console.log(`[loops] tick every ${TICK_MS / 60_000}m — ${loops.size} registered`);
}

export function stopLoops() {
  if (handle) { clearInterval(handle); handle = null; }
}

export function _resetForTests() { loops.clear(); running.clear(); cache = null; stopLoops(); }
