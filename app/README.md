# Aurora — 3-Day Prototype

The closed loop: **voice or joystick → intent → AI-composed tile surface → navigate → action → spoken result.**

See `../MVP-aurora-3day-prototype.md` for scope and `../PRD-aurora-ai-first-os.md` for the long-form vision.

## What's here (Day 1 scaffold)

```
app/
├── server/                  # Node orchestrator
│   ├── server.js            # Express: /interpret, /notes, static renderer
│   ├── orchestrator.js      # OpenRouter call → tile spec
│   ├── backends/notes.js    # Markdown notes read/append
│   ├── .env.example         # copy to .env and fill in
│   └── package.json
├── renderer/                # Fullscreen Chrome web app
│   ├── index.html
│   ├── style.css
│   ├── main.js              # boot + state + action exec
│   ├── gamepad.js           # Gamepad API → semantic press / ptt events
│   ├── speech.js            # Web Speech API STT + TTS
│   ├── focus.js             # focus ring across tile + action bar
│   └── tiles.js             # deterministic renderer for the 4-template spec
└── notes/                   # local .md notes (one file per note)
```

## Run it

Requires Node 20+ and Chrome (Web Speech API and Gamepad API).

```bash
cd app/server
cp .env.example .env          # then put your OpenRouter key in .env
npm install
npm run dev                   # http://localhost:4317
```

Open Chrome → http://localhost:4317 → press **F11** for true fullscreen.

If you don't have an OpenRouter key yet, the orchestrator falls back to a tiny local classifier so the loop still demos (`take a note`, `show my notes`, anything else → "I'm offline").

## Inputs

| Action | Keyboard | Xbox controller |
|---|---|---|
| Push-to-talk | hold **Space** | hold **RT** |
| Navigate | arrows | D-pad / left stick |
| Select / confirm | **Enter** | **A** |
| Back / cancel | **Esc** | **B** |
| Home | (reload) | **Start** |
| Typed fallback | **/** to open | — |

## The three intents (per MVP §5)

1. **"Take a note: <text>"** → `compose` tile → A saves → spoken confirmation.
2. **"Show my notes"** → `list` tile → A opens → `reader` tile reads aloud.
3. **Any question** → `reader` tile with the LLM's answer, spoken.

## Tile spec contract (the model's only output)

```jsonc
{
  "intent":  "take_note" | "list_notes" | "answer",
  "template": "compose" | "list" | "reader" | "confirm",
  "context": "string shown at top",
  "title":   "string",
  "body":    "string (compose/reader)",
  "items":   [{ "id": "...", "label": "..." }],   // list
  "actions": [{ "verb": "Save", "glyph": "A", "action": { "type": "save_note" } }]
}
```

Action types currently handled by the renderer: `save_note`, `open_note`, `cancel`. Adding a new action = add a case in `main.js#executeAction`.
