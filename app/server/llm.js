/* Shared OpenRouter plain-text completion. Extracted from kickoff.js so the
 * task executor can use it without a kickoff↔executor import cycle. */

import { recordModelCall } from './metrics.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_TIMEOUT_MS = 20_000;
const GLOBAL_LLM_CONCURRENCY = Math.max(1, Number(process.env.BRIDGE_LLM_CONCURRENCY || 4));
const ROUTER_LLM_CONCURRENCY = Math.max(1, Number(process.env.BRIDGE_ROUTER_LLM_CONCURRENCY || 2));

/* Transient upstream failures (rate limit, low-credit 402, 5xx, dropped
 * connection) get an exponential-backoff retry instead of instantly failing
 * the agent turn — the metrics log showed bursts of sub-300ms failures killing
 * whole review rounds. Honors Retry-After. Never retries 4xx caller bugs or
 * an AbortError (that's the caller's own timeout/cancel). */
const RETRYABLE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn, signal = null) {
    await this.acquire(signal);
    try { return await fn(); }
    finally {
      this.active--;
      this.pump();
    }
  }

  acquire(signal = null) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal, onAbort: null };
      item.onAbort = () => {
        this.queue = this.queue.filter(x => x !== item);
        reject(abortError(signal));
      };
      signal?.addEventListener?.('abort', item.onAbort, { once: true });
      this.queue.push(item);
    });
  }

  pump() {
    while (this.active < this.max && this.queue.length) {
      const item = this.queue.shift();
      if (item.signal?.aborted) {
        item.reject(abortError(item.signal));
        continue;
      }
      item.signal?.removeEventListener?.('abort', item.onAbort);
      this.active++;
      item.resolve();
    }
  }

  snapshot() { return { active: this.active, queued: this.queue.length, max: this.max }; }
}

const globalLimiter = new Semaphore(GLOBAL_LLM_CONCURRENCY);
const routerLimiter = new Semaphore(ROUTER_LLM_CONCURRENCY);

function abortError(signal) {
  const e = new Error(String(signal?.reason?.message || signal?.reason || 'aborted'));
  e.name = 'AbortError';
  return e;
}

export function llmConcurrencySnapshot() {
  return { global: globalLimiter.snapshot(), router: routerLimiter.snapshot() };
}

export function mergeSignals(...signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  const ctrl = new AbortController();
  const abort = (s) => {
    if (!ctrl.signal.aborted) ctrl.abort(s?.reason || new Error('aborted'));
  };
  for (const s of active) {
    if (s.aborted) { abort(s); break; }
    s.addEventListener('abort', () => abort(s), { once: true });
  }
  return ctrl.signal;
}

export function deadlineSignal(ms, parentSignal = null, label = 'operation') {
  if (!(ms > 0)) return { signal: parentSignal, cleanup: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    const e = new Error(`${label} timed out after ${ms}ms`);
    e.name = 'AbortError';
    ctrl.abort(e);
  }, ms);
  const signal = mergeSignals(parentSignal, ctrl.signal);
  return { signal, cleanup: () => clearTimeout(timer) };
}

function sleepAbortable(ms, signal, _sleep = sleep) {
  if (!signal) return _sleep(ms);
  if (signal.aborted) return Promise.reject(abortError(signal));
  if (_sleep !== sleep) return _sleep(ms);
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError(signal));
    }, { once: true });
  });
}

export async function fetchWithRetry(url, init = {}, { retries = 2, baseDelayMs = 1000, lane = 'global', _fetch = fetch, _sleep = sleep } = {}) {
  let lastErr = null;
  const signal = init.signal || null;
  const limiter = lane === 'router' ? routerLimiter : globalLimiter;
  for (let attempt = 0; ; attempt++) {
    let r = null;
    try {
      if (signal?.aborted) throw abortError(signal);
      r = await limiter.run(() => _fetch(url, init), signal);
      if (!RETRYABLE_STATUS.has(r.status) || attempt >= retries) return r;
    } catch (err) {
      if (err?.name === 'AbortError' || attempt >= retries) throw err;
      lastErr = err;
    }
    const retryAfter = Number(r?.headers?.get?.('Retry-After')) * 1000;
    const delay = retryAfter > 0 ? retryAfter : baseDelayMs * 2 ** attempt;
    console.warn(`[openrouter] transient failure (${r ? `HTTP ${r.status}` : lastErr?.message}) — retry ${attempt + 1}/${retries} in ${delay}ms`);
    await sleepAbortable(delay, signal, _sleep);
  }
}
// Cap output so OpenRouter reserves a bounded amount against the account balance
// instead of the model's full ceiling (~65536), which 402s on low credit. Plans
// and docs fit comfortably; still well under a typical balance.
const MAX_OUTPUT_TOKENS = 32_768;

export async function callOpenRouterText({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS, meta = {}, signal = null, _fetch = fetch }) {
  const deadline = deadlineSignal(timeoutMs, signal, `${model} text call`);
  const t0 = Date.now();
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - kickoff' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] }),
      signal: deadline.signal,
    }, { _fetch });
    if (!r.ok) {
      console.warn(`[openrouter] ${model} → HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
      recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false });
      return '';
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) console.warn(`[openrouter] ${model} → empty content (finish_reason: ${data?.choices?.[0]?.finish_reason || '?'})`);
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, usage: data?.usage, ok: !!content });
    return content;
  } catch (err) {
    console.warn(`[openrouter] ${model} → ${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || err)}`);
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false });
    return '';
  } finally { deadline.cleanup(); }
}

/* Same call constrained to a JSON object response. Returns the raw JSON string
 * (caller parses); on any failure returns '{}' so the caller never throws. */
export async function callOpenRouterJSON({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS, meta = {}, signal = null, _fetch = fetch }) {
  const deadline = deadlineSignal(timeoutMs, signal, `${model} json call`);
  const t0 = Date.now();
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - council' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: deadline.signal,
    }, { lane: meta?.kind?.includes?.('routing') || meta?.kind?.includes?.('classify') ? 'router' : 'global', _fetch });
    if (!r.ok) { console.warn(`[openrouter] ${model} (json) → HTTP ${r.status}`); recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false }); return '{}'; }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) console.warn(`[openrouter] ${model} (json) → empty content (finish_reason: ${data?.choices?.[0]?.finish_reason || '?'})`);
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, usage: data?.usage, ok: !!content });
    return content || '{}';
  } catch (err) {
    console.warn(`[openrouter] ${model} (json) → ${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || err)}`);
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false });
    return '{}';
  } finally { deadline.cleanup(); }
}
