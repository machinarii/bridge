/* Bridge v2 event bus.
 *
 * Single source of truth for live multi-agent activity. Modules
 * (orchestrator, team driver, projects, autosave) call publish()
 * with a typed event; the SSE /events route fans them out to every
 * connected renderer client.
 *
 * Event shapes:
 *   { type: 'status',       projectId, agentId, verb: 'idle'|'drafting'|'analyzing'|'waiting' }
 *   { type: 'token',        projectId, agentId, delta }
 *   { type: 'tool',         projectId, agentId, name, args, result? }
 *   { type: 'delegate',     projectId, fromAgentId, toAgentId, task }
 *   { type: 'activity',     projectId, agentId?, summary }   // feed entries
 *   { type: 'notification', projectId?, kind, title, body, actionable?, requiresApproval? }
 *   { type: 'note_added',   projectId, noteId, body }
 *
 * All events get a server-side `at: Date.now()` and a monotonic `id`
 * stamped on the way out so renderers can dedupe / replay.
 */

let _nextId = 1;
const subscribers = new Set(); // each: { projectId | null, write(ev) }

/** publish(event) — broadcast to every interested subscriber. */
export function publish(event) {
  if (!event || typeof event !== 'object') return;
  const out = { id: _nextId++, at: Date.now(), ...event };
  for (const sub of subscribers) {
    // null projectId on the subscriber means "all projects"; otherwise
    // only forward events for that project (or project-less ones).
    if (sub.projectId && out.projectId && sub.projectId !== out.projectId) continue;
    try { sub.write(out); } catch { /* the SSE route handles cleanup */ }
  }
}

/** subscribe(projectId, write) — register an SSE writer. Returns
 *  an unsubscribe fn. projectId === null means "all projects". */
export function subscribe(projectId, write) {
  const sub = { projectId: projectId || null, write };
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

/** Convenience helpers used by the orchestrator + team driver so
 *  callers don't have to remember the exact event shape. */
export function emitStatus(projectId, agentId, verb) {
  publish({ type: 'status', projectId, agentId, verb });
}
export function emitToken(projectId, agentId, delta) {
  publish({ type: 'token', projectId, agentId, delta });
}
export function emitActivity(projectId, summary, agentId, extra) {
  publish({ type: 'activity', projectId, agentId, summary, ...(extra || {}) });
}
export function emitDelegate(projectId, fromAgentId, toAgentId, task) {
  publish({ type: 'delegate', projectId, fromAgentId, toAgentId, task });
}
export function emitNotification(opts) {
  publish({ type: 'notification', ...opts });
}
