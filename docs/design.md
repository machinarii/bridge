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

- **L0 — Project picker.** Fixed 4×2 grid (8 cells). One of the cells is
  always the **+ New project** tile (positioned after the last existing
  project).
- **L1 — Agent grid.** Fixed 4×2 grid (8 cells). PM is locked into the
  top-left cell as the lead. Remaining roles are alphabetized by label.
- **L2 — Agent zoom.** Single-agent view with **inline chat history**
  (iMessage-style bubbles), centered hold-to-speak hint, prompt text
  field below the surface, plus optional Explorer / Skills drawers.

The user moves down a level by selecting; up a level with **Esc** / the
**X close button** at the top-right of the surface. Every forward/back
navigation is a FLIP-style morph (see §6).

**Nav state persists across reloads** via `sessionStorage['bridge:nav']`.
Refreshing returns you to the last screen you were on (L0 / L1 / L2),
including the active project and focused tile.

---

## 2. Visual language

### 2.1 Tile system

The same tile primitive is used on the project picker (L0), the agent grid
(L1), and the role picker (create-flow step 1). Identical structure:

- **Shape.** 12 px corner radius, 1 px faint resting border
  (`rgba(255,255,255,0.06)`).
- **Background.**
  - **L0 project tiles** carry the **per-project radial wash** in their own
    hashed accent color (top-center fade, see §4).
  - **L1 agent tiles** are **neutral** — they sit on top of the project's
    color-tinted L1 surface backdrop, so the color story is already told
    by the container. Inside, the tiles read in plain glass.
  - **Role picker tiles** carry no color (selection is the only signal).
- **+ New project tile.** Plain 1 px faint border, no background fill.

### 2.2 L1 surface backdrop (per-project color)

At L1 only, `#surface` paints a soft radial wash in the active project's
accent color (top-center → transparent). The agent tiles themselves stay
neutral, so the project-color identity reads as "the room you're in," not
"the tiles within it."

L0 keeps the picker neutral; L2 keeps the surface neutral (the chat already
carries enough signal).

### 2.3 Selected state

The selection cursor is the same across every screen — tiles, list rows,
action-bar buttons, drawer entries, close button. Composition (inside-out):

1. Tile body
2. Faint resting border (1 px, ~6 % white)
3. **1 px solid white outline**, `outline-offset: 2px` so it sits *just
   outside* the resting border
4. Soft blurred outer glow — `box-shadow: ..., 0 0 22px 6px rgba(255,255,255,0.22)`
5. Depth drop-shadow

Selection neutralizes any colored radial wash on the tile to grayscale, so
the focused tile reads as "lifted into the foreground." Resting tiles keep
their color so hierarchy is still encoded.

Focus token: `--focus: #ffffff`.

### 2.4 Surface close (top-right of L1 and L2)

A 32 × 32 **X** button sits at the top-right of every nested screen (L1 and
L2). It is **fully keyboard / d-pad reachable**: tab-navigable, takes the
same focus treatment as a tile, and Enter on it returns one level up.

Implementation notes:
- Click and keydown handlers `stopPropagation()` so the surface-wide Enter
  dispatcher doesn't re-fire the open action.
- `body[data-surface-close-focus="true"]` tags the surface during focus so
  the rest of the UI can dim if needed.

### 2.5 Footer rail (always visible)

There is **no top header**. The bottom rail is the only persistent UI.
It's a single flex row with three regions:

| Region | Content |
|---|---|
| **Left — `#brand`** | The Bridge lockup: SVG nodes-and-arc mark + "Bridge" wordmark in plain white Source Sans 3 SemiBold (600). Clickable; returns to L0. |
| **Center — `#shortcuts-rail`** | Persistent navigation reference for the current screen — chips like `○ Back`, `[ ] Cycle agent`, `E Explorer`, `S Skills`. Each chip renders both gamepad and keyboard forms; CSS hides the inactive one via `body[data-input-mode]`. Updated on every screen change via `setShortcuts(items)`. |
| **Right — `#action-bar`** | A **dark, 10 px rounded-rect pill** containing the **primary shortcut** (`#primary-shortcut`, e.g. `Enter Select`) and any per-screen action verbs (`Save`, `Cancel`, etc.). `#primary-shortcut` sits at the far right inside the pill. |

This is the only persistent surface for showing user shortcuts, so the user
always knows what's pressable. There is no longer a connection / status
indicator at the top — status surfaces inline as a small banner when needed.

---

## 3. Typography

Primary family: **Barlow Condensed** (Google Fonts), weights 200–700.
Secondary family: **Source Sans 3** (Google Fonts), weights 300–600 —
used for the brand wordmark and keyboard key chips (Enter, Esc, Space, v,
/, `[`, `]`, etc.) where a clean upright DIN-style sans reads better than
the condensed body face.

Two weights:

| Use | Weight |
|---|---|
| Body text, hints, metadata, chat bubbles | 300 (Light) |
| Headings, tile names, brand, key chips | 400 (Regular) |

### 3.1 Type per screen

- **L0 project tile.** Name 1.4 rem / 400; meta "N agents" 0.9 rem / 300
  with 0.25 rem gap below the name.
- **L1 agent tile.** Name 1.4 rem / 400; role label directly under name
  0.9 rem / 300 with 0.25 rem gap.
- **L2 agent header.** Name 1.4 em / 400 stacked over the role label
  0.9 em / 300 (subtitle-style, mirroring the project landing page).

---

## 4. Color tokens

```
--bg:        #0b0f14
--bg-elev:   #131a23
--bg-elev-2: #1c2632
--fg:        #e7ecf3
--fg-dim:    #8b97a8
--focus:     #ffffff   (selection outline)
```

### 4.1 Per-project palette

There is no per-role color anymore. Each **project** is assigned one of
**12** hashed palette colors via `getProjectColor(project)`:

```
PROJECT_PALETTE[i] = h(project.id) % 12
```

The color is applied to:
- The project tile's radial wash on **L0**.
- The L1 surface backdrop (`#surface` radial wash) on **L1**.
- The agent tiles themselves stay **neutral**.

Color stays stable for the lifetime of a project: same hash → same swatch.

---

## 5. Input model

Bridge is **gamepad-first** but fully keyboard-operable. The two input
languages never share the screen at the same time.

### 5.1 Input mode detection

- `document.body.dataset.inputMode` toggles between `gamepad` and `keyboard`.
- Boots in `gamepad` mode.
- Flips to `keyboard` on the first keypress or mouse move.
- Flips to `gamepad` on any gamepad button press or R2 PTT.
- CSS hides the wrong affordance via:
  ```
  body[data-input-mode="keyboard"] .for-gamepad  { display: none !important; }
  body[data-input-mode="gamepad"]  .for-keyboard { display: none !important; }
  ```

### 5.2 Keyboard model

| Key | Meaning |
|---|---|
| **Enter** | Select / advance |
| **Esc** | Back one level / close drawer / close panel |
| **Space** | Toggle on/off (role in role picker, agent enabled at L1) |
| **Arrows** | Navigate the grid; at L1 also cycle agents within row |
| **`[` / `]`** | Cycle agent at L2 (slide animation); cycle project at L1 |
| **Hold v** | Voice push-to-talk |
| **/** | Type a prompt inline (focuses the prompt text field below the surface) |
| **E** | File **Explorer** drawer (was `F` / `\`) |
| **S** | **Skills** drawer |
| **Opt + ←/→** | Slide focus between projects on L0 (see §6.3) |

The Explorer and Skills drawers are **mutually exclusive**: pressing `E`
while Skills is open swaps it out, and vice versa.

History is no longer a drawer — chat history renders inline at L2 (§7.1).

### 5.3 Gamepad model (DualSense)

| Button | Meaning |
|---|---|
| **Cross ✕** | Select / advance |
| **Circle ○** | Back |
| **Square ☐** | Toggle on/off |
| **Triangle △** | Advance from role picker |
| **D-pad / left stick** | Navigate |
| **R2 (hold)** | Voice push-to-talk |
| **L1 / R1** | Cycle agent at L2 / cycle project at L1 |
| **Options** | Files / Explorer |

### 5.4 Affordance rendering

- **Action bar buttons.** Each button renders two glyphs in the DOM — a
  colored PlayStation glyph (`.for-gamepad`) and a neutral keycap label
  (`.for-keyboard`).
- **Keyboard chips.** Flat: transparent background, 1 px white outline at
  22 % opacity, 5 px corners, Source Sans 3 / SemiBold. No gradient.
- **Gamepad glyphs.** Circular (26 × 26), 1.5 px ring, colored per button.
- **Pressed feedback.** When a shortcut key is pressed, only the small
  key-label container highlights — not the entire chip row.

---

## 6. Motion

Bridge's nav transitions are modeled after the markdown-cards StackTile →
FlashCard pattern: a real DOM element flies and grows through space;
siblings dim; the destination view appears beneath at the exact size and
position the element lands at.

### 6.1 Forward zoom (L0 → L1, L1 → L2) — `forwardMorph`

1. Capture the focused source tile's bounding rect; push onto `zoomStack`.
2. Clone the source tile into `document.body` as `position: fixed` at the
   source rect.
3. Fade out the clone's children (~110 ms) so only the shape morphs.
4. Fade other siblings to 0; hide the original source tile so the clone
   reads as it.
5. Animate the clone's `width/height/left/top` from the source rect to the
   **surface content rect** (after subtracting `#surface` padding), 320 ms
   with `cubic-bezier(.2,.8,.2,1)`.
6. Counter-scale `border-radius` and `border-width` so visible corners
   stay constant.
7. At ~170 ms in (≈ 50 % of the morph), render the destination view
   beneath the empty clone and fade it in over ~160 ms; the clone fades
   out over its last ~120 ms.

Total wall-clock: ~480 ms. The cross-fade midpoint is what makes the
destination feel like it "emerges" from inside the morphing card rather
than appearing as a separate cut.

### 6.2 Back zoom (L1 → L0, L2 → L1) — `backZoomWithSnapshot`

1. Pop the destination rect off `zoomStack`.
2. Build an **empty card overlay** with the surface's exact bg/border
   copied inline (no descendant content — avoids text bleed through).
3. Render the destination view inside `#surface` immediately — the user
   sees it underneath the overlay.
4. Animate the overlay shrinking from the surface rect → destination rect
   (320 ms, `cubic-bezier(.4,0,.6,1)`). Holds opacity 1 for the first
   85 %, fades to 0 at 85–100 %.
5. Counter-scale border-radius / border-width during the shrink.
6. **Cancel the animation explicitly** (`a.cancel()` after `a.finished`)
   to clear any leftover transform/opacity — otherwise the surface stays
   stuck on the end frame.

The destination rect is recomputed via a `resolveToRect` callback **after**
the destination renders, so the morph lands on the actual tile position.

### 6.3 Carousel slide on L0 and L1

- **L0 (project picker).** `Opt + ←/→` cycles linearly through
  `[project_0, …, project_n, + New]` with a 48 px translate + opacity slide
  on the newly focused tile (220 ms). Landing on **+ New** pops a centered
  "Create project" card (`min(520px, 70vw)`, dashed border, scale-in).
- **L1 (agent grid).** `[ / ]` (or L1/R1) slides the whole agent surface
  out and the next project's surface in via `slideAgent(delta, doSwap)` —
  used for both **agent cycling at L2** and **project cycling at L1**.

Regular arrows / clicks clear the centered-create overlay.

---

## 7. Inline content surfaces

### 7.1 L2 chat history (inline, iMessage-style)

History is no longer a side drawer. At L2 the surface itself is the chat
transcript:

- `.chat-scroll` contains alternating `.bubble.user` and `.bubble.agent`
  bubbles, newest at the bottom, scrollable.
- The top edge of `.chat-scroll` uses a CSS **mask-image gradient** that
  fades the oldest content into the surface bg — content vanishes into
  the upper edge as it scrolls past, no hard cut.
- A centered "Hold v to speak" hint sits in the surface center when the
  chat is empty. It vanishes the instant any bubble appears via
  `.agent-view:has(.chat-scroll > .bubble) .agent-view-hint { display: none; }`.
- The prompt text field (`#ptt-typed`) sits **below** the surface
  container, never above. Placeholder copy: **"Type a prompt and press
  enter"**.

### 7.2 File Explorer drawer (L1 / L2, left)

- Toggle: `E` / Options. Not available on L0.
- 280 px wide, fixed left, styled as a **rounded card** with the surface's
  border and 1 px outline, same corner radius. Sits between the surface-top
  and surface-bottom CSS variables (`--surface-top`, `--surface-bottom`,
  JS-synced via `syncExplorerHeights()`).
- Sections: **Charters** (one per agent role), **Notes** (newest first),
  and a singleton `project.md`.
- Selecting a file renders its content inline as a **file viewer**
  (`#file-viewer`) — see §7.3.
- Arrow keys navigate entries; Enter opens; Esc closes.

### 7.3 File viewer

- 44 vw wide, min 320 px, rounded card at the same top/bottom rails as the
  file drawer. When the drawer is also open, it sits at `left:
  calc(1.5rem + 280px + 0.75rem)`; otherwise at `left: 1.5rem`.
- **Slide-in animation.** On open, the panel slides 24 px from the left
  with a 240 ms ease-out (`viewer-slide-in` keyframes).
- **Push-not-resize.** When the viewer opens, `#surface` translates right
  via `transform: translateX(calc(44vw + 1rem))` — the surface keeps its
  full width, its right edge simply slides past the viewport. `#surface`
  has a 240 ms transition on `transform` so the slide is animated. **Not
  a margin change** — the surface does not narrow.
- Top-right X close button is keyboard-focusable; Enter/Space/Esc all
  close the viewer. Handlers `stopPropagation()` so the surface-wide Enter
  dispatcher doesn't re-fire.
- ArrowRight from inside the explorer hops focus to the viewer's X button.

### 7.4 Skills drawer

- Toggle: `S`.
- 280 px wide, fixed left, same rounded-card style as the file drawer.
- Mirrors the file drawer's open/close behavior. Skills and Explorer are
  **mutually exclusive** — opening one closes the other.
- Lists Claude skills available to the project. (The `+` add affordance
  and AI-generated creation panel were trialled but removed; skills are
  read-only for now.)

---

## 8. Copy conventions

- **Sentence case** for all UI strings. First word starts with one capital;
  the rest lowercase. Exceptions: proper nouns (Claude, Cassidy, iOS, PM).
  Never Title Case, never ALL CAPS in JS. (Stored as a project memory
  rule.)
- **Members → Agents.** Per-project headcount renders as `N agent` /
  `N agents`.
- **Status labels.** `Idle`, `Thinking…`, `Off`, `Saving…`, `Listening…`,
  `No speech detected`.
- **Verbs as labels for the action-bar pill.** `Select`, `Back`, `Save`,
  `Open`, `Cancel`, `Done`, `Toggle`.
- **Hints stay one line.** L2 idle hint:
  - gamepad: "Hold R2 to speak."
  - keyboard: "Hold v to speak."
- **Prompt field placeholder.** "Type a prompt and press enter."

---

## 9. Layout invariants

- The footer rail (`#footer-rail`) is the only persistent UI band.
  Everything navigation/level-specific happens inside `#surface`.
- `#surface` is `display: flex; flex-direction: column;` and its content
  fills the viewport minus the footer.
- **CSS variables `--surface-top` and `--surface-bottom`** are written by
  JS (`syncExplorerHeights()`) so left-side panels (Explorer, file viewer,
  Skills) align to the surface's exact top and bottom edges regardless of
  viewport size.
- All grid views (L0, L1, role picker) honor a fixed 4×2 layout with
  generous cell sizes; no internal scrolling at typical viewport sizes.
- Drawers float above the surface (z-index 60); the file viewer at z-index
  55; the centered-create card at z-index 80.
- **Persistent nav state.** On every navigation, `saveNavState()` writes
  `bridge:nav` to sessionStorage; on boot `readNavState()` restores it.

---

## 10. Role picker specifics

10 roles total, single-instance per project. Role roster (alphabetized
after PM):

```
pm (Product Manager, locked-in lead)  ← top-left, always
designer
data_sci
engineer
marketing
qa
security
tech_writer
tpm
ux_research
```

(Removed in the trim: data engineer, devops, ML engineer, support.)

- **Grid.** `.role-grid` is a 4-column CSS grid with `grid-auto-rows: 1fr`.
- **Checkbox.** Top-right of each tile, absolutely positioned. CSS-drawn
  rounded square (5 px corners, 1.5 px outline at 55 % white) that fills to
  white with a dark angled checkmark when checked. Checkmark is 14 %
  thicker than the stock CSS check; `x: -2`.
- **PM is locked.** Renders with `data-locked="true"`: checkbox at 45 %
  opacity, grayed checkmark, cannot be toggled off. (Disabled means
  grayed, **not** removed.)
- **Activation.** Enter advances (Triangle on gamepad); Space toggles the
  focused role.

---

## 11. Smart-TV HCI compliance

Bridge is designed for couch / 10-foot operation with a gamepad as the
primary input. The interaction model deliberately mirrors three
overlapping platform conventions:

- **Apple tvOS HIG** — focus engine, parallax motion, large rest sizes,
  no on-surface text input.
- **Google TV (Android TV) design principles** — flat grids, persistent
  action affordances, voice-first secondary nav.
- **Xbox UX guidelines** — ABXY mapping, safe-area discipline, "focus is
  sacred," shoulder buttons reserved for traversal/cycling.

Where the three platforms disagree, Bridge falls back to what's common to
all three.

### 11.1 Focus is unmistakable from across the room
- Single clearly-focused element at all times — never "no focus."
- White (`--focus: #ffffff`) **1 px outline with `outline-offset: 2px`**,
  plus a 22 px blurred outer glow, plus a −3 px lift transform, plus a
  grayscale wash on otherwise color-tinted tile backdrops. Multi-channel:
  shape + glow + translation + color shift.
- Identical treatment on all focusable surfaces (tiles, action-bar pill,
  drawer entries, surface-close X).

### 11.2 D-pad first, predictable traversal
- Five buttons control everything: D-pad, Cross (select), Circle (back),
  Square (toggle), Triangle (advance), plus L1/R1 for cycling and Options
  for the explorer.
- 4×2 grids at L0 and L1 keep arrow traversal cycle-stable — no surprise
  row jumps.
- `zoomStack` records the source rect on every forward zoom; back nav
  lands focus on the exact tile you came from (spatial continuity).
- `slideAgent(delta)` doubles as the cycling animation for **agents at L2**
  *and* **projects at L1**.

### 11.3 Glanceable, low-density information
- One job per screen.
- Tiles show one strong title and at most one secondary line.
- 4×2 grids mean each cell stays generous at any team size.

### 11.4 No keyboard required, voice over typed input
- Primary input for free-form content is push-to-talk (R2 / `v`).
- Typed text is a fallback bound to `/` — the prompt field sits below
  the surface, never on it.

### 11.5 Spatial continuity through motion
- Forward and back navigation morph the source tile itself.
- Zoom uses `width/height/left/top` (not `transform: scale`) so corners
  don't warp.
- Cross-fade at ~170 ms (≈ 50 % of the morph) so destination content
  "emerges" through the morph rather than cutting in.
- File viewer opens with a 24 px slide-in and the surface slides right
  by `44vw + 1rem` over 240 ms — not a snap.

### 11.6 Affordance discoverability
- Persistent footer rail is visible on every screen — brand left,
  shortcuts mid, action-pill right — so the user always sees what's
  pressable.
- Both gamepad and keyboard glyphs are rendered to the DOM; CSS hides
  the inactive scheme via `body[data-input-mode]`.
- Surface-close X is always visible at the top-right of L1 / L2.

### 11.7 Sufficient padding, safe zone
- `#baseplate` uses 24 / 32 px outer padding and a 20 px gap above the
  footer rail.
- Drawers and the file viewer are rounded cards inset from the viewport
  edges; nothing touches the safe-area boundary.

### 11.8 Glanceable status
- Status surfaces inline (banner / bubble) rather than via a top header
  badge. Listening/thinking pulse on the focused tile.

### 11.9 High-contrast type, readable from 3 m
- Body type 22 px Light 300 (Barlow Condensed) on `--bg #0b0f14`.
- Headings 1.4 em / 400. Brand wordmark in Source Sans 3 SemiBold for
  legibility at the smallest size.
- All foreground text uses `--fg #e7ecf3` (WCAG AAA against bg). Metadata
  uses `--fg-dim #8b97a8` (still > 4.5:1).

### 11.10 Single primary action; no hidden gestures
- Every screen exposes its primary action in the `#primary-shortcut` slot
  inside the action-bar pill.
- Drawers can be toggled with the same key that opens them (`E` /
  `Options` / `S`); no hidden close gesture.

### 11.11 Loading & uncertainty
- Long-running calls flag the focused / lead agent tile with a pulsing
  dot. Errors fall through to a reader-style banner inline.

---

## 12. Things considered and rejected

- **Header / top breadcrumb bar.** Removed entirely. Brand moved to the
  footer-left; status surfaces inline. Frees the top edge for the
  surface-close X and keeps one persistent UI band instead of two.
- **Per-role tile colors.** Replaced with per-project color applied to
  the **L1 surface backdrop** rather than the agent tiles, so the room
  carries the color and the tiles can stay neutral.
- **History drawer at L2.** Replaced with inline iMessage-style chat
  bubbles inside the surface, with a mask-fade top edge.
- **`F` / `\` for Explorer.** Rebound to **`E`** — easier to reach and
  doesn't collide with backslash on non-US layouts.
- **`+` button inside the Explorer / Skills drawers.** Trialled with
  Enter / Space activation, right-side creation panel, dictate button —
  removed for now. Drawers are read-only.
- **Resizing the surface when the file viewer opens.** Replaced with
  `transform: translateX` so the surface keeps its full width and simply
  slides past the right edge.
- **PM checkbox removed when locked.** Replaced with a grayed-out 45 %
  opacity check; user confirmed "disabled means grayed, not removed."
- **Background colors on role-picker buttons.** Removed; the L1 surface
  carries the project color instead.
- **"Hold v and speak — or press / to type" hint.** Trimmed to "Hold v
  to speak" centered on the surface, shown only when chat is empty.
- **Pill-shaped action bar.** Now a darker rounded-rectangle with a 10 px
  radius — reads as a contained band rather than free-floating chips.
- **Primary-shortcut centered or left-aligned.** Moved to the **far right**
  of the action pill so the most-used key (Enter Select) is the rightmost
  visual anchor on the rail.
- **Yellow focus outline (`#ffd35a`).** Replaced with white — felt cheap
  next to the muted backdrop.
- **Hard 4 px colored top border on tiles.** Replaced with the radial wash.
- **Gradient on logo and wordmark** (green→blue→purple). Replaced with
  plain white.
- **Thick body weights (Bold 700, ExtraBold 800).** Dropped — Bridge uses
  Light (300) by default and tops out at Regular (400).
- **Dosis font family.** Replaced with Barlow Condensed.
- **Role roster on L0 tiles** ("Product Manager · Engineer · QA").
  Reverted to "N agents" — more scannable on the home grid.
- **`fill: 'forwards'` on the zoom-out animation.** Caused blank-screen
  on Esc because the cancelled animation kept its end transform stuck on
  `#surface`. Fixed by `a.cancel()` after `a.finished`.
- **Plain overlay-snapshot zoom (no content fade).** Felt like a
  transparent overlay floating; solved by fading source content before
  the transform and fading destination content in mid-morph.
- **Descendant opacity-hiding during back zoom.** Caused text bleed-
  through; replaced with an empty card overlay carrying the surface's
  bg/border copied inline.
- **`◉ ○` radio glyph for role toggle.** Replaced with checkbox
  semantics, then with the current CSS-drawn rounded checkbox.
- **Agent · role crumb on L2.** Was redundant with the page header;
  trimmed.

---

## 13. Implementation anchors

For maintainers, the key functions to read in `app/renderer/main.js`:

| Concern | Function |
|---|---|
| Hash project → palette color | `getProjectColor(project)` |
| Sort agents with PM first | `withLeadFirst(project)` |
| Forward morph | `forwardMorph(sourceEl, sourceRect, targetRect, renderDest)` |
| Back zoom | `backZoomWithSnapshot(resolveToRect, renderNewView)` |
| Carousel slide (agents / projects) | `slideAgent(delta, doSwap)` |
| Set rail content | `setShortcuts(items)`, `setPrimaryShortcut(item)` |
| Per-screen rail content | `updateGridShortcuts()`, `_setL2Shortcuts()`, `updatePickerShortcuts()` |
| Drawer toggles | `toggleFileExplorer()`, `toggleSkillsDrawer()` |
| Surface push when viewer opens | CSS `body[data-file-viewer="open"] #surface { transform: translateX(...) }` |
| Persisted nav | `saveNavState()`, `readNavState()` |
| Surface close X | `renderGrid()` / `renderZoom()` — `.surface-close` button |

OpenRouter model used: `anthropic/claude-opus-4.7` (set in `app/server/.env`
as `OPENROUTER_MODEL`).
