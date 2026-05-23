# MVP PRD — Bridge 3-Day Prototype

> **Status:** MVP scope · **Author:** Jin · **Timebox:** 3 days · **Companion to:** PRD-bridge-ai-first-os.md (v0.4)
> This is a deliberately ruthless subset. Where it diverges from the full PRD, it says so. Divergences are *prototype shortcuts*, not design changes.

---

## 1. The one thing this proves

**The loop:** express intent (voice or joystick) → AI composes a controller-navigable surface from a small tile kit → user navigates with the gamepad → a real action executes → result is shown and spoken.

If that loop feels alive and works end-to-end on **2–3 intents**, the prototype is a success. Nothing else matters for 3 days. This is the §10 "spike the riskiest thing first" reduced to its core.

**Explicit non-goal:** this is not a small Bridge. It is a *proof of the interaction loop*. Breadth, polish, and the full feature bundle are out.

---

## 2. Deliberate shortcuts (divergences from the full PRD)

| Full PRD says | 3-day prototype does | Why |
|---|---|---|
| Custom/Sway compositor, hidden apps | **Run as one fullscreen web app on existing Ubuntu/desktop** | Owning the compositor is days of work and irrelevant to proving the loop. |
| Cloud STT/TTS via OpenRouter (§5) | **Browser Web Speech API** (Chrome) for STT + TTS | Zero integration; erases the audio pipeline risk. Swap to cloud later. |
| Xbox Adaptive Joystick via evdev/HID | **Browser Gamepad API** | Native controller support, no drivers. |
| Wake word + PTT (§3.2) | **PTT only** (a gamepad button / keyboard key) | Simpler, more reliable; wake word is pure risk in 3 days. |
| Tiered T1/T2/T3 app-driving, browser reinterpret (§4.3, §13.5) | **Local zero-auth backends only** | Auth is the #1 time-sink; local backends prove "drive a real capability" without it. |
| Configurable per-task model map (§5.6) | **One OpenRouter model** | Routing is a config nicety, not loop-critical. |
| Full design system / many tiles (§6.4–6.5) | **4 tiles** + 1 baseplate | Enough to prove generative-UI composition. |
| Browser, email, Signal as v1 must-haves (§13) | **Notes + LLM-answer** as the demo; Spotify/Signal = stretch | Removes auth from the critical path. |
| Offline-survival, persistence, accessibility hardware tuning | **Cut** | Out of scope for a loop proof. |

---

## 3. Architecture (prototype)

```
┌─────────────────────────────────────────────┐
│  FULLSCREEN WEB APP (Chrome) — the renderer   │
│  - Gamepad API (controller input)             │
│  - Web Speech API (STT in + TTS out)          │
│  - PTT button → capture speech                │
│  - Renders 4 tiles into the fixed baseplate   │
│  - D-pad = focus, A = select, B = back        │
└───────────────┬───────────────────────────────┘
                │ HTTP (localhost): {audio→text or text} ↔ {tile-spec JSON}
┌───────────────▼───────────────────────────────┐
│  ORCHESTRATOR (local Node or Python server)    │
│  - Receives intent text                        │
│  - Calls OpenRouter → returns a TILE SPEC      │
│  - Executes selected actions on backends       │
└───────────────┬───────────────────────────────┘
                │ subprocess / file I/O
┌───────────────▼───────────────────────────────┐
│  LOCAL BACKENDS (zero auth)                     │
│  - Notes: read/append local Markdown files      │
│  - Answer: LLM direct response (no backend)     │
│  - (stretch) Spotify or signal-cli              │
└─────────────────────────────────────────────────┘
```

Stack choice: **web renderer + small local server.** Node is the path of least resistance (one language, easy OpenRouter calls); Python is fine if preferred (better for later evdev/gamepad-native work). Renderer reuses the design-system approach from PRD §6.5 in plain HTML/CSS.

---

## 4. The tile kit (4 tiles + baseplate)

Minimal subset of PRD §6.5. The model emits a spec; a deterministic renderer draws it.

- **`ContextStrip`** (frame, top) — current intent / "where am I".
- **`ActionBar`** (frame, bottom) — verbs with controller glyphs (A/B/X).
- **`List`** — focusable items; D-pad moves focus, A selects.
- **`Reader`** — long text; TTS reads it aloud.
- **`Compose`** — shows dictated text for review before an action.
- **`Confirm`** — A = confirm, B = cancel (the safety gate, §8 of full PRD, kept).

Spec schema (the model's only output):
```json
{
  "template": "list" | "reader" | "compose" | "confirm",
  "context": "Your notes",
  "title": "…",
  "items": [{ "id": "n1", "label": "…" }],
  "body": "…",
  "actions": [{ "verb": "open", "glyph": "A" }, { "verb": "back", "glyph": "B" }]
}
```

---

## 5. Demo intents (the guaranteed core)

Three end-to-end intents, all zero-auth. Each must work by voice **and** be navigable by joystick.

1. **"Take a note: <content>"** → `Compose` tile shows the captured text → `Confirm` (A) → appends to a local Markdown file → spoken confirmation.
2. **"Show / read my notes"** → `List` of notes → select (A) → `Reader` opens one → TTS reads it aloud.
3. **"<any question>"** (e.g. "what's the capital of France", "convert 50 miles to km") → `Reader` with the LLM's answer, read aloud. *(Demonstrates the "AI absorbs utility apps" idea — calculator/lookup with no app, PRD §13.2.)*

**Stretch (only if Day 3 has time):** one networked action — "play <song>" via Spotify, or "message <contact>" via signal-cli. Treat as bonus; do not let it threaten the core.

---

## 6. Three-day plan

**Day 1 — the empty loop runs.**
- Renderer shell fullscreen; Gamepad API reads the controller; D-pad moves a focus highlight; A/B fire events.
- Web Speech API: PTT button starts recognition → text; TTS speaks a test string.
- Local server up; one OpenRouter call returns a (first hardcoded, then real) tile spec.
- **End-of-day bar:** press PTT, say anything, see *a* tile render, navigate it with the D-pad. The loop is closed even if dumb.

**Day 2 — the three intents work.**
- Implement the 4-tile renderer against the spec schema.
- Prompt the model to classify intent and emit the right spec.
- Wire backends: notes (append/read Markdown), LLM-answer (passthrough). Confirm gate on the note write.
- **End-of-day bar:** all three intents work end-to-end by voice + joystick.

**Day 3 — make it feel alive + demo-proof.**
- TTS readback on every result; immediate local UI acknowledgment on PTT (listening indicator) so nothing feels dead (PRD latency rule).
- Harden the happy path; handle the obvious failure (no speech detected, empty result).
- Stretch networked action *only if* ahead of schedule.
- Write a 5-step demo script; rehearse it. **Reserve the last few hours as buffer** — something will break.

---

## 7. Success criteria

- [ ] PTT → speech → a tailored tile surface appears (proves intent→generative-UI).
- [ ] The surface is fully navigable by the Xbox controller (D-pad + A/B), no mouse/keyboard needed.
- [ ] At least 2 of the 3 intents execute a real action end-to-end.
- [ ] Results are spoken aloud.
- [ ] The loop feels responsive — visible/audible acknowledgment within a moment of input.

If all five hold, the core thesis is demonstrated.

---

## 8. Risks & cuts-of-last-resort

| Risk | Mitigation / fallback |
|---|---|
| Web Speech API flaky / browser-specific | Use Chrome specifically; keep a typed-text input as the absolute fallback to demo the rest of the loop. |
| Gamepad mapping quirks | Test the actual controller Day 1, not Day 3; hardcode the button map. |
| OpenRouter latency makes it feel dead | Show the listening/thinking state immediately; never block the UI on the call. |
| Intent classification unreliable | Keep to 3 well-separated intents; give the model few-shot examples in the prompt. |
| Behind schedule end of Day 2 | Cut to **2 intents** (note + answer); cut the stretch action; cut all polish. The loop with 2 intents still proves the thesis. |

**The one thing never to cut:** the closed loop (voice/joystick → spec → render → navigate → action). If forced, ship one intent that does the full loop rather than three that don't.

---

*This MVP PRD is intentionally narrow. The full vision, tooling, and platform analysis live in PRD-bridge-ai-first-os.md (v0.4). After the prototype validates the loop, the build sequence in that doc's §10 picks up.*

---

## 9. Source dependencies (reference repos in `source/`)

The 3-day prototype itself needs **zero** of these — it runs in Chrome and uses Web Speech API + Gamepad API + one OpenRouter call. The `source/` folder exists as a **reference + fork target** for the post-MVP build path described in the full PRD (§10 build sequence, §13.7 backend tooling, §11 future compositor).

Use this folder as the reading library for building customized solutions: read the code to understand interfaces, fork what gets instrumented (T1 apps per §4.3), link/build what gets used as-is.

### 9.1 Compositor & shell (PRD §4, §6.2, §11)

| Repo | Purpose | Status |
|---|---|---|
| **sway** (https://github.com/swaywm/sway) | Wayland compositor — Bridge's substrate in v1 | ✅ cloned |
| **wlroots** (https://gitlab.freedesktop.org/wlroots/wlroots) | Compositor library Sway is built on; needed to understand/extend surface routing | clone |
| **Smithay** (https://github.com/Smithay/smithay) | Rust compositor framework — the §11 future custom compositor target | clone |
| **Astal / AGS** (https://github.com/Aylur/astal) | Programmable shell / widget system for wlroots — candidate renderer host (§6.2) | clone |
| **eww** (https://github.com/elkowar/eww) | Alternative scriptable widget system — second candidate for §6.2 | clone |

### 9.2 Input (PRD §3.3, §7)

| Repo | Purpose | Status |
|---|---|---|
| **libinput** (https://gitlab.freedesktop.org/libinput/libinput) | Wayland input stack — reference for evdev/HID joystick path beyond browser Gamepad API | clone |

### 9.3 Voice — local fallback / offline-survival (PRD §5.5)

| Repo | Purpose | Status |
|---|---|---|
| **whisper.cpp** (https://github.com/ggerganov/whisper.cpp) | Local STT for offline-survival mode | clone |
| **piper** (https://github.com/rhasspy/piper) | Local TTS fallback (PRD §5.5) | clone |

> Cloud STT/TTS in v1 is via OpenRouter / hosted APIs — no repo to clone (HTTP only).

### 9.4 Backend capabilities (PRD §13.7) — daemons/CLIs/libraries to drive headlessly

| Repo | Purpose | Status |
|---|---|---|
| **signal-cli** (https://github.com/AsamK/signal-cli) | Signal messaging (v1 must-have, §13) | clone |
| **isync / mbsync** (https://sourceforge.net/projects/isync/) — mirror at https://github.com/gburd/isync | IMAP sync — email backend | clone |
| **msmtp** (https://git.marlam.de/gitweb/?p=msmtp.git) — mirror at https://github.com/marlam/msmtp-mirror | SMTP send — email backend | clone |
| **notmuch** (https://git.notmuchmail.org/) — mirror at https://github.com/notmuch/notmuch | Indexed mail search/tag | clone |
| **khal** (https://github.com/pimutils/khal) | CalDAV calendar CLI | clone |
| **vdirsyncer** (https://github.com/pimutils/vdirsyncer) | CalDAV/CardDAV sync | clone |
| **mpd** (https://github.com/MusicPlayerDaemon/MPD) | Music player daemon — media backend | clone |
| **ripgrep** (https://github.com/BurntSushi/ripgrep) | File-content search — replaces file manager (§13.2) | clone |
| **fd** (https://github.com/sharkdp/fd) | File find — replaces file manager (§13.2) | clone |
| **mupdf** (https://github.com/ArtifexSoftware/mupdf) | PDF render/extract (§13.7 reading) | clone |
| **poppler** (https://gitlab.freedesktop.org/poppler/poppler) | PDF text extraction (`pdftotext`) | clone |
| **pandoc** (https://github.com/jgm/pandoc) | Document conversion — non-.docx documents (§13.7) | clone |
| **taskwarrior** (https://github.com/GothenburgBitFactory/taskwarrior) | Todo/reminder backend (§13.7) | clone |

### 9.5 Browser surface (PRD §13.5, "keystone")

Chromium / CEF is the rendering surface driven via CDP. **Not cloned** — the source is gigabytes and impractical to vendor; reference upstream docs (https://chromedevtools.github.io/devtools-protocol/) and pull binaries when needed. LibreOffice (`--headless`, .docx fidelity fallback) is similarly excluded for size.

### 9.6 House rules

- These repos are **read-only reference** unless explicitly forked for T1 instrumentation (§4.3). Don't edit in place; fork into a sibling folder when modifying.
- When a piece moves from reference to fork, note it in this section (mark "forked → `source-forks/<name>`").
- Keep `source/` out of any future Bridge repo — vendor by submodule or document-clone instructions, not by checking in millions of lines.
