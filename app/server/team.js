/* Bridge — team voice pipeline.
 *
 * pipeline(project, userText, opts) →
 *    { routing: {assignments, summary_intent},
 *      perAgent: { [agentId]: spec },
 *      summary: spec }
 */

import { getProject } from './projects.js';
import { getRole } from './roles.js';
import { interpretIntent } from './orchestrator.js';
import { appendTurn, getContext } from './scratchpad.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FANOUT_CAP = 5;
const ROUTING_TIMEOUT_MS = 20_000;
const SYNTHESIS_TIMEOUT_MS = 20_000;
const ASSIGNEE_TIMEOUT_MS = 20_000;

const SHARED_FROM_MAX = 3;
const SHARED_SNIPPET_MAX_CHARS = 240;
const DIGEST_MAX_CHARS = 120;

export function parseRoutingOutput(raw) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const obj = JSON.parse(cleaned);
  if (!obj || typeof obj !== 'object') throw new Error('routing not object');
  if (!Array.isArray(obj.assignments)) obj.assignments = [];
  for (const a of obj.assignments) {
    if (Array.isArray(a.sharedFrom)) {
      a.sharedFrom = a.sharedFrom.slice(0, SHARED_FROM_MAX).map(s => ({
        fromAgentName: String(s.fromAgentName || '').slice(0, 40),
        fromRole:      String(s.fromRole || '').slice(0, 40),
        snippet:       String(s.snippet || '').slice(0, SHARED_SNIPPET_MAX_CHARS),
      })).filter(s => s.snippet);
    } else {
      delete a.sharedFrom;
    }
  }
  return obj;
}

export function applyCostCap(assignments, cap = FANOUT_CAP) {
  const kept = assignments.slice(0, cap);
  const dropped = assignments.slice(cap);
  return { kept, dropped };
}

/** Build a per-agent digest line from scratchpad's lastSpec. */
export function digestLineFor(agent) {
  const ctx = getContext(agent.id);
  const last = ctx?.lastSpec;
  if (!last) return '—';
  const src = last.body || last.title || '';
  const t = String(src).replace(/\s+/g, ' ').trim();
  return t.slice(0, DIGEST_MAX_CHARS) || '—';
}

async function callOpenRouterJSON({ apiKey, model, prompt, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                 'HTTP-Referer': 'http://localhost/aurora-bridge', 'X-Title': 'Bridge - team' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' },
                             messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0,200)}`);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(t); }
}

export async function runTeamVoice({ projectId, text }) {
  const project = getProject(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('replace-me')) {
    return {
      blocked: true,
      reason: 'no_key',
      summary: {
        intent: 'answer', template: 'reader',
        context: 'Team voice',
        title: 'Team voice needs an API key',
        body: 'Add OPENROUTER_API_KEY to .env to use team voice. Single-agent prompts still work.',
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      },
    };
  }
  const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  const others = project.agents.filter(a => a.id !== lead.id && a.enabled);

  const rosterWithDigest = others.map(a =>
    `- ${a.name} (${getRole(a.role).label}) [id:${a.id}] — last work: ${digestLineFor(a)}`
  ).join('\n');
  const routingPrompt =
    `You are ${lead.name}, lead of project "${project.name}". The project goal is: "${project.goal}".\n\n` +
    `Active team:\n${rosterWithDigest || '(no other agents)'}\n\n` +
    `The user said: "${text}".\n\n` +
    `Return a single JSON object: ` +
    `{"assignments":[{"agentId":"...","task":"...","sharedFrom":[{"fromAgentName":"...","fromRole":"...","snippet":"..."}]}],"summary_intent":"..."}. ` +
    `The sharedFrom field is OPTIONAL per assignment — include it only when another teammate's "last work" line above gives useful context for this task. ` +
    `Max ${SHARED_FROM_MAX} sharedFrom entries per assignment; each snippet ≤ ${SHARED_SNIPPET_MAX_CHARS} characters. ` +
    `Use exact agent ids from the roster. Assign only agents whose role applies. Maximum ${FANOUT_CAP} assignments. ` +
    `If no one applies, return assignments:[] and put your direct answer in summary_intent.`;

  appendTurn(lead.id, 'user', `[team-voice] ${text}`);
  const routingRaw = await callOpenRouterJSON({ apiKey, model, prompt: routingPrompt, timeoutMs: ROUTING_TIMEOUT_MS });
  const routing = parseRoutingOutput(routingRaw);
  const { kept, dropped } = applyCostCap(routing.assignments, FANOUT_CAP);
  if (dropped.length) console.log(`[team] cost cap dropped ${dropped.length} assignments`);

  const perAgent = {};
  await Promise.all(kept.map(async (asg) => {
    try {
      const spec = await Promise.race([
        interpretIntent({
          projectId,
          agentId: asg.agentId,
          text: asg.task,
          sharedFrom: asg.sharedFrom,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('assignee timeout')), ASSIGNEE_TIMEOUT_MS)),
      ]);
      perAgent[asg.agentId] = spec;
    } catch (err) {
      console.warn(`[team] assignee ${asg.agentId} failed:`, err.message);
      perAgent[asg.agentId] = null;
    }
  }));

  const perAgentText = Object.entries(perAgent).map(([aid, spec]) => {
    const a = project.agents.find(x => x.id === aid);
    if (!a) return '';
    if (!spec) return `${a.name} (${getRole(a.role).label}): did not respond.`;
    return `${a.name} (${getRole(a.role).label}): ${spec.body || JSON.stringify(spec)}`;
  }).join('\n');

  const synthPrompt =
    `You are ${lead.name}. Project goal: "${project.goal}". The team replied to "${text}":\n${perAgentText || '(no assignees)'}\n` +
    `Compose a single response to the user that synthesizes their work. 1-3 sentences, spoken-friendly. ` +
    `Output the standard answer tile-spec JSON: ` +
    `{"intent":"answer","template":"reader","context":"Team","title":"<short>","body":"<text>","actions":[{"verb":"Back","glyph":"circle","action":{"type":"cancel"}}]}`;
  const synthRaw = await callOpenRouterJSON({ apiKey, model, prompt: synthPrompt, timeoutMs: SYNTHESIS_TIMEOUT_MS });
  let summary;
  try { summary = JSON.parse(synthRaw.trim().replace(/^```(?:json)?/i,'').replace(/```$/, '')); }
  catch {
    summary = {
      intent: 'answer', template: 'reader',
      context: 'Team', title: lead.name,
      body: routing.summary_intent || 'Team is on it.',
      actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    };
  }
  appendTurn(lead.id, 'assistant', summary.body || '');

  return { routing: { assignments: kept, summary_intent: routing.summary_intent, dropped: dropped.length },
           perAgent, summary };
}
