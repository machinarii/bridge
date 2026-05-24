import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking } from './speech.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';

const surfaceEl       = document.getElementById('surface');
const indicatorEl     = document.getElementById('listening-indicator');
const indicatorTextEl = indicatorEl.querySelector('.state-text');
const breadcrumbsEl   = document.getElementById('breadcrumbs');
const typedWrap       = document.getElementById('ptt-typed');
const typedInput      = document.getElementById('typed-input');
const shortcutsRailEl = document.getElementById('shortcuts-rail');

/** Set the persistent shortcuts rail at bottom-right. Pass an array of
 *  { gamepad, keyboard, label } — both glyphs render and CSS hides the
 *  inactive one based on body[data-input-mode]. */
function setShortcuts(items) {
  shortcutsRailEl.innerHTML = '';
  const GAMEPAD = { cross: '✕', circle: '○', square: '□', triangle: '△' };
  for (const it of items) {
    const wrap = document.createElement('span');
    wrap.className = 'sc';
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
  }
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

  // Fade the entire outgoing surface (the L0 / L1 backdrop and all its
  // tiles) so only the morphing clone is on screen during the zoom.
  const surfaceFade = surfaceEl.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 260, easing: 'ease-out', fill: 'forwards' }
  );

  // Track sibling tiles so we can restore their inline opacity after.
  const dimming = Array.from(ring.elements);

  // Animate via width/height/left/top instead of transform-scale. Avoids
  // counter-scaled borders/radius artifacts (border-radius stays naturally
  // constant in pixels regardless of the size).
  const grow = clone.animate(
    [
      { left: `${sourceRect.left}px`, top: `${sourceRect.top}px`,
        width: `${sourceRect.width}px`, height: `${sourceRect.height}px` },
      { left: `${targetRect.left}px`, top: `${targetRect.top}px`,
        width: `${targetRect.width}px`, height: `${targetRect.height}px` },
    ],
    { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }
  );

  return grow.finished.catch(() => {}).then(() => {
    // Destination view renders into the now-empty surface.
    try { surfaceFade.cancel(); } catch {}
    surfaceEl.style.opacity = '';
    renderDest();
    fadeInDestination(180);
    return clone.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 120, easing: 'ease-out', fill: 'forwards' }
    ).finished.catch(() => {});
  }).then(() => {
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

/* Seamless back nav: snapshot current surface as a floating clone, render
 * the new view underneath immediately, then animate the clone shrinking
 * into the destination rect. The user always sees BOTH views, with the
 * old one collapsing into a tile of the new one. */
function backZoomWithSnapshot(toRect, renderNewView) {
  if (!toRect) { renderNewView(); return Promise.resolve(); }
  const sRect = surfaceEl.getBoundingClientRect();
  const overlay = surfaceEl.cloneNode(true);
  overlay.removeAttribute('id');
  overlay.style.position = 'fixed';
  overlay.style.left = `${sRect.left}px`;
  overlay.style.top = `${sRect.top}px`;
  overlay.style.width = `${sRect.width}px`;
  overlay.style.height = `${sRect.height}px`;
  overlay.style.margin = '0';
  overlay.style.padding = getComputedStyle(surfaceEl).padding;
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '50';
  document.body.appendChild(overlay);

  // Hide the overlay's content instantly — only the shell (with its
  // colored backdrop) animates.
  hideContent(overlay);

  // Render the destination view underneath. Its content (the L0 grid /
  // L1 grid backdrop) fades in fresh.
  renderNewView();
  surfaceEl.animate([{ opacity: 0 }, { opacity: 1 }],
    { duration: 220, easing: 'ease-out', fill: 'backwards' });
  fadeInDestination(180);
  // Animate the overlay via width/height/left/top so the corner radius
  // stays naturally constant (no transform-scale artifacts).
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

/* ---------- Input-mode tracker ---------- */
function setInputMode(m) {
  if (document.body.dataset.inputMode !== m) document.body.dataset.inputMode = m;
}
// Boot in gamepad mode; flip to keyboard as soon as the user touches a key or mouse.
setInputMode('gamepad');
window.addEventListener('keydown', () => setInputMode('keyboard'), true);
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

/* ---------- Bootstrap ---------- */
async function loadProjects() {
  const [pj, rj] = await Promise.all([fetch('/projects'), fetch('/roles')]);
  projects = (await pj.json()).projects || [];
  window._roles = (await rj.json()).roles || [];
}

/* ---------- UI helpers ---------- */
function setIndicator(state, text) {
  indicatorEl.dataset.state = state;
  if (text) indicatorTextEl.textContent = text;
}

/** Set breadcrumbs in the top-right. Pass an array of {label, color?} where
 *  the last entry is the current page. */
function setBreadcrumbs(parts) {
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
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setBreadcrumbs([{ label: 'Projects' }]);
  surfaceEl.innerHTML = '';

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
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(p.name)}</h2>
      <div class="meta">${p.agents.length} agent${p.agents.length===1?'':'s'}</div>`;
    const myIdx = tileEls.length;
    tile.addEventListener('click', () => { pickerIndex = myIdx; ring.index = myIdx; ring.paint(); openFocused(); });
    grid.appendChild(tile);
    tileEls.push(tile);
  }
  // "+ New" tile
  const plus = document.createElement('div');
  plus.className = 'project-tile new-project';
  plus.innerHTML = `<h2 class="name">+ New project</h2><div class="meta">create a team</div>`;
  const plusIdx = tileEls.length;
  plus.addEventListener('click', () => { pickerIndex = plusIdx; ring.index = plusIdx; ring.paint(); openFocused(); });
  grid.appendChild(plus);
  tileEls.push(plus);

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(pickerIndex, 0, tileEls.length - 1);
  ring.paint();

  renderActionBar([
    { verb: 'Open',   glyph: 'cross',  action: { type: '_picker_open' } },
  ]);
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
  const targetRect = surfaceEl.getBoundingClientRect();
  zoomStack.push(sourceRect);
  activeProject = projects[idx];
  gridIndex = 0;
  zoomedIndex = 0;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderGrid());
}

function tileCount() { return projects.length + 1; }

async function renderNewProjectRoles() {
  mode = MODE_NEW_PROJ_ROLES;
  setBreadcrumbs([{ label: 'Projects' }, { label: 'New project' }, { label: 'Roles' }]);
  surfaceEl.innerHTML = '';

  // Lazy-load role catalog
  if (!window._roles) {
    const r = await fetch('/roles');
    const data = await r.json();
    window._roles = data.roles;
  }
  const roles = window._roles;

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
    t.style.setProperty('--tile-color', role.color);
    t.innerHTML = `
      <div class="role-label">${role.label}</div>
      <div class="role-sample">${sample}</div>
      <div class="role-toggle" data-checked="${newProjRoleIds.includes(role.id)}"></div>`;
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
    { verb: 'Toggle', glyph: 'cross',    action: { type: '_role_toggle' } },
    { verb: 'Next',   glyph: 'triangle', action: { type: '_role_next' } },
    { verb: 'Back',   glyph: 'circle',   action: { type: '_role_back' } },
  ]);
  setShortcuts([
    { gamepad: 'cross',    keyboard: 'Space', label: 'Toggle' },
    { gamepad: 'triangle', keyboard: 'Enter', label: 'Next' },
    { gamepad: 'circle',   keyboard: 'Esc',   label: 'Back' },
  ]);
}

function toggleFocusedRole() {
  const cur = ring.current();
  if (!cur) return;
  const id = cur.dataset.roleId;
  if (!id) return;
  const idx = newProjRoleIds.indexOf(id);
  if (idx >= 0) newProjRoleIds.splice(idx, 1);
  else newProjRoleIds.push(id);
  cur.querySelector('.role-toggle').dataset.checked = String(newProjRoleIds.includes(id));
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
    <p class="hint for-gamepad">Hold <kbd>R2</kbd> and speak.</p>
    <p class="hint for-keyboard">Hold <kbd>v</kbd> and speak — or press <kbd>/</kbd> to type.</p>
    <div class="capture-value">${escapeHtml(newProjName) || '<span class="placeholder">(speak now)</span>'}</div>
    ${newProjRoleIds.includes('pm') || newProjRoleIds.includes('tpm')
      ? ''
      : '<div class="lead-badge">Cadence will lead this team.</div>'}`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Confirm', glyph: 'cross',  action: { type: '_capture_confirm' } },
    { verb: 'Back',    glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'cross',  keyboard: 'Enter', label: 'Confirm' },
    { gamepad: 'circle', keyboard: 'Esc',   label: 'Back' },
  ]);
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
    <p class="hint for-gamepad">Hold <kbd>R2</kbd> and describe it.</p>
    <p class="hint for-keyboard">Hold <kbd>v</kbd> and describe it — or press <kbd>/</kbd> to type.</p>
    <div class="capture-value">${escapeHtml(newProjGoal) || '<span class="placeholder">(speak now)</span>'}</div>`;
  surfaceEl.appendChild(t);
  renderActionBar([
    { verb: 'Confirm', glyph: 'cross',  action: { type: '_capture_confirm' } },
    { verb: 'Back',    glyph: 'circle', action: { type: '_capture_back' } },
  ]);
  setShortcuts([
    { gamepad: 'cross',  keyboard: 'Enter', label: 'Confirm' },
    { gamepad: 'circle', keyboard: 'Esc',   label: 'Back' },
  ]);
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
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setBreadcrumbs([{ label: 'Projects' }, { label: activeProject.name }]);
  surfaceEl.innerHTML = '';

  const { cols, rows } = gridLayout(activeProject.agents.length);
  const grid = document.createElement('div');
  grid.className = 'agent-grid';
  grid.style.setProperty('--grid-cols', cols);
  grid.style.setProperty('--grid-rows', rows);
  grid._cols = cols;
  grid._rows = rows;

  const tileEls = activeProject.agents.map((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    if (!a.enabled) tile.dataset.disabled = 'true';
    if (a.id === activeProject.leadAgentId) tile.dataset.lead = 'true';
    tile.style.setProperty('--tile-color', a.color);
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
  setShortcuts([
    { gamepad: 'square',  keyboard: 'Space', label: 'On / Off' },
    { gamepad: 'options', keyboard: 'F',     label: 'Explorer' },
  ]);
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
  const targetRect = surfaceEl.getBoundingClientRect();
  zoomStack.push(sourceRect);
  zoomedIndex = idx;
  mode = MODE_ZOOM;
  await forwardMorph(sourceTile, sourceRect, targetRect, () => renderZoom(specOverride));
}

function renderZoom(specOverride) {
  const agent = currentAgent();
  if (!agent) return renderGrid();
  document.documentElement.style.setProperty('--agent-color', agent.color);
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
    <div class="tile-surface"></div>`;
  surfaceEl.appendChild(view);
  const chatEl = view.querySelector('.chat-scroll');
  const surfaceWrap = view.querySelector('.tile-surface');

  // Always-visible inline conversation history (iMessage-style bubbles).
  renderChatHistory(chatEl, agent);

  const spec = specOverride ?? agent.lastSpec;
  if (!spec) {
    surfaceWrap.innerHTML = `
      <div class="idle">
        <p class="for-gamepad">Hold <kbd>R2</kbd> and speak.</p>
        <p class="for-keyboard">Hold <kbd>v</kbd> and speak — or press <kbd>/</kbd> to type.</p>
      </div>`;
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
    { gamepad: 'l1',      keyboard: '[', label: 'Prev' },
    { gamepad: 'r1',      keyboard: ']', label: 'Next' },
    { gamepad: 'options', keyboard: 'F', label: 'Explorer' },
  ]);
}

async function exitZoom() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  const toRect = popZoomRect();
  await backZoomWithSnapshot(toRect, () => {
    mode = MODE_GRID;
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
  zoomedIndex = i;
  renderZoom();
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
  if (pttActive || !PTT_MODES.has(mode)) return;
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
}
async function exitToProjects() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  closeFileViewer();
  if (fileExplorerOpen) closeFileExplorer();
  const toRect = popZoomRect();
  await backZoomWithSnapshot(toRect, () => {
    activeProject = null;
    renderProjects();
  });
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

async function toggleFileExplorer() {
  if (mode === MODE_PROJECTS) return;
  if (!activeProject) return;
  if (fileExplorerOpen) { closeFileExplorer(); return; }
  await openFileExplorer();
}

async function openFileExplorer() {
  try {
    const r = await fetch(`/projects/${activeProject.id}/files`);
    if (!r.ok) throw new Error(await r.text());
    fileTree = await r.json();
  } catch (err) {
    setIndicator('error', 'Files failed');
    console.error(err);
    return;
  }
  fileTreeEl.innerHTML = '';
  fileEntries = [];

  if (fileTree.charters.length) {
    const h = document.createElement('div'); h.className = 'file-section'; h.textContent = '▾ Charters';
    fileTreeEl.appendChild(h);
    for (const c of fileTree.charters) {
      const li = document.createElement('div');
      li.className = 'file-entry';
      li.innerHTML = `<span>${escapeHtml(c.roleId)}.md</span><span class="who">${escapeHtml(c.agentName)}</span>`;
      li.dataset.path = c.path;
      fileTreeEl.appendChild(li);
      fileEntries.push(li);
    }
  }
  if (fileTree.notes.length) {
    const h = document.createElement('div'); h.className = 'file-section'; h.textContent = '▾ Notes';
    fileTreeEl.appendChild(h);
    for (const n of fileTree.notes) {
      const li = document.createElement('div');
      li.className = 'file-entry';
      li.textContent = n.path.replace(/^notes\//,'').replace(/\.md$/,'');
      li.dataset.path = n.path;
      fileTreeEl.appendChild(li);
      fileEntries.push(li);
    }
  }
  const pm = document.createElement('div');
  pm.className = 'file-entry';
  pm.textContent = 'project.md';
  pm.dataset.path = 'project.md';
  fileTreeEl.appendChild(pm);
  fileEntries.push(pm);

  fileDrawerEl.hidden = false;
  fileExplorerOpen = true;
  explorerFocused = true;
  fileFocus = 0;
  paintFileFocus();
  document.body.dataset.fileDrawer = 'open';
  if (drawerOpen) closeHistoryDrawer();
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
fileViewerCloseEl?.addEventListener('click', () => closeFileViewer());

async function openFocusedFile() {
  const e = fileEntries[fileFocus];
  if (!e) return;
  const path = e.dataset.path;
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
  if (e.key === 'v' && !e.repeat) { e.preventDefault(); startPTT(); return; }

  if (e.key === '\\' || e.key === 'f' || e.key === 'F') {
    // Only L1 / L2 actually have the explorer; toggleFileExplorer is a
    // no-op outside those modes.
    e.preventDefault();
    toggleFileExplorer();
    return;
  }
  if (e.key === '/')  { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); return; }

  const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const dir = dirMap[e.key];

  // File explorer (overlay at L1/L2) intercepts navigation while the
  // explorer holds focus. Right-arrow exits the explorer to the right.
  if (fileExplorerOpen && explorerFocused) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')       { e.preventDefault(); fileFocus = Math.max(0, fileFocus - 1); paintFileFocus(); return; }
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
  if (mode === MODE_PROJECTS) {
    if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      slideToAdjacentProject(e.key === 'ArrowRight' ? +1 : -1);
    } else if (dir) { e.preventDefault(); pickerMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); openFocused(); }
  } else if (mode === MODE_NEW_PROJ_ROLES) {
    if (dir) { e.preventDefault(); roleGridMove(dir); }
    else if (e.code === 'Space')  { e.preventDefault(); toggleFocusedRole(); }
    else if (e.key === 'Enter')   { e.preventDefault(); advanceFromRolePicker(); }
    else if (e.key === 'Escape')  { e.preventDefault(); renderProjects(); }
  } else if (mode === MODE_NEW_PROJ_NAME || mode === MODE_NEW_PROJ_GOAL) {
    if (e.key === 'Enter')        { e.preventDefault(); confirmCapture(); }
    else if (e.key === 'Escape')  { e.preventDefault(); goBackInCreateFlow(); }
  }

  // File viewer (right panel) — Esc closes it before any back navigation.
  if (fileViewerOpen && e.key === 'Escape') {
    e.preventDefault();
    closeFileViewer();
    return;
  }

  if (mode === MODE_GRID) {
    if (dir) { e.preventDefault(); gridMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitToProjects(); }
    else if (e.code === 'Space') { e.preventDefault(); toggleFocusedAgentEnabled(); }
  } else if (mode === MODE_ZOOM) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')      { e.preventDefault(); ring.move(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
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
    activeProject = project;
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
  renderProjects();
  setIndicator('idle', 'Connected');
  console.log('[bridge] L0 ready. ✕ open project, "+ New" to create.');
})();
