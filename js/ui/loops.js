// 8 loopers circulares estilo Loopy (2 páginas de 4). Tocá para grabar / mutear,
// mantené apretado para abrir el editor de onda.
import { app } from '../app.js';
import { A, inputLevel, closeMic } from '../audio/engine.js';
import { LOOP_COLORS } from '../state.js';
import { h, popover, closePopover, chips, slider, fmtPct, ink, toggle } from './util.js';
import { input } from '../input.js';
import { openLoopEditor } from './waveeditor.js';

const SRC_ICON = { mic: '🎤', keys: '🎹', groove: '🥁' };
const SRC_NEXT = { mic: 'keys', keys: 'groove', groove: 'mic' };
const SRC_NAME = { mic: '🎤 Graba el micrófono', keys: '🎹 Graba solo lo que tocás', groove: '🥁 Graba todo lo que suena' };

export function buildLoops(el) {
  const s = app.state;
  const pageChips = chips([[0, 'A · 1–4'], [1, 'B · 5–8']], s.loopPage, v => { s.loopPage = +v; layout(); });
  const dots = h('div', { class: 'loop-dots' }, ...app.loopers.map(() => h('i')));
  const modeChips = chips([[0, '🧲 Al compás'], [1, '〰 Libre']], s.loopFree ? 1 : 0, v => { s.loopFree = !!+v; });
  modeChips.classList.add('no-learn');
  const meterFill = h('i');
  const meter = h('div', { class: 'in-meter', title: 'Micrófono abierto · tocá para cerrarlo' }, meterFill);
  meter.addEventListener('click', () => { if (A.micStream && !app.loopers.some(l => l.job && l.source === 'mic')) { closeMic(); app.emit('toast', '🎤 Micrófono cerrado'); } });
  el.append(
    h('div', { class: 'loops-head' }, h('span', { class: 'panel-title' }, 'Loops'), dots, h('div', { style: { flex: 1 } }), meter),
    h('div', { class: 'loops-head' }, pageChips, modeChips),
  );
  const grid = h('div', { class: 'loops' });
  el.append(grid);

  const items = app.loopers.map((lp, i) => {
    const col = LOOP_COLORS[i];
    const cv = h('canvas');
    const src = h('button', { title: 'Fuente: micrófono, lo que tocás o todo' });
    const od = h('button', { title: 'Overdub: otra capa encima' }, '＋');
    const edit = h('button', { title: 'Editar onda' }, '✎');
    const more = h('button', { title: 'Opciones' }, '•••');
    const wrap = h('div', { class: 'loop' }, cv, h('div', { class: 'loop-ctrls' }, src, od, edit, more));
    wrap.style.setProperty('--c', col);

    // Tocar = grabar/mutear; mantener apretado = editor
    let lpTimer = null, longDone = false;
    cv.addEventListener('pointerdown', e => {
      e.preventDefault();
      longDone = false;
      selectLoop(i);
      lpTimer = setTimeout(() => { longDone = true; if (lp.raw) openLoopEditor(lp); }, 500);
    });
    const release = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; if (!longDone) lp.tap(); } };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', () => { clearTimeout(lpTimer); lpTimer = null; });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    src.addEventListener('click', () => {
      if (lp.state !== 'empty') return;
      lp.source = SRC_NEXT[lp.source] || 'mic';
      update();
      app.emit('toast', SRC_NAME[lp.source]);
    });
    od.addEventListener('click', () => lp.overdub());
    edit.addEventListener('click', () => openLoopEditor(lp));
    more.addEventListener('click', () => {
      popover(more, [
        h('h4', {}, `Loop ${i + 1}`),
        h('div', { class: 'lbl' }, 'Largo al compás'),
        chips([1, 2, 4, 8], lp.bars, v => { lp.bars = +v; }),
        h('div', { class: 'lbl' }, 'Fuente'),
        chips([['mic', '🎤 Micrófono'], ['keys', '🎹 Solo lo que toco'], ['groove', '🥁 Todo']], lp.source, v => { lp.source = v; update(); }),
        h('div', { class: 'hint' }, '🎹 graba solo lo que tocás en vivo (teclado, MIDI y pads), sin la base. 🥁 graba todo lo que suena.'),
        slider({ label: 'Volumen', value: lp.volume, color: col, fmt: fmtPct, onInput: v => { lp.setVolume(v); app.emit('loop-saved', i); } }),
        toggle('🎬 Las escenas manejan los loops', s.loopScenes !== false, v => { s.loopScenes = v; app.emit('toast', v ? 'Cada escena recuerda qué loops suenan' : 'Cambiar de escena ya no toca los loops'); }),
        h('div', { class: 'hint' }, 'Un loop nuevo suena solo en la escena donde lo grabaste. Para sumarlo a otra escena, andá a esa escena y tocalo.'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); openLoopEditor(lp); } }, '✎ Editar onda'),
        h('button', { class: 'menu-item', onclick: () => { lp.clear(); closePopover(); } }, '🗑 Borrar loop (se puede deshacer)'),
      ]).style.setProperty('--c', col);
    });
    input.target('loop:' + i, { label: `Loop ${i + 1}`, kind: 'button', el: cv, press: () => { selectLoop(i); lp.tap(); } });

    function update() {
      // Botones según el estado: vacío → fuente; con audio → overdub y editor
      src.textContent = SRC_ICON[lp.source] || '🎤';
      src.hidden = !!lp.raw;
      od.hidden = !lp.raw; edit.hidden = !lp.raw;
      src.disabled = lp.state !== 'empty';
      od.disabled = lp.overdubbing;
      od.classList.toggle('on', lp.overdubbing);
      wrap.classList.toggle('sel', s.selLoop === i);
      const d = dots.children[i];
      d.className = lp.state + (s.selLoop === i ? ' sel' : '');
      d.style.setProperty('--c', col);
    }
    return { lp, cv, col, wrap, update, ctx: cv.getContext('2d') };
  });

  function selectLoop(i) {
    s.selLoop = i;
    if (Math.floor(i / 4) !== s.loopPage) { s.loopPage = Math.floor(i / 4); pageChips.set(s.loopPage); layout(); }
    items.forEach(it => it.update());
  }
  function layout() {
    grid.innerHTML = '';
    items.slice(s.loopPage * 4, s.loopPage * 4 + 4).forEach(it => grid.append(it.wrap));
    items.forEach(it => it.update());
  }
  layout();
  app.on('loops', () => items.forEach(it => it.update()));
  app.on('loop-select', selectLoop);

  return function draw(time) {
    const lvl = inputLevel();
    meter.classList.toggle('on', !!A.micStream);
    meterFill.style.width = Math.min(100, Math.sqrt(lvl) * 100) + '%';
    meterFill.classList.toggle('clip', lvl > 0.97);
    const now = A.ctx.currentTime;
    for (const it of items.slice(s.loopPage * 4, s.loopPage * 4 + 4)) {
      const { lp, cv, ctx: g, col } = it;
      const r0 = cv.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      if (cv.width !== Math.round(r0.width * dpr) || cv.height !== Math.round(r0.height * dpr)) {
        cv.width = Math.round(r0.width * dpr); cv.height = Math.round(r0.height * dpr);
      }
      const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6 * dpr;
      g.clearRect(0, 0, W, H);
      if (R <= 0) continue;
      g.lineCap = 'round';
      const ring = (frac, color, width, start = -Math.PI / 2) => {
        g.strokeStyle = color; g.lineWidth = width;
        g.beginPath(); g.arc(cx, cy, R - width / 2, start, start + frac * Math.PI * 2); g.stroke();
      };
      const text = (t, size, color = ink(1), dy = 0) => {
        g.fillStyle = color; g.font = `800 ${size}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, cx, cy + dy);
      };
      let st = lp.state;
      if (st === 'armed' && now >= lp.recStart) st = 'recording';

      if (s.selLoop === lp.i) { g.strokeStyle = ink(0.5); g.lineWidth = 1.5 * dpr; g.beginPath(); g.arc(cx, cy, R + 4 * dpr, 0, Math.PI * 2); g.stroke(); }

      if (st === 'empty') {
        g.setLineDash([6 * dpr, 7 * dpr]);
        ring(1, ink(0.22), 3 * dpr);
        g.setLineDash([]);
        text('+', R * 0.5, ink(0.4), -R * 0.08);
        text(s.loopFree ? 'libre' : `${lp.bars} comp.`, Math.max(9 * dpr, R * 0.14), ink(0.4), R * 0.38);
      } else if (st === 'armed') {
        const left = lp.recStart - now, beats = Math.ceil(left / (app.seq.stepDur * 4));
        ring(1, Math.floor(time * 4) % 2 ? col : ink(0.15), 4 * dpr);
        text(Math.max(1, beats), R * 0.55);
      } else if (st === 'recording') {
        ring(1, 'rgba(255,84,112,0.18)', 6 * dpr);
        if (lp.free) {
          ring((now - lp.recStart) % 1, '#ff5470', 6 * dpr);
          text((now - lp.recStart).toFixed(1) + 's', R * 0.3);
          text('tocá para cerrar', Math.max(8 * dpr, R * 0.12), ink(0.6), R * 0.35);
        } else {
          ring(Math.min(1, (now - lp.recStart) / lp.recLen), '#ff5470', 6 * dpr);
          g.fillStyle = '#ff5470';
          g.beginPath(); g.arc(cx, cy, R * 0.22 * (1 + 0.1 * Math.sin(time * 10)), 0, Math.PI * 2); g.fill();
        }
      } else {
        const muted = st === 'muted';
        const pk = lp.peaks, n = pk ? pk.length : 0, inner = R * 0.42;
        g.strokeStyle = muted ? ink(0.2) : col;
        g.lineWidth = Math.max(1.5 * dpr, (2 * Math.PI * inner / Math.max(1, n)) * 0.7);
        for (let k = 0; k < n; k++) {
          const a = -Math.PI / 2 + k / n * Math.PI * 2;
          const len = (R - inner - 6 * dpr) * (0.08 + 0.92 * pk[k]);
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
          g.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
          g.stroke();
        }
        const ph = lp.phase();
        if (ph != null) {
          const a = -Math.PI / 2 + ph * Math.PI * 2;
          g.strokeStyle = muted ? ink(0.4) : ink(1); g.lineWidth = 3 * dpr;
          g.beginPath(); g.moveTo(cx + Math.cos(a) * inner * 0.6, cy + Math.sin(a) * inner * 0.6);
          g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
        }
        g.fillStyle = muted ? ink(0.08) : col;
        g.globalAlpha = muted ? 1 : 0.25;
        g.beginPath(); g.arc(cx, cy, inner * 0.75, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
        if (lp.overdubbing) ring(1, now >= lp.odStart ? '#ff5470' : 'rgba(255,84,112,0.4)', 4 * dpr);
        if (muted) text('MUTE', Math.max(9 * dpr, R * 0.14), ink(0.6));
      }
    }
  };
}
