// app/server/schema.js
/* Shared JSON extraction + validation helpers for model outputs.
 * Keeps response-shape handling consistent across orchestrator, team routing,
 * and team-review question generation. */

function parseJsonLoose(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

function toArray(v) { return Array.isArray(v) ? v : []; }

function pickGlyph(v, fallback = 'circle') {
  const g = String(v || '').trim();
  return ['cross', 'circle', 'square', 'triangle'].includes(g) ? g : fallback;
}

function sanitizeActions(actions) {
  return toArray(actions).map((a) => ({
    verb: String(a?.verb || '').trim() || 'Back',
    glyph: pickGlyph(a?.glyph),
    action: (a && typeof a.action === 'object') ? a.action : { type: 'cancel' },
  }));
}

function sanitizeChoices(choices) {
  const out = toArray(choices)
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return out.length ? out : null;
}

export function validateTileSpec(raw) {
  const obj = parseJsonLoose(raw);
  if (!obj || typeof obj !== 'object') return null;

  const intent = String(obj.intent || '').trim();
  if (!intent) return null;

  const out = {
    intent,
    template: String(obj.template || (intent === 'list_notes' ? 'list' : 'reader')).trim() || 'reader',
    context: String(obj.context || '').trim(),
    title: String(obj.title || '').trim(),
    body: String(obj.body || '').trim(),
  };

  const choices = sanitizeChoices(obj.choices);
  if (choices) out.choices = choices;

  const actions = sanitizeActions(obj.actions);
  if (actions.length) out.actions = actions;

  if (intent === 'delegate') {
    const toRole = String(obj.to_role || '').trim();
    const task = String(obj.task || '').trim();
    if (!toRole || !task) return null;
    out.to_role = toRole;
    out.task = task.slice(0, 400);
    out.template = out.template || 'reader';
  }

  if (intent === 'take_note') {
    if (!out.body) return null;
    out.template = 'compose';
  }

  if (intent === 'list_notes') {
    out.template = 'list';
  }

  return out;
}

export function validateRouting(raw, {
  sharedFromMax = 3,
  sharedSnippetMax = 240,
} = {}) {
  const obj = parseJsonLoose(raw);
  if (!obj || typeof obj !== 'object') return null;

  const assignments = toArray(obj.assignments).map((a) => {
    const shared = toArray(a?.sharedFrom)
      .slice(0, sharedFromMax)
      .map((s) => ({
        fromAgentName: String(s?.fromAgentName || '').slice(0, 40),
        fromRole: String(s?.fromRole || '').slice(0, 40),
        snippet: String(s?.snippet || '').slice(0, sharedSnippetMax),
      }))
      .filter((s) => s.snippet);
    return {
      agentId: String(a?.agentId || '').trim(),
      task: String(a?.task || '').trim(),
      ...(shared.length ? { sharedFrom: shared } : {}),
    };
  }).filter((a) => a.agentId && a.task);

  return {
    assignments,
    summary_intent: String(obj.summary_intent || '').trim(),
  };
}

export function validateReviewQuestion(raw) {
  const obj = parseJsonLoose(raw);
  if (!obj || typeof obj !== 'object') return null;
  const q = String(obj.question || '').trim();
  if (!q) return null;
  const options = toArray(obj.options)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return { q, options };
}

// Ask the model to repair malformed JSON into the expected shape. This is used
// only as a targeted retry after a failed parse/validation.
export function repairPrompt({ kind, raw }) {
  const body = String(raw || '').slice(0, 6000);
  if (kind === 'tile') {
    return (
      'Rewrite the following assistant output as exactly one valid JSON object for a Bridge tile spec. ' +
      'No markdown, no prose. Preserve intent and meaning. Allowed intent values: take_note, list_notes, answer, delegate.\n\n' +
      body
    );
  }
  if (kind === 'routing') {
    return (
      'Rewrite the following output as valid JSON: {"assignments":[{"agentId":"...","task":"...","sharedFrom":[{"fromAgentName":"...","fromRole":"...","snippet":"..."}]}],"summary_intent":"..."}. ' +
      'No prose or markdown.\n\n' + body
    );
  }
  if (kind === 'review_question') {
    return (
      'Rewrite the following output as valid JSON: {"question":"...","options":["...","..."]}. ' +
      'No prose or markdown.\n\n' + body
    );
  }
  return body;
}
