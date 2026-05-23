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
const MODE_GRID = 'grid';
const MODE_ZOOM = 'zoom';

let mode = MODE_GRID;
let agents = [];                 // [{ id, name, color, persona, lastSpec, ... }]
let zoomedIndex = 0;             // index into agents[] when zoomed
let gridIndex = 0;               // focus position on grid
let agentBusy = {};              // agentId -> bool ("thinking" indicator on tile)
let inflightController = null;   // AbortController for the in-flight LLM call
let pttActive = false;

/* ---------- Bootstrap ---------- */
async function loadAgents() {
  const r = await fetch('/agents');
  const data = await r.json();
  agents = data.agents;
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

function currentAgent() { return agents[zoomedIndex] || null; }

/* ---------- GRID view ---------- */
function renderGrid() {
  mode = MODE_GRID;
  surfaceEl.innerHTML = '';
  renderActionBar([
    { verb: 'Open',   glyph: 'cross',  action: { type: '_grid_open' } },
    { verb: 'Cancel', glyph: 'circle', action: { type: '_grid_cancel' } },
  ]);
  setContextLabel('Bridge — choose an agent');
  document.documentElement.style.setProperty('--agent-color', '#6ea8ff');

  const grid = document.createElement('div');
  grid.className = 'agent-grid';

  const tileEls = agents.map((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'agent-tile';
    tile.style.setProperty('--tile-color', a.color);
    tile.dataset.agentId = a.id;
    tile.dataset.busy = agentBusy[a.id] ? 'true' : 'false';

    const summary = summarizeLastSpec(a.lastSpec);
    tile.innerHTML = `
      <h2 class="name">${a.name}</h2>
      <div class="footer">
        <div class="summary">${summary || '<span style="opacity:0.5">no conversation yet</span>'}</div>
        <div class="status"><span class="dot"></span><span>${agentBusy[a.id] ? 'thinking…' : 'idle'}</span></div>
      </div>`;
    tile.addEventListener('click', () => { gridIndex = i; ring.set(tileEls); paintGridFocus(); enterZoom(); });
    grid.appendChild(tile);
    return tile;
  });

  surfaceEl.appendChild(grid);
  ring.set(tileEls);
  ring.index = clamp(gridIndex, 0, tileEls.length - 1);
  paintGridFocus();
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

function renderZoom(specOverride) {
  const agent = currentAgent();
  if (!agent) return renderGrid();
  document.documentElement.style.setProperty('--agent-color', agent.color);
  setContextLabel(agent.name, agent.color);
  surfaceEl.innerHTML = '';

  const view = document.createElement('section');
  view.className = 'agent-view';
  view.innerHTML = `
    <div class="agent-header">
      <div class="name-large">${agent.name}</div>
      <div class="nav-hint">
        <span class="shoulder"><span>L1</span> prev</span>
        <span class="shoulder"><span>R1</span> next</span>
        <span class="shoulder"><span>○</span> grid</span>
      </div>
    </div>
    <div class="tile-surface"></div>`;
  surfaceEl.appendChild(view);
  const surfaceWrap = view.querySelector('.tile-surface');

  const spec = specOverride ?? agent.lastSpec;
  if (!spec) {
    surfaceWrap.innerHTML = `
      <div class="idle">
        <h3>${agent.name}</h3>
        <p>Hold <kbd>R2</kbd> or <kbd>Space</kbd> and speak.</p>
        <p style="opacity:0.7">Try: <em>take a note</em>, <em>show my notes</em>, or any question.</p>
      </div>`;
    renderActionBar([{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }]);
    ring.set([]);
    return;
  }

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
}

function cycleAgent(delta) {
  if (mode !== MODE_ZOOM || agents.length === 0) return;
  if (inflightController) { inflightController.abort(); inflightController = null; }
  stopSpeaking();
  zoomedIndex = (zoomedIndex + delta + agents.length) % agents.length;
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

async function submitIntent(text) {
  const agent = currentAgent();
  if (!agent || mode !== MODE_ZOOM) return;
  if (inflightController) inflightController.abort();
  inflightController = new AbortController();
  const myController = inflightController;
  const targetAgentId = agent.id;

  agentBusy[targetAgentId] = true;
  setIndicator('thinking', `${agent.name} is thinking…`);
  try {
    const r = await fetch(`/agents/${targetAgentId}/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: myController.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const spec = await r.json();
    const a = agents.find(x => x.id === targetAgentId);
    if (a) a.lastSpec = spec;

    if (mode === MODE_ZOOM && currentAgent()?.id === targetAgentId) {
      setIndicator('idle', 'Ready');
      renderZoom(spec);
    } else {
      // The user switched agents before this one finished — leave a marker, don't yank focus.
      console.log(`[bg] ${targetAgentId} finished in background`);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    if (mode === MODE_ZOOM && currentAgent()?.id === targetAgentId) {
      setIndicator('error', 'Request failed');
      renderZoom({
        intent: 'answer', template: 'reader',
        context: 'Error', title: 'Something went wrong',
        body: 'I couldn’t reach the orchestrator. ' + (err.message || ''),
        actions: [{ verb: 'Back', glyph: 'circle', action: { type: 'cancel' } }],
      });
    }
  } finally {
    agentBusy[targetAgentId] = false;
    if (myController === inflightController) inflightController = null;
  }
}

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
  if (mode === MODE_GRID) {
    if (b === 'up' || b === 'down' || b === 'left' || b === 'right') gridMove(b);
    else if (b === 'cross')   enterZoom();
    else if (b === 'options') exitZoom();
  } else {
    if (b === 'up' || b === 'left')      ring.move(-1);
    else if (b === 'down' || b === 'right') ring.move(+1);
    else if (b === 'cross')              pressCross();
    else if (b === 'circle')             pressCircle();
    else if (b === 'l1')                 cycleAgent(-1);
    else if (b === 'r1')                 cycleAgent(+1);
    else if (b === 'options')            exitZoom();
  }
});

/* L2: speak the currently-focused agent's name. Works in both grid and zoom
 * so the user can audibly confirm "which agent am I on" without looking. */
function speakFocusedAgentName() {
  const agent = mode === MODE_ZOOM ? currentAgent() : agents[gridIndex];
  if (!agent) return;
  stopSpeaking();
  speak(agent.name);
}

window.addEventListener('keydown', (e) => {
  if (document.activeElement === typedInput) {
    if (e.key === 'Enter') {
      const t = typedInput.value.trim();
      typedInput.value = ''; typedWrap.hidden = true;
      if (t) submitIntent(t);
    } else if (e.key === 'Escape') {
      typedInput.value = ''; typedWrap.hidden = true;
    }
    return;
  }
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); }
  else if (mode === MODE_GRID) {
    if (e.key === 'ArrowUp')    { e.preventDefault(); gridMove('up'); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); gridMove('down'); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); gridMove('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); gridMove('right'); }
    else if (e.key === 'Enter')      { e.preventDefault(); enterZoom(); }
    else if (e.key === 'Escape')     { /* no-op on grid */ }
  } else {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')      { e.preventDefault(); ring.move(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
    else if (e.key === 'Enter')      { e.preventDefault(); pressCross(); }
    else if (e.key === 'Escape')     { e.preventDefault(); pressCircle(); }
    else if (e.key === '[')          { e.preventDefault(); cycleAgent(-1); }   // keyboard L1
    else if (e.key === ']')          { e.preventDefault(); cycleAgent(+1); }   // keyboard R1
  }
  if (e.key === '/') { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); endPTT(); }
});

/* ---------- Boot ---------- */
(async () => {
  await loadAgents();
  renderGrid();
  setIndicator('idle', 'Ready');
  console.log('[bridge] PS5 mode. Cross=open, Circle=back, L1/R1=switch agent, R2=PTT. Keyboard: arrows/Enter/Esc/[/]//space.');
})();
