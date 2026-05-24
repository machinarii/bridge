# Bridge — Multi-Agent Command Center

A voice/joystick command surface for running multiple projects, each with a
crew of role-typed AI agents. Built on Node + Express and a vanilla-JS
fullscreen Chrome renderer driven by a Gamepad / Web Speech / keyboard.

Three-level navigation:

- **L0 Project picker** — pick an existing project or `+ New`.
- **L1 Project grid** — reflow grid of role agents; lead pulses during
  team voice; Square enables/disables an agent (lead is protected).
- **L2 Agent zoom** — push-to-talk an individual agent; tile spec renders
  the response and TTS speaks the body.

See `../docs/superpowers/specs/2026-05-22-projects-and-roles-design.md`
for the architecture.

## What's here

```
app/
├── server/                          # Node orchestrator
│   ├── server.js                    # Express: /roles, /projects, /team, /files
│   ├── orchestrator.js              # Per-agent interpret with charter
│   ├── projects.js                  # Projects store + folder scaffold
│   ├── roles.js                     # 14-role catalog
│   ├── charters.js                  # Role-charter generation
│   ├── team.js                      # Router → fan-out → synthesizer
│   ├── scratchpad.js                # Per-agent conversation context
│   ├── backends/notes.js            # Project-scoped markdown notes
│   └── *.test.js                    # node:test runners
├── renderer/                        # Fullscreen Chrome web app
│   ├── index.html                   # surface + history/file drawers
│   ├── style.css
│   ├── main.js                      # nav modes, dispatch, action exec
│   ├── gamepad.js                   # Gamepad API → semantic events
│   ├── speech.js                    # Web Speech STT + TTS
│   ├── focus.js                     # focus ring
│   └── tiles.js                     # 4-template renderer
└── state/                           # runtime — gitignored
    ├── projects.json
    ├── scratchpad.json
    └── <projectId>/                 # per-project: project.md, roles/, notes/
```

## Run it

Requires Node 20+ and Chrome (Web Speech and Gamepad APIs).

```bash
cd app/server
cp .env.example .env          # put your OPENROUTER_API_KEY here
npm install
npm run dev                   # http://localhost:4317
```

Open Chrome → http://localhost:4317 → press **F11** for true fullscreen.

Without an OpenRouter key, single-agent prompts fall back to a tiny local
classifier and team voice is blocked with a clear message.

## Inputs

| Action            | Keyboard            | DualSense           |
|---|---|---|
| Push-to-talk      | hold **v**          | hold **R2**         |
| Navigate          | arrows              | D-pad / left stick  |
| Select / confirm  | **Enter**           | **Cross**           |
| Back              | **Esc**             | **Circle**          |
| Toggle on/off     | **Space**           | **Square**          |
| History drawer    | **t**               | **Triangle** (at L2)|
| File explorer     | **\\**              | **Options**         |
| Switch agent      | **[** / **]**       | **L1** / **R1**     |
| Slide project     | **Opt** + **←/→**   | —                   |
| Typed fallback    | **/**               | —                   |

Keyboard model: **Enter** selects/advances, **Esc** goes back, **Space**
toggles the focused thing on/off — toggles a role in the role picker,
toggles an agent's enabled flag at L1. Voice is on **v** (hold).

## Tile spec contract (the model's only output)

```jsonc
{
  "intent":  "take_note" | "list_notes" | "answer",
  "template": "compose" | "list" | "reader" | "confirm",
  "context": "string shown at top",
  "title":   "string",
  "body":    "string (compose/reader)",
  "items":   [{ "id": "...", "label": "..." }],
  "actions": [{ "verb": "Save", "glyph": "cross", "action": { "type": "save_note" } }]
}
```

Adding a new action = add a case in `main.js#executeAction`.

## Tests

```bash
cd app/server && npm test
```
