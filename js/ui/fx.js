// Pestaña FX: pad XY de performance, beat repeat y ajustes de delay/reverb.
import { app } from '../app.js';
import { A, setPerf, setDelay, DELAY_DIVS } from '../audio/engine.js';
import { h, chips, toggle, ink } from './util.js';
import { knob } from './knob.js';
import { input } from '../input.js';

export function buildFx() {
  const s = app.state;
  const el = h('div', { class: 'dock-body' });
  const cv = h('canvas');
  const xy = h('div', { class: 'xy' }, cv,
    h('span', { class: 'xy-lbl', style: { left: '12px', bottom: '8px' } }, '◀ grave'),
    h('span', { class: 'xy-lbl', style: { right: '12px', bottom: '8px' } }, 'agudo ▶'),
    h('span', { class: 'xy-lbl', style: { left: '12px', top: '8px' } }, '▲ reso + eco'));

  // Estado del XY
  let pos = { x: 0.5, y: 0 }, target = null, locked = false;
  const trail = [];
  const setFrom = e => {
    const r = xy.getBoundingClientRect();
    pos = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
    setPerf(pos.x, pos.y);
  };
  xy.addEventListener('pointerdown', e => { xy.setPointerCapture(e.pointerId); target = null; setFrom(e); });
  xy.addEventListener('pointermove', e => { if (xy.hasPointerCapture(e.pointerId)) setFrom(e); });
  const up = () => { if (!locked) target = { x: 0.5, y: 0 }; };
  xy.addEventListener('pointerup', up);
  xy.addEventListener('pointercancel', up);
  const lockBtn = toggle('📌 Fijar', false, v => { locked = v; if (!v) target = { x: 0.5, y: 0 }; });
  // Ejes del XY asignables a perillas/joysticks físicos
  input.target('xy:x', { label: 'XY · filtro', kind: 'value', get: () => pos.x, set: v => { target = null; pos = { ...pos, x: v }; setPerf(pos.x, pos.y); } });
  input.target('xy:y', { label: 'XY · reso + eco', kind: 'value', get: () => pos.y, set: v => { target = null; pos = { ...pos, y: v }; setPerf(pos.x, pos.y); } });
  xy.dataset.learn = 'xy:x';

  // Beat repeat (mantener apretado)
  const stut = h('div', { class: 'stut' });
  [['1/2', 8], ['1/4', 4], ['1/8', 2], ['1/16', 1]].forEach(([lbl, size]) => {
    const b = h('button', {}, lbl);
    const on = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on'); app.seq.setStutter(size); };
    const off = () => { if (!b.classList.contains('on')) return; b.classList.remove('on'); app.seq.setStutter(null); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    input.target('stut:' + size, {
      label: 'Repetir ' + lbl, kind: 'button', el: b,
      press: () => { b.classList.add('on'); app.seq.setStutter(size); },
      release: () => { b.classList.remove('on'); app.seq.setStutter(null); },
    });
    stut.append(b);
  });

  const fbKnob = knob({ label: 'Eco', value: s.delayFb, max: 0.85, def: 0.42, color: '#48dbb4', size: 46, learn: 'p:delayFb', onInput: v => { s.delayFb = v; setDelay(s.bpm, s.delayDiv, v); } });
  const revKnob = knob({ label: 'Reverb', value: s.revLevel, def: 0.8, color: '#a29bfe', size: 46, learn: 'p:revLevel', onInput: v => { s.revLevel = v; A.reverbReturn.gain.setTargetAtTime(v, A.ctx.currentTime, 0.03); A.liveRevRet?.gain.setTargetAtTime(v, A.ctx.currentTime, 0.03); } });

  el.append(h('div', { class: 'fx-wrap' }, xy, h('div', { class: 'fx-side' },
    h('div', { class: 'dock-row' }, h('span', { class: 'lbl' }, 'Repetir (mantener)'), h('div', { style: { flex: 1 } }), lockBtn),
    stut,
    h('div', { class: 'lbl' }, 'Tiempo del delay'),
    chips(DELAY_DIVS, s.delayDiv, v => { s.delayDiv = v; setDelay(s.bpm, v, s.delayFb); }),
    h('div', { class: 'dock-row' }, fbKnob.el, revKnob.el),
  )));

  input.target('p:delayFb', { label: 'Eco del delay', kind: 'value', get: () => s.delayFb / 0.85, set: v => { s.delayFb = v * 0.85; fbKnob.set(s.delayFb); setDelay(s.bpm, s.delayDiv, s.delayFb); } });
  input.target('p:revLevel', { label: 'Nivel de reverb', kind: 'value', get: () => s.revLevel, set: v => { s.revLevel = v; revKnob.set(v); A.reverbReturn.gain.setTargetAtTime(v, A.ctx.currentTime, 0.03); A.liveRevRet?.gain.setTargetAtTime(v, A.ctx.currentTime, 0.03); } });

  const g = cv.getContext('2d');
  return {
    el,
    frame() {
      if (target) {
        pos.x += (target.x - pos.x) * 0.18; pos.y += (target.y - pos.y) * 0.18;
        setPerf(pos.x, pos.y);
        if (Math.abs(pos.x - target.x) < 0.003 && pos.y < 0.003) { pos = { ...target }; setPerf(pos.x, pos.y); target = null; }
      }
      const r = xy.getBoundingClientRect();
      if (!r.width) return;
      const dpr = devicePixelRatio || 1;
      if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
      const W = cv.width, H = cv.height;
      g.fillStyle = 'rgba(21,18,27,0.25)'; g.fillRect(0, 0, W, H);
      g.strokeStyle = ink(0.06); g.lineWidth = 1;
      for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(W * k / 4, 0); g.lineTo(W * k / 4, H); g.moveTo(0, H * k / 4); g.lineTo(W, H * k / 4); g.stroke(); }
      const m = 12 * dpr, x = m + pos.x * (W - 2 * m), y = m + (1 - pos.y) * (H - 2 * m);
      trail.push({ x, y }); if (trail.length > 24) trail.shift();
      trail.forEach((p, k) => {
        const a = k / trail.length;
        const grd = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 30 * dpr * a + 4);
        grd.addColorStop(0, `rgba(255,142,212,${0.5 * a})`); grd.addColorStop(1, 'rgba(199,146,255,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(p.x, p.y, 30 * dpr * a + 4, 0, Math.PI * 2); g.fill();
      });
      g.fillStyle = ink(1); g.beginPath(); g.arc(x, y, 9 * dpr, 0, Math.PI * 2); g.fill();
    },
  };
}
