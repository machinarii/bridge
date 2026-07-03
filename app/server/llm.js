/* Shared OpenRouter plain-text completion. Extracted from kickoff.js so the
 * task executor can use it without a kickoff↔executor import cycle. */

import { recordModelCall } from './metrics.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_TIMEOUT_MS = 20_000;

/* Transient upstream failures (rate limit, low-credit 402, 5xx, dropped
 * connection) get an exponential-backoff retry instead of instantly failing
 * the agent turn — the metrics log showed bursts of sub-300ms failures killing
 * whole review rounds. Honors Retry-After. Never retries 4xx caller bugs or
 * an AbortError (that's the caller's own timeout/cancel). */
const RETRYABLE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchWithRetry(url, init, { retries = 2, baseDelayMs = 1000, _fetch = fetch, _sleep = sleep } = {}) {
  let lastErr = null;
  for (let attempt = 0; ; attempt++) {
    let r = null;
    try {
      r = await _fetch(url, init);
      if (!RETRYABLE_STATUS.has(r.status) || attempt >= retries) return r;
    } catch (err) {
      if (err?.name === 'AbortError' || attempt >= retries) throw err;
      lastErr = err;
    }
    const retryAfter = Number(r?.headers?.get?.('Retry-After')) * 1000;
    const delay = retryAfter > 0 ? retryAfter : baseDelayMs * 2 ** attempt;
    console.warn(`[openrouter] transient failure (${r ? `HTTP ${r.status}` : lastErr?.message}) — retry ${attempt + 1}/${retries} in ${delay}ms`);
    await _sleep(delay);
  }
}
// Cap output so OpenRouter reserves a bounded amount against the account balance
// instead of the model's full ceiling (~65536), which 402s on low credit. Plans
// and docs fit comfortably; still well under a typical balance.
const MAX_OUTPUT_TOKENS = 32_768;

export async function callOpenRouterText({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS, meta = {} }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - kickoff' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
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
  } finally { clearTimeout(timer); }
}

/* Same call constrained to a JSON object response. Returns the raw JSON string
 * (caller parses); on any failure returns '{}' so the caller never throws. */
export async function callOpenRouterJSON({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS, meta = {} }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - council' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
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
  } finally { clearTimeout(timer); }
}
