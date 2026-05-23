import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking } from './speech.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';

const surfaceEl       = document.getElementById('surface');
const indicatorEl     = document.getElementById('listening-indicator');
const indicatorTextEl = indicatorEl.querySelector('.state-text');
const contextLabelEl  = document.getElementById('context-label');
const typedWrap       = document.getElementById('ptt-typed');
const typedInput      = document.getElementById('typed-input');

const ring = new FocusRing();
const gp = new GamepadInput();
const speech = new Speech();

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
  const r = await fetch('/projects');
  const data = await r.json();
  projects = data.projects || [];
}

/* ---------- UI helpers ---------- */
function setIndicator(state, text) {
  indicatorEl.dataset.state = state;
  if (text) indicatorTextEl.textContent = text;
}

function setContextLabel(text, color) {
  contextLabelEl.innerHTML = '';
  if (color) {
    const chip = document.createElement('span');
    chip.className = 'agent-chip';
    chip.style.setProperty('--agent-color', color);
    contextLabelEl.appendChild(chip);
  }
  contextLabelEl.appendChild(document.createTextNode(text || 'Bridge'));
}

function renderProjects() {
  mode = MODE_PROJECTS;
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');
  setContextLabel('Bridge — projects');
  surfaceEl.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'project-picker';

  const tileEls = [];
  for (const p of projects) {
    const tile = document.createElement('div');
    tile.className = 'project-tile';
    tile.dataset.projectId = p.id;
    tile.innerHTML = `
      <h2 class="name">${escapeHtml(p.name)}</h2>
      <div class="meta">${p.agents.length} member${p.agents.length===1?'':'s'}</div>`;
    tile.addEventListener('click', () => { pickerIndex = tileEls.length; ring.set(tileEls); openFocused(); });
    grid.appendChild(tile);
    tileEls.push(tile);
  }
  // "+ New" tile
  const plus = document.createElement('div');
  plus.className = 'project-tile new-project';
  plus.innerHTML = `<h2 class="name">+ New project</h2><div class="meta">create a team</div>`;
  plus.addEventListener('click', () => { pickerIndex = tileEls.length; ring.set([...tileEls, plus]); openFocused(); });
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

function openFocused() {
  const idx = ring.index;
  if (idx === tileCount() - 1) {
    // "+ New" — enter create flow
    newProjRoleIds = [];
    newProjName = '';
    newProjGoal = '';
    renderNewProjectRoles();
  } else {
    activeProject = projects[idx];
    gridIndex = 0;
    zoomedIndex = 0;
    renderGrid();
  }
}

function tileCount() { return projects.length + 1; }

function renderNewProjectRoles() { surfaceEl.innerHTML = '<p style="padding:2rem">Role picker — Phase 3.</p>'; mode = MODE_NEW_PROJ_ROLES; }
function renderNewProjectName()  { surfaceEl.innerHTML = '<p style="padding:2rem">Name capture — Phase 3.</p>'; mode = MODE_NEW_PROJ_NAME; }
function renderNewProjectGoal()  { surfaceEl.innerHTML = '<p style="padding:2rem">Goal capture — Phase 3.</p>'; mode = MODE_NEW_PROJ_GOAL; }

function renderGrid() { surfaceEl.innerHTML = '<p style="padding:2rem">Project grid — Phase 3.</p>'; }

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

function paintGridFocus() {
  ring.paint();
  gridIndex = ring.index;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* Grid navigation: 4 columns × 2 rows. */
function gridMove(dir) {
  if (mode !== MODE_GRID) return;
  const cols = 4, rows = 2;
  const i = gridIndex;
  const r = Math.floor(i / cols), c = i % cols;
  let nr = r, nc = c;
  if (dir === 'left')  nc = (c + cols - 1) % cols;
  if (dir === 'right') nc = (c + 1) % cols;
  if (dir === 'up')    nr = (r + rows - 1) % rows;
  if (dir === 'down')  nr = (r + 1) % rows;
  gridIndex = nr * cols + nc;
  ring.index = gridIndex;
  paintGridFocus();
}

/* ---------- ZOOM view ---------- */
function enterZoom(specOverride) {
  const idx = mode === MODE_ZOOM ? zoomedIndex : gridIndex;
  zoomedIndex = idx;
  mode = MODE_ZOOM;
  renderZoom(specOverride);
}

function exitZoom() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  mode = MODE_GRID;
  renderGrid();
}

function renderZoom() { surfaceEl.innerHTML = '<p style="padding:2rem">Agent zoom — Phase 3.</p>'; }

function cycleAgent(delta) {
  if (mode !== MODE_ZOOM || !activeProject?.agents?.length) return;
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  zoomedIndex = (zoomedIndex + delta + activeProject.agents.length) % activeProject.agents.length;
  renderZoom();
}

/* ---------- Action execution ---------- */
async function executeAction(action, sourceSpec) {
  if (!action) return;
  const type = action.action?.type || action.type;

  // Grid-mode synthetic actions
  if (type === '_grid_open')   { enterZoom(); return; }
  if (type === '_grid_cancel') { stopSpeaking(); return; }

  const agent = currentAgent();
  if (!agent) return;
  switch (type) {
    case 'cancel':
      exitZoom();
      return;

    case 'save_note': {
      const body = sourceSpec?.body || agent.lastSpec?.body;
      if (!body) return;
      setIndicator('thinking', 'Saving…');
      try {
        const r = await fetch('/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        if (!r.ok) throw new Error(await r.text());
        const summary = body.length > 60 ? body.slice(0, 60) + '…' : body;
        const ackSpec = {
          intent: 'answer', template: 'reader',
          context: 'Note saved', title: 'Saved',
          body: `Saved your note: ${summary}`,
          actions: [{ verb: 'Done', glyph: 'circle', action: { type: 'cancel' } }],
        };
        agent.lastSpec = ackSpec;
        await persistSpec(agent.id, ackSpec);
        setIndicator('idle', 'Ready');
        renderZoom(ackSpec);
      } catch (err) {
        setIndicator('error', 'Save failed');
        renderZoom({
          intent: 'answer', template: 'reader',
          context: 'Error', title: "I couldn't save that",
          body: 'Something went wrong saving the note. ' + (err.message || ''),
          actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
        });
      }
      return;
    }

    case 'open_note': {
      const focused = ring.current();
      const id = focused?.dataset?.id;
      if (!id) return;
      setIndicator('thinking', 'Loading…');
      try {
        const r = await fetch(`/notes/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(await r.text());
        const { body } = await r.json();
        const readerSpec = {
          intent: 'answer', template: 'reader',
          context: 'Note', title: id.replace(/T/, ' ').slice(0, 16),
          body,
          actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
        };
        agent.lastSpec = readerSpec;
        await persistSpec(agent.id, readerSpec);
        setIndicator('idle', 'Ready');
        renderZoom(readerSpec);
      } catch (err) {
        setIndicator('error', 'Load failed');
      }
      return;
    }

    default:
      console.warn('[action] unknown type:', type, action);
  }
}

async function persistSpec(agentId, spec) {
  try {
    await fetch(`/agents/${agentId}/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
  } catch (e) { /* non-fatal */ }
}

/* ---------- PTT + intent submission ---------- */
function startPTT() {
  if (pttActive || mode !== MODE_ZOOM) return;
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
    setTimeout(() => setIndicator('idle', 'Ready'), 1500);
    return;
  }
  submitIntent(text);
});
speech.addEventListener('error', (e) => {
  setIndicator('error', `Speech error: ${e.detail}`);
  setTimeout(() => setIndicator('idle', 'Ready'), 2000);
});

/* ---------- L0 / shared helpers ---------- */
function pickerMove(dir) {
  // Picker is a 1-row wrap. up/down treat as left/right for simplicity at MVP scale.
  const n = tileCount();
  if (n <= 1) return;
  if (dir === 'left' || dir === 'up')    ring.index = (ring.index + n - 1) % n;
  if (dir === 'right' || dir === 'down') ring.index = (ring.index + 1) % n;
  pickerIndex = ring.index;
  ring.paint();
}
function exitToProjects() {
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  activeProject = null;
  renderProjects();
}
function toggleFocusedAgentEnabled() { /* Phase 5 */ }
function toggleHistoryDrawer()       { /* Phase 6 */ }
function toggleFileExplorer()        { /* Phase 7 */ }
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
gp.addEventListener('ptt-down', startPTT);
gp.addEventListener('ptt-up', endPTT);
gp.addEventListener('connected', () => {
  setIndicator('idle', 'Controller ready');
  setTimeout(() => setIndicator('idle', 'Ready'), 1500);
});
gp.addEventListener('press', (e) => {
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
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') gridMove(b);
    else if (b === 'cross')   enterZoom();
    else if (b === 'circle')  exitToProjects();
    else if (b === 'square')  toggleFocusedAgentEnabled();
    return;
  }

  if (mode === MODE_ZOOM) {
    if (b === 'up' || b === 'left')      ring.move(-1);
    else if (b === 'down' || b === 'right') ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'triangle')           toggleHistoryDrawer();
    return;
  }

  // Create-flow modes wired in Phase 3
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
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); return; }

  if (e.key === '\\') { e.preventDefault(); toggleFileExplorer(); return; }
  if (e.key === '/')  { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); return; }

  // Mode-specific keys
  const dirMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const dir = dirMap[e.key];

  if (mode === MODE_PROJECTS) {
    if (dir) { e.preventDefault(); pickerMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); openFocused(); }
  } else if (mode === MODE_GRID) {
    if (dir) { e.preventDefault(); gridMove(dir); }
    else if (e.key === 'Enter') { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitToProjects(); }
  } else if (mode === MODE_ZOOM) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')      { e.preventDefault(); ring.move(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
    else if (e.key === 'Enter')      { e.preventDefault(); pressCross(); }
    else if (e.key === 'Escape')     { e.preventDefault(); pressCircle(); }
    else if (e.key === '[')          { e.preventDefault(); cycleAgent(-1); }
    else if (e.key === ']')          { e.preventDefault(); cycleAgent(+1); }
    else if (e.key === 't')          { e.preventDefault(); toggleHistoryDrawer(); }
  }
});

function submitTypedText(text) {
  if (mode === MODE_NEW_PROJ_NAME) { newProjName = text; renderNewProjectGoal(); return; }
  if (mode === MODE_NEW_PROJ_GOAL) { newProjGoal = text; finalizeNewProject(); return; }
  if (mode === MODE_ZOOM) { submitIntent(text); return; }
  if (mode === MODE_GRID) { submitTeamIntent(text); return; }
}

// Placeholders — wired in later phases
function submitIntent(text) { /* Phase 3 */ }
function submitTeamIntent(text) { /* Phase 8 */ }
function finalizeNewProject() { /* Phase 3 */ }
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); endPTT(); }
});

/* ---------- Boot ---------- */
(async () => {
  await loadProjects();
  renderProjects();
  setIndicator('idle', 'Ready');
  console.log('[bridge] L0 ready. ✕ open project, "+ New" to create.');
})();
