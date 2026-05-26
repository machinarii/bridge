import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking } from './speech.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';

const surfaceEl       = document.getElementById('surface');
const indicatorEl     = document.getElementById('listening-indicator');     // removed from DOM
const indicatorTextEl = indicatorEl?.querySelector('.state-text') || null;
const breadcrumbsEl   = document.getElementById('breadcrumbs');             // removed from DOM
const typedWrap       = document.getElementById('ptt-typed');
const typedInput      = document.getElementById('typed-input');
const shortcutsRailEl = document.getElementById('shortcuts-rail');
const primaryShortcutEl = document.getElementById('primary-shortcut');

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
  const rail = [...shortcutsRailEl.querySelectorAll('.sc')];
  const primary = [...primaryShortcutEl.querySelectorAll('.sc')];
  const actions = [...document.querySelectorAll('#action-bar .action')];
  const gear = document.getElementById('settings-btn');
  return [...rail, ...primary, ...actions, ...(gear ? [gear] : [])];
}
function setShortcuts(items) {
  shortcutsRailEl.innerHTML = '';
  shortcutItems = items || [];
  shortcutFocusIdx = -1;
  const GAMEPAD = { cross: '✕', circle: '○', square: '□', triangle: '△' };
  shortcutItems.forEach((it, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'sc';
    wrap.dataset.idx = String(i);
    if (it.action) {
      wrap.style.cursor = 'pointer';
      wrap.addEventListener('click', () => it.action());
    }
    if (it.gamepad) {
      const g = document.createElement('span');
      g.className = 'glyph for-gamepad';
      g.dataset.glyph = it.gamepad;
      g.textContent = GAMEPAD[it.gamepad] || it.gamepad;
      wrap.appendChild(g);
    }
    if (it.keyboard) {
      const k = document.createElement('span');
      k.className = 'glyph for-keyboard';
      k.dataset.glyph = it.gamepad || '';
      k.textContent = it.keyboard;
      wrap.appendChild(k);
    }
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = it.label;
    wrap.appendChild(l);
    shortcutsRailEl.appendChild(wrap);
  });
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
    g.textContent = GAMEPAD[item.gamepad] || item.gamepad;
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
  const map = { ' ': 'Space', 'Escape': 'Esc', 'Enter': 'Enter', 'Tab': 'Tab' };
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
const MODE_NEW_PROJ_ROLES   = 'new_project_roles'; // create-flow step 1
const MODE_NEW_PROJ_NAME    = 'new_project_name';  // create-flow step 2
const MODE_NEW_PROJ_GOAL    = 'new_project_goal';  // create-flow step 3
const MODE_GRID             = 'grid';              // L1 (project grid)
const MODE_ZOOM             = 'zoom';              // L2 (agent zoom)

let mode = MODE_PROJECTS;
let projects = [];                // [{ id, name, agents, ... }]
let pickerIndex = 0;              // focus index on project picker (0..N where N = "+ New")
let activeProject = null;         // project record at L1/L2
let zoomedIndex = 0;
let gridIndex = 0;
let agentBusy = {};
let inflightController = null;
let pttActive = false;

// Create-project flow state
let newProjRoleIds = [];          // toggled during step 1
let newProjName    = '';          // captured during step 2
let newProjGoal    = '';          // captured during step 3

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
      <div class="meta">${p.agents.length} agent${p.agents.length===1?'':'s'}</div>`;
    const myIdx = tileEls.length;
    tile.addEventListener('click', () => { pickerIndex = myIdx; ring.index = myIdx; ring.paint(); openFocused(); });
    grid.appendChild(tile);
    tileEls.push(tile);
  }
  // "+ New" tile
  const plus = document.createElement('div');
  plus.className = 'project-tile new-project';
  plus.innerHTML = `<h2 class="name">+ New project</h2><div class="meta">Create a team</div>`;
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

/** On L0, the shortcuts rail reflects the focused project's lead so
 *  the user can talk to that project's PM from the home screen.
 *  Hidden when "+ New" is focused. */
function updatePickerShortcuts() {
  if (mode !== MODE_PROJECTS) return;
  const idx = ring.index ?? pickerIndex;
  const focused = idx < projects.length ? projects[idx] : null;
  if (!focused) { setShortcuts([]); return; }
  const lead = focused.agents.find(a => a.id === focused.leadAgentId);
  const leadName = lead?.name || 'Lead';
  setShortcuts([
    { gamepad: 'r2', keyboard: 'V', label: `Hold to talk`,
      action: () => talkToFocusedLead() },
  ]);
}

/** Open the focused project, wait for the morph to land, then start
 *  PTT so the user can talk to the lead immediately. */
async function talkToFocusedLead() {
  // No-op when "+ New" is focused — there's no lead to talk to.
  const idx = ring.index ?? pickerIndex;
  if (idx >= projects.length) return;
  await openFocused();
  startPTT();
}

/* ---------- Top-right close (×) button on L1 / L2 ---------- */
function createSurfaceCloseButton(onClose) {
  const btn = document.createElement('button');
  btn.className = 'surface-close';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Close');
  btn.textContent = '×';
  btn.addEventListener('click', onClose);
  btn.addEventListener('keydown', (e) => {
    // Must stopPropagation — otherwise window's bubble handler runs the
    // mode-specific Enter action (openFocused/enterZoom) immediately
    // after onClose, which re-opens the project the user just exited.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
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
  if (idx === tileCount() - 1) {
    // "+ New" — enter create flow
    newProjRoleIds = [];
    newProjName = '';
    newProjGoal = '';
    renderNewProjectRoles();
    return;
  }
  const sourceTile = ring.current();
  const sourceRect = sourceTile?.getBoundingClientRect();
  const targetRect = surfaceContentRect();
  zoomStack.push(sourceRect);
  activeProject = withLeadFirst(projects[idx]);
  gridIndex = 0;
  zoomedIndex = 0;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderGrid());
}

function tileCount() { return projects.length + 1; }

async function renderNewProjectRoles() {
  mode = MODE_NEW_PROJ_ROLES;
  // PM is the locked-in lead — pre-select and prevent removal.
  if (!newProjRoleIds.includes('pm')) newProjRoleIds = ['pm', ...newProjRoleIds];
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Roles' }]);
  surfaceEl.innerHTML = '';

  // Lazy-load role catalog
  if (!window._roles) {
    const r = await fetch('/roles');
    const data = await r.json();
    window._roles = data.roles;
  }
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
  surfaceEl.appendChild(wrap);

  ring.set(tileEls);
  ring.index = 0;
  ring.paint();

  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_role_back' } },
  ]);
  setShortcuts([
    { gamepad: 'cross',  keyboard: 'Space', label: 'Toggle', action: () => toggleFocusedRole() },
    { gamepad: 'circle', keyboard: 'Esc',   label: 'Back',   action: () => renderProjects() },
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
  renderNewProjectName();
}

function goBackInCreateFlow() {
  if (mode === MODE_NEW_PROJ_GOAL) renderNewProjectName();
  else if (mode === MODE_NEW_PROJ_NAME) renderNewProjectRoles();
  else renderProjects();
}

function confirmCapture() {
  if (mode === MODE_NEW_PROJ_NAME) {
    if (!newProjName.trim()) { setIndicator('error', 'Speak or type a name'); return; }
    renderNewProjectGoal();
  } else if (mode === MODE_NEW_PROJ_GOAL) {
    if (!newProjGoal.trim()) { setIndicator('error', 'Speak or type a goal'); return; }
    finalizeNewProject();
  }
}
function renderNewProjectName() {
  mode = MODE_NEW_PROJ_NAME;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Name' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>Name this project</h2>
    <div class="capture-value">${escapeHtml(newProjName) || '<span class="placeholder">(Speak now)</span>'}</div>
    ${newProjRoleIds.includes('pm') || newProjRoleIds.includes('tpm')
      ? ''
      : '<div class="lead-badge">Cadence will lead this team.</div>'}`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  ring.set([]);
}

function renderNewProjectGoal() {
  mode = MODE_NEW_PROJ_GOAL;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Goal' }]);
  surfaceEl.innerHTML = '';
  const t = document.createElement('section');
  t.className = 'capture-tile';
  t.innerHTML = `
    <h2>What is this project's goal?</h2>
    <div class="capture-value">${escapeHtml(newProjGoal) || '<span class="placeholder">(Speak now)</span>'}</div>`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'circle', keyboard: 'Esc', label: 'Back', action: () => goBackInCreateFlow() },
  ]);
  setPrimaryShortcut({ gamepad: 'cross', keyboard: 'Enter', label: 'Select',
                       action: () => confirmCapture() });
  ring.set([]);
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
    tile.dataset.busy = agentBusy[a.id] ? 'true' : 'false';
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(a.name)}</h2>
      <div class="role">${escapeHtml(roleLabel(a.role))}</div>
      <div class="status"><span class="dot"></span><span>${agentBusy[a.id] ? 'Thinking…' : 'Idle'}</span></div>`;
    tile.addEventListener('click', () => { gridIndex = i; ring.set(tileEls); ring.index = i; ring.paint(); enterZoom(); });
    grid.appendChild(tile);
    return tile;
  });

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(gridIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([
    { verb: 'Back', glyph: 'circle', action: { type: '_grid_back' } },
  ]);
  updateGridShortcuts();
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
    {                    keyboard: 'S', label: 'Skills',   action: () => toggleSkillsDrawer() },
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
    if (autoSpeak && !specOverride?._silent) speak(autoSpeak);
  } else {
    renderActionBar([]);
    ring.set([]);
    if (spec.body && !specOverride?._silent) speak(spec.body);
  }
  _setL2Shortcuts();
}

async function renderChatHistory(container, agent) {
  container.innerHTML = '';
  try {
    const r = await fetch(`/projects/${activeProject.id}/agents/${agent.id}/history`);
    if (!r.ok) return;
    const { messages } = await r.json();
    for (const m of messages) {
      const bubble = document.createElement('div');
      bubble.className = `bubble ${m.role === 'user' ? 'user' : 'agent'}`;
      let body = String(m.content || '').trim();
      if (m.role === 'assistant') {
        // The assistant turn is the raw spec JSON; extract its body.
        try {
          const parsed = JSON.parse(body.replace(/^```(?:json)?/i,'').replace(/```$/, '').trim());
          if (parsed?.body) body = parsed.body;
          else if (parsed?.title) body = parsed.title;
        } catch { /* leave body as-is */ }
      }
      bubble.textContent = body;
      container.appendChild(bubble);
    }
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.warn('[chat] history failed:', err);
  }
}

function _setL2Shortcuts() {
  setShortcuts([
    { gamepad: 'r2',      keyboard: 'V', label: 'Hold to talk', action: () => startPTT() },
    {                     keyboard: '/', label: 'Type prompt',  action: () => { typedWrap.hidden = false; typedInput.focus(); } },
    { gamepad: 'l1',      keyboard: '[', label: 'Prev agent',   action: () => cycleAgent(-1) },
    { gamepad: 'r1',      keyboard: ']', label: 'Next agent',   action: () => cycleAgent(+1) },
    { gamepad: 'options', keyboard: 'E', label: 'Explorer',     action: () => toggleFileExplorer() },
    {                     keyboard: 'S', label: 'Skills',       action: () => toggleSkillsDrawer() },
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
const PTT_MODES = new Set([MODE_ZOOM, MODE_GRID, MODE_NEW_PROJ_NAME, MODE_NEW_PROJ_GOAL]);
function startPTT() {
  if (pttActive) return;
  if (!PTT_MODES.has(mode)) return;
  pttActive = true;
  stopSpeaking();
  if (!speech.supported) {
    setIndicator('error', 'Speech not supported — press / to type');
    typedWrap.hidden = false;
    typedInput.focus();
    pttActive = false;
    return;
  }
  setIndicator('listening', 'Listening…');
  speech.start();
}

function endPTT() {
  if (!pttActive) return;
  pttActive = false;
  if (speech.supported) speech.stop();
}

speech.addEventListener('partial', (e) => {
  if (e.detail) setIndicator('listening', `“${e.detail}”`);
});
speech.addEventListener('end', (e) => {
  const text = e.detail;
  if (!text) {
    setIndicator('idle', 'No speech detected');
    setTimeout(() => setIndicator('idle', 'Connected'), 1500);
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
});
speech.addEventListener('error', (e) => {
  setIndicator('error', `Speech error: ${e.detail}`);
  setTimeout(() => setIndicator('idle', 'Connected'), 2000);
});

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
  if (skillsDrawerOpen) closeSkillsDrawer();
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
let projectSkills = {}; // { [projectId]: [{ name, desc }] } — client-side
let skillsDrawerOpen = false;

const skillsDrawerEl = document.getElementById('skills-drawer');
const skillsListEl   = skillsDrawerEl?.querySelector('.skills-list');

function toggleSkillsDrawer() {
  if (mode === MODE_PROJECTS) return;
  if (!activeProject) return;
  if (skillsDrawerOpen) { closeSkillsDrawer(); return; }
  openSkillsDrawer();
}
function openSkillsDrawer() {
  syncExplorerHeights();
  rebuildSkillsList();
  skillsDrawerEl.hidden = false;
  skillsDrawerOpen = true;
  document.body.dataset.skillsDrawer = 'open';
  if (fileExplorerOpen) closeFileExplorer();
}
function closeSkillsDrawer() {
  skillsDrawerEl.hidden = true;
  skillsDrawerOpen = false;
  document.body.dataset.skillsDrawer = 'closed';
}
function rebuildSkillsList() {
  const list = projectSkills[activeProject.id] || [];
  skillsListEl.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'skills-empty';
    empty.textContent = 'No skills yet.';
    skillsListEl.appendChild(empty);
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'skill-entry';
    row.innerHTML = `<div class="skill-name">${escapeHtml(s.name)}</div>
                     <div class="skill-desc">${escapeHtml(s.desc || '')}</div>`;
    skillsListEl.appendChild(row);
  }
}

async function toggleFileExplorer() {
  if (mode === MODE_PROJECTS) return;
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
  if (skillsDrawerOpen) closeSkillsDrawer();
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

  if (mode === MODE_PROJECTS) {
    if (b === 'left' || b === 'right' || b === 'up' || b === 'down') {
      pickerMove(b);
    } else if (b === 'cross') {
      openFocused();
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
  if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    if (b === 'cross')   confirmCapture();
    else if (b === 'circle') goBackInCreateFlow();
    return;
  }
});

gp.addEventListener('press', (e) => {
  if (e.detail.button === 'options') toggleFileExplorer();
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
const settingsApiMetaEl   = document.getElementById('settings-api-key-current');
const settingsModelEl     = document.getElementById('settings-model');
const settingsRoleModelsEl= document.getElementById('settings-role-models');
const settingsMcpListEl   = document.getElementById('settings-mcp-list');
const settingsMcpAddEl    = document.getElementById('settings-mcp-add');
const settingsGitEnabledEl= document.getElementById('settings-git-enabled');
const settingsGitIntervalEl = document.getElementById('settings-git-interval');
const settingsSaveEl      = document.getElementById('settings-save');
const settingsCancelEl    = document.getElementById('settings-cancel');
const settingsTabEls      = [...document.querySelectorAll('.settings-tab')];
const settingsPaneEls     = [...document.querySelectorAll('.settings-pane')];
let settingsOpen = false;
let settingsModelsList = []; // shared OpenRouter model list
let settingsRolesList = []; // [{ id, label }]
let settingsMcpEntries = []; // [{ id, name, enabled }]

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
  if (settingsOpen) return;
  settingsOpen = true;
  settingsModalEl.hidden = false;
  selectSettingsTab('general');
  settingsApiKeyEl.value = '';
  settingsApiMetaEl.textContent = '';
  let s = {};
  try {
    const r = await fetch('/settings');
    if (r.ok) s = await r.json();
  } catch {}
  settingsApiMetaEl.textContent = s.OPENROUTER_API_KEY_SET
    ? `Current: ${s.OPENROUTER_API_KEY} — leave blank to keep.`
    : 'No key set.';
  await Promise.all([ensureModelsList(), ensureRolesList()]);
  populateModelSelect(s.OPENROUTER_MODEL || '');
  populateRoleModels(s.OPENROUTER_MODEL_BY_ROLE || {});
  populateMcpList(s.MCP_PLUGINS || []);
  settingsGitEnabledEl.checked = !!s.GIT_AUTOSAVE;
  settingsGitIntervalEl.value = Number(s.GIT_AUTOSAVE_INTERVAL_MIN || 5);
  setTimeout(() => settingsApiKeyEl.focus(), 0);
}

function closeSettings() {
  settingsModalEl.hidden = true;
  settingsOpen = false;
}

async function saveSettings() {
  const updates = {};
  const apiKey = settingsApiKeyEl.value.trim();
  if (apiKey) updates.OPENROUTER_API_KEY = apiKey;
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
settingsModalEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
  else if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
    e.preventDefault(); saveSettings();
  }
});

window.addEventListener('keydown', (e) => {
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

  if (e.key === '\\' || e.key === 'e' || e.key === 'E') {
    // Only L1 / L2 actually have the explorer; toggleFileExplorer is a
    // no-op outside those modes.
    e.preventDefault();
    toggleFileExplorer();
    return;
  }
  if (e.key === 's' || e.key === 'S') {
    if (mode === MODE_GRID || mode === MODE_ZOOM) {
      e.preventDefault();
      toggleSkillsDrawer();
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
    else if (e.key === 'Enter') { e.preventDefault(); openFocused(); }
  } else if (mode === MODE_NEW_PROJ_ROLES) {
    if (e.key === 'ArrowDown') {
      const grid = surfaceEl.querySelector('.role-grid');
      if (grid) {
        const cols = grid._cols || 4;
        const n = ring.elements.length;
        const lastRow = Math.max(0, Math.ceil(n / cols) - 1);
        const r = Math.floor(ring.index / cols);
        if (r >= lastRow && enterShortcuts()) { e.preventDefault(); return; }
      }
      e.preventDefault(); roleGridMove('down');
    } else if (dir) { e.preventDefault(); roleGridMove(dir); }
    else if (e.code === 'Space')  { e.preventDefault(); toggleFocusedRole(); }
    else if (e.key === 'Enter')   { e.preventDefault(); advanceFromRolePicker(); }
    else if (e.key === 'Escape')  { e.preventDefault(); renderProjects(); }
  } else if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    if (e.key === 'ArrowDown') { e.preventDefault(); enterShortcuts(); return; }
    if (e.key === 'Enter')        { e.preventDefault(); confirmCapture(); }
    else if (e.key === 'Escape')  { e.preventDefault(); goBackInCreateFlow(); }
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
    else if (e.key === 'Escape') { e.preventDefault(); exitToProjects(); }
    else if (e.code === 'Space') { e.preventDefault(); toggleFocusedAgentEnabled(); }
    else if (e.key === '[')      { e.preventDefault(); cycleProject(-1); }
    else if (e.key === ']')      { e.preventDefault(); cycleProject(+1); }
  } else if (mode === MODE_ZOOM) {
    // Up / Right hops to the × close button.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowRight') && document.activeElement !== surfaceEl.querySelector('.surface-close')) {
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
    else if (e.key === 'Escape')     { e.preventDefault(); pressCircle(); }
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
  setIndicator('thinking', 'Customizing team charters…');
  try {
    const r = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjName.trim(), goal: newProjGoal.trim(), roleIds: newProjRoleIds }),
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
