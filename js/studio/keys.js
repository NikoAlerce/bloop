// Teclado del Estudio: toca (y graba) la pista MIDI elegida. Si es una batería, muestra los 16 pads.
// También responde al teclado de la compu (A W S E D F…) y a un controlador MIDI.
import { app } from '../app.js';
import { h } from '../ui/util.js';
import { noteName } from '../scales.js';
import { S, DRUM_NOTE, srcName } from './model.js';
import { studio } from './engine.js';

const QWERTY = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const BLACK = [1, 3, 6, 8, 10];

export function buildStudioKeys(el) {
  const st = S();
  let oct = 4, keyEls = new Map(), kind = null;
  const down = new Map(); // pointerId -> midi
  const qDown = new Map();

  function render() {
    if (el.hidden && kind) return;
    const t = studio.playTarget();
    const k = !t ? 'none' : t.inst?.type === 'drums' ? 'drums' : 'keys';
    el.innerHTML = ''; keyEls = new Map(); kind = k;
    const head = h('div', { class: 'stk-head' });
    el.append(head);
    if (k === 'none') { head.append(h('span', { class: 'hint' }, 'Elegí una pista MIDI para tocarla')); return; }
    head.append(h('b', {}, '🎹 ' + t.name), h('div', { style: { flex: 1 } }));
    if (k === 'keys') {
      const lbl = h('span', { class: 'lbl' }, 'C' + (oct - 1));
      head.append(h('div', { class: 'stepper sm' },
        h('button', { onclick: () => { oct = Math.max(1, oct - 1); render(); } }, '−'), lbl,
        h('button', { onclick: () => { oct = Math.min(7, oct + 1); render(); } }, '＋')));
      const kb = h('div', { class: 'stk-keys' });
      const base = oct * 12, n = 25;
      let wi = 0;
      const whites = [];
      for (let m = base; m < base + n; m++) if (!BLACK.includes(m % 12)) whites.push(m);
      const ww = 100 / whites.length;
      for (let m = base; m < base + n; m++) {
        const black = BLACK.includes(m % 12);
        const key = h('div', { class: 'stk-key ' + (black ? 'b' : 'w') }, !black && m % 12 === 0 ? h('small', {}, noteName(m)) : null);
        if (black) { key.style.left = `calc(${wi * ww}% - ${ww * 0.3}%)`; key.style.width = ww * 0.6 + '%'; }
        else { key.style.left = wi * ww + '%'; key.style.width = ww + '%'; wi++; }
        key.dataset.m = m;
        keyEls.set(m, key);
        kb.append(key);
      }
      bindPlay(kb);
      el.append(kb);
    } else {
      const pads = h('div', { class: 'stk-pads' });
      for (let i = 0; i < 16; i++) {
        const pd = t.inst.pads[i];
        const b = h('div', { class: 'stk-pad' + (pd ? '' : ' empty') }, h('small', {}, String(i + 1)), pd ? srcName(pd.src) : '');
        b.dataset.m = DRUM_NOTE + i;
        b.style.setProperty('--c', t.color);
        keyEls.set(DRUM_NOTE + i, b);
        pads.append(b);
      }
      bindPlay(pads);
      el.append(pads);
    }
  }

  function bindPlay(box) {
    box.addEventListener('pointerdown', e => {
      const k = e.target.closest('[data-m]'); if (!k) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      const m = +k.dataset.m;
      const r = k.getBoundingClientRect();
      const vel = kind === 'drums' ? 0.45 + 0.55 * Math.min(1, (e.clientY - r.top) / r.height) : (e.pressure && e.pointerType === 'pen' ? 0.3 + 0.7 * e.pressure : 0.8);
      down.set(e.pointerId, m);
      studio.noteOn(m, vel, e.timeStamp);
    });
    // Glissando: arrastrar sobre las teclas
    box.addEventListener('pointermove', e => {
      if (!down.has(e.pointerId) || kind === 'drums') return;
      const k = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-m]');
      if (!k || !box.contains(k)) return;
      const m = +k.dataset.m, old = down.get(e.pointerId);
      if (m === old) return;
      studio.noteOff(old, e.timeStamp); down.set(e.pointerId, m); studio.noteOn(m, 0.8, e.timeStamp);
    });
    const up = e => { const m = down.get(e.pointerId); if (m == null) return; down.delete(e.pointerId); studio.noteOff(m, e.timeStamp); };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  }

  app.on('studio-note', (m, on) => keyEls.get(m)?.classList.toggle('down', on));

  return {
    render,
    isQwerty: () => !!studio.playTarget(),
    qwerty(e, isDown) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (isDown && e.code === 'KeyZ') { oct = Math.max(1, oct - 1); render(); return true; }
      if (isDown && e.code === 'KeyX') { oct = Math.min(7, oct + 1); render(); return true; }
      const k = QWERTY[e.code];
      if (k == null) return false;
      if (isDown) {
        if (qDown.has(e.code) || e.repeat) return true;
        const t = studio.playTarget(); if (!t) return false;
        const m = t.inst?.type === 'drums' ? DRUM_NOTE + (k % 16) : oct * 12 + k;
        qDown.set(e.code, m); studio.noteOn(m, 0.8, e.timeStamp);
      } else {
        const m = qDown.get(e.code); if (m == null) return false;
        qDown.delete(e.code); studio.noteOff(m, e.timeStamp);
      }
      return true;
    },
  };
}
