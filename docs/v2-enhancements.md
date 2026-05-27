# Bridge v2 — Cowork-style enhancements

A roadmap of upgrades that move Bridge from "one-agent-at-a-time chat
surface" → "team workspace where the user supervises multiple agents
working in parallel." Inspired by Claude Cowork's multi-agent model.

These are deliberately scoped to surface what the team is *already*
doing (via `team.runTeamVoice`, `delegate-and-resume`, memory,
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
agents' memorys. Renderer renders `bubble.system` with the
handoff class.

---

## 5. Shared project Memory (independent left panel, `M` key)

A **standalone left-side drawer** — separate element from the
Explorer / Activity Feed drawers, opened with the **`M` keyboard
shortcut**. Same visual pattern as `#file-drawer` (rounded card,
matching surface-top / surface-bottom CSS vars, list of entries with
Enter to open / edit), but it's its own DOM node and its own toggle.

Contents: the team's accumulated working knowledge — open questions,
decisions, recent notes any agent has dropped. Editable by the user;
agents append automatically when they `take_note`. "Memory" matches
the Claude vocabulary and scales naturally if Bridge later adds
per-agent memories alongside the project-wide one.

**Skills drawer cleanup.** The `S` key + Skills drawer were
scaffolded earlier but the `+ Add skill` flow was removed. Drop the
Skills drawer entirely when shipping Memory (or move it behind a
different key if it's revived later). `M` is unbound today, so no
shortcut conflict.

**Mutually-exclusive with other drawers.** Opening Memory closes
the Explorer (and the Activity Feed, once that exists), and vice
versa — same swap behavior the Explorer ↔ Skills drawer pair has
today.

**Implementation sketch.** Reuses the persistent project state we
already have (`app/state/<projectId>/notes/`). New `#memory-drawer`
sibling of `#file-drawer`, sharing all the same styles via a
`.drawer.left` class. Subscribes to the SSE events channel and
appends new entries as `note_added` events fire so the list updates
live while an agent is working.

---

## 6. Notifications

Two **independent** UI elements driven by the same event stream:

### 6a. Notification icon + menu (footer rail)

The notification surface is a single **icon that doubles as the menu
opener** — the icon shows the live unread count, and selecting it
reveals a list anchored **just above** the icon (not a centered
modal, not in the rail itself).

- **Icon** sits in the footer rail, immediately **left of the
  settings gear**. Bell-style SVG, same hit target size as the gear.
  Displays the unread count as a small numeric badge when ≥ 1; bare
  icon when 0.
- **Menu** appears as a floating panel **immediately above the icon
  on activation** (Enter / click / d-pad Cross). Anchored to the
  icon's position, slides up briefly on open, dismisses on Esc /
  Circle / clicking outside.
- **Menu contents** — Steam-OS-style list, newest first: each entry
  has a title, body, timestamp, and (optionally) inline action
  buttons (e.g., `Approve` / `Dismiss` for permission prompts). Same
  focus / nav model as the rest of the rail.
- Entries persist in the menu until the user dismisses or clears
  them; this is the durable history of team activity.

### 6b. macOS-style toast (separate component)

A **distinct UI element**, not part of the notification menu. When a
new notification arrives, a card slides in **top-right of the
screen** (macOS-style):

- Independent DOM node, independent CSS, independent focus model.
- Slides in, persists ~4s for informational notifications, or
  **indefinitely** if it requires an action.
- Auto-dismisses → does **not** disappear from the menu; the menu
  still holds the durable copy.
- Multiple toasts stack vertically with a small gap.
- Card uses the standard Steam OS sizing tokens.

The toast is the transient, surface-level alert; the menu is the
ledger. They subscribe to the same events but render and dismiss on
independent timelines.

### What surfaces here

- Agent needs approval to take a material action.
- An agent has finished a long-running task.
- A delegated task has resumed back to the lead.
- Errors / autosave failures.

This subsumes the "team-level status bar" idea — the user can see
everything important without dedicating chrome to it.

### Implementation sketch

Server emits `notification` events; the renderer maintains an
in-memory queue (and persists unread count to sessionStorage). Three
UI components, each independent:

  - `#notification-btn` — footer rail icon (left of gear)
  - `#notification-menu` — Steam-OS list modal opened from the icon
  - `#notification-toast-stack` — fixed top-right container, slides
    cards in / out independently of the menu

Notification entries that require action emit follow-up `approval`
events back to the server when the user clicks Approve / Dismiss in
either the toast OR the menu.

---

## 7. Rich response formatting in agent bubbles

Today every agent bubble is plain `textContent` — even when the model
returns markdown the user only sees a wall of text. Claude's actual
responses lean heavily on bullets, tables, code blocks, and one-line
action summaries; Bridge should render all of them.

### 7a. Markdown rendering

Inline markdown the agent bubble parses on its own:

- Headers `##`, `###`
- Bullet lists (`-`, `*`) and numbered lists (`1.`)
- Tables (`| col | col |` with separator row)
- Fenced code blocks (```` ``` ````) with a tiny copy button
- Inline `code`
- Bold `**foo**` / italic `*foo*`
- Blockquotes `> …`
- Links `[text](url)`

Sanitize before injecting HTML (no raw `<script>`, no `on*=` attrs).
Use a small purpose-built parser (~150 lines) or pull in a minimal
markdown lib if license allows.

### 7b. Action summary cards

For Claude-Code-style "what the agent did" summaries — `Created
auth.ts`, `Edited 2 files`, `Ran tests: 12 passed`, `Searched for X`,
`Read project.md` — extend the tile-spec contract with an optional
`actions_taken` array:

```json
{
  "intent": "answer",
  "body": "Done — auth flow is now stubbed.",
  "actions_taken": [
    { "kind": "created", "label": "auth.ts" },
    { "kind": "edited",  "count": 2, "items": ["routes.ts", "config.ts"] },
    { "kind": "ran",     "label": "tests", "result": "12 passed" },
    { "kind": "read",    "label": "project.md" },
    { "kind": "searched","label": "OAuth handler" }
  ]
}
```

Renderer turns each entry into a compact card inside the bubble,
**above** the body text. Card styling:

- One row per action (`kind` glyph + label/details, right-aligned
  meta like file count or test result).
- Expandable when `items` is set (e.g. "Edited 2 files" expands to
  show `routes.ts`, `config.ts`).
- Glyph per kind: `+` for created, `~` for edited, `▶` for ran, `📖`
  / `eye` for read, `🔍` for searched. SVG icons; no emoji.

Update the system prompt so the model emits `actions_taken` when it
performed concrete operations on behalf of the user (even simulated,
in the current stub mode). Backwards-compatible: if `actions_taken`
is absent the bubble renders normally.

### 7c. Optional follow-ups

- **Copy button on code blocks** — click → copies to clipboard,
  brief "Copied!" affordance.
- **Inline diff blocks** when actions edit files — small unified
  diff card showing additions/deletions in the bubble.
- **Math** (`$…$`, `$$…$$`) via KaTeX if a project ever needs it.

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
7. **§5 shared memory panel** — wires existing notes into the
   left-panel system.
