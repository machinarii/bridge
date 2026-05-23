import { listNotes } from './backends/notes.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are Bridge's intent interpreter. The user speaks or types one short instruction. Your job: classify the intent and return a single JSON object describing the tile surface to render. No prose. No code fences. JSON only.

There are exactly three intent kinds:

1. take_note — the user wants to save a note. Example: "take a note: buy milk", "remember that I parked on level 3".
   Output:
   {
     "intent": "take_note",
     "template": "compose",
     "context": "New note",
     "title": "Save this note?",
     "body": "<the extracted note text, cleaned of the leading verb>",
     "actions": [
       { "verb": "Save", "glyph": "A", "action": { "type": "save_note" } },
       { "verb": "Cancel", "glyph": "B", "action": { "type": "cancel" } }
     ]
   }

2. list_notes — the user wants to see or read their notes. Example: "show my notes", "read my notes", "what did I write down".
   Output:
   {
     "intent": "list_notes",
     "template": "list",
     "context": "Your notes",
     "title": "Pick a note to read",
     "actions": [
       { "verb": "Open", "glyph": "A", "action": { "type": "open_note" } },
       { "verb": "Back", "glyph": "B", "action": { "type": "cancel" } }
     ]
   }
   (Do NOT invent items — the orchestrator fills them.)

3. answer — anything that's a question or a quick utility ask. Example: "what's the capital of France", "convert 50 miles to km", "who wrote Dune".
   Output:
   {
     "intent": "answer",
     "template": "reader",
     "context": "Answer",
     "title": "<a short title for the answer, max 6 words>",
     "body": "<a concise, spoken-friendly answer, 1-3 sentences>",
     "actions": [
       { "verb": "Back", "glyph": "B", "action": { "type": "cancel" } }
     ]
   }

If the intent is unclear or doesn't fit, treat it as "answer" and respond helpfully.

Rules:
- Output a single JSON object. No markdown, no commentary.
- Keep "body" speakable — Bridge reads it aloud via TTS.
- Never include controller affordances inside body text; they live in "actions".`;

export async function interpretIntent(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return fallbackSpec(text, 'OPENROUTER_API_KEY missing — using local classifier.');
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost/bridge-prototype',
      'X-Title': 'Bridge Prototype',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const spec = parseSpec(raw);
  return hydrateSpec(spec, text);
}

function parseSpec(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('model did not return JSON');
  }
}

function hydrateSpec(spec, originalText) {
  if (spec.intent === 'list_notes') {
    spec.items = listNotes().map(n => ({ id: n.id, label: n.label }));
    if (spec.items.length === 0) {
      return {
        intent: 'answer',
        template: 'reader',
        context: 'Your notes',
        title: 'No notes yet',
        body: "You haven't saved any notes yet. Try saying: take a note, followed by what you want to remember.",
        actions: [{ verb: 'Back', glyph: 'B', action: { type: 'cancel' } }],
      };
    }
  }
  spec._intentText = originalText;
  return spec;
}

function fallbackSpec(text, note) {
  const t = text.toLowerCase();
  if (/^(take a note|note|remember|jot|write down)/.test(t)) {
    const body = text.replace(/^(take a note[:,]?|note[:,]?|remember(?: that)?|jot(?: down)?|write down)\s*/i, '').trim() || text;
    return {
      intent: 'take_note',
      template: 'compose',
      context: 'New note',
      title: 'Save this note?',
      body,
      actions: [
        { verb: 'Save', glyph: 'A', action: { type: 'save_note' } },
        { verb: 'Cancel', glyph: 'B', action: { type: 'cancel' } },
      ],
      _intentText: text,
      _note: note,
    };
  }
  if (/(show|read|list|see).*(note|notes)/.test(t) || /^notes$/.test(t)) {
    return hydrateSpec({
      intent: 'list_notes',
      template: 'list',
      context: 'Your notes',
      title: 'Pick a note to read',
      actions: [
        { verb: 'Open', glyph: 'A', action: { type: 'open_note' } },
        { verb: 'Back', glyph: 'B', action: { type: 'cancel' } },
      ],
    }, text);
  }
  return {
    intent: 'answer',
    template: 'reader',
    context: 'Answer',
    title: 'Bridge is offline',
    body: note + ' I need an API key to answer free-form questions. Try: "take a note" or "show my notes".',
    actions: [{ verb: 'Back', glyph: 'B', action: { type: 'cancel' } }],
    _intentText: text,
    _note: note,
  };
}
