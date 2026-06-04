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
- **PM auto-kickoff (`app/server/kickoff.js`).** On project create the PM posts a plan-first kickoff to the lead chat. Approve (in-bubble button **or** "yes") → generates PRD + roadmap + operating-notes + open-questions docs (named files via `writeNote`), assigns topology-shaped starting tasks, posts a report, then asks follow-up questions. Reject holds it off. State machine on `project.kickoff.status`.
- **In-bubble agent choices.** Agents return a `choices[]` array when a decision is needed; rendered as a selectable list in the bubble; the pick becomes the user's next message.
- **Agent house style.** Shared `RESPONSE_STYLE` (legible reasoning, telegraphic bullets, no italics, banned clichés/moves) injected into every agent prompt + team synthesis + kickoff.
- **Voice overhaul.** Push-to-talk (hold V / R2), live word-by-word partials (re-transcribe the growing clip), wave only while holding, fixed-size capture box, Parakeet 422/decode bugs fixed (explicit `File(...)`, module-level fastapi import, temp-file + ffmpeg decode of webm).
- **L1 "Waiting for response"** — a tile glows + reads "Waiting for response" while an agent awaits the user's reply (clears when the user actually responds, not on view).
- **Create-flow polish** — topology Cancel, Enter-toggles-checkbox, name/goal Clear buttons, default-highlight Continue, transition animations, close-button ↕ nav, etc.

## Architecture additions

- `app/server/kickoff.js` — the whole kickoff pipeline. Pure helpers (`classifyApproval`, `topologyGuidance`, `buildPlanPrompt`) are unit-tested; orchestration fns take an injectable LLM caller (`opts.callText` / `opts.callJSON`).
- `app/server/orchestrator.js` — exports `RESPONSE_STYLE`; `parseSpec` resilience; topology in prompts.
- `app/server/team.js` — `resolveDelegateSpec` (1:1 delegation), topology in routing.
- `app/server/projects.js` — `kickoff` field + `getKickoff`/`setKickoff`; `TOPOLOGIES` exported.
- `app/server/backends/notes.js` — `writeNote(projectId, name, body)` for human-named docs.
- Routes: `POST /projects/:pid/kickoff/approve`, `…/kickoff/decline`.

## Tests

`cd app/server && node --test` (per-file is most reliable, e.g. `node --test kickoff.test.js`). Kickoff: **10/10**. Two **pre-existing** failures unrelated to this work: `listRoles returns all 14 roles` (catalog is 11) and `createProject writes charter markdown for each role` — neither touches files this work changed.

## Known gaps / follow-ups

- **Kickoff Phases 3 & 4 not built:** real code scaffolding into a hidden per-project `code/` folder (Phase 3) and cross-project "agent replied elsewhere" notifications (Phase 4). Design notes in `docs/superpowers/specs/2026-06-03-pm-kickoff-design.md`.
- **`npm run stt`** should set `HF_HOME=build/hf-cache` (and ideally one launch script starts web + STT together).
- **`app/renderer/speech.js`** (browser Web Speech) is now dead code — voice is Parakeet-only.
- **Choices nav** is Left/Right (reuses the bubble-action model) even though the list is vertical — switch to Up/Down if that feels off.
- **"Waiting for response"** persists until the user replies to that agent — by design, but verify it matches expectations across all agents (not just the kickoff PM).
- The app is **unsigned/un-notarized** if packaged (`Bridge-0.2.0-arm64.dmg` in `dist/` predates most of this work — rebuild from `main` to ship these changes; sign with team `935434BZ22` for distribution).

## Design docs

`docs/superpowers/specs/2026-06-03-pm-kickoff-design.md` and `docs/superpowers/plans/2026-06-03-pm-kickoff.md` (gitignored, per the repo's `docs/` convention).
