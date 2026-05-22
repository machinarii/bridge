const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Speech extends EventTarget {
  constructor() {
    super();
    this.supported = !!Recognition;
    this.recognition = null;
    this.listening = false;
    if (this.supported) {
      const r = new Recognition();
      r.lang = 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      let finalText = '';
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t;
          else interim += t;
        }
        this.dispatchEvent(new CustomEvent('partial', { detail: (finalText + interim).trim() }));
      };
      r.onerror = (e) => {
        this.listening = false;
        this.dispatchEvent(new CustomEvent('error', { detail: e.error || 'unknown' }));
      };
      r.onend = () => {
        const text = finalText.trim();
        finalText = '';
        this.listening = false;
        this.dispatchEvent(new CustomEvent('end', { detail: text }));
      };
      this.recognition = r;
    }
  }

  start() {
    if (!this.supported || this.listening) return;
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

export function speak(text, { interrupt = true } = {}) {
  if (!('speechSynthesis' in window) || !text) return;
  if (interrupt) window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) utt.voice = v;
  utt.rate = 1.02;
  utt.pitch = 1.0;
  window.speechSynthesis.speak(utt);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
