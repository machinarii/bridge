import { listNotes } from './backends/notes.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getProject } from './projects.js';
import { readProjectCharter } from './charters.js';
import { getRole } from './roles.js';
import { getModelForRole } from './models.js';
import { emitStatus, emitActivity } from './events.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* Tile-spec contract is unchanged from Aurora MVP — see prior README. */

function systemPrompt({ project, agent, sharedFrom }) {
  const role = getRole(agent.role);
  const charter = readProjectCharter(project.id, agent.role);
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
${sharedBlock}
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
     "body": "<concise spoken-friendly answer>",
     "actions": [{ "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } }] }

4. delegate — only when the task is plainly outside your role and would be better handled by a specific teammate (e.g. engineer wanting QA to write tests, PM punting code questions to engineer). Use sparingly. Output:
   { "intent": "delegate", "to_role": "<roleId from team>", "task": "<one sentence task for the teammate>",
     "context": "Delegating", "title": "Routing to <role label>",
     "body": "<short note for the user explaining why>",
     "actions": [{ "verb": "Back", "glyph": "circle", "action": { "type": "cancel" } }] }

Rules: single JSON object. No markdown, no commentary. "body" is read aloud — keep speakable. Allowed glyphs: cross | circle | square | triangle.`;
}

export async function interpretIntent({ projectId, agentId, text, sharedFrom }) {
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
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages }),
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
