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
| **Two-finger swipe ← / →** | Trackpad equivalent of `[` / `]` — swipe left = `[` (prev), swipe right = `]` (next). Synthesizes the real keydown so it follows the same per-screen behavior + guards; one swipe = one step. Ignored over a horizontally-scrollable element (wide code/table). |
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
- **Header overlay + dissolve (no hard cut).** The `.agent-header`
  (agent name + role) is an **absolute, full-width overlay** with
  `pointer-events: none`, carrying its own opaque→transparent gradient
  (opaque behind the name/role so they stay legible; `color-mix(... transparent)`
  lets the agent-color glow tint through). The chat **fills the whole column
  and scrolls *under*** it; a `.chat-scroll` **top mask-image** fades each
  bubble to transparent before it reaches the heading, so content dissolves at
  every scroll position rather than meeting a hard edge. One CSS variable —
  **`--header-h`** (currently `8.5rem`) — drives the overlay height, the
  gradient/mask depth, *and* the chat's top clearance (`padding-top` +
  `scroll-padding-top`), so they stay in lockstep; bigger = a wider, softer
  fade. `scrollBubbleIntoView()` reads `--header-h` (the chat's `padding-top`)
  so keyboard/gamepad-focused bubbles settle **below** the overlay, never under
  it. The bottom 8px keeps its own dissolve into the tile-surface/hint region.
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

## 10.5 Universal input accessibility (non-negotiable)

**Every interactive surface in Bridge must be reachable and operable
via all three input modes:**

1. **Keyboard** — Tab and arrow keys move focus; Enter activates; Esc
   backs out / closes; Space toggles. No interaction may require a
   mouse or controller.
2. **D-pad / gamepad** — dpad navigates; Cross activates; Circle backs
   out; Square toggles; Triangle advances. No interaction may require
   typing.
3. **Mouse** — every focusable surface accepts click, with the same
   visual focus state on `:focus-visible` and `.focused`.

Checklist for new UI:

- [ ] First focusable element receives focus when the surface opens.
- [ ] Arrow keys (or D-pad) navigate every control in a predictable
      order; nothing is reachable only by Tab.
- [ ] Tab also works (covers screen readers and assistive tech).
- [ ] Enter / Cross activates the focused control.
- [ ] Esc / Circle closes or backs out — always available, never
      silently consumed.
- [ ] Focus visuals follow the standard `--focus: #ffffff` outline +
      glow treatment (see §2.3).
- [ ] Background keyboard shortcuts (`v` PTT, `e` Explorer, `s` Skills,
      `/` typed prompt) are **disabled** while the surface owns the
      input — surfaces explicitly opt out by checking their open flag
      at the top of the global window keydown.
- [ ] Mouse click works on every focusable surface and lands focus
      where the user clicked.

Existing surfaces that meet this bar: L0 picker, L1 grid, L2 zoom,
role picker, name/goal capture, file explorer + viewer, skills drawer,
settings modal (including tabs and per-role dropdowns), surface-close X,
brand link, gear icon.

When you add a new modal / drawer / overlay, copy the pattern from
`openSettings()` → `handleSettingsGamepad()` → modal-scoped keydown
handler.

---

## 11. Smart-TV HCI compliance

Bridge is designed for couch / 10-foot operation with a gamepad as the
primary input. The interaction model deliberately mirrors four
overlapping platform conventions:

- **Apple tvOS HIG** — focus engine, parallax motion, large rest sizes,
  no on-surface text input.
- **Google TV (Android TV) design principles** — flat grids, persistent
  action affordances, voice-first secondary nav.
- **Xbox UX guidelines** — ABXY mapping, safe-area discipline, "focus is
  sacred," shoulder buttons reserved for traversal/cycling.
- **Steam OS / Big Picture / Steam Deck** — chunky tap targets, generous
  rounded corners, persistent action footer, gamepad-first text fields.

### 11.0 Steam OS sizing guidelines

Bridge adopts Steam Big Picture's minimum-size rules so the UI is
comfortable on a TV at 3 m and on a 7" Steam-Deck-style portable.
These are enforced via CSS variables in `:root`:

```
--steam-input-h:  48px   /* minimum input/select/dropdown height */
--steam-button-h: 56px   /* minimum button height */
--steam-body-fs:  17px   /* minimum body text in interactive elements */
--steam-radius:   12px   /* minimum corner radius on interactive surfaces */
```

Applied to:

- Every text input, select, dropdown, password field — min 48 px tall,
  17 px text, 12 px corners.
- Every modal button (Save, Cancel, etc.) — min 56 px tall, 120 px wide,
  17 px text.
- The inline prompt field (`#typed-input`) — same sizing as Steam Deck's
  on-screen text input row.

The footer rail's action-bar chips are intentionally smaller (~36 px)
because they're persistent and selection is by glyph, not tap target —
this is the same compromise Steam makes with its bottom button hints.

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

## 12.5 Orchestration capabilities

Modeled on Roo Code's orchestrator + mode mechanics. Live wiring lives
in `app/server/team.js`, `orchestrator.js`, and `models.js`.

### 12.5.1 Delegate-and-resume

The standard tile-spec contract grows a fourth intent: `delegate`. When
an assignee decides their role isn't best-suited, they emit:

```json
{ "intent": "delegate", "to_role": "engineer", "task": "<one sentence>",
  "context": "Delegating", "title": "Routing to Engineer",
  "body": "<short note>", "actions": [...] }
```

`runTeamVoice` follows each delegate hop: the originating assignee's
`body` is forwarded as `sharedFrom` context to the target agent, and the
chain continues until a non-delegate spec is returned or the depth cap
(`MAX_DELEGATION_DEPTH = 3`) is hit. Every hop is recorded in the
returned `delegations[]` array for telemetry.

### 12.5.2 Per-role model pinning

Each role can pin its own OpenRouter model via the settings panel.
Stored as a JSON map in `.env`:

```
OPENROUTER_MODEL_BY_ROLE={"pm":"anthropic/claude-opus-4.7","engineer":"anthropic/claude-sonnet-4.6"}
```

Resolution: `getModelForRole(roleId)` in `app/server/models.js` consults
the map first and falls back to `OPENROUTER_MODEL` (then to the
hard-coded default `anthropic/claude-opus-4.7`). Called from
`orchestrator.interpretIntent` and from `team.runTeamVoice` for the
lead's routing + synthesis prompts.

### 12.5.3 Git auto-save

Each project gets its own git repo at `app/state/<projectId>/`. On
project creation the server calls `initProjectRepo(id)`. The autosave
module (`app/server/autosave.js`):

- **On-change commit (debounced).** API endpoints that mutate state
  (notes, agent spec, team voice, project create) call
  `notifyStateChange(projectId, message)`. A 5-second debounce
  coalesces bursts, then commits any dirty files with the supplied
  message.
- **Periodic sweep.** Every `GIT_AUTOSAVE_INTERVAL_MIN` minutes
  (default 5), `commitAllDirty()` walks every project and commits
  drift. The interval is configurable in the settings panel.
- **Toggle.** `GIT_AUTOSAVE=on|off` in `.env`, surfaced as a checkbox
  in the **Git** tab of the settings modal.
- **Status.** `GET /projects/:pid/autosave` returns `{ enabled,
  hasRepo, dirty, lastCommit }` for the UI.

The per-project repo is local-only — no remote, no push. Users can
inspect history with `git -C app/state/<pid> log`.

### 12.5.4 MCP plugin registry

Settings → **MCP** lists every registered MCP plugin with an enable
toggle. Persisted as JSON in `.env`:

```
MCP_PLUGINS=[{"id":"anthropic/filesystem","name":"Filesystem","enabled":true}]
```

Currently just the registry + UI scaffold; actual MCP connection /
tool exposure is a follow-up.

### 12.5.5 Code generation & the execution sandbox

Kickoff doesn't stop at planning — it scaffolds and **runs** real code
(§15.12, steps 6–7). Two server modules own this:

- **Scaffold (`scaffold.js` / `workspace.js`).** On **"Build it"** the PM
  generates a build plan and an initial source tree under the project's repo
  (`~/bridge-projects/<slug>/`, code at the root, planning docs under `docs/`),
  writing files **path-safely** (escapes rejected), committing atomically, and
  running a `node --check` syntax-fix pass before reporting the file count + SHA.
- **Run-fix loop (`sandbox.js` → `verify.js` → `run-fix.js`).** On **"Run it"**
  the repo is installed/built/tested **in a throwaway container**, and failures
  drive a bounded model-fix loop (`runAndFix`).

**The sandbox (`sandbox.js`) is the *only* place Bridge touches a container
engine.** Design points:

- It shells out to the **`docker` CLI** (`spawn('docker', …)`), never to a GUI
  app or an engine-specific API. It needs only (a) a `docker` binary on `PATH`
  and (b) a reachable Docker **daemon** — *any* provider works: **Colima**
  (recommended, CLI-only, no GUI), OrbStack, Podman (via the `_bin` seam), or a
  remote `DOCKER_HOST`. There is **no dependency on Docker Desktop**.
- `dockerArgs()` builds `docker run --rm -v <repo>:/app -v /app/node_modules -w
  /app --memory=2g --cpus=2 <image> sh -lc <script>` — the repo source is
  **bind-mounted** (code stays local) while `node_modules` is a **container-only
  overlay** so Linux install artifacts never pollute the host repo.
- `runInContainer()` captures combined stdout+stderr, enforces a timeout, and
  classifies a **daemon-down** error (`DAEMON_DOWN_RE`) so the UI can ask you to
  start the engine instead of failing opaquely. It **never rejects** — outcomes
  are returned. `verifyProject` marks `install`/`build`/`test` steps with
  `@@STEP` markers to identify the failing step.
- **DI seams** (`_bin`, `image`, injected `runner`/`callText`) make the whole
  pipeline unit-testable **without Docker or network** — the live path defaults
  to `runInContainer` + OpenRouter.

> **Mount scope (Colima):** Colima mounts only `$HOME` into its VM by default.
> Bridge writes projects under `~/bridge-projects/` (inside `$HOME`), so bind
> mounts resolve. If `BRIDGE_PROJECTS_BASE` is relocated outside `$HOME`, start
> Colima with `colima start --mount <path>:w`.

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
as `OPENROUTER_MODEL`); per-role overrides via `OPENROUTER_MODEL_BY_ROLE`.

| Capability | Module |
|---|---|
| Per-role model resolution | `app/server/models.js` (`getModelForRole`) |
| Delegate-and-resume loop | `app/server/team.js` (`runWithDelegation`) |
| Git autosave + periodic sweep | `app/server/autosave.js` |
| Settings endpoints | `app/server/server.js` (`GET /settings`, `PUT /settings`, `GET /settings/models`) |
| MCP registry | settings → MCP tab + `MCP_PLUGINS` env JSON |

---

## 14. Theme & design heritage (consolidated)

Bridge is a **10-foot, controller-first interface**. The lineage is **Steam Big
Picture / SteamOS** (the `--steam-*` token namespace is a direct nod) and
**Apple TV** (focus-driven navigation, large legible tiles, motion that follows
focus). It runs in a desktop window but is designed as if it were on a couch
with a gamepad.

**Principles, in priority order**

1. **Controller-first, input-agnostic.** Every action is reachable by gamepad
   *and* keyboard *and* mouse, with identical results. Nothing is mouse-only.
   The gamepad is the design target; keyboard mirrors it; mouse is convenience.
2. **Focus is the cursor.** Exactly one focused element at all times. Navigation
   moves focus along a predictable ring; activation acts on the focused element.
3. **The model assembles, it doesn't author.** Agents return a small structured
   **tile spec** (§7 / §15.5); a deterministic renderer turns it into UI. Fast,
   cheap, visually stable, predictable for spatial memory.
4. **Spatial & motor memory.** Layouts are consistent so the same action lives in
   the same place every time. Don't reflow or relabel on a whim.
5. **Legibility over density.** Telegraphic copy, generous sizing, high contrast
   on a dark ground.
6. **No dead air.** Every input produces immediate optimistic feedback (a bubble,
   a "…", a glow, an indicator pulse) before the real result lands.

### 14.1 Theme tokens (semantic)

Color tokens are defined in §4; their **meaning** is fixed and must be used
semantically, never decoratively:

| Token | Value | Semantic meaning |
|---|---|---|
| `--bg` / `--bg-elev` / `--bg-elev-2` | `#0b0f14` / `#131a23` / `#1c2632` | ground → first → second elevation |
| `--fg` / `--fg-dim` | `#e7ecf3` / `#8b97a8` | primary / muted text |
| `--accent` | `#6ea8ff` (blue) | primary accent, interactive emphasis |
| `--accent-2` | `#9cf2c1` (green) | **working / positive** — agent is busy (analyzing/drafting) |
| `--warn` | `#ffb86b` (orange) | **waiting on the user** — needs your reply |
| `--danger` | `#ff7b86` (red) | error / destructive only |
| `--focus` | `#ffffff` | focus ring/glow (white) |
| `--agent-color` | per-project | agent/project accent (set at runtime) |

Sizing follows the `--steam-*` tokens (§11.0): `--steam-input-h 48px`,
`--steam-button-h 56px`, `--steam-body-fs 17px`, `--steam-radius 12px`,
`--radius 14px`. Type: `Oxanium` / `Barlow Condensed` (display), `Source Sans 3`
(UI), `JetBrains Mono` (chat bubbles + code).

---

## 15. UI patterns, consistency & current behaviors

The living record of the renderer's component patterns and the interaction rules
added through the current iteration. When the GUI changes, update this section.

### 15.1 Layer terminology

Screens are written **Layer 0 / Layer 1 / Layer 2** — deliberately spelled out to
stay **distinct from the gamepad L1/R1 shoulder buttons**:

- **Layer 0 — Projects:** the project picker; talk to a project's lead from here.
- **Layer 1 — Team grid:** a project's agents as tiles.
- **Layer 2 — Agent view:** one agent zoomed in, with its chat.

Plus the **create flow** sub-sequence: *roles → topology → name → goal*.

### 15.2 Agent tile (Layer 1) — states & status-dot legend

Each tile shows **name**, **role**, and a **status line** (a colored dot + a
verb). The dot color is a fixed legend:

**Work verbs** (`VERB_LABELS`) — every non-idle verb is a **busy** state: a
**green** (`--accent-2`) **pulsing** dot, and it rolls up to project **Working**
(§15.2.1). They differ only in the **word**, never the color — keep the dot
legend to three meanings (green busy / orange needs-you / grey idle):

| Verb | Label | Meaning |
|---|---|---|
| `idle` | Idle | not working (dim grey dot) |
| `analyzing` | Analyzing | reading / classifying the codebase |
| `drafting` | Drafting | generating prose / a reply |
| `coding` | Coding | writing code |
| `prototyping` | Prototyping | spiking / building an app prototype |
| `documenting` | Documenting | updating docs |
| `reviewing` | Reviewing | checking code or another agent's output |
| `testing` | Testing | writing / running tests |
| `debugging` | Debugging | investigating a failure |
| `researching` | Researching | gathering external info / reading docs |
| `planning` | Planning | structuring work before drafting |
| `building` | Building | compiling / bundling |
| `deploying` | Deploying | shipping / releasing |
| `waiting` | Waiting | **blocked on a teammate** (a delegate) — still busy/green, *not* the orange "needs you" |

**Pending overlays** (shown only while the verb is `idle`):

| State | Label | Dot color | Clears when |
|---|---|---|---|
| `data-unseen` | **Waiting for response** | **orange** (`--warn`), pulsing tile glow | the user **replies** |
| `data-complete` | **Task complete** | **green** (`--accent-2`), steady green tile highlight | the user **opens** the agent |

> **Emission status:** the server (`emitStatus`) currently emits only `idle`,
> `analyzing`, and `drafting`. The rest are **renderer-ready** (label + green dot
> + project rollup all work) but will not appear until the orchestrator calls
> `emitStatus()` with them — i.e. once agent work is classified into these verbs.

Which pending state an agent lands in is decided by **what its reply is**, not
how it was triggered. The server tags the reply's activity event with an
`awaitKind`:
- Reply has `choices[]` (it asked a question) → `awaitKind: 'reply'` →
  **"Waiting for response"**. Stays until the user actually answers (submits) —
  not on mere view. So an unanswered question bubble always reads "Waiting for
  response".
- Reply is a deliverable (no choices) → `awaitKind: 'view'` → **"Task
  complete"**. Clears the moment the user opens that agent (or immediately if
  they're already looking at it).

The renderer tracks this in an `agentPending` map (`agentId → 'reply' | 'view'`);
pending states only show while the verb is idle (the work verb wins while busy).
Other flags: `data-lead` (PM tile), `data-disabled` (toggled off),
`data-speaking` (soft outline pulse while its TTS plays).

### 15.2.1 Project tile (Layer 0) — rolled-up status

**Projects and agents use separate status vocabularies — do not mix them.** An
*agent* tile (L1) shows a fine-grained **verb** (Idle / Analyzing / Drafting /
Waiting) plus a pending overlay (Waiting for response / Task complete). A
*project* tile (L0) shows none of those verbs; it **rolls its agents' live state
up** into one of three project-level labels. Visually it uses the **same style as
the agent status line** — **white text (`--fg`) + a colored status dot** — so the
two grids' metadata lines up; the dot (not the text) carries the status color:

| Project status | Shown when | Dot color | Source |
|---|---|---|---|
| **Needs attention** | any enabled agent is **idle but awaiting the user's reply** (`agentPending === 'reply'`) | **orange** (`--warn`) | `projectStatus()` |
| **Working** | any enabled agent has a **non-idle verb** (any work verb — coding, testing, reviewing, …) and none needs the user | **green** (`--accent-2`) | `projectStatus()` |
| **Updated _X_ ago** | no agent is busy or awaiting — the last-activity timestamp | dim grey (`--fg-dim`) | `formatProjectUpdated()` |

Priority is **Needs attention > Working > Updated** — the actionable state
wins. The label is computed by `projectStatus(p)` (returns `{ kind, label }`
where `kind ∈ {attention, working, updated}`, surfaced as
`data-status` on `.project-updated`). Disabled agents are ignored.

Because L0 tiles are built once by `renderProjects()` and not re-rendered on
every event, `paintProjectStatuses()` repaints them in place on each `status`
and `activity`/`delegate` event so "Working" / "Needs attention" track agent
activity live. Mapping at a glance:

| Agent verb / pending (L1)        | Contributes to project status (L0) |
|----------------------------------|------------------------------------|
| any non-idle work verb (`analyzing`, `coding`, `testing`, `waiting`, …) | **Working** |
| idle + pending `reply`           | **Needs attention** |
| idle + pending `view` (Task complete) | nothing — falls through to **Updated X ago** |
| idle, no pending                 | nothing — **Updated X ago** |

### 15.3 Chat bubbles (Layer 2)

- **Your messages:** right-aligned, accent-tinted, timestamp + retry/edit
  affordances. **No name header.**
- **Agent messages:** left-aligned, neutral surface, markdown-rendered. The
  **viewed agent's own** bubbles get **no name header**; a **foreign** bubble
  (a delegate's reply surfaced into this chat) gets a `Name · ROLE` header and a
  subtle tint — only *other* agents are labeled.
- **Handoff marker:** a delegation renders as a normal left bubble with a
  `From Role → To Role` heading + the task.
- **Live streaming:** an optimistic "you" bubble on speak; an agent "…" bubble on
  submit; the reply streams token-by-token.

### 15.4 In-bubble actions, kickoff approval & choices

- **Bubble nav model (`cycleBubbleAction`):** when a bubble is focused,
  **Left/Right** cycle that bubble's in-bubble controls (retry/edit on your
  bubbles; **Reject/Approve** on a kickoff plan; **choice options**). **✕/Enter**
  activates the focused control.
- **Auto-select last bubble on entry:** navigating **into** an agent (opening it
  from L1, or swiping / `[` `]` to another agent at L2) lands focus on that
  agent's **last bubble** — so you start on its most recent message with no
  press to reach it. Set via a one-shot `_focusLastOnNextChatRender` flag that
  only the navigation paths (`enterZoom` true-entry, `cycleAgent`) raise, so
  live re-renders (SSE/ack) never steal focus. A more specific auto-focus
  (kickoff plan, or a fresh question's first choice) takes precedence when present.
- **Kickoff approval:** the PM's plan bubble embeds **Reject / Approve** (standard
  `role-cancel` / `role-confirm` button styles, ~30% smaller), bottom-right.
  Reachable by keyboard/gamepad/mouse. **One-tap Approve:** pressing **✕/Enter**
  while the bubble itself is focused (no button focused yet) activates **Approve**
  directly — so approval never takes two presses. Left then ✕ rejects.
  Approve → run kickoff; Reject → posts a "Reject" turn + a brief PM ack.
- **In-bubble choices (multi-select):** when a decision is needed an agent
  returns `choices[]`; rendered as **one horizontal row** of options, each
  showing its letter (**A / B / C…**) as a heading with the description on the
  next line, **uniform height** that grows to fit the wrapped text.
  - **Layout (no clipping):** the options row is a **single-row CSS grid**
    (`grid-auto-flow: column; grid-auto-columns: minmax(0,1fr)`); the option
    elements are **block-flow `<div role="button">`** (NOT `<button>`, which
    mis-reports wrapped-content height to grid track sizing). Grid auto-row
    sizes to the tallest option's full block height and stretches every cell to
    it — so long descriptions never clip and all options match height, and it
    reflows correctly when the web font loads. Do **not** JS-measure heights:
    a `scrollHeight` pass runs before the font swaps in and locks a stale height.
  - **Multi-select:** toggle one or more with **Enter / ✕** (Space is *not* a
    toggle). A **"Other — Hold to talk"** button (always appended) starts
    push-to-talk for a free-form answer, playing the standard mic wave inside
    itself. A **"Select one or more with ←/→"** hint sits bottom-left; **Submit** sits
    bottom-right and is **grayed out until at least one option is selected**.
    Submitting sends the chosen option(s) as the user's next message.
  - **Entrance:** buttons stagger in one-by-one (like Layer 1 tiles).
  - **Auto-focus on arrival:** when a **new** question bubble lands (e.g. right
    after you submit the previous answer), focus drops straight onto its **first
    option** — no press to reach the bubble, no press to step into the options —
    so the next answer is just *select → Submit*. Only fires for a genuinely new
    bubble (`hasNew`), and sets `chatBubbleIdx` to that bubble so the standard
    bubble nav (`cycleBubbleAction`, Submit) takes over. Mirrors the kickoff
    plan's one-tap auto-focus.
  - **Memorialized:** once a later user turn answers the question, that bubble
    re-renders **read-only** with the picked options shown selected — no Submit,
    Other, or hint (it's a record). Read-only entries drop `role`/`tabindex`
    (out of the nav ring).

### 15.5 Tile-spec contract (deterministic UI)

Agents never author UI. They return one JSON object the renderer turns into a
surface (full schema in §7):

```jsonc
{
  "intent":  "take_note" | "list_notes" | "answer" | "delegate",
  "template":"compose" | "list" | "reader" | "confirm",
  "context": "string shown at top",
  "title":   "string",
  "body":    "markdown (reader/compose) — bold/lists/tables/code/quotes; NO italics",
  "items":   [{ "id": "...", "label": "..." }],
  "choices": ["A — ...", "B — ..."],   // OPTIONAL: 2-4 in-bubble options
  "actions": [{ "verb": "Save", "glyph": "cross", "action": { "type": "save_note" } }],
  "actions_taken": [ /* created|edited|deleted|ran|read|searched summaries */ ]
}
```

Glyphs: `cross | circle | square | triangle`. `parseSpec` repairs malformed JSON
(control chars, body extraction) so rich agent output **never 500s** — it degrades
to a plain answer.

### 15.6 Agent response voice (house style)

Shared across every agent (`RESPONSE_STYLE`, injected into system + prose + kickoff
prompts):

- **Legible thinking:** state decision criteria early.
- **Bullets, concise.** Telegraphic allowed (drop "the"/"a").
- **Bold** for emphasis OK. **No italics** (harder to read on a 10-foot screen).
- **Emoji** only paired with text when giving result feedback *and* confidence
  ≥ 0.9. Never decoration.
- **Offer choices** (2–4, A–D) when direction is unclear instead of guessing.
- **Banned (hard):** "In today's fast-paced world…", "Great question!",
  "Certainly!/Absolutely!", "As an AI…", "unlock/unleash/supercharge/leverage"
  (verb), "game-changer/revolutionary/cutting-edge", em-dashes as every-other-
  sentence connectors.
- **Avoid:** "I hope this helps", "Let me know if you need anything else", "It's
  important to note…", "delve/dive into", "That said,", rhetorical openers.
- **Conduct:** no destructive actions without confirmation; never expose secrets;
  don't fabricate APIs/citations; don't claim untested work is done; correct over
  helpful-seeming; disclaimers on financial/legal/medical.
- **Grounding (hard):** every agent's only outputs are **markdown documents and
  code, produced in the conversation**. No external/visual tools (Figma, Sketch),
  channels, email, tickets, internet, or repos it can't see. Never promise
  external artifacts ("I'll share a Figma link", "post in the channel", "tag the
  PM later") or **ETAs/deadlines** ("2 days", "by Friday"). Do the work now or
  ask a focused question. **Per-role guidance** (`ROLE_GUIDANCE`) layers on top —
  e.g. the **Designer** sequences: design principles / UI guidelines / creative
  direction / system design → *confirm with the user* → use cases + user flows →
  *confirm* → only then build the GUI in code.

### 15.7 Voice & STT

- **Push-to-talk only.** Hold **V** (keyboard) or **R2** (gamepad) to talk;
  release to transcribe. Copy is "Hold V to talk" everywhere.
- **Local Parakeet only** — never the browser engine. A failure surfaces
  **visibly** (red message in the capture mic area + status indicator), never
  silent.
- **Live partials:** while holding on a capture screen, the audio-so-far is
  re-transcribed (~450ms) so words appear as you speak.
- **Wave** shows only while holding; the mic opens only during a hold.
- **Capture box** is fixed-height — it does **not** resize as content changes.
  Default = "Hold V to talk" centered; Holding = live wave; Committed = text.

### 15.8 Capture-screen button row

Right-aligned: **Cancel · Back · Clear · Continue** (Continue/Create
default-highlighted). **Clear** wipes the field to re-dictate. A single Back
chip — no duplicate action-bar Back. Entrance animates on screen transitions
(`capture-enter`), not on internal re-renders.

### 15.9 Drawers

Left drawers, mutually exclusive: **Explorer**, **Activity**, **Memory**. They
share a common **width** (320px) and **header style** (drawer label, weight 400).

- **Explorer** — project `.md` files (the code/build folder is hidden), grouped
  into collapsible folders (Roles, Notes, …). Keyboard/gamepad **and mouse**:
  clicking a file opens it in the viewer; clicking a folder header toggles it.
- **Activity** — always the **cross-project** feed, the same from Layer 0/1/2
  (header reads just "Activity"). Lists **agent responses across every project**,
  most-recent first, each as a card: **project name** (heading) → **agent name ·
  role** → a **quick summary** of the response (clamped to ~3 lines). Click /
  Enter opens that project and agent.
- **Memory** — global notes (Layer 0).

### 15.10 Name library

Agent names are globally unique. Each role has a short curated `namePool`; when it
is exhausted the picker draws a fresh distinct name from a large shared
`FALLBACK_NAMES` library — **never** a numeric suffix like "Cassidy 2". A numeric
suffix is only a last resort if both pools are fully exhausted.

### 15.11 Consistency rules (anti-patterns — don't)

- Don't add mouse-only affordances.
- Don't reflow/relabel surfaces between renders (breaks spatial memory).
- Don't resize the capture box as its content changes.
- Don't suffix names with numbers — draw from the shared library.
- Don't let the **× close** be reachable by Left/Right — it's only via Up-through-
  bubbles; **Down** from × returns to the last bubble.
- Don't use **italics** in agent output.
- Don't show the viewed agent's own name header on its bubbles (only foreign /
  delegate bubbles).
- Don't make the user press twice — primary actions (Approve) activate on the
  first ✕/Enter from the focused bubble.
- Don't fabricate external deliverables, tools, or ETAs in agent output (§15.6
  grounding).

### 15.12 PM kickoff lifecycle (current)

On project create the PM auto-kicks-off (`app/server/kickoff.js`), a
plan-first state machine on `project.kickoff.status` that runs all the way from
a plan to **running, tested code** in the project repo:

1. **`drafting`** → PM writes a plan-first message; its tile reads **Drafting**.
2. **`awaiting_approval`** → the plan posts as a **choice bubble** (§15.4), not
   Approve/Reject buttons: *"Go ahead with this plan"* / *"Go ahead, but ask me
   clarifying questions first"* / *"Let me adjust the plan first"*. The first two
   proceed; the third holds so you can steer. The plan bubble auto-focuses on open.
3. On an approving choice → **`running`**: PM writes the 4 starter docs (PRD,
   roadmap, operating notes, open questions) into `<repo>/docs/`, then assigns
   work. Assignment is **role-based** via the PM model — it may pick roles **not
   yet on the team**.
4. **`asking`** → the PM asks its kickoff questions **one at a time**, numbered
   **"Q1: …"**, each as a multi-select choice bubble (§15.4). A role the PM
   couldn't confidently task becomes a **clarify question** whose answer becomes
   that role's task. Every on-team role is guaranteed a task (gap-filled if
   needed). Each Q→answer is folded into `open-questions.md` as a decisions log.
   The PM reads **Waiting for response** between questions.
5. **`team_review`** → a **team planning round**: each specialist asks the user
   **one** question in turn (so every role shapes the plan before any code is
   written). Answers are recorded as that agent's planning notes and committed
   (*"Add team planning notes"*).
6. **`build_pending`** → the PM proposes a **build plan** with choices
   *"Build it"* / *"Hold off — let me adjust"* (`BUILD_CHOICES`). **"Build it"**
   → `runScaffold` generates the initial source tree and **commits** it
   (with a syntax-fix pass via `node --check`); the reply reports the file count
   and commit SHA.
7. **`run_pending`** → after a successful scaffold the PM offers *"Run it"* /
   *"Not now"* (`RUN_CHOICES`). **"Run it"** → `runAndFix` (B3): install → build
   → test the repo **in a throwaway sandbox container** (§12.5.5), and on failure
   feed the failing step + repo files to the model, apply its edits, commit, and
   re-verify — bounded by `maxRounds`. Outcomes:
   - green → **`verified`** (*"✅ It runs…"*);
   - still failing after the rounds → **`built`** (reports the failing step + tail
     of output; *"Run it"* retries);
   - container engine unreachable → stays **`run_pending`** (asks you to start it,
     e.g. `colima start`).
   **"Not now"** → **`done`** (code is committed; nothing run).
8. Across these stages the team also **fans out**: assigned specialists run their
   tasks (`startTeamWork` → `interpretIntent`), tiles light up (analyzing →
   drafting), and **missing roles are auto-added** (`addAgent` → "Added
   teammates" message + `team_changed` grid refresh). Each agent follows the
   **project topology** (injected into its prompt) and the §15.6 grounding; a
   delegated task records as a **PM → agent handoff bubble**. Terminal statuses
   (`done` / `verified` / `built` / `declined`) set no pending state.

### 15.13 Chat motion (Layer 2)

- **Thinking:** a "…" bubble shows whenever an agent is working and the user is
  waiting — across every agent (driven by status events for server-initiated
  work, optimistically for client requests).
- **Typed text:** live LLM replies stream token-by-token; *scripted* bubbles
  (kickoff plan/questions/closing) **typewriter-reveal** then snap to markdown.
- **Arrival:** new turns rise + fade in at the bottom while older content slides
  up; only genuinely-new bubbles animate (tracked per agent). The newest agent
  bubble flashes a highlight; choice buttons stagger in like Layer 1 tiles.
