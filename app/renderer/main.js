import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking, speechBus } from './speech.js';
import { renderMarkdown, attachCodeCopyHandlers } from './md.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';
import { GAMEPAD_ICON_SVG } from './gamepad-icons.js';

/* Render a gamepad glyph: inline the PlayStation SVG icon when we have one
 * (mono, follows the chip color via currentColor), else fall back to the
 * legacy text symbol so unmapped buttons still show something. */
function paintGamepadGlyph(g, key) {
  const svg = GAMEPAD_ICON_SVG[key];
  if (svg) { g.classList.add('gp-icon'); g.innerHTML = svg; }
  else g.textContent = GAMEPAD_GLYPHS[key] || key;
}

const surfaceEl       = document.getElementById('surface');
const indicatorEl     = document.getElementById('listening-indicator');     // removed from DOM
const indicatorTextEl = indicatorEl?.querySelector('.state-text') || null;
const breadcrumbsEl   = document.getElementById('breadcrumbs');             // removed from DOM
const typedWrap       = document.getElementById('ptt-typed');
const typedInput      = document.getElementById('typed-input');
const shortcutsRailEl = document.getElementById('shortcuts-rail');
const primaryShortcutEl = document.getElementById('primary-shortcut');
const backShortcutEl   = document.getElementById('back-shortcut');

/** Set the persistent shortcuts rail at bottom-right. Pass an array of
 *  { gamepad, keyboard, label, action } — both glyphs render and CSS
 *  hides the inactive one based on body[data-input-mode]. Each chip is
 *  clickable; if `action` is provided, it's invoked on click and when
 *  the chip is focused-and-Entered via keyboard navigation. */
let shortcutItems = [];
let shortcutFocusIdx = -1; // -1 means focus is not in the rail

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
  )];
}

const GAMEPAD_GLYPHS = { cross: '✕', circle: '○', square: '□', triangle: '△' };

function buildChip(it) {
  const wrap = document.createElement('span');
  wrap.className = 'sc';
  if (it.action) {
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
  if (backItem) backShortcutEl.appendChild(buildChip(backItem));
}

function paintShortcutFocus() {
  const items = footerFocusables();
  items.forEach((el, i) => el.classList.toggle('focused', i === shortcutFocusIdx));
}
function enterShortcuts() {
  const items = footerFocusables();
  if (items.length === 0) return false;
  shortcutFocusIdx = 0;
  paintShortcutFocus();
  return true;
}
function leaveShortcuts() {
  shortcutFocusIdx = -1;
  paintShortcutFocus();
}
function moveShortcutFocus(delta) {
  const items = footerFocusables();
  const n = items.length;
  if (n === 0) return;
  shortcutFocusIdx = (shortcutFocusIdx + delta + n) % n;
  paintShortcutFocus();
}
function activateFocusedShortcut() {
  const items = footerFocusables();
  const el = items[shortcutFocusIdx];
  if (!el) return;
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
  const items = surfaceEl.querySelectorAll('.project-tile:not(.centered-create), .agent-tile, .role-tile');
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
  Object.assign(overlay.style, {
    position: 'fixed',
    left: `${sRect.left}px`, top: `${sRect.top}px`,
    width: `${sRect.width}px`, height: `${sRect.height}px`,
    margin: '0', pointerEvents: 'none', zIndex: '50',
    background: cs.background,
    border: cs.border,
    borderRadius: cs.borderRadius,
    boxShadow: 'none',
  });
  document.body.appendChild(overlay);

  // Render the destination view first so the recompute below can read
  // the actual landing tile's rect.
  renderNewView();
  fadeInDestination(220);

  const toRect = typeof resolveToRect === 'function' ? resolveToRect() : resolveToRect;
  if (!toRect) { overlay.remove(); return Promise.resolve(); }

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
  return a.finished.catch(() => {}).then(() => { overlay.remove(); });
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
  if (!e.repeat) flashShortcutByKey(e.key);
}, true);
window.addEventListener('mousemove', () => setInputMode('keyboard'), true);

/* ---------- App state ---------- */
const MODE_PROJECTS         = 'projects';          // L0
const MODE_NEW_PROJ_ROLES    = 'new_project_roles';    // create-flow step 1
const MODE_NEW_PROJ_TOPOLOGY = 'new_project_topology'; // create-flow step 2
const MODE_NEW_PROJ_NAME     = 'new_project_name';     // create-flow step 3
const MODE_NEW_PROJ_GOAL     = 'new_project_goal';     // create-flow step 4
const MODE_GRID             = 'grid';              // L1 (project grid)
const MODE_ZOOM             = 'zoom';              // L2 (agent zoom)
const MODE_ADD_AGENT        = 'add_agent';         // L1 → add-agent role picker

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
const VERB_LABELS = { idle: 'Idle', drafting: 'Drafting', analyzing: 'Analyzing', waiting: 'Waiting' };
function verbLabel(v) { return VERB_LABELS[v] || 'Idle'; }

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

// Work topologies offered after role selection. Display copy lives here; the
// operating rule written into project.md lives server-side (projects.js).
const TOPOLOGIES = [
  { id: 'hub-and-spoke', heading: 'Hub-and-spoke', subtitle: 'One coordinator, four specialists', desc: 'A coordinator routes work to specialists and gathers their results.' },
  { id: 'feature-teams', heading: 'Feature teams', subtitle: 'Parallel pods, end-to-end ownership', desc: 'Independent pods each own a workstream from start to finish.' },
  { id: 'mesh-mob',      heading: 'Mesh / mob', subtitle: 'Everyone on everything', desc: 'The whole team swarms one problem together, no fixed ownership.' },
  { id: 'rotating-lead', heading: 'Rotating lead', subtitle: 'Leadership passes each sprint', desc: 'The lead role hands off each sprint so everyone steers in turn.' },
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
      <line class="link" x1="20" y1="16" x2="20" y2="44"/><line class="link" x1="48" y1="16" x2="48" y2="44"/><line class="link" x1="76" y1="16" x2="76" y2="44"/>
      <circle class="node" cx="20" cy="14" r="6"/><circle class="node" cx="20" cy="46" r="6"/>
      <circle class="node" cx="48" cy="14" r="6"/><circle class="node" cx="48" cy="46" r="6"/>
      <circle class="node" cx="76" cy="14" r="6"/><circle class="node" cx="76" cy="46" r="6"/>`,
    'mesh-mob': `
      <line class="link" x1="48" y1="9" x2="15" y2="30"/><line class="link" x1="48" y1="9" x2="81" y2="30"/>
      <line class="link" x1="48" y1="9" x2="48" y2="51"/><line class="link" x1="15" y1="30" x2="81" y2="30"/>
      <line class="link" x1="15" y1="30" x2="48" y2="51"/><line class="link" x1="81" y1="30" x2="48" y2="51"/>
      <circle class="node" cx="48" cy="9" r="6"/><circle class="node" cx="15" cy="30" r="6"/>
      <circle class="node" cx="81" cy="30" r="6"/><circle class="node" cx="48" cy="51" r="6"/>`,
    'rotating-lead': `
      <path class="ring" d="M67 23 A20 20 0 1 1 60 14"/>
      <polyline class="arrow" points="59,10 64,17 56,16"/>
      <circle class="node lead" cx="48" cy="10" r="6.5"/><circle class="node" cx="68" cy="30" r="6"/>
      <circle class="node" cx="48" cy="50" r="6"/><circle class="node" cx="28" cy="30" r="6"/>`,
    'async-pull': `
      <rect class="mini" x="4" y="5" width="27" height="12" rx="3"/><rect class="mini" x="4" y="24" width="27" height="12" rx="3"/><rect class="mini" x="4" y="43" width="27" height="12" rx="3"/>
      <path class="arrow" d="M34 11 H77"/><polyline class="arrow" points="72,7 78,11 72,15"/>
      <path class="arrow" d="M34 49 H53 C66 49 61 36 73 31"/><polyline class="arrow" points="67,30 74,30 72,37"/>
      <circle class="node" cx="86" cy="11" r="6"/><circle class="node" cx="86" cy="43" r="6"/>`,
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
  projects = (await pj.json()).projects || [];
  window._roles = (await rj.json()).roles || [];
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

function renderProjects() {
  mode = MODE_PROJECTS;
  document.body.dataset.mode = mode;
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setBreadcrumbs([{ label: 'Projects' }]);
  surfaceEl.innerHTML = '';
  saveNavState();

  // Heading at top-left of the surface, like the project detail screen.
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `<h2 class="project-title">Projects</h2>`;
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
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(sentenceCase(p.name))}</h2>
      <div class="meta">${p.agents.length} agent${p.agents.length===1?'':'s'}</div>
      <div class="project-updated">${escapeHtml(formatProjectUpdated(p.updatedAt || p.createdAt))}</div>`;
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
  ring.set(tileEls);
  ring.index = clamp(pickerIndex, 0, tileEls.length - 1);
  ring.paint();

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
  if (e.detail.button !== 'cross') return;
  if (projectEditOpen) { resetRemoveHold(); return; }
  if (mode === MODE_PROJECTS) endProjectHold(true);
});
// Releasing Enter at L0 (no modal) finishes a tile long-press.
window.addEventListener('keyup', (e) => {
  if (e.key === 'Enter' && mode === MODE_PROJECTS && !projectEditOpen) endProjectHold(true);
});

/** On L0, the shortcuts rail reflects the focused project's lead so
 *  the user can talk to that project's PM from the home screen.
 *  Hidden when "+ New" is focused. */
function updatePickerShortcuts() {
  if (mode !== MODE_PROJECTS) return;
  // Always show the Hold-to-talk chip on L0; it just no-ops on the
  // + New project tile (talkToFocusedLead bails when there's no
  // project to address).
  setShortcuts([
    { gamepad: 'r2', keyboard: 'V', label: `Hold to talk`,
      action: () => talkToFocusedLead() },
    {                gamepad: 'triangle', keyboard: 'A', label: 'Activity',
      action: () => toggleActivityDrawer() },
    {                gamepad: 'square', keyboard: 'M', label: 'Memory',
      action: () => toggleMemoryDrawer() },
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
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' ||
               e.key === 'ArrowUp'   || e.key === 'ArrowRight') {
      // Any arrow key releases the × focus and hands it back to the
      // surface ring. Up/Right have no natural neighbor (X sits at
      // the top-right corner), so we still treat them as "leave".
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
  if (btn) { btn.focus(); ring.items.forEach(el => el.classList.remove('focused')); return true; }
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

async function openFocused() {
  const idx = ring.index;
  const sourceTile = ring.current();
  const sourceRect = sourceTile?.getBoundingClientRect();
  const targetRect = surfaceContentRect();
  if (idx === tileCount() - 1) {
    // "+ New" — enter create flow with the same morph as a project tile.
    newProjRoleIds = [];
    newProjTopology = null;
    newProjName = '';
    newProjGoal = '';
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

  const tileEls = [];
  for (const role of roles) {
    const sample = role.namePool[0];
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

  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_role_back' } },
  ]);
  setShortcuts([
    { gamepad: 'cross',  keyboard: 'Space', label: 'Toggle', action: () => toggleFocusedRole() },
    { gamepad: 'circle', keyboard: 'Delete',   label: 'Back',   action: () => renderProjects() },
  ]);
  setPrimaryShortcut({ gamepad: 'triangle', keyboard: 'Enter', label: 'Select',
                       action: () => advanceFromRolePicker() });
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
    ring.index = firstNonTileIdx;
    ring.paint();
    return true;
  }
  // No buttons in the ring — fall back to entering the footer.
  if (enterShortcuts()) return true;
  return false;
}

function roleGridMove(dir) {
  const cols = 4;
  const n = ring.elements.length;
  if (n === 0) return;
  const i = ring.index;
  const r = Math.floor(i / cols), c = i % cols;
  const rows = Math.ceil(n / cols);
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  let next = nr * cols + nc;
  if (next >= n) next = n - 1;
  ring.index = next;
  ring.paint();
}

function advanceFromRolePicker() {
  if (newProjRoleIds.length === 0) {
    setIndicator('error', 'Pick at least one role');
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
    return;
  }
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
  const backBtn = document.createElement('button');
  backBtn.type = 'button'; backBtn.className = 'role-cancel'; backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => renderNewProjectRoles());
  row.appendChild(backBtn);
  wrap.appendChild(row);

  surfaceEl.appendChild(wrap);

  ring.set([...cardEls, backBtn]);
  ring.index = Math.max(0, TOPOLOGIES.findIndex(t => t.id === newProjTopology));
  ring.paint();

  renderActionBar([{ verb: 'Back', glyph: 'circle', action: { type: '_topo_back' } }]);
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Delete', label: 'Back', action: () => renderNewProjectRoles() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Choose',
                       action: () => { const c = ring.current(); if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId); else c?.click?.(); } });
}

function selectTopology(id) {
  newProjTopology = id;
  document.querySelectorAll('.topology-card').forEach(c => { c.dataset.selected = String(c.dataset.topoId === id); });
}
function chooseTopology(id) { selectTopology(id); renderNewProjectName(); }

/* Topology nav: the row of cards occupies ring indices 0..N-1, the Back
 * button is the last index. Left/right move between cards; down jumps to
 * Back; up returns from Back into the cards. */
function topoMoveCard(dir) {
  const n = TOPOLOGIES.length;
  if (ring.index >= n) { ring.index = dir < 0 ? n - 1 : 0; }   // from Back → into cards
  else ring.index = (ring.index + dir + n) % n;
  ring.paint();
}
function topoFocusBack() { ring.index = TOPOLOGIES.length; ring.paint(); }
function topoFocusCards() { if (ring.index >= TOPOLOGIES.length) { ring.index = 0; ring.paint(); } }

function goBackInCreateFlow() {
  if (mode === MODE_NEW_PROJ_GOAL) renderNewProjectName();
  else if (mode === MODE_NEW_PROJ_NAME) { stopMicVisualizer(); renderNewProjectTopology(); }
  else if (mode === MODE_NEW_PROJ_TOPOLOGY) renderNewProjectRoles();
  else { stopMicVisualizer(); renderProjects(); }
}

const NAME_LIMIT = 40;
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
    renderNewProjectGoal();
  } else if (mode === MODE_NEW_PROJ_GOAL) {
    if (!newProjGoal.trim()) { setIndicator('error', 'Speak or type a goal'); return; }
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

function captureValueInner(text) {
  if (text) return escapeHtml(text);
  // Mic visualizer markup. Bars are static here; heights are updated
  // by animateMicBars() each rAF tick. The .mic-live-text slot above
  // the bars is filled by the speech 'partial' listener while the
  // user is dictating.
  const bars = Array.from({ length: MIC_BAR_COUNT }, () => '<div class="bar"></div>').join('');
  return `
    <div class="mic-stack">
      <div class="mic-live-text" aria-live="polite"></div>
      <div class="mic-bars">${bars}</div>
      <div class="mic-label">Speak now</div>
    </div>`;
}

async function startMicVisualizer() {
  // No-op if we already have a running visualizer.
  if (micViz) { animateMicBars(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  }
}

function stopMicVisualizer() {
  if (micVizFrame) { cancelAnimationFrame(micVizFrame); micVizFrame = null; }
  if (micViz) {
    try { micViz.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { micViz.ac.close(); } catch {}
    micViz = null;
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
  mode = MODE_NEW_PROJ_NAME;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Name' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>Name this project</h2>
    <div class="capture-value ${newProjName ? 'has-value' : ''}">${captureValueInner(newProjName)}</div>
    ${newProjRoleIds.includes('pm')
      ? ''
      : '<div class="lead-badge">Cassidy will lead this team.</div>'}
    <div class="role-confirm-row">
      <button type="button" class="role-cancel" id="capture-cancel">Cancel</button>
      <button type="button" class="role-cancel role-back" id="capture-back">Back</button>
      <button type="button" class="role-confirm" id="capture-done">Continue</button>
    </div>`;
  surfaceEl.appendChild(t);
  const tryCancelNameCapture = () => {
    maybeConfirmCancel(!!newProjName.trim(), () => { stopMicVisualizer(); renderProjects(); });
  };
  const nameBackEl   = t.querySelector('#capture-back');
  const nameCancelEl = t.querySelector('#capture-cancel');
  const nameDoneEl   = t.querySelector('#capture-done');
  // Primary stays disabled until something has been captured.
  if (nameDoneEl) nameDoneEl.disabled = !newProjName.trim();
  nameBackEl?.addEventListener('click', () => {
    stopMicVisualizer();
    renderNewProjectRoles();
  });
  nameCancelEl?.addEventListener('click', tryCancelNameCapture);
  nameDoneEl?.addEventListener('click', () => confirmCapture());
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelNameCapture));
  startMicVisualizer();
  // Auto-start speech recognition so the user can just speak. Partial
  // transcripts populate .mic-live-text in real time; the 'end' event
  // commits the value.
  setTimeout(() => startPTT(), 80);
  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Delete', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  // Action-row buttons join the focus ring so arrow / d-pad nav works.
  ring.set([nameCancelEl, nameBackEl, nameDoneEl].filter(Boolean));
  ring.index = 0; // Cancel focused by default — leftmost in the row,
                  // so ArrowDown from the surface-close × lands on it
                  // first instead of skipping past to the primary.
  ring.paint();
}

function renderNewProjectGoal() {
  mode = MODE_NEW_PROJ_GOAL;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Goal' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>What's the objective?</h2>
    <div class="capture-value ${newProjGoal ? 'has-value' : ''}">${captureValueInner(newProjGoal)}</div>
    <div class="role-confirm-row">
      <button type="button" class="role-cancel" id="capture-cancel">Cancel</button>
      <button type="button" class="role-cancel role-back" id="capture-back">Back</button>
      <button type="button" class="role-confirm" id="capture-done">Create project</button>
    </div>`;
  surfaceEl.appendChild(t);
  const tryCancelGoalCapture = () => {
    maybeConfirmCancel(!!newProjGoal.trim(), () => { stopMicVisualizer(); renderProjects(); });
  };
  const goalBackEl   = t.querySelector('#capture-back');
  const goalCancelEl = t.querySelector('#capture-cancel');
  const goalDoneEl   = t.querySelector('#capture-done');
  if (goalDoneEl) goalDoneEl.disabled = !newProjGoal.trim();
  goalBackEl?.addEventListener('click', () => {
    stopMicVisualizer();
    renderNewProjectName();
  });
  goalCancelEl?.addEventListener('click', tryCancelGoalCapture);
  goalDoneEl?.addEventListener('click', () => confirmCapture());
  surfaceEl.appendChild(createSurfaceCloseButton(tryCancelGoalCapture));
  startMicVisualizer();
  setTimeout(() => startPTT(), 80);
  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Delete', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  ring.set([goalCancelEl, goalBackEl, goalDoneEl].filter(Boolean));
  ring.index = 0; // Cancel focused by default — leftmost in the row,
                  // so ArrowDown from the surface-close × lands on it
                  // first instead of skipping past to the primary.
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

  // Fixed 4×2 layout — matches the project picker on L0.
  const cols = 4, rows = 2;
  const grid = document.createElement('div');
  grid.className = 'agent-grid';
  grid.style.setProperty('--grid-cols', cols);
  grid.style.setProperty('--grid-rows', rows);
  grid._cols = cols;
  grid._rows = rows;

  const projectColor = getProjectColor(activeProject);
  const tileEls = activeProject.agents.map((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    if (!a.enabled) tile.dataset.disabled = 'true';
    if (a.id === activeProject.leadAgentId) tile.dataset.lead = 'true';
    tile.style.setProperty('--tile-color', projectColor);
    tile.dataset.agentId = a.id;
    const verb = agentStatus[a.id] || (agentBusy[a.id] ? 'drafting' : 'idle');
    tile.dataset.busy = (verb !== 'idle') ? 'true' : 'false';
    tile.dataset.status = verb;
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(a.name)}</h2>
      <div class="role">${escapeHtml(roleLabel(a.role))}</div>
      <div class="status"><span class="dot"></span><span class="status-verb">${verbLabel(verb)}</span></div>`;
    tile.addEventListener('click', () => { gridIndex = i; ring.set(tileEls); ring.index = i; ring.paint(); enterZoom(); });
    grid.appendChild(tile);
    return tile;
  });

  // "+ Add agent" tile — last cell when room remains (cap at cols*rows).
  if (tileEls.length < cols * rows) {
    const addIdx = tileEls.length;
    const addTile = document.createElement('div');
    addTile.className = 'agent-tile add-agent';
    addTile.dataset.addAgent = 'true';
    addTile.innerHTML = `
      <div class="add-symbol">+</div>
      <div class="add-label">Add agent</div>`;
    addTile.addEventListener('click', () => {
      gridIndex = addIdx;
      ring.set(tileEls.concat(addTile));
      ring.index = addIdx;
      ring.paint();
      openAddAgentPicker();
    });
    grid.appendChild(addTile);
    tileEls.push(addTile);
  }

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(gridIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_grid_back' } },
  ]);
  updateGridShortcuts();
}

/* ---------- Add-agent role picker (full-screen, multi-select) ----------
 * Reuses the .role-grid / .role-tile / .role-toggle visual treatment
 * from the create-project flow. PM is excluded since the project
 * already has one. Selected roles are POSTed sequentially to
 * /projects/:pid/agents on Done. */
let addAgentSelected = new Set(); // role ids checked in this session

async function openAddAgentPicker() {
  if (!activeProject) return;
  // Always fetch fresh so renames / additions on the server show up
  // without a hard page reload.
  try {
    const r = await fetch('/roles');
    if (r.ok) window._roles = (await r.json()).roles || [];
  } catch { window._roles = window._roles || []; }
  const usedRoles = new Set(activeProject.agents.map(a => a.role));
  // Every role is shown. Existing agents are pre-checked and locked
  // (cannot be removed from this screen).
  const available = (window._roles || []).filter(r => !usedRoles.has(r.id));
  if (available.length === 0) {
    setIndicator('error', 'No roles left to add');
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
    return;
  }
  mode = MODE_ADD_AGENT;
  document.body.dataset.mode = mode;
  // Keep the project's color wash so the add-agent screen reads as
  // "still inside this project."
  document.documentElement.style.setProperty('--agent-color', getProjectColor(activeProject));
  addAgentSelected = new Set();
  setBreadcrumbs([
    { label: 'Projects' },
    { label: activeProject.name },
    { label: 'Add agent' },
  ]);
  surfaceEl.innerHTML = '';

  // Heading + close X (consistent with L1 / L2).
  const heading = document.createElement('header');
  heading.className = 'project-heading';
  heading.innerHTML = `
    <h2 class="project-title">Add agent</h2>
    <p class="project-goal">Pick one or more roles to add.</p>`;
  surfaceEl.appendChild(heading);
  // Close × — confirms if the user has any new selections.
  surfaceEl.appendChild(createSurfaceCloseButton(() => {
    maybeConfirmCancel(addAgentSelected.size > 0, () => renderGrid());
  }));

  // Locked (already on project) first, alphabetized; then the rest,
  // also alphabetized. Focus lands on the first togglable tile.
  const allRoles = window._roles || [];
  const locked = allRoles.filter(r => usedRoles.has(r.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  const open = allRoles.filter(r => !usedRoles.has(r.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  const roles = [...locked, ...open];

  const wrap = document.createElement('section');
  wrap.className = 'role-picker';
  const grid = document.createElement('div');
  grid.className = 'role-grid';

  const tileEls = [];
  let firstOpenTile = null;
  for (const role of roles) {
    const sample = role.namePool?.[0] || '';
    const isLocked = usedRoles.has(role.id);
    const t = document.createElement('div');
    t.className = 'role-tile';
    t.dataset.roleId = role.id;
    if (isLocked) t.dataset.locked = 'true';
    t.style.setProperty('--tile-color', role.color);
    t.innerHTML = `
      <div class="role-label">${escapeHtml(role.label)}</div>
      <div class="role-sample">${escapeHtml(sample)}</div>
      <div class="role-toggle" data-checked="${isLocked ? 'true' : 'false'}" ${isLocked ? 'data-locked="true"' : ''}></div>`;
    t.addEventListener('click', () => { ring.moveTo(el => el === t); toggleFocusedAddAgentRole(); });
    grid.appendChild(t);
    tileEls.push(t);
    if (!firstOpenTile && !isLocked) firstOpenTile = t;
  }
  wrap.appendChild(grid);

  // Invisible row inside the picker — Cancel on the left of Continue.
  const tryCancelAddAgent = () => {
    maybeConfirmCancel(addAgentSelected.size > 0, () => renderGrid());
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
    { gamepad: 'options', keyboard: 'E',     label: 'Explorer', action: () => toggleFileExplorer() },
    { gamepad: 'triangle', keyboard: 'A',     label: 'Activity', action: () => toggleActivityDrawer() },
    { gamepad: 'circle',  keyboard: 'Delete',   label: 'Back',     action: () => renderGrid() },
  ]);
  setPrimaryShortcut({ gamepad: 'triangle', keyboard: 'Enter', label: 'Done',
                       action: () => commitAddAgentSelections() });
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
}

async function commitAddAgentSelections() {
  if (!activeProject || addAgentSelected.size === 0) { renderGrid(); return; }
  const pid = activeProject.id;
  setIndicator('thinking', `Adding ${addAgentSelected.size} agent${addAgentSelected.size > 1 ? 's' : ''}…`);
  let updated = null;
  for (const roleId of addAgentSelected) {
    try {
      const r = await fetch(`/projects/${pid}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId }),
      });
      if (!r.ok) throw new Error(await r.text());
      updated = await r.json();
    } catch (err) {
      console.error(`[add-agent] failed for ${roleId}`, err);
    }
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
    { gamepad: 'r2', keyboard: 'V', label: 'Hold to talk', action: () => startPTT() },
    { gamepad: 'l1', keyboard: '[', label: 'Prev project', action: () => cycleProject(-1) },
    { gamepad: 'r1', keyboard: ']', label: 'Next project', action: () => cycleProject(+1) },
    { gamepad: 'options', keyboard: 'E', label: 'Explorer', action: () => toggleFileExplorer() },
    {                    gamepad: 'triangle', keyboard: 'A', label: 'Activity', action: () => toggleActivityDrawer() },
  ];
  if (!isLeadFocused) {
    items.push({ gamepad: 'square', keyboard: 'Space', label: 'Agent on / off',
                 action: () => toggleFocusedAgentEnabled() });
  }
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
  const cols = grid._cols, rows = grid._rows;
  const n = ring.elements.length;
  const i = ring.index;
  const r = Math.floor(i / cols), c = i % cols;
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  let next = nr * cols + nc;
  if (next >= n) next = n - 1;
  ring.index = next;
  gridIndex = next;
  ring.paint();
  updateGridShortcuts();
}


async function enterZoom(specOverride) {
  if (!activeProject) return;
  // The "+ Add agent" tile sits at index activeProject.agents.length —
  // pressing Enter on it opens the role picker instead of zooming.
  if (mode !== MODE_ZOOM && gridIndex === activeProject.agents.length) {
    openAddAgentPicker();
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
  const sourceTile = ring.current();
  const sourceRect = sourceTile?.getBoundingClientRect();
  const targetRect = surfaceContentRect();
  zoomStack.push(sourceRect);
  zoomedIndex = idx;
  mode = MODE_ZOOM;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderZoom(specOverride));
}

function renderZoom(specOverride) {
  const agent = currentAgent();
  if (!agent) return renderGrid();
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
      </div>
    </div>
    <div class="chat-scroll"></div>
    <div class="tile-surface"></div>
    <div class="agent-view-hint">
      <span class="for-gamepad">Hold <kbd>R2</kbd> to speak</span>
      <span class="for-keyboard">Hold <kbd>v</kbd> to speak</span>
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

/* Selectable chat bubbles: each prompt / response is a tabbable
 * element with a hover-state action row (timestamp + retry + edit on
 * user turns, timestamp on agent turns). chatBubbles holds the live
 * NodeList for focus traversal. */
let chatBubbles = [];      // DOM nodes in order
let chatBubbleIdx = -1;    // -1 = not in chat
let chatMessages = [];     // last-fetched message records

function formatBubbleTime(at) {
  if (!at) return '';
  try {
    const d = new Date(at);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
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
    const arrow = document.createElement('div');
    arrow.className = 'handoff-line';
    arrow.innerHTML =
      `<span class="handoff-from">${escapeHtml(payload.from || '')}</span>` +
      `<span class="handoff-arrow" aria-hidden="true">→</span>` +
      `<span class="handoff-to">${escapeHtml(payload.to || '')}</span>`;
    el.appendChild(arrow);
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

async function renderChatHistory(container, agent) {
  container.innerHTML = '';
  chatBubbles = [];
  chatBubbleIdx = -1;
  chatMessages = [];
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history`);
    if (!r.ok) return;
    const { messages } = await r.json();
    chatMessages = messages || [];
    messages.forEach((m, i) => {
      // v2 §4: a 'system' turn carrying a JSON handoff payload renders
      // as a distinct neutral bubble between agent / user bubbles.
      // Handoff bubbles are read-only (not focusable, not in the
      // keyboard nav ring) — they're context, not actions.
      if (m.role === 'system') {
        const handoffEl = renderHandoffBubble(m, i);
        if (handoffEl) container.appendChild(handoffEl);
        return;
      }
      const isUser = m.role === 'user';
      const bubble = document.createElement('div');
      bubble.className = `bubble ${isUser ? 'user' : 'agent'}`;
      bubble.dataset.idx = String(i);
      bubble.dataset.role = m.role;
      bubble.tabIndex = 0;
      let body = String(m.content || '').trim();
      let actionsTaken = null;
      if (!isUser) {
        try {
          const parsed = JSON.parse(body.replace(/^```(?:json)?/i,'').replace(/```$/, '').trim());
          if (parsed?.body) body = parsed.body;
          else if (parsed?.title) body = parsed.title;
          if (Array.isArray(parsed?.actions_taken)) actionsTaken = parsed.actions_taken;
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

      bubble.addEventListener('focus', () => {
        chatBubbleIdx = i;
        paintBubbleFocus();
      });
      bubble.addEventListener('click', () => bubble.focus());
      container.appendChild(bubble);
      chatBubbles.push(bubble);
    });
    // Initial render: jump to the latest bubble with no animation —
    // the .chat-scroll has `scroll-behavior: smooth` which would
    // otherwise animate this. scrollTo({ behavior: 'auto' }) overrides.
    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
  } catch (err) {
    console.warn('[chat] history failed:', err);
  }
}

function paintBubbleFocus() {
  chatBubbles.forEach((b, i) => b.classList.toggle('focused', i === chatBubbleIdx));
}

function focusBubble(i) {
  if (chatBubbles.length === 0) return false;
  const n = chatBubbles.length;
  const next = Math.max(0, Math.min(n - 1, i));
  chatBubbleIdx = next;
  chatBubbles[next].focus();
  chatBubbles[next].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return true;
}

function focusFirstBubble()    { return focusBubble(0); }
function focusLastBubble()     { return focusBubble(chatBubbles.length - 1); }
function moveBubbleFocus(d)    { return focusBubble(chatBubbleIdx + d); }
function isBubbleFocused() {
  // True while either the bubble itself OR one of its action icons
  // (.bubble-action) holds focus — both states should keep the bubble
  // keyboard handler in charge of arrow navigation.
  if (chatBubbleIdx < 0) return false;
  const a = document.activeElement;
  if (!a) return false;
  return a.classList?.contains('bubble') || a.classList?.contains('bubble-action');
}
function leaveBubbleFocus()    { chatBubbleIdx = -1; paintBubbleFocus(); }

async function retryBubble(i) {
  const m = chatMessages[i];
  if (!m || m.role !== 'user') return;
  const text = String(m.content || '').replace(/^\[team-voice\]\s*/, '').trim();
  if (!text) return;
  leaveBubbleFocus();
  submitIntent(text);
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
  setTimeout(() => confirmCancelNoEl.focus(), 0);
}

function closeConfirmCancel() {
  confirmCancelModalEl.hidden = true;
  confirmCancelOpen = false;
  confirmCancelPending = null;
}

confirmCancelNoEl?.addEventListener('click', () => closeConfirmCancel());
confirmCancelYesEl?.addEventListener('click', () => {
  const fn = confirmCancelPending;
  closeConfirmCancel();
  if (fn) fn();
});
confirmCancelModalEl?.addEventListener('keydown', (e) => {
  if (!confirmCancelOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConfirmCancel(); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
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
  editBubbleModalEl.hidden = true;
  editBubbleOpen = false;
  editBubbleTargetIdx = -1;
}

function commitEditBubble() {
  const t = editBubbleTextEl.value.trim();
  if (!t) { closeEditBubbleModal(); return; }
  closeEditBubbleModal();
  leaveBubbleFocus();
  submitIntent(t);
}

editBubbleCancelEl?.addEventListener('click', () => closeEditBubbleModal());
editBubbleSaveEl?.addEventListener('click', () => commitEditBubble());
editBubbleDictateEl?.addEventListener('click', () => startPTT());
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
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    if (inTextarea) {
      const atStart = editBubbleTextEl.selectionStart === 0;
      if (e.key === 'ArrowUp' && !atStart) return;
      if (e.key === 'ArrowLeft' && !atStart) return;
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
    if (active && active.tagName === 'BUTTON') { active.click(); return; }
    // Default cross when textarea is focused: commit.
    commitEditBubble();
    return;
  }
  if (button === 'up' || button === 'left')   { stepEditBubbleFocus(-1); return; }
  if (button === 'down' || button === 'right') { stepEditBubbleFocus(+1); return; }
}

function _setL2Shortcuts() {
  setShortcuts([
    { gamepad: 'r2',      keyboard: 'V', label: 'Hold to talk', action: () => startPTT() },
    {                     keyboard: '/', label: 'Type prompt',  action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'l1',      keyboard: '[', label: 'Prev agent',   action: () => cycleAgent(-1) },
    { gamepad: 'r1',      keyboard: ']', label: 'Next agent',   action: () => cycleAgent(+1) },
    { gamepad: 'options', keyboard: 'E', label: 'Explorer',     action: () => toggleFileExplorer() },
    {                     gamepad: 'triangle', keyboard: 'A', label: 'Activity',     action: () => toggleActivityDrawer() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => pressCross() });
}

async function exitZoom() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
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

/** Slide to the next / previous project from L1 (project detail). */
function cycleProject(delta) {
  if (mode !== MODE_GRID || projects.length < 2 || !activeProject) return;
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  const curIdx = projects.findIndex(p => p.id === activeProject.id);
  const nextIdx = (curIdx + delta + projects.length) % projects.length;
  if (nextIdx === curIdx) return;
  slideAgent(delta, () => {
    activeProject = withLeadFirst(projects[nextIdx]);
    gridIndex = 0;
    zoomedIndex = 0;
    renderGrid();
  });
}

function cycleAgent(delta) {
  if (mode !== MODE_ZOOM || !activeProject) return;
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  const n = activeProject.agents.length;
  let i = zoomedIndex;
  for (let k = 0; k < n; k++) {
    i = (i + delta + n) % n;
    if (activeProject.agents[i].enabled) break;
  }
  if (i === zoomedIndex) { renderZoom(); return; }
  slideAgent(delta, () => { zoomedIndex = i; renderZoom(); });
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
const PTT_MODES = new Set([MODE_PROJECTS, MODE_ZOOM, MODE_GRID, MODE_NEW_PROJ_NAME, MODE_NEW_PROJ_GOAL]);

/* If LOCAL_STT_URL is configured on the server, mic capture goes
 * through MediaRecorder and POSTs to /transcribe. Otherwise we fall
 * back to the browser's SpeechRecognition (Google Cloud STT in
 * Chrome, Apple in Safari). */
let localSttUrl = '';
let localRecorder = null;
let localRecChunks = [];

(async function _initLocalStt() {
  try {
    const r = await fetch('/settings');
    if (r.ok) { const s = await r.json(); localSttUrl = s.LOCAL_STT_URL || ''; }
  } catch {}
  // Local Parakeet is the default engine, but only use it if the sidecar is
  // actually reachable — poll briefly (it may still be loading its model on
  // first launch), and fall back to the browser engine if it never comes up.
  if (localSttUrl) {
    let ready = false;
    for (let i = 0; i < 10 && !ready; i++) {
      try { ready = (await (await fetch('/stt-health')).json()).available; } catch {}
      if (!ready) await new Promise(res => setTimeout(res, 1200));
    }
    if (!ready) localSttUrl = '';
  }
})();

function startPTT() {
  if (pttActive) return;
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
  if (localRecorder) { stopLocalRecording(); return; }
  if (speech.supported) speech.stop();
}

/* Toggle the "held" highlight on the push-to-talk control so it stays lit for
 * the duration of the hold (not just a press flash). Targets the "Hold to talk"
 * chip's V keycap and R2 icon; whichever is visible for the current input mode
 * shows. Hidden/absent glyphs are harmlessly no-ops. */
function setPttHeld(on) {
  document.querySelectorAll('.glyph.for-gamepad[data-glyph="r2"]')
    .forEach(g => g.classList.toggle('held', on));
  document.querySelectorAll('.glyph.for-keyboard')
    .forEach(g => { if (g.textContent.trim() === 'V') g.classList.toggle('held', on); });
  // Swap the Hold-to-talk label for a live mic visualizer while holding.
  const chips = document.querySelectorAll('.sc.ptt-chip');
  chips.forEach(c => c.classList.toggle('talking', on));
  if (on && chips.length) startChipMic(); else stopChipMic();
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('no AudioContext');
    const ac = new Ctx();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 64; an.smoothingTimeConstant = 0.6;
    src.connect(an);
    chipViz = { ac, an, stream, data: new Uint8Array(an.frequencyBinCount) };
    animateChipBars();
  } catch (err) { console.warn('[chip-mic] failed:', err.message); }
}
function stopChipMic() {
  if (chipVizFrame) { cancelAnimationFrame(chipVizFrame); chipVizFrame = null; }
  if (chipViz) {
    try { chipViz.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { chipViz.ac.close(); } catch {}
    chipViz = null;
  }
}
function animateChipBars() {
  if (!chipViz) return;
  const bars = document.querySelectorAll('.sc.ptt-chip.talking .sc-mic .bar');
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    localRecorder = new MediaRecorder(stream, { mimeType: mime });
    localRecChunks = [];
    localRecorder.ondataavailable = (e) => { if (e.data?.size) localRecChunks.push(e.data); };
    localRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(localRecChunks, { type: mime });
      localRecorder = null;
      localRecChunks = [];
      await postLocalTranscript(blob);
    };
    localRecorder.start();
    setIndicator('listening', 'Listening…');
  } catch (err) {
    pttActive = false;
    setPttHeld(false);
    setIndicator('error', `Mic: ${err.message}`);
    setTimeout(() => setIndicator('idle', 'Connected'), 2000);
  }
}

function stopLocalRecording() {
  try { localRecorder?.stop(); } catch {}
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
      // Local STT failed mid-session (sidecar died/unreachable) — fall back to
      // the browser engine for subsequent presses so voice keeps working.
      if (r.status === 502 || r.status === 400) localSttUrl = '';
      setIndicator('error', data?.error || `Transcribe ${r.status}`);
      setTimeout(() => setIndicator('idle', 'Connected'), 2000);
      return;
    }
    const text = (data?.text || '').trim();
    setIndicator('idle', 'Connected');
    if (!text) { setIndicator('idle', 'No speech detected'); setTimeout(() => setIndicator('idle', 'Connected'), 1500); return; }
    // Hand off to the same routes Speech 'end' uses so the rest of
    // the app behaves identically to the browser-STT flow.
    dispatchTranscript(text);
  } catch (err) {
    localSttUrl = ''; // network error reaching local STT — use the browser engine next time
    setIndicator('error', `Transcribe failed: ${err.message}`);
    setTimeout(() => setIndicator('idle', 'Connected'), 2000);
  }
}

/* Same logic as the Speech 'end' listener — extracted so both paths
 * route the final transcript through one handler. */
function dispatchTranscript(text) {
  if (editBubbleOpen) { editBubbleTextEl.value = text; return; }
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = text; renderNewProjectName(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = text; renderNewProjectGoal(); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
  if (mode === MODE_PROJECTS) { dispatchHomeUtterance(text); return; }
}

speech.addEventListener('partial', (e) => {
  if (e.detail) setIndicator('listening', `“${e.detail}”`);
  // Mirror the live transcript into the capture screen's mic-stack so
  // the user sees their words above the visualizer.
  const liveEl = document.querySelector('.capture-tile .mic-live-text');
  if (liveEl) liveEl.textContent = e.detail || '';
  // Enable the primary action button as soon as any text is recognized.
  const doneEl = document.getElementById('capture-done');
  if (doneEl && e.detail && e.detail.trim()) doneEl.disabled = false;
});
speech.addEventListener('end', (e) => {
  // SpeechRecognition stopped (browser closed the session). Clear the
  // pttActive flag so the next screen / button press can re-trigger
  // recognition cleanly — otherwise startPTT() short-circuits.
  pttActive = false;
  setPttHeld(false);
  const text = e.detail;
  if (!text) {
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
    newProjName = text;
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
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
  if (mode === MODE_PROJECTS) { dispatchHomeUtterance(text); return; }
});
speech.addEventListener('error', (e) => {
  pttActive = false;
  setPttHeld(false);
  setIndicator('error', `Speech error: ${e.detail}`);
  setTimeout(() => setIndicator('idle', 'Connected'), 2000);
});

/* ---------- v2 SSE event subscriber ----------
 * Single long-lived connection to GET /events. Every server-side
 * event (status, activity, delegate, …) lands here; specific
 * handlers update local state and the DOM. The connection
 * auto-reconnects if the server restarts. */
let _evtSource = null;
function startEventStream() {
  if (_evtSource) try { _evtSource.close(); } catch {}
  try {
    _evtSource = new EventSource('/events');
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

function handleBridgeEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'status': {
      if (!ev.agentId) return;
      agentStatus[ev.agentId] = ev.verb || 'idle';
      agentBusy[ev.agentId] = (ev.verb && ev.verb !== 'idle');
      paintAgentStatus(ev.agentId);
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
      break;
    }
    case 'note_added':
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
    case 'notification':
    case 'token':
    case 'tool':
    default:
      break;
  }
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
  const entry = {
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
      mode === MODE_NEW_PROJ_GOAL) return;
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
  // Update the header to reflect the scope (project vs cross-project).
  const headerEl = el.querySelector('header span');
  if (headerEl) headerEl.textContent = activeProject ? 'Activity' : 'Activity · all projects';
  repaintActivityList();
}
function closeActivityDrawer() {
  const el = document.getElementById('activity-drawer');
  if (!el) return;
  el.hidden = true;
  activityDrawerOpen = false;
  document.body.dataset.activityDrawer = 'closed';
}
function repaintActivityList() {
  const list = document.querySelector('#activity-drawer .activity-list');
  if (!list) return;
  list.innerHTML = '';
  // On L0 (cross-project), show entries from every project with a
  // project-name crumb prefix; otherwise filter to the active project.
  const entries = activeProject
    ? projectActivityForId(activeProject.id)
    : allActivity.slice();
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = activeProject
      ? 'No team activity yet.'
      : 'No activity across any project yet.';
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `activity-entry activity-${entry.kind}`;
    row.tabIndex = 0;
    row.dataset.projectId = entry.projectId || '';
    if (!activeProject) {
      // Open the project (and the agent, if known) on click / Enter
      // when this entry is selected from the cross-project feed.
      const open = () => openProjectFromActivityEntry(entry);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
      });
    }
    const line = document.createElement('div');
    line.className = 'activity-line';
    if (!activeProject) {
      const projName = projects.find(p => p.id === entry.projectId)?.name || '';
      if (projName) {
        const crumb = document.createElement('span');
        crumb.className = 'activity-project';
        crumb.textContent = projName;
        line.appendChild(crumb);
        line.appendChild(document.createTextNode(' · '));
      }
    }
    line.appendChild(document.createTextNode(entry.text));
    const meta = document.createElement('div');
    meta.className = 'activity-meta';
    meta.textContent = formatBubbleTime(entry.at) || '';
    row.append(line, meta);
    list.appendChild(row);
  }
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

/* Live-update an individual agent tile's status label + busy state. */
function paintAgentStatus(agentId) {
  const tile = document.querySelector(`.agent-tile[data-agent-id="${agentId}"]`);
  if (!tile) return;
  const verb = agentStatus[agentId] || 'idle';
  tile.dataset.status = verb;
  tile.dataset.busy = (verb !== 'idle') ? 'true' : 'false';
  const verbEl = tile.querySelector('.status .status-verb');
  if (verbEl) verbEl.textContent = verbLabel(verb);
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

function pickerMove(dir) {
  clearCenteredCreate();
  // (focus changes; defer the shortcut update until after the move below)
  const grid = surfaceEl.querySelector('.project-picker');
  if (!grid) return;
  const cols = grid._cols, rows = grid._rows;
  const n = ring.elements.length;
  if (n <= 1) return;
  const i = ring.index;
  const r = Math.floor(i / cols), c = i % cols;
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  let next = nr * cols + nc;
  if (next >= n) next = n - 1;
  ring.index = next;
  pickerIndex = next;
  ring.paint();
  updatePickerShortcuts();
}
async function exitToProjects() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
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
let folderState = { charters: true, notes: true }; // default open
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
  explorerFocused = true;
  fileFocus = 0;
  paintFileFocus();
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

const fileViewerEl      = document.getElementById('file-viewer');
const fileViewerPathEl  = fileViewerEl.querySelector('.file-viewer-path');
const fileViewerBodyEl  = fileViewerEl.querySelector('.file-viewer-body');
const fileViewerCloseEl = fileViewerEl.querySelector('.file-viewer-close');
let fileViewerOpen      = false;
fileViewerCloseEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFileViewer();
});
// Right-arrow off the × button: move focus to the surface itself so
// Enter closes the viewer. Left-arrow returns focus to the ×.
fileViewerCloseEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    closeFileViewer();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeFileViewer();
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
        li.className = 'file-entry';
        fileRender(li, f);
        fileTreeEl.appendChild(li);
        fileEntries.push(li);
      }
    }
  };

  addFolder('charters', 'Charters', fileTree.charters, (li, c) => {
    li.innerHTML = `<span>${escapeHtml(c.roleId)}.md</span><span class="who">${escapeHtml(c.agentName)}</span>`;
    li.dataset.path = c.path;
  });
  addFolder('notes', 'Notes', fileTree.notes, (li, n) => {
    li.textContent = n.path.replace(/^notes\//,'').replace(/\.md$/,'');
    li.dataset.path = n.path;
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
      empty.className = 'file-entry';
      empty.style.opacity = '0.5';
      empty.style.fontStyle = 'italic';
      empty.textContent = '(empty)';
      fileTreeEl.appendChild(empty);
    }
  }

  const pm = document.createElement('div');
  pm.className = 'file-entry';
  pm.textContent = 'project.md';
  pm.dataset.path = 'project.md';
  fileTreeEl.appendChild(pm);
  fileEntries.push(pm);
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
  fileViewerPathEl.textContent = path;
  fileViewerBodyEl.textContent = body;
  fileViewerEl.hidden = false;
  fileViewerOpen = true;
  document.body.dataset.fileViewer = 'open';
}

function closeFileViewer() {
  fileViewerEl.hidden = true;
  fileViewerOpen = false;
  document.body.dataset.fileViewer = 'closed';
  setSurfaceCloseFocus(false);
}

/** When the user arrows right off the viewer × button, the surface
 *  itself becomes the focus target — pressing Enter closes the viewer. */
let surfaceCloseFocused = false;
function setSurfaceCloseFocus(on) {
  surfaceCloseFocused = !!on;
  document.body.dataset.surfaceCloseFocus = on ? 'true' : 'false';
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
      if (active && typeof active.click === 'function') { active.click(); return; }
    }
    if (b === 'circle') { closeNotificationMenu();
                          document.getElementById('notification-btn')?.focus();
                          return; }
    return;
  }

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
    if (fileExplorerOpen) {
      if (b === 'up' || b === 'left')   { fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return; }
      if (b === 'down' || b === 'right'){ fileFocus = Math.min(fileEntries.length - 1, fileFocus + 1); paintFileFocus(); return; }
      if (b === 'cross')                { openFocusedFile(); return; }
      if (b === 'circle')               { closeFileExplorer(); return; }
    }
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') gridMove(b);
    else if (b === 'cross')   enterZoom();
    else if (b === 'circle')  exitToProjects();
    else if (b === 'square')  toggleFocusedAgentEnabled();
    else if (b === 'triangle') toggleActivityDrawer();
    return;
  }

  if (mode === MODE_ZOOM) {
    if (fileExplorerOpen) {
      if (b === 'up' || b === 'left')   { fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return; }
      if (b === 'down' || b === 'right'){ fileFocus = Math.min(fileEntries.length - 1, fileFocus + 1); paintFileFocus(); return; }
      if (b === 'cross')                { openFocusedFile(); return; }
      if (b === 'circle')               { closeFileExplorer(); return; }
    }
    if (b === 'up' || b === 'left')      ring.move(-1);
    else if (b === 'down' || b === 'right') ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'triangle')           toggleActivityDrawer();
    return;
  }

  if (mode === MODE_NEW_PROJ_TOPOLOGY) {
    if (b === 'left')        topoMoveCard(-1);
    else if (b === 'right')  topoMoveCard(+1);
    else if (b === 'down')   topoFocusBack();
    else if (b === 'up')     topoFocusCards();
    else if (b === 'cross') { const c = ring.current(); if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId); else c?.click?.(); }
    else if (b === 'circle') renderNewProjectRoles();
    return;
  }
  if (mode === MODE_NEW_PROJ_ROLES) {
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') {
      roleGridMove(b);
    } else if (b === 'cross')    toggleFocusedRole();
    else if (b === 'triangle')   advanceFromRolePicker();
    else if (b === 'circle')     renderProjects();
    return;
  }
  if (mode === MODE_ADD_AGENT) {
    // D-pad Up from the top row, or D-pad Right from the rightmost
    // column, hops onto the × close button.
    if ((b === 'up' || b === 'right') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
      const grid = surfaceEl.querySelector('.role-grid');
      if (grid) {
        const cols = grid._cols || 4;
        const r = Math.floor(ring.index / cols);
        const c = ring.index % cols;
        if ((b === 'up' && r === 0) || (b === 'right' && c === cols - 1)) {
          if (focusSurfaceClose()) return;
        }
      }
    }
    if (b === 'down') {
      const grid = surfaceEl.querySelector('.role-grid');
      if (grid) {
        const cols = grid._cols || 4;
        const n = ring.elements.length;
        const lastRow = Math.max(0, Math.ceil(n / cols) - 1);
        const r = Math.floor(ring.index / cols);
        if (r >= lastRow && enterShortcuts()) return;
      }
      roleGridMove('down');
    } else if (b === 'up' || b === 'left' || b === 'right') {
      roleGridMove(b);
    } else if (b === 'cross')    toggleFocusedAddAgentRole();
    else if (b === 'triangle')   commitAddAgentSelections();
    else if (b === 'circle')     renderGrid();
    return;
  }
  if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    if (b === 'left')        ring.move(-1);
    else if (b === 'right')  ring.move(+1);
    else if (b === 'cross') {
      const cur = ring.current();
      if (cur && typeof cur.click === 'function') cur.click();
      else confirmCapture();
    }
    else if (b === 'circle') goBackInCreateFlow();
    return;
  }
});

gp.addEventListener('press', (e) => {
  if (e.detail.button === 'options') toggleFileExplorer();
});

/* Right thumbstick on the controller scrolls the L2 chat-scroll
 * smoothly. y > 0 = stick deflected down → scroll down; y < 0 →
 * scroll up. Speed scales with deflection. The gamepad driver
 * already applies a 0.15 dead-zone. */
const RSTICK_MAX_PX_PER_TICK = 32;
gp.addEventListener('rstick', (e) => {
  if (mode !== MODE_ZOOM) return;
  const dy = e.detail?.y || 0;
  if (!dy) return;
  const chat = surfaceEl?.querySelector?.('.chat-scroll');
  if (!chat) return;
  // Override the .chat-scroll's CSS smooth-scroll briefly so this
  // call lands as a tight per-frame scroll. The auto behavior also
  // ensures the next legitimate smooth scroll (e.g. arrow-key bubble
  // focus) still animates.
  chat.scrollBy({ top: dy * RSTICK_MAX_PX_PER_TICK, left: 0, behavior: 'auto' });
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
const settingsRoleModelsEl= document.getElementById('settings-role-models');
const settingsMcpListEl   = document.getElementById('settings-mcp-list');
const settingsMcpAddEl    = document.getElementById('settings-mcp-add');
const settingsGitEnabledEl= document.getElementById('settings-git-enabled');
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
const settingsTabEls      = [...document.querySelectorAll('.settings-tab')];
const settingsPaneEls     = [...document.querySelectorAll('.settings-pane')];
let settingsOpen = false;
let settingsModelsList = []; // shared OpenRouter model list
let settingsRolesList = []; // [{ id, label }]
let settingsMcpEntries = []; // [{ id, name, enabled }]

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
}
settingsTabEls.forEach(t => t.addEventListener('click', () => selectSettingsTab(t.dataset.tab)));

function buildModelOptions(currentId, includeUseDefault = false) {
  const frag = document.createDocumentFragment();
  if (includeUseDefault) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— Use default —';
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

function populateRoleModels(byRole) {
  settingsRoleModelsEl.innerHTML = '';
  for (const role of settingsRolesList) {
    const row = document.createElement('div');
    row.className = 'role-model-row';
    const label = document.createElement('div');
    label.className = 'role-label';
    label.textContent = role.label;
    const select = document.createElement('select');
    select.dataset.role = role.id;
    select.appendChild(buildModelOptions(byRole[role.id] || '', true));
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
  populateRoleModels(s.OPENROUTER_MODEL_BY_ROLE || {});
  populateMcpList(s.MCP_PLUGINS || []);
  settingsGitEnabledEl.checked = !!s.GIT_AUTOSAVE;
  settingsGitIntervalEl.value = Number(s.GIT_AUTOSAVE_INTERVAL_MIN || 5);
  if (settingsSttUrlEl) settingsSttUrlEl.value = s.LOCAL_STT_URL || '';
  // Keep the local STT cache in sync with the server.
  localSttUrl = s.LOCAL_STT_URL || '';
  paintGitState();
  // Land focus on the first tab so the user can immediately navigate
  // with arrows / d-pad.
  setTimeout(() => settingsTabEls[0]?.focus(), 0);
}

function closeSettings() {
  settingsModalEl.hidden = true;
  settingsOpen = false;
}

/** Every focusable in the modal, in visual order: tabs → active-pane
 *  controls → action-row buttons. */
function settingsFocusables() {
  const tabs = settingsTabEls;
  const activePane = settingsPaneEls.find(p => !p.hidden);
  const paneFocusables = activePane
    ? [...activePane.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])')]
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
  next?.focus();
}

/* Gamepad input for the settings modal. Mirrors the keyboard model:
 * dpad navigates, cross activates, circle closes. */
function handleSettingsGamepad(button) {
  const active = document.activeElement;
  const isTab = settingsTabEls.includes(active);
  if (button === 'circle') { closeSettings(); return; }
  if (button === 'cross') {
    if (active === settingsCancelEl) { closeSettings(); return; }
    if (active === settingsSaveEl)   { saveSettings(); return; }
    if (active && active.tagName === 'BUTTON') { active.click(); return; }
    if (active && active.type === 'checkbox')  { active.checked = !active.checked; return; }
    // Default: treat as Save.
    saveSettings();
    return;
  }
  if (isTab && (button === 'left' || button === 'right')) {
    const i = settingsTabEls.indexOf(active);
    const next = settingsTabEls[(i + (button === 'right' ? 1 : -1) + settingsTabEls.length) % settingsTabEls.length];
    selectSettingsTab(next.dataset.tab);
    next.focus();
    return;
  }
  if (isTab && button === 'down') {
    const items = settingsFocusables();
    const firstPane = items.find(el => !settingsTabEls.includes(el) && el !== settingsCancelEl && el !== settingsSaveEl);
    (firstPane || settingsSaveEl)?.focus();
    return;
  }
  if (button === 'up')   { focusNextInModal(-1); return; }
  if (button === 'down') { focusNextInModal(+1); return; }
  if ((button === 'left' || button === 'right') && (active === settingsCancelEl || active === settingsSaveEl)) {
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

  // Left/Right cycles tabs when a tab is focused.
  if (isTab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); e.stopPropagation();
    const i = settingsTabEls.indexOf(active);
    const next = settingsTabEls[(i + (e.key === 'ArrowRight' ? 1 : -1) + settingsTabEls.length) % settingsTabEls.length];
    selectSettingsTab(next.dataset.tab);
    next.focus();
    return;
  }

  // Down from a tab enters the active pane.
  if (isTab && e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    const items = settingsFocusables();
    const firstPane = items.find(el => !settingsTabEls.includes(el) && el !== settingsCancelEl && el !== settingsSaveEl);
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
    if (active === settingsCancelEl) { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
    if (active === settingsSaveEl)   { e.preventDefault(); e.stopPropagation(); saveSettings(); return; }
    if (active && active.tagName === 'BUTTON') { e.preventDefault(); e.stopPropagation(); active.click(); return; }
    if (active && (active.tagName === 'INPUT' && active.type !== 'checkbox')) {
      e.preventDefault(); e.stopPropagation(); saveSettings(); return;
    }
    if (active && active.type === 'checkbox') { e.preventDefault(); e.stopPropagation(); active.checked = !active.checked; return; }
  }

  // Space toggles checkboxes (HTML default already does this, but make
  // it explicit so it doesn't bubble out to the surface PTT handler).
  if (e.key === ' ' && active && active.type === 'checkbox') {
    e.stopPropagation();
  }
});

async function saveSettings() {
  const updates = {};
  const apiKey = settingsApiKeyEl.value.trim();
  // Don't ship the placeholder back — that would clobber the real
  // key with literal asterisks.
  if (apiKey && apiKey !== API_KEY_PLACEHOLDER) updates.OPENROUTER_API_KEY = apiKey;
  const model = (settingsModelEl.value || '').trim();
  if (model) updates.OPENROUTER_MODEL = model;

  const byRole = {};
  for (const sel of settingsRoleModelsEl.querySelectorAll('select')) {
    const v = sel.value.trim();
    if (v) byRole[sel.dataset.role] = v;
  }
  updates.OPENROUTER_MODEL_BY_ROLE = byRole;
  updates.MCP_PLUGINS = settingsMcpEntries;
  updates.GIT_AUTOSAVE = !!settingsGitEnabledEl.checked;
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

settingsBtnEl?.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
settingsBtnEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    openSettings();
  }
});
settingsSaveEl?.addEventListener('click', () => saveSettings());
settingsCancelEl?.addEventListener('click', () => closeSettings());
document.getElementById('settings-close')?.addEventListener('click', () => closeSettings());

/* ---------- Full-screen toggle ---------- */
const fullscreenBtnEl = document.getElementById('fullscreen-btn');
function isFullscreen() { return !!document.fullscreenElement; }
function toggleFullscreen() {
  if (isFullscreen()) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
function paintFullscreenIcon() {
  if (!fullscreenBtnEl) return;
  const fs = isFullscreen();
  fullscreenBtnEl.querySelector('.fs-enter')?.toggleAttribute('hidden', fs);
  fullscreenBtnEl.querySelector('.fs-exit')?.toggleAttribute('hidden', !fs);
  const label = fs ? 'Exit full screen' : 'Enter full screen';
  fullscreenBtnEl.setAttribute('aria-label', label);
  fullscreenBtnEl.setAttribute('title', fs ? 'Exit full screen' : 'Full screen');
}
fullscreenBtnEl?.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
fullscreenBtnEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    toggleFullscreen();
  }
});
document.addEventListener('fullscreenchange', paintFullscreenIcon);

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
  // handler take care of Esc / Tab / arrows / Enter.
  if (settingsOpen || editBubbleOpen || confirmCancelOpen || projectEditOpen) return;

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
  // Hold 'v' for push-to-talk (voice).
  if (e.key === 'v' && !e.repeat) {
    e.preventDefault();
    if (mode === MODE_PROJECTS) talkToFocusedLead();
    else startPTT();
    return;
  }

  if (e.key === 'e' || e.key === 'E') {
    // toggleFileExplorer bails outside the surface modes (L1 / L2 /
    // add-agent), so no extra guard needed here.
    e.preventDefault();
    toggleFileExplorer();
    return;
  }
  if (e.key === 'm' || e.key === 'M') {
    if (mode === MODE_PROJECTS) {
      e.preventDefault();
      toggleMemoryDrawer();
      return;
    }
  }
  if (e.key === 'a' || e.key === 'A') {
    if (mode === MODE_GRID || mode === MODE_ZOOM ||
        mode === MODE_ADD_AGENT || mode === MODE_PROJECTS) {
      e.preventDefault();
      toggleActivityDrawer();
      return;
    }
  }
  if (e.key === '/')  { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); return; }

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
    if (e.key === 'ArrowUp') {
      e.preventDefault(); fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return;
    }
    if (e.key === 'ArrowLeft')                               { e.preventDefault(); fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return; }
    if (e.key === 'ArrowDown')                               { e.preventDefault(); fileFocus = Math.min(fileEntries.length - 1, fileFocus + 1); paintFileFocus(); return; }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      explorerFocused = false;
      fileEntries.forEach(el => el.classList.remove('focused'));
      if (fileViewerOpen && fileViewerCloseEl) {
        // Land on the viewer's × close button.
        fileViewerCloseEl.focus();
      } else {
        // No viewer — give focus back to the main surface (agent grid /
        // agent zoom). Re-paint the ring so the user sees their cursor.
        ring.paint();
      }
      return;
    }
    if (e.key === 'Enter')                                  { e.preventDefault(); openFocusedFile(); return; }
    if (e.key === 'Escape')                                 { e.preventDefault(); closeFileExplorer(); return; }
  }
  // Shortcuts rail (bottom-left) is part of the focus order: arrow-down
  // from the main surface enters it; arrow-up exits back to the grid.
  if (isShortcutsFocused()) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); moveShortcutFocus(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveShortcutFocus(+1); return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); leaveShortcuts(); ring.paint(); return; }
    if (e.key === 'Enter')      { e.preventDefault(); activateFocusedShortcut(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); leaveShortcuts(); ring.paint(); return; }
  }

  if (mode === MODE_PROJECTS) {
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      slideToAdjacentProject(e.key === ']' ? +1 : -1);
    } else if (e.key === 'ArrowDown') {
      // Descend into the rail when the cursor is on the last row that
      // has actual content (not the grid's nominal last row — sparse
      // grids may have empty rows below).
      const grid = surfaceEl.querySelector('.project-picker');
      if (grid) {
        const cols = grid._cols;
        const n = ring.elements.length;
        const lastRow = Math.max(0, Math.ceil(n / cols) - 1);
        const r = Math.floor(ring.index / cols);
        if (r >= lastRow && enterShortcuts()) { e.preventDefault(); return; }
      }
      e.preventDefault(); pickerMove(dir);
    } else if (dir) { e.preventDefault(); pickerMove(dir); }
    else if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      if (ring.index < projects.length) startProjectHold(ring.index); // hold a project → edit modal
      else openFocused();                                             // "+ New" → open now
    }
  } else if (mode === MODE_NEW_PROJ_TOPOLOGY) {
    if (e.key === 'ArrowLeft')       { e.preventDefault(); topoMoveCard(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); topoMoveCard(+1); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); topoFocusBack(); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); topoFocusCards(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = ring.current();
      if (c?.dataset?.topoId) chooseTopology(c.dataset.topoId);
      else c?.click?.();
    }
    else if (e.key === 'Backspace' || e.key === 'Delete')    { e.preventDefault(); renderNewProjectRoles(); }
  } else if (mode === MODE_NEW_PROJ_ROLES) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (advanceDownFromRolePicker()) return;
      roleGridMove('down');
    } else if (dir) { e.preventDefault(); roleGridMove(dir); }
    else if (e.code === 'Space')  { e.preventDefault(); toggleFocusedRole(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = ring.current();
      if (cur && !cur.classList?.contains('role-tile') && typeof cur.click === 'function') {
        cur.click();
      } else {
        advanceFromRolePicker();
      }
    }
    else if (e.key === 'Backspace' || e.key === 'Delete')  { e.preventDefault(); renderProjects(); }
  } else if (mode === MODE_ADD_AGENT) {
    // Up / Right from the top-right of the grid hops to the × close button.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowRight') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
      const grid = surfaceEl.querySelector('.role-grid');
      if (grid) {
        const cols = grid._cols || 4;
        const r = Math.floor(ring.index / cols);
        const c = ring.index % cols;
        if ((e.key === 'ArrowUp' && r === 0) || (e.key === 'ArrowRight' && c === cols - 1)) {
          if (focusSurfaceClose()) { e.preventDefault(); return; }
        }
      }
    }
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
    else if (e.key === 'Backspace' || e.key === 'Delete')  { e.preventDefault(); renderGrid(); }
  } else if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    // Action-row buttons (Cancel · Back · Continue/Create) form the
    // ring. Left/Right walks them; Enter activates the focused one.
    if (e.key === 'ArrowLeft')  { e.preventDefault(); ring.move(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); enterShortcuts(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cur = ring.current();
      if (cur && typeof cur.click === 'function') cur.click();
      else confirmCapture();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); goBackInCreateFlow(); return; }
  }

  // Surface holds "close viewer" focus — Enter closes; Left returns to ×.
  if (surfaceCloseFocused) {
    if (e.key === 'Enter')      { e.preventDefault(); closeFileViewer(); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setSurfaceCloseFocus(false); fileViewerCloseEl?.focus(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeFileViewer(); return; }
  }

  // File viewer (right panel) — Esc closes it before any back navigation.
  if (fileViewerOpen && e.key === 'Escape') {
    e.preventDefault();
    closeFileViewer();
    return;
  }

  if (mode === MODE_GRID) {
    // Up arrow at the top row of the grid hops focus to the × close
    // button at the top-right; Right at the rightmost cell does the same.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowRight') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
      const grid = surfaceEl.querySelector('.agent-grid');
      if (grid) {
        const cols = grid._cols, rows = grid._rows;
        const r = Math.floor(ring.index / cols);
        const c = ring.index % cols;
        if ((e.key === 'ArrowUp' && r === 0) || (e.key === 'ArrowRight' && c === cols - 1)) {
          if (focusSurfaceClose()) { e.preventDefault(); return; }
        }
      }
    }
    // Left from the leftmost grid column with the explorer open hops
    // focus back into the explorer.
    if (e.key === 'ArrowLeft' && fileExplorerOpen && !explorerFocused) {
      const grid = surfaceEl.querySelector('.agent-grid');
      const cols = grid?._cols || 4;
      if ((ring.index % cols) === 0) {
        e.preventDefault();
        explorerFocused = true;
        ring.items.forEach(el => el.classList.remove('focused'));
        paintFileFocus();
        return;
      }
    }
    if (e.key === 'ArrowDown') {
      const grid = surfaceEl.querySelector('.agent-grid');
      if (grid) {
        const cols = grid._cols;
        const n = ring.elements.length;
        const lastRow = Math.max(0, Math.ceil(n / cols) - 1);
        const r = Math.floor(ring.index / cols);
        if (r >= lastRow && enterShortcuts()) { e.preventDefault(); return; }
      }
      e.preventDefault(); gridMove('down');
    } else if (dir) { e.preventDefault(); gridMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); exitToProjects(); }
    else if (e.code === 'Space') { e.preventDefault(); toggleFocusedAgentEnabled(); }
    else if (e.key === '[')      { e.preventDefault(); cycleProject(-1); }
    else if (e.key === ']')      { e.preventDefault(); cycleProject(+1); }
  } else if (mode === MODE_ZOOM) {
    // Chat bubble selection. ArrowUp from the surface enters the chat
    // history at the last bubble; once inside, ArrowUp/Down walks
    // bubbles, Left/Right cycles their action icons, Enter activates.
    if (isBubbleFocused()) {
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveBubbleFocus(-1); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (chatBubbleIdx >= chatBubbles.length - 1) { leaveBubbleFocus(); ring.paint(); return; }
        moveBubbleFocus(+1); return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const bubble = chatBubbles[chatBubbleIdx];
        const actions = bubble?.querySelectorAll('.bubble-action');
        if (!actions || actions.length === 0) return;
        const active = document.activeElement;
        const arr = [...actions];
        const idx = arr.indexOf(active);
        const next = (idx === -1)
          ? (e.key === 'ArrowRight' ? 0 : arr.length - 1)
          : Math.max(0, Math.min(arr.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
        e.preventDefault();
        arr[next].focus();
        return;
      }
      if (e.key === 'Enter' && document.activeElement?.classList?.contains('bubble-action')) {
        // Activate the focused action icon.
        e.preventDefault(); document.activeElement.click(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); leaveBubbleFocus(); ring.paint(); return; }
    }
    // Up / Right hops to the × close button, unless we're entering the
    // chat history (handled above) or already on a tile-surface focusable.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowRight') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
      if (ring.index === 0 && e.key === 'ArrowUp' && chatBubbles.length > 0) {
        e.preventDefault(); focusLastBubble(); return;
      }
      if (ring.index === 0 && focusSurfaceClose()) { e.preventDefault(); return; }
    }
    // Left at the first ring position with explorer open hops back in.
    if (e.key === 'ArrowLeft' && fileExplorerOpen && !explorerFocused && ring.index === 0) {
      e.preventDefault();
      explorerFocused = true;
      ring.items.forEach(el => el.classList.remove('focused'));
      paintFileFocus();
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
    else if (e.key === 'Backspace' || e.key === 'Delete')     { e.preventDefault(); pressCircle(); }
    else if (e.key === '[')          { e.preventDefault(); cycleAgent(-1); }
    else if (e.key === ']')          { e.preventDefault(); cycleAgent(+1); }
  }
});

function submitTypedText(text) {
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = text; renderNewProjectGoal(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = text; finalizeNewProject(); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
}

async function submitIntent(text) {
  const agent = currentAgent();
  if (!agent || mode !== MODE_ZOOM) return;
  if (inflightController) inflightController.abort();
  inflightController = new AbortController();
  const myCtl = inflightController;
  const targetId = agent.id;

  agentBusy[targetId] = true;
  setIndicator('thinking', `${agent.name} is thinking…`);
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${targetId}/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: myCtl.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
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
    setIndicator('error', 'Request failed');
  } finally {
    agentBusy[targetId] = false;
    if (myCtl === inflightController) inflightController = null;
  }
}
async function submitTeamIntent(text) {
  if (mode !== MODE_GRID || !activeProject) return;
  if (inflightController) inflightController.abort();
  inflightController = new AbortController();
  const myCtl = inflightController;

  const leadId = activeProject.leadAgentId;
  agentBusy[leadId] = true;
  setIndicator('thinking', 'Lead is delegating…');
  renderGrid();

  try {
    const r = await fetch(`/projects/${activeProject.id}/team/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
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

async function finalizeNewProject() {
  stopMicVisualizer();
  setIndicator('thinking', 'Customizing team charters…');
  try {
    const r = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjName.trim(), goal: newProjGoal.trim(), roleIds: newProjRoleIds, topology: newProjTopology }),
    });
    if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
    const project = await r.json();
    await loadProjects();
    activeProject = withLeadFirst(project);
    pickerIndex = projects.findIndex(p => p.id === project.id);
    gridIndex = 0; zoomedIndex = 0;
    setIndicator('idle', 'Connected');
    renderGrid();
  } catch (err) {
    setIndicator('error', 'Create failed');
    console.error(err);
  }
}
window.addEventListener('keyup', (e) => {
  if (e.key === 'v') { e.preventDefault(); endPTT(); }
});

/* ---------- Boot ---------- */
(async () => {
  await loadProjects();
  // Restore the last screen the user was on (survives page refresh).
  const saved = readNavState();
  let restored = false;
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
  if (!restored) {
    if (saved?.pickerIndex) pickerIndex = saved.pickerIndex;
    renderProjects();
  }
  staggerInCards();
  staggerInFooter();
  setIndicator('idle', 'Connected');
  startConnectionPing();
  console.log('[bridge] booted into', mode);
})();

/* Ping /health every 5 s — flip the indicator to red on failure, back to
 * green on success. Skip while listening / thinking so we don't clobber
 * those transient states. */
function startConnectionPing() {
  // Indicator removed from the chrome — no need to poll.
}
