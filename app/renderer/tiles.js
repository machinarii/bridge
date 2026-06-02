/* Deterministic tile renderer. Spec → DOM + focus list.
 *
 * Templates: list | reader | compose | confirm.
 * Glyphs (PS5): cross ✕ · circle ○ · square □ · triangle △.
 */

const GLYPH_SHAPES = {
  cross:    '✕',
  circle:   '○',
  square:   '□',
  triangle: '△',
};
const GLYPH_KEYS = {
  cross:    'Enter',
  circle:   'Esc', // Back is bound to Esc (full screen toggles with Cmd/Ctrl+F)
  square:   'Space',
  triangle: 'T',
};

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
  for (const p of String(spec.body || '').split(/\n\s*\n/)) body.appendChild(el('p', {}, p));
  const surface = el('section', { class: 'reader-tile' }, ...header(spec), body);
  return { surface, focusables: [], autoSpeak: spec.body || '' };
}

function renderCompose(spec) {
  const body = el('div', { class: 'body' }, spec.body || '');
  const hint = el('div', { class: 'compose-hint' }, 'Cross to save · Circle to cancel.');
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
  // Remove only the verb buttons; leave #primary-shortcut (the Enter/
  // Select chip lives inside the action-bar and persists across renders).
  bar.querySelectorAll('.action').forEach(el => el.remove());
  const primary = bar.querySelector('#primary-shortcut');
  const buttons = [];
  for (const a of actions) {
    const glyphChar = GLYPH_SHAPES[a.glyph] || '';
    const keyLabel  = GLYPH_KEYS[a.glyph] || '';
    const btn = el('button', { class: 'action', type: 'button', dataset: { verb: a.verb, glyph: a.glyph || '' } },
      glyphChar ? el('span', { class: 'glyph for-gamepad', dataset: { glyph: a.glyph } }, glyphChar) : null,
      keyLabel  ? el('span', { class: 'glyph for-keyboard', dataset: { glyph: a.glyph } }, keyLabel)  : null,
      el('span', {}, a.verb),
    );
    btn._action = a;
    // Insert verb buttons before the primary-shortcut chip so it stays
    // at the far right.
    if (primary) bar.insertBefore(btn, primary);
    else bar.appendChild(btn);
    buttons.push(btn);
  }
  return buttons;
}

export { GLYPH_SHAPES };
