# Bridge v2 — Cowork-style enhancements

A roadmap of upgrades that move Bridge from "one-agent-at-a-time chat
surface" → "team workspace where the user supervises multiple agents
working in parallel." Inspired by Claude Cowork's multi-agent model.

These are deliberately scoped to surface what the team is *already*
doing (via `team.runTeamVoice`, `delegate-and-resume`, scratchpad,
autosave) rather than re-architect the orchestrator.

---

## Architectural prerequisite

**Server-push event channel.** Most items below need the server to
notify the renderer asynchronously — not via per-request POST/response.
Add a single long-lived SSE channel:

```
GET /projects/:pid/events   →   text/event-stream
```

emitting typed events that the orchestrator and team driver publish to:

```js
{ type: 'status',  agentId, verb: 'drafting'|'analyzing'|'waiting'|'idle' }
{ type: 'token',   agentId, delta }
{ type: 'tool',    agentId, name, args, result? }
{ type: 'delegate', fromAgentId, toAgentId, task }
{ type: 'notification', kind, title, body, actionable, requiresApproval }
{ type: 'activity', agentId, summary }   // for feed entries
```

Everything below is a subscriber on this channel.

---

## 1. Live verb status on each agent tile

Replace the binary `Idle` / `Thinking…` label with a single verb that
maps to the agent's current activity. Keep it intentionally simple:

| Verb | When |
|---|---|
| `Drafting`  | Agent is producing tokens (response or note) |
| `Analyzing` | Agent is processing inputs, reading files, evaluating |
| `Waiting`   | Agent is blocked on user input (approval or clarification) |
| `Idle`      | No active task |

No file names, no task descriptions in the tile — those live in the
feed (§2). Keeps tile chrome quiet and glanceable from 10 feet.

**Implementation sketch.** Subscribe to the `events` SSE on L1. On
`status` events, update the focused agent's `.status` label text + a
`data-status` attribute for any verb-specific styling. Pulse the tile
border subtly while the verb is `Drafting`.

---

## 2. Cross-project activity feed (home left panel)

Reuse the existing left-panel pattern (the same shape as the file
explorer drawer). On L0 (home), pressing `E` / Options opens a left
drawer showing a unified feed of activity **across all projects**:

```
Falcon · Cassidy → Forge: take a look at the auth flow      2m
Falcon · Forge: opened auth.ts                              2m
Aurora · Cadence: drafted PRD section 4                     14m
Falcon · Vault: flagged secret-handling concern             1h
```

- Sorted newest-first, grouped only by recency (not by project).
- Project name is the first crumb so the user can scan across teams.
- Selecting an entry opens that project (L1) with the relevant agent
  pre-focused (and zooms further to L2 if it was an agent-level event).

**Implementation sketch.** Server emits `activity` events into the
project events stream; renderer keeps a sliding window of the last
N (~50?) events across all subscribed projects. Drawer markup mirrors
`#file-drawer`. Same focus / scroll / open-on-Enter model.

---

## 3. In-project activity feed (L1 left panel)

Same left-panel pattern, but on **L1**: a feed scoped to the active
project. Shows every event from agents in this team:

```
Cassidy → Forge: take a look at the auth flow
Forge: opened auth.ts
Forge: drafting reply
Cassidy: synthesizing
Cassidy: waiting on approval
```

- Default `E` / Options on L1 still opens the file explorer; the
  activity feed is a separate left-panel mode (toggle, or sibling
  drawer accessed via a separate shortcut). Decide on shortcut later;
  could be the same drawer with a tab switch at the top.
- Each line is selectable — Enter on an agent-scoped line opens L2
  for that agent.

**Implementation sketch.** Same SSE channel, filtered to the active
project. Same drawer styling as `#file-drawer` so the L0 and L1
variants stay visually consistent.

---

## 4. Inter-agent delegation, communicated in chat

When `team.runWithDelegation` hops one agent to another, surface the
hand-off in **chat bubbles** rather than as separate UI:

- **On L2 (agent zoom):** the receiving agent's chat shows a system
  bubble at the top of the delegation chain: `Cassidy → Forge` with the
  task as the body. The sending agent's chat shows the mirror:
  `Cassidy → Forge: passing this to engineering`.
- **On L1 activity feed:** same `Cassidy <→> Forge` notation as a
  feed line — clear who initiated, who's receiving.

The arrow form (`<→>` or `→`) reads as "they're speaking with one
another." Keep the bubble visually distinct from regular agent /
user bubbles (e.g. a `bubble.handoff` class — neutral background,
italicized prefix).

**Implementation sketch.** When the delegation event fires, append a
`{ role: 'system', content: 'Cassidy → Forge: <task>' }` turn to both
agents' scratchpads. Renderer renders `bubble.system` with the
handoff class.

---

## 5. Shared project scratchpad (L1/L2 left panel)

Reuse the **left-panel pattern** again — a pinned-notes panel
accessible on L1 (and L2) showing the team's shared scratchpad: open
questions, decisions, recent notes any agent has dropped. Editable by
the user; agents append automatically when they `take_note`.

- Mirrors the file drawer's drawer behavior: focusable list,
  Enter to open / edit, separate add-note affordance later.
- Could be a third tab inside the same left drawer alongside Files +
  Activity Feed.

**Implementation sketch.** This is the persistent project state we
already have (`app/state/<projectId>/notes/`). Just wire a left-panel
view of it that updates on the events channel when a `note_added`
event fires.

---

## 6. Notifications: icon + center, with macOS-style toast

New notification system, replacing the need for a top status line.
Two surfaces:

- **Notification icon** in the footer rail, immediately **left of the
  settings gear**. Bell-style SVG, same hit target size as the gear.
  A small dot indicates unread; a count badge appears for ≥1 unread.
- **Notification menu** opens when the icon is activated. Steam OS-
  style list: each entry has a title, body, timestamp, and (optionally)
  inline action buttons (e.g., `Approve` / `Dismiss` for permission
  prompts). Same focus / nav model as the rest of the rail.
- **Toast card** appears top-right (macOS-style) when a new
  notification arrives. Slides in, persists ~4s by default (or
  indefinitely if it requires action), then collapses into the menu.
  Card uses the standard Steam OS sizing tokens.

What ends up here:
- Agent needs approval to take a material action.
- An agent has finished a long-running task.
- A delegated task has resumed back to the lead.
- Errors / autosave failures.

This subsumes the "team-level status bar" idea — the user can see
everything important without dedicating chrome to it.

**Implementation sketch.** Server emits `notification` events; the
renderer maintains an in-memory queue (and persists unread count
to sessionStorage). Three UI components:
  - `#notification-btn` in the footer rail
  - `#notification-menu` modal (Steam-OS list)
  - `#notification-toast-stack` fixed top-right container, cards
    auto-dismiss

Notification entries that require action emit follow-up `approval`
events back to the server when the user clicks Approve / Dismiss.

---

## Deferred for now

- **§7 "What did the team do?" recap** — natural-language standup view.
  Useful but not core to the Cowork feel.
- **§8 Per-agent "is talking" indicator** — speaking waveform on the
  tile during TTS playback. Nice polish, low priority.
- **§9 Top status line** — replaced by the notification icon + toast
  approach in §6. Reconsider later only if the notifications turn out
  to be too "background" to convey live team status.

---

## Suggested rollout order

1. **Event channel** (architectural prereq — without it, none of the
   below works).
2. **§1 live verb status** — smallest UI change; immediately makes L1
   feel alive.
3. **§3 in-project activity feed** — first feed to ship, builds on the
   same event stream.
4. **§6 notifications** — unblocks approval-gate workflows.
5. **§4 inter-agent delegation in chat** — surfaces the existing
   delegate-and-resume mechanics.
6. **§2 cross-project feed** — once §3's drawer pattern is stable.
7. **§5 shared scratchpad panel** — wires existing notes into the
   left-panel system.
