/* Council — ask one question to three different LLMs ("members"), BLIND and
 * SEQUENTIAL (no member ever sees another's answer), then a chairman model
 * synthesizes one recommendation. A PM intake step gathers context first by
 * asking the user up to a few single-select clarifying questions.
 *
 * Inspired by karpathy/llm-council. The pure helpers take injectable LLM
 * callers (callText / callJSON) so the orchestration is unit-testable without
 * the network — mirroring kickoff.js. Routes in server.js stay thin. */

import { callOpenRouterText, callOpenRouterJSON } from './llm.js';
import { getModelForRole } from './models.js';

// Three diverse, problem-solving models no other agent uses (agents default to
// claude-opus-4.8; the router uses claude-haiku-4.5). xAI/grok is omitted by
// default — it 404s on accounts whose OpenRouter data policy disallows xAI.
const DEFAULT_COUNCIL_MODELS = ['openai/gpt-5.1', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1'];
const INTAKE_MAX = 3;
const MEMBER_TIMEOUT_MS = 90_000;

/** User-defined custom instructions (Settings → Instructions). Empty by default. */
export function aiInstructionsBlock() {
  const ins = (process.env.AI_INSTRUCTIONS || '').trim();
  return ins ? `\n\nAdditional user instructions (always follow):\n${ins}` : '';
}

/** Resolved council members: persisted setting, else the defaults (always 3). */
export function getCouncilModels() {
  let arr = [];
  try {
    const v = JSON.parse(process.env.OPENROUTER_COUNCIL_MODELS || 'null');
    if (Array.isArray(v)) arr = v.filter(Boolean);
  } catch { /* ignore malformed setting */ }
  return [0, 1, 2].map((i) => arr[i] || DEFAULT_COUNCIL_MODELS[i]);
}

/* ── PM intake ────────────────────────────────────────────────────────────
 * Before the council answers, the PM asks at most INTAKE_MAX single-select
 * clarifying questions — only the context that would actually change the
 * recommendation. The user answers each (clickable options) and the answers
 * are folded into the brief every member + the chairman receives. */

export function intakePrompt(question) {
  return (
    `You are the project manager preparing a question for an advisory council of experts. ` +
    `Before they answer, gather only the missing context that would genuinely change their recommendation. ` +
    `Produce at most ${INTAKE_MAX} short clarifying questions, each with 3-4 concise, mutually-exclusive answer options. ` +
    `Ask fewer — or none — if the question is already clear. Never ask for information the user already gave. ` +
    `Return JSON exactly: {"questions":[{"q":"<question>","options":["<option>","<option>","<option>"]}]}.` +
    `${aiInstructionsBlock()}\n\nUser question:\n${question}`
  );
}

/** Coerce a model's intake reply (object or JSON string) into clean questions. */
export function normalizeIntake(raw) {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { obj = null; } }
  const qs = Array.isArray(obj?.questions) ? obj.questions : [];
  return qs
    .map((q) => ({
      q: String(q?.q || '').trim(),
      options: (Array.isArray(q?.options) ? q.options : [])
        .map((o) => String(o).trim()).filter(Boolean).slice(0, 4),
    }))
    .filter((q) => q.q && q.options.length >= 2)
    .slice(0, INTAKE_MAX);
}

export async function buildIntake({ question, apiKey, callJSON } = {}) {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  const call = callJSON || callOpenRouterJSON;
  const raw = await call({ apiKey: key, model: getModelForRole('pm'), prompt: intakePrompt(String(question || '').trim()) });
  return normalizeIntake(raw);
}

/** Fold the PM's gathered answers into a context block appended to each prompt. */
export function councilContext(answers) {
  const list = (Array.isArray(answers) ? answers : [])
    .map((a) => ({ q: String(a?.q || '').trim(), a: String(a?.a || '').trim() }))
    .filter((a) => a.q && a.a);
  if (!list.length) return '';
  return '\n\nContext gathered by the PM:\n' + list.map(({ q, a }) => `- ${q} → ${a}`).join('\n');
}

/* ── Members (blind & sequential) ─────────────────────────────────────────
 * Each member answers from the question + PM context ONLY — never another
 * member's answer. The server calls askMember once per index, in turn. */

export function memberPrompt({ question, context }) {
  return (
    `You are an expert member of an advisory council convened to solve a problem. ` +
    `Give your single best, well-reasoned answer to the question below. Be concrete and decisive; ` +
    `use markdown (headings, bullets, code) where it helps. Depth over length.` +
    `${aiInstructionsBlock()}\n\nQuestion:\n${question}${context || ''}`
  );
}

export async function askMember({ apiKey, model, question, context, callText } = {}) {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  const call = callText || callOpenRouterText;
  const content = await call({ apiKey: key, model, prompt: memberPrompt({ question, context }), timeoutMs: MEMBER_TIMEOUT_MS });
  return { model, content: content || '', error: content ? null : 'No response' };
}

/* ── Chairman synthesis ───────────────────────────────────────────────────*/

export function chairPrompt({ question, context, members }) {
  const answered = (members || []).filter((m) => m && m.content);
  const combined = answered.map((m, i) => `### Member ${i + 1} (${m.model})\n${m.content}`).join('\n\n');
  return (
    `You are the chairman of an advisory council. ${answered.length} members answered the question below. ` +
    `Synthesize their answers into one clear, decisive recommendation: note where they agree, resolve where ` +
    `they disagree (say which view is stronger and why), and end with a concise "Recommendation". Use markdown.` +
    `${aiInstructionsBlock()}\n\nQuestion:\n${question}${context || ''}\n\nMember answers:\n${combined}`
  );
}

export async function synthesize({ apiKey, model, question, context, members, callText } = {}) {
  const answered = (members || []).filter((m) => m && m.content);
  const chair = model || getCouncilModels()[0];
  if (!answered.length) return { model: chair, content: '' };
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  const call = callText || callOpenRouterText;
  const content = await call({ apiKey: key, model: chair, prompt: chairPrompt({ question, context, members: answered }), timeoutMs: MEMBER_TIMEOUT_MS });
  return { model: chair, content: content || '' };
}
