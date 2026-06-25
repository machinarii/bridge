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

## What's new (this session — capture-flow type sizing + mic-stack stability + `/`·`A`·`E` sound)

Renderer-only (`app/renderer/main.js`, `style.css`). No server changes; server suite untouched. **Verify renderer edits with `node --check --input-type=module < app/renderer/main.js`** (plain `node --check` misses duplicate top-level declarations, which blank the screen).

### Capture textboxes: smaller text + agent-bubble live transcript
- **Live transcript** (`.mic-live-text`) now renders in the **agent-bubble font** (JetBrains Mono ExtraLight, `font-weight:200`) and is sized down **1.25rem → 0.95rem**.
- **Smaller text across the new-project flow:** `.capture-value` (name/objective/features box) **1.4rem → 1.1rem**; each accumulated block `.capture-block` **1.05rem → 0.9rem** (name filled-state inherits the value size).

### Mic-stack no longer shifts the UI when the wave appears
Starting to talk swapped the small "Hold V to talk" hint for the 60px wave (`.mic-bars`), and because the capture tile is vertically centered that height change pushed the textbox + heading above it up/down. Fix: `.mic-label` now occupies the **same fixed 60px height** as `.mic-bars` (flex-centered), so toggling hint↔wave is height-neutral and nothing above moves. (The live-transcript slot still expands when recognized words arrive — separate, later slot.)

### `/`, `A`, `E` keys play the `select` sound
The bare-key shortcuts — `/` (type prompt), `A` (activity drawer), `E` (file explorer) — now `playSfx('select')` (`sounds/ui-sound-select.m4a`) inside their existing guards, so the click only fires when the key actually triggers its action (never while typing in a text field; `A`/`/` only in their active modes).

## What's new (previous session — footer focus retention, hold-to-talk, voice + sound polish)

Renderer-only (`app/renderer/main.js`, `style.css`). No server changes; server suite untouched. **Verify renderer edits with `node --check --input-type=module < app/renderer/main.js`** — plain `node --check` parses as a *script* and misses **duplicate top-level declarations**, which are a fatal SyntaxError in module mode and **blank the whole screen**. main.js is ~8k lines, so a helper you reach for often already exists — **grep the name before adding any top-level `function`/`let`/`const`.** For a true boot check, load the app headlessly in Electron and read `console.error` + `#surface` child count. Still **re-test in the app after a hard refresh.**

### Footer rail focus retention (identity-based)
Activating a rail chip used to drop the cursor on the re-render. Chips now carry a stable `dataset.scKey` (`buildChip`/`setPrimaryShortcut`); activating a **keepFocus** chip records that key in `_pendingFooterKey`, and the next `setShortcuts` re-asserts focus on the same chip by identity via `restorePendingFooterFocus()`/`footerKeyIndex()`. One-shot (not sticky) — checked that L2 chat updates re-call `_setL2Shortcuts`, so sticky retention would yank focus back mid-stream. Cleared by any deliberate rail nav (`moveShortcutFocus`/`leaveShortcuts`).
- **Applies to:** `[` `]` `A` `E` (`keepFocus:true` on the items), **Back** (marked in `setShortcuts`), plus the **V/R holds** (via `endChipHold`).
- **Back→Select fallback:** `footerKeyIndex` maps a missing `Esc` (Back) to `Enter` (Select), so backing out to a screen with no Back (e.g. L0) keeps the cursor on Select instead of vanishing.
- **`E` Explorer opens without stealing focus:** `openFileExplorer` detects rail activation (`_pendingFooterKey != null`) and skips `explorerFocused`/`paintFileFocus`, so the panel opens but the chip stays focused. The global `E` key still focuses the explorer.
- **Retention suppresses L2 last-bubble auto-focus:** a keepFocus chip that enters/changes L2 (e.g. switching agents via `[`/`]` on L2) would otherwise lose focus to the auto-focused last bubble (`_focusLastOnNextChatRender`, set by `enterZoom`/`cycleAgent`). `restorePendingFooterFocus` clears that flag when it restores, so the rail keeps focus. Grid-tile entry (no pending key) is unaffected and still lands on the last bubble.
- **Inert-in-rail chips** (`disabledInRail`): **Agent on/off** (needs a selected grid tile) and **Select** (acts on the focused tile/bubble, not from the rail). When focused in the rail they render disabled (`.sc.focused.disabled`, now also styled under `#primary-shortcut`/`#back-shortcut`) and `activateFocusedShortcut` no-ops them.

### Hold-to-talk / reasoning from a focused chip
The "Hold to talk" (V) and "Reasoning" (R) chips are now `hold:{start,end}` chips (`beginChipHold`/`endChipHold`), so when focused they **press-and-hold** via Enter, gamepad-X, or click-hold (pointer capture) — mirroring the global V/R key holds (talk → `startPTT`/`endPTT`; reasoning → `openEffortPicker`/`commitEffortPicker`, nudge ↑/↓ while held).
- **Continuous-hold fix:** `startPTT` calls `leaveShortcuts`, which cleared rail focus the instant the hold began — so auto-repeat Enters fell through to the screen's default Enter action ("multiple keypresses"). Now a guard at the top of the main keydown handler swallows Enter while `_footerHoldEl` is set; keyup ends the hold. After release, focus is restored to the chip (one-shot, see retention above).

### Settings modal nav
- **Up from a tab → × close button** (keyboard + gamepad); **Down from × → active tab**. Other arrows on × rubberband. (`settingsCloseEl` + branches in the settings keydown/`handleSettingsGamepad`.)

### Capture-flow cancel now confirms
Cancel/X during name/objective/features used to bail to L0 without a prompt when the *current* field was empty — even though the name (always set by later steps) would be lost. Now gated on `hasCaptureProgress()` (any of name/goal/features filled), so it shows the confirm dialog whenever there's work to lose.

### Voice — silent holds no longer submit phantom text
Parakeet hallucinates a short filler ("Yeah.", "you", "Thank you") on a silent hold; those are non-empty so they passed the empty-check and got submitted. `postLocalTranscript` now runs `isProbablySilent(blob)` — decodes the clip and drops it if **peak amplitude < ~0.02** (peak, so even a quiet real word survives; fails OPEN if the clip can't be decoded).

### Chat bubble — wide user bubbles keep their action buttons on screen
The focus "slide-left" was a fixed `−72px` that only cleared narrow bubbles by leaning on the scroll container's right padding; wide bubbles then pushed the retry/edit row off-screen into a horizontal scrollbar. The slide is now sized to the full action-row footprint (`translateX(-6rem)`, `style.css`), width-independent.

### Sound feedback
- **Per-sound gains** (`SFX_VOLUMES`, applied per-play via a Web Audio GainNode): `navStrip` lowered **0.3 → 0.05**, added `select: 0.05` (default `SFX_VOLUME` is 0.084). Volume is set dynamically in code — the `.m4a` files are unmodified.
- **Settings** Cancel / Save / × → `select` (all activation paths; Save via `saveSettings`).
- **New-project** Cancel / Back → `zoomout`, Clear → `select` (one delegated capture-phase listener on `surfaceEl` covering all three capture steps, since the buttons reuse IDs `capture-cancel`/`capture-back`/`capture-redo`).
- **Settings** × close → `select` (its click handler; covers Enter/cross-on-focused-× which synthesize a click).
- **New SFX clip `bump`** (`sounds/ui-sound-bump.m4a`) plays on every edge rubberband — added inside `bumpEdge()`, so all call sites get it. ⚠️ The renderer serves sounds from **`app/renderer/sounds/`**, NOT the repo-root `sounds/` the user references — new clips must be copied there (this one was).
- **MD/file viewer** (`showFileViewer`/`closeFileViewer`): `swooshNext` on open, `swooshPrev` on close, `select` layered on the × button press. Focus moves around the viewer play `navigate`: ×↔body, body↔surface-container, body↔explorer — via a guard flag `_viewerNavSilent` (set during open so the swoosh isn't doubled) in `setViewerBodyFocus`/`setSurfaceContainerFocus`, plus inline `playSfx('navigate')` on the body→× / body→explorer moves (which only turn body focus *off*).

### Activity drawer — now keyboard/gamepad navigable (view-only)
The feed was display-only; it now mirrors the file explorer's focus model but **without open**. New state `activityFocused`/`activityFocusIdx`/`activityEntries` + `paintActivityFocus`/`stepActivityFocus`/`enterActivityFromSurface`/`exitActivityRight`. **Left** from the grid's left edge (or **A/▲**, which now also opens it) enters the feed and lands on the **newest (top)** entry; **Up/Down** move the highlight (scroll into view, nav sound); **Right/Esc** leave. `A`'s footer `keepFocus` was removed since it now enters the drawer. Entry-collection + clamp happen in `repaintActivityList` (survives live SSE re-renders). Style: `.activity-entry.focused` reuses the file-entry inset bar.
- **Text cleanup:** each line is `sentenceCase`'d (first letter up, rest preserved); a redundant leading role tag is stripped from the summary (full role label or a short `^[A-Z]{2,4}:` acronym like "PM:"); the project-name heading is now **white** (`--fg`), not blue.

### MD viewer interaction guards
- **Project/agent switching disabled while the viewer is open:** `cycleProject`/`cycleAgent` early-return on `fileViewerOpen` (covers `[`/`]` keys, L1/R1 buttons, two-finger swipe, and the footer chip). The `[`/`]` chips are also **hidden** via CSS (`body[data-file-viewer="open"] #shortcuts-rail .sc[data-sc-key="["/"]"]`) — `display:none` also drops them from footer nav.
- **Explorer follows the project:** switching projects with the explorer open reloads its tree via `refreshFileExplorer()` (re-fetch + `rebuildFileEntries`, closes a stale viewer, preserves open/focus state).

### L1 decluttered — voice / reasoning / type-prompt removed
L1 (project grid) is navigation-only now. The **V hold-to-talk**, **R reasoning**, and **`/` type-prompt** affordances are gone — chip AND capability:
- V: chip dropped from `updateGridShortcuts`; `MODE_GRID` removed from `PTT_MODES` so the V key / R2 button no-op on L1 (L0 talk-to-lead unchanged).
- R: chip dropped; `effortScope()` returns null for `MODE_GRID`, so the R key / touchpad picker is inert on L1. **Reasoning effort is now L2 (per-agent) only — there's no longer a way to set project-level effort.**
- `/`: the global handler was firing in every mode; now gated off on `MODE_PROJECTS` (L0) and `MODE_GRID` (L1).

### Confirmation modals + more sound feedback
- **New SFX clip `notification`** (`sounds/ui-sound-notification.m4a`, copied to `app/renderer/sounds/`): plays when a confirm modal appears (`maybeConfirmCancel`).
- Confirm-modal **buttons → `select`** on press (Yes/No, all input paths), **`navigate`** when toggling between them (keyboard + gamepad).
- **Settings + fullscreen icons → `select`** (added in `openSettings`/`toggleFullscreen`, so every entry point is covered).
- **New-project Cancel** only plays `zoomout` when it leaves directly; when there's progress it pops the confirm modal instead (which plays `notification`) — no double sound.
- Copy: typed-input placeholder "press Enter" → **"press return"**.

### `[` / `]` chips now flash when pressed
`slideAgent`'s `doSwap()` is **synchronous**, so `cycleProject`/`cycleAgent` rebuild the footer rail immediately, destroying the chip the keydown just started flashing (other keys don't rebuild the rail, so they worked). Fix: re-flash the `[`/`]` chip (keyboard + gamepad glyph) right after the slide.

### Activity drawer follow-ups
- **A chip keeps focus when activated from the rail.** Re-added `keepFocus` to the A chips; `openActivityDrawer` only auto-enters the feed (newest entry) when **not** from the rail (`_pendingFooterKey == null`) — same rule as the Explorer chip. So the **A key/▲** enters the panel, but **Enter/X on the highlighted A chip** opens it and keeps focus on the chip.
- **Header is fixed, not sticky.** The drawer is now a flex column where only `.activity-list` scrolls (`overscroll-behavior: contain`). This keeps the heading always visible, out of the overscroll bounce, and stops `scrollIntoView` from parking the first entry under it (the header is 66px — taller than a sticky scroll-offset would reliably clear).

### New-project capture screens overhaul
- **Name ≤ 30 chars.** `NAME_LIMIT` 40 → 30 in the renderer AND `app/server/server.js` (the LLM-backed `/projects/shorten-name`). Over-limit names still shorten on Continue; a heads-up under the field warns it'll be condensed. **Server change → needs a `npm run server` restart.**
- **Name field is a fixed single line** (`.capture-name`): same 4rem height empty / capturing / filled, 30% narrower; the wave bars are dropped here (don't fit one line) but the "Hold V" prompt + live transcript still show. (Verified empty == filled == 88px.)
- **Objective / Features fields are taller** (`.capture-tall`, 15.5rem) and **accumulate blocks**: each voice dictation OR `/`-typed entry **appends** a new block instead of replacing (`captureValueInner(text,{keepMic})` + `appendCaptureBlock`, wired into both `dispatchTranscript` and `submitTypedText`). Blocks stack top-down with a 1.1rem gap; the mic prompt stays below so you can keep adding. Newest block reveals with the typewriter animation.
- **STT text reveals like agent bubbles** — `revealCaptureText()` runs `typewriterReveal` on the new text (whole name, or the newest objective/features block).
- **Cancel always confirms.** During name/objective/features, Cancel now always pops the "do you really want to cancel?" modal (was: only when something was entered). The modal plays `notification`; the Cancel button no longer plays zoomout. (`hasCaptureProgress` removed.)

### Misc
- **Checkbox activation → `select`**: a delegated `change` listener covers native click/Space toggles; the programmatic gamepad-cross / Enter toggles (which don't fire `change`) add `select` inline.
- **File explorer:** removed the agent name (e.g. "Rowan") shown next to role/charter `.md` filenames — just the filename now.
- **MD viewer × button:** plays only the close swoosh now (the `select` press sound was removed).

## What's new (earlier session — background runs, council parity, bubble/sound polish)

All renderer + a few server changes. New server module: `council-store.js`. New
tests: `cancel.test.js`, `health.test.js`, `schema.test.js`, `smoke-flow.test.js`
(from the prior arc) plus `handoff-dedup.test.js` and `council-store.test.js` —
full server suite green (`node --test "app/server/*.test.js"`).

### Runs keep going when you navigate away (the big behavior change)
Back (`exitZoom`), leaving the project (`exitToProjects`), and switching agents
(`cycleAgent`/`cycleProject`/`openAgentById`) used to call `cancelActiveRequest`,
which canceled the operation token server-side — so answering a question then
pressing Back killed the build ("Canceled by user"). New `releaseActiveRequest()`
detaches the client (aborts the fetch, forgets the token) **without** canceling
it; the run finishes server-side and lands in history / over SSE. Only the **Stop
button** or a superseding submit cancels a run now.

### Stop button replaces the footer "X Cancel run"
While an agent is thinking, the "…" pending bubble carries an inline **Stop** pill
(icon + label, standard button font/colors) on its right; select the bubble and
press Right to reach it, Enter/Cross to cancel (`cancelActiveRequest`). The L2
footer `X Cancel run` shortcut + bare-key handler were removed.

### Council ↔ agent L2 parity
- Intake questions render through the **real `buildChoiceList`** (lettered
  `.choice-btn` grid, Submit, Skip, "Other — hold to talk") via new `onSubmit`/
  `onSkip` callbacks.
- Council bubbles join the `chatBubbles` nav ring (`registerNavBubbles`), and the
  keyboard/gamepad bubble-nav was extracted into shared `bubbleNavKeydown`/
  `bubbleNavButton` that now run for `MODE_COUNCIL` too — so council bubbles are
  selectable and arrow-navigable exactly like agent L2.
- **Persistence:** new `council-store.js` (`<stateDir>/council.json`,
  GET/PUT `/projects/:pid/council`, cleared on project create/delete). The
  renderer saves `councilState` after each step and restores on `openCouncil`.

### Bubble + markdown polish (`md.js`, `style.css`)
- Markdown headings render at **body size** (weight-only emphasis) — a run-on
  `# …` line no longer renders gigantic.
- Bare **http(s) URLs auto-link** (`linkifyUrls`), without touching existing
  markdown links or code (`processTextSegments` skips `<a>`/`<code>`).
- **Color swatches** render next to hex / `rgb(a)` values (`addColorSwatches`).

### Deliverables — role-named, in a folder
`reportToLead` now writes `deliverables/deliverables-<role-slug>.md` (reusing
`charterFileNameFor`, so `sw_engineer → sw-eng`), e.g.
`deliverables/deliverables-designer.md`. The report-bubble preview keeps markdown
structure and truncates at a clean boundary (`reportSnippet`).

### Kickoff question ordering
`executeKickoff` now leads with the PM's foundational product questions (model-
ranked) and appends role clarifications by priority — a security-scope clarify no
longer outranks "what are we building?".

### Health tab
- OpenRouter row shows the **remaining credit balance** (`/api/v1/credits`).
- Local STT row shows the **model name** (sidecar `/health` now reports `model`;
  falls back to `Parakeet (<backend>)`).
- Out-of-credits resilience: completion `max_tokens` is capped (`samplingFor`
  reasoning+8192; `llm.js` 32768) so a low balance doesn't 402 the full ceiling,
  and a failed `/interpret` now renders a visible **error bubble** in chat.

### Handoff bubbles are idempotent
`interpretIntent` skips the From→To handoff turn if the agent's last turn is
already that exact handoff — a retried task no longer duplicates the bubble.

### Sound design
- New **`navStrip`** clip (`ui-sound-navigate-strip.m4a`, vol 0.3) when entering /
  moving across the **footer shortcut rail** (`enterShortcuts`/`moveShortcutFocus`).
- `navigate` now plays on within-bubble action moves (`cycleBubbleAction`), role-
  picker tile moves (`roleGridMove`), and reaching the **× close** button.
- New-project flow: **zoomin** on Continue (advance), **zoomout** on Esc/Back/⊙
  (all routed through `goBackInCreateFlow`).
- L2 entry no longer fires `zoomin`+`navigate` back-to-back (`focusBubble` only
  plays `navigate` when already on a bubble).

### L2 / grid interaction
- Single-press **Back** from a selected bubble (`backFromBubbleView`) instead of
  un-select-then-exit.
- L1 grid **scrolls past 12 tiles**; Down from a last-column tile lands on the
  short final row (e.g. "Add / remove agent"), not the footer.
- Typing in any text field no longer flashes footer chips or fires bare-key
  shortcuts (`isTextInputFocused`).

## What's new (previous session — run cancellation, voice cleanup, skills)

Full suite **205/205** (`node --test "app/server/*.test.js"`).

### Run cancellation — cancel tokens now reach the work
Navigating away or hitting cancel must actually stop in-flight model work, not just abort the HTTP request. Cancel **operation tokens** are threaded end-to-end:
- **Server.** `/projects/:pid/agents/:aid/interpret` (the normal turn **and** the delegate hop via `resolveDelegateSpec`) and `/projects/:pid/team/interpret` now pass `cancelToken` down. `team.js` `runTeamVoice` + `resolveDelegateSpec` take a `cancelToken` and call `throwIfCanceled()` at every checkpoint — before routing, after parse/repair, around each assignee `interpretIntent`, before/after the delegation fan-out, before synthesis. A `CANCELED` error from an assignee now **rethrows** instead of being swallowed as an assignee failure.
- **Renderer token ownership (the race fix).** Rapid cancel/resubmit could let a *finishing old* request null out the *newer* request's token. Each submit now keeps a local `opToken`; `currentCancelToken` is cleared only when it still `=== opToken` (`submitIntent`, `submitTeamIntent`, `maybeCancelCurrentOperation(token)`). New `cancelActiveRequest()` centralizes "abort inflight + cancel its token + show 'Canceled'"; every nav guard (`exitToGrid`, `cycleProject`/`cycleAgent`, `openAgentById`, `pickerMove`) and `submitIntent`'s pre-abort call it.
- **`X` = cancel run** at L2 — both a global bare-key handler and an L2 footer shortcut ("Cancel run").
- **Tests.** `cancel.test.js` — token lifecycle (create→cancel→throws→complete) and a regression proving **team voice observes a canceled token before doing work** (`runTeamVoice` rejects with `code:'CANCELED'`). New `health.test.js`, `schema.test.js`, `smoke-flow.test.js` also landed.

### Voice = Parakeet-only (wording cleanup, no behavior change)
Removed the last stale references to the browser `webkitSpeechRecognition` fallback in `app/electron/main.js` and `app/renderer/main.js` comments; README STT line reworded. Voice already never fell back — the code now says so. Settings tab order: **Git** now precedes **Health**.

### GitHub token persist hardened
The `/github` POST persist (`writeSecret`/`deleteSecret` + `writeEnvFile`) is now fire-and-forget async with a `.catch`, so a slow/failed secret write can't hang the request.

### Skills — additions (`app/server/skills.js` + `skill-playbooks/`)
- **`skillspector`** (security): wraps the NVIDIA SkillSpector CLI to vet an agent skill before install (prompt injection, data exfiltration, excessive agency, supply chain). Tool installed at `~/.claude/tools/SkillSpector` via `uv tool install`; update with `git -C ~/.claude/tools/SkillSpector pull && uv tool install --reinstall ~/.claude/tools/SkillSpector`.
- **`ui-ux-pro`** gained a vendored playbook (was description-only) distilling the upstream priority-ordered design framework; the upstream repo also ships a Python `search.py` design-system generator referenced in the playbook.
- **From `affaan-m/ECC`** (cherry-picked into existing roles, condensed to Bridge playbooks): `engineering-patterns` got a real playbook (was description-only); new **`database-migrations`**, **`deployment-patterns`**, **`architecture-decision-records`** (sw_engineer) and **`accessibility`** (designer, qa). Only prose/methodology was vendored — none of ECC's executable harness machinery.
- Full catalog + mechanics documented in **`docs/skills.md`** (gitignored): **49 skills, 20 with playbooks**.

## What's new (previous session — Council, agent performance, gate fixes, polish)

Full suite **195/195** (`node --test "app/server/*.test.js"`). New modules this session: `council.js`, `learnings.js`, `metrics.js`. (Heads-up: outside this arc the OpenRouter key moved to a **secrets store** — `app/server/secrets.js`, `readSecret`/`writeSecret`; `/settings` is now `async`. New `cancel.js`, `health.js`, `schema.js`, `server-files.js`, `server-metrics.js` also appeared. The "key in `.env`" setup notes above may be stale — verify against `secrets.js`.)

### Council (`app/server/council.js` + renderer)
- **Flow:** PM intake → **blind, sequential** member answers → chairman synthesis. `POST /council/intake` (`buildIntake`/`normalizeIntake`, up to 3 single-select questions), `POST /council/member` (one model per index, in turn, each blind — sees only the question + PM context), `POST /council/synthesis` (`synthesize`). Members default to `openai/gpt-5.1`, `google/gemini-2.5-pro`, `deepseek/deepseek-r1` (chair = member 1; xAI omitted). Inspired by karpathy/llm-council.
- **It's now an agent, not a chip.** Surfaced as an **L1 grid tile** ("Council" / role "Advisory Team", `dataset.council`), selected like any agent (`enterZoom` routes non-agent tiles by dataset). It **reuses the entire agent L2 experience**: `councilShell()` sets `body.dataset.mode='zoom'` so it inherits all `.agent-view` CSS (transparent surface, header dissolve, rounded container) + the surface close button; `zoomin`/`zoomout` sounds via `exitCouncilToGrid()`. No bespoke composer — you ask by **holding V/R2 to talk or `/` to type** (`MODE_COUNCIL` is in `PTT_MODES`; `dispatchTranscript`/`submitTypedText` route it to `startCouncilIntake`). Everything renders as **chat bubbles** (question = user bubble; PM intake, each member, chair = agent bubbles) with a default greeting bubble. The old footer chip + `C` shortcut were removed.
- **Write-back:** the chair appends a `TAKEAWAY:` line (`extractTakeaway`); the `/council/synthesis` route stores it as a project **learning** (when `projectId` is sent), so council decisions persist into future agent turns.

### Agent performance (gstack-derived — see the analysis in chat)
- **Project learnings store (`learnings.js`).** Append-only per-project JSONL of durable insights (decision/pitfall/convention/preference/fact), deduped latest-write-wins, confidence-gated. `learningsBlock(projectId, role)` injects a `## Project learnings` block (confidence ≥7, cap 10, role-aware) into **both** agent prompts (`orchestrator.js`). Cleared on project create/delete (mirrors the scratchpad). `GET/POST /projects/:pid/learnings`. Tests: `learnings.test.js`.
- **Per-role model tiering (`models.js`).** **ON by default** (`OPENROUTER_TIERS`, set `=off` to disable). `defaultModelForRole(roleId)`: craft roles (Engineers, Designer, QA, Copy, Marketing) → `anthropic/claude-sonnet-4.6`; reasoning roles (PM, Security, Legal, Data Sci, Research) → flagship default (`opus-4.8`). Explicit per-role overrides still win. `/settings` returns `OPENROUTER_MODEL_DEFAULT_BY_ROLE` so each Settings → Models row shows its resolved default (e.g. "Default · Claude Sonnet 4.6"). Tests: `models.test.js`.
- **Per-call metrics (`metrics.js`).** Every OpenRouter call logs `model/role/kind/latency/tokens` to `<stateDir>/agent-metrics.jsonl` (instrumented in `llm.js` + the orchestrator streaming turn); never throws into the hot path, rolls to a `.1` generation past `BRIDGE_METRICS_MAX_BYTES` (50MB), `BRIDGE_METRICS=off` disables. Tests: `metrics.test.js`.
- **Charter quality bars** (prompt-only, `role-charters/role-*.md`): Designer 0-10 rubric + AI-slop blacklist; QA + SW-eng Iron-Law debugging; Security confidence-gate + false-positive exclusions + exploit-scenario-per-finding.
- **Custom AI instructions** (Settings → Instructions, `AI_INSTRUCTIONS`) inject into every agent prompt + all council prompts; empty by default, empty-string clears.

### First-launch gate — the big fix
The gate was **always visible**: `#apikey-gate` set `display:flex`, which (id specificity) overrode the `[hidden]` attribute — so it permanently overlaid the booted app with a **dead Save button** (when a key was set, `ensureApiKey` returns early and never wires Save). One line fixed it: `#apikey-gate[hidden] { display:none !important }`. Along the way (all real, all kept): **⌘V paste** worked once the bare-letter shortcuts (`v`=PTT, `a`=activity, …) were gated on `!meta && !ctrl && !alt`; native form-submit reloads killed (`type="button"`, `action="javascript:void(0)"`, unconditional `preventDefault`); `Cache-Control: no-store` on `/settings`; boot wrapped in try/catch + `loadProjectsWithRetry` + a global `unhandledrejection` net so a post-save hiccup never blanks the screen; **build markers** (`BUILD_ID` in main.js + `<meta name="bridge-build">`) to detect a stale bundle; arrow/d-pad focus nav inside the gate; Electron `session.defaultSession.clearCache()` before load + a `forceReload` menu role (Electron was serving a stale cached renderer — that masked several earlier fixes).

### Other fixes & polish
- **PTT (R2) instantly deactivating on the create-flow capture screens.** Two causes: capture screens opened **3 concurrent `getUserMedia`** (footer-chip wave + capture wave + recorder) and a failing grab ran the recorder's error path → `setPttHeld(false)`; and `gamepad.js` tracked R2 held-state in a **single shared flag** across pad slots. Fixed with one **ref-counted shared mic stream** (`acquireMicStream`/`releaseMicStream` in main.js) and **per-pad-index** `pttDown`.
- **Nav sound everywhere.** `FocusRing.onMove` hook (`focus.js`) → `playSfx('navigate')` covers action bars / create-flow / pickers; added to the movers that bypass the ring (L2 chat bubbles, topology, effort picker, notifications, Settings, file explorer `stepFileFocus`). No double-play (L0/L1 grids use `ring.index` directly).
- **Kickoff questions must offer real options.** `generateQuestions` (`kickoff.js`) now drops lines with <2 options and the prompt insists every question carry ≥2 options — no more bare "Other"-only bubbles.
- **Settings → Models/About/MCP polish.** Council members render as "Council Member 1/2/3" rows under the role models; Instructions textarea styled like app inputs + reachable via Down/d-pad (caret-aware nav); removed the tiering checkbox (tiering is default-on now); MCP tab top spacing matches other panes; About logo + links are white and open in a new window/app (Electron externalizes `mailto:` too); welcome screen + About share the tagline **"A multi-agent command center with multi-modal input"**.

### Tooling note (not a repo issue)
`claude-mem` (a Claude Code plugin) auto-updated to 13.7.0 but its worker daemon was dead, which blocked `Read`/`Bash` hooks. Restart with `node <plugin>/scripts/bun-runner.js <plugin>/scripts/worker-service.cjs start`. Unrelated to Bridge.

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
- `app/server/backends/notes.js` — `writeNote(projectId, name, body)` for human-named docs (a `/` in `name` nests a folder, e.g. `deliverables/deliverables-designer`).
- `app/server/council-store.js` — per-project council transcript persistence (`<stateDir>/council.json`, GET/PUT `/projects/:pid/council`, cleared on project create/delete).
- `app/server/cancel.js` + client `operations.js` — operation tokens; client `releaseActiveRequest()` detaches without canceling so runs survive navigation.
- `app/server/kickoff.js` — `startTeamWork` (fan-out + auto-add), role-based `assignKickoffTasks` returning `{ assignments, clarify }`, kickoff Q&A advances `assignments`.
- `app/server/orchestrator.js` — `RESPONSE_STYLE` grounding, `ROLE_GUIDANCE` + `roleGuidance()`, `interpretIntent({ handoff })`, `awaitKind` on activity events.
- `app/server/events.js` — `emitActivity`/`emitDelegate` take an `extra` arg (carries `awaitKind`).
- Routes: `POST /projects/:pid/kickoff/approve`, `…/kickoff/decline`.

## Tests

`node --test "app/server/*.test.js"` (from the repo root) → currently **207/207 pass**. Hermeticity rule: tests MUST set `BRIDGE_STATE_DIR` + `BRIDGE_PROJECTS_BASE` to throwaway temp dirs before importing server modules — never touch the real `~/bridge-projects/.bridge/` registry or `~/bridge-projects/` repos (a past test wiped real data). All state modules (`projects.js`, `tasks.js`, `scratchpad.js`) resolve paths lazily through `state-dir.js`, so the env vars work as long as they're set before first use.

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
