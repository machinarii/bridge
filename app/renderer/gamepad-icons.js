/* PlayStation controller glyphs from the Figma 'PlayStation Controller Icons
 * (Community)' set (node 2104:23, "plain" variants). Face buttons are a filled
 * disc + symbol: the disc uses currentColor (so it follows each chip's
 * dim/focus state) and the symbol is punched in var(--bg) so it reads as a
 * cutout on any dark background. */

/* Shoulder buttons (L1/L2/R1/R2): the Figma "plain" bumper-rect (flat top,
 * rounded bottom) filled with currentColor, with the label punched in var(--bg)
 * so it matches the filled face buttons. */
function bumper(label) {
  return `<svg viewBox="0 0 25.6327 17.6224" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 1.60204C0 0.717258 0.717258 0 1.60204 0H24.0306C24.9154 0 25.6327 0.717258 25.6327 1.60204V9.61225C25.6327 14.0362 22.0464 17.6224 17.6224 17.6224H8.01022C3.5863 17.6224 0 14.0362 0 9.61225V1.60204Z" fill="currentColor"/><text x="12.82" y="11.4" text-anchor="middle" font-family="'Source Sans 3', system-ui, sans-serif" font-size="9.5" font-weight="700" fill="var(--bg, #0b0f14)">${label}</text></svg>`;
}

/* DualSense touchpad (Figma node 18:76): a dark pad with a light border and a
 * 7×4 grid of light dots. Mono: pad fill var(--bg), border + dots currentColor
 * so the dots/edge follow the chip's dim/focus/held state. */
function touchpadIcon() {
  const cols = [5.6, 8.8, 12, 15.2, 18.4, 21.6, 24.8];
  const rows = [10.4, 13.6, 16.8, 20];
  let dots = '';
  for (const y of rows) for (const x of cols)
    dots += `<rect x="${x}" y="${y}" width="1.6" height="1.6" rx="0.6" fill="currentColor"/>`;
  return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4.6" y="8.6" width="22.8" height="14.8" rx="2.4" fill="var(--bg, #0b0f14)" stroke="currentColor" stroke-width="1.2"/>${dots}</svg>`;
}

export const GAMEPAD_ICON_SVG = {
  cross: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor"/><path d="M21.7674 11.9998L17.7674 15.9998L21.7674 19.9998L19.9998 21.7674L15.9998 17.7674L11.9998 21.7674L10.2322 19.9998L14.2322 15.9998L10.2322 11.9998L11.9998 10.2322L15.9998 14.2322L19.9998 10.2322L21.7674 11.9998Z" fill="var(--bg, #0b0f14)"/></svg>',
  circle: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor"/><circle cx="16" cy="16" r="5.75" stroke="var(--bg, #0b0f14)" stroke-width="2.5"/></svg>',
  square: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor"/><rect x="11.25" y="11.25" width="9.5" height="9.5" stroke="var(--bg, #0b0f14)" stroke-width="2.5"/></svg>',
  triangle: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="currentColor"/><path d="M20.7627 19.75H11.2373L16 11.5L20.7627 19.75Z" stroke="var(--bg, #0b0f14)" stroke-width="2.5"/></svg>',
  l1: bumper('L1'),
  l2: bumper('L2'),
  r1: bumper('R1'),
  r2: bumper('R2'),
  options: '<svg viewBox="0 0 7 21" fill="none" xmlns="http://www.w3.org/2000/svg"><rect y="7" width="7" height="14" rx="3.5" fill="currentColor"/><line x1="1.5" y1="0.5" x2="5.5" y2="0.5" stroke="currentColor" stroke-linecap="round"/><line x1="1.5" y1="2.5" x2="5.5" y2="2.5" stroke="currentColor" stroke-linecap="round"/><line x1="1.5" y1="4.5" x2="5.5" y2="4.5" stroke="currentColor" stroke-linecap="round"/></svg>',
  touchpad: touchpadIcon(),   // DualSense touchpad (reasoning-effort chip)
};
