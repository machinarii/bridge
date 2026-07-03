import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking, speechBus } from './speech.js';
import { renderMarkdown, attachCodeCopyHandlers } from './md.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';
import { GAMEPAD_ICON_SVG } from './gamepad-icons.js';
import { renderHealth, fetchHealth } from './health.js';
import { createOperationToken, cancelOperation } from './operations.js';

// Bump on each renderer change so we can confirm a FRESH bundle is running
// (the browser/Electron can serve a stale cached main.js / index.html).
const BUILD_ID = 'gate-fix-11';
console.log('[bridge] renderer build', BUILD_ID,
  '| index build', document.querySelector('meta[name="bridge-build"]')?.content || '(MISSING — stale index.html)');

// Belt-and-suspenders: the first-launch gate's <form> must NEVER navigate the
// page. A native GET submit (→ "/?") was reloading the app and looking like
// "Save does nothing". Kill it here at module load, unconditionally — even when
// ensureApiKey() returns early (key already set) and never attaches its handler.
document.getElementById('apikey-gate-form')?.addEventListener('submit', (e) => e.preventDefault());

// Safety net: no async path should ever blank the app silently. Surface it.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[bridge] unhandled rejection:', e.reason);
  try { setIndicator('error', 'Unexpected error'); } catch { /* indicator not ready */ }
});

/* Render a gamepad glyph: inline the PlayStation SVG icon when we have one
 * (mono, follows the chip color via currentColor), else fall back to the
 * legacy text symbol so unmapped buttons still show something. */
function paintGamepadGlyph(g, key) {
  const svg = GAMEPAD_ICON_SVG[key];
  if (svg) { g.classList.add('gp-icon'); g.innerHTML = svg; }
  else g.textContent = GAMEPAD_GLYPHS[key] || key;
}

const surfaceEl       = document.getElementById('surface');
// New-project capture flow: Back plays the step-back sound, Clear plays the
// select sound, and Cancel "zooms out" ONLY when it leaves directly — when
// there's progress to lose it pops the "do you really want to cancel?" confirm
// instead (no zoomout here; the dialog owns that moment). Delegated +
// capture-phase so it fires even though each button's own click handler
// re-renders (and removes) the node. IDs are reused across all three steps.
surfaceEl?.addEventListener('click', (e) => {
  const b = e.target.closest?.('#capture-cancel, #capture-back, #capture-redo');
  if (!b) return;
  if (b.id === 'capture-redo') { playSfx('select'); return; }
  if (b.id === 'capture-cancel') return;   // always opens the confirm modal (which plays 'notification')
  playSfx('zoomout');   // Back
}, true);
const indicatorEl     = document.getElementById('listening-indicator');     // removed from DOM
const indicatorTextEl = indicatorEl?.querySelector('.state-text') || null;
const breadcrumbsEl   = document.getElementById('breadcrumbs');             // removed from DOM
const typedWrap       = document.getElementById('ptt-typed');
const typedInput      = document.getElementById('typed-input');
const shortcutsRailEl = document.getElementById('shortcuts-rail');
const primaryShortcutEl = document.getElementById('primary-shortcut');
const backShortcutEl   = document.getElementById('back-shortcut');

/* ---------- UI navigation sound effects ----------
 * Short audio cues for moving around the zoom hierarchy:
 *   navigate → lateral switch between siblings (project↔project on L1,
 *              agent↔agent on L2)
 *   zoomin   → selecting into a level (L0→L1 project, L1→L2 agent)
 *   zoomout  → stepping up a level (L2→L1, L1→L0)
 * Files are served from app/renderer/sounds (see /sounds static path).
 * Preloaded once; play() clones the element so rapid repeats overlap
 * instead of cutting each other off. Playback failures (autoplay policy,
 * missing file) are swallowed — sound is never load-bearing. */
const SFX_FILES = {
  navigate:   'sounds/ui-sound-navigate.m4a',
  navStrip:   'sounds/ui-sound-navigate-strip.m4a',   // moving across the footer shortcut rail
  select:     'sounds/ui-sound-select.m4a',           // selecting a choice / pressing a button
  zoomin:     'sounds/ui-sound-zoomin.m4a',
  zoomout:    'sounds/ui-sound-zoomout.m4a',
  swooshNext: 'sounds/ui-sound-swoosh-next.m4a',   // ] — slide right
  swooshPrev: 'sounds/ui-sound-swoosh-prev.m4a',   // [ — slide left (reversed)
  bump:       'sounds/ui-sound-bump.m4a',          // rubberband at a navigation edge
  notification: 'sounds/ui-sound-notification.m4a',  // a confirmation modal appears
};
// Perceived loudness is logarithmic: linear gain 0.12 ≈ -12dB from the
// original 0.5 ≈ roughly half as loud to the ear. Small linear cuts
// (e.g. ×0.7 = -3dB) are barely audible — adjust in big steps.
const SFX_VOLUME = 0.084;                   // default per-play gain
const SFX_VOLUMES = {                       // per-sound overrides
  navStrip:   0.05,
  select:     0.05,
  swooshNext: 0.02,
  swooshPrev: 0.02,
};
// Web Audio, not <audio>: clips decode ONCE into AudioBuffers at startup and
// each play is a throwaway BufferSource — starts within a frame of the trigger.
// (Cloned <audio> elements re-loaded + re-decoded per play: 300-500ms late.)
let _sfxCtx = null;
const _sfxBuffers = {};
(function initSfx() {
  try { _sfxCtx = new AudioContext(); } catch { return; }
  for (const [name, url] of Object.entries(SFX_FILES)) {
    fetch(url)
      .then(r => r.arrayBuffer())
      .then(b => _sfxCtx.decodeAudioData(b))
      .then(buf => { _sfxBuffers[name] = buf; })
      .catch(() => {});   // sound is never load-bearing
  }
})();
function playSfx(name) {
  const buf = _sfxBuffers[name];
  if (!_sfxCtx || !buf) return;
  try {
    if (_sfxCtx.state === 'suspended') _sfxCtx.resume();
    const src = _sfxCtx.createBufferSource();
    src.buffer = buf;
    const gain = _sfxCtx.createGain();
    gain.gain.value = SFX_VOLUMES[name] ?? SFX_VOLUME;
    src.connect(gain).connect(_sfxCtx.destination);
    src.start();
  } catch { /* sound is best-effort */ }
}

// Any checkbox the user toggles natively (mouse click or the Space default)
// plays the select sound. Programmatic toggles (gamepad cross / Enter, which set
// .checked directly and don't fire 'change') add their own playSfx at the site.
document.addEventListener('change', (e) => {
  if (e.target?.matches?.('input[type="checkbox"]')) playSfx('select');
});

/** Set the persistent shortcuts rail at bottom-right. Pass an array of
 *  { gamepad, keyboard, label, action } — both glyphs render and CSS
 *  hides the inactive one based on body[data-input-mode]. Each chip is
 *  clickable; if `action` is provided, it's invoked on click and when
 *  the chip is focused-and-Entered via keyboard navigation. */
let shortcutItems = [];
let shortcutFocusIdx = -1; // -1 means focus is not in the rail
let _pendingFooterKey = null; // keepFocus chip → re-assert the chip with this scKey after a rebuild

/* Find a rail chip by its stable scKey. Falls back Back→Select: when a Back
 * action lands on a screen that no longer offers Back (e.g. L0), focus the
 * Select chip instead so the cursor doesn't vanish from the rail. */
function footerKeyIndex(key) {
  if (!key) return -1;
  const items = footerFocusables();
  let i = items.findIndex(el => el.dataset.scKey === key);
  if (i < 0 && key === 'Esc') i = items.findIndex(el => el.dataset.scKey === 'Enter');
  return i;
}
/* Re-assert rail focus on the chip identified by _pendingFooterKey (one-shot).
 * Called after a rebuild so a keepFocus chip's action keeps the cursor on it. */
function restorePendingFooterFocus() {
  if (_pendingFooterKey == null) return;
  const i = footerKeyIndex(_pendingFooterKey);
  _pendingFooterKey = null;
  if (i >= 0) {
    shortcutFocusIdx = i;
    paintShortcutFocus();
    // The user acted from the rail and wants to stay there. Entering an agent
    // via Select kicks off an async chat render that would otherwise steal focus
    // to the last bubble (it runs after this) — suppress that so the rail keeps
    // focus. Grid-tile entry doesn't set _pendingFooterKey, so it's unaffected.
    _focusLastOnNextChatRender = false;
  }
}

/* Builds the full footer focus order at the moment the user enters the
 * rail: every clickable chip in #shortcuts-rail, then #primary-shortcut,
 * then every #action-bar .action button. */
function footerFocusables() {
  // Single DOM-order query so nav order is always identical to visual
  // order in the rail. Anything focusable in #footer-rail counts —
  // chips, action buttons, the notification bell, and the settings
  // gear.
  return [...document.querySelectorAll(
    '#footer-rail .sc, #footer-rail .action, #footer-rail #notification-btn, #footer-rail #settings-btn, #footer-rail #fullscreen-btn'
  )].filter(el => el.offsetParent !== null);  // skip chips hidden in the current input mode
}

const GAMEPAD_GLYPHS = { cross: '✕', circle: '○', square: '□', triangle: '△' };

let _footerHoldEl = null;
let _footerHoldKey = null;   // scKey of the held chip (set only when held from rail focus)
/* Start/stop a hold-type footer chip (push-to-talk, reasoning). Mirrors the
 * global V / R key holds: start() on press, end() on release. Idempotent so a
 * key auto-repeat or a second input source can't double-fire. */
function beginChipHold(el) {
  if (_footerHoldEl || !el?._hold) return;
  _footerHoldEl = el;
  // Remember the chip so we can put rail focus back on it after release — only
  // when the hold was started from the rail (Enter / cross). Pointer holds and
  // the global V/R keys leave shortcutFocusIdx at -1 and don't retain.
  _footerHoldKey = shortcutFocusIdx >= 0 ? (el.dataset.scKey || null) : null;
  el.classList.add('holding');
  el._hold.start();
}
function endChipHold(el) {
  if (!_footerHoldEl || (el && el !== _footerHoldEl)) return;
  const h = _footerHoldEl;
  const key = _footerHoldKey;
  _footerHoldEl = null;
  _footerHoldKey = null;
  h.classList.remove('holding');
  // Keep rail focus on the chip after the hold. Arm a one-shot restore for the
  // action's terminal re-render — reasoning's commit rebuilds the rail
  // synchronously inside end(); talk's transcript rebuilds it asynchronously —
  // then re-assert directly for the gap (talk clears focus in startPTT, and some
  // paths don't re-render at all). One-shot (not sticky) so later streaming
  // re-renders don't keep yanking focus back to the rail.
  if (key) _pendingFooterKey = key;
  h._hold.end();
  if (key) {
    _pendingFooterKey = key;
    const i = footerKeyIndex(key);
    if (i >= 0 && shortcutFocusIdx < 0) { shortcutFocusIdx = i; paintShortcutFocus(); }
  }
}

function buildChip(it) {
  const wrap = document.createElement('span');
  wrap.className = 'sc';
  wrap.dataset.scKey = it.keyboard || it.gamepad || it.label || '';   // stable id for focus retention
  if (it.disabledInRail) wrap._disabledInRail = true;
  if (it.keepFocus) wrap._keepFocus = true;
  if (it.hold) {
    // Hold-type chip: press-and-hold semantics (pointer), mirroring the global
    // V / R holds. Pointer capture keeps the hold alive through the layout
    // shifts that starting dictation / the effort picker can cause.
    wrap.style.cursor = 'pointer';
    wrap._hold = it.hold;
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { wrap.setPointerCapture(e.pointerId); } catch {}
      beginChipHold(wrap);
    });
    const release = () => endChipHold(wrap);
    wrap.addEventListener('pointerup', release);
    wrap.addEventListener('pointercancel', release);
    wrap.addEventListener('lostpointercapture', release);
  } else if (it.action) {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => it.action());
  }
  if (it.gamepad) {
    const g = document.createElement('span');
    g.className = 'glyph for-gamepad';
    g.dataset.glyph = it.gamepad;
    paintGamepadGlyph(g, it.gamepad);
    wrap.appendChild(g);
  }
  if (it.keyboard) {
    const k = document.createElement('span');
    k.className = 'glyph for-keyboard';
    k.dataset.glyph = it.gamepad || '';
    k.textContent = it.keyboard;
    wrap.appendChild(k);
  }
  if (it.gamepad === 'r2') {
    // Hold-to-talk chip: while holding, the label is hidden (its width kept so
    // the rail doesn't shift) and a small mic visualizer shows in its place.
    wrap.classList.add('ptt-chip');
    const talk = document.createElement('span'); talk.className = 'sc-talk';
    const l = document.createElement('span'); l.className = 'label'; l.textContent = it.label;
    const mic = document.createElement('span'); mic.className = 'sc-mic'; mic.setAttribute('aria-hidden', 'true');
    mic.innerHTML = Array.from({ length: CHIP_BAR_COUNT }, () => '<span class="bar"></span>').join('');
    talk.append(l, mic);
    wrap.appendChild(talk);
    return wrap;
  }
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = it.label;
  wrap.appendChild(l);
  // Keyboard-only chips (e.g. "/ Type prompt") are irrelevant on a controller —
  // CSS hides them while the input mode is 'gamepad'.
  if (!it.gamepad && it.keyboard) wrap.classList.add('sc-kbd-only');
  return wrap;
}

function setShortcuts(items) {
  shortcutsRailEl.innerHTML = '';
  backShortcutEl.innerHTML = '';
  shortcutItems = items || [];
  shortcutFocusIdx = -1;
  // Any chip bound to Circle / Esc → routed into the back slot inside
  // the action-bar pill so the visible order is Back, Select, Settings.
  let backItem = null;
  for (const it of shortcutItems) {
    if (!backItem && (it.gamepad === 'circle' || it.keyboard === 'Esc')) {
      backItem = it; continue;
    }
    shortcutsRailEl.appendChild(buildChip(it));
  }
  if (backItem) {
    const backChip = buildChip(backItem);
    backChip._keepFocus = true;   // Back retains rail focus across the screen it lands on
    backShortcutEl.appendChild(backChip);
  }
  // Re-assert rail focus after a keepFocus chip's action rebuilt the rail.
  restorePendingFooterFocus();
}

function paintShortcutFocus() {
  const items = footerFocusables();
  items.forEach((el, i) => {
    const on = i === shortcutFocusIdx;
    el.classList.toggle('focused', on);
    // A chip that needs a grid selection (Agent on/off) reads as disabled while
    // it's the focused rail chip — it can't act without an agent selected.
    el.classList.toggle('disabled', on && !!el._disabledInRail);
  });
}
function enterShortcuts() {
  const items = footerFocusables();
  if (items.length === 0) return false;
  if (shortcutFocusIdx < 0) playSfx('navStrip');   // moved into the footer rail
  shortcutFocusIdx = 0;
  paintShortcutFocus();
  return true;
}
function leaveShortcuts() {
  _pendingFooterKey = null;
  shortcutFocusIdx = -1;
  paintShortcutFocus();
}
/* Leave the footer rail going up. On L2 with no surface-ring actions, jump
 * straight to the last chat bubble so a single Up press from the footer lands
 * on the last prompt (symmetric with Down-from-last-bubble dropping into the
 * footer). Otherwise just return focus to the surface ring. */
function leaveFooterUpward() {
  leaveShortcuts();
  if (mode === MODE_ZOOM && ring.elements.length === 0 && chatBubbles.length > 0) {
    focusLastBubble();
    return;
  }
  ring.paint();
}
function moveShortcutFocus(delta) {
  _pendingFooterKey = null;   // a deliberate rail move cancels any pending re-assert
  const items = footerFocusables();
  const n = items.length;
  if (n === 0) return;
  const prev = shortcutFocusIdx;
  shortcutFocusIdx = (shortcutFocusIdx + delta + n) % n;
  if (shortcutFocusIdx !== prev) playSfx('navStrip');   // moved across the footer rail
  paintShortcutFocus();
}
// When a keepFocus chip ([ ] / A / E / Back / Select) is activated from the
// rail, the action often re-renders (rebuilding the rail with shortcutFocusIdx
// reset to -1). activateFocusedShortcut records the chip's scKey in
// _pendingFooterKey so the NEXT setShortcuts re-asserts it by identity — keeping
// the same chip highlighted (with a Back→Select fallback). Cleared by any
// deliberate rail nav.
function activateFocusedShortcut() {
  const items = footerFocusables();
  const el = items[shortcutFocusIdx];
  if (!el) return;
  if (el._disabledInRail) return;   // needs an agent selected; inert from the rail
  _pendingFooterKey = el._keepFocus ? (el.dataset.scKey || null) : null;
  // Synthesize a click — covers chips with click handlers AND action-bar
  // buttons. For chips without handlers (e.g. the "Enter Select" primary)
  // this is a no-op, which is correct — pressing Enter on it is the same
  // as Enter on the focused tile.
  el.click();
}
function isShortcutsFocused() { return shortcutFocusIdx >= 0; }

/** The "Enter Select" chip lives on the right side of the footer rail
 *  (just before the action-bar). Pass null to clear it. */
function setPrimaryShortcut(item) {
  primaryShortcutEl.innerHTML = '';
  if (!item) return;
  const GAMEPAD = { cross: '✕', circle: '○', square: '□', triangle: '△' };
  const wrap = document.createElement('span');
  wrap.className = 'sc';
  wrap.dataset.scKey = item.keyboard || item.gamepad || item.label || '';   // stable id for focus retention
  wrap._disabledInRail = true;   // Select acts on the focused tile/bubble, not from the rail — show disabled + inert
  if (item.action) {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => item.action());
  }
  if (item.gamepad) {
    const g = document.createElement('span');
    g.className = 'glyph for-gamepad';
    g.dataset.glyph = item.gamepad;
    paintGamepadGlyph(g, item.gamepad);
    wrap.appendChild(g);
  }
  if (item.keyboard) {
    const k = document.createElement('span');
    k.className = 'glyph for-keyboard';
    k.dataset.glyph = item.gamepad || '';
    k.textContent = item.keyboard;
    wrap.appendChild(k);
  }
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = item.label;
  wrap.appendChild(l);
  primaryShortcutEl.appendChild(wrap);
}

const ring = new FocusRing();
ring.onMove = () => playSfx('navigate');   // nav sound on every ring cursor move (all screens)
const gp = new GamepadInput();
const speech = new Speech();

/* ---------- Zoom transitions (FLIP-style) ----------
 * Forward navigation captures the source tile's rect; the destination
 * surface animates from "matches source rect" → identity. Back navigation
 * pops the stored rect and animates the current surface to it.
 */
const zoomStack = [];

function pushZoomFromFocused() {
  const el = ring.current();
  if (el) zoomStack.push(el.getBoundingClientRect());
}

function popZoomRect() { return zoomStack.pop() || null; }

function _zoomFrame(target, rect) {
  const t = target.getBoundingClientRect();
  const sx = rect.width / t.width;
  const sy = rect.height / t.height;
  const s  = Math.max(0.05, Math.min(sx, sy, 0.7));
  const tx = (rect.left + rect.width / 2) - (t.left + t.width / 2);
  const ty = (rect.top + rect.height / 2) - (t.top + t.height / 2);
  return `translate(${tx}px, ${ty}px) scale(${s})`;
}

function playZoomIn(target, rect) {
  if (!rect || !target) return;
  target.animate(
    [
      { transform: _zoomFrame(target, rect), opacity: 1 },
      { transform: 'translate(0,0) scale(1)',  opacity: 1 },
    ],
    { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
}

/** Hide all descendants synchronously (via CSS class) so only the
 *  element's own shape/backdrop animates during a zoom. No fade — content
 *  disappears instantly before the transform begins. Also strips the
 *  .focused class from the element + descendants so the white outline
 *  and outer glow don't morph with the resize. */
function hideContent(el) {
  if (!el) return;
  el.classList.add('zoom-shell-only');
  el.classList.remove('focused');
  el.querySelectorAll('.focused').forEach(d => d.classList.remove('focused'));
}

/** Fade in fresh destination content after a zoom completes. */
function fadeInDestination(duration = 160) {
  const el = surfaceEl.firstElementChild;
  if (!el) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration, easing: 'ease-out', fill: 'backwards' });
}

/** Stagger-in the destination tiles (project / agent / role) — each card
 *  slides in from a negative-X offset and fades up. */
function staggerInCards() {
  const items = surfaceEl.querySelectorAll('.project-tile:not(.centered-create), .agent-tile, .role-tile, .topology-card');
  if (items.length === 0) return;
  for (const el of items) {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-28px)';
  }
  void items[0].offsetWidth;
  items.forEach((el, i) => {
    const a = el.animate(
      [
        { opacity: 0, transform: 'translateX(-28px)' },
        { opacity: 1, transform: 'translateX(0)'    },
      ],
      { duration: 320, delay: 45 * i, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }
    );
    a.finished.then(() => {
      el.style.opacity = '';
      el.style.transform = '';
    }).catch(() => {});
  });
}

/** Stagger-in the footer rail (shortcuts + primary + action-bar) after a
 *  forward zoom lands — each chip / button fades and slides in from the
 *  right. */
function staggerInFooter() {
  const items = [
    ...document.querySelectorAll('#shortcuts-rail .sc'),
    ...document.querySelectorAll('#back-shortcut .sc'),
    ...document.querySelectorAll('#primary-shortcut .sc'),
    ...document.querySelectorAll('#action-bar .action'),
  ];
  if (items.length === 0) return;
  // Snap to the start state synchronously, force a reflow so the
  // browser commits it before the animation, then animate each chip in.
  for (const el of items) {
    el.style.opacity = '0';
    el.style.transform = 'translateX(28px)';
  }
  void items[0].offsetWidth; // commit
  items.forEach((el, i) => {
    const a = el.animate(
      [
        { opacity: 0, transform: 'translateX(28px)' },
        { opacity: 1, transform: 'translateX(0)'    },
      ],
      { duration: 300, delay: 70 * i, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }
    );
    a.finished.then(() => {
      el.style.opacity = '';
      el.style.transform = '';
    }).catch(() => {});
  });
}

/* Forward navigation that morphs the SOURCE tile itself into the next
 * surface — like the markdown-cards stack-tile transition. The selected
 * tile clones, siblings dim, the clone flies and grows to fill the
 * surface, then the destination view renders beneath and the clone fades
 * out to reveal it. Reads as one physical motion, not an overlay. */
function forwardMorph(sourceEl, sourceRect, targetRect, renderDest) {
  if (!sourceEl || !sourceRect) { renderDest(); return Promise.resolve(); }

  const clone = sourceEl.cloneNode(true);
  clone.style.position = 'fixed';
  clone.style.left = `${sourceRect.left}px`;
  clone.style.top = `${sourceRect.top}px`;
  clone.style.width = `${sourceRect.width}px`;
  clone.style.height = `${sourceRect.height}px`;
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.zIndex = '50';
  document.body.appendChild(clone);

  // Hide all of the clone's content instantly — only the shell animates.
  hideContent(clone);

  // Track sibling tiles so we can restore their inline opacity after.
  const dimming = Array.from(ring.elements);

  // Position/size grows the full range; opacity holds at 1 for the first
  // 70 % then fades to 0 by the time the clone is fully enlarged — so
  // the destination view shows through without a hard cut.
  const grow = clone.animate(
    [
      { left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
        width: `${sourceRect.width}px`, height: `${sourceRect.height}px` },
      { left: `${targetRect.left}px`, top: `${targetRect.top}px`,
        width: `${targetRect.width}px`, height: `${targetRect.height}px` },
    ],
    { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
  );
  clone.animate(
    [
      { offset: 0,    opacity: 1 },
      { offset: 0.55, opacity: 1 },
      { offset: 1,    opacity: 0 },
    ],
    { duration: 340, easing: 'ease-out', fill: 'forwards' }
  );

  // Pre-render the destination behind the clone partway through the
  // morph so it's already visible (cross-fading with the clone) by the
  // time the clone reaches opacity 0. No empty moment.
  const handoffMs = 170; // ~50% of morph
  let preRendered = false;
  const handoff = setTimeout(() => {
    preRendered = true;
    renderDest();
    fadeInDestination(170);
    staggerInCards();
    staggerInFooter();
  }, handoffMs);

  return grow.finished.catch(() => {}).then(() => {
    clearTimeout(handoff);
    // If the grow finished before our pre-render fired (very fast
    // machine or aborted animation), render now.
    if (!preRendered) {
      renderDest();
      fadeInDestination(140);
      staggerInCards();
      staggerInFooter();
    }
    clone.remove();
    for (const el of dimming) {
      el.style.transition = '';
      el.style.opacity = '';
    }
  });
}

function playZoomOutTo(target, rect) {
  if (!rect || !target) return Promise.resolve();
  const a = target.animate(
    [
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: _zoomFrame(target, rect), opacity: 0 },
    ],
    { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
  );
  return a.finished
    .then(() => { try { a.cancel(); } catch {} })
    .catch(() => {});
}

/* Seamless back nav. The overlay is an EMPTY card sized like the
 * current surface (with surface's bg/border copied as inline style)
 * so no inner text/UI is visible during the shrink. We render the
 * destination view first, then optionally recompute the target rect
 * from the just-rendered destination so the overlay lands on the
 * actual tile (not a stale rect cached at navigate-forward time).
 *
 * `resolveToRect` may be:
 *   - a function returning the target rect (called after renderNewView)
 *   - a DOMRect (used as-is)
 *   - undefined (the animation is skipped). */
function backZoomWithSnapshot(resolveToRect, renderNewView) {
  const sRect = surfaceEl.getBoundingClientRect();
  // Card-only overlay: same size + position as the surface, with the
  // surface's own backdrop. No children — so no text to animate.
  const overlay = document.createElement('div');
  const cs = getComputedStyle(surfaceEl);
  // L2's #surface is transparent (the .agent-view is the visible container), so
  // a snapshot of it would be invisible — the back-zoom would show nothing.
  // Fall back to the ash-black panel look (matching the L1/L2 containers) so
  // the shrink is visible without flashing the old bluish card.
  const bgTransparent = cs.backgroundImage === 'none' &&
    (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent');
  Object.assign(overlay.style, {
    position: 'fixed',
    left: `${sRect.left}px`, top: `${sRect.top}px`,
    width: `${sRect.width}px`, height: `${sRect.height}px`,
    margin: '0', pointerEvents: 'none', zIndex: '50',
    background: bgTransparent ? 'rgba(18, 18, 20, 0.92)' : cs.background,
    border: bgTransparent || cs.borderStyle === 'none' ? '1px solid rgba(255,255,255,0.14)' : cs.border,
    borderRadius: bgTransparent ? 'var(--radius, 14px)' : cs.borderRadius,
    boxShadow: 'none',
  });
  document.body.appendChild(overlay);

  // A brief beat before the destructive re-render so a just-flashed footer
  // chip (e.g. the ○/Esc Back press) actually paints — giving Back the same
  // press feedback as forward navigations. The static overlay covers the
  // unchanged surface during the beat, so nothing else moves.
  return new Promise((resolve) => {
    setTimeout(() => {
      // Render the destination view first so the recompute below can read
      // the actual landing tile's rect.
      renderNewView();
      fadeInDestination(220);

      const toRect = typeof resolveToRect === 'function' ? resolveToRect() : resolveToRect;
      if (!toRect) { overlay.remove(); resolve(); return; }

      const a = overlay.animate(
        [
          { offset: 0,    left: `${sRect.left}px`, top: `${sRect.top}px`,
            width: `${sRect.width}px`, height: `${sRect.height}px`, opacity: 1 },
          { offset: 0.85, left: `${toRect.left}px`, top: `${toRect.top}px`,
            width: `${toRect.width}px`, height: `${toRect.height}px`, opacity: 1 },
          { offset: 1,    left: `${toRect.left}px`, top: `${toRect.top}px`,
            width: `${toRect.width}px`, height: `${toRect.height}px`, opacity: 0 },
        ],
        { duration: 320, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
      );
      a.finished.catch(() => {}).then(() => { overlay.remove(); resolve(); });
    }, 70);
  });
}

/* ---------- Shortcut press feedback ----------
 * When the user presses a key or gamepad button bound to an on-screen
 * chip / action-bar button, briefly pulse that chip so the press
 * registers visually. */
function flashChip(el) {
  if (!el) return;
  el.classList.remove('pressed');
  void el.offsetWidth; // restart animation
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 320);
}
/* True when a text field / textbox holds focus (the type-prompt box, the council
 * "Other" input, settings fields, capture screens, any contenteditable). Used to
 * suppress footer-shortcut flashing + bare-key shortcuts while typing. */
function isTextInputFocused() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable) return true;
  if (a.tagName === 'TEXTAREA') return true;
  if (a.tagName === 'INPUT') {
    const t = (a.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t);
  }
  return false;
}

function flashShortcutByKey(key) {
  const map = { ' ': 'Space', 'Escape': 'Esc', 'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Delete', 'Delete': 'Delete' };
  let label = map[key];
  if (!label) label = key.length === 1 ? key.toUpperCase() : key;
  for (const kbd of document.querySelectorAll('.glyph.for-keyboard')) {
    if (kbd.textContent === label) flashChip(kbd);
  }
}
function flashShortcutByGamepad(button) {
  for (const g of document.querySelectorAll(`.glyph.for-gamepad[data-glyph="${button}"]`)) {
    flashChip(g);
  }
}

/* ---------- Input-mode tracker ---------- */
function setInputMode(m) {
  if (document.body.dataset.inputMode !== m) document.body.dataset.inputMode = m;
}
// Boot in gamepad mode; flip to keyboard as soon as the user touches a key or mouse.
setInputMode('gamepad');
window.addEventListener('keydown', (e) => {
  setInputMode('keyboard');
  // Don't flash footer-shortcut chips for keystrokes typed into a text field.
  if (!e.repeat && !isTextInputFocused()) flashShortcutByKey(e.key);
}, true);
window.addEventListener('mousemove', () => setInputMode('keyboard'), true);

/* ── Two-finger horizontal trackpad swipe ≡ the [ / ] keys ─────────────────
 * A two-finger swipe arrives as a burst of `wheel` events with a dominant
 * horizontal delta. We fire once on the leading edge of a gesture, then wait
 * for the burst to settle before re-arming — so one swipe = one step, exactly
 * like one keypress. The action is whatever [ / ] do on the current screen
 * (prev/next project on L1, prev/next agent on L2): we synthesize the real
 * keydown so it flows through the same handler + guards.
 *   swipe left  → '['   (prev)
 *   swipe right → ']'   (next)
 * If the direction feels inverted on your trackpad, flip the comparison below. */
let _swipeArmed = true;
let _swipeSettleT = null;
window.addEventListener('wheel', (e) => {
  const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
  // Only deliberate, clearly-horizontal gestures — let vertical scroll and
  // tiny diagonal jitter pass through untouched.
  if (ax < 30 || ax <= ay * 1.5) return;
  // Don't hijack a genuinely horizontally-scrollable target (wide code block
  // or table in the chat) — let it scroll instead.
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return;
    }
  }
  if (_swipeSettleT) clearTimeout(_swipeSettleT);
  _swipeSettleT = setTimeout(() => { _swipeArmed = true; }, 180);
  if (!_swipeArmed) return;
  _swipeArmed = false;
  const key = e.deltaX > 0 ? ']' : '[';
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}, { passive: true });

/* ---------- Reasoning-effort quick picker ----------
 * Hold R (keyboard) or the DualSense touchpad, then nudge Up/Down with the
 * arrows / d-pad / either analog stick; release to commit. Effort is scoped:
 * set per-project on L1 and per-agent on L2. When a prompt runs, the agent's
 * own effort wins, else its project's, else medium (the default). The
 * orchestrator maps it to a reasoning budget (non-reasoning models ignore it). */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'extra', 'max'];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', extra: 'Extra', max: 'Max' };
let _effortStore = (() => {
  try { const s = JSON.parse(localStorage.getItem('bridge.effort.v2') || '{}'); return (s && typeof s === 'object') ? s : {}; }
  catch { return {}; }
})();
function _saveEffortStore() { try { localStorage.setItem('bridge.effort.v2', JSON.stringify(_effortStore)); } catch {} }
const _lvl = (l) => (EFFORT_LEVELS.includes(l) ? l : null);
function effortForAgent(pid, aid) { return _lvl(_effortStore.agent?.[aid]) || _lvl(_effortStore.proj?.[pid]) || 'high'; }
function effortForProject(pid)    { return _lvl(_effortStore.proj?.[pid]) || 'high'; }
/* Which scope the picker edits, by screen: L2 → this agent, L1 → this project. */
function effortScope() {
  // Reasoning effort is set per-agent on L2 only — L1 no longer exposes it.
  if (mode === MODE_ZOOM && currentAgent()) return { kind: 'agent', id: currentAgent().id };
  return null;
}
function scopeEffort(scope) {
  if (!scope) return 'high';
  return _lvl((scope.kind === 'agent' ? _effortStore.agent : _effortStore.proj)?.[scope.id]) || 'high';
}
function setScopeEffort(scope, lvl) {
  if (!scope) return;
  const key = scope.kind === 'agent' ? 'agent' : 'proj';
  (_effortStore[key] = _effortStore[key] || {})[scope.id] = lvl;
  _saveEffortStore();
}

let effortPickerOpen = false;
let effortPickerScope = null;
let effortPickerIdx = 1;
let _effortEl = null;
let _rstickLatch = 0;   // one step per analog-stick push while picking

function effortPickerEl() {
  if (_effortEl) return _effortEl;
  const el = document.createElement('div');
  el.id = 'effort-picker';
  el.hidden = true;
  el.innerHTML = `<div class="effort-title"></div><div class="effort-list"></div><div class="effort-hint"></div>`;
  document.body.appendChild(el);
  _effortEl = el;
  return el;
}
function renderEffortPicker() {
  const el = effortPickerEl();
  const scopeTxt = effortPickerScope?.kind === 'agent' ? 'this agent' : 'this project';
  el.querySelector('.effort-title').textContent = `Reasoning effort · ${scopeTxt}`;
  // Max at top → Low at bottom so Up = more effort.
  el.querySelector('.effort-list').innerHTML = EFFORT_LEVELS.slice().reverse().map(lvl => {
    const sel = EFFORT_LEVELS.indexOf(lvl) === effortPickerIdx ? ' selected' : '';
    return `<div class="effort-opt${sel}">${EFFORT_LABELS[lvl]}</div>`;
  }).join('');
  el.querySelector('.effort-hint').textContent = document.body.dataset.inputMode === 'gamepad'
    ? 'Hold touchpad · stick / d-pad Up·Down · release to set'
    : 'Hold R · ↑ ↓ · release to set';
}
/* Light the Reasoning chip's R keycap / touchpad glyph while it's held — the
 * same "held" treatment the Hold-to-talk chip uses. */
function setEffortHeld(on) {
  document.querySelectorAll('.glyph.for-gamepad[data-glyph="touchpad"]').forEach(g => g.classList.toggle('held', on));
  document.querySelectorAll('.glyph.for-keyboard').forEach(g => { if (g.textContent.trim() === 'R') g.classList.toggle('held', on); });
}
function openEffortPicker() {
  if (effortPickerOpen) return;
  const scope = effortScope();
  if (!scope) return;   // only meaningful on L1 / L2
  effortPickerScope = scope;
  effortPickerOpen = true;
  effortPickerIdx = Math.max(0, EFFORT_LEVELS.indexOf(scopeEffort(scope)));
  renderEffortPicker();
  effortPickerEl().hidden = false;
  setEffortHeld(true);
}
function moveEffortPicker(delta) {
  if (!effortPickerOpen) return;
  const prev = effortPickerIdx;
  effortPickerIdx = Math.max(0, Math.min(EFFORT_LEVELS.length - 1, effortPickerIdx + delta));
  if (effortPickerIdx !== prev) playSfx('navigate');
  renderEffortPicker();
}
function closeEffortPicker() { effortPickerOpen = false; effortPickerEl().hidden = true; setEffortHeld(false); }
function commitEffortPicker() {
  if (!effortPickerOpen) return;
  setScopeEffort(effortPickerScope, EFFORT_LEVELS[effortPickerIdx]);
  closeEffortPicker();
  refreshEffortChip();
}
/* Footer chip: shows the current scope's effort; click cycles it one step. */
function cycleScopeEffort() {
  const scope = effortScope();
  if (!scope) return;
  const cur = EFFORT_LEVELS.indexOf(scopeEffort(scope));
  setScopeEffort(scope, EFFORT_LEVELS[(cur + 1) % EFFORT_LEVELS.length]);
  refreshEffortChip();
}
function refreshEffortChip() {
  if (mode === MODE_ZOOM) _setL2Shortcuts();
  else if (mode === MODE_GRID) updateGridShortcuts();
}
function effortChipItem() {
  // Hold to open the reasoning-effort picker (nudge ↑/↓ while held, release to
  // commit) — same as holding the R key / the DualSense touchpad.
  return { gamepad: 'touchpad', keyboard: 'R', label: 'Reasoning', hold: { start: openEffortPicker, end: commitEffortPicker } };
}

/* ---------- App state ---------- */
const MODE_PROJECTS         = 'projects';          // L0
const MODE_NEW_PROJ_ROLES    = 'new_project_roles';    // create-flow step 1
const MODE_NEW_PROJ_TOPOLOGY = 'new_project_topology'; // create-flow step 2
const MODE_NEW_PROJ_NAME     = 'new_project_name';     // create-flow step 3
const MODE_NEW_PROJ_GOAL     = 'new_project_goal';     // create-flow step 4
const MODE_NEW_PROJ_FEATURES = 'new_project_features'; // create-flow step 5
const MODE_GRID             = 'grid';              // L1 (project grid)
const MODE_ZOOM             = 'zoom';              // L2 (agent zoom)
const MODE_ADD_AGENT        = 'add_agent';         // L1 → add-agent role picker
const MODE_COUNCIL          = 'council';           // L1 → Council (ask multiple models)

let mode = MODE_PROJECTS;
let projects = [];                // [{ id, name, agents, ... }]
let pickerIndex = 0;              // focus index on project picker (0..N where N = "+ New")
let activeProject = null;         // project record at L1/L2
let zoomedIndex = 0;
let gridIndex = 0;
let agentBusy = {};
/* v2 — last-known status verb per agent. Updated by the SSE
 * subscriber; rendered into agent-tile .status on L1. */
let agentStatus = {}; // { [agentId]: 'idle'|'drafting'|'analyzing'|'waiting' }
// Agent work verbs. Every non-idle verb is a "busy" state — green dot, rolls up
// to project "Working" (see projectStatus). `waiting` = blocked on a teammate
// (still busy/green, NOT the orange "needs you" state). Server currently emits
// only idle/analyzing/drafting; the rest are renderer-ready and light up once
// the orchestrator calls emitStatus() with them.
const VERB_LABELS = {
  idle: 'Idle',
  analyzing: 'Analyzing',
  drafting: 'Drafting',
  coding: 'Coding',
  scaffolding: 'Scaffolding',
  prototyping: 'Prototyping',
  documenting: 'Documenting',
  reviewing: 'Reviewing',
  testing: 'Testing',
  debugging: 'Debugging',
  researching: 'Researching',
  planning: 'Planning',
  building: 'Building',
  deploying: 'Deploying',
  waiting: 'Waiting',
};
function verbLabel(v) { return VERB_LABELS[v] || 'Idle'; }

/* Per-agent pending state after it produces output, shown (while idle) on the
 * L1 tile:
 *   'reply' → it asked the user something → "Waiting for response" (orange);
 *             clears only when the user actually replies.
 *   'view'  → it finished a task → "Task complete" (green); clears as soon as
 *             the user opens that agent / sees the bubble. */
const agentPending = new Map();   // agentId → 'reply' | 'view'
function setAgentPending(agentId, kind) {
  if (!agentId) return;
  if (kind === 'view') {
    // Don't downgrade a pending question to a task-complete, and don't flag a
    // task-complete for an agent the user is already looking at.
    if (agentPending.get(agentId) === 'reply') return;
    if (mode === MODE_ZOOM && currentAgent()?.id === agentId) kind = null;
  }
  if (kind == null) { clearAgentPending(agentId); return; }
  if (agentPending.get(agentId) !== kind) { agentPending.set(agentId, kind); paintAgentStatus(agentId); }
}
function clearAgentPending(agentId) {
  if (agentId && agentPending.delete(agentId)) paintAgentStatus(agentId);
}
// Clear only the "task complete" (view) state — used when the user opens an agent.
function clearTaskComplete(agentId) {
  if (agentId && agentPending.get(agentId) === 'view' && agentPending.delete(agentId)) paintAgentStatus(agentId);
}
// Back-compat shims. markUnseen = a question awaiting reply; clearUnseen = clear all.
function markUnseen(agentId) { setAgentPending(agentId, 'reply'); }
function clearUnseen(agentId) { clearAgentPending(agentId); }

/* v2 — activity feed buffer. Holds events across ALL projects so
 * both the L0 cross-project feed (§2) and the L1/L2 in-project feed
 * (§3) can read from the same source. Per-project filtering happens
 * at render time. */
const ACTIVITY_LIMIT = 400;
let allActivity = []; // [{ at, projectId, kind: 'activity'|'delegate', text, agentId? }]
let activityDrawerOpen = false;
/* projectActivity stays as a view alias of allActivity for compat
 * with code paths that may reference it. */
function projectActivityForId(pid) {
  return pid ? allActivity.filter(e => e.projectId === pid) : allActivity.slice();
}
let inflightController = null;
let pttActive = false;

// Create-project flow state
let newProjRoleIds  = [];                // toggled during step 1
let newProjTopology = null;   // chosen during step 2 (no default selection)
let newProjName     = '';                // captured during step 3
let newProjGoal     = '';                // captured during step 4
let newProjFeatures = '';                // captured during step 5

// Work topologies offered after role selection. Display copy lives here; the
// operating rule written into project.md lives server-side (projects.js).
const TOPOLOGIES = [
  { id: 'hub-and-spoke', heading: 'Hub-and-spoke', subtitle: 'One coordinator, four specialists', desc: 'A coordinator routes work to specialists and gathers their results.' },
  { id: 'rotating-lead', heading: 'Rotating lead', subtitle: 'Leadership passes each sprint', desc: 'The lead role hands off each sprint so everyone steers in turn.' },
  { id: 'mesh-mob',      heading: 'Mesh / mob', subtitle: 'Everyone on everything', desc: 'The whole team swarms one problem together, no fixed ownership.' },
  { id: 'feature-teams', heading: 'Feature teams', subtitle: 'Parallel pods, end-to-end ownership', desc: 'Independent pods each own a workstream from start to finish.' },
  { id: 'async-pull',    heading: 'Async pull / queue', subtitle: 'Self-assign from a shared backlog', desc: "Members pull the next item from a shared backlog whenever they're free." },
];

/* Small inline diagram for each topology — nodes/links drawn in currentColor
 * (the lead node uses the accent). Kept on a 96x60 canvas for consistent sizing. */
function topoDiagramSVG(id) {
  const open = '<svg class="topo-svg" viewBox="0 0 96 60" aria-hidden="true">';
  const body = {
    'hub-and-spoke': `
      <line class="link" x1="48" y1="30" x2="16" y2="12"/><line class="link" x1="48" y1="30" x2="80" y2="12"/>
      <line class="link" x1="48" y1="30" x2="16" y2="48"/><line class="link" x1="48" y1="30" x2="80" y2="48"/>
      <circle class="node" cx="16" cy="12" r="6"/><circle class="node" cx="80" cy="12" r="6"/>
      <circle class="node" cx="16" cy="48" r="6"/><circle class="node" cx="80" cy="48" r="6"/>
      <circle class="node lead" cx="48" cy="30" r="8"/>`,
    'feature-teams': `
      <line class="link" x1="20" y1="16" x2="41" y2="16"/><line class="link" x1="55" y1="16" x2="76" y2="16"/>
      <line class="link" x1="20" y1="44" x2="41" y2="44"/>
      <circle class="node" cx="13" cy="16" r="6"/><circle class="node" cx="48" cy="16" r="6"/><circle class="node" cx="83" cy="16" r="6"/>
      <circle class="node" cx="13" cy="44" r="6"/><circle class="node" cx="48" cy="44" r="6"/>`,
    'mesh-mob': `
      <line class="link" x1="48" y1="9" x2="15" y2="30"/><line class="link" x1="48" y1="9" x2="81" y2="30"/>
      <line class="link" x1="48" y1="9" x2="48" y2="51"/><line class="link" x1="15" y1="30" x2="81" y2="30"/>
      <line class="link" x1="15" y1="30" x2="48" y2="51"/><line class="link" x1="81" y1="30" x2="48" y2="51"/>
      <circle class="node" cx="48" cy="9" r="6"/><circle class="node" cx="15" cy="30" r="6"/>
      <circle class="node" cx="81" cy="30" r="6"/><circle class="node" cx="48" cy="51" r="6"/>`,
    'rotating-lead': `
      <ellipse class="ring" cx="48" cy="30" rx="30" ry="20"/>
      <circle class="node lead" cx="48" cy="10" r="6.5"/><circle class="node" cx="78" cy="30" r="6"/>
      <circle class="node" cx="48" cy="50" r="6"/><circle class="node" cx="18" cy="30" r="6"/>`,
    'async-pull': `
      <path class="link" d="M38 11 H70"/>
      <path class="link" d="M38 49 C54 49 58 38 70 38"/>
      <rect class="mini" x="12" y="5" width="27" height="12" rx="3"/><rect class="mini" x="12" y="24" width="27" height="12" rx="3"/><rect class="mini" x="12" y="43" width="27" height="12" rx="3"/>
      <circle class="node" cx="74" cy="11" r="6"/><circle class="node" cx="74" cy="38" r="6"/>`,
  }[id] || '';
  return open + body + '</svg>';
}

/* ---------- Explorer height sync ----------
 * The explorer panels are position:fixed cards; their top/bottom track
 * #surface via CSS variables updated whenever the surface measures. */
function syncExplorerHeights() {
  const r = surfaceEl.getBoundingClientRect();
  document.documentElement.style.setProperty('--surface-top', `${r.top}px`);
  document.documentElement.style.setProperty('--surface-bottom', `${window.innerHeight - r.bottom}px`);
}
window.addEventListener('resize', syncExplorerHeights);
window.addEventListener('load', syncExplorerHeights);

/* ---------- Nav state persistence (survives page refresh) ---------- */
const NAV_KEY = 'bridge:nav';
function saveNavState() {
  try {
    sessionStorage.setItem(NAV_KEY, JSON.stringify({
      mode,
      projectId: activeProject?.id || null,
      gridIndex,
      zoomedIndex,
      pickerIndex,
    }));
  } catch {}
}
function readNavState() {
  try { return JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null'); }
  catch { return null; }
}

/* ---------- Bootstrap ---------- */
async function loadProjects() {
  const [pj, rj] = await Promise.all([fetch('/projects'), fetch('/roles')]);
  if (!pj.ok || !rj.ok) throw new Error(`projects ${pj.status} / roles ${rj.status}`);
  // L0 lists projects most-recently-created first.
  projects = ((await pj.json()).projects || [])
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  window._roles = (await rj.json()).roles || [];
  // Restore "Waiting for response" from server truth (an unanswered question) —
  // survives page reloads and any missed SSE events. Leaves 'view' (task
  // complete) states alone; only reconciles 'reply'.
  for (const p of projects) for (const a of (p.agents || [])) {
    if (a.awaitingReply) agentPending.set(a.id, 'reply');
    else if (agentPending.get(a.id) === 'reply') agentPending.delete(a.id);
  }
}

/* ---------- UI helpers ---------- */
function setIndicator(state, text) {
  if (!indicatorEl) return;
  indicatorEl.dataset.state = state;
  if (text && indicatorTextEl) indicatorTextEl.textContent = text;
}

/** Set breadcrumbs in the top-right. Pass an array of {label, color?} where
 *  the last entry is the current page. */
function setBreadcrumbs(parts) {
  if (!breadcrumbsEl) return; // breadcrumb DOM removed
  breadcrumbsEl.innerHTML = '';
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›'; // ›
      breadcrumbsEl.appendChild(sep);
    }
    const c = document.createElement('span');
    c.className = 'crumb' + (i === parts.length - 1 ? ' current' : '');
    if (p.color) {
      const chip = document.createElement('span');
      chip.className = 'agent-chip';
      chip.style.setProperty('--agent-color', p.color);
      c.appendChild(chip);
    }
    c.appendChild(document.createTextNode(p.label));
    breadcrumbsEl.appendChild(c);
  });
}
// Back-compat shim — old callers pass (text, color); we re-derive crumbs.
function setContextLabel(text, color) {
  if (!text || text === 'Bridge' || /^Bridge —/.test(text)) {
    if (text === 'Bridge — projects') setBreadcrumbs([{ label: 'Projects' }]);
    else setBreadcrumbs([]);
    return;
  }
  // Default fallback — single crumb
  setBreadcrumbs([{ label: text, color }]);
}

/* L0 clock — "8:33pm": 12-hour, no leading zero, lowercase, no space. */
function clockText(d = new Date()) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
}
// One ticker for the app's lifetime; writes only while the L0 clock exists
// (renderProjects re-creates it with fresh text on every visit).
setInterval(() => {
  const el = document.querySelector('.project-heading .l0-clock');
  if (el) el.textContent = clockText();
}, 30_000);

function renderProjects() {
  delete document.body.dataset.addAgentOpen;
  mode = MODE_PROJECTS;
  document.body.dataset.mode = mode;
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setBreadcrumbs([{ label: 'Projects' }]);
  surfaceEl.innerHTML = '';
  saveNavState();

  // Heading at top-left of the surface, like the project detail screen —
  // with a live clock on the right (smaller than the title, baseline-aligned).
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `<h2 class="project-title">Projects</h2><span class="l0-clock" aria-hidden="true">${clockText()}</span>`;
  surfaceEl.appendChild(heading);

  // Fixed 4×2 layout — "+ New" is always one of the 8 cells.
  const cols = 4, rows = 2;
  const grid = document.createElement('div');
  grid.className = 'project-picker';
  grid.style.setProperty('--grid-cols', cols);
  grid.style.setProperty('--grid-rows', rows);
  grid._cols = cols;
  grid._rows = rows;

  const tileEls = [];
  for (const p of projects) {
    const tile = document.createElement('div');
    tile.className = 'project-tile';
    tile.dataset.projectId = p.id;
    tile.style.setProperty('--tile-color', getProjectColor(p));
    const ps = projectStatus(p);
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(sentenceCase(p.name))}</h2>
      <div class="meta">${p.agents.length} agent${p.agents.length===1?'':'s'}</div>
      <div class="project-updated" data-status="${ps.kind}"><span class="dot"></span><span class="status-verb">${escapeHtml(ps.label)}</span></div>`;
    const myIdx = tileEls.length;
    // Tap opens; press-and-hold (1.4s) opens the edit modal.
    tile.addEventListener('pointerdown', () => startProjectHold(myIdx));
    tile.addEventListener('pointerup',   () => endProjectHold(true));
    tile.addEventListener('pointerleave', () => cancelProjectHold());
    grid.appendChild(tile);
    tileEls.push(tile);
  }
  // "+ New" tile — mirrors the "+ Add agent" tile on L1.
  const plus = document.createElement('div');
  plus.className = 'project-tile new-project';
  plus.innerHTML = `
    <div class="add-symbol">+</div>
    <div class="add-label">New project</div>`;
  const plusIdx = tileEls.length;
  plus.addEventListener('click', () => { pickerIndex = plusIdx; ring.index = plusIdx; ring.paint(); openFocused(); });
  grid.appendChild(plus);
  tileEls.push(plus);

  surfaceEl.appendChild(grid);
  // 9+ tiles overflow into a 3rd row that scrolls: rows shave slightly so a
  // sliver of row 3 peeks above the fold, and the bottom fade hints at the
  // rest, lifting once the user reaches the end.
  grid.classList.toggle('overflowing', tileEls.length > cols * rows);
  const updateFade = () => {
    grid.classList.toggle('fade-bottom', grid.scrollHeight - grid.clientHeight - grid.scrollTop > 4);
    grid.classList.toggle('fade-top', grid.scrollTop > 4);
  };
  grid.addEventListener('scroll', updateFade, { passive: true });
  requestAnimationFrame(updateFade);
  ring.set(tileEls);
  ring.index = clamp(pickerIndex, 0, tileEls.length - 1);
  ring.paint();
  // A cursor restored onto an overflow row (9+ projects) starts fully in view.
  scrollPickerToRow(grid, ring.index);

  renderActionBar([]); // no separate "Open" verb — covered by Select chip
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => openFocused() });
  updatePickerShortcuts();
}

/* ---------- Project edit (long-press a project tile) ----------
 * Press & hold a project (mouse / Enter / Cross) for 1.4s to open an edit
 * modal: Rename, Remove (itself a 3s press-and-hold to confirm), Cancel. */
const PROJECT_LONGPRESS_MS = 1400;
const PROJECT_REMOVE_HOLD_MS = 3000;

const projectEditModalEl  = document.getElementById('project-edit-modal');
const projectEditNameEl   = document.getElementById('project-edit-name');
const projectEditRenameEl = document.getElementById('project-edit-rename');
const projectEditRemoveEl = document.getElementById('project-edit-remove');
const projectEditCancelEl = document.getElementById('project-edit-cancel');
let projectEditOpen = false;
let projectEditTarget = null;       // { id, name, idx }
let projectEditFocusEls = [];
let projectEditFocusIdx = 0;
let _projHold = null;               // open-modal long-press: { idx, fired, timer }
let _removeHold = null;             // remove confirm hold: { timer }

// Light the Select chip (Enter cap / Cross icon) while a project is held — the
// same held treatment the "Hold to talk" V cap uses during push-to-talk.
function setSelectHeld(on) {
  document.querySelectorAll('#primary-shortcut .glyph').forEach(g => g.classList.toggle('held', on));
}

function startProjectHold(idx) {
  if (mode !== MODE_PROJECTS || projectEditOpen) return;
  const p = projects[idx];
  if (!p) return; // "+ New" tile — no long-press
  cancelProjectHold();
  _projHold = { idx, fired: false };
  _projHold.timer = setTimeout(() => { _projHold.fired = true; openProjectEditModal(p, idx); }, PROJECT_LONGPRESS_MS);
  setSelectHeld(true);
}
function endProjectHold(openIfShort) {
  if (!_projHold) return false;
  const { fired, idx } = _projHold;
  clearTimeout(_projHold.timer);
  _projHold = null;
  setSelectHeld(false);
  if (!fired && openIfShort) { pickerIndex = idx; ring.index = idx; ring.paint(); openFocused(); }
  return fired;
}
function cancelProjectHold() { if (_projHold) { clearTimeout(_projHold.timer); _projHold = null; } setSelectHeld(false); }

function openProjectEditModal(project, idx) {
  cancelProjectHold();
  projectEditTarget = { id: project.id, name: project.name, idx };
  projectEditNameEl.value = project.name;
  projectEditOpen = true;
  projectEditModalEl.hidden = false;
  setRemoveLabel('Delete project');
  projectEditFocusEls = [projectEditNameEl, projectEditCancelEl, projectEditRemoveEl, projectEditRenameEl];
  projectEditFocusIdx = 0;
  paintProjectEditFocus();
  setTimeout(() => { projectEditNameEl.focus(); projectEditNameEl.select(); }, 0);
}
function closeProjectEditModal() {
  resetRemoveHold();
  projectEditOpen = false;
  projectEditModalEl.hidden = true;
  projectEditTarget = null;
}
function paintProjectEditFocus() {
  projectEditFocusEls.forEach((el, i) => el.classList.toggle('focused', i === projectEditFocusIdx));
}
function moveProjectEditFocus(d) {
  projectEditFocusIdx = (projectEditFocusIdx + d + projectEditFocusEls.length) % projectEditFocusEls.length;
  paintProjectEditFocus();
  projectEditFocusEls[projectEditFocusIdx]?.focus();
  if (!_removeHold) setRemoveLabel(removeLabelForState()); // hint when highlighted, default otherwise
}

async function renameProjectFromModal() {
  const t = projectEditTarget; if (!t) return;
  const name = projectEditNameEl.value.trim();
  if (!name || name === t.name) { closeProjectEditModal(); return; }
  try {
    const r = await fetch(`/projects/${encodeURIComponent(t.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    const p = projects.find(x => x.id === t.id); if (p) p.name = updated.name;
  } catch (err) { console.error('[rename] failed', err); }
  closeProjectEditModal();
  renderProjects();
}

function setRemoveLabel(text) {
  // Update both the base (light) label and the dark clipped copy that shows
  // only over the red fill.
  projectEditRemoveEl?.querySelectorAll('.remove-label, .remove-label-clip').forEach(el => { el.textContent = text; });
}
// Default label, or the hold hint when the button is highlighted/focused.
function removeLabelForState() {
  return document.activeElement === projectEditRemoveEl ? 'Hold for 3 sec to delete' : 'Delete project';
}
function startRemoveHold() {
  if (!projectEditTarget || _removeHold) return;
  projectEditRemoveEl.classList.add('holding');
  let secs = Math.round(PROJECT_REMOVE_HOLD_MS / 1000);
  setRemoveLabel(String(secs));                 // counts down 3 → 2 → 1
  const interval = setInterval(() => { secs -= 1; if (secs > 0) setRemoveLabel(String(secs)); }, 1000);
  const timer = setTimeout(() => removeProjectFromModal(), PROJECT_REMOVE_HOLD_MS);
  _removeHold = { timer, interval };
}
function resetRemoveHold() {
  if (_removeHold) { clearTimeout(_removeHold.timer); clearInterval(_removeHold.interval); _removeHold = null; }
  projectEditRemoveEl?.classList.remove('holding');
  setRemoveLabel(removeLabelForState());
}
async function removeProjectFromModal() {
  const t = projectEditTarget; if (!t) return;
  resetRemoveHold();
  try {
    const r = await fetch(`/projects/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    projects = projects.filter(x => x.id !== t.id);
  } catch (err) { console.error('[remove] failed', err); }
  closeProjectEditModal();
  pickerIndex = Math.max(0, Math.min(pickerIndex, projects.length));
  renderProjects();
}

// Modal controls — pointer.
document.getElementById('project-edit-close')?.addEventListener('click', () => closeProjectEditModal());
projectEditCancelEl?.addEventListener('click', () => closeProjectEditModal());
projectEditRenameEl?.addEventListener('click', () => renameProjectFromModal());
projectEditRemoveEl?.addEventListener('pointerdown', (e) => { e.preventDefault(); startRemoveHold(); });
projectEditRemoveEl?.addEventListener('pointerup', () => resetRemoveHold());
projectEditRemoveEl?.addEventListener('pointerleave', () => resetRemoveHold());
projectEditRemoveEl?.addEventListener('pointercancel', () => resetRemoveHold());
// Highlighted/focused → show the hold hint; blur → restore default (and cancel any hold).
projectEditRemoveEl?.addEventListener('focus', () => { if (!_removeHold) setRemoveLabel('Hold for 3 sec to delete'); });
projectEditRemoveEl?.addEventListener('blur', () => resetRemoveHold());
projectEditModalEl?.addEventListener('pointerdown', (e) => { if (e.target === projectEditModalEl) closeProjectEditModal(); });
// Modal keyboard.
projectEditModalEl?.addEventListener('keydown', (e) => {
  if (!projectEditOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeProjectEditModal(); return; }
  // Arrow / Tab navigation across the controls. Left/Right edit text when the
  // name field is focused; Up/Down (and Tab) always move between controls.
  const onInput = document.activeElement === projectEditNameEl;
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && !onInput)) {
    e.preventDefault(); e.stopPropagation(); moveProjectEditFocus(+1); return;
  }
  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.key === 'ArrowLeft' && !onInput)) {
    e.preventDefault(); e.stopPropagation(); moveProjectEditFocus(-1); return;
  }
  // !e.repeat so the still-held Enter that *opened* the modal (auto-repeating)
  // doesn't immediately fire Rename and close it.
  if (e.key === 'Enter' && !e.repeat && document.activeElement === projectEditNameEl) { e.preventDefault(); e.stopPropagation(); renameProjectFromModal(); }
});
// Hold Enter/Space on the focused Remove button (keyboard) to confirm delete.
projectEditRemoveEl?.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); startRemoveHold(); }
});
projectEditRemoveEl?.addEventListener('keyup', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetRemoveHold(); }
});

// Gamepad takeover while the modal is open.
function handleProjectEditGamepad(b) {
  if (b === 'up' || b === 'left')   { moveProjectEditFocus(-1); return; }
  if (b === 'down' || b === 'right'){ moveProjectEditFocus(+1); return; }
  if (b === 'circle') { closeProjectEditModal(); return; }
  if (b === 'cross') {
    const el = projectEditFocusEls[projectEditFocusIdx];
    if (el === projectEditRemoveEl) { startRemoveHold(); return; } // hold Cross; release cancels
    if (el === projectEditRenameEl) { renameProjectFromModal(); return; }
    if (el === projectEditCancelEl) { closeProjectEditModal(); return; }
  }
}
// Cross release: cancel a remove-hold in the modal, or finish a tile long-press at L0.
gp.addEventListener('release', (e) => {
  if (e.detail.button === 'cross' && _footerHoldEl) { endChipHold(_footerHoldEl); return; }  // release a held footer chip
  if (e.detail.button === 'touchpad') { commitEffortPicker(); return; }
  if (editBubbleOpen && e.detail.button === 'cross' && editDictating) { endEditDictate(); return; }  // release stops dictation
  if (e.detail.button === 'cross' && _otherDictateBtn) { endOtherDictate(); return; }  // release stops "Other" dictation
  if (e.detail.button !== 'cross') return;
  if (projectEditOpen) { resetRemoveHold(); return; }
  if (mode === MODE_PROJECTS) endProjectHold(true);
});
// Releasing Enter at L0 (no modal) finishes a tile long-press.
window.addEventListener('keyup', (e) => {
  if (e.key === 'Enter' && _footerHoldEl) { endChipHold(_footerHoldEl); return; }  // release a held footer chip
  if (e.key === 'Enter' && mode === MODE_PROJECTS && !projectEditOpen) endProjectHold(true);
  if (e.key === 'r' || e.key === 'R') commitEffortPicker();  // release R → set reasoning effort
});

/** On L0, the shortcuts rail reflects the focused project's lead so
 *  the user can talk to that project's PM from the home screen.
 *  Hidden when "+ New" is focused. */
function updatePickerShortcuts() {
  if (mode !== MODE_PROJECTS) return;
  // Hold V / R2 to talk still works on L0; we just don't surface it as a footer
  // chip here.
  setShortcuts([
    {                gamepad: 'triangle', keyboard: 'A', label: 'Activity', keepFocus: true,
      action: () => toggleActivityDrawer() },
  ]);
}

/** L0 push-to-talk: just start PTT — speech.end will dispatch the
 *  transcript either as a "create new project" command or as a
 *  prompt for the highlighted project's lead. */
function talkToFocusedLead() {
  startPTT();
}

/** Match common phrasings for "create new project" / "new project" /
 *  "make a project". Returns true if the transcript reads as a
 *  create-project command. */
function isCreateProjectCommand(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  // Strip very common filler at the head.
  const stripped = t.replace(/^(please|hey|ok(?:ay)?,?|let'?s|i (?:want to|wanna)|can you|could you)\s+/, '');
  return /\b(new|create|make|start|begin|add)\b.*\bproject\b/.test(stripped)
      || /\bproject\b.*\b(new|create)\b/.test(stripped);
}

/** Route a transcript spoken from L0. The user is addressing
 *  "Cassidy" — a single home-level assistant, not the PM of any
 *  particular project. For now Cassidy understands one command:
 *  "create new project". Other utterances surface a polite hint;
 *  a real Cassidy backend can plug in here later. */
function dispatchHomeUtterance(text) {
  if (!text) return;
  if (isCreateProjectCommand(text)) {
    newProjRoleIds = [];
    newProjTopology = null;
    newProjName = '';
    newProjGoal = '';
    newProjFeatures = '';
    renderNewProjectRoles();
    return;
  }
  // Acknowledge so the user knows the utterance was heard, even though
  // a free-form Cassidy response isn't wired yet.
  setIndicator('idle', 'Cassidy heard you. Try: "create new project"');
  setTimeout(() => setIndicator('idle', 'Connected'), 2400);
}

/* ---------- Top-right close (×) button on L1 / L2 ---------- */
function createSurfaceCloseButton(onClose) {
  const btn = document.createElement('button');
  btn.className = 'surface-close';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Close');
  // SVG X — stroke-width: 2.5, ~30% larger than the previous text glyph.
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
      <line x1="5" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="19" y1="5" x2="5" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;
  btn.addEventListener('click', onClose);
  btn.addEventListener('keydown', (e) => {
    // Must stopPropagation — otherwise window's bubble handler runs the
    // mode-specific Enter action (openFocused/enterZoom) immediately
    // after onClose, which re-opens the project the user just exited.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      // On L2, Down re-enters the chat at the most-recent (last) bubble so the
      // highlight is on-screen; elsewhere it just hands focus back to the ring.
      e.preventDefault(); e.stopPropagation();
      btn.blur();
      if (mode === MODE_ZOOM && chatBubbles.length) focusLastBubble();
      else ring.paint();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      // Up/Left/Right have no natural neighbor (X sits at the top-right
      // corner), so release the × focus back to the surface ring.
      e.preventDefault(); e.stopPropagation();
      btn.blur();
      ring.paint();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      onClose();
    }
  });
  return btn;
}

function focusSurfaceClose() {
  const btn = surfaceEl.querySelector('.surface-close');
  if (btn) {
    if (document.activeElement !== btn) playSfx('navigate');   // cursor moved to the × close
    btn.focus();
    ring.items.forEach(el => el.classList.remove('focused'));
    return true;
  }
  return false;
}

/* ---------- Per-project color palette ----------
 * Each project gets a deterministic color from a fixed palette so the
 * surface, project tile, and all of the project's agents share one hue.
 * Removes the per-role color scheme inside a project. */
const PROJECT_PALETTE = [
  '#6ea8ff', '#ff7b86', '#c08bff', '#9cf2c1',
  '#ffd35a', '#ffb86b', '#5fdcd6', '#ff8ec7',
  '#a5b4fc', '#fb923c', '#34d399', '#f472b6',
];
function getProjectColor(project) {
  if (!project?.id) return PROJECT_PALETTE[0];
  let h = 0;
  for (let i = 0; i < project.id.length; i++) h = (h * 31 + project.id.charCodeAt(i)) >>> 0;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}

/** Move the lead agent to index 0 so it always renders top-left on L1;
 *  the rest of the roles are sorted alphabetically by role label. */
function withLeadFirst(project) {
  if (!project?.leadAgentId) return project;
  const lead = project.agents.find(a => a.id === project.leadAgentId);
  if (!lead) return project;
  const others = project.agents
    .filter(a => a.id !== project.leadAgentId)
    .sort((a, b) => roleLabel(a.role).localeCompare(roleLabel(b.role)));
  return { ...project, agents: [lead, ...others] };
}

/** The morph target should be the surface's *content* area (inside its
 *  padding), not its outer rect — otherwise the clone lands larger than
 *  the destination's visible content area and the new view looks like
 *  it "shrunk down" after the morph finished. */
function surfaceContentRect() {
  const r = surfaceEl.getBoundingClientRect();
  const cs = getComputedStyle(surfaceEl);
  const pl = parseFloat(cs.paddingLeft)   || 0;
  const pr = parseFloat(cs.paddingRight)  || 0;
  const pt = parseFloat(cs.paddingTop)    || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  return {
    left: r.left + pl,
    top:  r.top  + pt,
    right:  r.right  - pr,
    bottom: r.bottom - pb,
    width:  r.width  - pl - pr,
    height: r.height - pt - pb,
  };
}

/* The morph target must be measured with the DESTINATION mode's surface
 * styling — zoom strips the surface padding entirely and L0 is frameless — or
 * the clone grows toward a rect inset by the SOURCE mode's padding and the
 * real view pops to a different size when it renders mid-morph (visible as
 * the container enlarging with a gap on one side). Flip the body's mode
 * attribute just long enough to measure; nothing paints in between. */
function surfaceContentRectFor(destMode) {
  const prev = document.body.dataset.mode;
  document.body.dataset.mode = destMode;
  const rect = surfaceContentRect();
  if (prev === undefined) delete document.body.dataset.mode;
  else document.body.dataset.mode = prev;
  return rect;
}

async function openFocused() {
  const idx = ring.index;
  const sourceTile = ring.current();
  const sourceRect = sourceTile?.getBoundingClientRect();
  // Destination: the L1 grid / create flow, whose visible container is the
  // surface PANEL itself (L0 is frameless, so the panel appears on arrival).
  // The morph must land on the panel's outer rect — targeting the padded
  // content rect leaves the clone smaller and offset from the panel it
  // becomes.
  const r = surfaceEl.getBoundingClientRect();
  const targetRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  playSfx('zoomin');   // L0 → L1 (project tile selected; also "+ New")
  if (idx === tileCount() - 1) {
    // "+ New" — enter create flow with the same morph as a project tile.
    newProjRoleIds = [];
    newProjTopology = null;
    newProjName = '';
    newProjGoal = '';
    newProjFeatures = '';
    zoomStack.push(sourceRect);
    await forwardMorph(sourceTile, sourceRect, targetRect, () => renderNewProjectRoles());
    return;
  }
  zoomStack.push(sourceRect);
  activeProject = withLeadFirst(projects[idx]);
  gridIndex = 0;
  zoomedIndex = 0;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderGrid());
}

function tileCount() { return projects.length + 1; }

/** Compact "Updated X ago" string for a project tile timestamp. */
function formatProjectUpdated(at) {
  if (!at) return '';
  const diff = Date.now() - Number(at);
  if (diff < 0 || !Number.isFinite(diff)) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Updated just now';
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Updated ${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Updated yesterday';
  if (d < 7) return `Updated ${d} days ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `Updated ${w} wk ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `Updated ${mo} mo ago`;
  const y = Math.floor(d / 365);
  return `Updated ${y} yr ago`;
}

/* ── Layer 0 project status ───────────────────────────────────────────────
 * Projects use a DIFFERENT status vocabulary than agents (see design.md §15.2
 * and §15.2.1). A project tile rolls its agents' live state up into one label:
 *   'attention' → "Needs attention"    — an agent is idle but awaiting the
 *                 user's reply (agentPending === 'reply')
 *   'working'   → "Working"            — an agent is actively busy (a non-idle
 *                 verb: analyzing / drafting / waiting)
 *   'updated'   → "Updated X ago"      — neither; the last-activity timestamp
 * Attention outranks Working — it's the actionable one. */
function projectStatus(p) {
  let attention = false, working = false;
  for (const a of (p.agents || [])) {
    if (a.enabled === false) continue;
    const verb = agentStatus[a.id] || (agentBusy[a.id] ? 'drafting' : 'idle');
    if (verb !== 'idle') { working = true; continue; }
    if (agentPending.get(a.id) === 'reply') attention = true;
  }
  if (attention) return { kind: 'attention', label: 'Needs attention' };
  if (working)   return { kind: 'working',   label: 'Working' };
  return { kind: 'updated', label: formatProjectUpdated(p.updatedAt || p.createdAt) };
}

/* Repaint L0 project tiles' status line in place (cheap — ≤8 tiles). No-op
 * off Layer 0, so it's safe to call from any live-event handler. */
function paintProjectStatuses() {
  if (mode !== MODE_PROJECTS) return;
  for (const tile of surfaceEl.querySelectorAll('.project-tile[data-project-id]')) {
    const p = projects.find(x => x.id === tile.dataset.projectId);
    const el = tile.querySelector('.project-updated');
    if (!p || !el) continue;
    const ps = projectStatus(p);
    el.dataset.status = ps.kind;
    const verbEl = el.querySelector('.status-verb');
    if (verbEl) verbEl.textContent = ps.label;
    else el.textContent = ps.label;
  }
}

async function renderNewProjectRoles() {
  mode = MODE_NEW_PROJ_ROLES;
  // PM is the locked-in lead — pre-select and prevent removal.
  if (!newProjRoleIds.includes('pm')) newProjRoleIds = ['pm', ...newProjRoleIds];
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Roles' }]);
  surfaceEl.innerHTML = '';

  // Page heading — matches the add-agent screen's heading shape so
  // both role-picker variants read consistently.
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `
    <h2 class="project-title">New project</h2>
    <p class="project-goal">Pick one or more roles for your team.</p>`;
  surfaceEl.appendChild(heading);

  // Always fetch fresh — the catalog can change between sessions
  // (e.g. roles renamed / added on the server) and we don't want a
  // long-lived cache to hide that.
  try {
    const r = await fetch('/roles');
    const data = await r.json();
    window._roles = data.roles || [];
  } catch { window._roles = window._roles || []; }
  // PM stays at the top-left; everything else is alphabetized by label.
  const roles = [...window._roles].sort((a, b) => {
    if (a.id === 'pm') return -1;
    if (b.id === 'pm') return 1;
    return a.label.localeCompare(b.label);
  });

  const wrap = document.createElement('section');
  wrap.className = 'role-picker';
  const grid = document.createElement('div');
  grid.className = 'role-grid';

  // Names already taken by agents on existing projects — the preview name
  // should be one that isn't in use, matching what the server will assign.
  const usedNames = new Set();
  for (const p of projects) for (const a of (p.agents || [])) if (a?.name) usedNames.add(a.name);

  const tileEls = [];
  for (const role of roles) {
    const sample = role.namePool.find(n => !usedNames.has(n)) || role.namePool[0];
    const t = document.createElement('div');
    t.className = 'role-tile';
    t.dataset.roleId = role.id;
    if (role.id === 'pm') t.dataset.locked = 'true';
    t.style.setProperty('--tile-color', role.color);
    const locked = role.id === 'pm';
    t.innerHTML = `
      <div class="role-label">${role.label}</div>
      <div class="role-sample">${sample}</div>
      <div class="role-toggle" data-checked="${newProjRoleIds.includes(role.id)}" ${locked ? 'data-locked="true"' : ''}></div>`;
    t.addEventListener('click', () => { ring.moveTo(el => el === t); toggleFocusedRole(); });
    grid.appendChild(t);
    tileEls.push(t);
  }
  wrap.appendChild(grid);

  // Close × at top-right and Cancel both abort to L0, but confirm first
  // if the user has selected any role beyond the default PM.
  const tryCancelRolePicker = () => {
    playSfx('select');   // Cancel is a press like any other — audible feedback
    const hasSelections = newProjRoleIds.some(r => r !== 'pm');
    maybeConfirmCancel(hasSelections, () => renderProjects());
  };
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelRolePicker));

  // Invisible row inside the picker — Cancel · Continue, all
  // right-aligned within the surface. No Back here: the first step
  // has no previous step in the create flow (home == cancel).
  const row = document.createElement('div');
  row.className = 'role-confirm-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'role-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', tryCancelRolePicker);
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'role-confirm';
  confirmBtn.textContent = 'Continue';
  confirmBtn.addEventListener('click', () => advanceFromRolePicker());
  row.append(cancelBtn, confirmBtn);
  wrap.appendChild(row);

  surfaceEl.appendChild(wrap);

  ring.set([...tileEls, cancelBtn, confirmBtn]);
  ring.index = 0;
  ring.paint();

  renderActionBar([]); // Back shown once via setShortcuts' Esc chip below
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => renderProjects() },
  ]);
  // Select = toggle the focused role's checkbox (Enter / ✕). Space is no longer
  // a toggle. Advance via the on-screen Continue button (or △ on a gamepad).
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => toggleFocusedRole() });
  // Tiles render after the async /roles fetch, so stagger them in here (the
  // morph's own stagger ran before they existed).
  staggerInCards();
  staggerInFooter();
}

function toggleFocusedRole() {
  const cur = ring.current();
  if (!cur) return;
  const id = cur.dataset.roleId;
  if (!id) return;
  if (id === 'pm') return; // PM is the locked-in lead; no toggle, no message
  const idx = newProjRoleIds.indexOf(id);
  if (idx >= 0) newProjRoleIds.splice(idx, 1);
  else newProjRoleIds.push(id);
  const toggle = cur.querySelector('.role-toggle');
  if (toggle) toggle.dataset.checked = String(newProjRoleIds.includes(id));
}

/* ArrowDown handler used by both the new-project role picker and the
 * add-agent picker. Returns true if it absorbed the keypress
 * (focusing a non-tile button or the footer rail), false if the
 * caller should fall through to plain grid-down navigation. */
function advanceDownFromRolePicker() {
  const items = ring.elements;
  if (items.length === 0) return false;
  const cur = items[ring.index];
  const isTile = !!cur?.classList?.contains('role-tile');
  const firstNonTileIdx = items.findIndex(el => !el.classList?.contains('role-tile'));

  if (!isTile) {
    // Already on Cancel/Back/Continue/Create — drop into the footer.
    if (enterShortcuts()) return true;
    return false;
  }
  // On a role tile. If a tile sits directly below the focused one,
  // let roleGridMove walk to it; otherwise land on the first non-tile
  // ring item (typically Cancel).
  const grid = surfaceEl.querySelector('.role-grid');
  const cols = grid?._cols || 4;
  const r = Math.floor(ring.index / cols);
  const c = ring.index % cols;
  const tileCount = (firstNonTileIdx === -1) ? items.length : firstNonTileIdx;
  const tileLastRow = Math.max(0, Math.ceil(tileCount / cols) - 1);
  const targetTileIdx = (r + 1) * cols + c;
  if (r < tileLastRow && targetTileIdx < tileCount) {
    return false; // there's another tile row below — fall through
  }
  if (firstNonTileIdx >= 0) {
    // Land on the bottom button nearest the focused tile's side: tiles on the
    // left half drop to Cancel (left), tiles on the right half to Continue
    // (right). See docs UI behavior — "Vertical drop to side-aligned buttons".
    const cancelIdx  = items.findIndex(el => el.classList?.contains('role-cancel'));
    const confirmIdx = items.findIndex(el => el.classList?.contains('role-confirm'));
    const wantLeft = c < cols / 2;
    let targetIdx = wantLeft ? cancelIdx : confirmIdx;
    if (targetIdx < 0) targetIdx = (confirmIdx >= 0 ? confirmIdx : firstNonTileIdx);
    if (targetIdx !== ring.index) ring.onMove?.();   // tile → button is a cursor move
    ring.index = targetIdx;
    ring.paint();
    return true;
  }
  // No buttons in the ring — fall back to entering the footer.
  if (enterShortcuts()) return true;
  return false;
}

/* Role-picker traversal. The ring is [role tiles…, Cancel, Continue]; the tiles
 * are a cols-wide grid and the two buttons are a separate bottom row (Cancel
 * left, Continue right). Left/Right flow in reading order through the tiles;
 * off the last tile, Right lands on Continue (bottom-right). Up from the first
 * row hops to the × close; Down off the bottom of a column drops to the nearer
 * bottom button (left half → Cancel, right half → Continue). */
function roleGridMove(dir) {
  const n = ring.elements.length;
  if (n === 0) return;
  const grid = surfaceEl.querySelector('.role-grid');
  const cols = grid?._cols || 4;
  const tileCount = ring.elements.filter(el => el.classList?.contains('role-tile')).length || n;
  const cancelIdx  = ring.elements.findIndex(el => el.classList?.contains('role-cancel'));
  const confirmIdx = ring.elements.findIndex(el => el.classList?.contains('role-confirm'));
  const i = ring.index;
  const onTile = i < tileCount;
  const c = i % cols;
  const lastRowStart = Math.floor((tileCount - 1) / cols) * cols;
  // Play the nav sound on a real cursor move — roleGridMove sets ring.index
  // directly (not ring.move), so it must fire onMove itself.
  const go = (x) => { if (x !== ring.index) ring.onMove?.(); ring.index = x; ring.paint(); };

  if (dir === 'right') {
    if (onTile) {
      if (i + 1 < tileCount) return go(i + 1);                 // next tile (flows to next row)
      return confirmIdx >= 0 ? go(confirmIdx) : bumpEdge(grid, 'right'); // last tile → Continue
    }
    if (i === cancelIdx && confirmIdx >= 0) return go(confirmIdx);       // Cancel → Continue
    return;                                                             // on Continue → inert (no rubberband)
  }
  if (dir === 'left') {
    if (onTile) return i > 0 ? go(i - 1) : bumpEdge(grid, 'left');
    if (i === confirmIdx && cancelIdx >= 0) return go(cancelIdx);        // Continue → Cancel
    if (i === cancelIdx) return go(tileCount - 1);                       // Cancel → last tile
    return;                                                             // inert (no rubberband)
  }
  if (dir === 'up') {
    if (onTile) {
      if (i - cols >= 0) return go(i - cols);
      if (focusSurfaceClose()) return;                          // first row → × close
      return bumpEdge(grid, 'up');
    }
    // On a bottom button → up into the last tile row (nearest side).
    if (i === cancelIdx) return go(lastRowStart);
    return go(Math.min(tileCount - 1, lastRowStart + cols - 1));
  }
  if (dir === 'down') {
    if (onTile) {
      const below = i + cols;
      if (below < tileCount) return go(below);
      // No tile below → drop to the nearer bottom button.
      const target = (c < cols / 2) ? cancelIdx : confirmIdx;
      if (target >= 0) return go(target);
      if (enterShortcuts()) return;
      return bumpEdge(grid, 'down');
    }
    if (enterShortcuts()) return;                               // button row → footer
    return bumpEdge(grid, 'down');
  }
}

function advanceFromRolePicker() {
  if (newProjRoleIds.length === 0) {
    setIndicator('error', 'Pick at least one role');
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
    return;
  }
  playSfx('zoomin');   // Continue → advance a step
  renderNewProjectTopology();
}

/* Step 2 — choose a work topology (how the team operates). Single-select:
 * picking a card sets it and advances to the name step. */
function renderNewProjectTopology() {
  mode = MODE_NEW_PROJ_TOPOLOGY;
  document.body.dataset.mode = mode;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Topology' }]);
  surfaceEl.innerHTML = '';

  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `
    <h2 class="project-title">New project</h2>
    <p class="project-goal">Choose how your team works.</p>`;
  surfaceEl.appendChild(heading);

  const wrap = document.createElement('section');
  wrap.className = 'topology-picker';
  const list = document.createElement('div');
  list.className = 'topology-list';

  const cardEls = [];
  for (const topo of TOPOLOGIES) {
    const card = document.createElement('div');
    card.className = 'topology-card';
    card.dataset.topoId = topo.id;
    card.dataset.selected = String(newProjTopology === topo.id);
    card.innerHTML = `
      <span class="topo-heading">${escapeHtml(topo.heading)}</span>
      <span class="topo-subtitle">${escapeHtml(topo.subtitle)}</span>
      ${topoDiagramSVG(topo.id)}
      <span class="topo-desc">${escapeHtml(topo.desc)}</span>`;
    card.addEventListener('click', () => { ring.moveTo(el => el === card); chooseTopology(topo.id); });
    list.appendChild(card);
    cardEls.push(card);
  }
  wrap.appendChild(list);

  surfaceEl.appendChild(createSurfaceCloseButton(() => maybeConfirmCancel(true, () => renderProjects())));

  const row = document.createElement('div');
  row.className = 'role-confirm-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'role-cancel'; cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => maybeConfirmCancel(true, () => renderProjects()));
  const backBtn = document.createElement('button');
  backBtn.type = 'button'; backBtn.className = 'role-cancel'; backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => goBackInCreateFlow());
  row.append(cancelBtn, backBtn);
  wrap.appendChild(row);

  surfaceEl.appendChild(wrap);

  ring.set([...cardEls, cancelBtn, backBtn]);
  ring.index = Math.max(0, TOPOLOGIES.findIndex(t => t.id === newProjTopology));
  ring.paint();

  renderActionBar([]); // Back lives in setShortcuts (Esc) below — avoid duplicate chip
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => { const c = ring.current(); if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId); else c?.click?.(); } });
  staggerInCards();
  staggerInFooter();
}

function selectTopology(id) {
  newProjTopology = id;
  document.querySelectorAll('.topology-card').forEach(c => { c.dataset.selected = String(c.dataset.topoId === id); });
}
function chooseTopology(id) { playSfx('zoomin'); selectTopology(id); renderNewProjectName(); }

/* Topology nav: the row of cards occupies ring indices 0..N-1, the Back
 * button is the last index. Left/right move between cards; down jumps to
 * Back; up returns from Back into the cards. */
function topoMoveCard(dir) {
  const n = TOPOLOGIES.length;
  const L = ring.elements.length;
  const prev = ring.index;
  if (ring.index >= n) {
    // On the footer row (Cancel · Back): move between the footer buttons,
    // clamped to the row so Left/Right doesn't jump back into the cards.
    ring.index = Math.min(L - 1, Math.max(n, ring.index + dir));
  } else {
    ring.index = (ring.index + dir + n) % n;   // cycle among topology cards
  }
  if (ring.index !== prev) playSfx('navigate');
  ring.paint();
}
function topoFocusBack() { if (ring.index !== TOPOLOGIES.length) playSfx('navigate'); ring.index = TOPOLOGIES.length; ring.paint(); }
function topoFocusCards() { if (ring.index >= TOPOLOGIES.length) { playSfx('navigate'); ring.index = 0; ring.paint(); } }

function goBackInCreateFlow() {
  playSfx('zoomout');   // Esc / Back / circle → step back (or leave the flow)
  if (mode === MODE_NEW_PROJ_FEATURES) { stopMicVisualizer(); renderNewProjectGoal(); }
  else if (mode === MODE_NEW_PROJ_GOAL) renderNewProjectName();
  else if (mode === MODE_NEW_PROJ_NAME) { stopMicVisualizer(); renderNewProjectTopology(); }
  else if (mode === MODE_NEW_PROJ_TOPOLOGY) renderNewProjectRoles();
  else { stopMicVisualizer(); renderProjects(); }
}

const NAME_LIMIT = 30;
async function confirmCapture() {
  if (mode === MODE_NEW_PROJ_NAME) {
    const raw = newProjName.trim();
    if (!raw) { setIndicator('error', 'Speak or type a name'); return; }
    if (raw.length > NAME_LIMIT) {
      // Over the 40-char limit — ask the server to rewrite the name
      // (LLM-backed; falls back to truncate on failure).
      setIndicator('thinking', 'Shortening name…');
      try {
        const r = await fetch('/projects/shorten-name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: raw }),
        });
        if (r.ok) {
          const data = await r.json();
          if (data?.name) newProjName = data.name;
          else newProjName = raw.slice(0, NAME_LIMIT).trim();
        } else {
          newProjName = raw.slice(0, NAME_LIMIT).trim();
        }
      } catch {
        newProjName = raw.slice(0, NAME_LIMIT).trim();
      }
      setIndicator('idle', 'Connected');
    } else {
      newProjName = raw;
    }
    newProjName = titleCaseName(newProjName);   // normalize (covers the shorten/truncate paths)
    playSfx('zoomin');   // Continue → advance a step
    renderNewProjectGoal();
  } else if (mode === MODE_NEW_PROJ_GOAL) {
    if (!newProjGoal.trim()) { setIndicator('error', 'Speak or type a goal'); return; }
    playSfx('zoomin');
    renderNewProjectFeatures();
  } else if (mode === MODE_NEW_PROJ_FEATURES) {
    if (!newProjFeatures.trim()) { setIndicator('error', 'Speak or type the top features'); return; }
    playSfx('zoomin');
    finalizeNewProject();
  }
}
/* ---------- Capture-screen mic visualizer ----------
 * Reactive bars + "Speak now" label. Uses AudioContext + getUserMedia
 * to read live mic input (runs alongside SpeechRecognition without
 * conflict in modern browsers). */
let micViz = null;
let micVizFrame = null;
const MIC_BAR_COUNT = 7;

/* Mic visualizer markup. Bars are static here; heights are updated by
 * animateMicBars() each rAF tick. The .mic-live-text slot above the bars is
 * filled by the partial-transcript handler while the user is dictating. */
function micStackHtml() {
  const bars = Array.from({ length: MIC_BAR_COUNT }, () => '<div class="bar"></div>').join('');
  return `
    <div class="mic-stack">
      <div class="mic-live-text" aria-live="polite"></div>
      <div class="mic-bars">${bars}</div>
      <div class="mic-label">
        <span class="for-keyboard">Hold <kbd>V</kbd> to talk</span>
        <span class="for-gamepad">Hold <kbd>R2</kbd> to talk</span>
      </div>
    </div>`;
}
/* Inner markup of a capture FIELD (just the entered text — the mic prompt is a
 * sibling below the box). Name (default) is a single value; the objective /
 * features fields pass {blocks:true}: each dictation / typed entry is a separate
 * block (joined by a blank line in state). */
function captureValueInner(text, { blocks = false } = {}) {
  if (!text) return '';
  if (!blocks) return escapeHtml(text);
  const html = String(text).split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
    .map(b => `<div class="capture-block">${escapeHtml(b)}</div>`).join('');
  return `<div class="capture-blocks">${html}</div>`;
}
/* Append a dictated / typed entry as a new block (blank-line separated), or set
 * it as the first block. Used by the objective / features fields. */
function appendCaptureBlock(existing, text) {
  const t = String(text || '').trim();
  if (!t) return existing;
  return existing ? `${existing}\n\n${t}` : t;
}

/* ── Shared mic stream ────────────────────────────────────────────────────
 * One getUserMedia per hold, ref-counted across every consumer (footer-chip
 * wave, capture-screen wave, and the recorder). Capture screens run all three;
 * opening getUserMedia 2-3× concurrently could fail on the 2nd/3rd grab, whose
 * error path calls setPttHeld(false) — that was PTT "activating then immediately
 * deactivating" on the create-flow capture screens (chat runs fewer, so it
 * survived). A cached promise makes concurrent acquirers share one stream. */
let _micStream = null;
let _micStreamPromise = null;
let _micStreamUsers = 0;
async function acquireMicStream() {
  _micStreamUsers++;
  if (!_micStreamPromise) _micStreamPromise = navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    _micStream = await _micStreamPromise;
    return _micStream;
  } catch (err) {
    _micStreamUsers = Math.max(0, _micStreamUsers - 1);
    _micStreamPromise = null;
    throw err;
  }
}
function releaseMicStream() {
  _micStreamUsers = Math.max(0, _micStreamUsers - 1);
  if (_micStreamUsers === 0) {
    if (_micStream) { try { _micStream.getTracks().forEach(t => t.stop()); } catch {} }
    _micStream = null;
    _micStreamPromise = null;
  }
}

async function startMicVisualizer() {
  // No-op if we already have a running visualizer.
  if (micViz) { animateMicBars(); return; }
  let stream;
  try {
    stream = await acquireMicStream();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('AudioContext unavailable');
    const ac = new Ctx();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    micViz = { ac, analyser, stream, data: new Uint8Array(analyser.frequencyBinCount) };
    animateMicBars();
  } catch (err) {
    console.warn('[mic-viz] failed:', err.message);
    if (stream) releaseMicStream();   // acquired but setup failed — balance the ref
  }
}

function stopMicVisualizer() {
  if (micVizFrame) { cancelAnimationFrame(micVizFrame); micVizFrame = null; }
  if (micViz) {
    try { micViz.ac.close(); } catch {}
    micViz = null;
    releaseMicStream();   // shared stream — release, don't stop tracks directly
  }
}

/* Travelling sine wave across the bars. The wave is always moving;
 * loudness from the mic just scales its amplitude. Silence still
 * shows a gentle baseline ripple so the UI reads as "alive." */
let _micLoudness = 0;     // smoothed 0..1
function animateMicBars() {
  if (!micViz) return;
  const bars = document.querySelectorAll('.capture-tile .mic-bars .bar');
  if (bars.length === 0) {
    micVizFrame = requestAnimationFrame(animateMicBars);
    return;
  }
  const { analyser, data } = micViz;
  analyser.getByteFrequencyData(data);

  // Average loudness across the speech band, smoothed so the
  // amplitude doesn't jitter frame-to-frame.
  const usable = Math.min(data.length, 16);
  let sum = 0;
  for (let i = 0; i < usable; i++) sum += data[i];
  const raw = sum / (usable * 255); // 0..1
  _micLoudness = _micLoudness * 0.78 + raw * 0.22;

  const t = performance.now() / 1000;
  const SPEED = 2.5;                                 // radians / sec — gentle
  const BASE_AMP = 1.5;                              // baseline ripple (px) — subtle
  const LOUD_AMP = 34;                               // extra amplitude when loud (px)
  const MID = 22;                                    // bar centerline (px)
  const PHASE_STEP = (Math.PI * 2) / bars.length;    // wave traverses the row
  const amp = BASE_AMP + LOUD_AMP * _micLoudness;

  bars.forEach((bar, i) => {
    const sine = Math.sin(t * SPEED + i * PHASE_STEP); // -1..1
    const h = Math.max(4, MID + sine * amp);
    bar.style.height = `${h}px`;
  });
  micVizFrame = requestAnimationFrame(animateMicBars);
}

function renderNewProjectName() {
  const entering = mode !== MODE_NEW_PROJ_NAME;  // animate only on screen transitions, not internal re-renders
  mode = MODE_NEW_PROJ_NAME;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Name' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile capture-name' + (entering ? ' capture-enter' : '');
  t.innerHTML = `
    <h2>Name this project</h2>
    <div class="capture-value ${newProjName ? 'has-value' : ''}">${captureValueInner(newProjName)}</div>
    <div class="capture-mic">${micStackHtml()}</div>
    ${newProjName.trim().length > NAME_LIMIT
      ? `<div class="capture-toolong">Long name — we'll automatically shorten it to ${NAME_LIMIT} characters.</div>`
      : ''}
    ${newProjRoleIds.includes('pm')
      ? ''
      : '<div class="lead-badge">Cassidy will lead this team.</div>'}
    <div class="role-confirm-row">
      <button type="button" class="role-cancel" id="capture-cancel">Cancel</button>
      <button type="button" class="role-cancel role-back" id="capture-back">Back</button>
      <button type="button" class="role-cancel role-redo" id="capture-redo" title="Clear the name and say it again" aria-label="Clear name">Clear</button>
      <button type="button" class="role-confirm" id="capture-done">Continue</button>
    </div>`;
  surfaceEl.appendChild(t);
  const tryCancelNameCapture = () => {
    maybeConfirmCancel(true, () => { stopMicVisualizer(); renderProjects(); });
  };
  const nameBackEl   = t.querySelector('#capture-back');
  const nameCancelEl = t.querySelector('#capture-cancel');
  const nameRedoEl   = t.querySelector('#capture-redo');
  const nameDoneEl   = t.querySelector('#capture-done');
  // Primary stays disabled until something has been captured.
  if (nameDoneEl) nameDoneEl.disabled = !newProjName.trim();
  nameBackEl?.addEventListener('click', () => {
    stopMicVisualizer();
    renderNewProjectTopology();
  });
  // Redo clears the captured name and re-renders the screen, which
  // resets the field, disables Continue, and auto-restarts voice capture.
  nameRedoEl?.addEventListener('click', () => {
    stopMicVisualizer();
    newProjName = '';
    renderNewProjectName();
  });
  nameCancelEl?.addEventListener('click', tryCancelNameCapture);
  nameDoneEl?.addEventListener('click', () => confirmCapture());
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelNameCapture));
  // Push-to-talk: the user holds V / R2 to dictate the name, then releases to
  // transcribe (Parakeet). The mic-stack shows "Hold V / R2 to talk" by default
  // and swaps to the live wave only while holding (driven by setPttHeld).
  renderActionBar([]); // Back shown once via setShortcuts' Esc chip below
  setShortcuts([
    // Keyboard-only "/" type-prompt, mirroring L2: opens the typed input; Enter
    // there routes through submitTypedText → sets newProjName → goal step.
    { keyboard: '/', label: 'Type prompt', action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  // Action-row buttons join the focus ring so arrow / d-pad nav works.
  const nameRing = [nameCancelEl, nameBackEl, nameRedoEl, nameDoneEl].filter(Boolean);
  ring.set(nameRing);
  // Continue focused by default — the primary action. Derive its index
  // from the final ring array so it stays correct as the row changes.
  ring.index = Math.max(0, nameRing.indexOf(nameDoneEl));
  ring.paint();
}

function renderNewProjectGoal() {
  const entering = mode !== MODE_NEW_PROJ_GOAL;  // animate only on screen transitions, not internal re-renders
  mode = MODE_NEW_PROJ_GOAL;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Goal' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile capture-tall' + (entering ? ' capture-enter' : '');
  t.innerHTML = `
    <h2>What's the objective?</h2>
    <div class="capture-value ${newProjGoal ? 'has-value' : ''}">${captureValueInner(newProjGoal, { blocks: true })}</div>
    <div class="capture-mic">${micStackHtml()}</div>
    <div class="role-confirm-row">
      <button type="button" class="role-cancel" id="capture-cancel">Cancel</button>
      <button type="button" class="role-cancel role-back" id="capture-back">Back</button>
      <button type="button" class="role-cancel role-redo" id="capture-redo" title="Clear the objective and say it again" aria-label="Clear objective">Clear</button>
      <button type="button" class="role-confirm" id="capture-done">Continue</button>
    </div>`;
  surfaceEl.appendChild(t);
  const tryCancelGoalCapture = () => {
    maybeConfirmCancel(true, () => { stopMicVisualizer(); renderProjects(); });
  };
  const goalBackEl   = t.querySelector('#capture-back');
  const goalCancelEl = t.querySelector('#capture-cancel');
  const goalRedoEl   = t.querySelector('#capture-redo');
  const goalDoneEl   = t.querySelector('#capture-done');
  if (goalDoneEl) goalDoneEl.disabled = !newProjGoal.trim();
  goalBackEl?.addEventListener('click', () => {
    stopMicVisualizer();
    renderNewProjectName();
  });
  // Clear the captured objective and re-render so the user can say it again.
  goalRedoEl?.addEventListener('click', () => {
    stopMicVisualizer();
    newProjGoal = '';
    renderNewProjectGoal();
  });
  goalCancelEl?.addEventListener('click', tryCancelGoalCapture);
  goalDoneEl?.addEventListener('click', () => confirmCapture());
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelGoalCapture));
  // Push-to-talk: hold V / R2 to dictate the goal, release to transcribe.
  // The mic-stack swaps the hold hint for the live wave only while holding.
  renderActionBar([]); // Back shown once via setShortcuts' Esc chip below
  setShortcuts([
    // Keyboard-only "/" type-prompt, mirroring L2: opens the typed input; Enter
    // there routes through submitTypedText → sets newProjGoal → stays for review.
    { keyboard: '/', label: 'Type prompt', action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  const goalRing = [goalCancelEl, goalBackEl, goalRedoEl, goalDoneEl].filter(Boolean);
  ring.set(goalRing);
  // Continue focused by default — the primary action.
  ring.index = Math.max(0, goalRing.indexOf(goalDoneEl));
  ring.paint();
}

function renderNewProjectFeatures() {
  const entering = mode !== MODE_NEW_PROJ_FEATURES;  // animate only on screen transitions, not internal re-renders
  mode = MODE_NEW_PROJ_FEATURES;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Features' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile capture-tall' + (entering ? ' capture-enter' : '');
  t.innerHTML = `
    <h2>What are the top features?</h2>
    <div class="capture-value ${newProjFeatures ? 'has-value' : ''}">${captureValueInner(newProjFeatures, { blocks: true })}</div>
    <div class="capture-mic">${micStackHtml()}</div>
    <div class="role-confirm-row">
      <button type="button" class="role-cancel" id="capture-cancel">Cancel</button>
      <button type="button" class="role-cancel role-back" id="capture-back">Back</button>
      <button type="button" class="role-cancel role-redo" id="capture-redo" title="Clear the features and say them again" aria-label="Clear features">Clear</button>
      <button type="button" class="role-confirm" id="capture-done">Create project</button>
    </div>`;
  surfaceEl.appendChild(t);
  const tryCancelFeaturesCapture = () => {
    maybeConfirmCancel(true, () => { stopMicVisualizer(); renderProjects(); });
  };
  const featBackEl   = t.querySelector('#capture-back');
  const featCancelEl = t.querySelector('#capture-cancel');
  const featRedoEl   = t.querySelector('#capture-redo');
  const featDoneEl   = t.querySelector('#capture-done');
  if (featDoneEl) featDoneEl.disabled = !newProjFeatures.trim();
  featBackEl?.addEventListener('click', () => {
    stopMicVisualizer();
    renderNewProjectGoal();
  });
  // Clear the captured features and re-render so the user can say them again.
  featRedoEl?.addEventListener('click', () => {
    stopMicVisualizer();
    newProjFeatures = '';
    renderNewProjectFeatures();
  });
  featCancelEl?.addEventListener('click', tryCancelFeaturesCapture);
  featDoneEl?.addEventListener('click', () => confirmCapture());
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelFeaturesCapture));
  // Push-to-talk: hold V / R2 to dictate the features, release to transcribe.
  renderActionBar([]); // Back shown once via setShortcuts' Esc chip below
  setShortcuts([
    // Keyboard-only "/" type-prompt, mirroring L2: opens the typed input; Enter
    // there routes through submitTypedText → sets newProjFeatures → stays for review.
    { keyboard: '/', label: 'Type prompt', action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  const featRing = [featCancelEl, featBackEl, featRedoEl, featDoneEl].filter(Boolean);
  ring.set(featRing);
  // Create project focused by default — the primary action.
  ring.index = Math.max(0, featRing.indexOf(featDoneEl));
  ring.paint();
}

function gridLayout(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 8) return { cols: 4, rows: 2 };
  if (n <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

function roleLabel(roleId) {
  return (window._roles || []).find(r => r.id === roleId)?.label || roleId;
}

function renderGrid() {
  delete document.body.dataset.addAgentOpen;   // left the add/remove screen
  if (!activeProject) return renderProjects();
  mode = MODE_GRID;
  document.body.dataset.mode = mode;
  document.documentElement.style.setProperty('--agent-color', getProjectColor(activeProject));
  setBreadcrumbs([{ label: 'Projects' }, { label: activeProject.name }]);
  surfaceEl.innerHTML = '';
  saveNavState();

  // Project heading inside the container — top-left, above the grid.
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `
    <h2 class="project-title">${escapeHtml(sentenceCase(activeProject.name))}</h2>
    <p class="project-goal">${escapeHtml(sentenceCase(activeProject.goal || ''))}</p>`;
  surfaceEl.appendChild(heading);

  // Close × button — top-right of the surface, exits to L0.
  surfaceEl.appendChild(createSurfaceCloseButton(() => exitToProjects()));

  // 4 columns; rows grow to fit (up to 3) and every row divides the height
  // equally via --grid-rows (set below, once the tile count is known).
  const cols = 4, MAX_ROWS = 3;
  const grid = document.createElement('div');
  grid.className = 'agent-grid';
  grid.style.setProperty('--grid-cols', cols);
  grid._cols = cols;

  const projectColor = getProjectColor(activeProject);
  const tileEls = activeProject.agents.map((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    if (!a.enabled) tile.dataset.disabled = 'true';
    if (a.id === activeProject.leadAgentId) tile.dataset.lead = 'true';
    tile.style.setProperty('--tile-color', projectColor);
    tile.dataset.agentId = a.id;
    const verb = agentStatus[a.id] || (agentBusy[a.id] ? 'drafting' : 'idle');
    const pending = verb === 'idle' ? agentPending.get(a.id) : null;
    const statusLabel = pending === 'reply' ? 'Waiting for response'
                      : pending === 'view'  ? 'Task complete' : verbLabel(verb);
    tile.dataset.busy = (verb !== 'idle') ? 'true' : 'false';
    tile.dataset.status = verb;
    tile.dataset.unseen = pending === 'reply' ? 'true' : 'false';
    tile.dataset.complete = pending === 'view' ? 'true' : 'false';
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(a.name)}</h2>
      <div class="role">${escapeHtml(roleLabel(a.role))}</div>
      <div class="status"><span class="dot"></span><span class="status-verb">${statusLabel}</span></div>`;
    tile.addEventListener('click', () => { gridIndex = i; ring.set(tileEls); ring.index = i; ring.paint(); enterZoom(); });
    grid.appendChild(tile);
    return tile;
  });

  // "Council" tile — sits with the team like an agent; selecting it opens the
  // cross-model council (no shortcut key — it's a tile you pick like any agent).
  {
    const councilIdx = tileEls.length;
    const councilTile = document.createElement('div');
    councilTile.className = 'agent-tile';
    councilTile.dataset.council = 'true';
    councilTile.style.setProperty('--tile-color', projectColor);
    councilTile.innerHTML = `
      <h2 class="name">Council</h2>
      <div class="role">Advisory Team</div>
      <div class="status"><span class="dot"></span><span class="status-verb">Idle</span></div>`;
    councilTile.addEventListener('click', () => { gridIndex = councilIdx; ring.set(tileEls); ring.index = councilIdx; ring.paint(); enterZoom(); });
    grid.appendChild(councilTile);
    tileEls.push(councilTile);
  }

  // "+ Add agent" tile — last cell when room remains (cap at cols*MAX_ROWS).
  if (tileEls.length < cols * MAX_ROWS) {
    const addIdx = tileEls.length;
    const addTile = document.createElement('div');
    addTile.className = 'agent-tile add-agent';
    addTile.dataset.addAgent = 'true';
    addTile.innerHTML = `
      <div class="add-symbol">+</div>
      <div class="add-label">Add / remove agent</div>`;
    addTile.addEventListener('click', () => {
      gridIndex = addIdx;
      ring.set(tileEls.concat(addTile));
      ring.index = addIdx;
      ring.paint();
      enterZoom();   // zoom-morph into the picker (same as keyboard/gamepad)
    });
    grid.appendChild(addTile);
    tileEls.push(addTile);
  }

  // Rows = however many it takes to fit all tiles (min 2); 1fr each → equal
  // heights across all rows, including a third row.
  const rows = Math.max(2, Math.ceil(tileEls.length / cols));
  grid.style.setProperty('--grid-rows', rows);
  grid._rows = rows;
  // Past MAX_ROWS (>12 tiles) the 1fr rows would crush the tiles — switch to a
  // fixed tile height and let the grid scroll instead.
  grid.classList.toggle('scroll', rows > MAX_ROWS);

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(gridIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([]);   // Back is a footer chip (see updateGridShortcuts), matching L2
  updateGridShortcuts();
}

/* ---------- Add-agent role picker (full-screen, multi-select) ----------
 * Reuses the .role-grid / .role-tile / .role-toggle visual treatment
 * from the create-project flow. PM is excluded since the project
 * already has one. Selected roles are POSTed sequentially to
 * /projects/:pid/agents on Done. */
let addAgentSelected = new Set(); // desired final roster (role ids) in the picker
let addAgentBaseline = new Set(); // the roster when the picker opened (diff anchor)
let addAgentReturnProject = null; // project to return to (L1) when leaving the picker

async function ensureRolesLoaded() {
  if (window._roles?.length) return;   // cached — render synchronously
  try {
    const r = await fetch('/roles');
    if (r.ok) window._roles = (await r.json()).roles || [];
  } catch { window._roles = window._roles || []; }
}

async function openAddAgentPicker() {
  if (!activeProject) return;
  // Set the mode SYNCHRONOUSLY, before any await — otherwise during the
  // /roles fetch `mode` stays MODE_GRID, and a Back/Esc in that window hits the
  // grid's circle→exitToProjects (which goes to L0 *and* nulls activeProject).
  mode = MODE_ADD_AGENT;
  document.body.dataset.mode = mode;
  // Robust return-to-L1: flag the screen + capture the project, so Back/Esc can
  // always get back to this project's grid regardless of any mode/activeProject
  // glitch (see the capture-phase Escape interceptor + gamepad guard).
  document.body.dataset.addAgentOpen = '1';
  addAgentReturnProject = activeProject;
  // Use cached roles when available so the picker renders synchronously and the
  // zoom morph hands off cleanly into it (the enterZoom add-agent branch
  // prefetches before the morph). Falls back to a fetch on a cold cache.
  await ensureRolesLoaded();
  // Keep the project's color wash so the screen reads as "still inside this
  // project."
  document.documentElement.style.setProperty('--agent-color', getProjectColor(activeProject));
  const leadRole = activeProject.agents.find(a => a.id === activeProject.leadAgentId)?.role;
  const currentRoles = new Set(activeProject.agents.map(a => a.role));
  // addAgentSelected = the desired final roster. Start from the current one:
  // untick a role to remove its agent, tick a new role to add one. The lead
  // (PM) is locked and can't be removed. addAgentBaseline is the diff anchor.
  addAgentSelected = new Set(currentRoles);
  addAgentBaseline = new Set(currentRoles);
  setBreadcrumbs([
    { label: 'Projects' },
    { label: activeProject.name },
    { label: 'Add / remove agents' },
  ]);
  surfaceEl.innerHTML = '';

  // Heading + close X (consistent with L1 / L2).
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `
    <h2 class="project-title">Add / remove agents</h2>
    <p class="project-goal">Tick a role to add it, untick to remove it. The lead can't be removed.</p>`;
  surfaceEl.appendChild(heading);
  // Close × — confirms only if the roster's been changed.
  surfaceEl.appendChild(createSurfaceCloseButton(() => {
    maybeConfirmCancel(addAgentChanged(), () => leaveAddAgentToGrid());
  }));

  // Roles already on the project first (alphabetized), then the rest. Focus
  // lands on the first togglable tile (the first non-lead role).
  const allRoles = window._roles || [];
  const onProject = allRoles.filter(r => currentRoles.has(r.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  const off = allRoles.filter(r => !currentRoles.has(r.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  const roles = [...onProject, ...off];
  // The lead (PM) is locked and is the team's anchor — always pin it top-left.
  const leadIdx = roles.findIndex(r => r.id === leadRole);
  if (leadIdx > 0) { const [lead] = roles.splice(leadIdx, 1); roles.unshift(lead); }

  const wrap = document.createElement('section');
  wrap.className = 'role-picker';
  const grid = document.createElement('div');
  grid.className = 'role-grid';

  const tileEls = [];
  let firstOpenTile = null;
  for (const role of roles) {
    const sample = role.namePool?.[0] || '';
    const isLocked = role.id === leadRole;            // only the lead can't be removed
    const checked  = addAgentSelected.has(role.id);
    const t = document.createElement('div');
    t.className = 'role-tile';
    t.dataset.roleId = role.id;
    if (isLocked) t.dataset.locked = 'true';
    t.style.setProperty('--tile-color', role.color);
    t.innerHTML = `
      <div class="role-label">${escapeHtml(role.label)}</div>
      <div class="role-sample">${escapeHtml(sample)}</div>
      <div class="role-toggle" data-checked="${checked ? 'true' : 'false'}" ${isLocked ? 'data-locked="true"' : ''}></div>`;
    t.addEventListener('click', () => { ring.moveTo(el => el === t); toggleFocusedAddAgentRole(); });
    grid.appendChild(t);
    tileEls.push(t);
    if (!firstOpenTile && !isLocked) firstOpenTile = t;
  }
  wrap.appendChild(grid);

  // Invisible row inside the picker — Cancel on the left of Continue.
  const tryCancelAddAgent = () => {
    maybeConfirmCancel(addAgentChanged(), () => leaveAddAgentToGrid());
  };
  const row = document.createElement('div');
  row.className = 'role-confirm-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'role-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', tryCancelAddAgent);
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'role-confirm';
  confirmBtn.textContent = 'Continue';
  confirmBtn.addEventListener('click', () => commitAddAgentSelections());
  row.append(cancelBtn, confirmBtn);
  wrap.appendChild(row);

  surfaceEl.appendChild(wrap);

  ring.set([...tileEls, cancelBtn, confirmBtn]);
  // Land focus on the first togglable role; if every role is already
  // on the project (rare — PM lock plus full team), fall through to 0.
  const startIdx = firstOpenTile ? tileEls.indexOf(firstOpenTile) : 0;
  ring.index = startIdx >= 0 ? startIdx : 0;
  ring.paint();

  renderActionBar([]);
  setShortcuts([
    { gamepad: 'cross',   keyboard: 'Space', label: 'Toggle',   action: () => toggleFocusedAddAgentRole() },
    { gamepad: 'triangle', keyboard: 'A',     label: 'Activity', action: () => toggleActivityDrawer() },
    { gamepad: 'square',  keyboard: 'E',     label: 'Explorer', action: () => toggleFileExplorer() },
    { gamepad: 'circle',  keyboard: 'Esc',   label: 'Back',     action: () => renderGrid() },
  ]);
  setPrimaryShortcut({ gamepad: 'triangle', keyboard: 'Enter', label: 'Done',
                       action: () => commitAddAgentSelections() });
  syncAddAgentConfirm();   // Continue starts disabled until a role is picked
  // Tiles render after the async /roles fetch, so the morph's own stagger ran
  // before they existed — stagger them in here instead.
  staggerInCards();
  staggerInFooter();
}

function toggleFocusedAddAgentRole() {
  const cur = ring.current();
  if (!cur) return;
  if (cur.dataset.locked === 'true') return; // locked roles cannot be un-checked
  const id = cur.dataset.roleId;
  if (!id) return;
  if (addAgentSelected.has(id)) addAgentSelected.delete(id);
  else addAgentSelected.add(id);
  const toggle = cur.querySelector('.role-toggle');
  if (toggle) toggle.dataset.checked = String(addAgentSelected.has(id));
  syncAddAgentConfirm();
}

/* Bulletproof return from the add/remove screen to its project's grid (L1),
 * independent of `mode` / `activeProject` state. */
function leaveAddAgentToGrid() {
  if (!activeProject && addAgentReturnProject) activeProject = addAgentReturnProject;
  mode = MODE_GRID;
  renderGrid();
}
// Capture-phase Escape: while the add/remove screen is open, Esc ALWAYS returns
// to the grid and nothing else (e.g. the grid's Escape→exitToProjects) runs.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.body.dataset.addAgentOpen !== '1') return;
  // A modal open over the screen owns Esc (e.g. the "really cancel?" dialog).
  if (settingsOpen || editBubbleOpen || confirmCancelOpen || projectEditOpen || notificationsOpen) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!e.repeat) leaveAddAgentToGrid();
}, true);

/* True when the picker's desired roster differs from when it opened. */
function addAgentChanged() {
  if (addAgentSelected.size !== addAgentBaseline.size) return true;
  for (const r of addAgentSelected) if (!addAgentBaseline.has(r)) return true;
  return false;
}
/* Continue is enabled only once the roster has actually changed (an add or a
 * remove); grayed out (disabled) otherwise. */
function syncAddAgentConfirm() {
  if (mode !== MODE_ADD_AGENT) return;
  const btn = surfaceEl.querySelector('.role-confirm');
  if (btn) btn.disabled = !addAgentChanged();
}

async function commitAddAgentSelections() {
  if (!activeProject) return;
  const pid = activeProject.id;
  const leadId = activeProject.leadAgentId;
  const toAdd = [...addAgentSelected].filter(r => !addAgentBaseline.has(r));
  const toRemove = activeProject.agents.filter(a => a.id !== leadId && !addAgentSelected.has(a.role));
  if (toAdd.length === 0 && toRemove.length === 0) { renderGrid(); return; }
  setIndicator('thinking', 'Updating team…');
  let updated = null;
  for (const roleId of toAdd) {
    try {
      const r = await fetch(`/projects/${pid}/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId }),
      });
      if (r.ok) updated = await r.json();
    } catch (err) { console.error(`[add-agent] add failed: ${roleId}`, err); }
  }
  for (const a of toRemove) {
    try {
      const r = await fetch(`/projects/${pid}/agents/${a.id}`, { method: 'DELETE' });
      if (r.ok) updated = await r.json();
    } catch (err) { console.error(`[add-agent] remove failed: ${a.id}`, err); }
  }
  if (updated) {
    const i = projects.findIndex(p => p.id === pid);
    if (i >= 0) projects[i] = updated;
    activeProject = withLeadFirst(updated);
  }
  setIndicator('idle', 'Connected');
  renderGrid();
}

/** L1 shortcuts depend on which agent is focused — the lead can't be
 *  disabled, so "Agent on / off" disappears when the lead is selected. */
function updateGridShortcuts() {
  if (!activeProject) return;
  const lead = activeProject.agents.find(a => a.id === activeProject.leadAgentId);
  const focused = activeProject.agents[gridIndex];
  const isLeadFocused = focused?.id === activeProject.leadAgentId;
  const items = [
    { gamepad: 'l1', keyboard: '[', label: 'Prev project', keepFocus: true, action: () => cycleProject(-1) },
    { gamepad: 'r1', keyboard: ']', label: 'Next project', keepFocus: true, action: () => cycleProject(+1) },
    {                    gamepad: 'triangle', keyboard: 'A', label: 'Activity', keepFocus: true, action: () => toggleActivityDrawer() },
    { gamepad: 'square', keyboard: 'E', label: 'Explorer', keepFocus: true, action: () => toggleFileExplorer() },
  ];
  if (!isLeadFocused) {
    // Toggling an agent needs a grid tile selected, which isn't the case while
    // focus is in the footer rail — so this chip shows disabled (and is inert)
    // when reached by footer navigation.
    items.push({ gamepad: 'options', keyboard: 'Space', label: 'Agent on / off',
                 disabledInRail: true, action: () => toggleFocusedAgentEnabled() });
  }
  items.push({ gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => exitToProjects() });
  setShortcuts(items);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => enterZoom() });
}

function summarizeLastSpec(spec) {
  if (!spec) return '';
  if (spec.title) return escapeHtml(spec.title);
  if (spec.body)  return escapeHtml(String(spec.body).slice(0, 80));
  return spec.intent || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Display-time sentence case: uppercase the first letter, leave the
 *  rest of the string as-typed (so iOS, Cassidy, etc. survive). */
function sentenceCase(s) {
  const t = String(s ?? '').trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* Grid navigation: reflow layout — read cols/rows from the rendered grid. */
function gridMove(dir) {
  if (mode !== MODE_GRID) return;
  const grid = surfaceEl.querySelector('.agent-grid');
  if (!grid) return;
  const next = stepGrid(grid, ring.index, ring.elements.length, dir);
  if (next == null) return;   // consumed by footer entry / rubberband
  playSfx('navigate');   // agent → agent (cursor move on L1 grid)
  ring.index = next;
  gridIndex = next;
  ring.paint();
  updateGridShortcuts();
}


async function enterZoom(specOverride) {
  if (!activeProject) return;
  // Non-agent grid tiles are routed by their dataset (order-independent), not by
  // index. The Council tile opens the council; the "+ Add agent" tile opens the
  // role picker with the same zoom-in morph as a real agent tile.
  if (mode !== MODE_ZOOM && ring.current()?.dataset.council === 'true') {
    playSfx('zoomin');   // L1 → council, same as zooming into an agent
    openCouncil();
    return;
  }
  if (mode !== MODE_ZOOM && ring.current()?.dataset.addAgent === 'true') {
    await ensureRolesLoaded();   // prefetch so the picker renders synchronously inside the morph
    const addTile = ring.current();
    const addRect = addTile?.getBoundingClientRect();
    // Switch mode before the morph so a Back pressed during/after the morph
    // routes to the add-agent handler (→ L1 grid), not the grid's circle
    // handler (→ L0). openAddAgentPicker re-sets it at the handoff.
    mode = MODE_ADD_AGENT;
    playSfx('zoomin');   // L1 → add-agent picker ("+ Add agent" tile selected)
    await forwardMorph(addTile, addRect, surfaceContentRectFor(MODE_ADD_AGENT), () => openAddAgentPicker());
    return;
  }
  const wasAtGrid = mode !== MODE_ZOOM;
  const idx = wasAtGrid ? gridIndex : zoomedIndex;
  if (!wasAtGrid) {
    // Re-render in place — no transition (e.g. spec update from submitIntent).
    zoomedIndex = idx;
    mode = MODE_ZOOM;
    renderZoom(specOverride);
    return;
  }
  _focusLastOnNextChatRender = true;   // navigated INTO the agent → focus its last bubble
  playSfx('zoomin');   // L1 → L2 (agent tile selected)
  const sourceTile = ring.current();
  const sourceRect = sourceTile?.getBoundingClientRect();
  // Destination: zoom mode, where the surface sheds its padding — measuring in
  // grid mode landed the morph 28px short and the view popped wider on render.
  const targetRect = surfaceContentRectFor(MODE_ZOOM);
  zoomStack.push(sourceRect);
  zoomedIndex = idx;
  mode = MODE_ZOOM;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderZoom(specOverride));
}

function renderZoom(specOverride) {
  const agent = currentAgent();
  if (!agent) return renderGrid();
  // Opening an agent counts as seeing its output → clear a "Task complete" flag
  // (but not a pending question, which only clears when the user replies).
  clearTaskComplete(agent.id);
  // Own the mode so direct callers (e.g. the boot-time restore) don't render
  // the agent view while `mode` is still MODE_PROJECTS — which would mis-size
  // the surface (no body[data-mode="zoom"]) and break all the zoom keybinds.
  mode = MODE_ZOOM;
  document.body.dataset.mode = mode;
  saveNavState();
  document.documentElement.style.setProperty('--agent-color', getProjectColor(activeProject));
  // L2 breadcrumb keeps the agent context out — the page header already
  // shows "<Name> · <Role>". Just trail back to the project.
  setBreadcrumbs([
    { label: 'Projects' },
    { label: activeProject.name },
  ]);
  surfaceEl.innerHTML = '';

  const view = document.createElement('section');
  view.className = 'agent-view';
  view.innerHTML = `
    <div class="agent-header">
      <div class="agent-title">
        <span class="name-large">${escapeHtml(agent.name)}</span>
        <span class="role-large">${escapeHtml(roleLabel(agent.role))}</span>
        <span class="agent-status" data-await="${agentPending.get(agent.id) === 'reply' ? 'reply' : ''}">${escapeHtml(agentStatusLabel(agent.id))}</span>
      </div>
    </div>
    <div class="chat-scroll"></div>
    <div class="tile-surface"></div>
    <div class="agent-view-hint">
      <span class="for-gamepad">Hold <kbd>R2</kbd> to talk</span>
      <span class="for-keyboard">Hold <kbd>V</kbd> to talk</span>
    </div>`;
  surfaceEl.appendChild(view);
  // Close × button — top-right of the agent surface, exits to L1.
  surfaceEl.appendChild(createSurfaceCloseButton(() => exitZoom()));
  const chatEl = view.querySelector('.chat-scroll');
  const surfaceWrap = view.querySelector('.tile-surface');

  // Always-visible inline conversation history (iMessage-style bubbles).
  renderChatHistory(chatEl, agent);

  const spec = specOverride ?? agent.lastSpec;
  if (!spec) {
    surfaceWrap.innerHTML = '';
    renderActionBar([]);
    ring.set([]);
    _setL2Shortcuts();
    // The PM's kickoff plan renders its Approve/Disapprove buttons inline,
    // embedded in the plan bubble (see renderChatHistory) — not in the footer.
    return;
  }

  // Compose / list specs still get their interactive surface below the
  // chat; reader/answer specs are already represented as the latest
  // agent bubble, so we don't double up.
  const showTile = spec.template === 'compose' || spec.template === 'list';
  if (showTile) {
    const { surface, focusables, autoSpeak } = renderTile(spec);
    surfaceWrap.appendChild(surface);
    const actionButtons = renderActionBar(spec.actions || []);
    ring.set([...focusables, ...actionButtons]);
    for (const btn of actionButtons) {
      btn.addEventListener('click', () => executeAction(btn._action, spec));
    }
    for (const f of focusables) {
      f.addEventListener('click', () => { ring.moveTo(el => el === f); pressCross(); });
    }
    if (autoSpeak && !specOverride?._silent) speak(autoSpeak, { agentId: agent.id });
  } else {
    renderActionBar([]);
    ring.set([]);
    if (spec.body && !specOverride?._silent) speak(spec.body, { agentId: agent.id });
  }
  _setL2Shortcuts();
}

/* When the lead's L2 opens with no live lastSpec but the project's kickoff
 * is awaiting approval, the PM's plan turn lives only in chat history. Pull
 * the latest assistant turn that carries an `actions` array out of history
 * and surface those actions (Approve / Revise) in the L2 action bar, wired
 * to executeAction. No-op for non-lead agents or other kickoff states. */
/* Inline kickoff approval embedded in the PM's plan bubble (bottom-right):
 * Approve runs the kickoff, Disapprove dismisses it. */
function buildKickoffApproval(agent, bubble) {
  const row = document.createElement('div');
  row.className = 'bubble-kickoff-actions';
  // Reuse the standard secondary/primary button styles (role-cancel / role-confirm).
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.className = 'role-cancel';
  reject.textContent = 'Reject';
  reject.addEventListener('click', (e) => { e.stopPropagation(); kickoffDecide('decline', agent); });
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'role-confirm';
  approve.textContent = 'Approve';
  approve.addEventListener('click', (e) => { e.stopPropagation(); kickoffDecide('approve', agent); });
  row.append(reject, approve);
  // The buttons are reached via the bubble's own keyboard/gamepad model: when
  // the plan bubble is focused, Left/Right cycle into them (cycleBubbleAction
  // recognizes .bubble-kickoff-actions), Cross/Enter activates, and Up still
  // walks up the bubbles to the × close. No separate ring.
  return row;
}

/* A handoff bubble's bottom-right "Talk to <name>" button. Reuses the
 * kickoff action-row layout so it's reachable via the bubble's keyboard/gamepad
 * model (cycleBubbleAction recognizes .bubble-kickoff-actions button). */
function buildHandoffButton(handoffTo) {
  const row = document.createElement('div');
  row.className = 'bubble-kickoff-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'role-confirm';
  // The bubble already names the agent WITH their role, so the button only needs
  // the name. Prefer the live roster name; fall back to the label minus any
  // "(role)" suffix, then the raw label.
  const name = activeProject?.agents?.find(a => a.id === handoffTo.agentId)?.name
    || String(handoffTo.label || '').replace(/\s*\(.*\)\s*$/, '').trim()
    || handoffTo.label;
  btn.textContent = `Talk to ${name}`;
  btn.addEventListener('click', (e) => { e.stopPropagation(); openAgentById(handoffTo.agentId); });
  row.appendChild(btn);
  return row;
}

async function kickoffDecide(which, agent) {
  clearUnseen(agent.id);   // the user acted → no longer awaiting them
  const path = which === 'approve' ? 'kickoff/approve' : 'kickoff/decline';
  setIndicator('thinking', which === 'approve' ? 'Starting kickoff…' : 'Dismissing…');
  // Approve kicks off a long server task (docs, tasks, questions) — show the
  // "…" thinking bubble immediately so the wait isn't dead air.
  if (which === 'approve') { leaveBubbleFocus(); showPendingAgentBubble(); }
  try {
    const r = await fetch(`/projects/${activeProject.id}/${path}`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    const status = which === 'approve' ? 'running' : 'declined';
    if (activeProject.kickoff) activeProject.kickoff.status = status;
    else activeProject.kickoff = { status };
    setIndicator('idle', 'Connected');
    const chat = chatScrollEl();
    if (chat) await renderChatHistory(chat, agent);
  } catch (err) {
    setIndicator('error', which === 'approve' ? 'Kickoff failed' : 'Failed');
    console.error('[kickoff]', which, 'failed:', err);
  }
}

/* Agent-offered choices: a horizontal row of selectable options inside the
 * bubble. The user toggles one or more (Space / Enter / ✕), then a Submit
 * button below-right sends the chosen set as the next message. Reachable via
 * the bubble's keyboard/gamepad model (cycleBubbleAction). */
function buildChoiceList(choices, agent, picked, skippable = false, handlers = {}) {
  // `picked` (an array) → memorialized/read-only: a past question whose answer
  // we replay as the displayed selection. Otherwise the list is interactive.
  const memorial = Array.isArray(picked);
  const wrap = document.createElement('div');
  wrap.className = 'bubble-choices' + (memorial ? ' memorial' : '');

  const opts = document.createElement('div');
  opts.className = 'bubble-choices-options';
  choices.forEach((c, i) => {
    const text = String(c).trim();
    if (!text) return;
    const letter = String.fromCharCode(65 + i);   // A, B, C, …
    // Strip any existing "A — " / "A. " / "A) " prefix; show the letter as a
    // heading and the description on the next line.
    const desc = text.replace(/^[A-Za-z]\s*[—\-.):]\s*/, '').trim() || text;
    // Use <div role=button>, not <button>: a <button> doesn't report its
    // wrapped-content height to the parent grid, so long option text clipped.
    const el = document.createElement('div');
    el.className = 'choice-btn';
    el.dataset.choice = text;                      // original choice text (submitted/matched)
    const isSel = memorial && picked.some(p => p === text || p === desc);
    el.setAttribute('aria-pressed', isSel ? 'true' : 'false');
    if (isSel) el.classList.add('selected');
    if (!memorial) { el.setAttribute('role', 'button'); el.tabIndex = 0; }
    el.innerHTML =
      `<span class="choice-letter">${escapeHtml(letter)}</span>` +
      `<span class="choice-desc">${escapeHtml(desc)}</span>`;
    if (!memorial) el.addEventListener('click', (e) => { e.stopPropagation(); toggleChoice(el); });
    opts.appendChild(el);
  });

  // Heights are handled entirely by the CSS grid (single auto row + block
  // buttons stretch to the tallest content) — which reflows correctly when the
  // web font swaps in. A JS scrollHeight pass would measure the fallback font
  // pre-swap and lock a stale min-height, re-introducing clipping; don't.

  // A memorialized (answered) list is a record — no Other / Submit / hint.
  if (memorial) { wrap.appendChild(opts); return wrap; }

  // Always offer an "Other" escape hatch — hold it to dictate a free-form
  // answer. Holding (pointer, or the global V / R2 while it's focused) plays a
  // wave inside the button and hides its label; release transcribes + submits.
  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'choice-other';
  other.innerHTML =
    `<span class="choice-other-label">Other</span>` +
    `<span class="choice-other-sub">Hold to talk</span>` +
    `<span class="choice-other-wave" aria-hidden="true">${'<i></i>'.repeat(9)}</span>`;
  other.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    // Capture the pointer so the hold survives layout shifts. Starting dictation
    // appends the "…" pending bubble (showPendingBubble) and scrolls, which moves
    // THIS button out from under a stationary cursor. Without capture that fires
    // pointerleave and cancels the hold. Capture binds the pointer to the button
    // until release, so only pointerup/cancel end it.
    try { other.setPointerCapture(e.pointerId); } catch {}
    startOtherDictate(other);
  });
  other.addEventListener('pointerup',           () => endOtherDictate());
  other.addEventListener('pointercancel',       () => endOtherDictate());
  // No pointerleave ender — with capture the pointer stays bound to the button and
  // release ends the hold wherever the cursor is. lostpointercapture is a safety
  // net (e.g. the button is removed mid-hold) so dictation never gets stuck on.
  other.addEventListener('lostpointercapture',  () => endOtherDictate());
  opts.appendChild(other);

  wrap.appendChild(opts);

  // No preset options → a free-form question: the user answers by holding Other
  // to talk or typing with "/". Show that hint and skip the (never-enabling)
  // Submit; with options, it's the normal multi-select.
  const hasChoices = choices.some(c => String(c).trim());
  const submitRow = document.createElement('div');
  submitRow.className = 'bubble-choices-submit';
  const hint = document.createElement('span');
  hint.className = 'bubble-choices-hint';
  hint.textContent = hasChoices ? 'Select one or more with ←/→' : 'Hold “Other” to talk, or type with /';
  // Right-side action group: [Skip for now] [Submit]. Skip precedes Submit in
  // the DOM so the bubble nav model (cycleBubbleAction → document order) reaches
  // it just left of Submit, matching its visual position.
  const actions = document.createElement('div');
  actions.className = 'bubble-choices-actions';
  if (skippable) {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'choice-skip';
    skip.textContent = 'Skip for now';
    skip.addEventListener('click', (e) => { e.stopPropagation(); playSfx('select'); if (handlers.onSkip) handlers.onSkip(); else skipChoices(wrap, agent); });
    actions.appendChild(skip);
  }
  if (hasChoices) {
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'choice-submit role-confirm is-disabled';   // disabled until a pick
    submit.setAttribute('aria-disabled', 'true');
    submit.textContent = 'Submit';
    submit.addEventListener('click', (e) => {
      e.stopPropagation();
      playSfx('select');
      if (handlers.onSubmit) {
        const arr = [...wrap.querySelectorAll('.choice-btn[aria-pressed="true"]')]
          .map(b => (b.dataset.choice || b.textContent).trim()).filter(Boolean);
        if (arr.length) handlers.onSubmit(arr);
      } else submitChoices(wrap, agent);
    });
    actions.appendChild(submit);
  }
  submitRow.append(hint, actions);
  wrap.appendChild(submitRow);

  return wrap;
}

/* Hold-to-talk on an "Other" choice button: start/stop push-to-talk. The wave
 * inside the button is driven by setPttHeld (so the global V/R2 hold lights it
 * too); the transcript flows through the normal PTT path and submits. */
let _otherDictateBtn = null;
function startOtherDictate(btn) {
  if (_otherDictateBtn || pttActive) return;
  _otherDictateBtn = btn;        // set before startPTT so setPttHeld lights it
  startPTT();
}
function endOtherDictate() {
  if (!_otherDictateBtn) return;
  _otherDictateBtn.classList.remove('talking');
  _otherDictateBtn = null;
  endPTT();
}
function toggleChoice(btn) {
  playSfx('select');   // selecting / deselecting a choice in a bubble
  const on = btn.getAttribute('aria-pressed') === 'true';
  btn.setAttribute('aria-pressed', on ? 'false' : 'true');
  btn.classList.toggle('selected', !on);
  // Submit is enabled only while at least one option is selected.
  const wrap = btn.closest('.bubble-choices');
  const submit = wrap?.querySelector('.choice-submit');
  if (submit) {
    const any = !!wrap.querySelector('.choice-btn[aria-pressed="true"]');
    submit.classList.toggle('is-disabled', !any);
    submit.setAttribute('aria-disabled', any ? 'false' : 'true');
  }
}
function submitChoices(wrap, agent) {
  if (currentAgent()?.id !== agent.id) return;
  const picked = [...wrap.querySelectorAll('.choice-btn[aria-pressed="true"]')]
    .map(b => (b.dataset.choice || b.textContent).trim()).filter(Boolean);
  if (!picked.length) return;          // nothing selected → no-op
  leaveBubbleFocus();
  submitIntent(picked.join('; '));     // the chosen option(s) become the next message
}
/* "Skip for now": advance past the question without answering. The server
 * recognizes this exact literal (kickoff.js SKIP_TOKEN) and moves to the next
 * question without recording an answer. Always available — no pick required. */
function skipChoices(wrap, agent) {
  if (currentAgent()?.id !== agent.id) return;
  leaveBubbleFocus();
  submitIntent('Skip for now');
}

/* Selectable chat bubbles: each prompt / response is a tabbable
 * element with a hover-state action row (timestamp + retry + edit on
 * user turns, timestamp on agent turns). chatBubbles holds the live
 * NodeList for focus traversal. */
let chatBubbles = [];      // DOM nodes in order
let chatBubbleIdx = -1;    // -1 = not in chat
let chatMessages = [];     // last-fetched message records
// Set by a navigation INTO L2 (open agent / switch agent) so the next chat
// render lands focus on the agent's last bubble. Consumed (and cleared) once;
// live re-renders (SSE/ack) don't set it, so they never steal focus.
let _focusLastOnNextChatRender = false;
let _prevTurnCount = {};   // per-agent: message count at last render, to animate only NEW bubbles
let pendingUserBubbleEl = null;  // optimistic "you" bubble shown while holding to talk
let pendingAgentBubbleEl = null; // "…" agent bubble shown the instant a prompt is submitted
let _redoStreak = { text: null, n: 0 };  // consecutive redos of the same prompt → escalate sampling

function formatBubbleTime(at) {
  if (!at) return '';
  try {
    const d = new Date(at);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

/* Relative "2 min ago" / "3 hours ago" / "3 days ago" — used by the activity
 * feed (computed at render time; refreshes whenever the list repaints). */
function relativeTime(at) {
  if (!at) return '';
  const diff = Date.now() - Number(at);
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} week${w === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

/* v2 — Claude-Code-style action cards rendered above the body in
 * agent bubbles. Each entry in actions_taken looks like:
 *   { kind: 'created'|'edited'|'ran'|'read'|'searched', label?, count?, items?, result? }
 * Cards collapse to one row each; ones with `items` expand on click. */
const ACTION_KIND = {
  created:  { glyph: '+',  cls: 'created',  defaultLabel: 'Created' },
  edited:   { glyph: '~',  cls: 'edited',   defaultLabel: 'Edited' },
  deleted:  { glyph: '−',  cls: 'deleted',  defaultLabel: 'Deleted' },
  ran:      { glyph: '▶',  cls: 'ran',      defaultLabel: 'Ran' },
  read:     { glyph: '◉',  cls: 'read',     defaultLabel: 'Read' },
  searched: { glyph: '⌕',  cls: 'searched', defaultLabel: 'Searched' },
};

function buildActionCards(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble-actions-taken';
  for (const a of actions) {
    const def = ACTION_KIND[a.kind] || { glyph: '•', cls: 'generic', defaultLabel: 'Did' };
    const card = document.createElement('div');
    card.className = `action-card action-${def.cls}`;
    const hasItems = Array.isArray(a.items) && a.items.length > 0;
    const head = `
      <span class="action-glyph">${escapeHtml(def.glyph)}</span>
      <span class="action-text">
        <strong>${escapeHtml(def.defaultLabel)}</strong>
        ${a.count ? `<span class="action-meta">${escapeHtml(String(a.count))} file${a.count === 1 ? '' : 's'}</span>` : ''}
        ${a.label && !a.count ? `<code class="action-label">${escapeHtml(a.label)}</code>` : ''}
        ${a.result ? `<span class="action-result">${escapeHtml(a.result)}</span>` : ''}
      </span>
      ${hasItems ? '<span class="action-expand" aria-hidden="true">▾</span>' : ''}`;
    card.innerHTML = head;
    if (hasItems) {
      const detail = document.createElement('ul');
      detail.className = 'action-items';
      for (const it of a.items) {
        const li = document.createElement('li');
        li.innerHTML = `<code>${escapeHtml(it)}</code>`;
        detail.appendChild(li);
      }
      card.appendChild(detail);
      card.classList.add('collapsible');
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('expanded');
      });
    }
    wrap.appendChild(card);
  }
  return wrap;
}

/* v2 §4 — render a delegation handoff as a distinct centered bubble.
 * Payload (stored as JSON in m.content) looks like:
 *   { kind: 'handoff', from, to, fromRole?, toRole?, task }
 * Anything else (legacy system turns) renders as plain text. */
function renderHandoffBubble(m, idx) {
  let payload = null;
  try {
    payload = JSON.parse(String(m.content || '').trim());
    if (payload?.kind !== 'handoff') payload = null;
  } catch { payload = null; }

  const el = document.createElement('div');
  el.className = 'bubble system handoff';
  el.dataset.idx = String(idx);
  el.dataset.role = 'system';

  if (payload) {
    const party = (name, role) =>
      `<span class="handoff-party">` +
        `<span class="handoff-name">${escapeHtml(name || '')}</span>` +
        (role ? `<span class="handoff-role">${escapeHtml(role)}</span>` : '') +
      `</span>`;
    const head = document.createElement('div');
    head.className = 'handoff-heading';
    head.innerHTML =
      party(payload.from, payload.fromRole) +
      `<span class="handoff-arrow" aria-hidden="true">→</span>` +
      party(payload.to, payload.toRole);
    el.appendChild(head);
    if (payload.task) {
      const task = document.createElement('div');
      task.className = 'handoff-task';
      task.textContent = payload.task;
      el.appendChild(task);
    }
  } else {
    el.textContent = String(m.content || '');
  }
  return el;
}

/* Re-render the open L2 chat for `agentId` when the server posts a turn on its
 * own (kickoff plan, one-at-a-time questions). No-op unless we're zoomed on
 * that agent and no client request owns the view. Pulls the new turn in and
 * clears the "…" thinking bubble. */
let _zoomRefreshPending = false;
async function maybeRefreshZoomFor(agentId) {
  if (mode !== MODE_ZOOM || inflightController) return;
  const a = currentAgent();
  if (!a || a.id !== agentId) return;
  if (_zoomRefreshPending) return;
  _zoomRefreshPending = true;
  try {
    const chat = chatScrollEl();
    if (chat) await renderChatHistory(chat, a);
  } finally { _zoomRefreshPending = false; }
}

/* Typewriter-reveal a bubble's text so scripted (non-streamed) agent messages
 * also look "typed", like the live-streamed replies. Reveals the plain text
 * progressively, then restores the full markdown HTML. Skips long bodies. */
function typewriterReveal(contentEl) {
  if (!contentEl) return;
  const finalHTML = contentEl.innerHTML;
  const plain = contentEl.textContent || '';
  if (plain.length < 2 || plain.length > 700) return;   // too short/long to bother
  const chat = contentEl.closest('.chat-scroll');
  const step = Math.max(1, Math.round(plain.length / 110));   // ~110 frames end-to-end
  let i = 0;
  contentEl.textContent = '';
  const token = (contentEl._twToken = (contentEl._twToken || 0) + 1);
  const tick = () => {
    if (contentEl._twToken !== token || !contentEl.isConnected) return;   // superseded / detached
    i += step;
    contentEl.textContent = plain.slice(0, i);
    if (chat) chat.scrollTop = chat.scrollHeight;
    if (i < plain.length) requestAnimationFrame(tick);
    else contentEl.innerHTML = finalHTML;   // restore bold/lists/links/code
  };
  requestAnimationFrame(tick);
}

async function renderChatHistory(container, agent) {
  // How many turns we had rendered for this agent before — anything beyond it is
  // new and gets the rise-in transition. `undefined` on first view (no animation).
  const prevCount = _prevTurnCount[agent.id];
  container.innerHTML = '';
  chatBubbles = [];
  chatBubbleIdx = -1;
  chatMessages = [];
  pendingUserBubbleEl = null;   // the optimistic bubbles (if any) were just cleared by innerHTML = ''
  pendingAgentBubbleEl = null;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history`);
    if (!r.ok) return;
    const { messages } = await r.json();
    chatMessages = messages || [];
    // Index of the most-recent assistant turn — the kickoff plan's inline
    // Approve/Disapprove buttons render only on it (and only while pending).
    let lastAssistantIdx = -1;
    for (let k = (messages || []).length - 1; k >= 0; k--) {
      if (messages[k].role === 'assistant') { lastAssistantIdx = k; break; }
    }
    // iOS-group-chat style: each agent (left-side) bubble gets a sender
    // name + role header, suppressed for consecutive turns by the same
    // author. Reset on every user / system turn so a new run re-labels.
    let lastShownAuthor = null;
    messages.forEach((m, i) => {
      // v2 §4: a 'system' turn carrying a JSON handoff payload renders
      // as a distinct neutral bubble between agent / user bubbles.
      // Handoff bubbles are read-only (not focusable, not in the
      // keyboard nav ring) — they're context, not actions.
      if (m.role === 'system') {
        const handoffEl = renderHandoffBubble(m, i);
        if (handoffEl) container.appendChild(handoffEl);
        lastShownAuthor = null;
        return;
      }
      // A host agent's own "delegate" turn is already represented by the
      // handoff bubble + the delegate's surfaced reply — don't also render
      // its raw spec JSON as a bubble.
      if (m.role === 'assistant' && !m.author) {
        try {
          const p = JSON.parse(String(m.content || '').replace(/^```(?:json)?/i,'').replace(/```$/, '').trim());
          if (p?.intent === 'delegate') return;
        } catch { /* not a delegate spec — render normally */ }
      }
      const isUser = m.role === 'user';
      const bubble = document.createElement('div');
      bubble.className = `bubble ${isUser ? 'user' : 'agent'}`;
      bubble.dataset.idx = String(i);
      bubble.dataset.role = m.role;
      bubble.tabIndex = 0;

      // Sender label: only on OTHER agents' bubbles — a "foreign" bubble (e.g.
      // a delegate's reply surfaced into this agent's chat). The viewed agent's
      // own bubbles get no name header.
      const isForeign = !isUser && !!(m.author && m.author.id && m.author.id !== agent.id);
      if (isForeign) {
        bubble.classList.add('foreign');
        const name = m.author.name || '';
        const role = m.author.role || '';
        if (name !== lastShownAuthor) {
          const hdr = document.createElement('div');
          hdr.className = 'bubble-author';
          hdr.innerHTML =
            `<span class="bubble-author-name">${escapeHtml(name)}</span>` +
            (role ? `<span class="bubble-author-role">${escapeHtml(role)}</span>` : '');
          bubble.appendChild(hdr);
        }
        lastShownAuthor = name;
      } else {
        lastShownAuthor = null;
      }
      let body = String(m.content || '').trim();
      let actionsTaken = null;
      let isKickoffPlan = false;
      let choices = null;
      let skippable = false;
      let handoffTo = null;
      if (!isUser) {
        try {
          const parsed = JSON.parse(body.replace(/^```(?:json)?/i,'').replace(/```$/, '').trim());
          if (parsed?.body) body = parsed.body;
          else if (parsed?.title) body = parsed.title;
          if (Array.isArray(parsed?.actions_taken)) actionsTaken = parsed.actions_taken;
          if (Array.isArray(parsed?.actions) && parsed.actions.some(a => (a.action?.type || a.type) === 'approve_kickoff')) isKickoffPlan = true;
          if (Array.isArray(parsed?.choices) && parsed.choices.length) choices = parsed.choices.slice(0, 4);
          if (parsed?.skippable) skippable = true;
          if (parsed?.handoffTo?.agentId) handoffTo = parsed.handoffTo;
        } catch { /* leave body as-is */ }
      }
      // Strip the "[team-voice] " prefix added by the team driver so the
      // user sees the original prompt.
      const promptText = body.replace(/^\[team-voice\]\s*/, '');

      // Action cards (Claude-Code-style) render above the body for
      // agent bubbles — created/edited/ran/read/searched summaries.
      if (!isUser && actionsTaken && actionsTaken.length) {
        bubble.appendChild(buildActionCards(actionsTaken));
      }

      const content = document.createElement('div');
      content.className = 'bubble-content';
      if (isUser) {
        content.textContent = promptText;
      } else {
        // Render the assistant body as markdown (tables, code, lists,
        // bold/italic, links). Inline output is HTML-sanitized inside
        // md.js — only the parser's own tags survive.
        content.innerHTML = renderMarkdown(promptText);
        attachCodeCopyHandlers(content);
      }
      bubble.appendChild(content);

      // Kickoff plan: embed Approve / Disapprove in the bubble (bottom-right),
      // only on the latest assistant turn and while the kickoff is still
      // pending (not running/done/declined/no-key).
      if (!isUser && isKickoffPlan && i === lastAssistantIdx &&
          !['running', 'done', 'declined', 'skipped_no_key'].includes(activeProject?.kickoff?.status)) {
        bubble.appendChild(buildKickoffApproval(agent, bubble));
      }

      // Agent-offered choices → a selectable list in the bubble. A question with
      // no preset options (skippable) still gets the bubble so it shows the
      // "Other — hold to talk" answer path. If a later user turn already answered
      // it, replay their picks as a read-only record.
      if (!isUser && (choices || skippable)) {
        let answer = null;
        for (let k = i + 1; k < messages.length; k++) {
          if (messages[k].role === 'user') { answer = String(messages[k].content || ''); break; }
        }
        const picked = answer != null
          ? answer.split(/;\s*/).map(s => s.trim()).filter(Boolean)
          : undefined;
        bubble.appendChild(buildChoiceList(choices || [], agent, picked, skippable));
      }

      // Handoff bubble → a "Talk to <name> (<role>)" button (bottom-right) that
      // jumps straight to that teammate's chat. Shown only while the target
      // teammate still exists on the project.
      if (!isUser && handoffTo && activeProject?.agents?.some(a => a.id === handoffTo.agentId)) {
        bubble.appendChild(buildHandoffButton(handoffTo));
      }

      // Timestamp + retry / edit only render on user-authored bubbles.
      // Agent bubbles stay clean (no floating metadata).
      if (isUser) {
        const actions = document.createElement('div');
        actions.className = 'bubble-actions';
        const time = document.createElement('span');
        time.className = 'bubble-time';
        time.textContent = formatBubbleTime(m.at);
        actions.appendChild(time);

        const btnRow = document.createElement('div');
        btnRow.className = 'bubble-action-row';

        const retry = document.createElement('button');
        retry.className = 'bubble-action retry';
        retry.type = 'button';
        retry.setAttribute('aria-label', 'Retry');
        retry.title = 'Retry';
        retry.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 12a8 8 0 1 0 2.34-5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <polyline points="3 3 3 9 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        retry.addEventListener('click', (e) => { e.stopPropagation(); retryBubble(i); });
        btnRow.appendChild(retry);

        const edit = document.createElement('button');
        edit.className = 'bubble-action edit';
        edit.type = 'button';
        edit.setAttribute('aria-label', 'Edit');
        edit.title = 'Edit';
        edit.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M12 20h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        edit.addEventListener('click', (e) => { e.stopPropagation(); openEditBubbleModal(i); });
        btnRow.appendChild(edit);

        actions.appendChild(btnRow);
        bubble.appendChild(actions);
      }

      // chatBubbleIdx tracks the position in chatBubbles (the nav array), NOT
      // the message index `i` — they diverge when system/handoff messages are
      // skipped, which otherwise mis-highlights (e.g. the last bubble looks
      // unselected). Capture the array index this bubble will occupy.
      const arrIdx = chatBubbles.length;
      bubble.addEventListener('focus', () => {
        chatBubbleIdx = arrIdx;
        paintBubbleFocus();
      });
      bubble.addEventListener('click', () => bubble.focus());
      container.appendChild(bubble);
      chatBubbles.push(bubble);
    });
    // Turns added since the last render get the slide-up transition. We include
    // the last prior bubble (e.g. the question just answered) so the CURRENT
    // bubble and the NEW one slide up together. The newest agent bubble also
    // highlights, types in (if it wasn't streamed live), and staggers its
    // selection buttons like the Layer 1 tiles.
    const hasNew = prevCount != null && chatMessages.length > prevCount;
    _prevTurnCount[agent.id] = chatMessages.length;
    const streamed = _streamedAgentTurn; _streamedAgentTurn = false;
    if (hasNew) {
      for (const b of chatBubbles) {
        if (Number(b.dataset.idx) >= prevCount - 1) b.classList.add('bubble-rise');
      }
      const newest = chatBubbles[chatBubbles.length - 1];
      if (newest && newest.classList.contains('agent')) {
        newest.classList.add('highlight-new');
        if (!streamed) typewriterReveal(newest.querySelector('.bubble-content'));
        const optsEl = newest.querySelector('.bubble-choices:not(.memorial) .bubble-choices-options');
        if (optsEl) {
          optsEl.classList.add('stagger');
          [...optsEl.children].forEach((el, k) => el.style.setProperty('--stagger-i', String(k)));
        }
        // A fresh question (answerable choices) → drop focus straight onto the
        // first option so the user can answer immediately: no press to reach the
        // bubble, no press to step into the options. (Mirrors the kickoff-plan
        // auto-focus below; chatBubbleIdx must point at this bubble so the
        // bubble keyboard/gamepad model — cycleBubbleAction, submit — takes over.)
        const firstChoice = newest.querySelector('.bubble-choices:not(.memorial) .choice-btn');
        if (firstChoice) {
          chatBubbleIdx = chatBubbles.length - 1;
          firstChoice.focus({ preventScroll: true });
          paintBubbleFocus();
        }
      }
    }
    // Land at the bottom instantly; the rise keyframe starts each bubble
    // translated down, so the scroll target is already its final position.
    const prevBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = container.scrollHeight;
    container.style.scrollBehavior = prevBehavior;

    // If the agent is busy (e.g. the PM drafting its kickoff plan or working
    // post-approval) and no client request owns the view, show the "…" thinking
    // bubble so the user sees it's working — across every agent.
    // Use agentStatus (the server's SSE truth) as the authority, not just
    // agentBusy: submitIntent clears agentBusy when its HTTP request returns,
    // but background work (kickoff/team) outlives that request and keeps the
    // server-side verb non-idle — so without this the "…" bubble vanishes on
    // L2 re-entry while the agent is still working.
    const stillWorking = agentBusy[agent.id]
      || (agentStatus[agent.id] && agentStatus[agent.id] !== 'idle');
    // Re-show even while a client request is in flight: this render just wiped
    // any owned "…" bubble from the DOM, and showPendingAgentBubble dedupes.
    if (stillWorking) showPendingAgentBubble();

    // Kickoff plan awaiting approval → auto-focus the plan bubble so a single
    // Cross/Enter approves (no need to press Up first). The approval buttons
    // only render while the plan is pending, so their presence is the signal.
    if (chatBubbles.length &&
        chatBubbles[chatBubbles.length - 1].querySelector('.bubble-kickoff-actions')) {
      focusLastBubble();
    }

    // Navigating INTO this agent (opened it / swiped to it) → land focus on its
    // last bubble so the user starts on the most recent message, no press to
    // reach it. chatBubbleIdx is still -1 here unless a block above already
    // claimed focus (kickoff plan / a fresh question's first choice) — in which
    // case we leave that more-specific target alone.
    if (_focusLastOnNextChatRender) {
      _focusLastOnNextChatRender = false;
      if (chatBubbles.length && chatBubbleIdx < 0) focusLastBubble();
    }
  } catch (err) {
    console.warn('[chat] history failed:', err);
  }
}

/* ---------- Optimistic "you" bubble while holding to talk ----------
 * The instant the user holds to talk in the agent view, drop a user bubble
 * into the chat showing a "…" typing animation, then the live transcript
 * (word-by-word with the browser engine; the final text on release with local
 * Parakeet). It's replaced by the real persisted bubble when history re-renders
 * after the agent responds. */
function chatScrollEl() { return surfaceEl?.querySelector?.('.chat-scroll') || null; }
const TYPING_DOTS = '<span class="typing-dots" aria-label="listening"><span></span><span></span><span></span></span>';
/* Stop affordance shown inline inside the "…" pending agent bubble, on its
 * right. Always visible while the agent is thinking; also focusable so Right
 * (cycleBubbleAction) + Enter/Cross cancels the run. */
const STOP_ACTION_BTN =
  '<button type="button" class="bubble-action stop" aria-label="Stop run" title="Stop run">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>' +
    '<span class="stop-label">Stop</span>' +
  '</button>';
function showPendingBubble() {
  if (mode !== MODE_ZOOM || editBubbleOpen) return;   // not while dictating into the edit-prompt modal
  const chat = chatScrollEl();
  if (!chat) return;
  if (!pendingUserBubbleEl || !chat.contains(pendingUserBubbleEl)) {
    const b = document.createElement('div');
    b.className = 'bubble user pending';
    b.innerHTML = `<div class="bubble-content">${TYPING_DOTS}</div>`;
    chat.appendChild(b);
    pendingUserBubbleEl = b;
  }
  chat.scrollTop = chat.scrollHeight;
}
function updatePendingBubble(text) {
  if (!pendingUserBubbleEl) return;
  const content = pendingUserBubbleEl.querySelector('.bubble-content');
  if (!content) return;
  if (text && text.trim()) content.textContent = text;
  else content.innerHTML = TYPING_DOTS;
  const chat = chatScrollEl();
  if (chat) chat.scrollTop = chat.scrollHeight;
}
function clearPendingBubble() {
  if (pendingUserBubbleEl) { try { pendingUserBubbleEl.remove(); } catch {} }
  pendingUserBubbleEl = null;
}
/* Drop an agent "…" bubble the instant a prompt is submitted, so the reply
 * feels immediate. The streaming bubble reuses it (dots → tokens); on a
 * non-streamed reply the history re-render replaces it. */
function showPendingAgentBubble() {
  if (mode !== MODE_ZOOM) return;
  const chat = chatScrollEl();
  if (!chat) return;
  if (!pendingAgentBubbleEl || !chat.contains(pendingAgentBubbleEl)) {
    const b = document.createElement('div');
    b.className = 'bubble agent pending';
    b.tabIndex = 0;   // selectable so Right/cycleBubbleAction can reach Stop
    // No name/role header: the "…" is always the viewed agent's own bubble.
    // (Foreign/delegate bubbles get their header only once the real reply lands.)
    b.innerHTML = `<div class="bubble-content">${TYPING_DOTS}</div>` + STOP_ACTION_BTN;
    b.querySelector('.bubble-action.stop')?.addEventListener('click', () => cancelActiveRequest());
    chat.appendChild(b);
    pendingAgentBubbleEl = b;
    chatBubbles.push(b);   // join the keyboard/gamepad nav ring (always the last bubble)
  }
  chat.scrollTop = chat.scrollHeight;
}
function clearPendingAgentBubble() {
  if (pendingAgentBubbleEl) {
    const i = chatBubbles.indexOf(pendingAgentBubbleEl);
    if (i !== -1) {
      chatBubbles.splice(i, 1);
      if (chatBubbleIdx === i) leaveBubbleFocus();   // focus was on the bubble being removed
      else if (chatBubbleIdx > i) chatBubbleIdx -= 1;
    }
    try { pendingAgentBubbleEl.remove(); } catch {}
  }
  pendingAgentBubbleEl = null;
}
/* Replace the "…" bubble with a visible error bubble in chat, so a failed turn
 * doesn't just vanish. Ephemeral — wiped by the next successful history render. */
function friendlyError(message) {
  const m = String(message || '');
  if (/402|credit|max_tokens|afford/i.test(m)) {
    return 'Out of OpenRouter credits for this request — top up your balance (Settings → Health shows what’s left).';
  }
  return m || 'Request failed';
}
function showErrorBubble(message) {
  clearPendingAgentBubble();
  const chat = chatScrollEl();
  if (!chat) return;
  const b = document.createElement('div');
  b.className = 'bubble system error';
  b.textContent = friendlyError(message);
  chat.appendChild(b);
  chat.scrollTop = chat.scrollHeight;
}

function paintBubbleFocus() {
  // The bubble shows its selected ring only when the bubble itself holds focus.
  // When focus is on one of its action icons (retry / edit), drop the ring but
  // keep the action row visible via .actions-open (the icons live in a panel
  // that only renders for .focused / .actions-open).
  const onAction = !!(document.activeElement?.classList?.contains('bubble-action')
    || document.activeElement?.closest?.('.bubble-kickoff-actions, .bubble-choices'));
  chatBubbles.forEach((b, i) => {
    const cur = i === chatBubbleIdx;
    b.classList.toggle('focused', cur && !onAction);
    b.classList.toggle('actions-open', cur && onAction);
  });
}

function focusBubble(i) {
  if (chatBubbles.length === 0) return false;
  const n = chatBubbles.length;
  const next = Math.max(0, Math.min(n - 1, i));
  // 'navigate' is a cursor-MOVED cue — only when already on a bubble. The first
  // focus (chatBubbleIdx < 0: entering L2, which already plays 'zoomin') is
  // silent, so entry doesn't fire zoomin + navigate back-to-back.
  if (chatBubbleIdx >= 0 && next !== chatBubbleIdx) playSfx('navigate');
  chatBubbleIdx = next;
  // Paint directly rather than waiting on the focus event: re-focusing a
  // bubble that already holds DOM focus (common after a footer round-trip)
  // fires no focus event, which would otherwise leave the highlight stale.
  paintBubbleFocus();
  const el = chatBubbles[next];
  el.focus({ preventScroll: true });   // we manage the scroll ourselves
  scrollBubbleIntoView(el);
  return true;
}

/* Scroll a bubble into view. A bubble that fits within the viewport is always
 * revealed in full — neither top nor bottom clipped. A bubble taller than the
 * viewport aligns its top (top wins; you read top-to-bottom). */
function scrollBubbleIntoView(el) {
  const container = el.closest('.chat-scroll');
  if (!container) return;
  const pad = 8;
  // The agent header floats over the top of the scroll viewport; its clearance
  // equals .chat-scroll's padding-top (--header-h). Reveal focused bubbles
  // BELOW it so they're never parked under the name/role overlay.
  const headTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
  const cr = container.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const fits = er.height <= cr.height - headTop - pad * 2;
  if (er.top < cr.top + headTop + pad) {
    // Top is under the header → reveal it below the heading.
    container.scrollBy({ top: er.top - cr.top - headTop - pad, behavior: 'smooth' });
  } else if (er.bottom > cr.bottom - pad) {
    // Bottom is cut. If the whole bubble fits, bring the bottom fully in;
    // otherwise align the top (below the header) instead.
    const delta = fits ? (er.bottom - cr.bottom + pad) : (er.top - cr.top - headTop - pad);
    container.scrollBy({ top: delta, behavior: 'smooth' });
  }
}

function focusFirstBubble()    { return focusBubble(0); }
function focusLastBubble()     { return focusBubble(chatBubbles.length - 1); }
function moveBubbleFocus(d)    { return focusBubble(chatBubbleIdx + d); }
/* Register every .bubble in `container` into the nav ring + make it focusable,
 * so a non-agent L2 view (the council) gets the same selectable-bubble model as
 * agent chat (which populates chatBubbles during renderZoom). */
function registerNavBubbles(container) {
  chatBubbles = [...(container?.querySelectorAll('.bubble') || [])];
  chatBubbles.forEach(b => { if (!b.hasAttribute('tabindex')) b.tabIndex = 0; });
  chatBubbleIdx = -1;
}

/* Single-press Back from a selected bubble: leave L2 directly rather than first
 * un-selecting the bubble (which used to require a second press). Council exits
 * to the grid; an agent uses the canonical pressCircle (its spec's circle
 * action, else exitZoom). */
function backFromBubbleView() {
  if (mode === MODE_COUNCIL) exitCouncilToGrid();
  else pressCircle();
}

/* Keyboard navigation for a focused chat bubble — shared by agent L2 (MODE_ZOOM)
 * and the council (MODE_COUNCIL). Returns true if it consumed the key. */
function bubbleNavKeydown(e) {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (chatBubbleIdx <= 0) { leaveBubbleFocus(); if (!focusSurfaceClose()) bumpEdge(chatScrollEl(), 'up', 6); }
    else moveBubbleFocus(-1);
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (chatBubbleIdx >= chatBubbles.length - 1) {
      leaveBubbleFocus();
      if (ring.elements.length === 0) enterShortcuts(); else ring.paint();
      return true;
    }
    moveBubbleFocus(+1); return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); cycleBubbleAction(e.key === 'ArrowRight' ? +1 : -1); return true;
  }
  if ((e.code === 'Space' || e.key === 'Enter') && document.activeElement?.classList?.contains('choice-other')) {
    e.preventDefault(); if (!e.repeat) startOtherDictate(document.activeElement); return true;
  }
  if (e.key === 'Enter' && (document.activeElement?.classList?.contains('bubble-action')
      || document.activeElement?.closest?.('.bubble-kickoff-actions, .bubble-choices'))) {
    e.preventDefault(); document.activeElement.click(); return true;
  }
  if (e.key === 'Enter') {
    const approve = chatBubbles[chatBubbleIdx]?.querySelector('.bubble-kickoff-actions .role-confirm');
    if (approve) { e.preventDefault(); approve.click(); return true; }
  }
  if (e.key === 'Escape') { e.preventDefault(); backFromBubbleView(); return true; }
  return false;
}

/* Gamepad equivalent of bubbleNavKeydown — shared by agent L2 and council.
 * Returns true if it consumed the button. (Agent-only l1/r1 agent-cycling is
 * handled by the caller.) */
function bubbleNavButton(b) {
  if (b === 'up') {
    if (chatBubbleIdx <= 0) { leaveBubbleFocus(); if (!focusSurfaceClose()) bumpEdge(chatScrollEl(), 'up', 6); }
    else moveBubbleFocus(-1);
    return true;
  }
  if (b === 'down') {
    if (chatBubbleIdx >= chatBubbles.length - 1) { leaveBubbleFocus(); if (ring.elements.length === 0) enterShortcuts(); else ring.paint(); }
    else moveBubbleFocus(+1);
    return true;
  }
  if (b === 'left')  { cycleBubbleAction(-1); return true; }
  if (b === 'right') { cycleBubbleAction(+1); return true; }
  if (b === 'cross') {
    const a = document.activeElement;
    if (a?.classList?.contains('choice-other')) { startOtherDictate(a); return true; }
    if (a?.classList?.contains('bubble-action') || a?.closest?.('.bubble-kickoff-actions, .bubble-choices')) { a.click(); return true; }
    const approve = chatBubbles[chatBubbleIdx]?.querySelector('.bubble-kickoff-actions .role-confirm');
    if (approve) approve.click();
    return true;
  }
  if (b === 'circle') { backFromBubbleView(); return true; }
  return false;
}
function isBubbleFocused() {
  // True while either the bubble itself OR one of its action icons
  // (.bubble-action) holds focus — both states should keep the bubble
  // keyboard handler in charge of arrow navigation.
  if (chatBubbleIdx < 0) return false;
  const a = document.activeElement;
  if (!a) return false;
  return a.classList?.contains('bubble') || a.classList?.contains('bubble-action')
    || !!a.closest?.('.bubble-kickoff-actions, .bubble-choices');
}
function leaveBubbleFocus()    { chatBubbleIdx = -1; paintBubbleFocus(); }
/* Move focus across the action icons (retry / edit / copy …) inside the
 * currently-focused chat bubble. Shared by keyboard and gamepad. */
function cycleBubbleAction(dir) {
  const bubble = chatBubbles[chatBubbleIdx];
  if (!bubble) return;
  // Retry/edit icons on user bubbles, plus the kickoff Approve/Reject buttons.
  const arr = [...bubble.querySelectorAll('.bubble-action, .bubble-kickoff-actions button, .bubble-choices button, .bubble-choices:not(.memorial) .choice-btn')];
  if (arr.length === 0) return;
  const idx = arr.indexOf(document.activeElement);
  if (idx === -1) {                       // on the bubble itself → step into the actions
    playSfx('navigate');                  // cursor moved into the bubble's actions
    (dir > 0 ? arr[0] : arr[arr.length - 1]).focus();
    paintBubbleFocus();                   // drop the bubble's selected ring
    return;
  }
  const next = idx + dir;
  if (next < 0) { playSfx('navigate'); bubble.focus(); return; }  // Left off the first → back to the prompt
  if (next >= arr.length) return;                // Right off the last → stay put (no move)
  playSfx('navigate');                    // cursor moved to the next/prev action
  arr[next].focus();
  paintBubbleFocus();
}

async function retryBubble(i) {
  const m = chatMessages[i];
  if (!m || m.role !== 'user') return;
  const text = String(m.content || '').replace(/^\[team-voice\]\s*/, '').trim();
  if (!text) return;
  const agent = currentAgent();
  if (!agent) return;
  leaveBubbleFocus();
  // Optimistically delete the old response (and anything after) from the chat
  // right away, so the previous answer is gone before the new "…" / reply
  // populates — the prompt bubble stays put.
  const _chat = chatScrollEl();
  const _promptEl = _chat?.querySelector(`.bubble[data-idx="${i}"]`);
  if (_promptEl) {
    let n = _promptEl.nextElementSibling;
    while (n) { const next = n.nextElementSibling; n.remove(); n = next; }
  }
  // Remove this prompt and the agent's response (and anything after) so redo
  // regenerates a fresh answer rather than appending a duplicate exchange.
  try {
    await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history/truncate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: i }),
    });
  } catch { /* fall through — submitIntent still resubmits */ }
  // Escalate sampling per consecutive redo of the same prompt (temperature +
  // reasoning effort climb) so each retry pushes for a better/different answer.
  if (_redoStreak.text === text) _redoStreak.n += 1;
  else _redoStreak = { text, n: 1 };
  submitIntent(text, _redoStreak.n);   // re-appends the prompt + a fresh, escalated response
}

/* ---------- Confirm-cancel modal ----------
 * Shown when the user tries to abandon a flow that has unsaved
 * selections / input. Single shared modal: callers pass a callback
 * to run on Yes. Esc / No just dismisses. */
const confirmCancelModalEl = document.getElementById('confirm-cancel-modal');
const confirmCancelYesEl   = document.getElementById('confirm-cancel-yes');
const confirmCancelNoEl    = document.getElementById('confirm-cancel-no');
let confirmCancelOpen = false;
let confirmCancelPending = null; // function to run on Yes

function maybeConfirmCancel(hasUnsaved, onCancel) {
  if (!hasUnsaved) { onCancel(); return; }
  confirmCancelPending = onCancel;
  confirmCancelOpen = true;
  confirmCancelModalEl.hidden = false;
  playSfx('notification');   // a confirmation modal appeared
  setTimeout(() => confirmCancelNoEl.focus(), 0);
}

function closeConfirmCancel() {
  confirmCancelModalEl.hidden = true;
  confirmCancelOpen = false;
  confirmCancelPending = null;
}

confirmCancelNoEl?.addEventListener('click', () => { playSfx('select'); closeConfirmCancel(); });
confirmCancelYesEl?.addEventListener('click', () => {
  playSfx('select');
  const fn = confirmCancelPending;
  closeConfirmCancel();
  if (fn) fn();
});
confirmCancelModalEl?.addEventListener('keydown', (e) => {
  if (!confirmCancelOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConfirmCancel(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
    playSfx('navigate');   // moved between Yes / No
    (document.activeElement === confirmCancelYesEl ? confirmCancelNoEl : confirmCancelYesEl)?.focus();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    (document.activeElement === confirmCancelYesEl ? confirmCancelYesEl : confirmCancelNoEl).click();
  }
});

/* ---------- Edit-bubble modal ---------- */
const editBubbleModalEl   = document.getElementById('edit-bubble-modal');
const editBubbleTextEl    = document.getElementById('edit-bubble-text');
const editBubbleDictateEl = document.getElementById('edit-bubble-dictate');
const editBubbleCancelEl  = document.getElementById('edit-bubble-cancel');
const editBubbleSaveEl    = document.getElementById('edit-bubble-save');
let editBubbleOpen = false;
let editBubbleTargetIdx = -1;

function openEditBubbleModal(i) {
  const m = chatMessages[i];
  if (!m || m.role !== 'user') return;
  editBubbleTargetIdx = i;
  editBubbleTextEl.value = String(m.content || '').replace(/^\[team-voice\]\s*/, '');
  editBubbleModalEl.hidden = false;
  editBubbleOpen = true;
  setTimeout(() => editBubbleTextEl.focus(), 0);
}

function closeEditBubbleModal() {
  if (editDictating) endEditDictate();
  editBubbleModalEl.hidden = true;
  editBubbleOpen = false;
  editBubbleTargetIdx = -1;
}

/* "Hold to dictate": while held, the button plays a mic-wave (its label hides)
 * and the textarea's text is hidden behind a centered "…" animation. On
 * release we stop recording; the transcript drops into the textarea. */
let editDictating = false;
function startEditDictate() {
  if (!editBubbleOpen || editDictating) return;
  editDictating = true;
  editBubbleDictateEl?.classList.add('dictating');
  editBubbleTextEl?.closest('.edit-bubble-textwrap')?.classList.add('dictating');
  startPTT();
}
function endEditDictate() {
  if (!editDictating) return;
  editDictating = false;
  editBubbleDictateEl?.classList.remove('dictating');
  editBubbleTextEl?.closest('.edit-bubble-textwrap')?.classList.remove('dictating');
  endPTT();
}
function toggleEditDictate() { editDictating ? endEditDictate() : startEditDictate(); }

function commitEditBubble() {
  const t = editBubbleTextEl.value.trim();
  if (!t) { closeEditBubbleModal(); return; }
  closeEditBubbleModal();
  leaveBubbleFocus();
  submitIntent(t);
}

// Releasing Enter/Space stops hold-to-dictate (keyboard hold).
editBubbleModalEl?.addEventListener('keyup', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && editDictating) { e.preventDefault(); endEditDictate(); }
});
editBubbleCancelEl?.addEventListener('click', () => closeEditBubbleModal());
editBubbleSaveEl?.addEventListener('click', () => commitEditBubble());
// Hold-to-dictate: press-and-hold with the pointer; a synthetic click (from a
// mouse tap) is harmless since it has no handler. Keyboard/gamepad toggle it
// via their own handlers below.
editBubbleDictateEl?.addEventListener('pointerdown', (e) => { e.preventDefault(); startEditDictate(); });
editBubbleDictateEl?.addEventListener('pointerup',   () => endEditDictate());
editBubbleDictateEl?.addEventListener('pointercancel', () => endEditDictate());
editBubbleDictateEl?.addEventListener('pointerleave', () => { if (editDictating) endEditDictate(); });
/* Focusables inside the edit-bubble modal, in visual order. Same
 * keyboard / d-pad model as the settings modal. */
function editBubbleFocusables() {
  // Visual order: textarea → [Cancel] (far left) → [Dictate] [Save and run] (right group).
  const items = [];
  if (editBubbleTextEl)    items.push(editBubbleTextEl);
  if (editBubbleCancelEl)  items.push(editBubbleCancelEl);
  if (editBubbleDictateEl) items.push(editBubbleDictateEl);
  if (editBubbleSaveEl)    items.push(editBubbleSaveEl);
  return items;
}
function stepEditBubbleFocus(delta) {
  const items = editBubbleFocusables();
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement);
  const next = (i < 0 ? 0 : (i + delta + items.length) % items.length);
  items[next].focus();
}

editBubbleModalEl?.addEventListener('keydown', (e) => {
  if (!editBubbleOpen) return;
  const active = document.activeElement;
  const inTextarea = active === editBubbleTextEl;

  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation(); closeEditBubbleModal();
    return;
  }
  // Cmd/Ctrl+Enter from anywhere commits.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); e.stopPropagation(); commitEditBubble();
    return;
  }
  // Enter on a button activates that button; the textarea passes
  // bare Enter through so the user can type newlines normally.
  if ((e.key === 'Enter' || e.key === ' ') && !inTextarea && active === editBubbleDictateEl) {
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) startEditDictate();   // hold to dictate; keyup (below) stops it
    return;
  }
  if (e.key === 'Enter' && !inTextarea && active && active.tagName === 'BUTTON') {
    e.preventDefault(); e.stopPropagation(); active.click();
    return;
  }
  // Down / Right / Up / Left walks the focus list. Inside the
  // textarea, only let arrow keys move focus when the cursor is
  // at the corresponding edge — otherwise let the textarea handle
  // them as cursor movement.
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    if (inTextarea) {
      const atEnd = editBubbleTextEl.selectionStart === editBubbleTextEl.value.length;
      if (e.key === 'ArrowDown' && !atEnd) return; // let textarea move cursor
      if (e.key === 'ArrowRight' && !atEnd) return;
    }
    e.preventDefault(); e.stopPropagation();
    stepEditBubbleFocus(+1);
    return;
  }
  if (e.key === 'ArrowUp') {
    // Up from any button jumps straight to the text box above. In the
    // textarea it's a normal cursor move (the textarea is the topmost element).
    if (inTextarea) return;
    e.preventDefault(); e.stopPropagation();
    editBubbleTextEl?.focus();
    return;
  }
  if (e.key === 'ArrowLeft') {
    if (inTextarea) {
      const atStart = editBubbleTextEl.selectionStart === 0;
      if (!atStart) return;
    }
    e.preventDefault(); e.stopPropagation();
    stepEditBubbleFocus(-1);
    return;
  }
});

/* Gamepad inside the edit-bubble modal. Mirrors the settings modal
 * gamepad model. */
function handleEditBubbleGamepad(button) {
  const active = document.activeElement;
  if (button === 'circle') { closeEditBubbleModal(); return; }
  if (button === 'cross') {
    if (active === editBubbleCancelEl) { closeEditBubbleModal(); return; }
    if (active === editBubbleSaveEl)   { commitEditBubble();    return; }
    if (active === editBubbleDictateEl) { startEditDictate();   return; }  // hold to dictate (release stops, below)
    if (active && active.tagName === 'BUTTON') { active.click(); return; }
    // Default cross when textarea is focused: commit.
    commitEditBubble();
    return;
  }
  if (button === 'up') {
    if (active !== editBubbleTextEl) editBubbleTextEl?.focus();  // any button → text box above
    return;
  }
  if (button === 'left')   { stepEditBubbleFocus(-1); return; }
  if (button === 'down' || button === 'right') { stepEditBubbleFocus(+1); return; }
}

function _setL2Shortcuts() {
  setShortcuts([
    { gamepad: 'r2',      keyboard: 'V', label: 'Hold to talk', hold: { start: startPTT, end: endPTT } },
    effortChipItem(),
    {                     keyboard: '/', label: 'Type prompt',  action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'l1',      keyboard: '[', label: 'Prev agent',   action: () => cycleAgent(-1) },
    { gamepad: 'r1',      keyboard: ']', label: 'Next agent',   action: () => cycleAgent(+1) },
    {                     gamepad: 'triangle', keyboard: 'A', label: 'Activity', keepFocus: true, action: () => toggleActivityDrawer() },
    { gamepad: 'square', keyboard: 'E', label: 'Explorer',     action: () => toggleFileExplorer() },
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back',       action: () => pressCircle() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => pressCross() });
}

async function exitZoom() {
  releaseActiveRequest();   // navigate away without canceling the agent's run
  stopSpeaking();
  playSfx('zoomout');   // L2 → L1
  const fromAgentId = currentAgent()?.id;
  popZoomRect();
  await backZoomWithSnapshot(
    () => {
      if (!fromAgentId) return null;
      const tile = surfaceEl.querySelector(`[data-agent-id="${fromAgentId}"]`);
      return tile?.getBoundingClientRect() || null;
    },
    () => {
      mode = MODE_GRID;
      renderGrid();
    }
  );
}

/* ───────────────────────── Council ─────────────────────────
 * L1 → the PM gathers a little context (intake), then three models answer one
 * at a time, BLIND and SEQUENTIAL (no model sees another), then a chairman
 * synthesizes. Backend: POST /council/intake, /council/member, /council/synthesis.
 * Members set in Settings → Models. State machine lives in `councilState`. */
let councilState = null;   // { phase, question, questions, idx, answers, models, members }

function councilModelLabel(id) {
  if (!id) return 'Model';
  const tail = String(id).split('/').pop();
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function councilCrumbs() {
  // Match the agent L2 breadcrumb — trail back to the project; the header shows "Council".
  setBreadcrumbs([{ label: 'Projects' }, { label: sentenceCase(activeProject.name) }]);
}


/* The council reuses the agent L2 chrome — the .agent-view container + chat
 * bubbles — so it looks and feels like talking to an agent. councilShell builds
 * that container with a "Council" header and returns the scrollable body. */
function councilShell(status) {
  mode = MODE_COUNCIL;
  // Reuse the ENTIRE agent L2 experience: data-mode="zoom" applies all the
  // agent-view CSS (transparent surface, header dissolve, chat masks), and we
  // add the same surface close button. Keybinds key off the JS `mode`
  // (MODE_COUNCIL), and nothing in JS reads body.dataset.mode, so this is safe.
  document.body.dataset.mode = 'zoom';
  councilCrumbs();
  document.documentElement.style.setProperty('--agent-color', getProjectColor(activeProject));
  surfaceEl.innerHTML = '';
  const view = document.createElement('section');
  view.className = 'agent-view council-view';
  view.innerHTML = `
    <div class="agent-header">
      <div class="agent-title">
        <span class="name-large">Council</span>
        <span class="role-large">Advisory Team</span>
        <span class="agent-status">${escapeHtml(status || '')}</span>
      </div>
    </div>
    <div class="chat-scroll council-body"></div>
    <div class="agent-view-hint">
      <span class="for-gamepad">Hold <kbd>R2</kbd> to talk</span>
      <span class="for-keyboard">Hold <kbd>V</kbd> to talk</span>
    </div>`;
  surfaceEl.appendChild(view);
  surfaceEl.appendChild(createSurfaceCloseButton(() => exitCouncilToGrid()));
  return view.querySelector('.council-body');
}

/* Leave the council back to the team grid — mirrors exitZoom (sound + render). */
function exitCouncilToGrid() { playSfx('zoomout'); renderGrid(); }

/* The council footer mirrors an agent's L2 footer — you ask by talking or
 * typing, exactly like any other agent. Back returns to the team grid. */
function councilFooterShortcuts() {
  renderActionBar([]);
  setShortcuts([
    { gamepad: 'r2', keyboard: 'V', label: 'Hold to talk', hold: { start: startPTT, end: endPTT } },
    { keyboard: '/', label: 'Type prompt', action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'triangle', keyboard: 'A', label: 'Activity', keepFocus: true, action: () => toggleActivityDrawer() },
    { gamepad: 'square', keyboard: 'E', label: 'Explorer', action: () => toggleFileExplorer() },
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => exitCouncilToGrid() },
  ]);
  setPrimaryShortcut(null);
}

/* A chat bubble matching the agent view. kind: 'user' | 'agent'. */
function councilBubble({ kind, author = '', role = '', html = '', id = '', cls = '' }) {
  const authorHtml = author
    ? `<div class="bubble-author"><span class="bubble-author-name">${escapeHtml(author)}</span>` +
      (role ? `<span class="bubble-author-role">${escapeHtml(role)}</span>` : '') + `</div>`
    : '';
  return `<div class="bubble ${kind}${author ? ' foreign' : ''}${cls ? ' ' + cls : ''}"${id ? ` id="${id}"` : ''}>` +
    `${authorHtml}<div class="bubble-content">${html}</div></div>`;
}

function councilQuestionBubble(q) { return councilBubble({ kind: 'user', html: escapeHtml(q) }); }


async function openCouncil() {
  if (!activeProject) return;
  const pid = activeProject.id;
  councilState = { phase: 'prompt' };
  // Open like any agent on L2 (talk or "/" to ask), with a default bubble that
  // explains how the council works — no status/mode notification for it. The
  // conversation replaces this greeting once the user asks.
  const body = councilShell('');
  body.innerHTML = councilBubble({ kind: 'agent', author: 'Council', role: 'Advisory Team',
    html: 'Ask a question and I’ll convene three models on it. The PM gathers a little context first, then each model answers independently — none sees the others — and a chair synthesizes one clear recommendation.' });
  registerNavBubbles(body);
  councilFooterShortcuts();
  // Restore a prior council conversation for this project (prompt + decisions +
  // answers), so leaving and re-entering doesn't lose the work.
  try {
    const r = await fetch(`/projects/${pid}/council`);
    const { council } = await r.json();
    // Bail if the user navigated away (or switched project) during the fetch.
    if (council && council.question && mode === MODE_COUNCIL && activeProject?.id === pid) {
      councilState = council;
      renderCouncilRestore(council);
    }
  } catch { /* best-effort restore */ }
}

/* Persist the live council state so it survives leaving the view. Fire-and-
 * forget — a failed save never blocks the conversation. */
function persistCouncil() {
  if (!activeProject || !councilState || councilState.phase === 'prompt') return;
  fetch(`/projects/${activeProject.id}/council`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: councilState }),
  }).catch(() => {});
}

/* Re-render a restored council conversation at whatever phase it left off. */
function renderCouncilRestore(st) {
  if (st.synthesis || st.phase === 'done') { renderCouncilDone(st); return; }
  if (st.phase === 'intake' && Array.isArray(st.questions) && st.idx < st.questions.length) { renderCouncilIntake(); return; }
  // Mid-deliberation (no synthesis yet) → resume from the saved question+answers.
  runCouncilDeliberation();
}

/* Rebuild the finished council view (prompt → members → synthesis) statically
 * from saved state — no re-fetching. */
function renderCouncilDone(st) {
  const body = councilShell('');
  const members = [0, 1, 2].map((i) => {
    const m = (st.members || [])[i];
    const label = m?.model ? councilModelLabel(m.model) : `Member ${i + 1}`;
    const content = m?.content ? renderMarkdown(m.content)
      : `<p class="council-err">${escapeHtml(m?.error || 'No response')}</p>`;
    return councilBubble({ kind: 'agent', author: label, role: 'council member', html: content });
  }).join('');
  const synth = st.synthesis
    ? councilBubble({ kind: 'agent', author: 'Chairman',
        role: `synthesis · ${escapeHtml(councilModelLabel(st.synthesis.model))}`,
        html: st.synthesis.content ? renderMarkdown(st.synthesis.content)
          : `<p class="council-err">${escapeHtml(st.synthesis.error || 'No synthesis.')}</p>` })
    : '';
  body.innerHTML = councilQuestionBubble(st.question) + members + synth;
  try { attachCodeCopyHandlers(body); } catch {}
  registerNavBubbles(body);
  councilFooterShortcuts();
}

/* "Thinking" state while the PM prepares intake questions — a PM bubble. */
function renderCouncilThinking(question, label) {
  const body = councilShell('Reviewing…');
  body.innerHTML = councilQuestionBubble(question) +
    councilBubble({ kind: 'agent', author: 'Project Manager', role: 'reviewing',
      html: `<div class="typing-dots"><span></span><span></span><span></span></div>` +
            `<p class="council-think-label">${escapeHtml(label)}</p>` });
  registerNavBubbles(body);
  councilFooterShortcuts();
}

/* Step 1 — PM intake. Ask the server for clarifying questions; if there are
 * none (question already clear, or intake failed) go straight to deliberation. */
async function startCouncilIntake(question) {
  councilState = { phase: 'loading', question, questions: [], idx: 0, answers: [], models: [], members: [] };
  renderCouncilThinking(question, 'The PM is reviewing your question…');
  try {
    const r = await fetch('/council/intake', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    councilState.questions = Array.isArray(data.questions) ? data.questions : [];
    councilState.models = Array.isArray(data.models) ? data.models : [];
  } catch (err) {
    // Intake is best-effort — never block the council on it.
    console.warn('[council] intake failed:', err?.message || err);
    councilState.questions = [];
  }
  if (councilState.questions.length) { councilState.phase = 'intake'; persistCouncil(); renderCouncilIntake(); }
  else runCouncilDeliberation();
}

/* One clarifying question at a time, rendered with the EXACT agent question
 * component (buildChoiceList): lettered .choice-btn options, multi-select +
 * Submit, "Other — hold to talk", and Skip — wired to council handlers. The
 * bubble joins the nav ring, so it's selectable and arrow-navigable like any
 * agent bubble. */
function renderCouncilIntake() {
  const st = councilState;
  const cur = st.questions[st.idx];
  const body = councilShell('Gathering context');
  body.innerHTML = councilQuestionBubble(st.question) +
    councilBubble({ kind: 'agent', author: 'Project Manager', role: `question ${st.idx + 1} of ${st.questions.length}`,
      html: `<p class="council-intake-q">${escapeHtml(cur.q)}</p>` });
  const contentEl = body.querySelector('.bubble:last-child .bubble-content');
  if (contentEl) {
    contentEl.appendChild(buildChoiceList(cur.options, null, undefined, true, {
      onSubmit: (picked) => answerCouncilIntake(picked.join('; ')),
      onSkip:   () => answerCouncilIntake(null),
    }));
  }
  registerNavBubbles(body);
  councilFooterShortcuts();
}

/* Record an answer (or skip when null), advance; deliberate after the last. */
function answerCouncilIntake(value) {
  const st = councilState;
  const cur = st.questions[st.idx];
  if (value != null && String(value).trim()) st.answers.push({ q: cur.q, a: String(value).trim() });
  st.idx += 1;
  persistCouncil();   // retain the decision across leaving the view
  if (st.idx < st.questions.length) renderCouncilIntake();
  else runCouncilDeliberation();
}

/* Step 2 + 3 — members answer one at a time (blind), then the chair synthesizes.
 * Each is a chat bubble in the council body, just like an agent's reply. */
function councilMemberSlot(i, label) {
  return councilBubble({ kind: 'agent', author: label, role: 'council member', id: `council-member-${i}`, cls: 'pending',
    html: `<div class="typing-dots"><span></span><span></span><span></span></div>` });
}

function renderCouncilDeliberation() {
  const st = councilState;
  st.phase = 'deliberation';
  const body = councilShell('Deliberating…');
  body.innerHTML = councilQuestionBubble(st.question) +
    [0, 1, 2].map((i) => councilMemberSlot(i, st.models[i] ? councilModelLabel(st.models[i]) : `Member ${i + 1}`)).join('');
  registerNavBubbles(body);
  councilFooterShortcuts();
}

function updateCouncilMember(i, m) {
  const el = document.getElementById(`council-member-${i}`);
  if (!el) return;
  el.classList.remove('pending');
  const label = m.model ? councilModelLabel(m.model) : `Member ${i + 1}`;
  el.innerHTML =
    `<div class="bubble-author"><span class="bubble-author-name">${escapeHtml(label)}</span><span class="bubble-author-role">council member</span></div>` +
    `<div class="bubble-content">${m.content ? renderMarkdown(m.content)
      : `<p class="council-err">${escapeHtml(m.error || 'No response')}</p>`}</div>`;
  try { attachCodeCopyHandlers(el); } catch {}
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* Append/fill the chair's synthesis bubble (created on demand so an empty
 * [hidden] bubble never shows — the .bubble display would defeat [hidden]). */
function setCouncilSynth(data, busy) {
  const bodyEl = surfaceEl.querySelector('.council-body');
  if (!bodyEl) return;
  let el = document.getElementById('council-synth');
  if (!el) { el = document.createElement('div'); el.id = 'council-synth'; el.className = 'bubble agent foreign'; bodyEl.appendChild(el); registerNavBubbles(bodyEl); }
  if (busy) {
    el.innerHTML = `<div class="bubble-author"><span class="bubble-author-name">Chairman</span><span class="bubble-author-role">synthesizing…</span></div>` +
      `<div class="bubble-content"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  } else if (data && data.content) {
    el.innerHTML = `<div class="bubble-author"><span class="bubble-author-name">Chairman</span><span class="bubble-author-role">synthesis · ${escapeHtml(councilModelLabel(data.model))}</span></div>` +
      `<div class="bubble-content">${renderMarkdown(data.content)}</div>`;
    try { attachCodeCopyHandlers(el); } catch {}
  } else {
    el.innerHTML = `<div class="bubble-author"><span class="bubble-author-name">Chairman</span></div>` +
      `<div class="bubble-content"><p class="council-err">${escapeHtml((data && data.error) || 'No synthesis.')}</p></div>`;
  }
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function runCouncilDeliberation() {
  const st = councilState;
  st.members = [];
  st.phase = 'deliberation';
  persistCouncil();
  renderCouncilDeliberation();
  // Sequential: each member's bubble fills in turn — never all at once. Each
  // call is blind (server sends only the question + PM context, no peer answers).
  for (let i = 0; i < 3; i++) {
    let member;
    try {
      const r = await fetch('/council/member', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: st.question, answers: st.answers, index: i }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      member = data;
    } catch (err) {
      member = { model: st.models[i] || null, content: '', error: String(err.message || err) };
    }
    st.members[i] = member;
    updateCouncilMember(i, member);
    persistCouncil();
  }
  setCouncilSynth(null, true);
  try {
    const r = await fetch('/council/synthesis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: st.question, answers: st.answers, members: st.members, projectId: activeProject?.id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    st.synthesis = data;
    setCouncilSynth(data, false);
  } catch (err) {
    st.synthesis = { content: '', error: String(err.message || err) };
    setCouncilSynth(st.synthesis, false);
  }
  st.phase = 'done';
  persistCouncil();
  councilFooterShortcuts();   // ask again just by talking / typing, like any agent
}

/** Slide to the next / previous project from L1 (project detail). */
function cycleProject(delta) {
  if (mode !== MODE_GRID || !activeProject) return;
  if (fileViewerOpen) return;   // project switching is disabled while the md viewer is open
  // Only one project — nothing to switch to: rubberband to say so.
  if (projects.length < 2) { bumpEdge(surfaceEl, delta > 0 ? 'right' : 'left'); return; }
  const curIdx = projects.findIndex(p => p.id === activeProject.id);
  const nextIdx = curIdx + delta;
  // No wrap-around — rubberband at the first / last project.
  if (nextIdx < 0 || nextIdx >= projects.length) { bumpEdge(surfaceEl, delta > 0 ? 'right' : 'left'); return; }
  releaseActiveRequest();   // navigate away without canceling the agent's run
  stopSpeaking();
  playSfx(delta > 0 ? 'swooshNext' : 'swooshPrev');   // project → project slide
  slideAgent(delta, () => {
    activeProject = withLeadFirst(projects[nextIdx]);
    gridIndex = 0;
    zoomedIndex = 0;
    renderGrid();
    if (fileExplorerOpen) refreshFileExplorer();   // show the new project's files (defined below)
  });
  // slideAgent's doSwap rebuilt the footer rail synchronously, eating the
  // keydown's chip flash — re-light the pressed [ / ] chip on the fresh rail.
  flashShortcutByKey(delta > 0 ? ']' : '[');
  flashShortcutByGamepad(delta > 0 ? 'r1' : 'l1');
}

/* Jump straight to a specific agent's L2 chat (used by handoff bubbles). */
function openAgentById(agentId) {
  if (!activeProject) return;
  const i = activeProject.agents.findIndex(a => a.id === agentId);
  if (i < 0 || i === zoomedIndex) return;
  releaseActiveRequest();   // navigate away without canceling the agent's run
  stopSpeaking();
  _focusLastOnNextChatRender = true;   // land on the target agent's last bubble
  slideAgent(i > zoomedIndex ? 1 : -1, () => { zoomedIndex = i; renderZoom(); });
}

function cycleAgent(delta) {
  if (mode !== MODE_ZOOM || !activeProject) return;
  if (fileViewerOpen) return;   // agent switching is disabled while the md viewer is open
  const n = activeProject.agents.length;
  // Step in the requested direction to the next ENABLED agent — no wrap-around.
  let i = zoomedIndex + delta;
  while (i >= 0 && i < n && !activeProject.agents[i].enabled) i += delta;
  // Ran off the end (no further agent that way) — rubberband instead of cycling.
  if (i < 0 || i >= n) { bumpEdge(surfaceEl, delta > 0 ? 'right' : 'left'); return; }
  releaseActiveRequest();   // navigate away without canceling the agent's run
  stopSpeaking();
  playSfx(delta > 0 ? 'swooshNext' : 'swooshPrev');   // agent → agent slide
  _focusLastOnNextChatRender = true;   // switched to another agent → focus its last bubble
  slideAgent(delta, () => { zoomedIndex = i; renderZoom(); });
  // The slide rebuilt the footer rail synchronously — re-light the [ / ] chip.
  flashShortcutByKey(delta > 0 ? ']' : '[');
  flashShortcutByGamepad(delta > 0 ? 'r1' : 'l1');
}

/** Cross-fade slide between two agent screens at L2. The outgoing
 *  view is cloned as a fixed overlay that slides off; the new view
 *  slides in from the opposite side. */
function slideAgent(delta, doSwap) {
  const r = surfaceEl.getBoundingClientRect();
  const cs = getComputedStyle(surfaceEl);
  const overlay = surfaceEl.cloneNode(true);
  overlay.removeAttribute('id');
  // The #id is removed so the #surface CSS rule (flex column, padding,
  // bg, border) no longer applies. Re-apply the relevant chrome inline
  // so the cloned children lay out exactly like the original.
  Object.assign(overlay.style, {
    position: 'fixed',
    left: `${r.left}px`, top: `${r.top}px`,
    width: `${r.width}px`, height: `${r.height}px`,
    margin: '0', pointerEvents: 'none', zIndex: '50',
    display: 'flex',
    flexDirection: 'column',
    padding: cs.padding,
    background: cs.background,
    border: cs.border,
    borderRadius: cs.borderRadius,
    overflow: 'hidden',
    boxSizing: cs.boxSizing,
  });
  document.body.appendChild(overlay);
  doSwap();
  const dir = delta > 0 ? 1 : -1;
  const off = `${-dir * 100}%`;
  const inFrom = `${dir * 100}%`;
  overlay.animate(
    [{ transform: 'translateX(0)', opacity: 1 },
     { transform: `translateX(${off})`, opacity: 0 }],
    { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
  ).finished.then(() => overlay.remove()).catch(() => overlay.remove());
  surfaceEl.animate(
    [{ transform: `translateX(${inFrom})`, opacity: 0 },
     { transform: 'translateX(0)',         opacity: 1 }],
    { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
}

/* ---------- Action execution ---------- */
async function executeAction(action, sourceSpec) {
  if (!action) return;
  const type = action.action?.type || action.type;
  if (type === '_grid_open')   { enterZoom(); return; }
  if (type === '_grid_back')   { exitToProjects(); return; }
  if (type === '_grid_toggle_enabled') { toggleFocusedAgentEnabled(); return; }

  const agent = currentAgent();
  if (!agent || !activeProject) return;
  if (type === 'cancel') { exitZoom(); return; }

  if (type === 'approve_kickoff') {
    setIndicator('thinking', 'Starting kickoff…');
    try {
      const r = await fetch(`/projects/${activeProject.id}/kickoff/approve`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      // Reflect the new kickoff state locally so the plan's Approve action
      // stops surfacing once we re-render the lead's L2.
      if (activeProject.kickoff) activeProject.kickoff.status = 'running';
      setIndicator('idle', 'Connected');
      const chat = chatScrollEl();
      if (chat) await renderChatHistory(chat, agent);
      // The chat re-render replaces the action bar; clear the now-stale
      // kickoff Approve/Revise affordances.
      renderActionBar([]);
      ring.set([]);
      _setL2Shortcuts();
    } catch (err) {
      setIndicator('error', 'Kickoff failed');
      console.error('[kickoff] approve failed:', err);
    }
    return;
  }

  if (type === 'save_note') {
    const body = sourceSpec?.body || agent.lastSpec?.body;
    if (!body) return;
    setIndicator('thinking', 'Saving…');
    try {
      const r = await fetch(`/projects/${activeProject.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) throw new Error(await r.text());
      const summary = body.length > 60 ? body.slice(0, 60) + '…' : body;
      const ack = {
        intent: 'answer', template: 'reader',
        context: 'Note saved', title: 'Saved',
        body: `Saved your note: ${summary}`,
        actions: [{ verb: 'Done', glyph: 'circle', action: { type: 'cancel' } }],
      };
      agent.lastSpec = ack;
      setIndicator('idle', 'Connected');
      renderZoom(ack);
    } catch (err) {
      setIndicator('error', 'Save failed');
      console.error(err);
    }
    return;
  }

  if (type === 'open_note') {
    const focused = ring.current();
    const id = focused?.dataset?.id;
    if (!id) return;
    try {
      const r = await fetch(`/projects/${activeProject.id}/notes/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(await r.text());
      const { body } = await r.json();
      renderZoom({
        intent: 'answer', template: 'reader',
        context: 'Note', title: id.replace(/T/, ' ').slice(0, 16),
        body,
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      });
    } catch (err) { console.error(err); }
    return;
  }
  console.warn('[action] unknown type:', type, action);
}

/* ---------- PTT + intent submission ---------- */
const PTT_MODES = new Set([MODE_PROJECTS, MODE_ZOOM, MODE_COUNCIL, MODE_NEW_PROJ_NAME, MODE_NEW_PROJ_GOAL, MODE_NEW_PROJ_FEATURES]);

/* Voice capture always uses local STT via MediaRecorder -> /transcribe.
 * When the sidecar is unavailable we surface an error instead of
 * switching engines. */
let localSttUrl = '';
let localRecorder = null;
let localRecChunks = [];
let _partialBusy = false;   // one in-flight live-partial transcription at a time

(async function _initLocalStt() {
  try {
    const r = await fetch('/settings');
    if (r.ok) { const s = await r.json(); localSttUrl = s.LOCAL_STT_URL || ''; }
  } catch {}
  // Local Parakeet is the only engine. Probe sidecar reachability so the user
  // gets a clear hint when it is still loading or not running yet.
  // Voice ALWAYS uses the local Parakeet sidecar — never the browser speech
  // engine. localSttUrl stays set (the server defaults LOCAL_STT_URL on); if
  // Parakeet is unavailable we surface an error rather than switching engines.
  // Probe once just to hint when the sidecar isn't up yet.
  if (localSttUrl) {
    let ready = false;
    for (let i = 0; i < 4 && !ready; i++) {
      try { ready = (await (await fetch('/stt-health')).json()).available; } catch {}
      if (!ready) await new Promise(res => setTimeout(res, 700));
    }
    if (!ready) setIndicator('error', 'Parakeet STT not running — start it with: npm run stt');
  }
})();

// On release we keep capturing for a short tail so the last word isn't clipped.
const VOICE_TAIL_MS = 200;
let _pttTailTimer = null;

function startPTT() {
  if (pttActive) return;
  // Re-pressed within the release tail — cancel the pending stop and keep the
  // same capture running rather than starting a fresh one.
  if (_pttTailTimer) {
    clearTimeout(_pttTailTimer); _pttTailTimer = null;
    pttActive = true;
    setPttHeld(true);
    return;
  }
  if (!editBubbleOpen && !PTT_MODES.has(mode)) return;
  pttActive = true;
  // Drop any footer-rail selection while holding to talk. Otherwise the
  // focused chip — "Hold to talk" is index 0, so it's the default — keeps
  // its `.sc.focused` ring for the entire hold and reads as a stuck
  // "selected" state until release. The post-utterance re-render rebuilds
  // the rail and resets focus anyway, so clearing it here is safe.
  if (isShortcutsFocused()) leaveShortcuts();
  setPttHeld(true); // light the PTT control (V cap / R2 icon) for the whole hold
  stopSpeaking();
  showPendingBubble();  // optimistic "you" bubble with a "…" animation
  if (localSttUrl) {
    // Local STT path — MediaRecorder → /transcribe proxy → text.
    startLocalRecording();
    return;
  }
  if (!speech.supported) {
    setIndicator('error', 'Speech not supported — press / to type');
    typedWrap.hidden = false;
    typedInput.focus();
    pttActive = false;
    setPttHeld(false);
    return;
  }
  setIndicator('listening', 'Listening…');
  speech.start();
}

function endPTT() {
  if (!pttActive) return;
  pttActive = false;
  setPttHeld(false);
  // Defer the actual stop by a short tail so trailing speech still lands. A
  // re-press within the window cancels this (see startPTT) and keeps recording.
  if (_pttTailTimer) clearTimeout(_pttTailTimer);
  _pttTailTimer = setTimeout(() => {
    _pttTailTimer = null;
    if (localRecorder) { stopLocalRecording(); return; }
    if (speech.supported) speech.stop();
  }, VOICE_TAIL_MS);
}

/* Toggle the "held" highlight on the push-to-talk control so it stays lit for
 * the duration of the hold (not just a press flash). Targets the "Hold to talk"
 * chip's V keycap and R2 icon; whichever is visible for the current input mode
 * shows. Hidden/absent glyphs are harmlessly no-ops. */
function setPttHeld(on) {
  // Dictation started from the on-screen "Other" button shouldn't light the footer
  // shortcut reference (V / R2 keycaps) or the footer Hold-to-talk chip — the user
  // is holding the on-screen control, not pressing the keyboard/gamepad shortcut.
  // Only the Other button's own wave reacts. footer always clears on release.
  const footerOn = on && !_otherDictateBtn;
  document.querySelectorAll('.glyph.for-gamepad[data-glyph="r2"]')
    .forEach(g => g.classList.toggle('held', footerOn));
  document.querySelectorAll('.glyph.for-keyboard')
    .forEach(g => { if (g.textContent.trim() === 'V') g.classList.toggle('held', footerOn); });
  // Swap the Hold-to-talk label for a live mic visualizer while holding.
  const chips = document.querySelectorAll('.sc.ptt-chip');
  chips.forEach(c => c.classList.toggle('talking', footerOn));
  // An "Other" choice button — pointer-held, or focused while holding V/R2 —
  // plays the same mic-reactive wave inside itself (its label hides).
  const otherBtn = _otherDictateBtn ||
    (document.activeElement?.classList?.contains('choice-other') ? document.activeElement : null);
  if (otherBtn) otherBtn.classList.toggle('talking', on);
  // The chip visualizer drives both the footer chip bars and the Other-button
  // bars — start it whenever either is talking.
  if (on && (chips.length || otherBtn)) startChipMic(); else stopChipMic();
  // Capture screens (name/goal): show the live wave (and hide the "Hold V/R2
  // to talk" hint) only while holding; revert on release.
  const stack = document.querySelector('.capture-tile .mic-stack');
  if (stack) {
    stack.classList.toggle('talking', on);
    if (on) startMicVisualizer(); else stopMicVisualizer();
  }
}

/* ---------- Hold-to-talk chip mic visualizer ----------
 * A small, self-contained version of the capture-screen visualizer that lives
 * inside the "Hold to talk" footer chip while the user is holding to talk. */
const CHIP_BAR_COUNT = 9;
let chipViz = null;
let chipVizFrame = null;
let _chipLoud = 0;
async function startChipMic() {
  if (chipViz) { animateChipBars(); return; }
  let stream;
  try {
    stream = await acquireMicStream();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no AudioContext');
    const ac = new Ctx();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 64; an.smoothingTimeConstant = 0.6;
    src.connect(an);
    chipViz = { ac, an, stream, data: new Uint8Array(an.frequencyBinCount) };
    animateChipBars();
  } catch (err) {
    console.warn('[chip-mic] failed:', err.message);
    if (stream) releaseMicStream();
  }
}
function stopChipMic() {
  if (chipVizFrame) { cancelAnimationFrame(chipVizFrame); chipVizFrame = null; }
  if (chipViz) {
    try { chipViz.ac.close(); } catch {}
    chipViz = null;
    releaseMicStream();   // shared stream — release, don't stop tracks directly
  }
}
function animateChipBars() {
  if (!chipViz) return;
  // Drives the footer Hold-to-talk chip AND any "Other" choice button mid-hold.
  const bars = document.querySelectorAll('.sc.ptt-chip.talking .sc-mic .bar, .choice-other.talking .choice-other-wave i');
  if (bars.length === 0) { chipVizFrame = requestAnimationFrame(animateChipBars); return; }
  chipViz.an.getByteFrequencyData(chipViz.data);
  const usable = Math.min(chipViz.data.length, 16);
  let sum = 0; for (let i = 0; i < usable; i++) sum += chipViz.data[i];
  _chipLoud = _chipLoud * 0.78 + (sum / (usable * 255)) * 0.22;
  const t = performance.now() / 1000, SPEED = 2.5, BASE = 1, LOUD = 9, MID = 6;
  const step = (Math.PI * 2) / bars.length, amp = BASE + LOUD * _chipLoud;
  bars.forEach((b, i) => { b.style.height = `${Math.max(2, MID + Math.sin(t * SPEED + i * step) * amp)}px`; });
  chipVizFrame = requestAnimationFrame(animateChipBars);
}

async function startLocalRecording() {
  let stream;
  try {
    stream = await acquireMicStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    localRecorder = new MediaRecorder(stream, { mimeType: mime });
    localRecChunks = [];
    localRecorder.ondataavailable = (e) => {
      if (e.data?.size) localRecChunks.push(e.data);
      // Live partials: re-transcribe the audio captured so far so words appear
      // in the box as the user speaks (capture screens only). Best-effort; the
      // final transcribe on release (onstop) is authoritative.
      if (pttActive && localRecChunks.length &&
          (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL || mode === MODE_NEW_PROJ_FEATURES)) {
        postPartialTranscript(new Blob(localRecChunks, { type: mime }));
      }
    };
    localRecorder.onstop = async () => {
      releaseMicStream();   // shared stream — release our ref (don't stop tracks others may use)
      const blob = new Blob(localRecChunks, { type: mime });
      localRecorder = null;
      localRecChunks = [];
      await postLocalTranscript(blob);
    };
    localRecorder.start(450);   // timeslice → periodic dataavailable for live partials
    setIndicator('listening', 'Listening…');
  } catch (err) {
    if (stream) releaseMicStream();
    pttActive = false;
    setPttHeld(false);
    setIndicator('error', `Mic: ${err.message}`);
    setTimeout(() => setIndicator('idle', 'Connected'), 2000);
  }
}

function stopLocalRecording() {
  try { localRecorder?.stop(); } catch {}
}

/* Surface a speech-to-text failure both on the global status indicator AND,
 * when a capture screen is open, in its mic area — so a Parakeet failure is
 * clearly visible right where the user is trying to speak. */
function showSttFailure(msg) {
  setIndicator('error', msg);
  const label = document.querySelector('.capture-tile .mic-label');
  if (label) { label.textContent = msg; label.classList.add('mic-error'); }
  const pend = document.querySelector('.capture-tile .mic-live-text');
  if (pend) pend.classList.add('mic-error');
}

/* Re-transcribe the audio captured so far and show it live in the capture
 * screen's text slot (Parakeet has no native partials). Best-effort: errors
 * are ignored, and only one runs at a time so requests don't pile up. The
 * authoritative final transcript still comes from postLocalTranscript. */
async function postPartialTranscript(blob) {
  if (_partialBusy) return;
  _partialBusy = true;
  try {
    const r = await fetch('/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (!r.ok) return;
    const data = await r.json().catch(() => ({}));
    let text = (data?.text || '').trim();
    if (mode === MODE_NEW_PROJ_NAME) text = stripNamePunct(text);   // name carries no punctuation
    const live = document.querySelector('.capture-tile .mic-live-text');
    if (live && text) live.textContent = text;
  } catch { /* partial is best-effort */ }
  finally { _partialBusy = false; }
}

/* Decode the recorded clip and report whether it's essentially silent — no
 * sample ever reaches speech level. Uses PEAK amplitude (not RMS): a single
 * real word spikes the peak even within a long mostly-quiet hold, while a
 * silent hold stays flat. Conservative threshold so real (even quiet) speech is
 * never dropped; fails OPEN (returns false) if the clip can't be decoded. */
async function isProbablySilent(blob) {
  try {
    if (!blob || blob.size === 0) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    const buf = await blob.arrayBuffer();
    const ac = new Ctx();
    try {
      const audio = await ac.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i += 8) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      return peak < 0.02;   // ≈ -34 dBFS; speech peaks well above, silence well below
    } finally { try { ac.close(); } catch {} }
  } catch { return false; }
}

async function postLocalTranscript(blob) {
  setIndicator('thinking', 'Transcribing…');
  try {
    const r = await fetch('/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Local STT failed (sidecar down or couldn't decode). We never switch to
      // the browser engine — show one clean message (the raw upstream/ffmpeg
      // output is logged below, not shown to the user).
      console.warn('[stt] transcribe failed:', r.status, data?.error || '');
      clearPendingBubble();
      showSttFailure('Cannot connect to speech to text model');
      return;
    }
    const text = (data?.text || '').trim();
    setIndicator('idle', 'Connected');
    if (!text) { clearPendingBubble(); setIndicator('idle', 'No speech detected'); setTimeout(() => setIndicator('idle', 'Connected'), 1500); return; }
    // Parakeet (like Whisper-family models) can hallucinate a short filler —
    // "Yeah.", "you", "Thank you" — from a silent hold. Those are non-empty, so
    // gate on the actual captured audio: if it never reached speech level, drop
    // the phantom transcript instead of submitting it.
    if (await isProbablySilent(blob)) {
      clearPendingBubble(); setIndicator('idle', 'No speech detected'); setTimeout(() => setIndicator('idle', 'Connected'), 1500); return;
    }
    // Hand off to the same routes Speech 'end' uses so the rest of
    // the app behaves identically to the browser-STT flow.
    dispatchTranscript(text);
  } catch (err) {
    // Don't fall back to the browser engine — keep using Parakeet.
    console.warn('[stt] transcribe unreachable:', err?.message || err);
    clearPendingBubble();
    showSttFailure('Cannot connect to speech to text model');
    setTimeout(() => setIndicator('idle', 'Connected'), 2000);
  }
}

/* Same logic as the Speech 'end' listener — extracted so both paths
 * route the final transcript through one handler. */
/* Project names carry no punctuation — STT tends to add a trailing "." and
 * commas. Keep letters, numbers, spaces (collapse runs). The objective keeps
 * its punctuation. */
function stripNamePunct(s) {
  return String(s).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/* Project names display in Title Case (e.g. "My Stock Trading Mobile App").
 * Uppercase the first letter of each word; leave the rest as entered so typed
 * acronyms (REST, API) are preserved. */
function titleCaseName(s) {
  return String(s).replace(/\b\p{L}/gu, c => c.toUpperCase());
}

/* After a capture screen re-renders with freshly-recognized text, reveal it with
 * the same gradual typewriter build-up the agent bubbles use. */
function revealCaptureText() {
  const cv = surfaceEl.querySelector('.capture-tile .capture-value.has-value');
  if (!cv) return;
  // Multi-block fields (objective/features) reveal just the newest block; the
  // single-value name field reveals the whole thing.
  typewriterReveal(cv.querySelector('.capture-block:last-of-type') || cv);
}
function dispatchTranscript(text) {
  if (editBubbleOpen) { editBubbleTextEl.value = text; return; }
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = titleCaseName(stripNamePunct(text)); renderNewProjectName(); revealCaptureText(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = appendCaptureBlock(newProjGoal, text); renderNewProjectGoal(); revealCaptureText(); return; }
  if (mode === MODE_NEW_PROJ_FEATURES) { newProjFeatures = appendCaptureBlock(newProjFeatures, text); renderNewProjectFeatures(); revealCaptureText(); return; }
  if (mode === MODE_COUNCIL) { routeCouncilInput(text); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
  if (mode === MODE_PROJECTS) { dispatchHomeUtterance(text); return; }
}

speech.addEventListener('partial', (e) => {
  if (e.detail) setIndicator('listening', `“${e.detail}”`);
  updatePendingBubble(e.detail);  // live word-by-word transcript in the chat bubble
  // Mirror the live transcript into the capture screen's mic-stack so
  // the user sees their words above the visualizer.
  const liveEl = document.querySelector('.capture-tile .mic-live-text');
  if (liveEl) liveEl.textContent = e.detail || '';
  // Enable the primary action button as soon as any text is recognized.
  const doneEl = document.getElementById('capture-done');
  if (doneEl && e.detail && e.detail.trim()) doneEl.disabled = false;
  // Keep the backing state var in sync with the live transcript so the
  // Continue gate (confirmCapture) sees the same value the user sees — even
  // when the recognizer never emits a final result before 'end' fires.
  if (e.detail && e.detail.trim()) {
    if (mode === MODE_NEW_PROJ_NAME) newProjName = titleCaseName(e.detail.trim());
    else if (mode === MODE_NEW_PROJ_GOAL) newProjGoal = e.detail.trim();
    else if (mode === MODE_NEW_PROJ_FEATURES) newProjFeatures = e.detail.trim();
  }
});
speech.addEventListener('end', (e) => {
  // SpeechRecognition stopped (browser closed the session). Clear the
  // pttActive flag so the next screen / button press can re-trigger
  // recognition cleanly — otherwise startPTT() short-circuits.
  pttActive = false;
  setPttHeld(false);
  const text = e.detail;
  if (!text) {
    clearPendingBubble();
    setIndicator('idle', 'No speech detected');
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
    return;
  }
  if (editBubbleOpen) {
    editBubbleTextEl.value = text;
    setIndicator('idle', 'Connected');
    return;
  }
  if (mode === MODE_NEW_PROJ_NAME) {
    newProjName = titleCaseName(stripNamePunct(text));
    renderNewProjectName();
    setIndicator('idle', 'Connected');
    return;
  }
  if (mode === MODE_NEW_PROJ_GOAL) {
    newProjGoal = text;
    renderNewProjectGoal();
    setIndicator('idle', 'Connected');
    return;
  }
  if (mode === MODE_NEW_PROJ_FEATURES) {
    newProjFeatures = text;
    renderNewProjectFeatures();
    setIndicator('idle', 'Connected');
    return;
  }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
  if (mode === MODE_PROJECTS) { dispatchHomeUtterance(text); return; }
});
speech.addEventListener('error', (e) => {
  pttActive = false;
  setPttHeld(false);
  clearPendingBubble();
  setIndicator('error', `Speech error: ${e.detail}`);
  setTimeout(() => setIndicator('idle', 'Connected'), 2000);
});

/* ---------- v2 SSE event subscriber ----------
 * Single long-lived connection to GET /events. Every server-side
 * event (status, activity, delegate, …) lands here; specific
 * handlers update local state and the DOM. The connection
 * auto-reconnects if the server restarts. */
let _evtSource = null;
/* A reloaded (or reconnected) renderer has an empty status map, so an agent
 * mid-turn looked idle and the L2 "…" bubble vanished. Pull the server's live
 * snapshot and resync EVERY agent of the active project — including clearing
 * stale busy flags after a server restart (empty snapshot = nobody working). */
async function rehydrateAgentStatuses() {
  if (!activeProject) return;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/status`);
    if (!r.ok) return;
    const { statuses } = await r.json();
    for (const a of activeProject.agents) {
      const verb = (statuses && statuses[a.id]) || 'idle';
      agentStatus[a.id] = verb;
      agentBusy[a.id] = (verb !== 'idle');
      paintAgentStatus(a.id);
    }
    paintProjectStatuses();
    const cur = currentAgent();
    if (mode === MODE_ZOOM && !inflightController && cur && agentBusy[cur.id]) showPendingAgentBubble();
  } catch { /* snapshot is best-effort; live SSE events still apply */ }
}
function startEventStream() {
  if (_evtSource) try { _evtSource.close(); } catch {}
  try {
    _evtSource = new EventSource('/events');
    _evtSource.onopen = () => { rehydrateAgentStatuses(); };
    _evtSource.addEventListener('bridge', (e) => {
      try { handleBridgeEvent(JSON.parse(e.data)); } catch {}
    });
    _evtSource.onerror = () => {
      // EventSource reconnects automatically; just log noisily.
      console.warn('[events] stream error — reconnecting');
    };
  } catch (err) {
    console.warn('[events] failed to start stream:', err);
  }
}

/* Live token streaming into the agent view. submitIntent sets the expected
 * agent; the first token lazily creates a bubble; renderZoom (after the reply
 * resolves) re-renders the chat from history and supersedes it. */
let streamingAgentId = null;
let streamingBubbleEl = null;
let streamingText = '';
let _streamedAgentTurn = false;   // set when the latest reply streamed → skip the typewriter for it
function resetStreaming() { streamingAgentId = null; streamingBubbleEl = null; streamingText = ''; }
function appendStreamToken(agentId, delta) {
  if (!streamingAgentId || agentId !== streamingAgentId) return;
  if (mode !== MODE_ZOOM || currentAgent()?.id !== agentId) return;
  const chat = surfaceEl.querySelector('.chat-scroll');
  if (!chat) return;
  _streamedAgentTurn = true;   // this reply is streaming live — don't also typewriter it
  if (!streamingBubbleEl) {
    let c;
    if (pendingAgentBubbleEl && chat.contains(pendingAgentBubbleEl)) {
      // Reuse the "…" bubble: swap dots for streamed text (seamless).
      const b = pendingAgentBubbleEl;
      pendingAgentBubbleEl = null;
      b.classList.remove('pending');
      b.classList.add('streaming');
      b.querySelector('.bubble-action.stop')?.remove();   // Stop is for the "…" wait only
      c = b.querySelector('.bubble-content');
      c.textContent = '';
    } else {
      const b = document.createElement('div');
      b.className = 'bubble agent streaming';
      c = document.createElement('div');
      c.className = 'bubble-content';
      b.appendChild(c);
      chat.appendChild(b);
    }
    streamingBubbleEl = c;
  }
  streamingText += delta;
  streamingBubbleEl.textContent = streamingText;   // plain while streaming; renderZoom finalizes as markdown
  const prev = chat.style.scrollBehavior;
  chat.style.scrollBehavior = 'auto';
  chat.scrollTop = chat.scrollHeight;
  chat.style.scrollBehavior = prev;
}

function handleBridgeEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'status': {
      if (!ev.agentId) return;
      agentStatus[ev.agentId] = ev.verb || 'idle';
      agentBusy[ev.agentId] = (ev.verb && ev.verb !== 'idle');
      paintAgentStatus(ev.agentId);
      paintProjectStatuses();   // L0 tile "Working" rollup follows agent verbs
      // Reflect a server-initiated work cycle (e.g. PM kickoff) in the open L2:
      // show the "…" thinking bubble while it works, pull the new turn in when
      // it finishes. Skipped while a client request owns the view (submitIntent
      // drives that case itself).
      if (mode === MODE_ZOOM && !inflightController && currentAgent()?.id === ev.agentId) {
        if (agentBusy[ev.agentId]) showPendingAgentBubble();
        else maybeRefreshZoomFor(ev.agentId);
      }
      break;
    }
    case 'token': {
      if (ev.agentId && ev.delta) appendStreamToken(ev.agentId, ev.delta);
      break;
    }
    // Other event types are unused at the moment but kept here so
    // future features (activity feed, notifications, delegate lines)
    // can hook in without touching the subscriber wiring.
    case 'activity':
    case 'delegate': {
      // Capture every event into the global buffer. The L1/L2 feed
      // filters by activeProject at render time; the L0 cross-project
      // feed shows everything.
      pushActivityEntry(ev);
      // Backfill (replayed on connect) only feeds the Activity panel — skip the
      // live side effects below so a reconnect doesn't resurrect stale pending
      // states, re-scroll the chat, etc.
      if (ev.backfill) break;
      // Set the agent's L1 pending state from the event's awaitKind:
      //   'reply' → "Waiting for response", 'view' → "Task complete",
      //   anything else → clear. (delegate/assignment carries no awaitKind.)
      if (ev.type === 'activity' && ev.agentId) setAgentPending(ev.agentId, ev.awaitKind || null);
      else if (ev.type === 'delegate' && ev.toAgentId) setAgentPending(ev.toAgentId, ev.awaitKind || null);
      paintProjectStatuses();   // L0 tile "Attention required" rollup follows pending replies
      // A server-posted turn (kickoff plan / question) for the agent we're
      // viewing → pull it into the open chat and clear the "…" bubble.
      if (ev.type === 'activity' && ev.agentId) maybeRefreshZoomFor(ev.agentId);
      break;
    }
    case 'note_added':
    case 'file_removed':
    case 'file_created': {
      // File explorer is per-project — only refresh when the event
      // matches the active project. Memory is global (L0) — refresh
      // any time a note lands.
      if (activeProject && ev.projectId === activeProject.id &&
          fileExplorerOpen) {
        refreshFileExplorer();
      }
      if (memoryDrawerOpen && (ev.type === 'note_added' || ev.kind === 'note')) {
        loadMemoryNotes();
      }
      break;
    }
    case 'team_changed': {
      // The PM auto-added teammates during kickoff — pull the new roster in so
      // the L1 grid shows the fresh tiles.
      if (activeProject && ev.projectId === activeProject.id) reloadActiveProject();
      break;
    }
    case 'notification':
    case 'token':
    case 'tool':
    default:
      break;
  }
}

/* Re-fetch projects and refresh the active one in place (used when the server
 * changes the team, e.g. kickoff auto-adds a specialist). Re-renders the grid
 * so new agent tiles appear without losing the user's place. */
async function reloadActiveProject() {
  if (!activeProject) return;
  const id = activeProject.id;
  await loadProjects();
  const fresh = projects.find(p => p.id === id);
  if (!fresh) return;
  activeProject = withLeadFirst(fresh);
  if (mode === MODE_GRID) renderGrid();
}

/* Refetch /projects/:pid/files and re-render entries while keeping
 * the explorer's current focus index. Used when the server tells us
 * a new file landed under the project. */
async function refreshFileExplorer() {
  if (!activeProject) return;
  try {
    const r = await fetch(`/projects/${activeProject.id}/files`);
    if (!r.ok) return;
    fileTree = await r.json();
    rebuildFileEntries();
    if (explorerFocused) paintFileFocus();
  } catch (err) {
    console.warn('[explorer] refresh failed:', err);
  }
}

function pushActivityEntry(ev) {
  // Dedupe by server id so backfill replays on reconnect don't double-add.
  if (ev.id != null && allActivity.some(e => e.id === ev.id)) return;
  const entry = {
    id: ev.id,
    at: ev.at || Date.now(),
    projectId: ev.projectId,
    kind: ev.type, // 'activity' | 'delegate'
  };
  if (ev.type === 'activity') {
    entry.text = ev.summary || '';
    entry.agentId = ev.agentId;
  } else if (ev.type === 'delegate') {
    const from = agentNameForProjectAgent(ev.projectId, ev.fromAgentId);
    const to   = agentNameForProjectAgent(ev.projectId, ev.toAgentId);
    const task = (ev.task || '').slice(0, 140);
    entry.text = `${from} → ${to}${task ? ': ' + task : ''}`;
    entry.fromAgentId = ev.fromAgentId;
    entry.toAgentId = ev.toAgentId;
  }
  if (!entry.text) return;
  allActivity.unshift(entry);
  if (allActivity.length > ACTIVITY_LIMIT) allActivity.length = ACTIVITY_LIMIT;
  if (activityDrawerOpen) repaintActivityList();
}

/* Resolve an agent's display name across projects. For the L1/L2
 * feed activeProject covers it; for the L0 cross-project feed we
 * may need a different project's roster. */
function agentNameForProjectAgent(projectId, agentId) {
  if (!agentId) return '';
  if (activeProject && activeProject.id === projectId) {
    const a = activeProject.agents.find(x => x.id === agentId);
    if (a) return a.name;
  }
  const p = projects.find(x => x.id === projectId);
  const a = p?.agents?.find(x => x.id === agentId);
  return a?.name || agentId;
}
function agentNameFromId(agentId) {
  if (!activeProject || !agentId) return agentId || '';
  const a = activeProject.agents.find(x => x.id === agentId);
  return a?.name || agentId;
}

function toggleActivityDrawer() {
  // Allowed at L0 (cross-project feed) and inside a project (L1/L2 /
  // add-agent). Disabled during the new-project create flow.
  if (mode === MODE_NEW_PROJ_ROLES ||
      mode === MODE_NEW_PROJ_NAME ||
      mode === MODE_NEW_PROJ_GOAL ||
      mode === MODE_NEW_PROJ_FEATURES) return;
  if (activityDrawerOpen) { closeActivityDrawer(); return; }
  openActivityDrawer();
}
function openActivityDrawer() {
  const el = document.getElementById('activity-drawer');
  if (!el) return;
  syncExplorerHeights();
  el.hidden = false;
  activityDrawerOpen = true;
  document.body.dataset.activityDrawer = 'open';
  // Mutually exclusive with the other left drawers.
  if (fileExplorerOpen) closeFileExplorer();
  if (memoryDrawerOpen) closeMemoryDrawer();
  // Activity is always the cross-project feed now, anywhere (L0/L1/L2).
  const headerEl = el.querySelector('header span');
  if (headerEl) headerEl.textContent = 'Activity';
  repaintActivityList();
  // Pressing the A key / ▲ button lands focus on the newest (top) entry so the
  // feed is immediately navigable. But activating the A *chip* from the footer
  // rail (which sets _pendingFooterKey) keeps focus on the chip instead — same
  // rule as the Explorer chip.
  if (_pendingFooterKey == null) enterActivityFromSurface('first');
}
function closeActivityDrawer() {
  const el = document.getElementById('activity-drawer');
  if (!el) return;
  el.hidden = true;
  activityDrawerOpen = false;
  activityFocused = false;
  document.body.dataset.activityDrawer = 'closed';
}

// ── Activity feed keyboard/gamepad navigation (view-only) ────────────────────
let activityFocused = false;       // true while keyboard nav is inside the feed
let activityFocusIdx = 0;
let activityEntries = [];          // entry rows, in display order (newest first)
function paintActivityFocus() {
  activityEntries.forEach((el, i) => el.classList.toggle('focused', i === activityFocusIdx));
  activityEntries[activityFocusIdx]?.scrollIntoView({ block: 'nearest' });
}
/* Step the activity cursor by ±1, clamped, nav sound on an actual move. */
function stepActivityFocus(delta) {
  if (!activityEntries.length) return;
  const prev = activityFocusIdx;
  activityFocusIdx = Math.max(0, Math.min(activityEntries.length - 1, activityFocusIdx + delta));
  if (activityFocusIdx !== prev) playSfx('navigate');
  paintActivityFocus();
}
/* Move focus from the main surface INTO the feed (Left at the grid's left edge,
 * or opening via A / ▲). Entries are newest-first, so 'first' = newest (top).
 * View-only: Up/Down highlight, no open. Returns false if nothing to focus. */
function enterActivityFromSurface(which = 'first') {
  if (!activityDrawerOpen || !activityEntries.length) return false;
  if (isShortcutsFocused()) leaveShortcuts();   // came from the A footer chip
  activityFocused = true;
  ring.items?.forEach?.(el => el.classList.remove('focused'));
  activityFocusIdx = which === 'last' ? activityEntries.length - 1 : 0;
  paintActivityFocus();
  return true;
}
/* Exit the feed back to the main surface (Right / Esc-less). */
function exitActivityRight() {
  activityFocused = false;
  activityEntries.forEach(el => el.classList.remove('focused'));
  ring.paint();
}
function repaintActivityList() {
  const list = document.querySelector('#activity-drawer .activity-list');
  if (!list) return;
  list.innerHTML = '';
  activityEntries = [];
  // On L0 (the projects landing) show the cross-project feed with a
  // project-name crumb; inside a project filter to it. Keyed on mode, not
  // just activeProject — that record lingers after backing out to L0.
  // Always the cross-project feed (every agent, every project), regardless of
  // where the drawer is opened: agent responses, grouped project → agent · role
  // → summary, most-recent first.
  const crossProject = true;
  // Agent responses (activity with an agent) AND task delegations (PM → agent).
  const entries = allActivity.filter(e => (e.kind === 'activity' && e.agentId) || e.kind === 'delegate');
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = 'No activity yet.';
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `activity-entry activity-${entry.kind}`;
    // View-only feed: entries are not interactive (no focus / click / open).
    row.dataset.projectId = entry.projectId || '';
    const meta = document.createElement('div');
    meta.className = 'activity-meta';
    meta.textContent = relativeTime(entry.at);

    if (crossProject) {
      // View-only: no click / keyboard open — the feed is for glancing only.
      const proj = projects.find(p => p.id === entry.projectId);
      let authorText = '';
      let summary = String(entry.text || '');
      if (entry.kind === 'delegate') {
        // "<PM> → <agent> · <role>" with the task as the summary.
        const toAgent = proj?.agents?.find(a => a.id === entry.toAgentId);
        const fromName = agentNameForProjectAgent(entry.projectId, entry.fromAgentId);
        const toName = toAgent?.name || agentNameForProjectAgent(entry.projectId, entry.toAgentId);
        const toRole = toAgent ? roleLabel(toAgent.role) : '';
        authorText = `${fromName} → ${toName}${toRole ? ` · ${toRole}` : ''}`;
        // entry.text is "From → To: task" — keep just the task for the summary.
        const ci = summary.indexOf(':');
        if (ci >= 0) summary = summary.slice(ci + 1).trim();
      } else {
        const agent = proj?.agents?.find(a => a.id === entry.agentId);
        const agentName = agent?.name || agentNameForProjectAgent(entry.projectId, entry.agentId);
        const role = agent ? roleLabel(agent.role) : '';
        authorText = agentName + (role ? ` · ${role}` : '');
        // Strip a leading "<Name>: " prefix — the name is shown separately.
        if (agentName && summary.startsWith(agentName)) {
          summary = summary.slice(agentName.length).replace(/^\s*[:\-–—]\s*/, '');
        }
        // Drop a leading role tag the author line already shows — the full role
        // label or a short acronym like "PM:" / "QA:".
        if (role && summary.toLowerCase().startsWith(role.toLowerCase())) {
          summary = summary.slice(role.length).replace(/^\s*[:\-–—]\s*/, '');
        }
        summary = summary.replace(/^\s*[A-Z]{2,4}\s*[:\-–—]\s*/, '');
      }

      const projEl = document.createElement('div');
      projEl.className = 'activity-project-head';
      projEl.textContent = proj?.name || 'Project';
      const authorEl = document.createElement('div');
      authorEl.className = 'activity-author';
      authorEl.textContent = authorText;
      const sumEl = document.createElement('div');
      sumEl.className = 'activity-summary';
      sumEl.textContent = sentenceCase(summary);
      row.append(projEl, authorEl, sumEl, meta);
    } else {
      const line = document.createElement('div');
      line.className = 'activity-line';
      line.textContent = sentenceCase(entry.text);
      row.append(line, meta);
    }
    list.appendChild(row);
    activityEntries.push(row);
  }
  // Keep the highlight valid across live re-renders while the feed is focused.
  activityFocusIdx = Math.min(activityFocusIdx, Math.max(0, activityEntries.length - 1));
  if (activityFocused) paintActivityFocus();
}

/* Cross-project feed entry → open the target project. If the entry
 * names an agent, drill into L2 as well. */
async function openProjectFromActivityEntry(entry) {
  const idx = projects.findIndex(p => p.id === entry.projectId);
  if (idx < 0) return;
  closeActivityDrawer();
  // Focus the matching project tile and open it via the same morph
  // path a click does.
  pickerIndex = idx;
  ring.index = idx;
  ring.paint();
  await openFocused();
  // Once at L1, if the event named an agent, also enter L2.
  if (entry.agentId && activeProject) {
    const aIdx = activeProject.agents.findIndex(a => a.id === entry.agentId);
    if (aIdx >= 0) {
      gridIndex = aIdx;
      ring.set(surfaceEl.querySelectorAll('.agent-tile'));
      ring.index = aIdx;
      await enterZoom();
    }
  }
}

/* Live-update an individual agent tile's status label + busy state. The pending
 * states ("Waiting for response" / "Task complete") show only while idle —
 * during drafting/analyzing the work verb wins. */
/** The human label for an agent's current state — shared by the L1 tile and the
 * L2 header. A pending question ("reply") wins over the idle verb so an agent
 * awaiting the user never reads as idle. */
function agentStatusLabel(agentId) {
  const verb = agentStatus[agentId] || (agentBusy[agentId] ? 'drafting' : 'idle');
  const pending = verb === 'idle' ? agentPending.get(agentId) : null;
  if (pending === 'reply') return 'Waiting for your response';
  if (pending === 'view')  return 'Task complete';
  return verb !== 'idle' ? verbLabel(verb) : '';
}

function paintAgentStatus(agentId) {
  // L2 header (when this agent is the one being viewed) — keep its status line
  // in sync with live SSE updates, so a handoff's pending question shows here too.
  if (mode === MODE_ZOOM && currentAgent()?.id === agentId) {
    const sEl = surfaceEl.querySelector('.agent-view .agent-status');
    if (sEl) {
      const waiting = (agentStatus[agentId] || 'idle') === 'idle' && agentPending.get(agentId) === 'reply';
      sEl.textContent = agentStatusLabel(agentId);
      sEl.dataset.await = waiting ? 'reply' : '';
    }
  }
  const tile = document.querySelector(`.agent-tile[data-agent-id="${agentId}"]`);
  if (!tile) return;
  const verb = agentStatus[agentId] || 'idle';
  const pending = verb === 'idle' ? agentPending.get(agentId) : null;
  tile.dataset.status = verb;
  tile.dataset.busy = (verb !== 'idle') ? 'true' : 'false';
  tile.dataset.unseen = pending === 'reply' ? 'true' : 'false';
  tile.dataset.complete = pending === 'view' ? 'true' : 'false';
  const verbEl = tile.querySelector('.status .status-verb');
  if (verbEl) verbEl.textContent =
    pending === 'reply' ? 'Waiting for response' :
    pending === 'view'  ? 'Task complete' : verbLabel(verb);
}

// Kick the SSE channel off once the renderer is ready.
startEventStream();

/* v2 — TTS lifecycle: stamp data-speaking on the currently-talking
 * agent's tile (visible on L1; also on the L2 surface). */
let _speakingAgentId = null;
function paintSpeaking(agentId) {
  // Clear any previous speaker.
  if (_speakingAgentId) {
    const prev = document.querySelector(`.agent-tile[data-agent-id="${_speakingAgentId}"]`);
    prev?.removeAttribute('data-speaking');
  }
  _speakingAgentId = agentId || null;
  document.body.dataset.speaking = agentId ? 'true' : 'idle';
  if (agentId) {
    const tile = document.querySelector(`.agent-tile[data-agent-id="${agentId}"]`);
    if (tile) tile.dataset.speaking = 'true';
  }
}
speechBus.addEventListener('start', (e) => paintSpeaking(e.detail?.agentId || null));
speechBus.addEventListener('end',   ()  => paintSpeaking(null));

/* ---------- v2 §6 — Notifications ----------
 *
 * Two independent surfaces wired off the same SSE channel:
 *   - notificationStore: durable, lives in the menu
 *   - showNotificationToast(): transient, top-right card
 *
 * Persistence is in sessionStorage so a refresh keeps the unread count
 * but it's intentionally not durable across browser restarts. */
const NOTIF_LIMIT = 200;
const NOTIF_KEY   = 'bridge:notifications';
const TOAST_AUTO_MS_DEFAULT = 4200;

let notifications = (function loadNotifs() {
  try { return JSON.parse(sessionStorage.getItem(NOTIF_KEY) || '[]'); }
  catch { return []; }
})();

function saveNotifs() {
  try { sessionStorage.setItem(NOTIF_KEY, JSON.stringify(notifications.slice(0, NOTIF_LIMIT))); }
  catch {}
}

function addNotification(n) {
  const entry = {
    id: n.id || `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    at: n.at || Date.now(),
    kind: n.kind || 'info',
    title: String(n.title || '').slice(0, 200),
    body: String(n.body || '').slice(0, 600),
    actionable: !!n.actionable,
    requiresApproval: !!n.requiresApproval,
    unread: true,
    projectId: n.projectId || null,
    agentId: n.agentId || null,
  };
  notifications.unshift(entry);
  if (notifications.length > NOTIF_LIMIT) notifications.length = NOTIF_LIMIT;
  saveNotifs();
  paintNotificationBadge();
  showNotificationToast(entry);
  if (!document.getElementById('notification-menu').hidden) repaintNotificationMenu();
  return entry;
}

function paintNotificationBadge() {
  const btn = document.getElementById('notification-btn');
  if (!btn) return;
  const badge = btn.querySelector('.notification-count');
  if (!badge) return;
  const unread = notifications.filter(n => n.unread).length;
  if (unread > 0) { badge.hidden = false; badge.textContent = unread > 99 ? '99+' : String(unread); }
  else            { badge.hidden = true;  badge.textContent = '0'; }
}

function showNotificationToast(entry) {
  const stack = document.getElementById('notification-toast-stack');
  if (!stack) return;
  const card = document.createElement('div');
  card.className = 'notif-toast';
  card.dataset.id = entry.id;
  const title = document.createElement('div');
  title.className = 'notif-title';
  title.textContent = entry.title;
  card.appendChild(title);
  if (entry.body) {
    const body = document.createElement('div');
    body.className = 'notif-body';
    body.textContent = entry.body;
    card.appendChild(body);
  }
  if (entry.requiresApproval) {
    const actions = document.createElement('div');
    actions.className = 'notif-actions';
    const yes = document.createElement('button');
    yes.className = 'notif-primary'; yes.textContent = 'Approve';
    yes.addEventListener('click', () => { resolveApproval(entry, true);  removeToast(card); });
    const no = document.createElement('button');
    no.textContent = 'Dismiss';
    no.addEventListener('click', () => { resolveApproval(entry, false); removeToast(card); });
    actions.append(yes, no);
    card.appendChild(actions);
  }
  card.addEventListener('click', () => { if (!entry.requiresApproval) removeToast(card); });
  stack.appendChild(card);
  // Auto-dismiss informational toasts; approval-required toasts stay
  // until the user clicks Approve / Dismiss.
  if (!entry.requiresApproval) {
    setTimeout(() => removeToast(card), TOAST_AUTO_MS_DEFAULT);
  }
}
function removeToast(card) {
  if (!card || card.classList.contains('leaving')) return;
  card.classList.add('leaving');
  setTimeout(() => card.remove(), 220);
}

function resolveApproval(entry, approved) {
  // Mark the entry as resolved + non-actionable so the menu shows the
  // outcome rather than the buttons.
  const i = notifications.findIndex(n => n.id === entry.id);
  if (i >= 0) {
    notifications[i] = {
      ...notifications[i],
      requiresApproval: false,
      unread: false,
      title: `${notifications[i].title} — ${approved ? 'Approved' : 'Dismissed'}`,
    };
    saveNotifs();
    paintNotificationBadge();
    if (!document.getElementById('notification-menu').hidden) repaintNotificationMenu();
  }
  // POST follow-up to the server once that endpoint exists.
}

function repaintNotificationMenu() {
  const list = document.getElementById('notification-menu-list');
  if (!list) return;
  list.innerHTML = '';
  if (notifications.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notification-empty';
    empty.textContent = 'No notifications.';
    list.appendChild(empty);
    return;
  }
  for (const n of notifications) {
    const row = document.createElement('div');
    row.className = 'notification-entry';
    row.dataset.id = n.id;
    row.tabIndex = 0; // keyboard / d-pad reachable
    const title = document.createElement('div');
    title.className = 'notif-title';
    title.textContent = n.title;
    const body  = document.createElement('div');
    body.className = 'notif-body';
    body.textContent = n.body;
    const time  = document.createElement('div');
    time.className = 'notif-time';
    time.textContent = formatBubbleTime(n.at) || '';
    row.append(title, body, time);
    if (n.requiresApproval) {
      const actions = document.createElement('div');
      actions.className = 'notif-actions';
      const yes = document.createElement('button');
      yes.className = 'notif-primary'; yes.textContent = 'Approve';
      yes.addEventListener('click', () => resolveApproval(n, true));
      const no  = document.createElement('button');
      no.textContent = 'Dismiss';
      no.addEventListener('click', () => resolveApproval(n, false));
      actions.append(yes, no);
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
}

let notificationsOpen = false;
function openNotificationMenu() {
  if (notificationsOpen) return;
  const btn  = document.getElementById('notification-btn');
  const menu = document.getElementById('notification-menu');
  if (!btn || !menu) return;
  notificationsOpen = true;
  menu.hidden = false;
  // Anchor the menu just above the bell icon. Re-measured every open
  // so it tracks the icon's actual position.
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 420;
  menu.style.right  = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 14}px`;
  repaintNotificationMenu();
  // Mark everything as read on open.
  notifications.forEach(n => { n.unread = false; });
  saveNotifs();
  paintNotificationBadge();
}
function closeNotificationMenu() {
  notificationsOpen = false;
  const menu = document.getElementById('notification-menu');
  if (menu) menu.hidden = true;
}
function toggleNotificationMenu() {
  if (notificationsOpen) closeNotificationMenu(); else openNotificationMenu();
}

/* Items focusable inside the notification menu, in visual order
 * (top → bottom of the floating panel). Used by the menu's own
 * keyboard handler. */
function notificationMenuItems() {
  const menu = document.getElementById('notification-menu');
  if (!menu) return [];
  // Notification entries first (visual top of the floating panel),
  // then Clear all in the header.
  const entries = [...menu.querySelectorAll('.notification-entry')];
  const clearBtn = document.getElementById('notification-clear');
  return [...entries, ...(clearBtn ? [clearBtn] : [])];
}

/* Focus first / last item, or step. Returns false when there's
 * nothing focusable (empty menu). */
function focusFirstNotifEntry() {
  const items = notificationMenuItems();
  if (items.length === 0) return false;
  items[0].focus();
  return true;
}
function focusLastNotifEntry() {
  const items = notificationMenuItems();
  if (items.length === 0) return false;
  items[items.length - 1].focus();
  return true;
}
function stepNotifEntry(delta) {
  const items = notificationMenuItems();
  if (items.length === 0) return false;
  playSfx('navigate');   // notification menu: stepping entries / back to the bell
  const idx = items.indexOf(document.activeElement);
  if (idx < 0) { items[0].focus(); return true; }
  const next = idx + delta;
  if (next < 0) {
    // Above the topmost entry → return focus to the bell icon.
    document.getElementById('notification-btn')?.focus();
    return true;
  }
  if (next >= items.length) {
    // Below the last item → also return focus to the bell.
    document.getElementById('notification-btn')?.focus();
    return true;
  }
  items[next].focus();
  return true;
}

/* Menu-scoped keyboard handler — bound on the floating panel itself
 * so it only fires while the menu is open and an entry holds focus. */
document.getElementById('notification-menu')?.addEventListener('keydown', (e) => {
  if (!notificationsOpen) return;
  const active = document.activeElement;
  const onEntry = active?.classList?.contains('notification-entry');
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeNotificationMenu();
    document.getElementById('notification-btn')?.focus();
    return;
  }
  if (e.key === 'ArrowUp')   { e.preventDefault(); e.stopPropagation(); stepNotifEntry(-1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); stepNotifEntry(+1); return; }
  // Left / Right cycle action buttons inside the focused entry.
  if (onEntry && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const btns = [...active.querySelectorAll('.notif-actions button')];
    if (btns.length === 0) return;
    e.preventDefault(); e.stopPropagation();
    btns[e.key === 'ArrowRight' ? 0 : btns.length - 1].focus();
    return;
  }
  if (e.key === 'Enter' && onEntry) {
    // Enter on an entry → click the primary action if one exists.
    const primary = active.querySelector('.notif-actions .notif-primary')
                 || active.querySelector('.notif-actions button');
    if (primary) { e.preventDefault(); e.stopPropagation(); primary.click(); }
    return;
  }
});
function clearAllNotifications() {
  notifications = [];
  saveNotifs();
  paintNotificationBadge();
  repaintNotificationMenu();
}

document.getElementById('notification-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotificationMenu();
  // Land focus on the first entry when opening (parity with the keyboard path),
  // so the next Cross/Enter acts on a notification rather than re-closing.
  if (notificationsOpen) setTimeout(() => focusFirstNotifEntry(), 0);
});
document.getElementById('notification-btn')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    toggleNotificationMenu();
    // Auto-walk focus into the menu so the user can immediately
    // step through entries with Up/Down.
    if (notificationsOpen) setTimeout(() => focusFirstNotifEntry(), 0);
  } else if (e.key === 'Escape' && notificationsOpen) {
    e.preventDefault(); e.stopPropagation();
    closeNotificationMenu();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && notificationsOpen) {
    // Step into the menu — Up lands on the topmost entry (visually
    // closest to where the user's eye is going), Down does the same
    // for symmetry.
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowUp') focusFirstNotifEntry();
    else                     focusLastNotifEntry();
  }
});
document.getElementById('notification-clear')?.addEventListener('click', (e) => {
  e.stopPropagation();
  clearAllNotifications();
});
// Click outside the menu closes it. Wait for the next click after open.
document.addEventListener('click', (e) => {
  if (!notificationsOpen) return;
  const menu = document.getElementById('notification-menu');
  const btn  = document.getElementById('notification-btn');
  if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) closeNotificationMenu();
});
window.addEventListener('keydown', (e) => {
  if (notificationsOpen && e.key === 'Escape') {
    e.preventDefault(); closeNotificationMenu();
  }
}, true);

// Paint the badge on load.
paintNotificationBadge();

/* ---------- L0 / shared helpers ---------- */
/* Option+arrows on L0: slide through projects in a carousel. The "+ New"
 * tile is the last stop in the cycle and pops to a centered "Create
 * project" card when it lands focus this way. */
function slideToAdjacentProject(delta) {
  const tiles = ring.elements;
  const n = tiles.length; // includes "+ New" as the last tile
  if (n === 0) return;
  const next = (ring.index + delta + n) % n;
  ring.index = next;
  pickerIndex = next;
  ring.paint();
  updatePickerShortcuts();

  const tile = tiles[next];
  if (!tile) return;
  const isCreate = tile.classList.contains('new-project');
  // Clear any prior carousel state on every tile
  for (const el of tiles) el.classList.remove('slide-from-left', 'slide-from-right', 'centered-create');
  if (isCreate) {
    tile.classList.add('centered-create');
  } else {
    void tile.offsetWidth; // reflow → animation restarts
    tile.classList.add(delta > 0 ? 'slide-from-right' : 'slide-from-left');
  }
}

// Any non-slide navigation (regular arrows, click, mode change) clears the
// centered-create overlay so the picker grid looks normal again.
function clearCenteredCreate() {
  for (const el of ring.elements) el.classList?.remove('centered-create');
}

/* Overscroll "rubberband" bounce on a container when the user tries to move
 * past the end of a list — signals "you've reached the end" instead of
 * silently wrapping around. */
function bumpEdge(el, dir, d = 16) {
  if (!el) return;
  const off = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[dir];
  if (!off) return;
  playSfx('bump');   // audible "you've hit the edge" cue
  el.animate(
    [
      { transform: 'translate(0,0)' },
      { transform: `translate(${off[0]}px, ${off[1]}px)` },
      { transform: 'translate(0,0)' },
    ],
    { duration: 300, easing: 'cubic-bezier(.34,1.56,.64,1)' }
  );
}

/* Step within a tile grid with HARD EDGES (no wrap-around):
 *  - Down off the last content row drops focus into the footer shortcuts rail.
 *  - Any other off-grid press rubberbands the container instead of wrapping.
 * Returns the new index, or null when the press was consumed (footer entry or
 * a rubberband) and the caller should not move. */
function stepGrid(grid, i, n, dir) {
  // Rows come from the LIVE tile count, not the layout template (_rows): an
  // overflowing L0 picker holds 3+ content rows in a 2-row-tall scrollport,
  // and Down must walk every row before dropping to the footer rail.
  const cols = grid._cols, rows = Math.ceil(n / cols) || grid._rows;
  const r = Math.floor(i / cols), c = i % cols;
  if (dir === 'down') {
    const below = (r + 1) * cols + c;
    if (r < rows - 1 && below < n) return below;   // a tile sits below → move
    // Cell directly below is empty but the next row still has tiles (last
    // column dropping into a short final row, e.g. → "Add / remove agent") →
    // land on that row's last tile rather than skipping to the footer.
    if (r < rows - 1 && (r + 1) * cols < n) return Math.min(n - 1, (r + 2) * cols - 1);
    if (enterShortcuts()) return null;             // nothing below → footer rail
    bumpEdge(grid, 'down'); return null;
  }
  if (dir === 'up') {
    // From the first row, jump to the × close button if the screen has one
    // (e.g. L1); otherwise (e.g. L0 home) do nothing — no rubberband.
    if (r === 0) { focusSurfaceClose(); return null; }
    return (r - 1) * cols + c;
  }
  // Left/Right traverse in reading order: off the end of a row flows to the
  // adjacent row; only the very first / last item rubberbands.
  if (dir === 'left') {
    if (i === 0) { bumpEdge(grid, 'left'); return null; }
    return i - 1;
  }
  if (dir === 'right') {
    if (i + 1 >= n) { bumpEdge(grid, 'right'); return null; }
    return i + 1;
  }
  return null;
}

function pickerMove(dir) {
  clearCenteredCreate();
  const grid = surfaceEl.querySelector('.project-picker');
  if (!grid) return;
  const next = stepGrid(grid, ring.index, ring.elements.length, dir);
  if (next == null) return;   // consumed by footer entry / rubberband
  playSfx('navigate');   // project → project (cursor move on L0 home grid)
  ring.index = next;
  pickerIndex = next;
  ring.paint();
  scrollPickerToRow(grid, next);
  updatePickerShortcuts();
}

/* Scroll the picker so the cursor's row is FULLY visible: the last row snaps
 * all the way to the bottom (block:'nearest' stopped at the scrollport edge,
 * leaving the row's bottom under the fade) and the first row snaps to the
 * very top; middle rows use nearest. */
function scrollPickerToRow(grid, index) {
  const cols = grid._cols || 4;
  const row = Math.floor(index / cols);
  const lastRow = Math.floor((ring.elements.length - 1) / cols);
  if (row === 0) grid.scrollTo({ top: 0, behavior: 'smooth' });
  else if (row === lastRow) grid.scrollTo({ top: grid.scrollHeight, behavior: 'smooth' });
  else ring.elements[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function exitToProjects() {
  releaseActiveRequest();   // navigate away without canceling the agent's run
  stopSpeaking();
  playSfx('zoomout');   // L1 → L0
  closeFileViewer();
  if (fileExplorerOpen) closeFileExplorer();
  if (memoryDrawerOpen) closeMemoryDrawer();
  if (activityDrawerOpen) closeActivityDrawer();
  // allActivity is intentionally NOT cleared — the L0 cross-project
  // feed accumulates across projects. Per-project filtering at render
  // time keeps L1/L2 scoped to the active project.
  const fromProjectId = activeProject?.id;
  popZoomRect(); // discard stale cached rect; we'll compute fresh
  await backZoomWithSnapshot(
    () => {
      // After renderProjects(), find the matching tile in the freshly
      // laid-out picker and target its actual rect.
      if (!fromProjectId) return null;
      const tile = surfaceEl.querySelector(`[data-project-id="${fromProjectId}"]`);
      return tile?.getBoundingClientRect() || null;
    },
    () => {
      activeProject = null;
      renderProjects();
    }
  );
}
async function toggleFocusedAgentEnabled() {
  if (mode !== MODE_GRID || !activeProject) return;
  const agent = activeProject.agents[gridIndex];
  if (!agent) return;
  if (agent.id === activeProject.leadAgentId) {
    setIndicator('error', "Lead can't be disabled");
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
    return;
  }
  const next = !agent.enabled;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (!r.ok) throw new Error(await r.text());
    agent.enabled = next;
    renderGrid();
  } catch (err) {
    setIndicator('error', 'Toggle failed');
    console.error(err);
  }
}
// History drawer was removed; chat is always inline. Keep these stubs
// so file-explorer code that references "drawerOpen" doesn't crash.
let drawerOpen = false;
let drawerFocus = 0;
let drawerEntries = [];
let fileExplorerOpen = false; // wired in Phase 7

async function toggleHistoryDrawer() {
  if (mode !== MODE_ZOOM) return;
  if (drawerOpen) { closeHistoryDrawer(); return; }
  await openHistoryDrawer();
}

async function openHistoryDrawer() {
  const agent = currentAgent();
  if (!agent) return;
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history`);
    if (!r.ok) throw new Error(await r.text());
    const { messages } = await r.json();
    drawerEntries = messages.slice().reverse();
    drawerListEl.innerHTML = '';
    drawerEntries.forEach((m, i) => {
      const li = document.createElement('li');
      li.className = 'history-entry';
      li.dataset.idx = String(i);
      li.innerHTML = `<div class="role">${m.role}</div><div class="snippet">${escapeHtml(String(m.content).slice(0, 120))}</div>`;
      drawerListEl.appendChild(li);
    });
    drawerEl.hidden = false;
    drawerOpen = true;
    drawerFocus = 0;
    paintDrawerFocus();
    if (fileExplorerOpen) closeFileExplorer();
  } catch (err) {
    setIndicator('error', 'History failed');
    console.error(err);
  }
}

function closeHistoryDrawer() {
  drawerEl.hidden = true;
  drawerOpen = false;
}

function paintDrawerFocus() {
  const entries = drawerListEl.querySelectorAll('.history-entry');
  entries.forEach((el, i) => el.classList.toggle('focused', i === drawerFocus));
}

function openHistoryEntry(entry) {
  if (!entry) return;
  closeHistoryDrawer();
  renderZoom({
    intent: 'answer', template: 'reader',
    context: `${entry.role[0].toUpperCase() + entry.role.slice(1)} turn`,
    title: entry.role === 'user' ? 'You said' : `${currentAgent()?.name || 'Agent'} said`,
    body: String(entry.content),
    actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
    _silent: true,
  });
}

const fileDrawerEl = document.getElementById('file-drawer');
const fileTreeEl   = fileDrawerEl.querySelector('.file-tree');
let fileTree = null;
let fileFocus = 0;
let fileEntries = [];
let explorerFocused = false; // true while keyboard nav is inside the explorer
let folderState = { charters: true }; // default open
let userFolders = []; // [{ key: 'user_<ts>', label: 'Name' }] — client-side
/* v2 §5 — shared project Memory drawer. Replaces the now-defunct
 * Skills drawer (S binding). Reuses the existing notes backend:
 *   GET /projects/:pid/notes  →  [{ id, label, ... }]
 * Subscribes to file_created / note_added events on the SSE channel
 * so the list updates live while an agent (or the user) adds notes. */
let memoryDrawerOpen = false;
let memoryNotes = []; // [{ id, label, at }]

const memoryDrawerEl = document.getElementById('memory-drawer');
const memoryListEl   = memoryDrawerEl?.querySelector('.memory-list');

function toggleMemoryDrawer() {
  // Memory is global — only available on L0 (home). It aggregates
  // notes across every project rather than belonging to one.
  if (mode !== MODE_PROJECTS) return;
  if (memoryDrawerOpen) { closeMemoryDrawer(); return; }
  openMemoryDrawer();
}
async function openMemoryDrawer() {
  if (!memoryDrawerEl) return;
  syncExplorerHeights();
  memoryDrawerEl.hidden = false;
  memoryDrawerOpen = true;
  document.body.dataset.memoryDrawer = 'open';
  // Mutually exclusive with the other left drawers.
  if (fileExplorerOpen) closeFileExplorer();
  if (activityDrawerOpen) closeActivityDrawer();
  await loadMemoryNotes();
}
function closeMemoryDrawer() {
  if (!memoryDrawerEl) return;
  memoryDrawerEl.hidden = true;
  memoryDrawerOpen = false;
  document.body.dataset.memoryDrawer = 'closed';
}
/* Aggregate notes across every project the renderer knows about.
 * Each entry keeps its source project so the UI can prefix a crumb. */
async function loadMemoryNotes() {
  memoryNotes = [];
  try {
    const fetches = projects.map(async (p) => {
      const r = await fetch(`/projects/${p.id}/notes`);
      if (!r.ok) return [];
      const { items } = await r.json();
      return (items || []).map(n => ({ ...n, projectId: p.id, projectName: p.name }));
    });
    const all = (await Promise.all(fetches)).flat();
    // Newest first. notes.js returns items with mtime / at fields;
    // fall back to id sort if neither is present.
    all.sort((a, b) => (b.at || b.mtime || 0) - (a.at || a.mtime || 0));
    memoryNotes = all;
  } catch (err) {
    console.warn('[memory] load failed:', err);
    memoryNotes = [];
  }
  repaintMemoryList();
}
function repaintMemoryList() {
  if (!memoryListEl) return;
  memoryListEl.innerHTML = '';
  if (memoryNotes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent = 'Nothing in memory yet. Notes from any project land here.';
    memoryListEl.appendChild(empty);
    return;
  }
  for (const n of memoryNotes) {
    const row = document.createElement('div');
    row.className = 'memory-entry';
    row.tabIndex = 0;
    row.dataset.id = n.id;
    row.dataset.projectId = n.projectId || '';
    const label = document.createElement('div');
    label.className = 'memory-label';
    if (n.projectName) {
      const crumb = document.createElement('span');
      crumb.className = 'memory-project';
      crumb.textContent = n.projectName;
      label.appendChild(crumb);
      label.appendChild(document.createTextNode(' · '));
    }
    label.appendChild(document.createTextNode(n.label || n.id || '(untitled)'));
    const meta = document.createElement('div');
    meta.className = 'memory-meta';
    meta.textContent = formatBubbleTime(n.at || n.mtime) || '';
    row.append(label, meta);
    memoryListEl.appendChild(row);
  }
}

async function toggleFileExplorer() {
  if (mode === MODE_PROJECTS || mode === MODE_NEW_PROJ_ROLES) return;
  if (!activeProject) return;
  if (fileExplorerOpen) { closeFileExplorer(); return; }
  await openFileExplorer();
}

async function openFileExplorer() {
  // Opened from the footer rail (E chip, a keepFocus action) → reveal the panel
  // but leave focus on the chip; the user steps into the explorer deliberately.
  // Any other entry point (e.g. the global E key) focuses it as before.
  const fromRail = _pendingFooterKey != null;
  syncExplorerHeights();
  try {
    const r = await fetch(`/projects/${activeProject.id}/files`);
    if (!r.ok) throw new Error(await r.text());
    fileTree = await r.json();
  } catch (err) {
    setIndicator('error', 'Files failed');
    console.error(err);
    return;
  }
  rebuildFileEntries();

  fileDrawerEl.hidden = false;
  fileExplorerOpen = true;
  if (!fromRail) {
    explorerFocused = true;
    fileFocus = 0;
    paintFileFocus();
  }
  document.body.dataset.fileDrawer = 'open';
  if (drawerOpen) closeHistoryDrawer();
  if (memoryDrawerOpen) closeMemoryDrawer();
  if (activityDrawerOpen) closeActivityDrawer();
}

function closeFileExplorer() {
  fileDrawerEl.hidden = true;
  fileExplorerOpen = false;
  explorerFocused = false;
  document.body.dataset.fileDrawer = 'closed';
  // The viewer is tied to the file manager — never appears on its own.
  closeFileViewer();
}

function paintFileFocus() {
  fileEntries.forEach((el, i) => el.classList.toggle('focused', i === fileFocus));
}

/* Step the explorer cursor by ±1, clamped, with the nav sound on an actual move. */
function stepFileFocus(delta) {
  const prev = fileFocus;
  fileFocus = Math.max(0, Math.min(fileEntries.length - 1, fileFocus + delta));
  if (fileFocus !== prev) playSfx('navigate');
  paintFileFocus();
}

/* Right off the explorer list. With the viewer open, hand focus to its text
 * box; otherwise drop onto the main surface (first grid tile / agent view). */
function exitExplorerRight() {
  explorerFocused = false;
  fileEntries.forEach(el => el.classList.remove('focused'));
  if (fileViewerOpen) setViewerBodyFocus(true);
  else ring.paint();
}

/* Inverse of exitExplorerRight: hop focus from the main surface back INTO the
 * explorer list (Left at the surface's left edge). Clears the ring highlight so
 * focus visibly lives in the explorer again. Shared by the keyboard and gamepad
 * handlers so both paths re-enter the explorer identically. */
function enterExplorerFromSurface() {
  if (!fileExplorerOpen) return;
  explorerFocused = true;
  ring.items.forEach(el => el.classList.remove('focused'));
  paintFileFocus();
}

const fileViewerEl      = document.getElementById('file-viewer');
const fileViewerPathEl  = fileViewerEl.querySelector('.file-viewer-path');
const fileViewerBodyEl  = fileViewerEl.querySelector('.file-viewer-body');
const fileViewerCloseEl = fileViewerEl.querySelector('.file-viewer-close');
let fileViewerOpen      = false;
fileViewerCloseEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFileViewer();   // plays swooshPrev (no select sound on the × button)
});
// Right-arrow off the × button: move focus to the surface itself so
// Enter closes the viewer. Left-arrow returns focus to the ×.
fileViewerCloseEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    closeFileViewerToExplorer();   // plays swooshPrev (no select sound)
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeFileViewerToExplorer();
    return;
  }
  if (e.key === 'ArrowDown') {
    // Down from the × returns focus to the text container.
    e.preventDefault(); e.stopPropagation();
    fileViewerCloseEl.blur();
    setViewerBodyFocus(true);
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
    fileViewerCloseEl.blur();
    setSurfaceCloseFocus(true);
  }
});

/** Re-render the explorer entries based on fileTree + folderState.
 *  Folder headers are focusable; pressing Enter on one toggles. */
function rebuildFileEntries() {
  fileTreeEl.innerHTML = '';
  fileEntries = [];
  if (!fileTree) return;

  const addFolder = (key, label, files, fileRender) => {
    if (files.length === 0) return;
    const head = document.createElement('div');
    head.className = 'file-section file-folder';
    head.dataset.folder = key;
    head.innerHTML = `<span class="folder-toggle">${folderState[key] ? '▾' : '▸'}</span> ${label}`;
    fileTreeEl.appendChild(head);
    fileEntries.push(head);
    if (folderState[key]) {
      for (const f of files) {
        const li = document.createElement('div');
        // `in-folder` indents the entry so it reads as nested under its folder.
        li.className = 'file-entry in-folder';
        fileRender(li, f);
        fileTreeEl.appendChild(li);
        fileEntries.push(li);
      }
    }
  };

  // Entry labels are the bare filename (with .md) — never the directory path.
  const base = (p) => String(p).split('/').pop();
  addFolder('charters', 'Roles', fileTree.charters, (li, c) => {
    li.innerHTML = `<span>${escapeHtml(base(c.path))}</span>`;
    li.dataset.path = c.path;
  });
  // User-created folders (client-side, no contents yet).
  for (const uf of userFolders) {
    const head = document.createElement('div');
    head.className = 'file-section file-folder';
    head.dataset.folder = uf.key;
    head.innerHTML = `<span class="folder-toggle">${folderState[uf.key] ? '▾' : '▸'}</span> ${escapeHtml(uf.label)}`;
    fileTreeEl.appendChild(head);
    fileEntries.push(head);
    if (folderState[uf.key]) {
      const empty = document.createElement('div');
      empty.className = 'file-entry in-folder';
      empty.style.opacity = '0.5';
      empty.style.fontStyle = 'italic';
      empty.textContent = '(empty)';
      fileTreeEl.appendChild(empty);
    }
  }

  // Top-level docs (PRD, milestones, …) — loose, no "Notes" wrapper folder.
  for (const n of (fileTree.notes || [])) {
    const li = document.createElement('div');
    li.className = 'file-entry';
    li.textContent = base(n.path);
    li.dataset.path = n.path;
    fileTreeEl.appendChild(li);
    fileEntries.push(li);
  }

  // project.md is legacy; only older projects still have it.
  if (fileTree.projectMd) {
    const pm = document.createElement('div');
    pm.className = 'file-entry';
    pm.textContent = 'project.md';
    pm.dataset.path = fileTree.projectMd;
    fileTreeEl.appendChild(pm);
    fileEntries.push(pm);
  }

  // Mouse: clicking an entry focuses it then runs the same open/toggle path as
  // Enter/✕ — a file opens in the viewer, a folder header expands/collapses.
  for (const el of fileEntries) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      explorerFocused = true;
      const idx = fileEntries.indexOf(el);
      if (idx < 0) return;
      fileFocus = idx;
      paintFileFocus();
      openFocusedFile();
    });
  }
  paintOpenFile();   // keep the open-file marker after a rebuild (folder toggle)
}

async function openFocusedFile() {
  const e = fileEntries[fileFocus];
  if (!e) return;
  // If the focused entry is a folder header, toggle expand/collapse.
  if (e.classList.contains('file-folder')) {
    const key = e.dataset.folder;
    folderState[key] = !folderState[key];
    rebuildFileEntries();
    // Re-focus the same folder header after rebuild.
    fileFocus = fileEntries.findIndex(el => el.dataset.folder === key);
    if (fileFocus < 0) fileFocus = 0;
    paintFileFocus();
    return;
  }
  const path = e.dataset.path;
  if (!path) return;
  try {
    const r = await fetch(`/projects/${activeProject.id}/file/${path}`);
    if (!r.ok) throw new Error(await r.text());
    const { body } = await r.json();
    showFileViewer(path, body);
  } catch (err) {
    setIndicator('error', 'File read failed');
    console.error(err);
  }
}

function showFileViewer(path, body) {
  playSfx('swooshNext');   // viewer slides in
  fileViewerPathEl.textContent = path;
  fileViewerBodyEl.textContent = body;
  fileViewerBodyEl.scrollTop = 0;
  fileViewerEl.hidden = false;
  fileViewerOpen = true;
  document.body.dataset.fileViewer = 'open';
  // Opening a file highlights the text container: the right stick now scrolls
  // it, and Up jumps to the × button. Hand focus over from the explorer — but
  // keep the opened file visibly marked in the explorer so it's clear which
  // file is showing.
  _openFilePath = path;
  explorerFocused = false;
  fileEntries.forEach(el => el.classList.remove('focused'));
  paintOpenFile();
  _viewerNavSilent = true;   // opening plays swooshNext, not the focus nav sound
  setSurfaceCloseFocus(false);
  setViewerBodyFocus(true);
  _viewerNavSilent = false;
}

function closeFileViewer() {
  if (!fileViewerOpen) return;   // avoid a stray swoosh when already closed
  playSfx('swooshPrev');   // viewer slides out
  fileViewerEl.hidden = true;
  fileViewerOpen = false;
  document.body.dataset.fileViewer = 'closed';
  setSurfaceCloseFocus(false);
  setViewerBodyFocus(false);
  setSurfaceContainerFocus(false);
  _openFilePath = null;
  paintOpenFile();
}

// Path of the file currently shown in the viewer — kept marked in the explorer
// (a persistent ".open" highlight) so it's clear which file is open, and used
// to send focus back to that entry when the viewer is dismissed.
let _openFilePath = null;
function paintOpenFile() {
  fileEntries.forEach(el =>
    el.classList.toggle('open', !!_openFilePath && el.dataset.path === _openFilePath));
}
/* Dismiss the viewer (Esc / Back / ×) and return the explorer highlight to the
 * file that was open, so the user lands back on it rather than nowhere. */
function closeFileViewerToExplorer() {
  const path = _openFilePath;
  closeFileViewer();
  if (!fileExplorerOpen) return;
  if (path) {
    const i = fileEntries.findIndex(el => el.dataset.path === path);
    if (i >= 0) fileFocus = i;
  }
  explorerFocused = true;
  paintFileFocus();
}

/** When the user arrows right off the viewer × button, the surface
 *  itself becomes the focus target — pressing Enter closes the viewer. */
let surfaceCloseFocused = false;
function setSurfaceCloseFocus(on) {
  surfaceCloseFocused = !!on;
  document.body.dataset.surfaceCloseFocus = on ? 'true' : 'false';
}

// True while the file viewer's text container holds focus. In this state the
// right stick scrolls the body and Up moves focus to the viewer's × button.
let viewerBodyFocused = false;
let _viewerNavSilent = false;   // suppress the nav SFX during open/close (swoosh plays instead)
function setViewerBodyFocus(on) {
  if (on && !viewerBodyFocused && !_viewerNavSilent) playSfx('navigate');   // moved INTO the body
  viewerBodyFocused = !!on;
  if (fileViewerBodyEl) fileViewerBodyEl.classList.toggle('focused', viewerBodyFocused);
  document.body.dataset.viewerBody = viewerBodyFocused ? 'true' : 'false';
}

// True while the whole main surface container (agent grid / agent view) is
// highlighted as one block — reached by arrowing right off the viewer body.
// Enter drops into the surface; Left returns to the viewer body.
let surfaceContainerFocused = false;
function setSurfaceContainerFocus(on) {
  if (on && !surfaceContainerFocused && !_viewerNavSilent) playSfx('navigate');   // moved onto the surface container
  surfaceContainerFocused = !!on;
  surfaceEl.classList.toggle('container-focused', surfaceContainerFocused);
  document.body.dataset.surfaceContainer = surfaceContainerFocused ? 'true' : 'false';
}
function currentAgent() { return activeProject?.agents?.[zoomedIndex] || null; }

/* ---------- Button dispatch ---------- */
function pressCross() {
  if (mode === MODE_GRID) {
    enterZoom();
    return;
  }
  const cur = ring.current();
  if (!cur) {
    const crossBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'cross');
    if (crossBtn) executeAction(crossBtn._action, currentAgent()?.lastSpec);
    return;
  }
  if (cur.classList.contains('action')) {
    executeAction(cur._action, currentAgent()?.lastSpec);
  } else if (cur.classList.contains('list-row')) {
    const crossBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'cross');
    if (crossBtn) executeAction(crossBtn._action, currentAgent()?.lastSpec);
  }
}

function pressCircle() {
  if (mode === MODE_GRID) return;
  // First, an explicit circle action on the bar wins; otherwise back-out of zoom.
  const cur = ring.current();
  if (cur?.classList?.contains('action') && cur.dataset.glyph === 'circle') {
    executeAction(cur._action, currentAgent()?.lastSpec);
    return;
  }
  const circleBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'circle');
  if (circleBtn && currentAgent()?.lastSpec) {
    // If the current spec has a circle action, fire it (Back/Cancel/Done).
    executeAction(circleBtn._action, currentAgent()?.lastSpec);
    return;
  }
  exitZoom();
}

/* ---------- Input bindings ---------- */
gp.addEventListener('ptt-down', () => { setInputMode('gamepad'); startPTT(); });
gp.addEventListener('ptt-up', endPTT);
gp.addEventListener('connected', () => {
  setIndicator('idle', 'Controller ready');
  setTimeout(() => setIndicator('idle', 'Connected'), 1500);
});
gp.addEventListener('press', (e) => {
  setInputMode('gamepad');
  flashShortcutByGamepad(e.detail.button);
  const b = e.detail.button;
  // First-launch key gate owns the gamepad while it's up: d-pad moves between
  // the key field and Save; Cross submits.
  const apiGateEl = document.getElementById('apikey-gate');
  if (apiGateEl && !apiGateEl.hidden) {
    if (b === 'up' || b === 'left')         document.getElementById('apikey-gate-input')?.focus();
    else if (b === 'down' || b === 'right') document.getElementById('apikey-gate-save')?.focus();
    else if (b === 'cross')                 document.getElementById('apikey-gate-save')?.click();
    return;
  }
  // Reasoning-effort picker: hold the touchpad, nudge Up/Down (d-pad or sticks).
  if (b === 'touchpad') { openEffortPicker(); return; }
  if (effortPickerOpen) {
    if (b === 'up')   { moveEffortPicker(+1); return; }
    if (b === 'down') { moveEffortPicker(-1); return; }
    return;  // swallow everything else while picking
  }
  if (b === 'l2') { speakFocusedAgentName(); return; }

  // Settings modal takes over gamepad while open.
  if (settingsOpen) {
    handleSettingsGamepad(b);
    return;
  }
  // Edit-bubble modal takes over while open.
  if (editBubbleOpen) {
    handleEditBubbleGamepad(b);
    return;
  }
  // Project-edit modal takes over while open.
  if (projectEditOpen) {
    handleProjectEditGamepad(b);
    return;
  }
  // "Really cancel?" confirm modal takes over while open — otherwise gamepad
  // input leaks to the screen underneath and the modal can't be answered.
  if (confirmCancelOpen) {
    if (b === 'left' || b === 'right') {
      playSfx('navigate');   // moved between Yes / No
      (document.activeElement === confirmCancelYesEl ? confirmCancelNoEl : confirmCancelYesEl)?.focus();
    } else if (b === 'cross') {
      (document.activeElement === confirmCancelYesEl ? confirmCancelYesEl : confirmCancelNoEl)?.click();
    } else if (b === 'circle') {
      closeConfirmCancel();   // back out of the confirm = keep editing (matches Esc)
    }
    return;
  }

  // Notification menu takes over while open — Up/Down step entries,
  // Cross activates the focused entry's primary action, Circle closes.
  if (notificationsOpen) {
    if (b === 'up')     { stepNotifEntry(-1); return; }
    if (b === 'down')   { stepNotifEntry(+1); return; }
    if (b === 'cross') {
      const active = document.activeElement;
      if (active?.classList?.contains('notification-entry')) {
        const primary = active.querySelector('.notif-actions .notif-primary')
                     || active.querySelector('.notif-actions button');
        primary?.click();
        return;
      }
      // Cross while not on an entry (e.g. on the bell) dismisses the menu.
      closeNotificationMenu();
      document.getElementById('notification-btn')?.focus();
      return;
    }
    if (b === 'circle') { closeNotificationMenu();
                          document.getElementById('notification-btn')?.focus();
                          return; }
    return;
  }

  // File viewer text container holds focus: the right stick scrolls it (see the
  // rstick listener). The d-pad Up jumps to the × button, Down nudge-scrolls,
  // Left returns to the explorer, Right highlights the surface container,
  // Circle closes.
  if (viewerBodyFocused) {
    if (b === 'up')     { playSfx('navigate'); setViewerBodyFocus(false); fileViewerCloseEl?.focus(); return; }
    if (b === 'down')   { fileViewerBodyEl.scrollBy({ top: 80, behavior: 'instant' }); return; }
    if (b === 'cross')  { fileViewerBodyEl.scrollBy({ top: 80, behavior: 'instant' }); return; }
    if (b === 'left')   { if (fileExplorerOpen) { playSfx('navigate'); setViewerBodyFocus(false); explorerFocused = true; paintFileFocus(); } return; }
    if (b === 'right')  { setViewerBodyFocus(false); setSurfaceContainerFocus(true); return; }
    if (b === 'circle') { closeFileViewerToExplorer(); return; }
  }
  // Whole surface container highlighted (right off the viewer body): Left
  // returns to the body, Cross drops into the grid, Circle steps back.
  if (surfaceContainerFocused) {
    if (b === 'left')   { setSurfaceContainerFocus(false); if (fileViewerOpen) setViewerBodyFocus(true); else if (fileExplorerOpen) { explorerFocused = true; paintFileFocus(); } return; }
    if (b === 'cross')  { setSurfaceContainerFocus(false); ring.paint(); return; }
    if (b === 'circle') { setSurfaceContainerFocus(false); if (fileViewerOpen) setViewerBodyFocus(true); return; }
    if (b === 'up' || b === 'down' || b === 'right') return;   // whole-container highlight — stays put
  }
  // The viewer × button holds DOM focus (reached via Up from the body):
  // Cross/Circle close it, Down returns to the body.
  if (fileViewerOpen && document.activeElement === fileViewerCloseEl) {
    if (b === 'cross' || b === 'circle') { closeFileViewerToExplorer(); return; }
    if (b === 'down')  { fileViewerCloseEl.blur(); setViewerBodyFocus(true); return; }
    if (b === 'up' || b === 'left' || b === 'right') return;
  }

  // While the × close button holds focus (reached via Up from the first row),
  // Cross activates it and Down returns to the grid; the close button is the
  // top-right corner, so Up / Left / Right just rubberband.
  {
    const closeBtn = surfaceEl.querySelector('.surface-close');
    if (closeBtn && document.activeElement === closeBtn) {
      if (b === 'cross')      { closeBtn.click(); return; }
      if (b === 'down')       {
        closeBtn.blur();
        // On L2, Down re-enters the chat at the most-recent (last) bubble,
        // which is on-screen so the highlight is visible.
        if (mode === MODE_ZOOM && chatBubbles.length) focusLastBubble();
        else ring.paint();
        return;
      }
      if (b === 'up' || b === 'left' || b === 'right') return;  // no rubberband on the × close
      closeBtn.blur(); ring.paint(); return;
    }
  }

  // Footer shortcuts rail has focus (entered with Down from the grid): the
  // d-pad walks the chips, Up/Circle returns to the surface, Cross activates.
  if (isShortcutsFocused()) {
    if (b === 'left')   { moveShortcutFocus(-1); return; }
    if (b === 'right')  { moveShortcutFocus(+1); return; }
    if (b === 'up')     { leaveFooterUpward(); return; }
    if (b === 'down')   { return; }   // already the bottom row — no rubberband
    if (b === 'cross')  {
      const el = footerFocusables()[shortcutFocusIdx];
      if (el?._hold) beginChipHold(el);   // press-and-hold chip (talk / reasoning)
      else activateFocusedShortcut();
      return;
    }
    if (b === 'circle') { leaveShortcuts(); ring.paint(); return; }
    return;
  }

  // While the add/remove screen is open, Back (circle) always returns to L1.
  if (document.body.dataset.addAgentOpen === '1' && b === 'circle') { leaveAddAgentToGrid(); return; }

  if (mode === MODE_PROJECTS) {
    if (b === 'left' || b === 'right' || b === 'up' || b === 'down') {
      pickerMove(b);
    } else if (b === 'cross') {
      if (ring.index < projects.length) startProjectHold(ring.index); // hold → edit modal
      else openFocused();                                             // "+ New" → open now
    } else if (b === 'triangle') {
      toggleActivityDrawer();
    } else if (b === 'square') {
      toggleMemoryDrawer();
    }
    return;
  }

  if (mode === MODE_GRID) {
    if (fileExplorerOpen && explorerFocused) {
      // Explorer is a vertical list — Up/Down walk it; Left no-op. Right exits
      // to the right (open viewer's text box, or the first grid tile).
      if (b === 'up')                   { stepFileFocus(-1); return; }
      if (b === 'down')                 { stepFileFocus(+1); return; }
      if (b === 'left')                 { return; }
      if (b === 'right')                { exitExplorerRight(); return; }
      if (b === 'cross')                { openFocusedFile(); return; }
      if (b === 'circle')               { closeFileExplorer(); return; }
    }
    if (activityDrawerOpen && activityFocused) {
      // View-only feed: Up/Down highlight, Right leaves, Circle closes.
      if (b === 'up')    { stepActivityFocus(-1); return; }
      if (b === 'down')  { stepActivityFocus(+1); return; }
      if (b === 'left')  { return; }
      if (b === 'right') { exitActivityRight(); return; }
      if (b === 'circle'){ closeActivityDrawer(); ring.paint(); return; }
      if (b === 'cross') { return; }   // view-only feed — X does nothing on an entry
    }
    // Left off the leftmost grid column with a left drawer open hops back in.
    if (b === 'left' && (fileExplorerOpen || activityDrawerOpen) && !explorerFocused && !activityFocused) {
      const grid = surfaceEl.querySelector('.agent-grid');
      const cols = grid?._cols || 4;
      if ((ring.index % cols) === 0) {
        if (activityDrawerOpen) enterActivityFromSurface('first'); else enterExplorerFromSurface();
        return;
      }
    }
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') gridMove(b);
    else if (b === 'cross')   enterZoom();
    else if (b === 'circle')  exitToProjects();
    else if (b === 'l1')      cycleProject(-1);
    else if (b === 'r1')      cycleProject(+1);
    else if (b === 'square')  toggleFileExplorer();
    else if (b === 'options') toggleFocusedAgentEnabled();
    else if (b === 'triangle') toggleActivityDrawer();
    return;
  }

  if (mode === MODE_ZOOM) {
    if (fileExplorerOpen && explorerFocused) {
      // Explorer is a vertical list — Up/Down walk it; Left no-op. Right exits
      // to the right (open viewer's text box, or the first grid tile).
      if (b === 'up')                   { stepFileFocus(-1); return; }
      if (b === 'down')                 { stepFileFocus(+1); return; }
      if (b === 'left')                 { return; }
      if (b === 'right')                { exitExplorerRight(); return; }
      if (b === 'cross')                { openFocusedFile(); return; }
      if (b === 'circle')               { closeFileExplorer(); return; }
    }
    if (activityDrawerOpen && activityFocused) {
      if (b === 'up')    { stepActivityFocus(-1); return; }
      if (b === 'down')  { stepActivityFocus(+1); return; }
      if (b === 'left')  { return; }
      if (b === 'right') { exitActivityRight(); return; }
      if (b === 'circle'){ closeActivityDrawer(); ring.paint(); return; }
      if (b === 'cross') { return; }   // view-only feed — X does nothing on an entry
    }
    // Chat-history navigation (mirrors the keyboard model): once a bubble is
    // focused, Up/Down walk bubbles, Left/Right cycle a bubble's action icons,
    // Cross activates, Down past the last bubble (or Circle) drops back out.
    if (isBubbleFocused()) {
      if (bubbleNavButton(b)) return;
      if (b === 'l1')     { cycleAgent(-1); return; }
      if (b === 'r1')     { cycleAgent(+1); return; }
      return;
    }
    // Left at the first ring position with a left drawer open hops back in.
    if (b === 'left' && (fileExplorerOpen || activityDrawerOpen) && !explorerFocused && !activityFocused && ring.index === 0) {
      if (activityDrawerOpen) enterActivityFromSurface('first'); else enterExplorerFromSurface();
      return;
    }
    // Surface ring. Up from the top enters the chat history (last bubble);
    // Down from the bottom drops into the footer shortcuts rail.
    if (b === 'up') {
      if (ring.index === 0 && chatBubbles.length > 0) { focusLastBubble(); return; }
      if (ring.index === 0 && focusSurfaceClose()) return;
      ring.move(-1); return;
    }
    if (b === 'down') {
      const lastIdx = Math.max(0, ring.elements.length - 1);
      if ((ring.elements.length === 0 || ring.index === lastIdx) && enterShortcuts()) return;
      ring.move(+1); return;
    }
    if (b === 'left')                    ring.move(-1);
    else if (b === 'right')              ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'square')             toggleFileExplorer();
    else if (b === 'triangle')           toggleActivityDrawer();
    return;
  }

  if (mode === MODE_COUNCIL) {
    // Same selectable-bubble model as agent L2 (mirrors the council footer).
    if (isBubbleFocused()) { if (bubbleNavButton(b)) return; return; }
    if (b === 'up')       { if (chatBubbles.length) focusLastBubble(); return; }
    if (b === 'square')   { toggleFileExplorer(); return; }
    if (b === 'triangle') { toggleActivityDrawer(); return; }
    if (b === 'circle')   { exitCouncilToGrid(); return; }
    return;
  }

  if (mode === MODE_NEW_PROJ_TOPOLOGY) {
    if (b === 'left')        topoMoveCard(-1);
    else if (b === 'right')  topoMoveCard(+1);
    else if (b === 'down')   { if (ring.index >= TOPOLOGIES.length) enterShortcuts(); else topoFocusBack(); }
    else if (b === 'up')   { if (ring.index >= TOPOLOGIES.length) topoFocusCards(); else focusSurfaceClose(); }
    else if (b === 'cross') { const c = ring.current(); if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId); else c?.click?.(); }
    else if (b === 'circle') goBackInCreateFlow();
    return;
  }
  if (mode === MODE_NEW_PROJ_ROLES) {
    if (b === 'up') {
      const grid = surfaceEl.querySelector('.role-grid');
      const cols = grid?._cols || 4;
      if (Math.floor(ring.index / cols) === 0 && focusSurfaceClose()) return;
    }
    if (b === 'down') { if (advanceDownFromRolePicker()) return; roleGridMove('down'); return; }
    if (b === 'up' || b === 'left' || b === 'right') {
      roleGridMove(b);
    } else if (b === 'cross') {
      // On a role tile → toggle it; on Cancel/Continue → activate it (Cancel
      // runs the "really cancel?" confirm when the selection's been revised).
      const cur = ring.current();
      if (cur && !cur.classList?.contains('role-tile') && typeof cur.click === 'function') cur.click();
      else toggleFocusedRole();
    }
    else if (b === 'triangle')   advanceFromRolePicker();
    else if (b === 'circle')     goBackInCreateFlow();
    return;
  }
  if (mode === MODE_ADD_AGENT) {
    // roleGridMove owns edge behavior: Up from the first row → × close;
    // Left/Right flow through tiles in reading order and Cancel ⟷ Continue;
    // Down drops to the nearer bottom button. (No inline right→close, which
    // wrongly treated the Cancel button as a rightmost-column tile.)
    if (b === 'down') {
      if (advanceDownFromRolePicker()) return;
      roleGridMove('down');
    } else if (b === 'up' || b === 'left' || b === 'right') {
      roleGridMove(b);
    } else if (b === 'cross') {
      // On a role tile → toggle it; on the Cancel/Continue button → activate it.
      const cur = ring.current();
      if (cur && !cur.classList?.contains('role-tile') && typeof cur.click === 'function') cur.click();
      else toggleFocusedAddAgentRole();
    }
    else if (b === 'square')     toggleFileExplorer();
    else if (b === 'triangle')   commitAddAgentSelections();
    else if (b === 'circle')     renderGrid();
    return;
  }
  if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL || mode === MODE_NEW_PROJ_FEATURES) {
    if (b === 'left')        ring.move(-1);
    else if (b === 'right')  ring.move(+1);
    else if (b === 'up')     focusSurfaceClose();
    else if (b === 'cross') {
      const cur = ring.current();
      if (cur && typeof cur.click === 'function') cur.click();
      else confirmCapture();
    }
    else if (b === 'circle') goBackInCreateFlow();
    return;
  }
});

/* Right thumbstick scrolls the L2 chat with a velocity model: holding up/down
 * ramps the scroll speed up (acceleration) and releasing eases it back to a
 * stop (deceleration / momentum). y > 0 = down, y < 0 = up. The gamepad driver
 * already applies a 0.15 dead-zone. Scrolls are 'instant' per frame — the
 * easing lives in the velocity, not the browser's smooth-scroll. */
const RSCROLL_MAX   = 22;    // px/frame at full deflection (top speed)
const RSCROLL_ACCEL = 0.14;  // ramp toward target speed while holding
const RSCROLL_DECEL = 0.08;  // ease back to 0 after release (lower = longer glide)
let _rstickY = 0;            // latest stick deflection (-1..1)
let _rscrollVel = 0;         // current scroll velocity (px/frame)
let _rscrollRAF = null;
function _rstickScroller() {
  // The right stick scrolls the focused file-viewer body, otherwise the chat.
  if (viewerBodyFocused && fileViewerOpen) return fileViewerBodyEl;
  return mode === MODE_ZOOM ? surfaceEl?.querySelector?.('.chat-scroll') : null;
}
function _rscrollTick() {
  const scroller = _rstickScroller();
  if (!scroller) { _rscrollVel = 0; _rstickY = 0; _rscrollRAF = null; return; }
  const target = _rstickY * RSCROLL_MAX;
  const rate = Math.abs(target) > Math.abs(_rscrollVel) ? RSCROLL_ACCEL : RSCROLL_DECEL;
  _rscrollVel += (target - _rscrollVel) * rate;
  if (target === 0 && Math.abs(_rscrollVel) < 0.3) { _rscrollVel = 0; _rscrollRAF = null; return; }
  scroller.scrollBy({ top: _rscrollVel, left: 0, behavior: 'instant' });
  _rscrollRAF = requestAnimationFrame(_rscrollTick);
}
gp.addEventListener('rstick', (e) => {
  // While the effort picker is open, the right stick steps it (one step per
  // push past the threshold) instead of scrolling the chat. Up = more effort.
  if (effortPickerOpen) {
    const y = e.detail?.y || 0;
    if (y < -0.5 && _rstickLatch <= 0) { _rstickLatch = 1; moveEffortPicker(+1); }
    else if (y > 0.5 && _rstickLatch >= 0) { _rstickLatch = -1; moveEffortPicker(-1); }
    else if (Math.abs(y) < 0.3) _rstickLatch = 0;
    return;
  }
  _rstickY = _rstickScroller() ? (e.detail?.y || 0) : 0;
  if (_rscrollRAF == null && (_rstickY || _rscrollVel)) _rscrollRAF = requestAnimationFrame(_rscrollTick);
});

/* L2: speak the currently-focused project/agent name. */
function speakFocusedAgentName() {
  if (mode === MODE_PROJECTS) {
    const p = ring.index < projects.length ? projects[ring.index] : null;
    if (p) { stopSpeaking(); speak(p.name); }
  } else if (mode === MODE_GRID || mode === MODE_ZOOM) {
    const agent = mode === MODE_ZOOM ? currentAgent() : (activeProject?.agents?.[gridIndex] ?? null);
    if (agent) { stopSpeaking(); speak(agent.name); }
  }
}

// Brand link: clicking it returns to L0.
document.getElementById('brand')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (mode === MODE_PROJECTS) return;
  if (mode === MODE_ZOOM)      exitZoom().then(() => exitToProjects());
  else if (mode === MODE_GRID) exitToProjects();
  else                          renderProjects();
});

/* ---------- Settings modal ---------- */
const settingsBtnEl       = document.getElementById('settings-btn');
const settingsModalEl     = document.getElementById('settings-modal');
const settingsApiKeyEl    = document.getElementById('settings-api-key');
const settingsApiMetaEl   = document.getElementById('settings-api-key-current'); // removed from DOM; keep null-safe
const settingsModelEl     = document.getElementById('settings-model');
const settingsRouterModelEl = document.getElementById('settings-router-model');
const settingsRoleModelsEl= document.getElementById('settings-role-models');
const settingsCouncilEls  = [null, null, null];   // council-member selects, created by populateRoleModels
const settingsInstructionsEl = document.getElementById('settings-instructions');
const settingsSkillsListEl= document.getElementById('settings-skills-list');
const ghStatusEl       = document.getElementById('settings-github-status');
const ghConnectEl      = document.getElementById('settings-github-connect');
const ghDisconnectEl   = document.getElementById('settings-github-disconnect');
const ghClientIdEl     = document.getElementById('settings-github-client-id');
const ghClientIdField  = document.getElementById('settings-github-clientid-field');
const ghDeviceEl       = document.getElementById('settings-github-device');
const ghQrEl           = document.getElementById('settings-github-qr');
const ghLinkEl         = document.getElementById('settings-github-link');
const ghCodeEl         = document.getElementById('settings-github-code');
const ghDeviceStateEl  = document.getElementById('settings-github-device-state');
let ghPollTimer = null;
const settingsMcpListEl   = document.getElementById('settings-mcp-list');
const settingsMcpAddEl    = document.getElementById('settings-mcp-add');
const settingsHealthEl    = document.getElementById('settings-health');
const settingsGitEnabledEl= document.getElementById('settings-git-enabled');
const settingsTiersEl     = document.getElementById('settings-tiers');
const settingsGitIntervalEl = document.getElementById('settings-git-interval');
const settingsSttUrlEl    = document.getElementById('settings-stt-url');
const settingsGitStateEl   = document.getElementById('settings-git-state');

function paintGitState() {
  if (!settingsGitStateEl) return;
  const on = !!settingsGitEnabledEl?.checked;
  settingsGitStateEl.textContent = on ? 'Enabled' : 'Disabled';
  settingsGitStateEl.dataset.on = String(on);
}
settingsGitEnabledEl?.addEventListener('change', paintGitState);

function stepGitInterval(delta) {
  if (!settingsGitIntervalEl) return;
  const cur = Number(settingsGitIntervalEl.value) || 5;
  const next = Math.max(1, Math.min(120, cur + delta));
  settingsGitIntervalEl.value = String(next);
}
document.getElementById('settings-git-interval-dec')?.addEventListener('click', () => stepGitInterval(-1));
document.getElementById('settings-git-interval-inc')?.addEventListener('click', () => stepGitInterval(+1));
const settingsSaveEl      = document.getElementById('settings-save');
const settingsCancelEl    = document.getElementById('settings-cancel');
const settingsCloseEl     = document.getElementById('settings-close');
const settingsTabEls      = [...document.querySelectorAll('.settings-tab')];
const settingsPaneEls     = [...document.querySelectorAll('.settings-pane')];
let settingsOpen = false;
let settingsModelsList = []; // shared OpenRouter model list
let settingsRolesList = []; // [{ id, label }]
let settingsMcpEntries = []; // [{ id, name, enabled }]
let settingsHealthTimer = null;
let currentCancelToken = null;

/* Visual placeholder shown in the API key input when the server
 * already has a key. Treated as "unchanged" on save — sending it
 * back as the value would overwrite the real key with asterisks. */
const API_KEY_PLACEHOLDER = '*'.repeat(30);
let apiKeyIsSet = false;
settingsApiKeyEl?.addEventListener('focus', () => {
  if (settingsApiKeyEl.value === API_KEY_PLACEHOLDER) settingsApiKeyEl.value = '';
});
settingsApiKeyEl?.addEventListener('blur', () => {
  if (apiKeyIsSet && settingsApiKeyEl.value === '') {
    settingsApiKeyEl.value = API_KEY_PLACEHOLDER;
  }
});

function selectSettingsTab(name) {
  for (const t of settingsTabEls) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of settingsPaneEls) p.hidden = (p.dataset.tab !== name);
  if (name === 'health') refreshHealthPane();
}
settingsTabEls.forEach(t => t.addEventListener('click', () => selectSettingsTab(t.dataset.tab)));

/* Friendly name for a model id (uses the loaded model list, else prettifies). */
function modelDisplayName(id) {
  if (!id) return '';
  const m = settingsModelsList.find(x => x.id === id);
  return m && m.name && m.name !== m.id ? m.name : councilModelLabel(id);
}

function buildModelOptions(currentId, includeUseDefault = false, defaultModelId = '') {
  const frag = document.createDocumentFragment();
  if (includeUseDefault) {
    const opt = document.createElement('option');
    opt.value = '';
    // Show what "default" resolves to for this role (its tier-assigned model).
    opt.textContent = defaultModelId ? `Default · ${modelDisplayName(defaultModelId)}` : '— Use default —';
    if (!currentId) opt.selected = true;
    frag.appendChild(opt);
  }
  let matched = false;
  for (const m of settingsModelsList) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id;
    if (m.id === currentId) { opt.selected = true; matched = true; }
    frag.appendChild(opt);
  }
  if (currentId && !matched) {
    const opt = document.createElement('option');
    opt.value = currentId;
    opt.textContent = `${currentId} (current)`;
    opt.selected = true;
    frag.prepend(opt);
  }
  return frag;
}

function populateModelSelect(currentId) {
  settingsModelEl.innerHTML = '';
  settingsModelEl.appendChild(buildModelOptions(currentId, false));
}

function populateRouterModelSelect(currentId) {
  if (!settingsRouterModelEl) return;
  settingsRouterModelEl.innerHTML = '';
  // Server resolves this (defaults to the fast router model), so it's always a
  // concrete model — no "use default" entry needed.
  settingsRouterModelEl.appendChild(buildModelOptions(currentId, false));
}

function populateCouncilModels(models) {
  settingsCouncilEls.forEach((sel, i) => {
    if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(buildModelOptions(models[i] || '', false));
  });
}

function populateRoleModels(byRole, defaultByRole = {}) {
  settingsRoleModelsEl.innerHTML = '';
  for (const role of settingsRolesList) {
    const row = document.createElement('div');
    row.className = 'role-model-row';
    const label = document.createElement('div');
    label.className = 'role-label';
    label.textContent = role.label;
    const select = document.createElement('select');
    select.dataset.role = role.id;
    select.appendChild(buildModelOptions(byRole[role.id] || '', true, defaultByRole[role.id] || ''));
    row.append(label, select);
    settingsRoleModelsEl.appendChild(row);
  }
  // Council members render as three more rows below the agent roles (under
  // Legal), in the same role-model-row style. The selects are created here (and
  // stored in settingsCouncilEls for save); populateCouncilModels fills options.
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'role-model-row';
    const label = document.createElement('div');
    label.className = 'role-label';
    label.textContent = `Council Member ${i + 1}`;
    const select = document.createElement('select');
    select.id = `settings-council-${i}`;
    settingsCouncilEls[i] = select;
    row.append(label, select);
    settingsRoleModelsEl.appendChild(row);
  }
}

function populateMcpList(entries) {
  settingsMcpEntries = (entries || []).slice();
  settingsMcpListEl.innerHTML = '';
  if (settingsMcpEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-meta';
    empty.textContent = 'No MCP plugins registered yet.';
    settingsMcpListEl.appendChild(empty);
    return;
  }
  for (const p of settingsMcpEntries) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    const name = document.createElement('div');
    name.className = 'mcp-name';
    name.textContent = p.name || p.id;
    const meta = document.createElement('div');
    meta.className = 'mcp-meta';
    meta.textContent = p.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.enabled;
    cb.addEventListener('change', () => { p.enabled = cb.checked; });
    row.append(name, meta, cb);
    settingsMcpListEl.appendChild(row);
  }
}

async function populateSkills() {
  if (!settingsSkillsListEl) return;
  settingsSkillsListEl.innerHTML = '';
  let skills = [];
  try {
    const r = await fetch('/skills');
    if (r.ok) skills = (await r.json()).skills || [];
  } catch (err) { console.warn('[settings] skills fetch failed', err); }
  if (skills.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-meta';
    empty.textContent = 'No skills available yet.';
    settingsSkillsListEl.appendChild(empty);
    return;
  }
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.dataset.skillId = s.id;
    const text = document.createElement('div');
    text.className = 'skill-text';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = s.name;
    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = s.description;
    text.append(name, desc);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'skill-toggle';
    cb.checked = !!s.enabled;
    cb.setAttribute('aria-label', `${s.enabled ? 'Deactivate' : 'Activate'} ${s.name}`);
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        const r = await fetch(`/skills/${encodeURIComponent(s.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: cb.checked }),
        });
        if (!r.ok) throw new Error(`server ${r.status}`);
        s.enabled = cb.checked;
        row.dataset.enabled = String(cb.checked);
      } catch (err) {
        console.warn('[settings] skill toggle failed', err);
        cb.checked = !cb.checked; // revert on failure
      } finally {
        cb.disabled = false;
      }
    });
    row.dataset.enabled = String(s.enabled);
    row.append(text, cb);
    settingsSkillsListEl.appendChild(row);
  }
}

/* ---------- GitHub pairing (device flow) ---------- */
function renderGithubStatus(st) {
  if (!ghStatusEl) return;
  const configured = !!st?.configured;
  const connected = !!st?.connected;
  ghStatusEl.textContent = connected
    ? `Connected${st.login ? ` as ${st.login}` : ''}`
    : (configured ? 'Not connected' : 'GitHub login isn’t set up yet');
  ghStatusEl.dataset.connected = String(connected);
  // Connect shows whenever not connected; the OAuth client id is baked in
  // server-side, so end users never enter it. Disabled only if the maintainer
  // hasn't configured the client id.
  if (ghConnectEl)    { ghConnectEl.hidden = connected; ghConnectEl.disabled = !configured; }
  if (ghDisconnectEl) ghDisconnectEl.hidden = !connected;
  if (ghClientIdField) ghClientIdField.hidden = true;        // baked in — not an end-user field
  if (connected && ghDeviceEl) ghDeviceEl.hidden = true;
}

async function refreshGithubStatus() {
  // Show current status immediately…
  try {
    const r = await fetch('/github');
    if (r.ok) renderGithubStatus(await r.json());
  } catch {}
  // …then auto-detect an existing local token (gh CLI / git keychain) in the
  // background; flips to "Connected as …" if one is found.
  try {
    const r = await fetch('/github/detect', { method: 'POST' });
    if (r.ok) renderGithubStatus(await r.json());
  } catch {}
}

function stopGithubPoll() { if (ghPollTimer) { clearInterval(ghPollTimer); ghPollTimer = null; } }

async function githubConnect() {
  stopGithubPoll();
  if (ghDeviceEl) ghDeviceEl.hidden = true;   // keep hidden until the flow starts
  if (ghStatusEl) ghStatusEl.textContent = 'Starting…';
  let info;
  try {
    const r = await fetch('/github/device', { method: 'POST' });
    info = await r.json();
    if (!r.ok) throw new Error(info?.error || `server ${r.status}`);
  } catch (err) {
    // Failure → show it on the status line; don't reveal a broken device/QR area.
    if (ghStatusEl) ghStatusEl.textContent = `Couldn't start: ${err.message}`;
    return;
  }
  const url = info.verification_uri_complete;
  if (ghCodeEl) ghCodeEl.textContent = info.user_code || '????-????';
  if (ghLinkEl) ghLinkEl.href = url;
  // QR of the verification URL (phone path). The value is a single-use device
  // code, useless without the user's own GitHub approval, so a public QR-image
  // renderer is acceptably low-risk. Hide the image gracefully if it can't load
  // — the code + on-device link still work.
  if (ghQrEl) {
    ghQrEl.style.display = '';
    ghQrEl.onload  = () => { ghQrEl.style.display = ''; };
    ghQrEl.onerror = () => { ghQrEl.style.display = 'none'; };
    ghQrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(url)}`;
  }
  if (ghStatusEl) ghStatusEl.textContent = 'Not connected';
  if (ghDeviceStateEl) ghDeviceStateEl.textContent = 'Waiting for authorization…';
  if (ghDeviceEl) {
    ghDeviceEl.hidden = false;
    ghDeviceEl.scrollIntoView({ block: 'center', behavior: 'smooth' });   // reveal the QR/code
  }
  ghPollTimer = setInterval(async () => {
    try {
      const s = await (await fetch('/github')).json();
      if (s.connected) {
        stopGithubPoll();
        renderGithubStatus(s);
      } else if (s.pending?.status === 'error') {
        stopGithubPoll();
        if (ghDeviceStateEl) ghDeviceStateEl.textContent = `Authorization ${s.pending.error || 'failed'}.`;
      }
    } catch {}
  }, 3000);
}

async function githubDisconnect() {
  stopGithubPoll();
  try { renderGithubStatus(await (await fetch('/github/disconnect', { method: 'POST' })).json()); }
  catch {}
}
ghConnectEl?.addEventListener('click', githubConnect);
ghDisconnectEl?.addEventListener('click', githubDisconnect);

async function ensureModelsList() {
  if (settingsModelsList.length) return;
  try {
    const r = await fetch('/settings/models');
    if (r.ok) settingsModelsList = (await r.json()).models || [];
  } catch (err) { console.warn('[settings] model list fetch failed', err); }
}

async function ensureRolesList() {
  if (settingsRolesList.length) return;
  try {
    const r = await fetch('/roles');
    if (r.ok) settingsRolesList = (await r.json()).roles || [];
  } catch (err) { console.warn('[settings] roles fetch failed', err); }
}

async function openSettings() {
  if (settingsOpen || editBubbleOpen || confirmCancelOpen || projectEditOpen) return;
  playSfx('select');   // settings icon press
  settingsOpen = true;
  settingsModalEl.hidden = false;
  selectSettingsTab('general');
  settingsApiKeyEl.value = '';
  let s = {};
  try {
    const r = await fetch('/settings');
    if (r.ok) s = await r.json();
  } catch {}
  apiKeyIsSet = !!s.OPENROUTER_API_KEY_SET;
  if (apiKeyIsSet) settingsApiKeyEl.value = API_KEY_PLACEHOLDER;
  await Promise.all([ensureModelsList(), ensureRolesList()]);
  populateModelSelect(s.OPENROUTER_MODEL || '');
  populateRouterModelSelect(s.OPENROUTER_ROUTER_MODEL || '');
  populateRoleModels(s.OPENROUTER_MODEL_BY_ROLE || {}, s.OPENROUTER_MODEL_DEFAULT_BY_ROLE || {});
  populateCouncilModels(s.OPENROUTER_COUNCIL_MODELS || []);
  if (settingsInstructionsEl) settingsInstructionsEl.value = s.AI_INSTRUCTIONS || '';
  populateMcpList(s.MCP_PLUGINS || []);
  populateSkills();
  if (ghClientIdEl) ghClientIdEl.value = s.GITHUB_OAUTH_CLIENT_ID || '';
  if (ghDeviceEl) ghDeviceEl.hidden = true;
  refreshGithubStatus();
  settingsGitEnabledEl.checked = !!s.GIT_AUTOSAVE;
  if (settingsTiersEl) settingsTiersEl.checked = !!s.OPENROUTER_TIERS;
  settingsGitIntervalEl.value = Number(s.GIT_AUTOSAVE_INTERVAL_MIN || 5);
  if (settingsSttUrlEl) settingsSttUrlEl.value = s.LOCAL_STT_URL || '';
  // Keep the local STT cache in sync with the server.
  localSttUrl = s.LOCAL_STT_URL || '';
  paintGitState();
  await refreshHealthPane();
  if (settingsHealthTimer) clearInterval(settingsHealthTimer);
  settingsHealthTimer = setInterval(() => {
    if (!settingsOpen) return;
    if (settingsTabEls.find(t => t.dataset.tab === 'health' && t.getAttribute('aria-selected') === 'true')) {
      refreshHealthPane();
    }
  }, 8000);
  // Land focus on the first tab so the user can immediately navigate
  // with arrows / d-pad.
  setTimeout(() => settingsTabEls[0]?.focus(), 0);
}

function closeSettings() {
  settingsModalEl.hidden = true;
  settingsOpen = false;
  stopGithubPoll();
  if (settingsHealthTimer) { clearInterval(settingsHealthTimer); settingsHealthTimer = null; }
}

async function maybeCancelCurrentOperation(token = currentCancelToken) {
  if (!token) return false;
  if (currentCancelToken === token) currentCancelToken = null;
  try { await cancelOperation(token); }
  catch {}
  return true;
}

function cancelActiveRequest() {
  if (!inflightController && !currentCancelToken) return;
  const token = currentCancelToken;
  if (inflightController) {
    inflightController.abort();
    inflightController = null;
  }
  maybeCancelCurrentOperation(token);
  setIndicator('idle', 'Canceled');
}

/* Detach from the in-flight run WITHOUT canceling it — the agent keeps working
 * server-side and its result lands in history / over SSE (visible when you
 * return). Used by navigation (Back, switch agent, leave project); only the
 * Stop button or a superseding submit actually cancels a run. */
function releaseActiveRequest() {
  if (inflightController) { try { inflightController.abort(); } catch {} inflightController = null; }
  currentCancelToken = null;   // forget the token; do NOT cancel it server-side
}

async function refreshHealthPane() {
  if (!settingsHealthEl) return;
  try {
    const payload = await fetchHealth();
    renderHealth(settingsHealthEl, payload);
  } catch (err) {
    settingsHealthEl.innerHTML = `<p class="settings-meta">Health checks unavailable: ${escapeHtml(err?.message || String(err))}</p>`;
  }
}

/** Every focusable in the modal, in visual order: tabs → active-pane
 *  controls → action-row buttons. */
function settingsFocusables() {
  const tabs = settingsTabEls;
  const activePane = settingsPaneEls.find(p => !p.hidden);
  const paneFocusables = activePane
    ? [...activePane.querySelectorAll('input, select, textarea, button, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null)
    : [];
  const actions = [settingsCancelEl, settingsSaveEl].filter(Boolean);
  return [...tabs, ...paneFocusables, ...actions];
}

function focusNextInModal(delta) {
  const items = settingsFocusables();
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement);
  const next = items[(i + delta + items.length) % items.length];
  if (next && next !== document.activeElement) playSfx('navigate');   // settings: cursor move
  next?.focus();
}

/* Gamepad input for the settings modal. Mirrors the keyboard model:
 * dpad navigates, cross activates, circle closes. */
function handleSettingsGamepad(button) {
  const active = document.activeElement;
  const isTab = settingsTabEls.includes(active);
  if (button === 'circle') { closeSettings(); return; }
  if (button === 'cross') {
    if (active === settingsCancelEl) { playSfx('select'); closeSettings(); return; }
    if (active === settingsSaveEl)   { saveSettings(); return; }
    if (active && active.tagName === 'BUTTON') { active.click(); return; }
    if (active && active.type === 'checkbox')  { playSfx('select'); active.checked = !active.checked; return; }
    // Default: treat as Save.
    saveSettings();
    return;
  }
  if (isTab && (button === 'left' || button === 'right')) {
    const i = settingsTabEls.indexOf(active);
    const next = settingsTabEls[(i + (button === 'right' ? 1 : -1) + settingsTabEls.length) % settingsTabEls.length];
    playSfx('navigate');
    selectSettingsTab(next.dataset.tab);
    next.focus();
    return;
  }
  if (isTab && button === 'down') {
    const items = settingsFocusables();
    const firstPane = items.find(el => !settingsTabEls.includes(el) && el !== settingsCancelEl && el !== settingsSaveEl);
    playSfx('navigate');
    (firstPane || settingsSaveEl)?.focus();
    return;
  }
  // Up from a tab goes to the × close button (above the tab strip).
  if (isTab && button === 'up') { playSfx('navigate'); settingsCloseEl?.focus(); return; }
  // From the close button: Down returns to the active tab; Up/Left/Right stay put.
  if (active === settingsCloseEl) {
    if (button === 'down') {
      playSfx('navigate');
      (settingsTabEls.find(t => t.getAttribute('aria-selected') === 'true') || settingsTabEls[0])?.focus();
    }
    return;
  }
  if (button === 'up')   { focusNextInModal(-1); return; }
  if (button === 'down') { focusNextInModal(+1); return; }
  if ((button === 'left' || button === 'right') && (active === settingsCancelEl || active === settingsSaveEl)) {
    playSfx('navigate');
    (active === settingsSaveEl ? settingsCancelEl : settingsSaveEl)?.focus();
    return;
  }
}

/* Modal-scoped keyboard handler. */
settingsModalEl?.addEventListener('keydown', (e) => {
  if (!settingsOpen) return;

  // Escape closes from anywhere in the modal.
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }

  const active = document.activeElement;
  const isTab = settingsTabEls.includes(active);

  // Inside a multi-line textarea (e.g. Instructions), arrows move the caret;
  // only hop focus at the text edges — Left/Right always edit, Up navigates out
  // only when the caret is at the very start, Down only at the very end. At a
  // boundary we fall through to the normal nav branches below.
  const ta = active && active.tagName === 'TEXTAREA' ? active : null;
  if (ta) {
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    if (e.key === 'ArrowUp' && !atStart) return;
    if (e.key === 'ArrowDown' && !atEnd) return;
  }

  // The × close button sits above the tab strip: Down returns to the active
  // tab; Up/Left/Right stay put (it's the top-most control). Enter/Escape fall
  // through to native activation / the Escape branch above.
  if (active === settingsCloseEl) {
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      playSfx('navigate');
      (settingsTabEls.find(t => t.getAttribute('aria-selected') === 'true') || settingsTabEls[0])?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();   // swallow — nothing above the close button
    }
    return;
  }

  // Up from a tab goes to the × close button (above the tab strip).
  if (isTab && e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    playSfx('navigate');
    settingsCloseEl?.focus();
    return;
  }

  // Left/Right cycles tabs when a tab is focused.
  if (isTab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); e.stopPropagation();
    const i = settingsTabEls.indexOf(active);
    const next = settingsTabEls[(i + (e.key === 'ArrowRight' ? 1 : -1) + settingsTabEls.length) % settingsTabEls.length];
    playSfx('navigate');
    selectSettingsTab(next.dataset.tab);
    next.focus();
    return;
  }

  // Down from a tab enters the active pane.
  if (isTab && e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    const items = settingsFocusables();
    const firstPane = items.find(el => !settingsTabEls.includes(el) && el !== settingsCancelEl && el !== settingsSaveEl);
    playSfx('navigate');
    (firstPane || settingsSaveEl)?.focus();
    return;
  }

  // Up from a pane control returns to the tab strip.
  if (!isTab && e.key === 'ArrowUp') {
    const items = settingsFocusables();
    const i = items.indexOf(active);
    const prev = items[i - 1];
    if (prev && settingsTabEls.includes(prev)) {
      e.preventDefault(); e.stopPropagation();
      playSfx('navigate');
      settingsTabEls.find(t => t.getAttribute('aria-selected') === 'true')?.focus();
      return;
    }
    // Otherwise step backward in the list.
    e.preventDefault(); e.stopPropagation();
    focusNextInModal(-1);
    return;
  }

  // Down within pane: next focusable.
  if (!isTab && e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    focusNextInModal(+1);
    return;
  }

  // Left/Right walk the focusables list — same as Up/Down — so the
  // user can reach the − / + stepper buttons (visually to the right
  // of the interval input) without pressing ArrowDown twice.
  if (!isTab && e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
    focusNextInModal(+1);
    return;
  }
  if (!isTab && e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopPropagation();
    focusNextInModal(-1);
    return;
  }

  // Enter on Cancel/Save activates them; Enter on an input triggers save
  // unless we're on a button (which has its own click handler).
  if (e.key === 'Enter') {
    if (active === settingsCancelEl) { e.preventDefault(); e.stopPropagation(); playSfx('select'); closeSettings(); return; }
    if (active === settingsSaveEl)   { e.preventDefault(); e.stopPropagation(); saveSettings(); return; }
    if (active && active.tagName === 'BUTTON') { e.preventDefault(); e.stopPropagation(); active.click(); return; }
    if (active && (active.tagName === 'INPUT' && active.type !== 'checkbox')) {
      e.preventDefault(); e.stopPropagation(); saveSettings(); return;
    }
    if (active && active.type === 'checkbox') { e.preventDefault(); e.stopPropagation(); playSfx('select'); active.checked = !active.checked; return; }
  }

  // Space toggles checkboxes (HTML default already does this, but make
  // it explicit so it doesn't bubble out to the surface PTT handler).
  if (e.key === ' ' && active && active.type === 'checkbox') {
    e.stopPropagation();
  }
});

async function saveSettings() {
  playSfx('select');   // confirm the press, like other buttons
  const updates = {};
  const apiKey = settingsApiKeyEl.value.trim();
  // Don't ship the placeholder back — that would clobber the real
  // key with literal asterisks.
  if (apiKey && apiKey !== API_KEY_PLACEHOLDER) updates.OPENROUTER_API_KEY = apiKey;
  const model = (settingsModelEl.value || '').trim();
  if (model) updates.OPENROUTER_MODEL = model;
  const routerModel = (settingsRouterModelEl?.value || '').trim();
  if (routerModel) updates.OPENROUTER_ROUTER_MODEL = routerModel;
  const ghClientId = (ghClientIdEl?.value || '').trim();
  if (ghClientId) updates.GITHUB_OAUTH_CLIENT_ID = ghClientId;

  const byRole = {};
  for (const sel of settingsRoleModelsEl.querySelectorAll('select')) {
    const v = sel.value.trim();
    if (v) byRole[sel.dataset.role] = v;
  }
  updates.OPENROUTER_MODEL_BY_ROLE = byRole;
  updates.OPENROUTER_COUNCIL_MODELS = settingsCouncilEls.map((sel) => (sel?.value || '').trim()).filter(Boolean);
  if (settingsInstructionsEl) updates.AI_INSTRUCTIONS = settingsInstructionsEl.value;
  updates.MCP_PLUGINS = settingsMcpEntries;
  updates.GIT_AUTOSAVE = !!settingsGitEnabledEl.checked;
  // Only write the tiering flag when its control is present — otherwise a save
  // would silently clobber the setting (no checkbox in the UI right now).
  if (settingsTiersEl) updates.OPENROUTER_TIERS = !!settingsTiersEl.checked;
  updates.GIT_AUTOSAVE_INTERVAL_MIN = Math.max(1, Math.min(120, Number(settingsGitIntervalEl.value) || 5));
  if (settingsSttUrlEl) {
    const url = settingsSttUrlEl.value.trim();
    updates.LOCAL_STT_URL = url;
    localSttUrl = url;
  }

  try {
    const r = await fetch('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!r.ok) throw new Error(await r.text());
  } catch (err) {
    console.error('[settings] save failed', err);
  }
  closeSettings();
}

settingsMcpAddEl?.addEventListener('click', () => {
  const id = prompt('MCP plugin id (e.g. anthropic/filesystem)?');
  if (!id) return;
  const name = prompt('Display name?', id) || id;
  settingsMcpEntries.push({ id: id.trim(), name: name.trim(), enabled: true });
  populateMcpList(settingsMcpEntries);
});

// Blur after opening — same stuck-focus trap as the fullscreen button: a
// focused gear re-fires on the next Enter meant for a tile.
settingsBtnEl?.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); settingsBtnEl.blur(); });
settingsBtnEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    openSettings();
    settingsBtnEl.blur();
  }
});
settingsSaveEl?.addEventListener('click', () => saveSettings());
settingsCancelEl?.addEventListener('click', () => { playSfx('select'); closeSettings(); });
document.getElementById('settings-close')?.addEventListener('click', () => { playSfx('select'); closeSettings(); });

/* ---------- Full-screen toggle ---------- */
const fullscreenBtnEl = document.getElementById('fullscreen-btn');
/* In the Electron host we drive native window full screen over IPC — it shows
 * no "press and hold Esc" notice and leaves Esc free to act as Back. In a plain
 * browser we fall back to HTML element full screen + Keyboard Lock. */
const fsBridge = window.bridge;          // present only under Electron
let electronFs = false;                   // tracks native window full-screen state
function isFullscreen() { return fsBridge ? electronFs : !!document.fullscreenElement; }
function toggleFullscreen() {
  playSfx('select');   // fullscreen icon press
  if (fsBridge) { fsBridge.toggleFullscreen(); return; }
  if (isFullscreen()) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().then(lockEscapeKey).catch(() => {});
}
/* Keyboard Lock (browser fallback only) — capture Esc in HTML full screen so a
 * tap reaches the page (Back) instead of leaving full screen. */
function lockEscapeKey() { try { navigator.keyboard?.lock?.(['Escape']); } catch {} }
function unlockKeyboard() { try { navigator.keyboard?.unlock?.(); } catch {} }
function paintFullscreenIcon() {
  if (!fullscreenBtnEl) return;
  const fs = isFullscreen();
  fullscreenBtnEl.querySelector('.fs-enter')?.toggleAttribute('hidden', fs);
  fullscreenBtnEl.querySelector('.fs-exit')?.toggleAttribute('hidden', !fs);
  const label = fs ? 'Exit full screen' : 'Enter full screen';
  fullscreenBtnEl.setAttribute('aria-label', label);
  fullscreenBtnEl.setAttribute('title', fs ? 'Exit full screen' : 'Full screen');
}
/* Blur after acting: the button would otherwise keep DOM focus, staying
 * highlighted through card navigation and re-firing on the next Enter
 * (surprise full-screen exit while selecting a tile). */
fullscreenBtnEl?.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); fullscreenBtnEl.blur(); });
fullscreenBtnEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    toggleFullscreen();
    fullscreenBtnEl.blur();
  }
});
if (fsBridge) {
  fsBridge.onFullscreenChange((v) => { electronFs = v; paintFullscreenIcon(); });
  fsBridge.isFullscreen?.().then((v) => { electronFs = !!v; paintFullscreenIcon(); }).catch(() => {});
  // Esc in native full screen arrives via IPC (main intercepts the raw key so
  // macOS can't exit full screen with it). Re-dispatch it from <body> so it
  // bubbles through every normal Esc handler — modals, bubble nav, Back.
  fsBridge.onEscapePressed?.(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
} else {
  document.addEventListener('fullscreenchange', () => {
    paintFullscreenIcon();
    if (isFullscreen()) lockEscapeKey(); else unlockKeyboard();
  });
}

// Cmd/Ctrl+F toggles full screen in and out. Capture phase + preventDefault so
// it works regardless of focus or open modals and overrides the browser's Find.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    toggleFullscreen();
  }
}, true);

window.addEventListener('keydown', (e) => {
  // Settings modal owns the keyboard while it's open — let its own
  // handler take care of Esc / Tab / arrows / Enter. Notifications too, so
  // Esc only closes the menu rather than also triggering Back.
  if (settingsOpen || editBubbleOpen || confirmCancelOpen || projectEditOpen || notificationsOpen) return;

  // Mode at handler entry. A branch below (e.g. add-agent Cancel/Esc → renderGrid)
  // can flip `mode` mid-handler; the trailing MODE_GRID/MODE_ZOOM blocks are a
  // SEPARATE `if`, so without this they'd then re-process the same keypress as a
  // grid press (Enter on the Add tile → the picker reopens). Guard them on the
  // mode we entered with, not the possibly-mutated live one.
  const entryMode = mode;

  // Escape is a one-shot back action — ignore auto-repeat. Otherwise a held Esc
  // fires repeated keydowns that over-navigate (e.g. add-agent → L1 → L0).
  if (e.key === 'Escape' && e.repeat) { e.preventDefault(); return; }

  // A footer hold chip (talk / reasoning) is being held via Enter: swallow every
  // Enter keydown for the duration. The first press started the hold through the
  // rail branch below, but startPTT clears footer focus — so without this the
  // auto-repeat Enters would fall through and fire the screen's default Enter
  // action over and over. keyup ends the hold (global keyup handler).
  if (e.key === 'Enter' && _footerHoldEl) { e.preventDefault(); return; }

  // Reasoning-effort picker: hold R, nudge ↑/↓, release R to set.
  const _typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!_typing) {
    if ((e.key === 'r' || e.key === 'R') && !e.repeat) { e.preventDefault(); openEffortPicker(); return; }
    if (effortPickerOpen) {
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveEffortPicker(+1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveEffortPicker(-1); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeEffortPicker(); return; }
      return;  // swallow other keys while picking
    }
  }

  // × close button focused (reached via Up from the first row): Down returns to
  // the content; the other arrows rubberband — matches the gamepad behavior.
  {
    const closeBtn = surfaceEl.querySelector('.surface-close');
    if (closeBtn && document.activeElement === closeBtn) {
      if (e.key === 'Enter')      { e.preventDefault(); closeBtn.click(); return; }
      if (e.key === 'ArrowDown')  {
        e.preventDefault(); closeBtn.blur();
        if (mode === MODE_ZOOM && chatBubbles.length) focusLastBubble();
        else ring.paint();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); return; }  // no rubberband on the × close
    }
  }

  if (document.activeElement === typedInput) {
    if (e.key === 'Enter') {
      const t = typedInput.value.trim();
      typedInput.value = ''; typedWrap.hidden = true;
      if (t) submitTypedText(t);
    } else if (e.key === 'Escape') {
      typedInput.value = ''; typedWrap.hidden = true;
    }
    return;
  }
  // Any other text field / textbox focused → it owns the keystroke; never fire
  // bare-key shortcuts or footer-rail nav while the user is typing.
  if (isTextInputFocused()) return;
  // Bare-letter shortcuts (v=talk, e=explorer, m=memory, a=activity, /=type)
  // must NOT hijack OS/browser combos — otherwise ⌘V triggers push-to-talk and
  // preventDefault() eats the paste, ⌘A blocks select-all, etc.
  const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;

  // Hold 'v' for push-to-talk (voice).
  if (bareKey && e.key === 'v' && !e.repeat) {
    e.preventDefault();
    if (mode === MODE_PROJECTS) talkToFocusedLead();
    else startPTT();
    return;
  }

  if (bareKey && (e.key === 'e' || e.key === 'E')) {
    // toggleFileExplorer bails outside the surface modes (L1 / L2 /
    // add-agent), so no extra guard needed here.
    e.preventDefault();
    playSfx('select');
    toggleFileExplorer();
    return;
  }
  if (bareKey && (e.key === 'm' || e.key === 'M')) {
    if (mode === MODE_PROJECTS) {
      e.preventDefault();
      toggleMemoryDrawer();
      return;
    }
  }
  if (bareKey && (e.key === 'a' || e.key === 'A')) {
    if (mode === MODE_GRID || mode === MODE_ZOOM ||
        mode === MODE_ADD_AGENT || mode === MODE_PROJECTS) {
      e.preventDefault();
      playSfx('select');
      toggleActivityDrawer();
      return;
    }
  }
  // Type-prompt is for talking to an agent / council / capture — not the L0
  // projects grid or the L1 project grid.
  if (bareKey && e.key === '/' && mode !== MODE_PROJECTS && mode !== MODE_GRID) {
    e.preventDefault(); playSfx('select'); typedWrap.hidden = false; typedInput.focus(); return;
  }

  // Universal Tab: jumps focus into the footer rail from anywhere. Once
  // there, the rail keydown handler below takes over.
  if (e.key === 'Tab' && !e.shiftKey && !isShortcutsFocused() && !fileExplorerOpen) {
    if (enterShortcuts()) { e.preventDefault(); return; }
  }

  const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const dir = dirMap[e.key];

  // File explorer (overlay at L1/L2) intercepts navigation while the
  // explorer holds focus. Right-arrow exits the explorer to the right.
  if (fileExplorerOpen && explorerFocused) {
    // Explorer is a vertical list — Up/Down walk it; Left is swallowed.
    if (e.key === 'ArrowUp')    { e.preventDefault(); stepFileFocus(-1); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); stepFileFocus(+1); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); return; }
    // Right exits the list to the right: into the open viewer's text box, or
    // (no viewer) onto the first grid tile.
    if (e.key === 'ArrowRight') { e.preventDefault(); exitExplorerRight(); return; }
    if (e.key === 'Enter')      { e.preventDefault(); openFocusedFile(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeFileExplorer(); return; }
  }
  // Activity feed (left drawer) — view-only: Up/Down highlight entries, Right
  // leaves to the grid, Esc closes. Left is swallowed. No open (Enter).
  if (activityDrawerOpen && activityFocused) {
    if (e.key === 'ArrowUp')    { e.preventDefault(); stepActivityFocus(-1); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); stepActivityFocus(+1); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); exitActivityRight(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeActivityDrawer(); ring.paint(); return; }
    if (e.key === 'Enter')      { e.preventDefault(); return; }   // view-only feed — Enter does nothing on an entry
  }
  // Shortcuts rail (bottom-left) is part of the focus order: arrow-down
  // from the main surface enters it; arrow-up exits back to the grid.
  if (isShortcutsFocused()) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); moveShortcutFocus(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveShortcutFocus(+1); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); return; }   // already the bottom row — no rubberband
    if (e.key === 'ArrowUp')    {
      e.preventDefault();
      leaveShortcuts();
      // Agent view with no tile-surface ring: jump straight to the newest
      // bubble instead of landing in an empty middle row.
      if (mode === MODE_ZOOM && ring.elements.length === 0 && chatBubbles.length > 0) focusLastBubble();
      else ring.paint();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const el = footerFocusables()[shortcutFocusIdx];
      if (el?._hold) { if (!e.repeat) beginChipHold(el); }   // press-and-hold chip (talk / reasoning)
      else activateFocusedShortcut();
      return;
    }
    if (e.key === 'Escape')     { e.preventDefault(); leaveShortcuts(); ring.paint(); return; }
  }

  if (mode === MODE_PROJECTS) {
    if (dir) {
      // pickerMove owns edge behavior: Down off the last content row drops
      // into the footer rail; other off-grid presses rubberband (no wrap).
      // ([ / ] intentionally do nothing on L0 — there's no "adjacent project"
      // to cycle to from the picker itself.)
      e.preventDefault(); pickerMove(dir);
    }
    else if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      if (ring.index < projects.length) startProjectHold(ring.index); // hold a project → edit modal
      else openFocused();                                             // "+ New" → open now
    }
  } else if (mode === MODE_NEW_PROJ_TOPOLOGY) {
    if (e.key === 'ArrowLeft')       { e.preventDefault(); topoMoveCard(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); topoMoveCard(+1); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); if (ring.index >= TOPOLOGIES.length) enterShortcuts(); else topoFocusBack(); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); if (ring.index >= TOPOLOGIES.length) topoFocusCards(); else focusSurfaceClose(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = ring.current();
      if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId);
      else c?.click?.();
    }
    else if (e.key === 'Escape')    { e.preventDefault(); goBackInCreateFlow(); }
  } else if (mode === MODE_NEW_PROJ_ROLES) {
    if (e.key === 'ArrowUp') {
      const grid = surfaceEl.querySelector('.role-grid');
      const cols = grid?._cols || 4;
      if (Math.floor(ring.index / cols) === 0 && focusSurfaceClose()) { e.preventDefault(); return; }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (advanceDownFromRolePicker()) return;
      roleGridMove('down');
    } else if (dir) { e.preventDefault(); roleGridMove(dir); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = ring.current();
      // Enter = Select: on the Cancel/Back/Continue buttons it presses them; on
      // a role tile it toggles the checkbox. Advance via the Continue button.
      if (cur && !cur.classList?.contains('role-tile') && typeof cur.click === 'function') {
        cur.click();
      } else {
        toggleFocusedRole();
      }
    }
    else if (e.key === 'Escape')  { e.preventDefault(); goBackInCreateFlow(); }
  } else if (mode === MODE_ADD_AGENT) {
    // roleGridMove owns edge behavior (Up → × close, reading-order Left/Right
    // incl. Cancel ⟷ Continue, Down → nearer bottom button). No inline
    // right→close, which wrongly treated the Cancel button as a grid tile.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (advanceDownFromRolePicker()) return;
      roleGridMove('down');
    } else if (dir) { e.preventDefault(); roleGridMove(dir); }
    else if (e.code === 'Space')  { e.preventDefault(); toggleFocusedAddAgentRole(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = ring.current();
      if (cur && !cur.classList?.contains('role-tile') && typeof cur.click === 'function') {
        cur.click();
      } else {
        commitAddAgentSelections();
      }
    }
    else if (e.key === 'Escape')  { e.preventDefault(); renderGrid(); }
  } else if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL || mode === MODE_NEW_PROJ_FEATURES) {
    // Action-row buttons (Cancel · Back · Continue/Create) form the
    // ring. Left/Right walks them; Enter activates the focused one.
    if (e.key === 'ArrowLeft')  { e.preventDefault(); ring.move(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); focusSurfaceClose(); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); enterShortcuts(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cur = ring.current();
      if (cur && typeof cur.click === 'function') cur.click();
      else confirmCapture();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); goBackInCreateFlow(); return; }
  } else if (mode === MODE_COUNCIL) {
    // Number keys quick-pick an intake option when not navigating bubbles.
    // Everything else (arrow nav, Submit, Skip, Other, Escape) is the shared
    // selectable-bubble model in the entryMode === MODE_COUNCIL branch below.
    if (councilState?.phase === 'intake' && !isBubbleFocused()) {
      const cur = councilState.questions[councilState.idx];
      const n = Number(e.key);
      if (cur && Number.isInteger(n) && n >= 1 && cur.options[n - 1] !== undefined) {
        e.preventDefault(); answerCouncilIntake(cur.options[n - 1]); return;
      }
    }
  }

  // Viewer text container holds focus — Up jumps to the × button, Left hops
  // back into the explorer, Right highlights the surface container to the
  // right, Down nudge-scrolls, Esc closes.
  if (viewerBodyFocused) {
    if (e.key === 'ArrowUp')    { e.preventDefault(); playSfx('navigate'); setViewerBodyFocus(false); fileViewerCloseEl?.focus(); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); fileViewerBodyEl.scrollBy({ top: 80, behavior: 'instant' }); return; }
    if (e.key === 'ArrowLeft' && fileExplorerOpen) {
      e.preventDefault(); playSfx('navigate'); setViewerBodyFocus(false); explorerFocused = true; paintFileFocus(); return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); setViewerBodyFocus(false); setSurfaceContainerFocus(true); return; }
    if (e.key === 'Enter')      { e.preventDefault(); fileViewerBodyEl.scrollBy({ top: 80, behavior: 'instant' }); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeFileViewerToExplorer(); return; }
  }

  // Whole surface container highlighted (arrowed right off the viewer body):
  // Left returns to the body, Enter drops into the grid, Esc steps back.
  if (surfaceContainerFocused) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setSurfaceContainerFocus(false); if (fileViewerOpen) setViewerBodyFocus(true); else if (fileExplorerOpen) { explorerFocused = true; paintFileFocus(); } return; }
    if (e.key === 'Enter')      { e.preventDefault(); setSurfaceContainerFocus(false); ring.paint(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); setSurfaceContainerFocus(false); if (fileViewerOpen) setViewerBodyFocus(true); return; }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); return; }   // whole-container highlight — other arrows stay put
  }

  // Surface holds "close viewer" focus — Enter closes; Left returns to ×.
  if (surfaceCloseFocused) {
    if (e.key === 'Enter')      { e.preventDefault(); closeFileViewerToExplorer(); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setSurfaceCloseFocus(false); fileViewerCloseEl?.focus(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeFileViewerToExplorer(); return; }
  }

  // File viewer (right panel) — Esc closes it before any back navigation,
  // returning the highlight to the open file in the explorer.
  if (fileViewerOpen && e.key === 'Escape') {
    e.preventDefault();
    closeFileViewerToExplorer();
    return;
  }

  if (entryMode === MODE_GRID) {
    // (gridMove/stepGrid own edge behavior: Up from the first row jumps to the
    // × close, Left/Right flow across rows, Down drops into the footer rail.)
    // Left from the leftmost grid column with the explorer open hops
    // focus back into the explorer.
    if (e.key === 'ArrowLeft' && (fileExplorerOpen || activityDrawerOpen) && !explorerFocused && !activityFocused) {
      const grid = surfaceEl.querySelector('.agent-grid');
      const cols = grid?._cols || 4;
      if ((ring.index % cols) === 0) {
        e.preventDefault();
        if (activityDrawerOpen) enterActivityFromSurface('first'); else enterExplorerFromSurface();
        return;
      }
    }
    if (dir) {
      // gridMove owns edge behavior: Down off the last content row drops into
      // the footer rail; other off-grid presses rubberband (no wrap).
      e.preventDefault(); gridMove(dir);
    }
    else if (e.key === 'Enter') { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitToProjects(); }
    else if (e.code === 'Space') { e.preventDefault(); toggleFocusedAgentEnabled(); }
    else if (e.key === '[')      { e.preventDefault(); cycleProject(-1); }
    else if (e.key === ']')      { e.preventDefault(); cycleProject(+1); }
  } else if (entryMode === MODE_ZOOM) {
    // Chat bubble selection. ArrowUp from the surface enters the chat
    // history at the last bubble; once inside, ArrowUp/Down walks
    // bubbles, Left/Right cycles their action icons, Enter activates.
    if (isBubbleFocused() && bubbleNavKeydown(e)) return;
    // Up / Right hops to the × close button, unless we're entering the
    // chat history (handled above) or already on a tile-surface focusable.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowRight') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
      if (ring.index === 0 && e.key === 'ArrowUp' && chatBubbles.length > 0) {
        e.preventDefault(); focusLastBubble(); return;
      }
      if (ring.index === 0 && focusSurfaceClose()) { e.preventDefault(); return; }
    }
    // Left at the first ring position with explorer open hops back in.
    if (e.key === 'ArrowLeft' && (fileExplorerOpen || activityDrawerOpen) && !explorerFocused && !activityFocused && ring.index === 0) {
      e.preventDefault();
      if (activityDrawerOpen) enterActivityFromSurface('first'); else enterExplorerFromSurface();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const lastIdx = Math.max(0, ring.elements.length - 1);
      if ((ring.elements.length === 0 || ring.index === lastIdx) && enterShortcuts()) return;
      ring.move(+1);
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')      { e.preventDefault(); ring.move(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
    else if (e.key === 'Enter')      { e.preventDefault(); pressCross(); }
    else if (e.key === 'Escape')     { e.preventDefault(); pressCircle(); }
    else if (e.key === '[')          { e.preventDefault(); cycleAgent(-1); }
    else if (e.key === ']')          { e.preventDefault(); cycleAgent(+1); }
  } else if (entryMode === MODE_COUNCIL) {
    // Council uses the same selectable-bubble model as agent L2.
    if (isBubbleFocused() && bubbleNavKeydown(e)) return;
    // ArrowUp from the surface enters the chat at the last bubble.
    if (e.key === 'ArrowUp' && chatBubbles.length) { e.preventDefault(); focusLastBubble(); return; }
    if (e.key === 'Escape') { e.preventDefault(); exitCouncilToGrid(); return; }
  }
});

function submitTypedText(text) {
  if (mode === MODE_PROJECTS) { dispatchHomeUtterance(text); return; }
  // Capture screens: a typed value lands in the box above (like a voice
  // transcript) and re-renders the SAME screen so the user can review it and
  // press Continue / Done — it must NOT silently auto-advance or auto-create.
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = titleCaseName(text.trim()); renderNewProjectName(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = appendCaptureBlock(newProjGoal, text); renderNewProjectGoal(); revealCaptureText(); return; }
  if (mode === MODE_NEW_PROJ_FEATURES) { newProjFeatures = appendCaptureBlock(newProjFeatures, text); renderNewProjectFeatures(); revealCaptureText(); return; }
  if (mode === MODE_COUNCIL) { routeCouncilInput(text); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
}

/* Council input (typed or dictated): during intake it answers the current
 * question (incl. a held "Other"); otherwise it starts a new council question. */
function routeCouncilInput(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (councilState?.phase === 'intake') answerCouncilIntake(t);
  else startCouncilIntake(t);
}

async function submitIntent(text, regenerate = 0) {
  const agent = currentAgent();
  if (!agent || mode !== MODE_ZOOM) return;
  const targetId = agent.id;
  clearUnseen(agent.id);   // the user is responding → no longer awaiting them
  if (regenerate === 0) _redoStreak = { text: null, n: 0 };  // a fresh prompt resets the redo streak
  // Lock the optimistic bubble to the final transcript while the agent thinks
  // (it's replaced by the persisted bubble when history re-renders).
  if (pendingUserBubbleEl) { pendingUserBubbleEl.classList.remove('pending'); updatePendingBubble(text); }
  // Immediately show an agent "…" bubble so the reply feels instant; the
  // streaming bubble reuses it (or the history re-render replaces it).
  showPendingAgentBubble();
  if (inflightController) cancelActiveRequest();
  inflightController = new AbortController();
  const myCtl = inflightController;
  let opToken = null;
  try {
    opToken = await createOperationToken({ kind: 'agent_interpret', projectId: activeProject.id, ownerAgentId: targetId });
    currentCancelToken = opToken;
  } catch { opToken = null; currentCancelToken = null; }

  agentBusy[targetId] = true;
  setIndicator('thinking', `${agent.name} is thinking…`);
  resetStreaming();
  streamingAgentId = targetId;   // accept streamed tokens for this reply
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${targetId}/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        regenerate,
        effort: effortForAgent(activeProject.id, targetId),
        cancelToken: opToken,
      }),
      signal: myCtl.signal,
    });
    if (!r.ok) {
      let detail = `server ${r.status}`;
      try { const e = await r.json(); if (e?.error) detail = String(e.error); } catch {}
      throw new Error(detail);
    }
    const spec = await r.json();
    const a = activeProject.agents.find(x => x.id === targetId);
    if (a) a.lastSpec = spec;
    if (mode === MODE_ZOOM && currentAgent()?.id === targetId) {
      setIndicator('idle', 'Connected');
      renderZoom(spec);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    showErrorBubble(err?.message || 'Request failed');
    setIndicator('error', 'Request failed');
  } finally {
    agentBusy[targetId] = false;
    if (myCtl === inflightController) inflightController = null;
    if (currentCancelToken === opToken) currentCancelToken = null;
    resetStreaming();
  }
}
async function submitTeamIntent(text) {
  if (mode !== MODE_GRID || !activeProject) return;
  const leadId = activeProject.leadAgentId;
  if (inflightController) cancelActiveRequest();
  inflightController = new AbortController();
  const myCtl = inflightController;
  let opToken = null;
  try {
    opToken = await createOperationToken({ kind: 'team_interpret', projectId: activeProject.id, ownerAgentId: leadId });
    currentCancelToken = opToken;
  } catch { opToken = null; currentCancelToken = null; }
  agentBusy[leadId] = true;
  setIndicator('thinking', 'Lead is delegating…');
  renderGrid();

  try {
    const r = await fetch(`/projects/${activeProject.id}/team/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, effort: effortForProject(activeProject.id), cancelToken: opToken }),
      signal: myCtl.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const result = await r.json();

    if (result.blocked) {
      setIndicator('error', 'Team voice blocked');
      speak(result.summary.body || '');
      showTeamSummary(result.summary);
      return;
    }

    for (const asg of (result.routing?.assignments || [])) {
      agentBusy[asg.agentId] = true;
    }
    renderGrid();

    for (const [aid, spec] of Object.entries(result.perAgent || {})) {
      const a = activeProject.agents.find(x => x.id === aid);
      if (a && spec) a.lastSpec = spec;
      agentBusy[aid] = false;
    }
    agentBusy[leadId] = false;
    renderGrid();
    showTeamSummary(result.summary);
    if (result.summary?.body) speak(result.summary.body);
    setIndicator('idle', 'Connected');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setIndicator('error', 'Team voice failed');
    console.error(err);
  } finally {
    for (const a of activeProject.agents) agentBusy[a.id] = false;
    if (myCtl === inflightController) inflightController = null;
    if (currentCancelToken === opToken) currentCancelToken = null;
  }
}

function showTeamSummary(spec) {
  if (!spec) return;
  document.querySelectorAll('.team-summary').forEach(el => el.remove());
  const banner = document.createElement('section');
  banner.className = 'team-summary';
  banner.innerHTML = `
    <div class="ts-title">${escapeHtml(spec.title || 'Team')}</div>
    <div class="ts-body">${escapeHtml(spec.body || '')}</div>
    <button class="ts-close" type="button">Dismiss</button>`;
  banner.querySelector('.ts-close').addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 25_000);
}

let _creatingProject = false;
async function finalizeNewProject() {
  if (_creatingProject) return;   // guard against a double-submit (two POSTs → two kickoffs)
  _creatingProject = true;
  stopMicVisualizer();
  setIndicator('thinking', 'Customizing team charters…');
  try {
    const r = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjName.trim(), goal: newProjGoal.trim(), features: newProjFeatures.trim(), roleIds: newProjRoleIds, topology: newProjTopology }),
    });
    if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
    const project = await r.json();
    await loadProjects();
    activeProject = withLeadFirst(project);
    pickerIndex = projects.findIndex(p => p.id === project.id);
    gridIndex = 0; zoomedIndex = 0;
    setIndicator('idle', 'Connected');
    // The PM immediately starts drafting the kickoff plan on the server — show
    // "Drafting" on its tile right away rather than waiting on the SSE round-trip.
    if (project.leadAgentId) { agentStatus[project.leadAgentId] = 'drafting'; agentBusy[project.leadAgentId] = true; }
    renderGrid();
  } catch (err) {
    setIndicator('error', 'Create failed');
    console.error(err);
  } finally {
    _creatingProject = false;   // allow the next project to be created
  }
}
window.addEventListener('keyup', (e) => {
  if (e.key === 'v' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); endPTT(); }
  // Releasing Space / Enter ends a hold-to-talk started on an "Other" option.
  if ((e.code === 'Space' || e.key === 'Enter') && _otherDictateBtn) { e.preventDefault(); endOtherDictate(); }
});

/* ---------- First-launch OpenRouter key gate ---------- */
/* Blocks boot until a VALID key is saved. Unskippable by design: no close
 * affordance, Escape is swallowed, focus is held in the input, and all key
 * events outside the gate are trapped so nav/PTT handlers can't fire. */
async function ensureApiKey() {
  // Retry briefly before showing the gate. At launch the renderer can load
  // before the server is ready; failing open immediately would wrongly prompt
  // for a key that's already set. Only show the gate once we've actually
  // reached the server and confirmed no key is configured.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch('/settings', { cache: 'no-store' });   // never trust a stale gate verdict
      if ((await r.json()).OPENROUTER_API_KEY_SET) return;  // key already set → no gate
      break;                                                // reached server, no key → show gate
    } catch {
      await new Promise((res) => setTimeout(res, 300));     // server still warming up — retry
    }
  }

  const gate    = document.getElementById('apikey-gate');
  const form    = document.getElementById('apikey-gate-form');
  const input   = document.getElementById('apikey-gate-input');
  const saveBtn = document.getElementById('apikey-gate-save');
  const errEl   = document.getElementById('apikey-gate-error');

  gate.hidden = false;
  input.focus();

  // Capture-phase trap: stop keys aimed OUTSIDE the gate from reaching the
  // global grid-nav / PTT handlers, and swallow Escape. Two carve-outs:
  //  - never touch ⌘/Ctrl combos — that was eating ⌘V paste (and copy/cut/⌘A);
  //  - never touch keys typed in the input (target is inside the gate).
  const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const trap = (e) => {
    if (e.metaKey || e.ctrlKey) return;
    // Arrow-key focus nav between the key field and Save (keyboard; the d-pad
    // is handled on the gamepad bus below). Left/Right/Up stay native inside
    // the field so the text cursor still works; Down hops to the button.
    if (e.type === 'keydown' && ARROWS.includes(e.key)) {
      if (document.activeElement === saveBtn) {
        // Button has no cursor: Left/Up return to the field; Right/Down stay put.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          input.focus(); e.preventDefault(); e.stopImmediatePropagation();
        }
        return;
      }
      if (document.activeElement === input) {
        // Down always hops to the button; Right hops only when the caret is at
        // the end (no selection) so in-field Left/Right still move the cursor.
        const caretAtEnd = input.selectionStart === input.value.length &&
                           input.selectionStart === input.selectionEnd;
        if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && caretAtEnd)) {
          saveBtn.focus(); e.preventDefault(); e.stopImmediatePropagation();
        }
        return;   // Left / Up / mid-text Right stay native for the text cursor
      }
      input.focus(); e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (!gate.contains(e.target) || e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  // Bubble-stop at the gate root so input keystrokes never reach the global
  // window-level shortcut handlers registered at module load.
  const stop = (e) => e.stopPropagation();
  // Keep the cursor in the key field. Programmatic focus() can silently no-op
  // when the OS window isn't focused at launch — leaving ⌘V with no target — so
  // also refocus when the window regains focus and on any click in the card
  // (except the OpenRouter link, which must stay clickable).
  const refocus = () => { if (!gate.hidden) setTimeout(() => input.focus(), 0); };
  const grabFocus = (e) => { if (!gate.hidden && e.target?.tagName !== 'A') input.focus(); };
  window.addEventListener('keydown', trap, true);
  window.addEventListener('keyup', trap, true);
  window.addEventListener('focus', refocus);
  gate.addEventListener('mousedown', grabFocus);
  gate.addEventListener('keydown', stop);
  gate.addEventListener('keyup', stop);
  input.addEventListener('focusout', refocus);

  const status = (msg, kind) => {   // visible feedback so a Save never looks silent
    errEl.style.color = kind === 'err' ? 'var(--danger)' : 'var(--fg-dim)';
    errEl.textContent = msg; errEl.hidden = false;
  };
  const submitKey = async (resolve) => {
    console.log('[gate] save: submit fired');
    const key = input.value.trim();
    if (!key) { status('Enter your OpenRouter API key to continue.', 'err'); input.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Checking…';
    status('Checking your key…', 'info');
    try {
      const vr = await fetch('/settings/verify-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      });
      const v = await vr.json();
      console.log('[gate] save: verify-key →', vr.status, v);
      if (!v.valid) throw new Error(v.error || 'Invalid key');
      const s = await fetch('/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ OPENROUTER_API_KEY: key }),
      });
      console.log('[gate] save: PUT /settings →', s.status);
      if (!s.ok) throw new Error('Could not save the key — try again.');
      errEl.hidden = true;
      console.log('[gate] save: success — closing gate');
      resolve();
    } catch (err) {
      console.error('[gate] save failed:', err);
      status(err.message || 'Something went wrong — try again.', 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & continue';
    }
  };
  // Button is type=button (no native submit at all); also accept Enter in the field.
  await new Promise((resolve) => {
    saveBtn.addEventListener('click', () => submitKey(resolve));
    form.addEventListener('submit', (e) => { e.preventDefault(); submitKey(resolve); });
  });

  window.removeEventListener('keydown', trap, true);
  window.removeEventListener('keyup', trap, true);
  window.removeEventListener('focus', refocus);
  gate.removeEventListener('mousedown', grabFocus);
  input.removeEventListener('focusout', refocus);
  gate.hidden = true;
  console.log('[bridge] OpenRouter key saved via first-launch gate');
}

/* ---------- Boot ---------- */
// Tolerate a transient server hiccup right after the key is saved — the gate
// has already closed, so an unguarded throw here would blank the app.
async function loadProjectsWithRetry(tries = 5) {
  for (let i = 1; ; i++) {
    try { return await loadProjects(); }
    catch (err) {
      if (i >= tries) throw err;
      console.warn('[bridge] loadProjects retry', i, '—', err?.message || err);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

(async () => {
  try {
    await ensureApiKey();
    await loadProjectsWithRetry();
    // Restore the last screen the user was on (survives page refresh).
    const saved = readNavState();
    let restored = false;
    try {
      if (saved?.projectId) {
        const p = projects.find(pp => pp.id === saved.projectId);
        if (p) {
          activeProject = withLeadFirst(p);
          gridIndex   = saved.gridIndex   || 0;
          zoomedIndex = saved.zoomedIndex || 0;
          if (saved.mode === MODE_ZOOM) { renderZoom(); restored = true; }
          else if (saved.mode === MODE_GRID) { renderGrid(); restored = true; }
        }
      }
    } catch (err) {
      console.error('[bridge] restore failed — falling back to projects:', err);
      restored = false;
    }
    if (!restored) {
      if (saved?.pickerIndex) pickerIndex = saved.pickerIndex;
      renderProjects();
    }
    // Never strand the user on a blank surface — if the restored view rendered
    // nothing, drop back to the projects home screen.
    if (!surfaceEl.firstChild) { activeProject = null; renderProjects(); }
    rehydrateAgentStatuses();   // busy verbs + "…" bubble survive the reload
    staggerInCards();
    staggerInFooter();
    setIndicator('idle', 'Connected');
    startConnectionPing();
    console.log('[bridge] booted into', mode);
  } catch (err) {
    // Never leave a blank screen — show what happened and let the user recover.
    console.error('[bridge] boot failed:', err);
    setIndicator('error', 'Failed to load — reload to retry');
  }
})();

/* Ping /health every 5 s — flip the indicator to red on failure, back to
 * green on success. Skip while listening / thinking so we don't clobber
 * those transient states. */
function startConnectionPing() {
  // Indicator removed from the chrome — no need to poll.
}
