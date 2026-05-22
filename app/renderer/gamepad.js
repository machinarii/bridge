/* Xbox-style controller mapping (standard layout, Chrome).
 * Buttons: 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT, 8=Back, 9=Start,
 *          12=DPad Up, 13=DPad Down, 14=DPad Left, 15=DPad Right.
 * Left stick: axes[0]=X, axes[1]=Y.
 *
 * Emits semantic events: 'press' { button: 'a'|'b'|'x'|'y'|'up'|'down'|'left'|'right'|'start' }
 *                        'ptt-down', 'ptt-up' (RT or LT held).
 */

const BUTTON_MAP = {
  0: 'a', 1: 'b', 2: 'x', 3: 'y',
  4: 'lb', 5: 'rb',
  9: 'start', 8: 'back',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
const PTT_INDEX = 7; // RT
const STICK_THRESHOLD = 0.55;
const REPEAT_DELAY_MS = 320;
const REPEAT_INTERVAL_MS = 110;

export class GamepadInput extends EventTarget {
  constructor() {
    super();
    this.prev = {};       // index -> pressed
    this.repeat = {};     // semantic name -> { firstAt, lastAt }
    this.pttDown = false;
    this.raf = null;
    window.addEventListener('gamepadconnected', (e) => {
      console.log('[gamepad] connected:', e.gamepad.id);
      this.dispatchEvent(new CustomEvent('connected', { detail: e.gamepad.id }));
      if (!this.raf) this.loop();
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log('[gamepad] disconnected:', e.gamepad.id);
      this.dispatchEvent(new CustomEvent('disconnected'));
    });
    // start polling anyway — some pads only show up after first input
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

    // PTT (RT)
    const rt = pad.buttons[PTT_INDEX];
    const rtPressed = !!rt && (rt.pressed || rt.value > 0.5);
    if (rtPressed && !this.pttDown) {
      this.pttDown = true;
      this.dispatchEvent(new CustomEvent('ptt-down'));
    } else if (!rtPressed && this.pttDown) {
      this.pttDown = false;
      this.dispatchEvent(new CustomEvent('ptt-up'));
    }

    // Discrete buttons
    for (const [idxStr, name] of Object.entries(BUTTON_MAP)) {
      const idx = +idxStr;
      const btn = pad.buttons[idx];
      const pressed = !!btn && btn.pressed;
      const was = this.prev[idx];
      if (pressed && !was) {
        this.dispatchEvent(new CustomEvent('press', { detail: { button: name } }));
        if (['up','down','left','right'].includes(name)) {
          this.repeat[name] = { firstAt: now, lastAt: now };
        }
      } else if (!pressed && was) {
        delete this.repeat[name];
      }
      this.prev[idx] = pressed;
    }

    // Held d-pad repeat
    for (const name of ['up','down','left','right']) {
      const r = this.repeat[name];
      if (!r) continue;
      const since = now - r.firstAt;
      if (since < REPEAT_DELAY_MS) continue;
      if (now - r.lastAt >= REPEAT_INTERVAL_MS) {
        r.lastAt = now;
        this.dispatchEvent(new CustomEvent('press', { detail: { button: name, repeat: true } }));
      }
    }

    // Left stick → discrete d-pad events
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
