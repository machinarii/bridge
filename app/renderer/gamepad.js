/* PlayStation 5 DualSense mapping (Chrome standard gamepad layout).
 * Buttons: 0=Cross, 1=Circle, 2=Square, 3=Triangle,
 *          4=L1, 5=R1, 6=L2, 7=R2,
 *          8=Create, 9=Options,
 *          12=DPad Up, 13=DPad Down, 14=DPad Left, 15=DPad Right.
 * Left stick: axes[0]=X, axes[1]=Y.
 *
 * Semantic event names emitted on the bus:
 *   cross | circle | square | triangle
 *   l1 | r1 | l2
 *   up | down | left | right
 *   options
 * PTT: 'ptt-down' / 'ptt-up' from R2 (analog).
 * L2 is a digital press here (analog value ignored); R2 stays analog for PTT.
 */

const BUTTON_MAP = {
  0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle',
  4: 'l1', 5: 'r1', 6: 'l2',
  9: 'options',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
const PTT_INDEX = 7; // R2
const STICK_THRESHOLD = 0.55;
const REPEAT_DELAY_MS = 320;
const REPEAT_INTERVAL_MS = 110;
const REPEATABLE = new Set(['up', 'down', 'left', 'right', 'l1', 'r1']);

export class GamepadInput extends EventTarget {
  constructor() {
    super();
    this.prev = {};
    this.repeat = {};
    this.pttDown = false;
    this.raf = null;
    window.addEventListener('gamepadconnected', (e) => {
      console.log('[gamepad] connected:', e.gamepad.id);
      this.dispatchEvent(new CustomEvent('connected', { detail: e.gamepad.id }));
      if (!this.raf) this.loop();
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.dispatchEvent(new CustomEvent('disconnected'));
    });
    this.loop();
  }

  loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      this.scan(pad);
    }
  };

  scan(pad) {
    const now = performance.now();

    // PTT (R2) — analog trigger, treat as pressed when value > 0.5
    const r2 = pad.buttons[PTT_INDEX];
    const r2Pressed = !!r2 && (r2.pressed || r2.value > 0.5);
    if (r2Pressed && !this.pttDown) {
      this.pttDown = true;
      this.dispatchEvent(new CustomEvent('ptt-down'));
    } else if (!r2Pressed && this.pttDown) {
      this.pttDown = false;
      this.dispatchEvent(new CustomEvent('ptt-up'));
    }

    for (const [idxStr, name] of Object.entries(BUTTON_MAP)) {
      const idx = +idxStr;
      const btn = pad.buttons[idx];
      const pressed = !!btn && btn.pressed;
      const was = this.prev[idx];
      if (pressed && !was) {
        this.dispatchEvent(new CustomEvent('press', { detail: { button: name } }));
        if (REPEATABLE.has(name)) this.repeat[name] = { firstAt: now, lastAt: now };
      } else if (!pressed && was) {
        delete this.repeat[name];
      }
      this.prev[idx] = pressed;
    }

    for (const name of Object.keys(this.repeat)) {
      const r = this.repeat[name];
      const since = now - r.firstAt;
      if (since < REPEAT_DELAY_MS) continue;
      if (now - r.lastAt >= REPEAT_INTERVAL_MS) {
        r.lastAt = now;
        this.dispatchEvent(new CustomEvent('press', { detail: { button: name, repeat: true } }));
      }
    }

    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const stickDir =
      ay < -STICK_THRESHOLD ? 'up' :
      ay >  STICK_THRESHOLD ? 'down' :
      ax < -STICK_THRESHOLD ? 'left' :
      ax >  STICK_THRESHOLD ? 'right' : null;
    if (stickDir !== this._lastStickDir) {
      if (stickDir) {
        this.dispatchEvent(new CustomEvent('press', { detail: { button: stickDir } }));
        this.repeat[stickDir] = { firstAt: now, lastAt: now };
      } else if (this._lastStickDir) {
        delete this.repeat[this._lastStickDir];
      }
      this._lastStickDir = stickDir;
    }
  }
}
