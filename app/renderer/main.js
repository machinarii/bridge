import { GamepadInput } from './gamepad.js';
import { Speech, speak, stopSpeaking } from './speech.js';
import { FocusRing } from './focus.js';
import { renderTile, renderActionBar } from './tiles.js';

const surfaceEl = document.getElementById('surface');
const indicatorEl = document.getElementById('listening-indicator');
const indicatorTextEl = indicatorEl.querySelector('.state-text');
const contextLabelEl = document.getElementById('context-label');
const typedWrap = document.getElementById('ptt-typed');
const typedInput = document.getElementById('typed-input');

const ring = new FocusRing();
const gp = new GamepadInput();
const speech = new Speech();

let currentSpec = null;
let inflight = false;

// ---------- UI state helpers ----------

function setIndicator(state, text) {
  indicatorEl.dataset.state = state;
  if (text) indicatorTextEl.textContent = text;
}

function setContext(label) {
  contextLabelEl.textContent = label || 'Aurora';
}

function clearSurface() {
  surfaceEl.innerHTML = '';
  renderActionBar([]);
  ring.set([]);
}

function showWelcome() {
  surfaceEl.innerHTML = `
    <section class="welcome">
      <h1>Aurora</h1>
      <p class="hint">Hold <kbd>Space</kbd> or the gamepad <kbd>RT</kbd> and speak.</p>
      <p class="hint subtle">D-pad / arrows to navigate. <kbd>A</kbd> / <kbd>Enter</kbd> to select. <kbd>B</kbd> / <kbd>Escape</kbd> to go back. Press <kbd>/</kbd> to type instead.</p>
    </section>`;
  renderActionBar([]);
  ring.set([]);
  setContext('Aurora');
  currentSpec = null;
}

// ---------- Rendering a tile spec ----------

function renderSpec(spec) {
  currentSpec = spec;
  setContext(spec.context || 'Aurora');
  const { surface, focusables, autoSpeak } = renderTile(spec);
  surfaceEl.innerHTML = '';
  surfaceEl.appendChild(surface);

  const actionButtons = renderActionBar(spec.actions || []);
  ring.set([...focusables, ...actionButtons]);

  // Click-to-fire on action buttons (keyboard/mouse parity).
  for (const btn of actionButtons) {
    btn.addEventListener('click', () => executeAction(btn._action));
  }
  for (const f of focusables) {
    f.addEventListener('click', () => {
      ring.moveTo(el => el === f);
      pressA();
    });
  }

  if (autoSpeak) speak(autoSpeak);
}

// ---------- Action execution ----------

async function executeAction(action) {
  if (!action || !currentSpec) return;
  const type = action.action?.type || action.type;
  switch (type) {
    case 'cancel':
      stopSpeaking();
      showWelcome();
      speak('Cancelled.');
      return;
    case 'save_note': {
      const body = currentSpec.body;
      setIndicator('thinking', 'Saving…');
      try {
        const r = await fetch('/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
        if (!r.ok) throw new Error(await r.text());
        setIndicator('idle', 'Saved');
        const summary = body.length > 60 ? body.slice(0, 60) + '…' : body;
        renderSpec({
          intent: 'answer', template: 'reader',
          context: 'Note saved', title: 'Saved',
          body: `Saved your note: ${summary}`,
          actions: [{ verb: 'Done', glyph: 'B', action: { type: 'cancel' } }],
        });
      } catch (err) {
        setIndicator('error', 'Save failed');
        renderSpec({
          intent: 'answer', template: 'reader',
          context: 'Error', title: "I couldn't save that",
          body: 'Something went wrong saving the note. ' + (err.message || ''),
          actions: [{ verb: 'Back', glyph: 'B', action: { type: 'cancel' } }],
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
        setIndicator('idle', 'Ready');
        renderSpec({
          intent: 'answer', template: 'reader',
          context: 'Note', title: id.replace(/T/, ' ').replace(/-/g, '·').slice(0, 16),
          body,
          actions: [{ verb: 'Back', glyph: 'B', action: { type: 'cancel' } }],
        });
      } catch (err) {
        setIndicator('error', 'Load failed');
      }
      return;
    }
    default:
      console.warn('[action] unknown type:', type, action);
  }
}

// ---------- PTT + intent submission ----------

let pttActive = false;

function startPTT() {
  if (pttActive || inflight) return;
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
  if (inflight) return;
  inflight = true;
  setIndicator('thinking', 'Thinking…');
  try {
    const r = await fetch('/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const spec = await r.json();
    setIndicator('idle', 'Ready');
    renderSpec(spec);
  } catch (err) {
    console.error(err);
    setIndicator('error', 'Request failed');
    renderSpec({
      intent: 'answer', template: 'reader',
      context: 'Error', title: 'Something went wrong',
      body: 'I couldn’t reach the orchestrator. ' + (err.message || ''),
      actions: [{ verb: 'Back', glyph: 'B', action: { type: 'cancel' } }],
    });
  } finally {
    inflight = false;
  }
}

// ---------- Input bindings ----------

function pressA() {
  const cur = ring.current();
  if (!cur) {
    // No focusable items — fire the first action that has glyph A.
    const aBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'A');
    if (aBtn) executeAction(aBtn._action);
    return;
  }
  if (cur.classList.contains('action')) {
    executeAction(cur._action);
  } else if (cur.classList.contains('list-row')) {
    // Selecting a list row fires the bar's A-glyph action.
    const aBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'A');
    if (aBtn) executeAction(aBtn._action);
  }
}

function pressB() {
  const bBtn = [...document.querySelectorAll('#action-bar .action')].find(b => b.dataset.glyph === 'B');
  if (bBtn) executeAction(bBtn._action);
  else { stopSpeaking(); showWelcome(); }
}

gp.addEventListener('ptt-down', startPTT);
gp.addEventListener('ptt-up', endPTT);
gp.addEventListener('connected', (e) => {
  setIndicator('idle', 'Controller ready');
  setTimeout(() => setIndicator('idle', 'Ready'), 1500);
});
gp.addEventListener('press', (e) => {
  const b = e.detail.button;
  if (b === 'up' || b === 'left') ring.move(-1);
  else if (b === 'down' || b === 'right') ring.move(+1);
  else if (b === 'a') pressA();
  else if (b === 'b') pressB();
  else if (b === 'start') showWelcome();
});

// Keyboard parity (works without a controller).
window.addEventListener('keydown', (e) => {
  if (document.activeElement === typedInput) {
    if (e.key === 'Enter') {
      const t = typedInput.value.trim();
      typedInput.value = '';
      typedWrap.hidden = true;
      if (t) submitIntent(t);
    } else if (e.key === 'Escape') {
      typedInput.value = '';
      typedWrap.hidden = true;
    }
    return;
  }
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startPTT(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); ring.move(-1); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); ring.move(+1); }
  else if (e.key === 'Enter') { e.preventDefault(); pressA(); }
  else if (e.key === 'Escape') { e.preventDefault(); pressB(); }
  else if (e.key === '/') { e.preventDefault(); typedWrap.hidden = false; typedInput.focus(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); endPTT(); }
});

// ---------- Boot ----------

showWelcome();
setIndicator('idle', 'Ready');
console.log('[aurora] renderer ready. PTT = Space / RT. Type with /.');
