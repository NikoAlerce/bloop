// Cuenta regresiva en pantalla (4 · 3 · 2 · 1) sincronizada con los clicks que se escuchan.
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { h } from './util.js';

export function buildCountIn() {
  const num = h('b');
  const lbl = h('small');
  const el = h('div', { class: 'countin', hidden: true }, num, lbl);
  document.body.append(el);
  let raf = 0;

  app.on('countin', ci => {
    cancelAnimationFrame(raf);
    const recLoop = () => app.loopers.some(l => l.state === 'armed');
    const loop = () => {
      const seq = app.seq;
      if (seq.countIn !== ci || !seq.playing) { el.hidden = true; return; }
      const heard = A.ctx.currentTime - A.outLat;
      if (heard >= ci.t0) { el.hidden = true; return; }
      if (heard >= ci.t) {
        const k = Math.floor((heard - ci.t) / ci.beat);         // pulso que suena ahora
        const left = ci.n - k;
        const txt = String(left > 4 ? ((left - 1) % 4) + 1 : left);
        if (num.textContent !== txt) {
          num.textContent = txt;
          el.classList.remove('beat'); void el.offsetWidth; el.classList.add('beat');
        }
        lbl.textContent = recLoop() ? 'grabando en…' : app.seq.recording ? 'grabando en…' : 'arranca en…';
        el.classList.toggle('rec', recLoop() || app.seq.recording);
        el.hidden = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  });
}

// Texto corto para la opción de cuenta regresiva
export const COUNT_OPTS = [[0, 'Sin cuenta'], [1, '1 compás'], [2, '2 compases']];
