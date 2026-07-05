/* Per-call model metrics. Append-only JSONL of every OpenRouter call so the
 * cost/latency of each model and role is measurable (and tiering savings are a
 * measured fact, not a guess). Pure observability — never throws into the hot
 * path; disable with BRIDGE_METRICS=off.
 *
 *   recordModelCall({ model, role?, kind?, latencyMs?, usage?, ok? })
 *   recordOrchestrationEvent({ projectId?, kind, latencyMs?, counts?, ok? })
 *   metricsFile() → absolute path of the log (for tooling/tests)
 */

import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';

export function metricsFile() { return join(stateDir(), 'agent-metrics.jsonl'); }

// Bound the log: once it passes this size, roll to a single .1 generation
// (overwriting any prior roll). Overridable for tests via BRIDGE_METRICS_MAX_BYTES.
function maxBytes() { return Number(process.env.BRIDGE_METRICS_MAX_BYTES) || 50 * 1024 * 1024; }

let _warned = false;

export function recordModelCall({ model = null, role = null, kind = null, latencyMs = null, usage = null, ok = true } = {}) {
  if ((process.env.BRIDGE_METRICS || 'on') === 'off') return;
  try {
    ensureStateDir();
    const rec = {
      ts: Date.now(),
      model,
      role,
      kind,                         // 'agent' | 'router' | 'council' | 'kickoff' | …
      ok: !!ok,
      latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    };
    const f = metricsFile();
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
    if (statSync(f).size > maxBytes()) renameSync(f, f + '.1');   // roll, keep one prior generation
  } catch (err) {
    if (!_warned) { _warned = true; console.warn('[metrics] logging disabled:', err.message); }
  }
}

export function recordOrchestrationEvent({ projectId = null, kind = null, latencyMs = null, counts = null, ok = true } = {}) {
  if ((process.env.BRIDGE_METRICS || 'on') === 'off') return;
  try {
    ensureStateDir();
    const rec = {
      ts: Date.now(),
      type: 'orchestration',
      projectId,
      kind,
      ok: !!ok,
      latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      counts: counts && typeof counts === 'object' ? counts : null,
    };
    const f = metricsFile();
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
    if (statSync(f).size > maxBytes()) renameSync(f, f + '.1');
  } catch (err) {
    if (!_warned) { _warned = true; console.warn('[metrics] logging disabled:', err.message); }
  }
}
