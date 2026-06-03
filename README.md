# Bridge

Bridge is an **AI-first command center for managing multi-agent work** — a productivity surface for running teams of role-typed AI agents across multiple projects. You describe intent; the orchestrator routes it to the right agents, combines cloud and local models, and composes a consistent, navigable surface that's read back to you. The goal is to make *coordinating a team of agents* — assigning, steering, and tracking their work — fast and low-friction.

It's built around **diverse input modalities**, so you can drive it however suits you (and however you're able to):

- **Voice** — hold to talk; speech-to-text runs **locally via Parakeet** (your audio never leaves the machine for transcription), and results are spoken back.
- **Gamepad** — every on-screen action maps to a controller glyph to maximize input speed.
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
- **Topology-shaped teams.** Creating a project walks you through *roles → topology → name → goal*. The **work topology** — Hub-and-spoke, Rotating lead, Mesh / mob, Feature teams, or Async pull / queue — defines how the team coordinates, and is written into the project's `project.md` as its operating rule.
- **Voice-first, controller-navigable.** Hold to talk; every on-screen action shows its controller glyph (✕ select, ○ back, L1/R1 switch, R2 push-to-talk). Keyboard mirrors all of it.
- **The model assembles, it doesn't author.** Agents return a small structured spec; a deterministic renderer turns it into a consistent surface — fast, cheap, and visually stable (which matters for spatial memory and accessibility).
- **Spoken results.** Answers and confirmations are read aloud via text-to-speech.

For the full vision and design rationale see the (local, unpublished) `docs/` folder.

---

## Features

- **Multi-project command center** — run many projects, each with its own agent team and state.
- **Role-typed agent teams** — PM lead + specialists (Software/Hardware Engineer, Designer, QA, Data Scientist, Security, Researcher, Copywriter, Marketing, Legal); every agent has a globally unique name and a persistent identity.
- **Work topologies** — pick how a team coordinates (Hub-and-spoke, Rotating lead, Mesh / mob, Feature teams, Async pull / queue); the rule is written into the project's `project.md`.
- **Three-level navigation** — projects → team grid → agent view, consistent for spatial/motor memory.
- **Voice in, voice out** — push-to-talk capture (local **Parakeet** STT or the browser's Web Speech) with spoken results (TTS).
- **Controller + keyboard parity** — every action shows its PlayStation glyph; full keyboard mirror; type-prompt fallback (`/`).
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
│   • STT (browser Web Speech *or* local Parakeet), TTS       │
│   • deterministic tile/surface renderer                     │
└──────────────────────────────────────────────────────────────┘
```

- **AI** is via **OpenRouter** (one integration, many models, per-role model overrides).
- **Speech-to-text** is either the browser's Web Speech API or a bundled local **Parakeet** (MLX) Python sidecar — set `LOCAL_STT_URL` to use the latter. **Text-to-speech** uses the OS voice (`speechSynthesis`).
- **State** for each project (notes, conversation, optional git auto-save) lives under `app/state/<projectId>/` (git-ignored).

---

## Getting started (development)

**Prerequisites:** Node 20+, npm, and Google Chrome installed. macOS (Apple Silicon) for packaging.

```bash
# 1. install dependencies (root = Electron host; server has its own deps)
npm install
cd app/server && npm install && cd ../..

# 2. add your OpenRouter key (or set it later in the in-app Settings)
#    app/server/.env:
#      OPENROUTER_API_KEY=sk-or-...
#      OPENROUTER_MODEL=anthropic/claude-sonnet-4.6

# 3. run the app
npm run dev          # launches Electron → server on :4317 → window
```

Without an OpenRouter key the app still runs; AI answers are disabled until you add one (Settings → General, or the `.env`).

Run just the web server (drive it in Chrome at `http://localhost:4317`):

```bash
npm run server
```

### Optional: local speech-to-text (Parakeet)

```bash
# create app/stt/.venv and install parakeet-mlx, then:
npm run stt          # starts the Parakeet sidecar on :8123
```
Set `LOCAL_STT_URL=http://127.0.0.1:8123/transcribe` (Settings → General) to route voice through it instead of the browser engine. Leave blank to use the browser's built-in recognition.

---

## Controls

| Action | Keyboard | Controller (PS5/Xbox) |
|---|---|---|
| Push-to-talk | hold **V** | hold **R2 / RT** |
| Navigate | arrows / **Tab** (into footer) | D-pad / left stick |
| Select / confirm | **Enter** | **✕ / A** |
| Back / cancel | **Esc** | **○ / B** |
| Switch agent | **[** / **]** | **L1 / R1** |
| Activity feed | **A** | — |
| Memory | **M** | — |
| Files | **E** | — |
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
├── charters.js      # per-project role charters (role-<label>.md base templates)
├── skills.js        # agent skill (playbook) registry — toggled in Settings → Skills
├── scratchpad.js    # per-agent conversation context
├── events.js        # SSE event bus (status / activity / delegate / notification)
└── backends/notes.js# project-scoped markdown notes

app/renderer/
├── index.html · style.css
├── main.js          # nav modes (L0/L1/L2 + create flow), dispatch, action exec
├── gamepad.js       # Gamepad API → semantic events
├── speech.js        # Web Speech STT + TTS
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
