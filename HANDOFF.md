# Bridge — Handoff

Snapshot for whoever picks this up next. Pairs with `README.md` (product + dev setup) and the design docs under `docs/superpowers/` (gitignored).

## TL;DR

- **Repo:** active branch is **`main`**. Runtime data lives outside the repo under `~/bridge-projects/` (registry in `.bridge/`, one git repo per project).
- **Runtime:** an Express server (`app/server/server.js`) on **:4317** + a local **Parakeet** STT sidecar on **:8123**. The renderer is vanilla JS served statically from `app/renderer/`. The build/run sandbox shells out to the **`docker` CLI** (any daemon — **Colima** recommended, no Docker Desktop).
- **To run:** see "Running it" below. Voice needs the Parakeet sidecar up; agents need `OPENROUTER_API_KEY` in `app/server/.env`; the "Run it" build loop needs a Docker daemon (`colima start`).

## Running it

```bash
# 1. deps
npm install
cd app/server && npm install && cd ../..

# 2. config — app/server/.env (git-ignored)
#    OPENROUTER_API_KEY=sk-or-...        (required for agent replies + kickoff)
#    OPENROUTER_MODEL=anthropic/claude-opus-4.8   (default if unset)
#    (LOCAL_STT_URL defaults to http://127.0.0.1:8123/transcribe)

# 3. Parakeet STT sidecar (required for voice) — needs ffmpeg on PATH (8.x is fine)
python3 -m venv app/stt/.venv
app/stt/.venv/bin/pip install -r app/stt/requirements.txt
HF_HOME="$PWD/build/hf-cache" npm run stt        # model is cached there (~600MB)

# 4. (optional) Docker daemon for the "Build it → Run it" sandbox — Colima, no GUI
brew install colima && colima start

# 5. the app
npm run server     # web server on :4317 (open in Chrome)
#   – or –
npm run dev        # Electron window (its own Chromium)
```

Notes:
- **Server code loads once at startup** — restart `npm run server` after any `app/server/**` change. The renderer (`app/renderer/**`) is served fresh, so a browser **hard-refresh (Cmd-Shift-R)** picks up frontend changes.
- `npm run stt` does **not** set `HF_HOME`; without the `HF_HOME=…/build/hf-cache` prefix it re-downloads the model. (Worth folding into the npm script.)
- Voice is **Parakeet-only** — it never falls back to the browser engine. If the sidecar is down, voice shows a visible STT error.
- **QA shortcut:** `npm run qa:new -- trading` (or `recipes` / `iot`) seeds a fully-formed project from prefilled name/objective/features and kicks off — skips the capture UI. Prefilled copy-paste text for the capture screens + a flow walkthrough live in **`QA-GUIDE.md`**.

## What's new (latest session — Council + custom Instructions)

- **L1 "Council" — PM intake → blind & sequential deliberation → chair.** New project-level surface (press **C** / gamepad L2 from the grid, or `openCouncil()`). The flow, all in the new **`app/server/council.js`** module:
  1. **PM intake.** The PM (`getModelForRole('pm')`) reads the question and returns up to **3** single-select clarifying questions; the user answers each via clickable options (or "Other…" free text / Skip), one at a time. Their answers become a context brief appended to every downstream prompt. `POST /council/intake` → `buildIntake` / `normalizeIntake`.
  2. **Blind & sequential members.** The three "council members" answer **one at a time, each in its own bubble** — never simultaneously, and each **blind** (it sees only the question + PM context, never another member's answer). The client calls `POST /council/member` once per index in turn; `askMember` runs the call.
  3. **Chairman synthesis.** `POST /council/synthesis` → `synthesize` folds the answers into one decisive recommendation.
  Members are configurable in **Settings → Models → Council members** and default to three diverse problem-solvers no other agent uses — `openai/gpt-5.1`, `google/gemini-2.5-pro`, `deepseek/deepseek-r1` (chair = member 1; xAI/grok omitted by default — 404s on accounts whose OpenRouter data policy disallows xAI). Renderer state machine in `councilState` (`MODE_COUNCIL`): `openCouncil → startCouncilIntake → renderCouncilIntake/answerCouncilIntake → runCouncilDeliberation` (`updateCouncilMember` / `setCouncilSynth`); styles under `.council-*` in `style.css`. Inspired by karpathy/llm-council.
- **Custom AI instructions (Settings → Instructions).** New settings tab with a freeform textarea persisted as `AI_INSTRUCTIONS`; injected into **every agent system prompt** (`customInstructionsBlock()` in `orchestrator.js`, both the JSON-tile and prose prompts) and into **all council prompts** (`aiInstructionsBlock()` in `council.js`). Empty by default; the `PUT /settings` handler special-cases it so an empty string can clear it (the generic update loop skips empties).
- **Tests.** Council logic now lives in an importable module with injectable LLM callers (mirroring `kickoff.js`), so it's unit-tested in **`app/server/council.test.js`** (13 tests: model resolution defaults/override/malformed, intake normalization + capping, context assembly, blind member prompt, chair prompt member-numbering, synthesis short-circuit). Full suite **175/175**.

## What's new (previous session — storage, roles, skills)

- **Storage unified under `~/bridge-projects/`.** The cross-project registry (`projects.json`, `tasks.json`, `scratchpad.json`) moved out of the app bundle to `~/bridge-projects/.bridge/` via the new `app/server/state-dir.js` (one-time copy migration from legacy `app/state/`). All per-project files live in the project's own repo (`~/bridge-projects/<slug>/`). Three real bugs fixed in the process: `readProjectCharter` read a legacy path the writers never touched (the orchestrator never saw tailored charters); autosave git-committed the internal state dir instead of the project repo (now commits `project.repoPath` with an inline `-c` identity); `scratchpad.js` ignored `BRIDGE_STATE_DIR`, leaking test writes into the real scratchpad.
- **12-role catalog.** New **Electrical Engineer** (`ee_engineer`, charter `role-ee-eng.md`) owning schematics, PCB layout, power/analog, and fab outputs; the long-failing `listRoles` test (expected 14) is fixed to 12.
- **Skill registry rebuilt around the GitHub Claude-skills ecosystem.** 31 skills, every role covered; adopted entries carry a `source` repo URL (anthropics/skills, obra/superpowers, pbakaus/impeccable, VoltAgent/awesome-claude-design, trailofbits/skills, aklofas/kicad-happy, …). **Skills now inject into agent prompts**: `orchestrator.js` adds a per-role skills section to both system prompts (tile + prose, so the executor inherits it); 13 condensed playbooks vendored at `app/server/skill-playbooks/<id>.md` inject in full, the rest as one-line capabilities; the Settings → Skills toggle now actually gates agent behavior. New API: `skillsForRole(roleId)`, `loadSkillPlaybook(id)`.

## What's new (earlier — scaffold/execution loop)

Code generation/execution loop + a long tail of doc/UX fixes on `feat/scaffold-phase-a`. Highlights:

- **Skill-seeded, PRD-tailored charters.** Baselines (`app/server/role-charters/role-*.md`) are now distilled from best-in-class skills (designer←impeccable, pm←pm-skills, etc.); they're written verbatim at project creation (no API call) and deeply re-tailored from the PRD during kickoff (`deepenCharters`, preserves any `## Plan`). Optional `BRIDGE_CHARTERS_DIR` drops in override charters. Provenance/attribution table lives in `docs/design.md` and `specs/2026-06-08-prd-tailored-charters-design.md`.

- **Phase A scaffold + Phase B execution loop.** After planning, the PM **hands build/scaffolding off to the software engineer** (`ensureBuildAgent`; `kickoff.buildAgentId`): the PM posts a handoff bubble in its chat (with a **"Talk to <name> (<role>)"** button → jumps to that agent), and the build plan + **"Build it" / "Run it"** live in the engineer's chat. "Build it" → `runScaffold` (generate + commit a source tree, `node --check` fix pass). "Run it" → `runAndFix`: install/build/test **in a throwaway Docker container** (`sandbox.js`/`verify.js`/`run-fix.js`), model-fix loop on failure, `classifyFailure` diagnosis. The interpret endpoint routes the build owner's messages during `build_pending`/`run_pending`.
- **Sandbox = `docker` CLI only, no Docker Desktop.** Any daemon works (Colima recommended). Stack-aware provisioning (Prisma → `apt-get openssl`); scaffolds are made self-contained via `SANDBOX_GUIDANCE` (SQLite default, complete Prisma datasource). See `docs/design.md §12.5.5`.
- **Single source-of-truth doc.** New projects seed **`PRD.md`** (not `project.md`); the kickoff **expands** that seed into a full PRD. Specialist plans now live as a **`## Plan` section inside each role charter** (`docs/roles/role-<slug>.md`) — no `plan-*.md`, no Plans folder. Explorer shows **basename labels with `.md`**, no "Notes" folder (top-level docs are loose), and `project.md` (legacy) opens. milestones carry **no week timing**.
- **One question at a time, reliably.** The kickoff **plan bubble is plan-only** (no embedded questions; clarifying questions come as one-at-a-time follow-ups). `startKickoff` is **idempotent** (synchronous claim — never posts two plans). `createProject`/`deleteProject` **clear the scratchpad** for the (deterministic) agent ids, so a reused id (same name → same date-based id) never inherits an old chat. Specialist team-planning questions are real JSON questions (retry, skip-as-last-resort), role-tagged ("Iris (Designer) asks…"), and mentioned teammates are role-tagged too ("Hollis (Legal)").
- **Question bubbles.** "Skip for now" button (left of Submit, equal size, correct kb/gamepad nav order) — advances without recording.
- **Create-flow.** New **"Top features"** step after the objective (threaded into the project + PRD/plan prompts). Project **names are Title Cased**. `/ Type prompt` chip on the name + objective + features capture screens; typed text lands in the box for review (no auto-advance/auto-create).
- **Default model → `anthropic/claude-opus-4.8`** (`models.js` + `server.js`).
- **L2 agent status** shown below the role (top-left, small) — "Waiting for your response" (orange) when a question is pending, work verb when busy.
- **STT failure is clean.** Any transcribe failure shows one toast — **"Cannot connect to speech to text model"** — instead of dumping ffmpeg's banner. Still Parakeet-only (no browser fallback); raw cause is console-logged.

### Earlier in the branch (already committed)

Big feature + a long tail of UX fixes (see `git log 416dec7..HEAD`). Highlights:

- **Multi-agent group chat + working delegation.** A delegate's reply surfaces in the delegating agent's chat as a labeled "foreign" bubble; the handoff renders as a `From → To` bubble. 1:1 delegation actually routes now (`resolveDelegateSpec`). `parseSpec` hardened so rich agent output (wireframes, code) never 500s.
- **Topology-driven routing.** The chosen work topology is injected into the PM's routing prompt and agent system prompts — it now actually shapes assignment/coordination, not just `project.md`.
- **PM auto-kickoff that runs the team (`app/server/kickoff.js`).** Plan-first → one-tap Approve → writes 4 starter docs → asks follow-up questions **one at a time** (numbered "Q1:", as multi-select choice bubbles). Assignment is **role-based** via the PM model and may pick roles not on the team. When all questions are answered → kickoff **complete** → `startTeamWork` **fans out**: each assigned specialist runs its task (`interpretIntent`) and produces a deliverable; **missing roles auto-added** (`addAgent`) with an "Added teammates" PM message + `team_changed` event. A clarify-question's answer becomes that role's task; every on-team role is guaranteed one (gap-filled). State machine on `project.kickoff.status` (`drafting→awaiting_approval→running→asking→done`).
- **Agent tile states via `awaitKind`.** A reply with `choices` → "Waiting for response" (orange, clears on reply); a deliverable → "Task complete" (green, clears on view). Client tracks `agentPending` (`agentId → 'reply'|'view'`); server tags activity events with `awaitKind`. Old `markUnseen`/`unseenAgents` replaced.
- **Multi-select in-bubble choices.** A/B/C buttons in one horizontal **grid row** (uniform height, grows to fit), letter heading + description, **Other = hold-to-talk** free-form (standard mic wave), grayed **Submit** until a pick, "Select one or more" hint. Answered questions render **memorialized** (read-only, picks shown). Selection is **Enter/✕ only** (no Space).
- **Agent grounding.** `RESPONSE_STYLE` now hard-grounds output to markdown docs + code (no Figma/external tools, channels, ETAs). `ROLE_GUIDANCE` adds per-role workflow (e.g. Designer: principles/guidelines/direction/system design → confirm → use cases/flows → confirm → build in code).
- **Delegated task = handoff bubble.** `interpretIntent({ handoff })` records a delegated kickoff task as a PM→agent handoff turn, not a right-aligned "you" bubble.
- **Chat motion.** "…" thinking across agents, typewriter reveal for scripted bubbles, slide-up arrival (current + new), staggered choice entrance, new-bubble highlight.
- **Model defaults.** Reasoning effort defaults to **high**, base temperature **0.8**, richer per-role persona seeds. (Default model is now **opus-4.8** — see latest session.)
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

`node --test "app/server/*.test.js"` (from the repo root) → currently **160/160 pass**. Hermeticity rule: tests MUST set `BRIDGE_STATE_DIR` + `BRIDGE_PROJECTS_BASE` to throwaway temp dirs before importing server modules — never touch the real `~/bridge-projects/.bridge/` registry or `~/bridge-projects/` repos (a past test wiped real data). All state modules (`projects.js`, `tasks.js`, `scratchpad.js`) resolve paths lazily through `state-dir.js`, so the env vars work as long as they're set before first use.

## Known gaps / follow-ups

- **Fan-out cost.** Kickoff completion makes N real high-effort opus calls (one per specialist) + charter generation for any auto-added role. Intended, but real cost/latency.
- **Agent-tile pending state is client-side** (`agentPending` map) — lost on a hard page reload (the live SSE re-establishes it for new events, but an already-pending question won't show until the next event). Persisting it server-side (e.g. from `kickoff.status` / last turn) is a follow-up.
- **"Task complete" clears on view**, "Waiting for response" clears on reply — verify this matches expectations across non-kickoff replies too.
- **`npm run stt`** should set `HF_HOME=build/hf-cache` (and ideally one launch script starts web + STT together).
- **`app/renderer/speech.js`** (browser Web Speech) is now dead code — voice is Parakeet-only.
- **Project id reuse.** Ids are date+slug based; a same-day, same-name project reuses the id (and agent ids). `createProject`/`deleteProject` now clear the scratchpad to compensate, but a counter/random suffix on collision would be cleaner.
- **Skill playbook coverage.** 13 of 31 skills have vendored playbooks; the rest inject as one-liners. Worth writing playbooks for the remaining high-traffic ones (discovery, prd, ux-flows) and refreshing vendored ones against their upstream `source` repos occasionally.
- The app is **unsigned/un-notarized** if packaged — rebuild from `main` to ship these changes; sign with team `935434BZ22` for distribution.

## Design docs

`docs/superpowers/specs/2026-06-03-pm-kickoff-design.md` and `docs/superpowers/plans/2026-06-03-pm-kickoff.md` (gitignored, per the repo's `docs/` convention).
