/* Shared OpenRouter plain-text completion. Extracted from kickoff.js so the
 * task executor can use it without a kickoff↔executor import cycle. */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PLAN_TIMEOUT_MS = 20_000;

export async function callOpenRouterText({ apiKey, model, prompt, timeoutMs = PLAN_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      return '';
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) console.warn(`[openrouter] ${model} → empty content (finish_reason: ${data?.choices?.[0]?.finish_reason || '?'})`);
    return content;
  } catch (err) { console.warn(`[openrouter] ${model} → ${err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || err)}`); return ''; }
  finally { clearTimeout(timer); }
}
