// Pestaña "Sonido": parámetros de la pista seleccionada o del synth.
// Las especificaciones se comparten con el sistema de asignación de controladores.
import { app } from '../app.js';
import { TRACK_COLORS, SYNTH_COLOR } from '../state.js';
import { h, popover, closePopover, chips, toggle, ink, shade } from './util.js';
import { knob } from './knob.js';
import { input } from '../input.js';
import { inputLevel } from '../audio/engine.js';
import { GATES } from '../audio/trackfx.js';
import { noteName } from '../scales.js';
import {
  applyTrack, applySynth, audition, setKitSound, loadFileToTrack, resampleToTrack, toggleMicRecord, micRecInfo,
  soundName, trackName, normalizeTrack, undoTrack,
} from '../actions.js';
import { openSampleEditor } from './waveeditor.js';
import { openBank } from './bank.js';

const pm = v => (v > 0 ? '+' : '') + v;
const sec = v => v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(1) + 's';
const pct = v => Math.round(v * 100) + '';
const WAVES = [['sawtooth', 'Saw'], ['square', 'Sqr'], ['triangle', 'Tri'], ['sine', 'Sin']];

// [clave, etiqueta, opciones]
export const DRUM_SPECS = {
  Sample: [
    ['pitch', 'Afinar', { min: -24, max: 24, step: 1, def: 0, bipolar: true, fmt: pm }],
    ['decay', 'Decay', { def: 1 }],
    ['start', 'Inicio', { max: 0.99, def: 0 }],
    ['end', 'Fin', { min: 0.01, def: 1 }],
    ['root', 'Nota base', { min: 36, max: 84, step: 1, def: 60, fmt: noteName }],
  ],
  Filtro: [
    ['filter', 'Filtro', { def: 0.5, bipolar: true, fmt: v => v < 0.49 ? 'LP' : v > 0.51 ? 'HP' : 'off' }],
    ['reso', 'Reso', { def: 0.1 }],
    ['drive', 'Drive', { def: 0 }],
  ],
  Color: [
    ['crush', 'Bits', { def: 0, fmt: v => Math.round(16 - v * 14) + 'b' }],
    ['down', 'Rate', { def: 0, fmt: v => '÷' + (1 + v * v * 40).toFixed(1) }],
    ['tape', 'Cinta', { def: 0 }],
    ['gateDepth', 'Gate', { def: 0.8 }],
  ],
  Mezcla: [
    ['vol', 'Volumen', { def: 0.8 }],
    ['pan', 'Paneo', { min: -1, max: 1, def: 0, bipolar: true, fmt: v => v < -0.02 ? 'L' + Math.round(-v * 100) : v > 0.02 ? 'R' + Math.round(v * 100) : 'C' }],
    ['rev', 'Reverb', { def: 0 }],
    ['dly', 'Delay', { def: 0 }],
  ],
};
export const SYNTH_SPECS = {
  Osciladores: [
    ['osc1', 'Osc 1', { def: 1 }],
    ['unison', 'Voces', { min: 1, max: 7, step: 1, fmt: v => v + 'x' }],
    ['detune', 'Detune', {}], ['mix2', 'Osc 2', {}],
    ['semi2', 'Semitono 2', { min: -24, max: 24, step: 1, bipolar: true, fmt: pm }],
    ['sub', 'Sub', {}], ['noise', 'Ruido', {}], ['fm', 'FM', {}],
  ],
  Filtro: [
    ['cutoff', 'Brillo', {}], ['reso', 'Reso', {}], ['envAmt', 'Env', {}],
    ['fa', 'F.Ataque', { max: 3, fmt: sec }], ['fd', 'F.Caída', { max: 3, fmt: sec }], ['fs', 'F.Sostén', {}],
  ],
  'Volumen (ADSR)': [
    ['a', 'Ataque', { max: 3, fmt: sec }], ['d', 'Caída', { max: 3, fmt: sec }], ['s', 'Sostén', {}], ['r', 'Release', { max: 5, fmt: sec }],
  ],
  Mod: [
    ['glide', 'Glide', { max: 0.5, fmt: sec }], ['vib', 'Vibrato', {}],
    ['penv', 'Pitch env', { min: -24, max: 24, step: 1, bipolar: true, def: 0, fmt: pm }],
    ['lfoAmt', 'Wobble', { def: 0 }],
  ],
  FX: [['chorus', 'Chorus', {}], ['drive', 'Drive', {}], ['rev', 'Reverb', {}], ['dly', 'Delay', {}], ['vol', 'Volumen', {}]],
};
const SYNTH_FX = DRUM_SPECS.Color;

// Registra todos los parámetros como destinos asignables (aunque no estén en pantalla)
export function registerParamTargets() {
  const reg = (id, labelFn, obj, k, o, apply, ch) => {
    const min = o.min ?? 0, max = o.max ?? 1, step = o.step || 0;
    input.target(id, {
      get label() { return labelFn(); },
      kind: 'value',
      get: () => (obj()[k] - min) / (max - min),
      set: v => {
        let x = min + v * (max - min);
        if (step) x = Math.round(x / step) * step;
        obj()[k] = x; apply(); app.emit('param', ch, k);
      },
    });
  };
  for (let i = 0; i < 8; i++) {
    for (const specs of Object.values(DRUM_SPECS)) for (const [k, label, o] of specs) {
      reg(`p:${i}:${k}`, () => `${trackName(i)} · ${label}`, () => app.state.tracks[i].params, k, o, () => applyTrack(i), i);
    }
  }
  for (const specs of Object.values(SYNTH_SPECS)) for (const [k, label, o] of specs) {
    reg(`p:s:${k}`, () => `Synth · ${label}`, () => app.state.synth.params, k, o, applySynth, 's');
  }
  for (const [k, label, o] of SYNTH_FX) reg(`p:sfx:${k}`, () => `Synth · ${label}`, () => app.state.synth.fx, k, o, applySynth, 'sfx');
}

export function buildParams() {
  const el = h('div', { class: 'dock-body' });
  const body = h('div', { class: 'params-wrap' });
  el.append(body);
  let waveDraw = null, knobs = {}, recTimer = null;

  const group = (label, ...items) => h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, label), h('div', { class: 'row' }, ...items));
  const mkKnobs = (specs, obj, col, prefix, ch, apply, extra = () => {}) => specs.map(([k, label, o]) => {
    const kn = knob({ label, value: obj[k], color: col, learn: `p:${prefix}:${k}`, ...o, onInput: v => { obj[k] = v; apply(); extra(k); } });
    knobs[ch + ':' + k] = kn;
    return kn.el;
  });

  function mount() {
    body.innerHTML = '';
    waveDraw = null; knobs = {};
    clearInterval(recTimer);
    if (app.state.selected === 8) mountSynth(); else mountDrum(app.state.selected);
    input.markMapped();
  }

  // ---------- Pista de batería ----------
  function mountDrum(i) {
    const t = app.state.tracks[i], p = t.params, col = TRACK_COLORS[i];
    body.style.setProperty('--c', col);
    const wave = h('canvas', { class: 'wave' });
    waveDraw = () => drawWave(wave, app.tracks[i], p, col);
    // Arrastrar sobre la onda mueve el marcador más cercano (inicio o fin)
    wave.addEventListener('pointerdown', e => {
      wave.setPointerCapture(e.pointerId);
      undoTrack(i, 'Región', 'reg' + i);
      const r = wave.getBoundingClientRect();
      const x0 = (e.clientX - r.left) / r.width;
      const key = Math.abs(x0 - p.start) <= Math.abs(x0 - p.end) ? 'start' : 'end';
      const mv = ev => {
        const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        if (key === 'start') p.start = Math.min(x, p.end - 0.01); else p.end = Math.max(x, p.start + 0.01);
        knobs[i + ':' + key]?.set(p[key]); waveDraw();
      };
      mv(e);
      const upH = () => { wave.removeEventListener('pointermove', mv); wave.removeEventListener('pointerup', upH); audition(i); app.emit('param', i, key); };
      wave.addEventListener('pointermove', mv); wave.addEventListener('pointerup', upH);
    });

    const file = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) loadFileToTrack(i, f); } });
    const soundsBtn = h('button', { class: 'sbtn on' }, '🎵 ' + soundName(i));
    soundsBtn.addEventListener('click', () => openBank(i));
    const rec = micRecInfo();
    const micBtn = h('button', { class: 'sbtn rec' + (rec ? ' on' : ''), onclick: () => toggleMicRecord(i) }, rec ? '■ Parar' : '🎤 Grabar');
    if (rec) {
      let heard = false;
      recTimer = setInterval(() => {
        const info = micRecInfo(); if (!info) return;
        if (inputLevel() > app.state.settings.recThresh) heard = true;
        micBtn.textContent = heard ? `■ Parar · ${info.secs.toFixed(0)}s` : '⏳ Esperando sonido…';
      }, 200);
    }
    const revBtn = toggle('⇄ Reversa', p.reverse, v => { p.reverse = v; waveDraw(); audition(i); }, 'sbtn');
    const monoBtn = toggle('Mono', p.mono, v => { p.mono = v; }, 'sbtn');
    const box = h('div', { class: 'sample-box' },
      h('div', { class: 'btn-row' }, soundsBtn, h('button', { class: 'sbtn', onclick: () => audition(i) }, '▶'),
        h('button', { class: 'sbtn', onclick: () => openSampleEditor(i) }, '✎ Editor')),
      wave,
      h('div', { class: 'btn-row' },
        h('button', { class: 'sbtn', onclick: () => file.click() }, '📁 Archivo'),
        micBtn,
        h('button', { class: 'sbtn', onclick: () => openResample(i) }, '⟲ Resample'),
        revBtn, monoBtn,
        h('button', { class: 'sbtn', onclick: () => normalizeTrack(i) }, '📈 Normalizar'), file),
    );

    const apply = () => applyTrack(i);
    const extra = k => { if (k === 'start' || k === 'end') waveDraw && waveDraw(); };
    const gateChips = chips(GATES.map(g => [g, g === 'off' ? 'off' : g]), p.gate, v => { p.gate = v; apply(); });
    body.append(
      box,
      group('Sample', ...mkKnobs(DRUM_SPECS.Sample, p, col, i, i, apply, extra)),
      group('Filtro', ...mkKnobs(DRUM_SPECS.Filtro, p, col, i, i, apply)),
      h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, 'Color · crush, cinta y gate'),
        h('div', { class: 'row' }, ...mkKnobs(DRUM_SPECS.Color, p, col, i, i, apply)), gateChips),
      group('Mezcla', ...mkKnobs(DRUM_SPECS.Mezcla, p, col, i, i, apply)),
      h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, 'Choke'),
        chips([[0, '—'], [1, 'A'], [2, 'B']], t.choke, v => { t.choke = +v; }),
        h('div', { class: 'hint' }, 'Pistas con la misma letra se cortan entre sí (ej: hat abierto/cerrado)')),
    );
    requestAnimationFrame(waveDraw);
  }

  function openSounds(anchor, i) {
    popover(anchor, [
      h('h4', {}, 'Sonidos'),
      h('div', { class: 'sound-list' }, ...app.kits.flatMap((k, ki) => [
        h('div', { class: 'kit-name' }, k.name),
        h('div', { class: 'row' }, ...k.sounds.map((snd, si) => h('button', { class: 'sbtn', onclick: () => { setKitSound(i, ki, si); audition(i); } }, snd.name))),
      ])),
    ]).style.setProperty('--c', TRACK_COLORS[i]);
  }

  function openResample(i) {
    popover(body.querySelector('.sample-box'), [
      h('h4', {}, 'Resample'),
      h('div', { class: 'hint' }, 'Graba lo que suena (batería + synth) desde el próximo compás y lo pone en esta pista.'),
      h('div', { class: 'btn-row' }, ...[1, 2, 4].map(b => h('button', { class: 'sbtn', onclick: () => { closePopover(); resampleToTrack(i, b); } }, `${b} compás${b > 1 ? 'es' : ''}`))),
    ]);
  }

  // ---------- Synth ----------
  function mountSynth() {
    const sy = app.state.synth, col = SYNTH_COLOR, p = sy.params;
    body.style.setProperty('--c', col);
    body.append(
      h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, 'Onda 1 · Onda 2'),
        chips(WAVES, p.wave, v => { p.wave = v; }),
        chips(WAVES, p.wave2, v => { p.wave2 = v; }),
        h('div', { class: 'row', style: { marginTop: '4px', gap: '4px' } },
          toggle('Mono', p.mono, v => { p.mono = v; app.synth.allOff(); }))),
      h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, 'Wobble · LFO al filtro (a tempo)'),
        chips(['1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/32'], p.lfoDiv, v => { p.lfoDiv = v; }),
        chips([['sine', '∿'], ['square', '⊓'], ['saw', '⩘']], p.lfoShape, v => { p.lfoShape = v; }),
        h('div', { class: 'hint' }, 'Subí la perilla Wobble (grupo Mod). Cada nota arranca el wobble desde cerrado.')),
      ...Object.entries(SYNTH_SPECS).map(([g, specs]) => group(g, ...mkKnobs(specs, p, col, 's', 's', applySynth))),
      h('div', { class: 'knob-group' }, h('div', { class: 'lbl' }, 'Color · crush, cinta y gate'),
        h('div', { class: 'row' }, ...mkKnobs(SYNTH_FX, sy.fx, col, 'sfx', 'sfx', applySynth)),
        chips(GATES.map(g => [g, g]), sy.fx.gate, v => { sy.fx.gate = v; applySynth(); })),
    );
  }

  app.on('select', mount);
  app.on('preset', () => { if (app.state.selected === 8) mount(); });
  app.on('synth-param', () => { if (app.state.selected === 8) mount(); });
  app.on('sound', i => { if (i === app.state.selected) mount(); });
  app.on('mic-rec', () => { if (app.state.selected !== 8) mount(); });
  // Un controlador físico movió un parámetro: actualizar la perilla visible
  app.on('param', (ch, k) => {
    const kn = knobs[ch + ':' + k];
    if (!kn) return;
    const obj = ch === 's' ? app.state.synth.params : ch === 'sfx' ? app.state.synth.fx : app.state.tracks[ch].params;
    kn.set(obj[k]);
    if (k === 'start' || k === 'end') waveDraw && waveDraw();
  });
  mount();
  return { el, refresh: mount };
}

function drawWave(cv, track, p, col) {
  const r = cv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = devicePixelRatio || 1;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const buf = track.buffer;
  if (!buf) return;
  const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / W));
  let max = 0.0001;
  for (let i = 0; i < d.length; i += 8) max = Math.max(max, Math.abs(d[i]));
  const mirror = x => (p.reverse ? W - 1 - x : x);
  g.fillStyle = col;
  for (let x = 0; x < W; x++) {
    let m = 0;
    for (let j = x * step; j < (x + 1) * step && j < d.length; j += 2) m = Math.max(m, Math.abs(d[j]));
    const hh = (m / max) * (H * 0.44);
    g.fillRect(mirror(x), H / 2 - hh, 1, hh * 2 + 1);
  }
  const sx = mirror(p.start * W), ex = mirror(p.end * W);
  g.fillStyle = shade(0.65);
  g.fillRect(0, 0, Math.min(sx, ex), H); g.fillRect(Math.max(sx, ex), 0, W, H);
  if (p.sliceMode) {
    g.fillStyle = ink(0.7);
    for (const s of p.slices) g.fillRect(mirror(s * W), 0, dpr, H);
  }
  g.fillStyle = ink(1);
  for (const x of [sx, ex]) { g.fillRect(x - dpr, 0, 2 * dpr, H); g.beginPath(); g.arc(x, 8 * dpr, 6 * dpr, 0, Math.PI * 2); g.fill(); }
}
