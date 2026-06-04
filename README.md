# Bridge

## Command center for multi-agentic orchestration using Speech to Text (STT) + gamepad for increased productivity.

Bridge is an **Command center for managing multi-agent work** — a productivity surface for running teams of role-based AI agents across multiple projects. You describe intent; the orchestrator routes it to the right agents, and composes a consistent, navigable surface. Agents work **in parallel** — many run at once across your projects — and can define work topology so that agents can work dynamically. The goal is to make *coordinating a team of agents* — assigning, steering, and tracking their work — fast, low-friction and goal-oriented.

It's built around **diverse input modalities**, so you can drive it however suits you (and however you're able to):

- **Voice** — hold to talk; speech-to-text runs **locally via Parakeet** (your audio never leaves the machine for transcription) and appears live in the chat as you speak.
- **Gamepad** *(PlayStation 5 DualSense only, for now)* — the fastest way to switch from project to project and agent to agent. Every on-screen action maps to a controller glyph, so **switching is a single button at your fingertips** (L1/R1 to cycle, ✕ to select) — no cursor travel. A trackpad or mouse forces you to move the pointer, aim at a tab, click, and repeat that whole trip every time you want to switch; the gamepad collapses it to one press, which adds up fast when you're hopping across many projects and agents.
- **Keyboard** — full parity with the controller.
- **Trackpad / mouse** — click any tile, chip, or action to select; standard pointer navigation.
- **Remote** *(planned)* — drive a Bridge session from a phone or second device.

Agents are powered by **any model on OpenRouter** (choose a default and override per role), and **speech-to-text runs locally with the Parakeet model**. It runs as a macOS desktop app (Electron).

---

## Core ideas

- **Projects → agents → conversation.** Work is organized into *projects*, each staffed by a small team of *role-typed agents* (Product Manager, Software & Hardware Engineer, Designer, QA, Data Scientist, Security, Researcher, Copywriter, Marketing, Legal). Each agent has a globally unique name and a persistent identity. You navigate three levels:
  - **L0 — Projects:** pick a project (or create one) and talk to its lead.
  - **L1 — Team grid:** the project's agents as tiles.
  - **L2 — Agent view:** zoom into one agent and converse.
- **Parallel agents & subagents.** Agents run *concurrently* rather than one-at-a-time — you can have several projects' teams working at once — and any agent can **delegate to a teammate**, splitting a big task into pieces and synthesizing the results back into one answer. A delegate's reply surfaces in the chat as a labeled bubble (group-chat style), with a `From → To` handoff marker so you can follow who did what.
- **Plan-first PM kickoff.** Create a project and the PM immediately drafts a **kickoff plan** in the lead chat — *Approve* (button or just say so) and it generates a PRD plus a roadmap, team operating notes, and an open-questions doc (saved as project files), assigns each teammate a topology-shaped starting task, then comes back with follow-up questions. *Reject* holds it off.
- **Topology-shaped teams.** Creating a project walks you through *roles → topology → name → goal*. The **work topology** — Hub-and-spoke, Rotating lead, Mesh / mob, Feature teams, or Async pull / queue — is written into `project.md` *and* injected into the PM's routing prompt, so it actually shapes how work is assigned and whether teammates report back or coordinate.
- **Agents ask, not guess.** When direction is unclear an agent offers **2–4 choices** as a selectable list right in the bubble; your pick becomes your next message. Agents follow a shared house style (legible reasoning, telegraphic bullets, banned clichés).
- **Voice-first, controller-navigable.** Hold to talk; every on-screen action shows its controller glyph (✕ select, ○ back, L1/R1 switch, R2 push-to-talk). Keyboard mirrors all of it.
- **The model assembles, it doesn't author.** Agents return a small structured spec; a deterministic renderer turns it into a consistent surface — fast, cheap, and visually stable (which matters for spatial memory and accessibility).
- **Live, optimistic UI.** Your prompt shows up as a bubble the instant you speak (typing animation → live transcript), an agent "…" bubble appears immediately on submit, and the reply streams in token-by-token — no dead air.
- **Steerable reasoning.** Hold the controller touchpad (or `T`) and nudge up/down to set how hard the model thinks — Low → Max — per request; *redo* re-rolls an answer in place and escalates temperature + reasoning each time.

For the full vision and design rationale see the (local, unpublished) `docs/` folder.

---

## Features

- **Multi-project command center** — run many projects, each with its own agent team and state.
- **Role-typed agent teams** — PM lead + specialists (Software/Hardware Engineer, Designer, QA, Data Scientist, Security, Researcher, Copywriter, Marketing, Legal); every agent has a globally unique name and a persistent identity.
- **Work topologies** — pick how a team coordinates (Hub-and-spoke, Rotating lead, Mesh / mob, Feature teams, Async pull / queue); the rule is written into `project.md` and drives the PM's routing.
- **PM auto-kickoff** — on project creation the PM proposes a plan-first kickoff; on approval it drafts PRD + roadmap + operating-notes + open-questions docs, assigns topology-shaped tasks, and asks follow-up questions.
- **In-bubble choices** — agents offer 2–4 selectable options when a decision is needed; pick one to continue.
- **"Waiting for response" tiles** — an agent's L1 tile glows and reads *Waiting for response* once it's produced a message that's awaiting your reply.
- **Three-level navigation** — projects → team grid → agent view, consistent for spatial/motor memory.
- **Voice input with live transcript** — hold **V** / **R2** to talk; transcription runs **locally via Parakeet** and streams word-by-word into the box. *(STT is local-only — never the browser engine; text-to-speech is off in this build.)*
- **Controller + keyboard parity** — every action shows its PlayStation glyph; arrows and the d-pad share one navigation model (rubberband at list edges, Down into the footer rail, Up to the × close, reading-order Left/Right); type-prompt fallback (`/`).
- **Steerable reasoning effort** — hold the touchpad / `T` and nudge Up/Down to pick Low · Medium · High · Extra · Max; the orchestrator maps it to a per-request reasoning budget (reasoning-capable models only).
- **Redo / regenerate** — re-roll a prompt's answer in place; each consecutive redo escalates temperature (variety) and reasoning effort (quality).
- **Deterministic surfaces** — agents emit a small structured spec; a fixed renderer turns it into a stable, navigable UI (fast, cheap, accessible).
- **Per-role model routing** — different OpenRouter model per role, plus a fast **router model** for team-voice classification.
- **Agent skills** — toggle the playbooks (discovery, TDD, code review, positioning, …) the team can draw on (Settings → Skills).
- **Activity feed, memory, and file explorer** drawers; per-project notes with optional **git auto-save**.
- **GitHub pairing** — connect your GitHub account from Settings via a **keyboard-free OAuth device flow** (scan a QR on your phone or open a pre-filled authorize link on-device).
- **Settings** — OpenRouter key, default + per-role + router models, agent skill toggles, git auto-save, GitHub pairing (MCP plugins coming soon).

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electron host (app/electron/main.js)                      │
│   • boots the Express server in-process                    │
│   • optionally spawns the local Parakeet STT sidecar       │
│   • opens a BrowserWindow on http://127.0.0.1:4317         │
└───────────────┬────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│  Orchestrator — Express server (app/server/server.js)       │
│   • REST + SSE API (projects, agents, notes, settings, …)   │
│   • interprets intent via OpenRouter → response/spec        │
│   • serves the renderer + static assets                     │
└───────────────┬────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│  Renderer — vanilla-JS web app (app/renderer/)              │
│   • Gamepad API + keyboard input, push-to-talk              │
│   • STT via the local Parakeet sidecar (/transcribe)        │
│   • deterministic tile/surface renderer                     │
└──────────────────────────────────────────────────────────────┘
```

- **AI** is via **OpenRouter** (one integration, many models, per-role model overrides).
- **Speech-to-text** runs **only** on the bundled local **Parakeet** (MLX) Python sidecar (`LOCAL_STT_URL`, default `127.0.0.1:8123`) — it never falls back to the browser engine; a failure surfaces on the capture screen instead. **Text-to-speech** is disabled in this build (no OS voice output).
- **State** for each project (notes, conversation, optional git auto-save) lives under `app/state/<projectId>/` (git-ignored).

---

## Getting started (development)

**Prerequisites:** Node 20+, npm, and Google Chrome installed. macOS (Apple Silicon) for packaging.

```bash
# 1. install dependencies (root = Electron host; server has its own deps)
npm install
cd app/server && npm install && cd ../..

# 2. add your OpenRouter key (or set it later in the in-app Settings)
#    cp app/server/.env.example app/server/.env   # then edit:
#      OPENROUTER_API_KEY=sk-or-...
#      OPENROUTER_MODEL=anthropic/claude-sonnet-4.6
#    (.env is git-ignored — never commit personal credentials)

# 3. run the app
npm run dev          # launches Electron → server on :4317 → window
```

Without an OpenRouter key the app still runs; AI answers are disabled until you add one (Settings → General, or the `.env`).

Run just the web server (drive it in Chrome at `http://localhost:4317`):

```bash
npm run server
```

### Local speech-to-text (Parakeet) — required for voice

Voice always uses the local Parakeet sidecar (never the browser engine), so it must be running:

```bash
python3 -m venv app/stt/.venv
app/stt/.venv/bin/pip install -r app/stt/requirements.txt
# the ~600MB model is cached under build/hf-cache from a prior packaging run;
# point HF_HOME there to skip re-downloading it:
HF_HOME="$PWD/build/hf-cache" npm run stt     # serves Parakeet on :8123
```
The server defaults `LOCAL_STT_URL` to `http://127.0.0.1:8123/transcribe`. Requires **ffmpeg** on PATH (Parakeet decodes the browser's webm/opus through it). Without the sidecar, voice fails with a visible STT error rather than falling back.

### Fonts

Font files are **not bundled in this repository** — the licensing on the
typefaces used (e.g. **Dosis**) is limited and doesn't permit redistributing
them here. Most type loads from Google Fonts via a `<link>` in `index.html`; any
local font files belong under `app/assets/fonts/` (git-ignored). Supply the
matching files there yourself for the intended look — otherwise the UI falls
back to system fonts.

---

## Controls

> **Controller support:** only the **PlayStation 5 DualSense** is supported right
> now (glyphs and the touchpad binding assume it). Other controllers aren't
> mapped yet.

| Action | Keyboard | Controller (PS5 DualSense) |
|---|---|---|
| Push-to-talk | hold **V** | hold **R2 / RT** |
| Navigate | arrows / **Tab** (into footer) | D-pad / left stick |
| Select / confirm | **Enter** | **✕ / A** |
| Back / cancel | **Esc** | **○ / B** |
| Switch agent (L2) / project (L1) | **[** / **]** | **L1 / R1** |
| Scroll chat history (L2) | arrows | **right stick** |
| Reasoning effort | hold **T** + ↑/↓ | hold **touchpad** + stick/d-pad ↑/↓ |
| Activity feed | **A** | **△** |
| Explorer (files) | **E** | **□** |
| Agent on / off (L1) | **Space** | **Menu / Options** |
| Memory (L0) | **M** | **□** |
| Type instead of speak | **/** | — |
| Full screen | **⌘F** | — |

---

## Settings

Open Settings from the footer (⚙). Tabs:

- **General** — OpenRouter API key, default model, local STT URL.
- **Models** — per-role model overrides (route each role to a different model).
- **Skills** — activate/deactivate the agent **playbook skills** (model-agnostic
  how-to-do-the-work guides, e.g. discovery, TDD, code review, positioning) the
  team can draw on.
- **MCP** — register MCP plugins *(coming soon)*.
- **Git** — auto-save each project's state to its git repo on an interval.

---

## Project layout

```
app/
├── electron/      # Electron host (main process) + STT setup
├── server/        # Express orchestrator: API, OpenRouter calls, static serving
├── renderer/      # UI: input, speech, gamepad icons, deterministic surfaces
├── assets/fonts/  # local font files (git-ignored — not redistributed, see Fonts)
├── stt/           # optional local Parakeet (MLX) speech-to-text sidecar
└── state/         # per-project state + git repos (git-ignored)
build/             # app icon, entitlements, Python/STT packaging scripts
docs/              # internal design + planning notes (git-ignored, not published)
```

### Key modules

```
app/server/
├── server.js        # Express: REST + SSE (projects, agents, notes, settings, skills, …)
├── orchestrator.js  # per-agent intent → tile spec, using the role charter
├── team.js          # team voice: router → fan-out → synthesizer
├── projects.js      # projects store + per-project folder scaffold
├── roles.js         # role catalog (PM, Software/Hardware Engineer, Designer, …)
├── charters.js      # per-project role charters (role-<slug>.md, no underscores; short slugs via CHARTER_SLUG_OVERRIDE)
├── skills.js        # agent skill (playbook) registry — toggled in Settings → Skills
├── scratchpad.js    # per-agent conversation context
├── events.js        # SSE event bus (status / activity / delegate / notification)
└── backends/notes.js# project-scoped markdown notes

app/renderer/
├── index.html · style.css
├── main.js          # nav modes (L0/L1/L2 + create flow), dispatch, action exec
├── gamepad.js       # Gamepad API → semantic events
├── speech.js        # Web Speech STT (TTS disabled)
├── tiles.js         # deterministic tile/surface renderer
└── gamepad-icons.js # PlayStation glyph set
```

---

## Tile spec — the model's only output

Agents don't author UI. They return a small structured spec; the renderer turns
it into a consistent, controller-navigable surface.

```jsonc
{
  "intent":   "take_note" | "list_notes" | "answer",
  "template": "compose" | "list" | "reader" | "confirm",
  "context":  "string shown at top",
  "title":    "string",
  "body":     "string (compose/reader)",
  "items":    [{ "id": "...", "label": "..." }],
  "actions":  [{ "verb": "Save", "glyph": "cross", "action": { "type": "save_note" } }]
}
```

Adding a new action = add a case in `app/renderer/main.js → executeAction`.

---

## Tests

```bash
cd app/server && npm test     # node:test runners (projects, charters, …)
```

---

## License

MIT — see [LICENSE](LICENSE).
