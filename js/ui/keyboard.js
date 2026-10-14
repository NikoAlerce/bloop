// Teclado: presets, arpegiador, destino (synth o sampler), piano o pads en escala.
import { app } from '../app.js';
import { openPresets, stepPreset, allPresets } from './presets.js';
import { ARP_MODES, ARP_RATES } from '../sequencer.js';
import { h, chips, toggle, popover } from './util.js';
import { noteOn, noteOff, setPreset, samplerTrack, trackName, presetLabel, presetById, varyPreset } from '../actions.js';
import { input } from '../input.js';
import { SCALES, NOTE_NAMES, scaleActive, inScale, degree, scaleLabel, noteName } from '../scales.js';

const QWERTY = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const QLABEL = { 0: 'A', 1: 'W', 2: 'S', 3: 'E', 4: 'D', 5: 'F', 6: 'T', 7: 'G', 8: 'Y', 9: 'H', 10: 'U', 11: 'J', 12: 'K', 13: 'O', 14: 'L', 15: 'P', 16: 'Ñ' };
const BLACK = [1, 3, 6, 8, 10];
const MODE_LBL = { up: '↑', down: '↓', updown: '↕', random: '?', order: '1·2·3' };

export function buildKeyboard() {
  const s = app.state, sy = s.synth;
  const el = h('div', { class: 'dock-body' });

  // Presets del synth: ◀ ▶ dentro de la categoría, botón al navegador completo, variar,
  // y atajos con los demás sonidos de la misma categoría
  const curBtn = h('button', { class: 'preset on cur-preset', title: 'Ver todos los sonidos', onclick: openPresets });
  const quick = h('div', { class: 'dock-row', style: { gap: '6px' } });
  const presetRow = h('div', { class: 'dock-row scroll' },
    h('button', { class: 'round', title: 'Anterior', onclick: () => stepPreset(-1) }, '◀'),
    h('button', { class: 'round', title: 'Siguiente', onclick: () => stepPreset(1) }, '▶'),
    curBtn,
    h('button', { class: 'preset', title: 'Variación aleatoria', onclick: () => varyPreset() }, '🎲'),
    h('div', { class: 'sep' }), quick);
  let quickCat = null;
  const markPreset = () => {
    curBtn.textContent = presetLabel() + '  ▾';
    const pr = presetById(sy.preset);
    const cat = typeof sy.preset === 'string' ? 'mine' : pr?.cat;
    const list = allPresets().filter(x => x.cat === cat);
    const sig = cat + ':' + list.map(x => x.key).join(',');
    if (sig !== quickCat) {
      quickCat = sig;
      quick.innerHTML = '';
      for (const p of list) {
        const b = h('button', { class: 'preset', 'data-k': String(p.key), onclick: () => setPreset(p.key) }, p.emoji + ' ' + p.name);
        quick.append(b);
      }
    }
    [...quick.children].forEach(b => b.classList.toggle('on', b.dataset.k === String(sy.preset)));
  };
  markPreset();
  app.on('preset', markPreset);

  // Destino, modo, escala, octava, arpegiador
  const targetChips = chips([['synth', '♫ Synth'], ['sample', '🥁 Sampler']], s.kbTarget, v => { s.kbTarget = v; releaseAll(); refreshTarget(); });
  const targetLbl = h('span', { class: 'lbl' });
  const modeChips = chips([['piano', '🎹'], ['pads', '▦']], s.kbMode, v => { s.kbMode = v; releaseAll(); build(); });
  const scaleBtn = h('button', { class: 'tog' });
  scaleBtn.addEventListener('click', () => openScale(scaleBtn));
  const octLbl = h('span', { class: 'lbl', style: { minWidth: '26px', textAlign: 'center' } });
  const setOct = d => { sy.octave = Math.max(0, Math.min(7, sy.octave + d)); releaseAll(); build(); };
  const arpTog = toggle('ARP', sy.arp.on, v => { sy.arp.on = v; app.seq.arpClear(); app.synth.allOff(); });
  arpTog.style.setProperty('--c', '#c792ff');
  const holdTog = toggle('Hold', sy.arp.hold, v => { sy.arp.hold = v; if (!v) app.seq.arpClear(); });
  holdTog.style.setProperty('--c', '#c792ff');
  const arpBox = h('div', { class: 'dock-row' }, arpTog,
    chips(ARP_MODES.map(m => [m, MODE_LBL[m]]), sy.arp.mode, v => { sy.arp.mode = v; }),
    chips(ARP_RATES, sy.arp.rate, v => { sy.arp.rate = v; }),
    chips([[1, '1 oct'], [2, '2'], [3, '3']], sy.arp.oct, v => { sy.arp.oct = +v; }),
    holdTog);
  const ctrlRow = h('div', { class: 'dock-row scroll' },
    targetChips, targetLbl, modeChips, scaleBtn,
    h('div', { class: 'stepper' }, h('button', { onclick: () => setOct(-1) }, '−'), octLbl, h('button', { onclick: () => setOct(1) }, '+')),
    h('div', { class: 'sep' }), arpBox);

  const keys = h('div', { class: 'keys' });
  el.append(presetRow, ctrlRow, keys);

  function refreshTarget() {
    const smp = s.kbTarget === 'sample';
    presetRow.style.display = smp ? 'none' : '';
    arpBox.style.display = smp ? 'none' : '';
    targetLbl.textContent = smp ? `pista ${samplerTrack() + 1} · ${trackName(samplerTrack())}` : '';
    scaleBtn.textContent = '🎼 ' + scaleLabel();
    scaleBtn.classList.toggle('on', scaleActive());
    build();
  }
  app.on('select', () => { if (s.kbTarget === 'sample') refreshTarget(); });
  app.on('sound', () => { if (s.kbTarget === 'sample') refreshTarget(); });

  function openScale(anchor) {
    popover(anchor, [
      h('h4', {}, 'Escala'),
      h('div', { class: 'lbl' }, 'Tónica'),
      h('div', { class: 'btn-row' }, chips(NOTE_NAMES.map((n, i) => [i, n]), s.scale.root, v => { s.scale.root = +v; refreshTarget(); app.emit('pattern-edit'); })),
      h('div', { class: 'lbl' }, 'Tipo'),
      h('div', { class: 'btn-row' }, ...Object.entries(SCALES).map(([k, sc]) => {
        const b = h('button', { class: 'sbtn' + (s.scale.type === k ? ' on' : '') }, sc.name);
        b.addEventListener('click', () => { s.scale.type = k; [...b.parentNode.children].forEach(x => x.classList.toggle('on', x === b)); refreshTarget(); app.emit('pattern-edit'); });
        return b;
      })),
      h('div', { class: 'hint' }, 'Con una escala elegida, las notas de afuera se apagan y se corrigen solas (también desde MIDI). En ▦ pads solo aparecen notas de la escala.'),
    ]);
  }

  let keyEls = new Map(); // midi -> elementos
  const lit = new Map();
  let lastW = 0, lastH = 0;
  function addKey(midi, k) { if (!keyEls.has(midi)) keyEls.set(midi, []); keyEls.get(midi).push(k); }
  function build() {
    const W = keys.clientWidth, H = keys.clientHeight;
    if (!W) return;
    lastW = W; lastH = H;
    keys.innerHTML = ''; keyEls = new Map();
    const base = (sy.octave + 1) * 12;
    octLbl.textContent = 'C' + sy.octave;
    keys.classList.toggle('pads-mode', s.kbMode === 'pads');
    if (s.kbMode === 'pads') {
      // 2 filas × 8: cada fila sube una octava, solo notas de la escala
      const rows = 2, cols = 8, L = scaleActive() ? SCALES[s.scale.type].iv.length : 12;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const midi = scaleActive() ? degree(base + 12, (rows - 1 - r) * L + c) : base + (rows - 1 - r) * 12 + c;
        const root = ((midi - s.scale.root) % 12 + 12) % 12 === 0;
        const k = h('div', { class: 'kpad' + (root ? ' root' : ''), 'data-m': midi, style: { left: (c / cols * 100) + '%', top: (r / rows * 100) + '%', width: `calc(${100 / cols}% - 6px)`, height: `calc(${100 / rows}% - 6px)` } }, h('small', {}, noteName(midi)));
        keys.append(k); addKey(midi, k);
      }
      return;
    }
    const nWhite = Math.max(10, Math.min(29, Math.round(W / 50)));
    const ww = W / nWhite;
    let wi = 0, midi = base;
    while (wi < nWhite) {
      const pc = midi % 12, off = midi - base;
      const lab = QLABEL[off] ? h('small', {}, QLABEL[off]) : (pc === 0 ? h('small', {}, 'C' + (Math.floor(midi / 12) - 1)) : null);
      const outCls = scaleActive() && !inScale(midi) ? ' off' : '';
      const rootCls = scaleActive() && pc === s.scale.root ? ' root' : '';
      if (BLACK.includes(pc)) {
        const k = h('div', { class: 'key b' + outCls + rootCls, 'data-m': midi, style: { left: (wi * ww - ww * 0.32) + 'px', width: (ww * 0.64) + 'px' } }, lab);
        keys.append(k); addKey(midi, k);
      } else {
        const k = h('div', { class: 'key w' + outCls + rootCls, 'data-m': midi, style: { left: (wi * ww) + 'px', width: (ww - 2) + 'px' } }, lab);
        keys.append(k); addKey(midi, k);
        wi++;
      }
      midi++;
    }
  }
  new ResizeObserver(() => { if (keys.clientWidth !== lastW || keys.clientHeight !== lastH) build(); }).observe(keys);
  const mark = (m, cls, on) => (keyEls.get(m) || []).forEach(k => k.classList.toggle(cls, on));

  // Multitouch + glissando
  const ptr = new Map();
  const keyAt = (x, y) => { const e = document.elementFromPoint(x, y); const k = e && e.closest('.key,.kpad'); return k && keys.contains(k) ? k : null; };
  const velOf = (k, y) => { const r = k.getBoundingClientRect(); return 0.35 + 0.65 * Math.min(1, Math.max(0, (y - r.top) / r.height)); };
  const press = (k, y) => { const m = +k.dataset.m; mark(m, 'down', true); noteOn(m, velOf(k, y)); return m; };
  const release = m => { mark(m, 'down', false); noteOff(m); };
  function releaseAll() { for (const m of ptr.values()) release(m); ptr.clear(); }

  keys.addEventListener('pointerdown', e => {
    e.preventDefault();
    const k = keyAt(e.clientX, e.clientY); if (!k) return;
    keys.setPointerCapture(e.pointerId);
    ptr.set(e.pointerId, press(k, e.clientY));
  });
  keys.addEventListener('pointermove', e => {
    if (!ptr.has(e.pointerId)) return;
    const k = keyAt(e.clientX, e.clientY);
    const cur = ptr.get(e.pointerId);
    if (!k || +k.dataset.m === cur) return;
    release(cur);
    ptr.set(e.pointerId, press(k, e.clientY));
  });
  const up = e => { if (ptr.has(e.pointerId)) { release(ptr.get(e.pointerId)); ptr.delete(e.pointerId); } };
  keys.addEventListener('pointerup', up);
  keys.addEventListener('pointercancel', up);
  keys.addEventListener('contextmenu', e => e.preventDefault());

  // Teclado de computadora (si la tecla no fue asignada a otra cosa)
  const qDown = new Map();
  input.onKey((e, down) => {
    if (e.code in QWERTY) {
      if (down) {
        if (qDown.has(e.code)) return true;
        const m = (sy.octave + 1) * 12 + QWERTY[e.code];
        qDown.set(e.code, m); mark(m, 'down', true); noteOn(m, 0.8);
      } else if (qDown.has(e.code)) {
        const m = qDown.get(e.code); qDown.delete(e.code); mark(m, 'down', false); noteOff(m);
      }
      return true;
    }
    if (down && e.code === 'KeyZ') { setOct(-1); return true; }
    if (down && e.code === 'KeyX') { setOct(1); return true; }
    return false;
  });
  window.addEventListener('blur', () => { for (const m of qDown.values()) noteOff(m); qDown.clear(); releaseAll(); });

  refreshTarget();
  return {
    el,
    refresh: build,
    markDown: mark,
    setLit(midi, on) {
      const n = Math.max(0, (lit.get(midi) || 0) + (on ? 1 : -1));
      lit.set(midi, n);
      mark(midi, 'lit', n > 0);
    },
    clearLit() { lit.clear(); keyEls.forEach(arr => arr.forEach(k => k.classList.remove('lit'))); },
  };
}
