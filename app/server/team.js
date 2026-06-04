/* Bridge — team voice pipeline.
 *
 * pipeline(project, userText, opts) →
 *    { routing: {assignments, summary_intent},
 *      perAgent: { [agentId]: spec },
 *      summary: spec }
 */

import { getProject, TOPOLOGIES } from './projects.js';
import { getRole } from './roles.js';
import { interpretIntent, RESPONSE_STYLE } from './orchestrator.js';
import { appendTurn, getContext } from './scratchpad.js';
import { getModelForRole, getDefaultModel, getRouterModel } from './models.js';
import { emitStatus, emitActivity, emitDelegate, emitNotification } from './events.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FANOUT_CAP = 5;
const ROUTING_TIMEOUT_MS = 20_000;
const SYNTHESIS_TIMEOUT_MS = 20_000;
const ASSIGNEE_TIMEOUT_MS = 20_000;

const SHARED_FROM_MAX = 3;
const SHARED_SNIPPET_MAX_CHARS = 240;
const DIGEST_MAX_CHARS = 120;
const MAX_DELEGATION_DEPTH = 3;

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

export async function runTeamVoice({ projectId, text, effort = 'medium' }) {
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
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  const leadModel = getModelForRole(lead.role);
  const others = project.agents.filter(a => a.id !== lead.id && a.enabled);

  const rosterWithDigest = others.map(a =>
    `- ${a.name} (${getRole(a.role).label}) [id:${a.id}] — last work: ${digestLineFor(a)}`
  ).join('\n');
  const topo = project.topology ? TOPOLOGIES[project.topology] : null;
  const topoBlock = topo
    ? `Team operating model — ${topo.label}: ${topo.rule}\n` +
      `Route work to honor this operating model when choosing who to assign and whether teammates should coordinate or report back to you.\n\n`
    : '';
  const routingPrompt =
    `You are ${lead.name}, lead of project "${project.name}". The project goal is: "${project.goal}".\n\n` +
    topoBlock +
    `Active team:\n${rosterWithDigest || '(no other agents)'}\n\n` +
    `The user said: "${text}".\n\n` +
    `Return a single JSON object: ` +
    `{"assignments":[{"agentId":"...","task":"...","sharedFrom":[{"fromAgentName":"...","fromRole":"...","snippet":"..."}]}],"summary_intent":"..."}. ` +
    `The sharedFrom field is OPTIONAL per assignment — include it only when another teammate's "last work" line above gives useful context for this task. ` +
    `Max ${SHARED_FROM_MAX} sharedFrom entries per assignment; each snippet ≤ ${SHARED_SNIPPET_MAX_CHARS} characters. ` +
    `Use exact agent ids from the roster. Assign only agents whose role applies. Maximum ${FANOUT_CAP} assignments. ` +
    `If no one applies, return assignments:[] and put your direct answer in summary_intent.`;

  appendTurn(lead.id, 'user', `[team-voice] ${text}`);
  emitStatus(projectId, lead.id, 'analyzing');
  emitActivity(projectId, `${lead.name}: routing "${text.slice(0, 60)}"`, lead.id);
  const routingRaw = await callOpenRouterJSON({ apiKey, model: getRouterModel(), prompt: routingPrompt, timeoutMs: ROUTING_TIMEOUT_MS });
  const routing = parseRoutingOutput(routingRaw);
  const { kept, dropped } = applyCostCap(routing.assignments, FANOUT_CAP);
  if (dropped.length) console.log(`[team] cost cap dropped ${dropped.length} assignments`);

  /* perAgent records the final (terminal) spec from each agent that
   * contributed. delegationLog captures every hop for telemetry. */
  const perAgent = {};
  const delegationLog = [];

  /* Resolve a single assignment, following any delegate hops up to the
   * depth limit. Returns the terminal spec (intent != 'delegate'). */
  async function runWithDelegation(asg, depth) {
    try {
      const spec = await Promise.race([
        interpretIntent({
          projectId,
          agentId: asg.agentId,
          text: asg.task,
          sharedFrom: asg.sharedFrom,
          effort,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('assignee timeout')), ASSIGNEE_TIMEOUT_MS)),
      ]);
      perAgent[asg.agentId] = spec;

      if (spec?.intent !== 'delegate') return spec;
      if (depth >= MAX_DELEGATION_DEPTH) {
        console.warn(`[team] delegation depth ${depth} hit; halting chain`);
        return spec;
      }
      const toRoleId = String(spec.to_role || '').trim();
      const target = project.agents.find(a => a.role === toRoleId && a.enabled);
      const fromAgent = project.agents.find(a => a.id === asg.agentId);
      if (!target) {
        console.warn(`[team] delegate to ${toRoleId} failed: no enabled agent for that role`);
        return spec;
      }
      const newTask = String(spec.task || asg.task).slice(0, 400);
      delegationLog.push({
        depth,
        fromAgentId: asg.agentId, fromRole: fromAgent?.role,
        toAgentId: target.id, toRole: target.role,
        task: newTask,
      });
      emitDelegate(projectId, asg.agentId, target.id, newTask);
      // v2 §4: leave a "handoff" system turn in both agents' chat
      // histories so the delegation shows up as a distinct bubble at
      // L2 on either side of the chain.
      const handoff = JSON.stringify({
        kind: 'handoff',
        from: fromAgent?.name || asg.agentId,
        to:   target.name || target.id,
        fromRole: getRole(fromAgent?.role)?.label || '',
        toRole:   getRole(target.role)?.label || '',
        task: newTask,
      });
      appendTurn(asg.agentId, 'system', handoff);
      appendTurn(target.id,    'system', handoff);
      const nextAsg = {
        agentId: target.id,
        task: newTask,
        sharedFrom: [{
          fromAgentName: fromAgent?.name || '',
          fromRole: getRole(fromAgent?.role)?.label || '',
          snippet: (spec.body || '').slice(0, SHARED_SNIPPET_MAX_CHARS),
        }],
      };
      const childSpec = await runWithDelegation(nextAsg, depth + 1);
      // Group-chat view: surface the delegate's answer as a bubble in the
      // delegating agent's L2 chat, tagged with the delegate's identity so it
      // renders on the left under *their* name/role (not the host agent's).
      if (childSpec && (childSpec.body || childSpec.title)) {
        appendTurn(asg.agentId, 'assistant',
          JSON.stringify({ body: childSpec.body || childSpec.title }),
          { author: { id: target.id, name: target.name || target.id, role: getRole(target.role)?.label || '' } });
      }
      return childSpec;
    } catch (err) {
      console.warn(`[team] assignee ${asg.agentId} failed:`, err.message);
      perAgent[asg.agentId] = null;
      return null;
    }
  }

  await Promise.all(kept.map(asg => runWithDelegation(asg, 0)));

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
    `{"intent":"answer","template":"reader","context":"Team","title":"<short>","body":"<text>","actions":[{"verb":"Back","glyph":"circle","action":{"type":"cancel"}}]}` +
    RESPONSE_STYLE;
  emitStatus(projectId, lead.id, 'drafting');
  const synthRaw = await callOpenRouterJSON({ apiKey, model: leadModel, prompt: synthPrompt, timeoutMs: SYNTHESIS_TIMEOUT_MS });
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
  emitStatus(projectId, lead.id, 'idle');
  emitActivity(projectId, `${lead.name}: ${summary.title || 'team voice complete'}`, lead.id);
  emitNotification({
    kind: 'info',
    projectId,
    title: 'Team responded',
    body: `${lead.name}: ${summary.title || (summary.body || '').slice(0, 140) || 'Team voice complete.'}`,
  });

  return { routing: { assignments: kept, summary_intent: routing.summary_intent, dropped: dropped.length },
           perAgent, delegations: delegationLog, summary };
}

/* Resolve a delegate spec produced in a 1:1 (L2) chat. The team pipeline has
 * its own in-closure resolver (runWithDelegation); this is the standalone
 * entry point so a `delegate` intent from a direct agent chat actually routes
 * to a teammate instead of dead-ending. Mirrors the team path: writes a
 * handoff turn into both histories, emits the delegate event, runs the target,
 * follows further hops up to MAX_DELEGATION_DEPTH, and surfaces the teammate's
 * reply as a foreign-author bubble in the delegating agent's chat. Returns the
 * terminal (non-delegate) spec — the teammate's answer — or the original spec
 * when it can't resolve (e.g. no enabled agent of the requested role). */
export async function resolveDelegateSpec({ projectId, fromAgentId, spec, effort = 'high', depth = 0 }) {
  if (!spec || spec.intent !== 'delegate') return spec;
  if (depth >= MAX_DELEGATION_DEPTH) return spec;
  const project = getProject(projectId);
  if (!project) return spec;

  const toRoleId = String(spec.to_role || '').trim();
  const target = project.agents.find(a => a.role === toRoleId && a.enabled);
  const fromAgent = project.agents.find(a => a.id === fromAgentId);
  if (!target) {
    console.warn(`[delegate:1:1] to ${toRoleId} failed: no enabled agent for that role`);
    return spec;
  }
  const task = (String(spec.task || '').trim() || `Help with: ${spec.body || ''}`).slice(0, 400);

  const handoff = JSON.stringify({
    kind: 'handoff',
    from: fromAgent?.name || fromAgentId,
    to:   target.name || target.id,
    fromRole: getRole(fromAgent?.role)?.label || '',
    toRole:   getRole(target.role)?.label || '',
    task,
  });
  appendTurn(fromAgentId, 'system', handoff);
  appendTurn(target.id,    'system', handoff);
  emitDelegate(projectId, fromAgentId, target.id, task);

  const sharedFrom = [{
    fromAgentName: fromAgent?.name || '',
    fromRole: getRole(fromAgent?.role)?.label || '',
    snippet: (spec.body || '').slice(0, SHARED_SNIPPET_MAX_CHARS),
  }];
  let childSpec = await interpretIntent({ projectId, agentId: target.id, text: task, sharedFrom, effort });
  // follow any further delegate hops the teammate makes
  childSpec = await resolveDelegateSpec({ projectId, fromAgentId: target.id, spec: childSpec, effort, depth: depth + 1 });

  // Group-chat view: surface the teammate's answer in the delegating agent's
  // L2 chat, tagged with the teammate's identity.
  if (childSpec && (childSpec.body || childSpec.title)) {
    appendTurn(fromAgentId, 'assistant',
      JSON.stringify({ body: childSpec.body || childSpec.title }),
      { author: { id: target.id, name: target.name || target.id, role: getRole(target.role)?.label || '' } });
  }
  return childSpec;
}
