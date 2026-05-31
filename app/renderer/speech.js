const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Speech extends EventTarget {
  constructor() {
    super();
    this.supported = !!Recognition;
    this.recognition = null;
    this.listening = false;
    this._holding = false;   // true between start() (PTT press) and stop() (release)
    this._finalText = '';    // accumulated final transcript across the whole hold
    if (this.supported) {
      const r = new Recognition();
      r.lang = 'en-US';
      r.interimResults = true;
      // Stay listening through pauses. With continuous=false the recognizer
      // ended after the first utterance/silence, so push-to-talk deactivated
      // the instant the user paused (or immediately, on no speech). We keep it
      // active for the whole hold and only finalize on release (see onend).
      r.continuous = true;
      r.maxAlternatives = 1;
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) this._finalText += t;
          else interim += t;
        }
        this.dispatchEvent(new CustomEvent('partial', { detail: (this._finalText + interim).trim() }));
      };
      r.onerror = (e) => {
        // 'no-speech'/'aborted' can fire mid-hold on brief silence. While the
        // key is still held, swallow it and let onend restart listening.
        if (this._holding && (e.error === 'no-speech' || e.error === 'aborted')) return;
        this.listening = false;
        this.dispatchEvent(new CustomEvent('error', { detail: e.error || 'unknown' }));
      };
      r.onend = () => {
        // The browser stops on silence even with continuous=true. If the user
        // is still holding, transparently restart so PTT stays active until
        // they actually release; otherwise finalize the accumulated transcript.
        if (this._holding) {
          try { this.recognition.start(); return; } catch { /* fall through to finalize */ }
        }
        const text = this._finalText.trim();
        this._finalText = '';
        this.listening = false;
        this.dispatchEvent(new CustomEvent('end', { detail: text }));
      };
      this.recognition = r;
    }
  }

  start() {
    if (!this.supported || this.listening) return;
    this._holding = true;
    this._finalText = '';
    try {
      this.recognition.start();
      this.listening = true;
      this.dispatchEvent(new CustomEvent('start'));
    } catch (err) {
      // start() throws if already started — swallow.
      console.warn('[speech] start error:', err);
    }
  }

  stop() {
    // PTT released: end the hold, then stop. The next onend finalizes and
    // dispatches the accumulated transcript.
    this._holding = false;
    if (!this.supported || !this.listening) return;
    try { this.recognition.stop(); } catch {}
  }
}

let voice = null;
function pickVoice() {
  if (voice) return voice;
  const all = window.speechSynthesis.getVoices();
  voice =
    all.find(v => /Samantha|Karen|Daniel|Google US English|Microsoft Aria/i.test(v.name)) ||
    all.find(v => v.lang?.startsWith('en')) ||
    all[0] || null;
  return voice;
}
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { voice = null; pickVoice(); };
  pickVoice();
}

/* Module-level event emitter for TTS lifecycle so callers can mark
 * which agent tile is "currently talking." */
class SpeechBus extends EventTarget {}
export const speechBus = new SpeechBus();

export function speak(text, { interrupt = true, agentId = null } = {}) {
  if (!('speechSynthesis' in window) || !text) return;
  if (interrupt) {
    window.speechSynthesis.cancel();
    speechBus.dispatchEvent(new CustomEvent('end'));
  }
  const utt = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) utt.voice = v;
  utt.rate = 1.02;
  utt.pitch = 1.0;
  utt.onstart = () => speechBus.dispatchEvent(new CustomEvent('start', { detail: { agentId } }));
  utt.onend   = () => speechBus.dispatchEvent(new CustomEvent('end',   { detail: { agentId } }));
  utt.onerror = () => speechBus.dispatchEvent(new CustomEvent('end',   { detail: { agentId } }));
  window.speechSynthesis.speak(utt);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  speechBus.dispatchEvent(new CustomEvent('end'));
}
