/* Deterministic tile renderer. Input: tile spec (see PRD §6.5 / MVP §4).
 * Output: { surfaceEl, focusables, autoSpeak } — the host wires focus + actions.
 *
 * Templates:
 *   list    — items[] of {id,label}; focus rows; A opens.
 *   reader  — body text; TTS-spoken; B closes.
 *   compose — body shows captured text; A saves, B cancels.
 *   confirm — explicit yes/no gate (PRD §8 safety gate).
 */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function header(spec) {
  return [
    spec.context && el('div', { class: 'tile-context' }, spec.context),
    spec.title   && el('h2',  { class: 'tile-title' },   spec.title),
  ].filter(Boolean);
}

export function renderTile(spec) {
  switch (spec.template) {
    case 'list':    return renderList(spec);
    case 'reader':  return renderReader(spec);
    case 'compose': return renderCompose(spec);
    case 'confirm': return renderConfirm(spec);
    default:        return renderReader({ ...spec, template: 'reader', body: 'Unknown tile template: ' + spec.template });
  }
}

function renderList(spec) {
  const ul = el('ul');
  const rowEls = [];
  for (const item of spec.items || []) {
    const li = el('li', { class: 'list-row', tabindex: '-1', dataset: { id: item.id } }, item.label || item.id);
    rowEls.push(li);
    ul.appendChild(li);
  }
  const surface = el('section', { class: 'list-tile' }, ...header(spec), ul);
  return { surface, focusables: rowEls, autoSpeak: null };
}

function renderReader(spec) {
  const body = el('div', { class: 'body' });
  const paragraphs = String(spec.body || '').split(/\n\s*\n/);
  for (const p of paragraphs) body.appendChild(el('p', {}, p));
  const surface = el('section', { class: 'reader-tile' }, ...header(spec), body);
  return { surface, focusables: [], autoSpeak: spec.body || '' };
}

function renderCompose(spec) {
  const body = el('div', { class: 'body' }, spec.body || '');
  const hint = el('div', { class: 'compose-hint' }, 'Press A to save, B to cancel.');
  const surface = el('section', { class: 'compose-tile' }, ...header(spec), body, hint);
  return { surface, focusables: [], autoSpeak: `Save this note? ${spec.body || ''}` };
}

function renderConfirm(spec) {
  const surface = el('section', { class: 'confirm-tile' },
    ...header(spec),
    el('p', {}, spec.body || ''),
  );
  return { surface, focusables: [], autoSpeak: spec.body || spec.title || '' };
}

export function renderActionBar(actions = []) {
  const bar = document.getElementById('action-bar');
  bar.innerHTML = '';
  const buttons = [];
  for (const a of actions) {
    const btn = el('button', { class: 'action', type: 'button', dataset: { verb: a.verb, glyph: a.glyph || '' } },
      a.glyph ? el('span', { class: 'glyph', dataset: { glyph: a.glyph } }, a.glyph) : null,
      el('span', {}, a.verb),
    );
    btn._action = a;
    bar.appendChild(btn);
    buttons.push(btn);
  }
  return buttons;
}
