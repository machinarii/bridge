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

// Recent Activity-feed events (activity + delegate only) kept for backfill, so a
// freshly-connected or reloaded client isn't blank — SSE has no history of its
// own. Status/token/note events are live-only and NOT buffered.
const FEED_BUFFER = [];
const FEED_BUFFER_MAX = 200;

/** publish(event) — broadcast to every interested subscriber. */
export function publish(event) {
  if (!event || typeof event !== 'object') return;
  const out = { id: _nextId++, at: Date.now(), ...event };
  if (out.type === 'activity' || out.type === 'delegate') {
    FEED_BUFFER.push(out);
    if (FEED_BUFFER.length > FEED_BUFFER_MAX) FEED_BUFFER.shift();
  }
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
  // Backfill the recent feed (chronological) so the client's Activity panel is
  // populated on connect. Flagged backfill:true so the renderer only feeds the
  // panel and skips live side effects (notifications, zoom refresh). Each event
  // keeps its id so the renderer dedupes on reconnect.
  for (const ev of FEED_BUFFER) {
    if (sub.projectId && ev.projectId && sub.projectId !== ev.projectId) continue;
    try { write({ ...ev, backfill: true }); } catch { /* route handles cleanup */ }
  }
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

/** Test/diagnostic helper: the current feed-buffer length. */
export function _feedBufferSize() { return FEED_BUFFER.length; }

// Live per-agent status verbs (non-idle only), so a freshly-loaded client can
// rehydrate "who's working right now" — SSE has no history and status events
// are deliberately not buffered. A server restart clears this, which is
// correct: in-flight turns die with the process, so nobody is working.
const LIVE_STATUS = new Map();   // projectId → Map(agentId → verb)

/** Current non-idle verbs for a project: { [agentId]: verb }. */
export function statusSnapshot(projectId) {
  const m = LIVE_STATUS.get(projectId);
  const out = {};
  if (m) for (const [agentId, verb] of m) out[agentId] = verb;
  return out;
}

/** Convenience helpers used by the orchestrator + team driver so
 *  callers don't have to remember the exact event shape. */
export function emitStatus(projectId, agentId, verb) {
  if (projectId && agentId) {
    if (!verb || verb === 'idle') {
      LIVE_STATUS.get(projectId)?.delete(agentId);
    } else {
      let m = LIVE_STATUS.get(projectId);
      if (!m) { m = new Map(); LIVE_STATUS.set(projectId, m); }
      m.set(agentId, verb);
    }
  }
  publish({ type: 'status', projectId, agentId, verb });
}
export function emitToken(projectId, agentId, delta) {
  publish({ type: 'token', projectId, agentId, delta });
}
export function emitActivity(projectId, summary, agentId, extra) {
  publish({ type: 'activity', projectId, agentId, summary, ...(extra || {}) });
}
export function emitDelegate(projectId, fromAgentId, toAgentId, task, extra) {
  publish({ type: 'delegate', projectId, fromAgentId, toAgentId, task, ...(extra || {}) });
}
export function emitNotification(opts) {
  publish({ type: 'notification', ...opts });
}
