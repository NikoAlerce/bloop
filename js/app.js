// Registro compartido + bus de eventos muy simple.
const listeners = {};

export const app = {
  state: null,      // datos del proyecto (serializable)
  tracks: [],       // DrumTrack (audio)
  synth: null,      // Synth (audio)
  loopers: [],      // Looper (audio)
  seq: null,        // secuenciador
  kits: [],         // [{name, sounds:[{name, buffer}]}]
  customSamples: new Map(), // id -> AudioBuffer

  on(ev, fn) { (listeners[ev] ||= []).push(fn); },
  off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
  emit(ev, ...args) { (listeners[ev] || []).forEach(fn => fn(...args)); },

  get pattern() { return this.state.patterns[this.state.current]; },

  // i: 0..7 pistas de batería, 8 = synth
  audible(i) {
    const s = this.state;
    const anySolo = s.tracks.some(t => t.solo) || s.synth.solo;
    const ch = i === 8 ? s.synth : s.tracks[i];
    return anySolo ? ch.solo : !ch.mute;
  },
};
