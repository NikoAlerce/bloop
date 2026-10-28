// Entrada al modo Estudio: prepara el arreglo (con un ejemplo la primera vez), carga el audio
// guardado y arma la interfaz recién cuando se abre (así el modo En vivo no gasta de más).
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { isPatternEmpty } from '../state.js';
import { S, defaultStudio, newTrack, newMidiClip, loadBuffers, gcBuffers, DRUM_NOTE } from './model.js';
import { studio } from './engine.js';
import { buildStudio } from './ui.js';
import { liveKit } from './browser.js';

let ready = false, ui = null;

export function studioReady() { return ready; }

async function prepare() {
  if (ready) return;
  const s = app.state;
  if (!s.studio || s.studio.v !== 1) { s.studio = defaultStudio(); demo(); }
  else s.studio = { ...defaultStudio(), ...s.studio, rec: false };
  const keep = await loadBuffers();
  gcBuffers(keep);
  studio.init();
  studio.sync();
  ready = true;
  // Ctrl+… (el sistema de entradas de Bloop ignora las teclas con Ctrl)
  window.addEventListener('keydown', e => {
    if (app.state.view !== 'studio' || !(e.ctrlKey || e.metaKey) || e.target.closest?.('input,textarea,select')) return;
    if (ui?.key(e, true)) e.preventDefault();
  });
}

export async function openStudio(el) {
  await prepare();
  if (!ui) ui = buildStudio(el);
  else ui.layout();
  app.emit('studio-view');
}

export const studioFrame = () => ui?.frame();
export const studioTick = () => { if (ready) studio.tick(); };
export const studioKey = (e, down) => (ui ? ui.key(e, down) : false);
export function studioMidi(ev) {
  if (!ready) return false;
  if (ev.cmd === 0x90 || ev.cmd === 0x80) {
    if (ev.on) studio.noteOn(ev.d1, ev.value); else studio.noteOff(ev.d1);
    return true;
  }
  return false;
}
export function stopStudio() { if (ready) studio.stop(); }

// Ejemplo de arranque: la batería y el synth del patrón actual + una pista de audio vacía
function demo() {
  const st = S(), s = app.state, p = s.patterns[s.current];
  if (!isPatternEmpty(p)) {
    const notes = [];
    let len = 1;
    p.tracks.forEach((tp, i) => {
      len = Math.max(len, tp.len);
      for (let k = 0; k < tp.len; k++) { const step = tp.steps[k]; if (step) notes.push({ p: DRUM_NOTE + i, s: (k + (step.nudge || 0)) / 4, d: 0.25, v: step.vel }); }
    });
    if (notes.length) {
      const t = newTrack('midi', { inst: liveKit(), name: 'Batería' });
      const c = newMidiClip(0, 16, t.color, notes); c.loop = Math.ceil(len / 16) * 4; c.name = 'Groove';
      t.clips.push(c); st.tracks.push(t);
    }
    if (p.synth.notes.length) {
      const t = newTrack('midi', { inst: { type: 'synth', preset: s.synth.preset, params: { ...s.synth.params } }, name: 'Synth' });
      const c = newMidiClip(0, 16, t.color, p.synth.notes.map(n => ({ p: n.midi, s: n.step / 4, d: n.len / 4, v: n.vel })));
      c.loop = Math.ceil(p.synth.len / 16) * 4; c.name = 'Acordes';
      t.clips.push(c); st.tracks.push(t);
    }
  }
  st.tracks.push(newTrack('audio', { name: 'Voz' }));
  st.sel.track = st.tracks[0].id;
  st.loop = { on: true, a: 0, b: 16 };
}
