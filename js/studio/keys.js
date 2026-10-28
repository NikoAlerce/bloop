// Teclado del Estudio: toca (y graba) la pista MIDI elegida. Si es una batería, muestra los 16 pads.
// Se usa en la tira de abajo (🎹) y en el modo "Tocar" del instrumento.
// También responde al teclado de la compu (A W S E D F…) y a un controlador MIDI.
import { app } from '../app.js';
import { h } from '../ui/util.js';
import { noteName } from '../scales.js';
import { DRUM_NOTE, srcName } from './model.js';
import { studio } from './engine.js';

const QWERTY = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
const BLACK = [1, 3, 6, 8, 10];
let oct = 4; // octava compartida entre la tira y el instrumento
const surfaces = new Set();

// Superficie para tocar: teclas de piano (con glissando) o 16 pads. big = modo "Tocar" del instrumento
export function playSurface(t, { big = false } = {}) {
  const el = h('div', { class: 'play-surface' + (big ? ' big' : '') });
  const keyEls = new Map(), down = new Map();
  const drums = t.inst?.type === 'drums';
  function render() {
    el.innerHTML = ''; keyEls.clear();
    if (!drums) {
      const lbl = h('span', { class: 'ps-oct' }, 'C' + (oct - 1));
      el.append(h('div', { class: 'ps-head' },
        h('button', { class: 'ps-btn', onclick: () => { oct = Math.max(1, oct - 1); renderAll(); } }, '◀ Oct'), lbl,
        h('button', { class: 'ps-btn', onclick: () => { oct = Math.min(7, oct + 1); renderAll(); } }, 'Oct ▶'),
        h('span', { class: 'ps-hint' }, 'Deslizá para glissando · con el lápiz, la presión es la fuerza')));
      const kb = h('div', { class: 'stk-keys' });
      const n = big ? 37 : 25, base = oct * 12;
      const whites = [];
      for (let m = base; m < base + n; m++) if (!BLACK.includes(m % 12)) whites.push(m);
      const ww = 100 / whites.length;
      let wi = 0;
      for (let m = base; m < base + n; m++) {
        const black = BLACK.includes(m % 12);
        const key = h('div', { class: 'stk-key ' + (black ? 'b' : 'w') }, !black && m % 12 === 0 ? h('small', {}, noteName(m)) : null);
        if (black) { key.style.left = `calc(${wi * ww}% - ${ww * 0.3}%)`; key.style.width = ww * 0.6 + '%'; }
        else { key.style.left = wi * ww + '%'; key.style.width = ww + '%'; wi++; }
        key.dataset.m = m;
        keyEls.set(m, key);
        kb.append(key);
      }
      bind(kb);
      el.append(kb);
    } else {
      const pads = h('div', { class: 'stk-pads' + (big ? ' big' : '') });
      // como un controlador 4×4: el pad 1 abajo a la izquierda
      const order = big ? [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3] : [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
      for (const i of order) {
        const pd = t.inst.pads[i];
        const b = h('div', { class: 'stk-pad' + (pd ? '' : ' empty') }, h('small', {}, String(i + 1)), pd ? srcName(pd.src) : '');
        b.dataset.m = DRUM_NOTE + i;
        b.style.setProperty('--c', t.color);
        keyEls.set(DRUM_NOTE + i, b);
        pads.append(b);
      }
      bind(pads);
      el.append(pads);
    }
  }
  function bind(box) {
    box.addEventListener('pointerdown', e => {
      const k = e.target.closest('[data-m]'); if (!k) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      const m = +k.dataset.m, r = k.getBoundingClientRect();
      const vel = e.pointerType === 'pen' && e.pressure ? 0.25 + 0.75 * e.pressure
        : drums ? 0.45 + 0.55 * Math.min(1, (e.clientY - r.top) / r.height) : 0.8;
      down.set(e.pointerId, m);
      studio.noteOn(m, vel, e.timeStamp);
    });
    box.addEventListener('pointermove', e => {
      if (!down.has(e.pointerId) || drums) return;
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
  const s = { el, render, lit: (m, on) => keyEls.get(m)?.classList.toggle('down', on) };
  surfaces.add(s);
  render();
  return el;
}
function renderAll() { for (const s of [...surfaces]) { if (!s.el.isConnected) surfaces.delete(s); else s.render(); } }
app.on('studio-note', (m, on) => { for (const s of surfaces) s.lit(m, on); });

export function buildStudioKeys(el) {
  const qDown = new Map();
  function render() {
    el.innerHTML = '';
    for (const s of [...surfaces]) if (!s.el.isConnected) surfaces.delete(s);
    const t = studio.playTarget();
    if (!t) { el.append(h('div', { class: 'stk-head' }, h('span', { class: 'hint' }, 'Elegí una pista MIDI para tocarla'))); return; }
    el.append(h('div', { class: 'stk-head' }, h('b', {}, '🎹 ' + t.name)), playSurface(t));
  }
  return {
    render,
    isQwerty: () => !!studio.playTarget(),
    qwerty(e, isDown) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (isDown && e.code === 'KeyZ') { oct = Math.max(1, oct - 1); renderAll(); return true; }
      if (isDown && e.code === 'KeyX') { oct = Math.min(7, oct + 1); renderAll(); return true; }
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
