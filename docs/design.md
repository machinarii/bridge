# Bridge — Design

This file captures the design language and UX decisions for Bridge. It is the
single reference for visual style, interaction model, and copy conventions.
The implementation lives in `app/renderer/` (`index.html`, `style.css`,
`main.js`).

---

## 1. Product surface

Bridge is a fullscreen Chrome command surface for running multiple **projects**,
each staffed by a crew of role-typed **agents**. There are three navigation
levels:

- **L0 — Project picker.** Fixed 4×2 grid. One of the eight cells is always
  the **+ New project** tile (positioned after the last existing project).
- **L1 — Agent grid.** Reflow grid (1×1 → 4×4 depending on team size) of the
  active project's role agents. The PM (or TPM if no PM) is marked as lead.
- **L2 — Agent zoom.** Single-agent view with prompt/response tiles, history
  drawer, and file explorer drawer.

The user moves down a level by selecting; up a level with back. Every
forward/back navigation is animated as a FLIP-style zoom (see §6).

---

## 2. Visual language

### 2.1 Tile system — one style, three screens

The same tile primitive is used on the project picker (L0), the agent grid
(L1), and the role picker (create-flow step 1). Identical structure:

- **Shape.** 12 px corner radius, 1 px faint resting border
  (`rgba(255,255,255,0.06)`).
- **Background.** A futuristic "faded radial" — the tile's accent color
  (project = brand blue, agent = role color) fades from the **top center**
  outward via `radial-gradient(... at 50% -10%, color 28%, transparent 60%)`,
  layered over a faint vertical glass gradient. A `::before` overlay adds a
  subtle top-edge highlight in the same color.
- **No hard colored borders.** Earlier versions used a 4 px colored top
  stripe; this was replaced with the radial wash for a quieter, more
  futuristic feel.

### 2.2 Selected state

The selection cursor is the same across every screen — tiles, list rows,
action-bar buttons, drawer entries. Composition (inside-out):

1. Tile body
2. Faint resting border (1 px, ~6 % white)
3. **1 px solid white outline**, `outline-offset: 2px` so it sits *just
   outside* the resting border
4. Soft blurred outer glow — `box-shadow: ..., 0 0 22px 6px rgba(255,255,255,0.22)`
5. Depth drop-shadow

When selected, the tile's **colored** radial wash is neutralized to grayscale
(same pattern, just `rgba(255,255,255,0.18)` instead of the tile color). This
reads as "this one is lifted into the foreground"; the resting state keeps
the colored backdrop so the visual hierarchy still encodes role/project color.

Focus token: `--focus: #ffffff;` (was yellow `#ffd35a` originally — switched
to white).

### 2.3 Header (always visible)

| Slot | Content |
|---|---|
| Top-left (always) | **Bridge** logo + wordmark in plain white. |
| Top-center / fill | — |
| Top-right | Breadcrumbs |
| Far right | Connection indicator |

**Logo.** Inline SVG of two filled nodes joined by an arc — a visual
shorthand for "bridge between things." Stroke and fills are plain `#ffffff`.
No gradient. The brand link is clickable and returns to L0.

**Wordmark.** "Bridge" in Barlow Condensed Medium (500), plain white,
slightly tracked (`letter-spacing: 0.04em`).

**Breadcrumbs.** `PROJECTS › FALCON › CASSIDY · PRODUCT MANAGER`
- Separator between levels: chevron `›` (U+203A), 0.4 opacity, ~1.1 em.
- Separator between agent name and role: middle-dot `·` (U+00B7).
- Agent leaf includes a small color chip (`.agent-chip`) for the role color.
- Current crumb is full-strength white; ancestors are dimmed.
- Uppercase, tracked, 0.8 em.

**Connection indicator.** Pill at far right with a colored dot. Text reads
**Connected** at rest (replaces older "Ready"), **Listening…** during PTT,
**Thinking…** during model calls, **<error reason>** in error.

---

## 3. Typography

Family: **Barlow Condensed** (Google Fonts). Loaded via `<link>` in
`index.html`, weights 200–700.

**Weights are deliberately low** — Bridge avoids heavy/bold text. Maximum
weight on screen is 500 (Medium). Hierarchy:

| Use | Weight |
|---|---|
| Body text | 300 (Light) |
| Headings (h1–h6, tile-title) | 400 (Regular) |
| Brand wordmark, tile names | 500 (Medium) |
| Metadata (role label, project meta, role sample) | 300 (Light) |
| Hints, nav-hint, compose-hint | 300 (Light) |
| Breadcrumbs | 400 (Regular) |

Sentence case across the UI. Status labels: `Idle`, `Thinking…`, `Off`,
`Connected` — never lowercase, never ALL CAPS in JS (breadcrumbs are
uppercased via CSS).

---

## 4. Color tokens

```
--bg:        #0b0f14
--bg-elev:   #131a23
--bg-elev-2: #1c2632
--fg:        #e7ecf3
--fg-dim:    #8b97a8
--accent:    #6ea8ff   (default brand blue)
--accent-2:  #9cf2c1
--warn:      #ffb86b
--danger:    #ff7b86
--focus:     #ffffff   (selection outline)
```

Each role has its own color used as the agent tile's accent (radial wash +
chip in the breadcrumb). The role catalog defines 14 distinct colors.

---

## 5. Input model

Bridge is **gamepad-first** but fully keyboard-operable. The two input
languages never share the screen at the same time.

### 5.1 Input mode detection

- `document.body.dataset.inputMode` toggles between `gamepad` and `keyboard`.
- **Boots in `gamepad` mode** (was previously keyboard).
- Flips to `keyboard` on the first keypress or mouse move.
- Flips to `gamepad` on any gamepad button press or R2 PTT.
- CSS hides the wrong affordance via:
  ```
  body[data-input-mode="keyboard"] .for-gamepad  { display: none !important; }
  body[data-input-mode="gamepad"]  .for-keyboard { display: none !important; }
  ```
- The DOM renders **both** keyboard and gamepad hints; CSS hides one.

### 5.2 Keyboard model

The whole UI is reducible to three keys plus arrows:

| Key | Meaning |
|---|---|
| **Enter** | Select / advance (open project, enter agent, advance role picker, confirm capture, open file/history entry, fire focused action) |
| **Esc** | Back one level / close drawer |
| **Space** | Toggle on/off (role in role picker, agent enabled at L1) |
| **Arrows** | 2D grid navigation |
| **Hold v** | Voice push-to-talk |
| **[** / **]** | Switch agent within L2 |
| **t** | History drawer |
| **\\** | File explorer drawer |
| **/** | Typed text fallback |
| **Opt + ←/→** | Slide focus between projects on L0 (see §6.3) |

PTT was previously on Space; it moved to `v` so Space can be the universal
on/off toggle.

### 5.3 Gamepad model (DualSense)

| Button | Meaning |
|---|---|
| **Cross ✕** | Select / advance |
| **Circle ○** | Back |
| **Square ☐** | Toggle on/off |
| **Triangle △** | History drawer (L2) / advance from role picker |
| **D-pad / left stick** | Navigate |
| **R2 (hold)** | Voice push-to-talk |
| **L1 / R1** | Switch agent within L2 |
| **Options** | File explorer drawer |

### 5.4 Affordance rendering

- **Action bar buttons.** Each button renders two glyphs in the DOM — a
  colored PlayStation glyph (`.for-gamepad`) and a neutral keycap label
  (`.for-keyboard`). The PS glyphs are colored per the data-glyph rules
  (`cross #6ea8ff`, `circle #ff7b86`, etc.). The keyboard chips are
  **explicitly NOT colorized** — `color: var(--fg) !important;` overrides
  the per-glyph color rules so keys read in neutral white.
- **Keyboard chips.** Flat: transparent background, single 1 px white
  outline at 22% opacity, 5 px corners, monospace, 600 weight. No gradient,
  no inner highlight, no drop-shadow.
- **Gamepad glyphs.** Circular (26 × 26), 1.5 px ring, colored per button.

---

## 6. Motion

### 6.1 Forward zoom (L0 → L1, L1 → L2)

Driven by `playZoomIn(target, sourceRect)`:

1. Before the navigation, the focused tile's bounding rect is pushed onto a
   `zoomStack` (stack supports nested forward navigation).
2. The new view renders normally at full surface.
3. `target.animate(...)` runs from a transform that maps source-rect → target,
   `opacity: 0` → `opacity: 1`, over 320 ms with
   `cubic-bezier(.2,.8,.2,1)`.

Visually: "I clicked that tile, and that tile zoomed up to fill the screen
with the next level."

### 6.2 Back zoom (L1 → L0, L2 → L1)

Driven by `playZoomOutTo(current, targetRect)`:

1. The destination rect is popped off `zoomStack` — it's where the originating
   tile was when we navigated forward.
2. The **current** surface animates from identity → source-rect transform,
   fading out, over 260 ms with `cubic-bezier(.4,0,.6,1)`.
3. After the animation, the new view renders.

Visually: "I'm zooming back into the tile I came from."

Brand link (top-left) also triggers this — clicking from L2 chains
`exitZoom()` then `exitToProjects()`.

### 6.3 Carousel slide on L0 (Opt + ←/→)

In addition to grid arrow navigation, **Option + ←/→** treats the picker as
a 1-D carousel: it cycles focus linearly through `[project_0, project_1, …,
+ New]`, with a slide-in animation on the newly focused tile (translate
48 px + opacity, 220 ms).

When the slide lands on **+ New**, the tile escapes the grid layout and pops
to a **centered create card** (`.centered-create`): `position: fixed`,
`min(520px, 70vw)` square, dashed white border, scale-in animation, dimmed
+ slight-blur backdrop on the other tiles. Pressing Enter on it starts the
create flow.

This is most useful when there's only one project: a single Opt+→ from that
project lands directly on a centered Create card in the middle of the
screen — a clearer affordance than the small "+ New" cell.

Regular arrow navigation, click, or mode change clears the centered-create
state.

---

## 7. Drawers

Two side drawers exist; they're mutually exclusive (opening one auto-closes
the other).

### 7.1 History drawer (L2 only, right)

- Triangle / `t` at L2 opens.
- 360 px wide, fixed right, between the header and action bar.
- Lists prior turns newest-first via
  `GET /projects/:pid/agents/:aid/history`.
- Each entry: small uppercase role label + 120-char snippet of content.
- Arrow keys navigate; Cross/Enter opens a turn as a fullscreen reader tile;
  Circle/Esc/Triangle closes.
- Focused entry: 3 px inset white left-bar.

### 7.2 File explorer (L1 / L2, left)

- Options / `\\` toggles. Not available on L0.
- 280 px wide, fixed left.
- Sections: **Charters** (one per agent role), **Notes** (newest first),
  and a singleton `project.md`.
- Selecting a file renders its content inline as a reader tile (silent;
  no TTS).
- Surface shifts 280 px right when the file drawer is open
  (`body[data-file-drawer="open"] #surface { margin-left: 280px; }`).
- Focused entry: 4 px white left border.

---

## 8. Copy conventions

- **Members → Agents.** The word "members" is not used. Per-project
  headcount renders as `N agent` / `N agents`.
- **Sentence case for status.** `Idle`, `Thinking…`, `Off`, `Connected`,
  `Saving…`, `Listening…`, `No speech detected`, `Speak or type a name`.
- **Verbs as labels for action bar.** `Save`, `Open`, `Back`, `Cancel`,
  `Done`, `Toggle`, `Next`, `Disable`.
- **Hints stay one line.** Idle and capture hints show different copy per
  input mode:
  - gamepad: "Hold R2 and speak."
  - keyboard: "Hold v and speak — or press / to type."

---

## 9. Layout invariants

- Header (`#context-strip`) and action bar (`#action-bar`) are persistent
  rails; everything navigation/level-specific happens inside `#surface`.
- `#surface` is `display: flex; flex-direction: column;` and its content
  fills the viewport minus the header/footer.
- All grid views (project picker, agent grid, role picker) honor
  `height: calc(100vh - 8rem)` so tiles fill the available space without
  scrolling at typical viewport sizes.
- Drawers float above the surface (z-index 60); the centered-create card
  floats above tiles (z-index 80); the team-voice summary banner floats
  above everything (z-index 70).

---

## 10. Things that were considered and rejected

- **Yellow focus outline (`#ffd35a`).** Replaced with white — felt cheap
  next to the muted backdrop.
- **Hard 4 px colored top border on tiles.** Replaced with the radial wash.
- **Pill-shaped keyboard chips.** Replaced with rounded-rect keycap, then
  with the current flat outlined chips when the keycap shading felt overly
  textured.
- **Gradient on logo and wordmark** (green→blue→purple). Replaced with plain
  white.
- **Thick body weights (Bold 700, ExtraBold 800).** Dropped — Bridge uses
  Light (300) by default and tops out at Medium (500).
- **Dosis font family.** Loaded briefly from `app/assets/fonts/dosis/`,
  then replaced with Barlow Condensed from Google Fonts.
