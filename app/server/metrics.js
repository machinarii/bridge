/* Per-call model metrics. Append-only JSONL of every OpenRouter call so the
 * cost/latency of each model and role is measurable (and tiering savings are a
 * measured fact, not a guess). Pure observability — never throws into the hot
 * path; disable with BRIDGE_METRICS=off.
 *
 *   recordModelCall({ model, role?, kind?, latencyMs?, usage?, ok? })
 *   metricsFile() → absolute path of the log (for tooling/tests)
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, ensureStateDir } from './state-dir.js';

export function metricsFile() { return join(stateDir(), 'agent-metrics.jsonl'); }

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
    appendFileSync(metricsFile(), JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    if (!_warned) { _warned = true; console.warn('[metrics] logging disabled:', err.message); }
  }
}
