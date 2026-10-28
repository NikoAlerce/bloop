// Modo Pads (drum machine): los 8 sonidos de batería como pads gigantes, con los loops al
// lado, para tocar la batería en vivo en vez de secuenciarla. Lo que tocás se puede grabar
// en un loop (fuente 🎹: solo lo que tocás) o en los pasos (⏺ de arriba).
import { app } from '../app.js';
import { TRACK_COLORS } from '../state.js';
import { h, chips } from './util.js';
import { hitLive, selectTrack, trackName, soundName } from '../actions.js';
import { openBank } from './bank.js';
import { openSampleEditor } from './waveeditor.js';
import { COUNT_OPTS } from './countin.js';
import { openStudio, stopStudio } from '../studio/index.js';

// Vistas: 'main' (todo) · 'pads' (drum machine + loops) · 'keys' (loops arriba + teclado abajo)
// · 'studio' (vista Arrangement, pantalla completa)
export function setView(v) {
  const prev = app.state.view;
  app.state.view = v;
  const el = document.getElementById('app');
  el.classList.toggle('pads-mode', v === 'pads');
  el.classList.toggle('keys-mode', v === 'keys');
  el.classList.toggle('studio-mode', v === 'studio');
  document.body.classList.toggle('studio-on', v === 'studio');
  document.getElementById('studio').hidden = v !== 'studio';
  if (v === 'studio') {
    if (app.seq.playing) app.seq.stop();
    openStudio(document.getElementById('studio'));
  } else if (prev === 'studio') stopStudio();
  app.emit('view');
}

export function buildPadView(el) {
  const s = app.state;
  const grid = h('div', { class: 'bigpads' });
  const pads = [];
  for (let i = 0; i < 8; i++) {
    const name = h('b'), sub = h('small');
    const pad = h('div', { class: 'bigpad' }, h('span', { class: 'bp-num' }, i + 1), h('div', { class: 'bp-txt' }, name, sub));
    pad.style.setProperty('--c', TRACK_COLORS[i]);
    // Fuerza según dónde tocás: abajo = fuerte (o siempre fuerte)
    pad.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = pad.getBoundingClientRect();
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      hitLive(i, s.padVel === 'fixed' ? 0.95 : 0.4 + 0.6 * y);
      pad.classList.add('down');
      if (s.selected !== i) selectTrack(i);
    });
    const up = () => pad.classList.remove('down');
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('pointerleave', up);
    pad.addEventListener('contextmenu', e => e.preventDefault());
    pads.push({ pad, name, sub });
    grid.append(pad);
  }

  const velChips = chips([['touch', '✋ Fuerza al tocar'], ['fixed', '💥 Siempre fuerte']], s.padVel || 'touch', v => { s.padVel = v; });
  velChips.classList.add('no-learn');
  // Cuenta regresiva antes de grabar (con el transporte parado): sin · 1 · 2 compases
  const countBtn = h('button', { class: 'pill', title: 'Cuenta regresiva antes de grabar' });
  const updCount = () => {
    const v = s.countIn ?? 1;
    countBtn.textContent = '⏱ ' + (v ? COUNT_OPTS[v][1] : 'Sin cuenta');
    countBtn.classList.toggle('on', !!v);
  };
  countBtn.addEventListener('click', () => { s.countIn = ((s.countIn ?? 1) + 1) % 3; updCount(); app.emit('countin-opt'); });
  app.on('countin-opt', updCount);
  updCount();
  el.append(
    h('div', { class: 'pv-head' },
      h('span', { class: 'panel-title' }, 'Pads'),
      velChips,
      countBtn,
      h('div', { style: { flex: 1 } }),
      h('button', { class: 'pill', title: 'Cambiar el sonido del pad elegido', onclick: () => openBank(s.lastDrum ?? 0) }, '📚 Sonido'),
      h('button', { class: 'pill', title: 'Editar la onda del pad elegido', onclick: () => openSampleEditor(s.lastDrum ?? 0) }, '✎ Onda'),
      h('button', { class: 'pill', title: 'Volver a la vista completa', onclick: () => setView('main') }, '✕')),
    grid,
    h('div', { class: 'hint pv-hint' }, 'Para grabar lo que tocás: en un loop con 🎹 (graba solo lo que tocás, sin la base) o con ⏺ arriba (queda en los pasos).'),
  );

  function update() {
    pads.forEach(({ pad, name, sub }, i) => {
      name.textContent = trackName(i);
      sub.textContent = soundName(i) !== trackName(i) ? soundName(i) : '';
      pad.classList.toggle('sel', (s.lastDrum ?? 0) === i);
      pad.classList.toggle('muted', !app.audible(i));
    });
  }
  update();
  ['select', 'sound', 'tracks', 'view', 'mix'].forEach(ev => app.on(ev, update));

  return {
    flash(i) {
      if (s.view !== 'pads' || !pads[i]) return;
      const p = pads[i].pad;
      p.classList.remove('hit'); void p.offsetWidth; p.classList.add('hit');
    },
  };
}
