import { listNotes } from './backends/notes.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getProject, TOPOLOGIES } from './projects.js';
import { readProjectCharter } from './charters.js';
import { getRole } from './roles.js';
import { getModelForRole, getRouterModel } from './models.js';
import { emitStatus, emitActivity, emitToken } from './events.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* Tile-spec contract is unchanged from Aurora MVP — see prior README. */

function systemPrompt({ project, agent, sharedFrom }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project.id, agent.role);
  const topo = project.topology ? TOPOLOGIES[project.topology] : null;
  const topoLine = topo ? `\nTeam operating model — ${topo.label}: ${topo.rule}\nLet this shape whether you handle the task yourself, delegate, or report back to the lead.\n` : '';
  const sharedBlock = (Array.isArray(sharedFrom) && sharedFrom.length)
    ? `\nContext shared with you by your teammates:\n` +
      sharedFrom.map(s => `- ${s.fromAgentName} (${s.fromRole}): "${String(s.snippet).slice(0, 240)}"`).join('\n') +
      `\nUse this only if it bears on the user's request. Do not summarise it back unless asked.\n`
    : '';
  return `You are ${agent.name}, the ${role.label} on project "${project.name}". Project goal: "${project.goal}".

Your charter for this project:
---
${charter}
---
${topoLine}${sharedBlock}
Stay in role and on-goal. Speak briefly, in first person when relevant. The user is talking to you specifically.

Your job: classify the user's intent and return a single JSON object describing the tile surface to render. No prose, no markdown, no code fences. JSON only.

There are four intent kinds:

1. take_note — the user wants to save a note. Output:
   { "intent": "take_note", "template": "compose", "context": "New note", "title": "Save this note?",
     "body": "<extracted note>", "actions": [
       { "verb": "Save",   "glyph": "cross",  "action": { "type": "save_note" } },
       { "verb": "Cancel", "glyph": "circle", "action": { "type": "cancel" } } ] }

2. list_notes — the user wants to see notes. Output:
   { "intent": "list_notes", "template": "list", "context": "Your notes", "title": "Pick a note to read",
     "actions": [
       { "verb": "Open", "glyph": "cross",  "action": { "type": "open_note" } },
       { "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } } ] }
   (orchestrator fills items.)

3. answer — anything else. Output:
   { "intent": "answer", "template": "reader", "context": "Answer", "title": "<short>",
     "body": "<concise spoken-friendly answer; markdown OK — bullets, tables, code blocks, **bold**, *italic*, \`inline code\`, > quotes, links — supported>",
     "actions_taken": [
       /* OPTIONAL. Include only when you actually performed operations on the user's behalf.
          Each entry is one of:
          { "kind": "created",  "label": "<file or thing>" }
          { "kind": "edited",   "count": <int>, "items": ["<file1>", "<file2>"] }   // or "label" for a single edit
          { "kind": "deleted",  "label": "<file>" }
          { "kind": "ran",      "label": "<command or task>", "result": "<short summary>" }
          { "kind": "read",     "label": "<file>" }
          { "kind": "searched", "label": "<query>" }
          Omit the field entirely when nothing material happened. */
     ],
     "actions": [{ "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } }] }

4. delegate — only when the task is plainly outside your role and would be better handled by a specific teammate (e.g. engineer wanting QA to write tests, PM punting code questions to engineer). Use sparingly. Output:
   { "intent": "delegate", "to_role": "<roleId from team>", "task": "<one sentence task for the teammate>",
     "context": "Delegating", "title": "Routing to <role label>",
     "body": "<short note for the user explaining why>",
     "actions": [{ "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } }] }

Rules: single JSON object. No markdown, no commentary. "body" is read aloud — keep speakable. Allowed glyphs: cross | circle | square | triangle.`;
}

/* Reasoning-effort tiers → OpenRouter `reasoning` budgets. Using max_tokens (vs
 * `effort`) lets us offer 5 granular tiers; OpenRouter normalizes the budget to
 * each provider's mechanism, and non-reasoning models simply ignore it. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'extra', 'max'];
const EFFORT_BUDGET = { low: 1024, medium: 4096, high: 8192, extra: 16384, max: 32768 };

/* Build the per-request sampling overrides from the user's chosen reasoning
 * effort plus the redo count. The manual effort sets the reasoning budget; each
 * consecutive redo raises temperature (variety) AND bumps the effort a tier
 * (quality). top_p / max_tokens stay at their defaults. */
function samplingFor({ effort, regenerate }) {
  let lvl = EFFORT_LEVELS.indexOf(effort);
  if (lvl < 0) lvl = 1;                       // default: medium
  const out = {};
  const n = Math.max(0, Number(regenerate) || 0);
  if (n > 0) {
    out.temperature = Math.min(1.1, 0.7 + 0.2 * n);   // 0.9, 1.1, 1.1 …
    lvl = Math.min(EFFORT_LEVELS.length - 1, lvl + n); // each redo → one tier up
  }
  out.reasoning = { max_tokens: EFFORT_BUDGET[EFFORT_LEVELS[lvl]] };
  return out;
}

export async function interpretIntent({ projectId, agentId, text, sharedFrom, regenerate = 0, effort = 'medium' }) {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const agent = project.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  appendTurn(agentId, 'user', text);

  // v2 status: agent is reading context, evaluating inputs.
  emitStatus(projectId, agentId, 'analyzing');

  if (!apiKey || apiKey.includes('replace-me')) {
    const spec = fallbackSpec(text, 'OPENROUTER_API_KEY missing — using local classifier.');
    emitStatus(projectId, agentId, 'idle');
    return hydrateSpec(spec, { project, agent, text });
  }
  // Try streaming a prose answer (tokens pushed live over the event bus).
  // Anything unexpected falls through to the structured JSON tile path below,
  // so the worst case is exactly today's behavior.
  try {
    const streamed = await tryStreamProseAnswer({ projectId, agentId, project, agent, apiKey, text, sharedFrom, regenerate, effort });
    if (streamed) { emitStatus(projectId, agentId, 'idle'); return streamed; }
  } catch (err) {
    console.warn('[stream] falling back to JSON tile path:', err?.message);
  }

  const model = getModelForRole(agent.role);

  const history = getContext(agentId).messages.slice(0, -1);
  const messages = [
    { role: 'system', content: systemPrompt({ project, agent, sharedFrom }) },
    ...history,
    { role: 'user', content: text },
  ];

  try {
    // v2 status: producing tokens.
    emitStatus(projectId, agentId, 'drafting');
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost/aurora-bridge',
        'X-Title': `Bridge - ${agent.name}`,
      },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages, ...samplingFor({ effort, regenerate }) }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    appendTurn(agentId, 'assistant', raw);
    const spec = parseSpec(raw);
    emitActivity(projectId, `${agent.name}: ${spec?.title || spec?.intent || 'replied'}`, agentId);
    return hydrateSpec(spec, { project, agent, text });
  } finally {
    emitStatus(projectId, agentId, 'idle');
  }
}

function parseSpec(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('model did not return JSON');
  }
}

/* ---------- streamed prose answers ----------
 * For plain "answer the question" intents we stream a prose reply token-by-token
 * (pushed over the event bus) instead of waiting on a full JSON tile. Action
 * intents (note/list/compose/…) still use the structured path. */

/* Role + charter, but instruct a direct prose reply (no JSON tile spec). */
function proseSystemPrompt({ project, agent, sharedFrom }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project.id, agent.role);
  const topo = project.topology ? TOPOLOGIES[project.topology] : null;
  const topoLine = topo ? `\nTeam operating model — ${topo.label}: ${topo.rule}\n` : '';
  const sharedBlock = (Array.isArray(sharedFrom) && sharedFrom.length)
    ? `\nContext shared with you by teammates:\n` +
      sharedFrom.map(s => `- ${s.fromAgentName} (${s.fromRole}): "${String(s.snippet).slice(0, 240)}"`).join('\n') + '\n'
    : '';
  return `You are ${agent.name}, the ${role.label} on project "${project.name}". Project goal: "${project.goal}".

Your charter for this project:
---
${charter}
---
${topoLine}${sharedBlock}
Stay in role and on-goal. Answer the user directly in clear, concise prose — first person where natural. Do NOT return JSON, tile specs, or code fences unless you're quoting actual code.`;
}

/* Cheap router-model classification: ANSWER (prose) vs ACTION (tile). Defaults
 * to 'action' on any doubt, so action intents always get the structured path. */
async function classifyIntent({ apiKey, text }) {
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getRouterModel(),
        max_tokens: 4,
        messages: [
          { role: 'system', content: 'Classify the user message. Reply with ONE word only: ANSWER if they want a prose answer or explanation, or ACTION if they want to save a note, list things, compose/edit content, or perform an action.' },
          { role: 'user', content: String(text).slice(0, 600) },
        ],
      }),
    });
    if (!r.ok) return 'action';
    const d = await r.json();
    const w = (d?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return w.startsWith('answer') ? 'answer' : 'action';
  } catch { return 'action'; }
}

/* Stream a chat completion, invoking onDelta(text) per content chunk. Returns
 * the full accumulated text. Throws on a non-OK / bodyless response. */
async function streamOpenRouter({ apiKey, model, messages, onDelta, extra }) {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost/bridge',
      'X-Title': 'Bridge',
    },
    body: JSON.stringify({ model, stream: true, messages, ...(extra || {}) }),
  });
  if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* keepalive / partial line */ }
    }
  }
  return full;
}

/* Returns a hydrated 'reader' spec on success, or null to defer to the JSON
 * tile path (action intents, empty output, or classify failure). */
async function tryStreamProseAnswer({ projectId, agentId, project, agent, apiKey, text, sharedFrom, regenerate = 0, effort = 'medium' }) {
  if (await classifyIntent({ apiKey, text }) !== 'answer') return null;
  emitStatus(projectId, agentId, 'drafting');
  const history = getContext(agentId).messages.slice(0, -1);
  const messages = [
    { role: 'system', content: proseSystemPrompt({ project, agent, sharedFrom }) },
    ...history,
    { role: 'user', content: text },
  ];
  const full = await streamOpenRouter({
    apiKey,
    model: getModelForRole(agent.role),
    messages,
    extra: samplingFor({ effort, regenerate }),
    onDelta: (d) => emitToken(projectId, agentId, d),
  });
  if (!full || !full.trim()) return null;
  appendTurn(agentId, 'assistant', full);
  emitActivity(projectId, `${agent.name}: replied`, agentId);
  return hydrateSpec({ intent: 'answer', template: 'reader', context: '', title: '', body: full, streamed: true },
    { project, agent, text });
}

function hydrateSpec(spec, { project, text }) {
  if (spec.intent === 'list_notes') {
    spec.items = listNotes(project.id).map(n => ({ id: n.id, label: n.label }));
    if (spec.items.length === 0) {
      return {
        intent: 'answer', template: 'reader',
        context: 'Your notes', title: 'No notes yet',
        body: "You haven't saved any notes yet. Try saying: take a note, followed by what you want to remember.",
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      };
    }
  }
  spec._intentText = text;
  return spec;
}

function fallbackSpec(text, note) {
  const t = text.toLowerCase();
  if (/^(take a note|note|remember|jot|write down)/.test(t)) {
    const body = text.replace(/^(take a note[:,]?|note[:,]?|remember(?: that)?|jot(?: down)?|write down)\s*/i, '').trim() || text;
    return {
      intent: 'take_note', template: 'compose',
      context: 'New note', title: 'Save this note?', body,
      actions: [
        { verb: 'Save',   glyph: 'cross',  action: { type: 'save_note' } },
        { verb: 'Cancel', glyph: 'circle', action: { type: 'cancel' } },
      ],
      _intentText: text, _note: note,
    };
  }
  if (/(show|read|list|see).*(note|notes)/.test(t) || /^notes$/.test(t)) {
    return {
      intent: 'list_notes', template: 'list',
      context: 'Your notes', title: 'Pick a note to read',
      actions: [
        { verb: 'Open', glyph: 'cross',  action: { type: 'open_note' } },
        { verb: 'Back', glyph: 'circle', action: { type: 'cancel' } },
      ],
    };
  }
  return {
    intent: 'answer', template: 'reader',
    context: 'Answer', title: 'Bridge is offline',
    body: note + ' I need an API key to answer free-form questions. Try: "take a note" or "show my notes".',
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    _intentText: text, _note: note,
  };
}
