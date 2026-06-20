import { listNotes } from './backends/notes.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getProject, TOPOLOGIES } from './projects.js';
import { readProjectCharter } from './charters.js';
import { selectSkillsForTask, loadSkillPlaybook } from './skills.js';
import { getRole } from './roles.js';
import { getModelForRole, getRouterModel } from './models.js';
import { learningsBlock } from './learnings.js';
import { recordModelCall } from './metrics.js';
import { emitStatus, emitActivity, emitToken } from './events.js';
import { validateTileSpec, repairPrompt } from './schema.js';
import { throwIfCanceled } from './cancel.js';
import { callOpenRouterJSON } from './llm.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* Shared response voice + conduct for every agent. Injected into the tile-spec
 * and prose system prompts, and reused by the kickoff + team-synthesis prompts. */
export const RESPONSE_STYLE = `
## How you write
- Make thinking legible: state decision criteria early.
- Any list of 3+ items (per-person tasks, options, steps, findings) MUST be a markdown bullet list — never packed into one run-on sentence. Concise sentences otherwise; telegraphic style allowed — drop "the"/"a" to cut scan time. Fewer words = faster to scan.
- When prose runs long (roughly 4+ sentences) and isn't a list, break it into short paragraphs separated by a blank line — never one dense block of text.
- **Bold** for emphasis is fine. No italics (harder to read).
- Emoji only paired with text when delivering feedback on a result AND your confidence is ≥ 0.9. Never decoration.

## Never write (hard rule)
"In today's fast-paced world…", "In the ever-evolving landscape of…", "Great question!", "Certainly!"/"Absolutely!", "As an AI…", "unlock"/"unleash"/"supercharge"/"leverage" (as a verb), "game-changer"/"revolutionary"/"cutting-edge". Don't use em-dashes as every-other-sentence connectors.

## Avoid (strong tendency)
"I hope this helps", "Let me know if you need anything else", "It's important to note that…", "delve into"/"dive into", "That said,", "With that in mind,", opening a section with a rhetorical question.

## When direction is unclear or you need a decision
Don't guess. Offer 2-4 short labeled choices (A, B, C, D) and let the user pick. Put them in the answer spec's "choices" array (short strings, each starting with its letter); the user's pick becomes their next message.

## What you can actually do (grounding — hard rule)
You work entirely inside Bridge. Your only outputs are **markdown documents** and **code**, produced directly here in the conversation. You have NO access to external or visual tools (Figma, Sketch, design software), no chat channels, no email, no tickets, no internet, no repos you can't see.
- Never promise external artifacts or future hand-offs: no "I'll share a Figma link", no "I'll post it in the project channel", no "I'll tag the PM when it's ready", no "uploading to…".
- Never give ETAs, timelines, or deadlines ("2 days", "by Friday", "next sprint"). You produce the work now, in text — or state exactly what you need to proceed.
- Don't invent files, links, tools, or systems that don't exist. Do the actual work in this reply (write the doc, write the code), or ask a focused question.

## Conduct (hard rule)
No irreversible/destructive actions without confirmation. Never expose API keys, tokens, or credentials — not even as examples. Don't fabricate citations, library APIs, or function signatures; say when you're unsure. Don't claim work is done when it's partial or untested. Be correct over appearing helpful. For financial/legal/medical topics, include a disclaimer.
`;

/* Role-specific working guidance, injected into the system prompt. Grounds each
 * role in what it actually delivers inside Bridge (docs + code), not real-world
 * tools or hand-offs. */
const ROLE_GUIDANCE = {
  designer: `As the Designer you work in written documents and code — never visual-design tools (there is no Figma/Sketch in Bridge). Follow this sequence, and do NOT skip ahead:
1. Write the design foundation as a markdown doc: design principles, UI guidelines, creative direction, and system design. Then ask the user to confirm before continuing (offer choices if a direction is open).
2. After they confirm, write use cases and user flows as a markdown doc. Then ask the user to confirm.
3. Only once the full design documentation is complete and the user has reviewed it, build the GUI directly in code.
Never promise a Figma file, an external link, a channel post, or a delivery date.`,
};
function roleGuidance(roleId) {
  const g = ROLE_GUIDANCE[roleId];
  return g ? `\n${g}\n` : '';
}

/* Per-role skills section, task-aware. Skills the task text actually triggers
 * (keyword match in skills.js) inject their full vendored playbook — capped at
 * MAX_TASK_PLAYBOOKS so a keyword-rich message can't flood the prompt. All
 * other enabled role skills inject as a one-line capability, keeping the agent
 * aware of what it can do without the weight. With no task text, every
 * vendored playbook injects (pre-task-aware behavior). Disabled skills
 * (Settings → Skills) are omitted entirely. */
const MAX_TASK_PLAYBOOKS = 3;
function skillsBlock(roleId, taskText) {
  const { matched, all } = selectSkillsForTask(roleId, taskText);
  if (!all.length) return '';
  const expanded = (taskText ? matched : all)
    .map(s => ({ s, pb: loadSkillPlaybook(s.id) }))
    .filter(x => x.pb)
    .slice(0, taskText ? MAX_TASK_PLAYBOOKS : all.length);
  const expandedIds = new Set(expanded.map(x => x.s.id));
  const lines = all.filter(s => !expandedIds.has(s.id))
    .map(s => `- ${s.name}: ${s.description}`);
  const playbooks = expanded.map(x => `### Skill: ${x.s.name}\n${x.pb.trim()}`);
  return '\nYour skills — apply the relevant one when a task matches:\n' +
    (lines.length ? lines.join('\n') + '\n' : '') +
    (playbooks.length ? playbooks.join('\n\n') + '\n' : '');
}

/* Tile-spec contract is unchanged from Aurora MVP — see prior README. */

/* User-defined custom instructions (Settings → Instructions). Empty by default. */
function customInstructionsBlock() {
  const ins = (process.env.AI_INSTRUCTIONS || '').trim();
  return ins ? `\n\nAdditional user instructions (always follow):\n${ins}\n` : '';
}

function systemPrompt({ project, agent, sharedFrom, text }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project, agent.role);
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
${roleGuidance(agent.role)}${skillsBlock(agent.role, text)}${learningsBlock(project.id, agent.role)}${topoLine}${sharedBlock}
Stay in role and on-goal. Speak briefly, in first person when relevant. The user is talking to you specifically.${customInstructionsBlock()}
${RESPONSE_STYLE}

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
     "body": "<concise spoken-friendly answer; markdown OK — bullets, tables, code blocks, **bold**, \`inline code\`, > quotes, links — supported. No italics.>",
     "choices": ["A — <short option>", "B — <short option>"],   /* OPTIONAL: include 2-4 options when direction is unclear or you need the user to decide. The user picks one and it becomes their next message. Omit when not asking the user to choose. */
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
  if (lvl < 0) lvl = 2;                       // default: high reasoning
  const out = {};
  const n = Math.max(0, Number(regenerate) || 0);
  // Base temperature 0.8 for livelier, more varied phrasing; each redo nudges
  // it up further for more variety.
  out.temperature = Math.min(1.1, 0.8 + 0.2 * n);   // 0.8, 1.0, 1.1 …
  if (n > 0) {
    lvl = Math.min(EFFORT_LEVELS.length - 1, lvl + n); // each redo → one tier up
  }
  out.reasoning = { max_tokens: EFFORT_BUDGET[EFFORT_LEVELS[lvl]] };
  return out;
}

export async function interpretIntent({ projectId, agentId, text, sharedFrom, regenerate = 0, effort = 'high', handoff, cancelToken = null }) {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const agent = project.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  // A delegated task records as a From→To handoff turn (so it doesn't render as
  // the user's own "you" bubble). `text` is still the prompt for the model.
  if (handoff) {
    appendTurn(agentId, 'system', JSON.stringify({
      kind: 'handoff', from: handoff.from, fromRole: handoff.fromRole,
      to: handoff.to, toRole: handoff.toRole, task: text,
    }));
  } else {
    appendTurn(agentId, 'user', text);
  }

  // v2 status: agent is reading context, evaluating inputs.
  emitStatus(projectId, agentId, 'analyzing');
  throwIfCanceled(cancelToken);

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
    { role: 'system', content: systemPrompt({ project, agent, sharedFrom, text }) },
    ...history,
    { role: 'user', content: text },
  ];

  try {
    // v2 status: producing tokens. The software engineer's generation reads as
    // "Building" (it's writing code), everyone else as "Drafting".
    emitStatus(projectId, agentId, agent?.role === 'sw_engineer' ? 'building' : 'drafting');
    const t0 = Date.now();
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
      recordModelCall({ model, role: agent.role, kind: 'agent', latencyMs: Date.now() - t0, ok: false });
      throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    throwIfCanceled(cancelToken);
    recordModelCall({ model, role: agent.role, kind: 'agent', latencyMs: Date.now() - t0, usage: data?.usage, ok: true });
    const raw = data?.choices?.[0]?.message?.content || '';
    appendTurn(agentId, 'assistant', raw);
    let spec = validateTileSpec(raw) || parseSpec(raw);
    if (!validateTileSpec(raw)) {
      const repaired = await callOpenRouterJSON({
        apiKey,
        model: getRouterModel(),
        prompt: repairPrompt({ kind: 'tile', raw }),
        meta: { role: agent.role, kind: 'repair' },
      });
      spec = validateTileSpec(repaired) || spec;
    }
    // A reply with choices asks the user something → "Waiting for response";
    // otherwise it's a finished deliverable → "Task complete" (clears on view).
    const needsResponse = Array.isArray(spec?.choices) && spec.choices.length > 0;
    emitActivity(projectId, `${agent.name}: ${spec?.title || spec?.intent || 'replied'}`, agentId, { awaitKind: needsResponse ? 'reply' : 'view' });
    return hydrateSpec(spec, { project, agent, text });
  } finally {
    emitStatus(projectId, agentId, 'idle');
  }
}

/* Repair the most common LLM JSON defect: raw control characters (newlines,
 * tabs, carriage returns) inside string values — illegal in JSON, and exactly
 * what a model emits when it stuffs a wireframe / ASCII art / code block into a
 * "body" field. Walks the text and escapes control chars seen inside a string
 * literal, leaving structural whitespace untouched. */
function escapeControlCharsInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

/* Best-effort extraction of the "body" value from JSON we couldn't parse, so
 * rich content still reaches the user instead of being dropped. */
function lenientBody(cleaned) {
  const m = cleaned.match(/"body"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"\w+"\s*:|\}\s*$)/);
  if (m) return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  return cleaned;
}

function parseSpec(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // Try the text as-is, then with control chars escaped; for each, try a whole
  // parse and then a brace-bounded slice.
  for (const candidate of [cleaned, escapeControlCharsInStrings(cleaned)]) {
    try { return JSON.parse(candidate); } catch { /* try next strategy */ }
    const m = candidate.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* try next strategy */ } }
  }
  // Never throw: degrade to a plain answer so the model's content (e.g. a
  // wireframe) still renders rather than 500-ing the whole request.
  return {
    intent: 'answer', template: 'reader', context: '', title: '',
    body: lenientBody(cleaned),
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
  };
}

/* ---------- streamed prose answers ----------
 * For plain "answer the question" intents we stream a prose reply token-by-token
 * (pushed over the event bus) instead of waiting on a full JSON tile. Action
 * intents (note/list/compose/…) still use the structured path. */

/* Role + charter, but instruct a direct prose reply (no JSON tile spec). */
function proseSystemPrompt({ project, agent, sharedFrom, text }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project, agent.role);
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
${roleGuidance(agent.role)}${skillsBlock(agent.role, text)}${learningsBlock(project.id, agent.role)}${topoLine}${sharedBlock}
Stay in role and on-goal. Answer the user directly in clear, concise prose — first person where natural. Do NOT return JSON, tile specs, or code fences unless you're quoting actual code.${customInstructionsBlock()}
${RESPONSE_STYLE}`;
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
async function tryStreamProseAnswer({ projectId, agentId, project, agent, apiKey, text, sharedFrom, regenerate = 0, effort = 'high' }) {
  if (await classifyIntent({ apiKey, text }) !== 'answer') return null;
  emitStatus(projectId, agentId, agent?.role === 'sw_engineer' ? 'building' : 'drafting');
  const history = getContext(agentId).messages.slice(0, -1);
  const messages = [
    { role: 'system', content: proseSystemPrompt({ project, agent, sharedFrom, text }) },
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
  // Prose answer (no choices) → a finished deliverable: "Task complete" (clears
  // when the user views it; immediate no-op if they're already looking). The
  // activity summary carries a short snippet so the L0 feed reads usefully.
  const snippet = String(full).replace(/[#*_`>\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  emitActivity(projectId, `${agent.name}: ${snippet}`, agentId, { awaitKind: 'view' });
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
