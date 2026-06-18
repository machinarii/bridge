/* Focus ring: a flat ordered list of focusable elements across the current surface.
 * Tile content items come first, then action-bar buttons. D-pad up/down moves through
 * the full ring; left/right is reserved for horizontal layouts (action bar).
 */

export class FocusRing {
  constructor() {
    this.items = [];
    this.index = 0;
  }

  set(items) {
    this.items = items.filter(Boolean);
    this.index = 0;
    this.paint();
  }

  get elements() { return this.items || []; }

  current() { return this.items[this.index] || null; }

  move(delta) {
    if (this.items.length === 0) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.paint();
    this.onMove?.();   // cursor moved — host wires this to the nav sound
    this.current()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  moveTo(predicate) {
    const i = this.items.findIndex(predicate);
    if (i >= 0) { this.index = i; this.paint(); }
  }

  paint() {
    this.items.forEach((el, i) => el.classList.toggle('focused', i === this.index));
  }
}
