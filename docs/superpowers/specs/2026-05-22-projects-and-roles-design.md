# Bridge — multi-agent command center

> *Bridge*: the surface where one voice commands a named, role-typed crew. Captain at the helm; specialists at their stations; the lead delegates and reports back.

**Status:** draft for review
**Date:** 2026-05-22
**Scope:** Bridge desktop env — `app/` (server + renderer)

## Goal

Turn the current single 4×2 grid of 8 hardcoded agents into a **multi-project workspace**. Each project is a hand-picked team drawn from a 14-role catalog. Projects are created with PTT voice, files are scoped per project, and the user can talk to a single agent *or* the whole team — the team's lead delegates and synthesizes.

The user interaction model stays what it is today: **voice + DualSense gamepad, single-bubble Claude/ChatGPT-style prompt at the agent level**. This change is structural (adds a project layer above the grid and a team-voice surface) without abandoning the MVP frame.

## Non-goals

- File editing, rename, delete (read-only explorer in MVP)
- Streaming team-voice responses (wait for full fan-out, then animate)
- Multi-instance roles per project (each role appears at most once)
- Cross-project context sharing
- Project delete UI (deferred — manual JSON edit for now)
- LLM-generated agent personalities (templates per role; tone-of-voice deferred)

## Navigation model

Three levels, Circle (○) walks up one:

```
L0  Project Picker      ──○ (no-op — top level)
 │   ✕ on project tile → L1
 │   ✕ on "+ New"      → Create-project flow
L1  Project Grid        ──○ back to L0
 │   ✕ on agent tile   → L2
 │   R2 (PTT)          → talk to the team (lead delegates)
 │   □ on tile         → toggle agent enabled/disabled
L2  Agent Zoom (chat)   ──○ back to L1
     R2 (PTT)          → talk to that one agent
     △                 → open history drawer
     L1/R1             → cycle to prev/next enabled agent
```

**File explorer panel** is a left-side drawer visible at L1 and L2 (hidden at L0). Toggled by the **Options** button (keyboard: `\`). State persists per-session.

### Button map (additions / changes)

| Button | L0 picker | L1 grid | L2 zoom |
|---|---|---|---|
| ✕ Cross | open project / create new | open agent | activate focused control |
| ○ Circle | (no-op) | back to L0 | back to L1 |
| □ Square | (no-op) | toggle agent enabled | (no-op) |
| △ Triangle | (no-op) | (no-op) | open history drawer |
| L1/R1 | (no-op) | (no-op) | cycle enabled agents |
| L2 | speak project name | speak focused agent name | speak current agent name |
| R2 (PTT) | (no-op outside name capture) | talk to team via lead | talk to current agent |
| Options | (no-op) | toggle file explorer | toggle file explorer |

L2-earcon is the already-shipped behavior; project-picker case extends it to speak the focused project name.

## Role catalog

14 roles, each with: stable `id`, label, color, name pool, persona template. Catalog lives in `app/server/roles.js` as the single source of truth.

| id | Label | Name pool | Persona seed |
|---|---|---|---|
| `pm` | Product Manager | Cassidy, Marlowe, Quinn, Linden | organizing, strategic |
| `engineer` | Engineer | Kade, Reese, Forge, Birch | builder, precise |
| `designer` | Designer | Iris, Mira, Cove, Juno | visual, intuitive |
| `qa` | QA | Audrey, Tess, Roan, Vail | methodical, sharp |
| `data_sci` | Data Scientist | Theo, Nori, Banks, Soren | analytical |
| `devops` | DevOps / SRE | Ridge, Beacon, Atlas, Cairn | infrastructure-minded |
| `security` | Security | Sentry, Cyrus, Onyx, Vault | vigilant |
| `tpm` | TPM / PgM | Cadence, Lennox, Pace, Halden | coordinating |
| `ux_research` | UX Research | Wren, Story, Iona, Sable | curious |
| `ml_eng` | ML Engineer | Vector, Tessa, Helix, Axon | tensor-minded |
| `data_eng` | Data Engineer | Brook, Delta, Reine, Conduit | pipeline flow |
| `tech_writer` | Technical Writer | Quill, Proser, Hadley, Mark | clarifying |
| `marketing` | Marketing | Brio, Lark, Verve, Echo | energetic |
| `support` | Support | Haven, Bay, Solace, Lior | helpful |

**Name selection at project creation:** for each chosen role, walk that role's pool in order, picking the first name not yet used **within this project**. Cross-project collisions are allowed. Pools are intentionally short (4 names) — the catalog is small enough that a project never picks the same role twice (single-instance rule), so a pool of 4 is plenty.

**Colors** carry over from the existing palette so the visual language stays continuous.

## Data model

```js
// app/state/projects.json
{
  "projects": [
    {
      "id": "p_2026_05_22_falcon",
      "name": "Falcon launch",
      "goal": "Ship v2 of the mobile checkout flow by end of quarter, with new payment methods and 99.9% reliability.",
      "createdAt": 1716412800000,
      "leadAgentId": "p_2026_05_22_falcon__pm",
      "agents": [
        {
          "id": "p_2026_05_22_falcon__pm",
          "role": "pm",
          "name": "Cassidy",
          "color": "#ffb86b",
          "persona": "organizing, strategic",
          "enabled": true
        },
        // ... one per chosen role
      ]
    }
  ]
}
```

**Project id format:** `p_YYYY_MM_DD_<slug>` — `slug` is the lowercased, dash-collapsed project name. Disambiguated with `_2`, `_3`, … on collision.

**Agent id format:** `<projectId>__<roleId>` — flat, predictable, scratchpad-friendly.

**Lead resolution:** at create time, `leadAgentId` is set to the project's PM agent if `pm` was chosen, else the TPM agent. If neither was picked by the user, **TPM is auto-added silently** with a one-frame banner (*"Adding Cadence as lead"*) before the project grid renders. The lead's `enabled` flag is forced to `true` and cannot be toggled off via Square (no-op + toast: *"Lead can't be disabled."*).

### Scratchpad

`app/state/scratchpad.json` is reused with the new agent-id format. **The legacy 8-agent records are wiped on first boot under the new schema** (user-approved fresh start). The file structure is otherwise unchanged — key by `agentId`, value `{ messages, lastSpec, notes, updatedAt }`.

### Project folder layout

Each project gets its own folder under `app/state/<projectId>/`. **This folder is the file explorer's home** — everything in it is browsable.

```
app/state/<projectId>/
  project.md                # auto-generated header: name, goal, team, created
  roles/
    pm.md                   # this project's PM charter (customized from base)
    engineer.md             # this project's Engineer charter
    qa.md                   # ...one per chosen role
  notes/
    2026-05-22T20-15.md     # saved via "take a note"
```

The existing `app/notes/` directory is deleted (fresh start). The `backends/notes.js` helper grows a `projectId` parameter throughout.

### Role charters (base templates)

Each role has a **default charter markdown** that describes that role's responsibilities, typical tasks, and areas of expertise. Base templates live in the repo (static):

```
app/server/role-charters/
  pm.md
  engineer.md
  designer.md
  ...  (one per role in the catalog)
```

**Charter template structure:**

```markdown
# {{Role label}}

## Role
One-paragraph description of what this role owns.

## Typical tasks
- bullet
- bullet
- bullet

## Areas of expertise
- bullet
- bullet
- bullet
```

**At project creation**, after the user captures the project goal (see Create-project flow below), each chosen role's base charter is **customized for this specific project** — the lead agent rewrites each charter section to reflect *Falcon launch's* PM responsibilities, not generic PM. The customized files are written to `app/state/<projectId>/roles/<roleId>.md`.

**The customized charter becomes part of the agent's system prompt** — concatenated into the prompt that runs through `orchestrator.js` for every per-agent interpret. This is the mechanism by which a project's agents feel like *this team for this project*, not interchangeable templates.

## Create-project flow

Four steps, each a tile inside L0's surface, separated by tile transitions (not pages):

### Step 1 — Pick roles

Large grid of 14 toggle tiles, one per role. D-pad navigates, Cross toggles. Triangle confirms (or Cross on a dedicated "Done" tile at the end). At least 1 role required.

Display per tile: role label, sample name (the name the agent would receive), and toggle state (filled / outlined).

### Step 2 — Name (PTT)

Reader-style tile: *"Hold R2 and speak the project name."* Indicator shows live partial. Cross saves; Circle goes back to step 1. Keyboard fallback via `/`. Empty name blocks save.

If no PM/TPM was picked in step 1, a small badge under the input reads: *"Cadence will lead this team."*

### Step 3 — Goal (PTT)

Reader-style tile: *"What is this project's goal? Hold R2 and describe it."* Same PTT/keyboard mechanics as the name step. The goal is a 1–3 sentence intent statement (e.g., *"Ship version 2 of the mobile checkout flow by end of quarter, with new payment methods and 99.9% reliability."*).

Cross commits the goal; Circle goes back to step 2. Empty goal blocks commit (mandatory — charter customization needs it).

### Step 4 — Charter generation (one-shot background)

After the goal is committed, the server runs charter customization **synchronously before returning the project** to the renderer. Pipeline:

```
1. project folder created at app/state/<projectId>/
2. project.md written (name, goal, team list, timestamp)
3. notes/ folder created
4. roles/ folder created
5. for each chosen role (parallel, cap 5 concurrent):
     - read base charter from app/server/role-charters/<roleId>.md
     - call OpenRouter:
         prompt: "{name} (the {role} on project '{projectName}') has this
                  base charter:\n\n{baseCharter}\n\nThe project goal is:\n
                  '{goal}'\n\nRewrite the charter so it reflects this
                  project's specifics. Keep the same markdown structure
                  (Role / Typical tasks / Areas of expertise). Replace
                  generic items with project-specific ones. 200 words max."
     - write result to roles/<roleId>.md
6. response returns the project record once all charters land (or timeout)
```

Indicator during this step: *"Customizing team charters…"* with a per-role progress count (e.g. *"3 of 5 ready"*). On any single-charter failure or timeout (20s/charter), the base charter is written verbatim as a fallback — the project still lands.

### Step 5 — Land on project

The user is dropped at L1 with focus on the lead's tile. The file explorer (if open) shows the newly-created folder contents: `project.md`, `roles/`, and an empty `notes/`.

## Agent zoom (L2)

Same single-bubble tile spec as today. New: **Triangle opens the history drawer**.

**History drawer:**
- Overlays the right 60% of the L2 surface (file explorer keeps its left position if open).
- Vertical list of prior turns, newest first, rendered as compact reader tiles (title + first ~80 chars of body).
- D-pad navigates entries; Cross opens the entry full-screen as a reader tile; Circle closes the drawer.
- Sourced from `scratchpad.json[agent.id].messages` (existing data, no schema change).

## Context efficiency model

Bridge is built around a deliberate split of who knows what, to keep token usage bounded and outputs in-role:

**Lead has oversight only.** The lead agent's working context contains:
- project metadata (name, goal, team roster as `Name (Role)`)
- the user's current prompt
- a **team activity digest** — one short line per enabled agent summarising their most recent output (≤120 chars, derived from `scratchpad[aid].lastSpec.body`)
- prior team-voice summaries (the lead's own scratchpad history)

The lead's context **never** contains another agent's full scratchpad. The digest is the only cross-agent signal it sees.

**Each agent is deep but narrow.** A per-agent `interpret` call's context contains:
- the agent's customized charter (their domain knowledge)
- the agent's own scratchpad history (their prior turns)
- the user's prompt (or the lead's assigned task)
- optional **shared context snippets** explicitly forwarded by the lead

Agents do not see each other's scratchpads. They cannot infer what another agent has done unless the lead chose to forward a snippet.

**Cross-agent sharing is explicit and small.** When the lead routes a task during team voice, each assignment may carry a `sharedFrom` array of short snippets from peers:

```json
{
  "agentId": "p_xyz__qa",
  "task": "List the top 3 risks for the new payment integration.",
  "sharedFrom": [
    { "fromAgentName": "Kade", "fromRole": "Engineer",
      "snippet": "Auth handshake retries on timeout; idempotency keys on every charge." }
  ]
}
```

Constraints on `sharedFrom`:
- Maximum **3 snippets** per assignment.
- Each snippet ≤ **240 characters**.
- The assignee's system prompt prepends snippets as: *"Context shared with you by {fromAgentName} ({fromRole}): {snippet}"* — quoted, attributed, bounded.

Snippets come from the lead's team activity digest (which the lead sees) — the lead does not need raw access to peer scratchpads to share. This keeps the sharing primitive deterministic and token-cheap.

**What this rules out (intentionally):**
- Agents reading each other's full transcripts.
- A "global team chat" that every agent processes.
- Automatic cross-context-injection based on similarity / vector recall.

These could come in a future phase. The MVP rule is: **lead curates, agents stay focused**.

## Team voice (L1 PTT)

When the user holds R2 at L1, the prompt routes to the **lead agent**, who delegates and synthesizes. The fan-out is bounded and parallel.

### Pipeline

```
1. routing    → lead receives { userPrompt, team: enabled agents }
                returns JSON: { assignments: [{agentId, task}], summary_intent }
                max 5 assignments; over-cap entries are dropped + logged

2. delegation → for each assignment, call /agents/:aid/interpret in parallel
                each agent's tile pulses while in-flight

3. synthesis  → lead receives { userPrompt, perAgent: {aid: spec} }
                returns a single tile spec for the project-level summary
                rendered as a "team summary" banner above the grid

4. response   → returns { routing, perAgent, summary } to the renderer
```

### Lead system prompts

**Router prompt** (lead, JSON-only):

> You are {leadName}, lead of project "{projectName}". The project goal is: "{goal}".
>
> Active team:
> {for each enabled non-lead agent: "- {Name} ({Role}) [id:{agentId}] — last work: {digest line or '—'}"}
>
> The user said: "{prompt}".
>
> Return a single JSON object: `{ "assignments": [ { "agentId": "...", "task": "...", "sharedFrom": [ { "fromAgentName": "...", "fromRole": "...", "snippet": "..." } ] } ], "summary_intent": "..." }`. The `sharedFrom` field is optional per assignment — include it only when another teammate's recent work (visible in their digest line) gives useful context for this task. Max 3 sharedFrom entries per assignment; each snippet ≤ 240 characters. Use exact agent ids from the roster. Assign only agents whose role applies. Maximum 5 assignments. If no one applies, return `assignments: []` and put the answer in `summary_intent`.

The lead sees the digest lines and is the only agent allowed to forward peer snippets. Per-agent context stays focused.

**Synthesizer prompt** (lead):

> You are {leadName}. Project goal: "{goal}". The team replied to "{prompt}":
> {for each: "{name} ({role}): {spec.body}"}
> Compose a single response to the user that synthesizes their work. 1–3 sentences, spoken-friendly. Output the standard `answer` tile-spec JSON.

### Per-agent system prompt (all interpret calls)

Every per-agent `interpret` call (whether direct from L2 or delegated by the lead) includes the agent's **customized charter markdown** plus any **shared context** forwarded by the lead for this turn:

> You are {name}, the {roleLabel} on project "{projectName}". Project goal: "{goal}".
>
> Your charter for this project:
> ---
> {customized charter markdown from `roles/<roleId>.md`}
> ---
>
> {if sharedFrom present:}
> Context shared with you by your teammates:
> {for each: "- {fromAgentName} ({fromRole}): \"{snippet}\""}
> Use this only if it bears on the user's request. Do not summarise it back unless asked.
>
> {existing tile-spec instructions from `orchestrator.js#systemPrompt`}

The shared-context block is the *only* way an agent learns what peers have done. There is no global team transcript and no automatic injection.

### Team activity digest

A per-agent one-line summary is maintained continuously in scratchpad to feed the lead's roster. Source: the first ~120 characters of `scratchpad[aid].lastSpec.body` (or `lastSpec.title` if body is absent). Cleared on agent reset; updated on every interpret. Cheap to compute; never exposed to non-lead agents.

Both calls go through the existing OpenRouter pathway in `orchestrator.js`. Tile-spec contract is unchanged.

### Cost guard

- Fan-out cap **5** assignees per turn.
- Routing model and synthesis model both share `OPENROUTER_MODEL`; can be split via env later.
- Per-agent timeout **20s**; on timeout the assignee's slot in `perAgent` is `null` and synthesis is told *"Kade did not respond."*

### UI during fan-out

- `agentBusy[aid] = true` is already in place per agent → tile pulse animation triggers off this.
- Indicator: *"Cassidy is delegating to 3…"* during routing, then *"Team working…"* during fan-out, then synthesis result speaks aloud.
- User can press Circle once to cancel (aborts in-flight requests; partial responses discarded).

## Agent enable/disable

Per-agent `enabled: bool` in the project record (default `true`).

- **L1 Square** on the focused tile toggles `enabled` and persists immediately.
- **Visual:** disabled tile desaturates to ~40% opacity with a small "off" dot in the upper-right.
- **L2 cycling:** L1/R1 skip disabled agents.
- **Team voice:** disabled agents are not listed in the router prompt's roster — the model literally cannot assign to them.
- **Direct PTT in zoom:** unaffected. Disable = "out of team rotation," not muted.
- **Lead:** always-enabled. Square on the lead is a no-op + toast.

## File explorer

Left-side slide-in drawer, ~280px wide. Shows the contents of `app/state/<projectId>/` (the project folder).

- **Visible at L1 and L2.** Hidden at L0.
- **Toggle:** Options button on gamepad, `\` on keyboard. State held in renderer module-local state, **not persisted** across reloads.
- **Content:** the project folder tree, rendered as collapsible sections:
  ```
  ▾ Charters
      pm.md         (Cassidy)
      engineer.md   (Kade)
      …
  ▾ Notes
      ship sun
      v2 launch checklist
  ─ project.md
  ```
  Charter entries show the role label and the agent's name. Note entries show the derived title. `project.md` sits at the bottom as a singleton.
- **Operations:**
  - D-pad navigates the tree (focus ring extends into the panel when it's open and focused).
  - Cross opens the focused file inline as a reader tile (replaces the center surface; back via Circle).
  - Sections toggle open/closed via left/right at the section header.
- **Saved notes from "take a note":** route into `app/state/<projectId>/notes/`. The existing `save_note` action already plumbs through `appendNote(body)` — we add `projectId` to the signature.
- **Charter editing:** read-only in MVP. Future-extension: Square on a charter file to mark it editable; agent re-reads on next prompt.

## Server surface

### New routes

```
GET    /roles                                       → role catalog (id, label, color, namePool, personaSeed)
GET    /projects                                    → list (id, name, createdAt, agents[])
POST   /projects                                    → { name, roleIds: [...] } → project
GET    /projects/:pid                               → full project
PATCH  /projects/:pid/agents/:aid                   → { enabled }
POST   /projects/:pid/agents/:aid/interpret         → tile spec (per-agent prompt)
POST   /projects/:pid/agents/:aid/spec              → persist last spec
POST   /projects/:pid/team/interpret                → team-voice pipeline
GET    /projects/:pid/notes                         → list project notes
GET    /projects/:pid/notes/:nid                    → read note
POST   /projects/:pid/notes                         → { body } → note
```

### Removed routes

```
GET    /agents
GET    /agents/:id
POST   /agents/:id/interpret
POST   /agents/:id/spec
POST   /agents/:id/reset
GET    /notes
GET    /notes/:id
POST   /notes
```

`/health` stays. Renderer must update all fetch calls.

## Files touched

**New:**
- `app/server/roles.js` — 14-role catalog
- `app/server/projects.js` — CRUD + name-pool walker + lead resolution + folder scaffolding
- `app/server/charters.js` — charter customization pipeline (base read → LLM rewrite → write)
- `app/server/team.js` — team-voice pipeline (router → fan-out → synthesizer)
- `app/server/role-charters/*.md` — 14 base charter templates (one per role)

**Deleted:**
- `app/server/agents.js`
- `app/notes/` directory

**Modified:**
- `app/server/server.js` — replace agent routes with project routes; mount team route
- `app/server/orchestrator.js` — `interpretIntent(agentId, text)` lookup goes through projects
- `app/server/backends/notes.js` — add `projectId` to `listNotes / readNote / appendNote`
- `app/server/scratchpad.js` — no schema change; first-boot wipe under new agent-id format
- `app/renderer/main.js` — add MODE_PROJECTS, MODE_NEW_PROJECT_ROLES, MODE_NEW_PROJECT_NAME; wire team voice; wire file explorer toggle; wire history drawer
- `app/renderer/tiles.js` — add `role_picker` template; add history-drawer renderer; add team-summary banner
- `app/renderer/gamepad.js` — no change (Options + Square already mapped)
- `app/renderer/style.css` — reflow grid, picker tile, disabled state, file drawer, history drawer

## State migration

On first boot under the new code:

1. If `app/state/projects.json` does not exist, create it as `{ projects: [] }`.
2. If `app/state/scratchpad.json` contains entries keyed by the legacy ids (`nova`, `atlas`, …), rewrite the file to `{}`.
3. If `app/notes/` exists, leave it on disk (user data) but stop reading from it — files are project-scoped now. Manual relocation is up to the user.

No interactive migration prompt; the fresh-start path is user-approved.

## Testing approach

This is a UI-heavy change; automated tests are limited.

- **Server:** unit-test `projects.js` (name-pool walker, lead resolution, slug collision) and `team.js` (routing-output validation, fan-out cap, timeout handling). Lightweight `node:test`.
- **Orchestrator:** keep the existing fallback classifier so the flow works without an OpenRouter key (already true).
- **Renderer:** no JS unit tests today; verify manually with the `/run` skill — launch the app, walk the three nav levels, create a project, toggle an agent, PTT at L1, PTT at L2, open file explorer, open history drawer.

## Risks / open items

- **Team voice latency under no-key fallback:** the local classifier doesn't handle multi-agent routing. **Decision:** block team voice when key absent with TTS message *"Team voice needs an OpenRouter key."* — keeps the demo path honest.
- **Charter customization under no-key fallback:** customization needs the LLM. **Decision:** when key absent, write the base charter verbatim to each project role file. Project creation still completes; agents fall back to generic charter content.
- **History drawer over file drawer:** when both are open simultaneously at L2, the screen gets cramped. **Decision:** opening the history drawer auto-closes the file drawer at L2.
- **Project picker scale:** layout assumes <12 projects fit on screen. Beyond that, simple vertical scroll. No pagination in MVP.
- **Charter prompt drift:** customization rewrites charters but model may change structure unexpectedly. Validator: if the output doesn't contain the three required headings (`## Role`, `## Typical tasks`, `## Areas of expertise`), fall back to base charter.
- **Goal step is mandatory but PTT-friendly:** users without a mic can't proceed without keyboard fallback. The `/` keyboard input must be visible/discoverable on the goal step. UI cue required.

## Decision log (from brainstorm)

- Project name → **Bridge** (single brand; no parent product wrapper)
- Role list scope → Comprehensive product org (14)
- Grid shape → Reflow to fit
- Prompt UI per agent → Single-bubble + Triangle history drawer
- Project naming → PTT (voice)
- Legacy agents → Drop, fresh start
- Team voice → PM/Producer auto-delegates, TPM auto-added as lead if none
- Empty team behavior → Lead is always-enabled (Square on lead is no-op)
- File explorer scope → Project folder contents (charters + notes + project.md)
- File explorer toggle → Options button (repurposed from redundant back)
- Project folder → `app/state/<projectId>/` created at project creation
- Role charters → Base templates in repo; customized to project goal at creation; injected into every per-agent system prompt
- Goal capture → Step 3 of create flow, mandatory PTT (or `/` typed)
- Charter customization on failure → fall back to base charter verbatim
- Context model → Lead has high-level oversight + team digest; agents are deep and narrow; cross-sharing is explicit via `sharedFrom` snippets (max 3 × 240 chars per assignment)
- No global team transcript → agents only see another agent's work if the lead explicitly forwards a snippet
