/* Shared OpenRouter plain-text completion. Extracted from kickoff.js so the
 * task executor can use it without a kickoff↔executor import cycle. */

import { recordModelCall } from './metrics.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_TIMEOUT_MS = 20_000;

export async function callOpenRouterText({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS, meta = {} }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - kickoff' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
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
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/bridge', 'X-Title': 'Bridge - council' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) { console.warn(`[openrouter] ${model} (json) → HTTP ${r.status}`); recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false }); return '{}'; }
    const data = await r.json();
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, usage: data?.usage, ok: true });
    return data?.choices?.[0]?.message?.content || '{}';
  } catch (err) {
    console.warn(`[openrouter] ${model} (json) → ${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || err)}`);
    recordModelCall({ model, ...meta, latencyMs: Date.now() - t0, ok: false });
    return '{}';
  } finally { clearTimeout(timer); }
}
