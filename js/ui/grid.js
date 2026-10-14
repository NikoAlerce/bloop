// Centro: 32 pads (pista de batería) o piano roll (synth).
import { app } from '../app.js';
import { TRACK_COLORS, SYNTH_COLOR, MAX_STEPS, mkStep } from '../state.js';
import { h, popover, closePopover, slider, chips, fmtPct } from './util.js';
import { trackName } from '../actions.js';
import { Roll } from './roll.js';
import { undo } from '../undo.js';
import { input } from '../input.js';
import { openSampleEditor } from './waveeditor.js';
import { degree } from '../scales.js';

const WEIGHTS = [ // [tiempo fuerte, contratiempo, semicorchea]
  [0.75, 0.15, 0.08], [0.06, 0.06, 0.04], [0.05, 0.08, 0.04], [0.55, 0.9, 0.4],
  [0.05, 0.4, 0.05], [0.15, 0.25, 0.2], [0.15, 0.2, 0.15], [0.08, 0.12, 0.1],
];

export function buildGrid(head, wrap) {
  const s = app.state;
  let playStep = -1;

  // ---------- Pads ----------
  const pads = h('div', { class: 'pads' });
  const padEls = [];
  for (let k = 0; k < MAX_STEPS; k++) {
    const p = h('div', { class: 'pad' + (k % 4 === 0 ? ' beat' : ''), 'data-k': k }, h('span', { class: 'pnum' }, k + 1), h('span', { class: 'pinfo' }));
    padEls.push(p); pads.append(p);
    input.target('step:' + k, {
      label: `Paso ${k + 1} (pista elegida)`, kind: 'button', el: p,
      press: () => { if (s.selected === 8) return; undo.pattern('Pasos'); setStep(k, !tp().steps[k]); renderPads(); app.emit('pattern-edit'); },
    });
  }
  const roll = new Roll();

  const tp = () => app.pattern.tracks[s.selected];

  function renderPads() {
    const t = tp();
    padEls.forEach((p, k) => {
      const st = t.steps[k];
      p.classList.toggle('on', !!st);
      p.classList.toggle('out', k >= t.len);
      p.classList.toggle('prob', !!st && st.prob < 1);
      p.classList.toggle('ph', k === playStep % t.len && playStep >= 0);
      if (st) p.style.setProperty('--v', st.vel);
      const info = p.lastChild;
      info.innerHTML = '';
      if (st) {
        const sl = s.tracks[s.selected].params.sliceMode;
        if (sl) info.append(h('span', {}, 'S' + ((st.pitch || 0) + 1)));
        else if (st.pitch) info.append(h('span', {}, (st.pitch > 0 ? '+' : '') + st.pitch));
        if (st.nudge) info.append(h('span', {}, st.nudge > 0 ? '›' : '‹'));
        if (st.rat > 1) info.append(h('span', { class: 'rat' }, ...Array.from({ length: st.rat }, () => h('i'))));
      }
    });
  }

  // Interacción táctil: tocar = on/off, arrastrar = pintar, mantener = editar
  const touches = new Map();
  const padAt = (x, y) => { const e = document.elementFromPoint(x, y); const p = e && e.closest('.pad'); return p && pads.contains(p) ? +p.dataset.k : null; };
  const setStep = (k, on) => {
    const t = tp();
    if (on && !t.steps[k]) t.steps[k] = mkStep(0.8);
    if (!on) t.steps[k] = null;
  };
  pads.addEventListener('pointerdown', e => {
    const k = padAt(e.clientX, e.clientY);
    if (k == null) return;
    if (e.button === 2 || e.shiftKey) { e.preventDefault(); openStep(k); return; }
    pads.setPointerCapture(e.pointerId);
    undo.pattern('Pasos');
    const orig = tp().steps[k];
    const val = !orig;
    setStep(k, val);
    const tc = { k, orig, val, last: k, timer: null };
    tc.timer = setTimeout(() => {
      tp().steps[k] = orig || mkStep(0.8);
      tc.done = true; renderPads(); openStep(k);
    }, 480);
    touches.set(e.pointerId, tc);
    renderPads(); app.emit('pattern-edit');
  });
  pads.addEventListener('pointermove', e => {
    const tc = touches.get(e.pointerId);
    if (!tc || tc.done) return;
    const k = padAt(e.clientX, e.clientY);
    if (k == null || k === tc.last) return;
    clearTimeout(tc.timer);
    tc.last = k; setStep(k, tc.val); renderPads();
  });
  const up = e => { const tc = touches.get(e.pointerId); if (tc) { clearTimeout(tc.timer); touches.delete(e.pointerId); app.emit('pattern-edit'); } };
  pads.addEventListener('pointerup', up);
  pads.addEventListener('pointercancel', up);
  pads.addEventListener('contextmenu', e => e.preventDefault());

  function openStep(k) {
    const st = tp().steps[k];
    if (!st) return;
    const col = TRACK_COLORS[s.selected];
    const tparams = s.tracks[s.selected].params;
    const nSl = tparams.sliceMode ? tparams.slices.length : 0;
    // Cada cambio guarda una foto ANTES de modificar (los cambios seguidos se agrupan)
    const ch = fn => v => { undo.pattern('Editar paso', 'step' + k); fn(v); renderPads(); app.emit('pattern-edit'); };
    const pop = popover(padEls[k], [
      h('h4', {}, `Paso ${k + 1}`),
      slider({ label: 'Velocity', value: st.vel, color: col, fmt: fmtPct, onInput: ch(v => { st.vel = Math.max(0.05, v); }) }),
      slider({ label: 'Probabilidad', value: st.prob, color: col, step: 0.05, fmt: fmtPct, onInput: ch(v => { st.prob = Math.max(0.05, v); }) }),
      nSl
        ? slider({ label: 'Slice', min: 0, max: Math.max(1, nSl - 1), step: 1, value: Math.min(st.pitch, nSl - 1), color: col, fmt: v => (v + 1) + ' de ' + nSl, onInput: ch(v => { st.pitch = v; }) })
        : slider({ label: 'Afinación', min: -24, max: 24, step: 1, value: st.pitch, color: col, fmt: v => (v > 0 ? '+' : '') + v + ' st', onInput: ch(v => { st.pitch = v; }) }),
      slider({ label: 'Micro-timing', min: -0.5, max: 0.5, step: 0.01, value: st.nudge, color: col, fmt: v => (v > 0 ? '+' : '') + Math.round(v * 100) + '% de paso', onInput: ch(v => { st.nudge = v; }) }),
      h('div', { class: 'lbl' }, 'Ratchet (repeticiones)'),
      chips([1, 2, 3, 4], st.rat, ch(v => { st.rat = +v; })),
      h('button', { class: 'menu-item', onclick: () => { undo.pattern('Borrar paso'); tp().steps[k] = null; closePopover(); renderPads(); app.emit('pattern-edit'); } }, '🗑 Borrar paso'),
    ]);
    pop.style.setProperty('--c', col);
  }

  // ---------- Cabecera ----------
  function renderHead() {
    head.innerHTML = '';
    const isSynth = s.selected === 8;
    head.style.setProperty('--c', isSynth ? SYNTH_COLOR : TRACK_COLORS[s.selected]);
    const lenObj = () => (isSynth ? app.pattern.synth : tp());
    const lenLbl = h('span', {}, lenObj().len, h('small', {}, ' pasos'));
    const setLen = d => { undo.pattern('Largo', 'len'); const o = lenObj(); o.len = Math.max(1, Math.min(MAX_STEPS, o.len + d)); lenLbl.firstChild.textContent = o.len; isSynth ? roll.draw() : renderPads(); };
    head.append(
      h('div', { class: 'gh-title' }, h('span', { class: 'gh-dot' }), trackName(s.selected)),
      h('div', { class: 'stepper' }, h('button', { onclick: () => setLen(-1) }, '−'), lenLbl, h('button', { onclick: () => setLen(1) }, '+')),
      h('button', { class: 'pill', onclick: () => { undo.pattern('Dados'); isSynth ? randomMelody() : randomTrack(); } }, '🎲 Dados'),
      h('button', { class: 'pill', onclick: () => {
        undo.pattern('Limpiar');
        if (isSynth) app.pattern.synth.notes = []; else tp().steps.fill(null);
        isSynth ? roll.draw() : renderPads(); app.emit('pattern-edit');
      } }, '🧽 Limpiar'),
    );
    if (!isSynth) head.append(h('button', { class: 'pill', onclick: () => openSampleEditor(s.selected) }, '✎ Onda'));
    if (isSynth) head.append(
      h('button', { class: 'pill', onclick: () => roll.scroll(12) }, '▲ oct'),
      h('button', { class: 'pill', onclick: () => roll.scroll(-12) }, '▼ oct'),
      h('span', { class: 'gh-hint' }, 'Tocá: nota · arrastrá: alargar/mover · tocá una nota: borrar'),
    );
    else head.append(h('span', { class: 'gh-hint' }, 'Tocá o arrastrá para pintar · mantené apretado para editar'));
  }

  function randomTrack() {
    const t = tp(), w = WEIGHTS[s.selected];
    for (let k = 0; k < MAX_STEPS; k++) {
      const pos = k % 4 === 0 ? 0 : k % 2 === 0 ? 1 : 2;
      let p = w[pos];
      if ((s.selected === 1 || s.selected === 2) && k % 8 === 4) p = 0.92;
      t.steps[k] = Math.random() < p ? mkStep(0.5 + Math.random() * 0.5) : null;
    }
    renderPads(); app.emit('pattern-edit');
  }

  function randomMelody() {
    // Melodía en la escala elegida (si es cromática, pentatónica menor sobre la tónica)
    const ps = app.pattern.synth, base = (s.synth.octave + 1) * 12;
    const chromatic = s.scale.type === 'chromatic';
    const penta = [0, 3, 5, 7, 10, 12, 15];
    ps.notes = [];
    let k = 0;
    while (k < ps.len) {
      const len = [1, 2, 2, 3, 4][Math.floor(Math.random() * 5)];
      const n = Math.floor(Math.random() * 7);
      const midi = chromatic ? base + s.scale.root + penta[n] : degree(base + 12, n);
      if (Math.random() < 0.75) ps.notes.push({ step: k, midi, len, vel: 0.6 + Math.random() * 0.4 });
      k += len;
    }
    roll.draw(); app.emit('pattern-edit');
  }

  function mount() {
    renderHead();
    wrap.innerHTML = '';
    if (s.selected === 8) { wrap.append(roll.canvas); roll.resize(); }
    else { pads.style.setProperty('--c', TRACK_COLORS[s.selected]); wrap.append(pads); renderPads(); }
  }

  app.on('select', mount);
  app.on('pattern', () => { mount(); });
  app.on('pattern-edit', () => { s.selected === 8 ? roll.draw() : renderPads(); });
  app.on('sound', () => renderHead());
  mount();

  return {
    setPlayhead(eff) {
      playStep = eff;
      if (s.selected === 8) { roll.setPlayhead(eff); return; }
      const t = tp();
      padEls.forEach((p, k) => p.classList.toggle('ph', eff >= 0 && k === eff % t.len));
    },
  };
}
