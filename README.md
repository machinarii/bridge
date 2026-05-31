# Bridge

Bridge is an **AI-first, accessibility-first command center for multi-agent work**. Instead of windows and a pointer, you talk to a team of AI agents and navigate everything with a game controller (or keyboard). You express intent by voice; the orchestrator interprets it, drives local capabilities, and composes a controller-navigable surface that's read back to you.

It runs as a macOS desktop app (Electron) and is designed so that voice + a single joystick are enough to operate it end to end.

---

## Core ideas

- **Projects → agents → conversation.** Work is organized into *projects*, each staffed by a small team of *role-typed agents* (PM, engineer, designer, …). You navigate three levels:
  - **L0 — Projects:** pick a project (or create one) and talk to its lead.
  - **L1 — Team grid:** the project's agents as tiles.
  - **L2 — Agent view:** zoom into one agent and converse.
- **Voice-first, controller-navigable.** Hold to talk; every on-screen action shows its controller glyph (✕ select, ○ back, L1/R1 switch, R2 push-to-talk). Keyboard mirrors all of it.
- **The model assembles, it doesn't author.** Agents return a small structured spec; a deterministic renderer turns it into a consistent surface — fast, cheap, and visually stable (which matters for spatial memory and accessibility).
- **Spoken results.** Answers and confirmations are read aloud via text-to-speech.

For the full vision and design rationale see the (local, unpublished) `docs/` folder.

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

---

## Building the macOS app

```bash
npm run build:mac          # fetches Python, prepares STT, runs electron-builder (arm64 DMG + zip)
```

The build is configured for **hardened-runtime signing + notarization** (`build/entitlements.mac.plist`, `package.json → build.mac`). To produce a signed, notarized, distributable build you need a **Developer ID Application** certificate (paid Apple Developer Program) in your keychain, then:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run build:mac
```

electron-builder signs (including the bundled Node/Python binaries), notarizes via notarytool, and staples the ticket. Output lands in `dist/`.

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

---

## License

MIT — see [LICENSE](LICENSE).
