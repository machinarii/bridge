# Bridge — Handoff

Snapshot for whoever picks this up next. Pairs with `README.md` (product + dev setup) and the design docs under `docs/superpowers/` (gitignored).

## TL;DR

- **Repo:** `main` is current and pushed to `origin` (`github.com/machinarii/bridge`). Working tree clean.
- **Runtime:** an Express server (`app/server/server.js`) on **:4317** + a local **Parakeet** STT sidecar on **:8123**. The renderer is vanilla JS served statically from `app/renderer/`.
- **To run:** see "Running it" below. Voice needs the Parakeet sidecar up; agents need `OPENROUTER_API_KEY` in `app/server/.env`.

## Running it

```bash
# 1. deps
npm install
cd app/server && npm install && cd ../..

# 2. config — app/server/.env (git-ignored)
#    OPENROUTER_API_KEY=sk-or-...        (required for agent replies + kickoff)
#    OPENROUTER_MODEL=anthropic/claude-sonnet-4.6
#    (LOCAL_STT_URL defaults to http://127.0.0.1:8123/transcribe)

# 3. Parakeet STT sidecar (required for voice) — needs ffmpeg on PATH
python3 -m venv app/stt/.venv
app/stt/.venv/bin/pip install -r app/stt/requirements.txt
HF_HOME="$PWD/build/hf-cache" npm run stt        # model is cached there (~600MB)

# 4. the app
npm run server     # web server on :4317 (open in Chrome)
#   – or –
npm run dev        # Electron window (its own Chromium)
```

Notes:
- **Server code loads once at startup** — restart `npm run server` after any `app/server/**` change. The renderer (`app/renderer/**`) is served fresh, so a browser **hard-refresh (Cmd-Shift-R)** picks up frontend changes.
- `npm run stt` does **not** set `HF_HOME`; without the `HF_HOME=…/build/hf-cache` prefix it re-downloads the model. (Worth folding into the npm script.)
- Voice is **Parakeet-only** — it never falls back to the browser engine. If the sidecar is down, voice shows a visible STT error.

## What's new this session

Big feature + a long tail of UX fixes (see `git log 416dec7..HEAD`). Highlights:

- **Multi-agent group chat + working delegation.** A delegate's reply surfaces in the delegating agent's chat as a labeled "foreign" bubble; the handoff renders as a `From → To` bubble. 1:1 delegation actually routes now (`resolveDelegateSpec`). `parseSpec` hardened so rich agent output (wireframes, code) never 500s.
- **Topology-driven routing.** The chosen work topology is injected into the PM's routing prompt and agent system prompts — it now actually shapes assignment/coordination, not just `project.md`.
- **PM auto-kickoff that runs the team (`app/server/kickoff.js`).** Plan-first → one-tap Approve → writes 4 starter docs → asks follow-up questions **one at a time** (numbered "Q1:", as multi-select choice bubbles). Assignment is **role-based** via the PM model and may pick roles not on the team. When all questions are answered → kickoff **complete** → `startTeamWork` **fans out**: each assigned specialist runs its task (`interpretIntent`) and produces a deliverable; **missing roles auto-added** (`addAgent`) with an "Added teammates" PM message + `team_changed` event. A clarify-question's answer becomes that role's task; every on-team role is guaranteed one (gap-filled). State machine on `project.kickoff.status` (`drafting→awaiting_approval→running→asking→done`).
- **Agent tile states via `awaitKind`.** A reply with `choices` → "Waiting for response" (orange, clears on reply); a deliverable → "Task complete" (green, clears on view). Client tracks `agentPending` (`agentId → 'reply'|'view'`); server tags activity events with `awaitKind`. Old `markUnseen`/`unseenAgents` replaced.
- **Multi-select in-bubble choices.** A/B/C buttons in one horizontal **grid row** (uniform height, grows to fit), letter heading + description, **Other = hold-to-talk** free-form (standard mic wave), grayed **Submit** until a pick, "Select one or more" hint. Answered questions render **memorialized** (read-only, picks shown). Selection is **Enter/✕ only** (no Space).
- **Agent grounding.** `RESPONSE_STYLE` now hard-grounds output to markdown docs + code (no Figma/external tools, channels, ETAs). `ROLE_GUIDANCE` adds per-role workflow (e.g. Designer: principles/guidelines/direction/system design → confirm → use cases/flows → confirm → build in code).
- **Delegated task = handoff bubble.** `interpretIntent({ handoff })` records a delegated kickoff task as a PM→agent handoff turn, not a right-aligned "you" bubble.
- **Chat motion.** "…" thinking across agents, typewriter reveal for scripted bubbles, slide-up arrival (current + new), staggered choice entrance, new-bubble highlight.
- **Model defaults.** Reasoning effort defaults to **high**, base temperature **0.8**, default model **opus-4.7** (`.env`), richer per-role persona seeds.
- **Create-flow / nav polish** — topology screen footer reachable (Down from Back row), L0 chips trimmed (no Hold-to-talk / Type-prompt / notification bell / Memory), role-screen "Select" relabel, etc.
- **Activity feed = cross-project everywhere.** Opening Activity from any layer (header just "Activity") lists agent responses across all projects as cards: project → agent · role → response summary; click opens that project/agent. Streamed-reply activity now carries a body snippet. **Explorer** entries (files + folder headers) are now mouse-clickable. Drawer headers share one weight.

## Architecture additions

- `app/server/kickoff.js` — the whole kickoff pipeline. Pure helpers (`classifyApproval`, `topologyGuidance`, `buildPlanPrompt`) are unit-tested; orchestration fns take an injectable LLM caller (`opts.callText` / `opts.callJSON`).
- `app/server/orchestrator.js` — exports `RESPONSE_STYLE`; `parseSpec` resilience; topology in prompts.
- `app/server/team.js` — `resolveDelegateSpec` (1:1 delegation), topology in routing.
- `app/server/projects.js` — `kickoff` field + `getKickoff`/`setKickoff`; `TOPOLOGIES` exported.
- `app/server/backends/notes.js` — `writeNote(projectId, name, body)` for human-named docs.
- `app/server/kickoff.js` — `startTeamWork` (fan-out + auto-add), role-based `assignKickoffTasks` returning `{ assignments, clarify }`, kickoff Q&A advances `assignments`.
- `app/server/orchestrator.js` — `RESPONSE_STYLE` grounding, `ROLE_GUIDANCE` + `roleGuidance()`, `interpretIntent({ handoff })`, `awaitKind` on activity events.
- `app/server/events.js` — `emitActivity`/`emitDelegate` take an `extra` arg (carries `awaitKind`).
- Routes: `POST /projects/:pid/kickoff/approve`, `…/kickoff/decline`.

## Tests

`cd app/server && node --test` (per-file is most reliable, e.g. `node --test kickoff.test.js`). Kickoff: **10/10**. Two **pre-existing** failures unrelated to this work: `listRoles returns all 14 roles` (catalog is 11) and `createProject writes charter markdown for each role` — neither touches files this work changed.

## Known gaps / follow-ups

- **Fan-out cost.** Kickoff completion makes N real high-effort opus calls (one per specialist) + charter generation for any auto-added role. Intended, but real cost/latency.
- **Agent-tile pending state is client-side** (`agentPending` map) — lost on a hard page reload (the live SSE re-establishes it for new events, but an already-pending question won't show until the next event). Persisting it server-side (e.g. from `kickoff.status` / last turn) is a follow-up.
- **"Task complete" clears on view**, "Waiting for response" clears on reply — verify this matches expectations across non-kickoff replies too.
- **`npm run stt`** should set `HF_HOME=build/hf-cache` (and ideally one launch script starts web + STT together).
- **`app/renderer/speech.js`** (browser Web Speech) is now dead code — voice is Parakeet-only.
- Two **pre-existing** test failures unrelated to this work (`listRoles returns all 14 roles` — catalog is 11; `createProject writes charter markdown for each role`).
- The app is **unsigned/un-notarized** if packaged — rebuild from `main` to ship these changes; sign with team `935434BZ22` for distribution.

## Design docs

`docs/superpowers/specs/2026-06-03-pm-kickoff-design.md` and `docs/superpowers/plans/2026-06-03-pm-kickoff.md` (gitignored, per the repo's `docs/` convention).
