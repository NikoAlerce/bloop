// Editor de forma de onda a pantalla casi completa, para loops y samples.
// Marcadores de inicio/fin arrastrables, zoom con dos dedos (o rueda), fades,
// ajuste al compás (loops) y slices por transientes (samples).
// En los loops además se puede seleccionar un pedazo y cortarlo, copiarlo, pegarlo,
// duplicarlo, silenciarlo o darlo vuelta (collage).
import { app } from '../app.js';
import { A, detectTransients, normalizeBuffer } from '../audio/engine.js';
import { copyRange, deleteRange, insertAt, overwriteAt, silenceRange, reverseRange, afterDelete, afterInsert } from '../audio/edit.js';
import { stretchBuffer } from '../audio/stretch.js';
import { TRACK_COLORS, LOOP_COLORS, mkStep } from '../state.js';
import { h, slider, toggle, toast, ink, shade, chips, popover, closePopover } from './util.js';
import { undo } from '../undo.js';
import { audition, normalizeTrack, undoTrack, soundName, trackName, setCustomSample } from '../actions.js';

const HANDLE = 30; // px de tolerancia para agarrar un marcador
const TOP = 52;    // px: franja de arriba donde están las manijas de inicio/fin (I / F)

function editor({ title, color, buffer, region, setRegion, commit, fades, snapGrid, gridOrigin, playhead, extra, slices, select, toolbar }) {
  let buf = buffer();
  const sheet = h('div', { class: 'sheet' });
  const base = h('canvas', { class: 'we-base' }), over = h('canvas', { class: 'we-over' });
  const area = h('div', { class: 'we-area' }, base, over);
  const info = h('span', { class: 'we-info' });
  const close = () => { sheet.remove(); cancelAnimationFrame(raf); app.off('loops', onLoops); app.off('undo-change', onLoops); };
  const onLoops = () => { if (buffer()) refresh(); else close(); };
  app.on('loops', onLoops);
  app.on('undo-change', onLoops);
  const toolRow = toolbar ? h('div', { class: 'we-tools' }) : null;
  sheet.append(
    h('div', { class: 'sheet-card' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'gh-dot', style: { background: color } }), h('b', {}, title), info,
        h('div', { style: { flex: 1 } }),
        h('button', { class: 'pill', title: 'Deshacer', onclick: () => { undo.undo(); refresh(); } }, '↶'),
        h('button', { class: 'pill', title: 'Rehacer', onclick: () => { undo.redo(); refresh(); } }, '↷'),
        h('button', { class: 'pill', onclick: () => { view = [0, 1]; drawBase(); } }, '⤢ Ver todo'),
        h('button', { class: 'round', onclick: close }, '✕')),
      ...(toolRow ? [toolRow] : []),
      area,
      h('div', { class: 'we-ctrls' }, ...extra.map(x => (typeof x === 'function' ? x() : x))),
    ),
  );
  sheet.addEventListener('pointerdown', e => { if (e.target === sheet) close(); });
  document.body.append(sheet);
  sheet.style.setProperty('--c', color);

  let view = [0, 1];          // fracción visible del buffer
  let snap = !!snapGrid;
  let selSlice = -1;
  let sel = null;             // selección [a, b] en fracciones del buffer
  let cursor = null;          // punto para pegar (fracción)
  let tool = 'sel';           // 'sel' = el dedo selecciona · 'pan' = el dedo mueve la vista
  const ptrs = new Map();
  let drag = null, pinch = null, lastTap = 0;

  // Picos por bloques para dibujar rápido aunque el audio sea largo
  const BLOCK = 256;
  let blocks = null;
  function buildBlocks() {
    buf = buffer();
    const d = buf.getChannelData(0), n = Math.ceil(d.length / BLOCK);
    blocks = new Float32Array(n * 2);
    for (let b = 0; b < n; b++) {
      let mn = 1, mx = -1;
      for (let i = b * BLOCK; i < Math.min(d.length, (b + 1) * BLOCK); i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      blocks[b * 2] = mn; blocks[b * 2 + 1] = mx;
    }
  }
  buildBlocks();

  const W = () => base.width, H = () => base.height;
  const dpr = () => devicePixelRatio || 1;
  // Margen a los costados para que las manijas de inicio/fin se puedan agarrar en los bordes
  const PAD = () => 26 * dpr();
  const IW = () => W() - 2 * PAD();
  const fx = f => PAD() + (f - view[0]) / (view[1] - view[0]) * IW();      // fracción → px (canvas)
  const xf = px => view[0] + ((px - PAD()) / IW()) * (view[1] - view[0]);  // px (canvas) → fracción
  const evX = e => (e.clientX - base.getBoundingClientRect().left) * dpr();
  const evY = e => (e.clientY - base.getBoundingClientRect().top) * dpr();
  const clamp01 = f => Math.max(0, Math.min(1, f));

  function resize() {
    const r = area.getBoundingClientRect();
    for (const c of [base, over]) { c.width = r.width * dpr(); c.height = r.height * dpr(); }
    drawBase();
  }

  // Grilla de tiempos (loops): arranca en el inicio de la región
  const gridF = () => snapGrid() / buf.duration;
  const originF = () => (gridOrigin ? gridOrigin() : 0) / buf.duration;
  function snapF(f) {
    if (!snap || !snapGrid) return f;
    const g = gridF(), o = originF();
    return o + Math.round((f - o) / g) * g;
  }

  function drawBase() {
    const g = base.getContext('2d'), w = W(), hh = H(), mid = hh / 2;
    if (!w) return;
    g.clearRect(0, 0, w, hh);
    const d = buf.getChannelData(0), N = d.length;
    const [ra, rb] = region();
    // Grilla de tiempos
    if (snapGrid) {
      const gs = gridF(), o = originF();
      const first = Math.ceil((view[0] - o) / gs);
      for (let k = first; o + k * gs <= view[1]; k++) {
        g.fillStyle = k % 4 === 0 ? ink(0.2) : ink(0.07);
        g.fillRect(fx(o + k * gs), 0, k % 4 === 0 ? 2 : 1, hh);
      }
    }
    // Selección
    if (sel) {
      const x0 = fx(sel[0]), x1 = fx(sel[1]);
      g.fillStyle = 'rgba(254, 203, 87, 0.2)';
      g.fillRect(x0, 0, x1 - x0, hh);
    }
    // Onda
    const spp = (view[1] - view[0]) * N / IW();
    g.fillStyle = color;
    for (let x = Math.floor(PAD()); x < w - PAD(); x++) {
      const a = Math.floor(xf(x) * N), b = Math.max(a + 1, Math.floor(xf(x + 1) * N));
      let mn = 0, mx = 0;
      if (spp > BLOCK * 2) {
        for (let k = Math.floor(a / BLOCK); k < Math.min(blocks.length / 2, Math.ceil(b / BLOCK)); k++) { mn = Math.min(mn, blocks[k * 2]); mx = Math.max(mx, blocks[k * 2 + 1]); }
      } else {
        for (let i = Math.max(0, a); i < Math.min(N, b); i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      g.fillRect(x, mid - mx * mid * 0.92, 1, Math.max(1, (mx - mn) * mid * 0.92));
    }
    // Fuera de la región: oscurecido
    g.fillStyle = shade(0.7);
    g.fillRect(0, 0, Math.max(0, fx(ra)), hh);
    g.fillRect(fx(rb), 0, w, hh);
    // Fades
    if (fades) {
      const [fi, fo] = fades.get();
      g.strokeStyle = ink(0.8); g.lineWidth = 2 * dpr();
      g.beginPath(); g.moveTo(fx(ra), hh); g.lineTo(fx(ra + fi / buf.duration), 4 * dpr()); g.stroke();
      g.beginPath(); g.moveTo(fx(rb - fo / buf.duration), 4 * dpr()); g.lineTo(fx(rb), hh); g.stroke();
    }
    const tab = (x, w2, y, hgt, r) => { g.beginPath(); g.roundRect ? g.roundRect(x - w2 / 2, y, w2, hgt, r) : g.rect(x - w2 / 2, y, w2, hgt); g.fill(); };
    // Slices
    if (slices) {
      slices.get().forEach((s, k) => {
        const x = fx(s);
        g.fillStyle = k === selSlice ? ink(1) : ink(0.55);
        g.fillRect(x - dpr(), 0, 2 * dpr(), hh);
        tab(x, 28 * dpr(), hh - 30 * dpr(), 26 * dpr(), 8 * dpr());
        g.fillStyle = shade(1); g.font = `800 ${12 * dpr()}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(k + 1, x, hh - 17 * dpr());
      });
    }
    // Bordes de la selección con manijas abajo (para ajustarla)
    if (sel) {
      for (const f of sel) {
        const x = fx(f);
        g.fillStyle = '#fecb57';
        g.fillRect(x - dpr(), 0, 2 * dpr(), hh);
        tab(x, 28 * dpr(), hh - 36 * dpr(), 32 * dpr(), 10 * dpr());
        g.fillStyle = '#15121b'; g.font = `800 ${14 * dpr()}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('↔', x, hh - 20 * dpr());
      }
    }
    // Cursor (donde se pega)
    if (cursor != null && !sel) {
      const x = fx(cursor);
      g.fillStyle = '#fecb57';
      for (let y = 0; y < hh; y += 10 * dpr()) g.fillRect(x - dpr(), y, 2 * dpr(), 6 * dpr());
      g.beginPath(); g.moveTo(x - 10 * dpr(), hh); g.lineTo(x + 10 * dpr(), hh); g.lineTo(x, hh - 14 * dpr()); g.fill();
    }
    // Marcadores de inicio y fin con manijas grandes
    for (const [f, lbl] of [[ra, 'I'], [rb, 'F']]) {
      const x = fx(f);
      g.fillStyle = ink(1);
      g.fillRect(x - 1.5 * dpr(), 0, 3 * dpr(), hh);
      g.beginPath(); g.arc(x, 22 * dpr(), 18 * dpr(), 0, Math.PI * 2); g.fill();
      g.fillStyle = shade(1); g.font = `800 ${14 * dpr()}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(lbl, x, 22 * dpr());
    }
    const len = (rb - ra) * buf.duration;
    let txt = `${len.toFixed(2)} s` + (snapGrid ? ` · ${(len / snapGrid()).toFixed(2)} tiempos` : '');
    if (sel) txt += ` · selección ${((sel[1] - sel[0]) * buf.duration).toFixed(2)} s` + (snapGrid ? ` (${((sel[1] - sel[0]) * buf.duration / snapGrid()).toFixed(2)} t)` : '');
    if (view[1] - view[0] < 0.999) txt += ` · zoom ×${(1 / (view[1] - view[0])).toFixed(1)}`;
    info.textContent = txt;
    if (select) select.onChange?.();
  }

  let raf = 0;
  function drawOver() {
    const g = over.getContext('2d');
    g.clearRect(0, 0, over.width, over.height);
    const ph = playhead && playhead();
    if (ph != null && ph >= view[0] && ph <= view[1]) {
      g.fillStyle = ink(0.9);
      g.fillRect(fx(ph) - dpr(), 0, 2 * dpr(), over.height);
    }
    raf = requestAnimationFrame(drawOver);
  }

  // ---------- Gestos ----------
  // Un dedo: marcadores I/F (arriba), bordes de la selección, o seleccionar arrastrando.
  // Tocar sin arrastrar pone el cursor de pegado. Dos dedos: zoom y desplazamiento.
  over.addEventListener('pointerdown', e => {
    over.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      // Si recién empezaba una selección con el primer dedo, se descarta
      if (drag && drag.kind === 'sel') { sel = drag.prevSel; cursor = drag.prevCursor; }
      if (drag && (drag.kind === 'start' || drag.kind === 'end')) commit.end();
      drag = null;
      const [p1, p2] = [...ptrs.values()];
      const left = base.getBoundingClientRect().left;
      pinch = { d: Math.abs(p1.x - p2.x) || 1, c: xf(((p1.x + p2.x) / 2 - left) * dpr()), v: [...view] };
      drawBase();
      return;
    }
    if (ptrs.size > 2) return;
    const x = evX(e), y = evY(e);
    const [ra, rb] = region();
    const near = f => Math.abs(fx(f) - x) < HANDLE * dpr();
    if (slices && y > H() - 40 * dpr()) {
      const k = slices.get().findIndex(s => near(s));
      if (k >= 0) { selSlice = k; drag = { kind: 'slice', k }; slices.begin(); drawBase(); return; }
    }
    // Con selección habilitada, los marcadores I/F se agarran solo desde arriba
    const topZone = !select || y < TOP * dpr();
    if (topZone && near(ra) && (!near(rb) || Math.abs(fx(ra) - x) <= Math.abs(fx(rb) - x))) { drag = { kind: 'start' }; commit.begin(); return; }
    if (topZone && near(rb)) { drag = { kind: 'end' }; commit.begin(); return; }
    if (select && sel && y >= TOP * dpr()) {
      const d0 = Math.abs(fx(sel[0]) - x), d1 = Math.abs(fx(sel[1]) - x);
      if (Math.min(d0, d1) < HANDLE * dpr()) { drag = { kind: 'seledge', k: d0 <= d1 ? 0 : 1 }; return; }
    }
    const now = performance.now();
    if (slices && now - lastTap < 320) { slices.add(snapF(xf(x))); selSlice = -1; drawBase(); lastTap = 0; return; }
    lastTap = now;
    if (select && tool === 'sel') { drag = { kind: 'sel', x, f: clamp01(xf(x)), moved: false, prevSel: sel, prevCursor: cursor }; return; }
    drag = { kind: 'pan', x, v: [...view] };
  });
  over.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [p1, p2] = [...ptrs.values()];
      const z = Math.max(0.0005, Math.min(1, (pinch.v[1] - pinch.v[0]) * pinch.d / (Math.abs(p1.x - p2.x) || 1)));
      // El punto que estaba entre los dos dedos sigue bajo los dedos (zoom y arrastre a la vez)
      const cx = ((p1.x + p2.x) / 2 - base.getBoundingClientRect().left) * dpr();
      setView(pinch.c - (cx - PAD()) / IW() * z, z);
      return;
    }
    if (!drag) return;
    const x = evX(e), f = clamp01(snapF(xf(x)));
    const [ra, rb] = region();
    const minLen = 0.01 / buf.duration;
    if (drag.kind === 'start') setRegion(Math.min(f, rb - minLen), rb);
    else if (drag.kind === 'end') setRegion(ra, Math.max(f, ra + minLen));
    else if (drag.kind === 'slice') slices.move(drag.k, f);
    else if (drag.kind === 'seledge') {
      sel[drag.k] = f;
      if (sel[0] > sel[1]) { sel.reverse(); drag.k = 1 - drag.k; }
    } else if (drag.kind === 'sel') {
      if (!drag.moved && Math.abs(x - drag.x) < 8 * dpr()) return;
      drag.moved = true;
      const a = clamp01(snapF(drag.f));
      sel = a <= f ? [a, f] : [f, a];
      cursor = null;
    } else if (drag.kind === 'pan') {
      const span = drag.v[1] - drag.v[0];
      setView(drag.v[0] - (x - drag.x) / IW() * span, span);
      return;
    }
    drawBase();
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (drag && (drag.kind === 'start' || drag.kind === 'end')) commit.end();
    if (drag && drag.kind === 'slice') slices.end();
    if (drag && drag.kind === 'sel' && !drag.moved && e.type === 'pointerup') {
      // Toque: cursor de pegado (y se suelta la selección)
      sel = null; cursor = clamp01(snapF(drag.f));
    }
    if (sel && sel[1] - sel[0] < 0.002 / buf.duration) sel = null;
    drag = null;
    drawBase();
  };
  over.addEventListener('pointerup', up);
  over.addEventListener('pointercancel', up);
  over.addEventListener('wheel', e => {
    e.preventDefault();
    const c = xf(evX(e)), span = view[1] - view[0];
    const z = Math.max(0.0005, Math.min(1, span * (e.deltaY > 0 ? 1.25 : 0.8)));
    setView(c - (c - view[0]) / span * z, z);
  }, { passive: false });

  function setView(a, span) {
    a = Math.max(0, Math.min(1 - span, a));
    view = [a, a + span];
    drawBase();
  }
  function refresh() {
    const old = buf.duration;
    buildBlocks();
    // Si cambió el largo, la vista, la selección y el cursor siguen en el mismo lugar (en segundos)
    if (Math.abs(buf.duration - old) > 1e-6) {
      const k = old / buf.duration;
      const full = view[1] - view[0] > 0.999; // si se veía todo, se sigue viendo todo
      const span = full ? 1 : Math.min(1, (view[1] - view[0]) * k);
      if (sel) sel = sel.map(f => clamp01(f * k));
      if (cursor != null) cursor = clamp01(cursor * k);
      setView(full ? 0 : view[0] * k, span);
      return;
    }
    drawBase();
  }

  new ResizeObserver(resize).observe(area);
  requestAnimationFrame(() => { resize(); drawOver(); });
  const api = {
    refresh, redraw: drawBase, close,
    setSnap(v) { snap = v; },
    setTool(t) { tool = t; },
    get selSlice() { return selSlice; }, set selSlice(v) { selSlice = v; },
    // Selección y cursor en segundos
    selection: () => (sel ? [sel[0] * buf.duration, sel[1] * buf.duration] : null),
    cursorAt: () => (cursor == null ? null : cursor * buf.duration),
    setSelection(a, b) { buf = buffer(); sel = a == null ? null : [clamp01(a / buf.duration), clamp01(b / buf.duration)]; if (sel) cursor = null; drawBase(); },
    setCursor(t) { buf = buffer(); cursor = t == null ? null : clamp01(t / buf.duration); if (t != null) sel = null; drawBase(); },
  };
  if (toolbar) toolbar(api).forEach(x => toolRow.append(x));
  return api;
}

// ---------- Loops ----------
// Portapapeles compartido entre loops (copiar en el loop 1 y pegar en el 3)
let clip = null; // { buf, bpm }

export function openLoopEditor(lp) {
  if (!lp.raw) return;
  const col = LOOP_COLORS[lp.i];
  let before = null;
  const begin = () => { before = lp.snapshot(); };
  const end = () => {
    lp.setEdit({ region: lp.region });
    if (before) { lp.pushUndo('Recorte', before); before = null; }
  };
  const S = t => Math.round(t * lp.raw.sampleRate);

  // Si el loop quedó con un largo que no cierra en compases: elegir encogerlo o estirarlo
  const barsTxt = n => `${n} compás${n > 1 ? 'es' : ''}`;
  const squareBtn = h('button', { class: 'sbtn warn', title: 'El loop no dura compases enteros: ajustalo para que quede en tiempo', onclick: () => {
    const b = lp.regionBeats / 4, lo = Math.max(1, Math.floor(b)), hi = Math.max(1, Math.ceil(b));
    const pick = n => { closePopover(); lp.squareToBars(n); toast(`⏱ Loop ajustado a ${barsTxt(n)}`); };
    popover(squareBtn, [
      h('h4', {}, `Dura ${b.toFixed(2)} compases`),
      h('div', { class: 'btn-row' },
        ...[...new Set([lo, hi])].map(n => h('button', { class: 'sbtn big', onclick: () => pick(n) }, `${barsTxt(n)} · ${n < b ? 'más rápido' : 'más lento'}`))),
      h('div', { class: 'hint' }, 'Se estira o se encoge sin cambiar el tono. También podés seguir editando (duplicar, borrar, mover I/F) hasta que cierre justo.'),
    ]).style.setProperty('--c', col);
  } }, '⏱ Cuadrar al compás');
  const updSquare = () => {
    const bars = lp.regionBeats / 4;
    squareBtn.hidden = !(Math.abs(bars - Math.round(bars)) > 0.02 || bars < 0.75);
  };

  // Barra de herramientas tipo collage
  const toolbar = api => {
    const need = () => { const s = api.selection(); if (!s) toast('Primero arrastrá sobre la onda para seleccionar un pedazo'); return s; };
    const edit = (raw, region, label, msg) => { lp.applyEdit(raw, region, label); if (msg) toast(msg); };
    const btn = (lbl, title, fn, cls = '') => h('button', { class: 'sbtn ' + cls, title, onclick: fn }, lbl);
    const cutOut = (a, b) => {
      const R = lp.region;
      edit(deleteRange(lp.raw, S(a), S(b)), [afterDelete(R[0], a, b), afterDelete(R[1], a, b)], 'Borrar');
      api.setCursor(a);
    };
    return [
      chips([['sel', '▭ Seleccionar'], ['pan', '✋ Mover']], 'sel', v => api.setTool(v)),
      h('div', { class: 'sep' }),
      btn('✂ Cortar', 'Quita la selección y la guarda para pegar', () => {
        const s = need(); if (!s) return;
        clip = { buf: copyRange(lp.raw, S(s[0]), S(s[1])), bpm: lp.recBpm };
        cutOut(s[0], s[1]);
        toast('✂ Cortado · tocá donde quieras y 📋 Pegar');
      }),
      btn('⧉ Copiar', 'Guarda la selección para pegarla (también en otro loop)', () => {
        const s = need(); if (!s) return;
        clip = { buf: copyRange(lp.raw, S(s[0]), S(s[1])), bpm: lp.recBpm };
        toast('⧉ Copiado · tocá donde pegar (o abrí otro loop)');
      }),
      btn('📋 Pegar', 'Inserta lo copiado en el cursor (o en lugar de la selección). El loop se alarga.', async () => {
        const c = await clipFor(lp); if (!c) return;
        const s = api.selection();
        let raw = lp.raw, reg = [...lp.region], p;
        if (s) { raw = deleteRange(raw, S(s[0]), S(s[1])); reg = [afterDelete(reg[0], s[0], s[1]), afterDelete(reg[1], s[0], s[1])]; p = s[0]; }
        else p = api.cursorAt() ?? reg[1];
        const L = c.length / c.sampleRate;
        edit(insertAt(raw, S(p), c), [afterInsert(reg[0], p, L, false), afterInsert(reg[1], p, L, true)], 'Pegar', '📋 Pegado');
        api.setSelection(p, p + L);
      }),
      btn('⤓ Pegar encima', 'Pega reemplazando lo que hay desde el cursor. El largo no cambia.', async () => {
        const c = await clipFor(lp); if (!c) return;
        const s = api.selection();
        const p = s ? s[0] : (api.cursorAt() ?? lp.region[0]);
        edit(overwriteAt(lp.raw, S(p), c), lp.region, 'Pegar encima', '⤓ Pegado encima');
        api.setSelection(p, Math.min(lp.raw.duration, p + c.duration));
      }),
      btn('⧺ Duplicar', 'Repite la selección justo después (por ejemplo, para alargar un compás)', () => {
        const s = need(); if (!s) return;
        const [a, b] = s, L = b - a, R = lp.region;
        edit(insertAt(lp.raw, S(b), copyRange(lp.raw, S(a), S(b))), [afterInsert(R[0], b, L, false), afterInsert(R[1], b, L, true)], 'Duplicar', '⧺ Duplicado');
        api.setSelection(b, b + L);
      }),
      btn('🔇 Silenciar', 'Borra el sonido pero deja el hueco: el loop sigue en tiempo. Ideal para ruidos.', () => {
        const s = need(); if (!s) return;
        edit(silenceRange(lp.raw, S(s[0]), S(s[1])), lp.region, 'Silenciar', '🔇 Silenciado');
      }, 'good'),
      btn('🗑 Borrar', 'Quita la selección y junta los dos lados (el loop se acorta)', () => {
        const s = need(); if (!s) return;
        cutOut(s[0], s[1]);
        toast('🗑 Borrado');
      }),
      btn('⇆ Al revés', 'Da vuelta la selección', () => {
        const s = need(); if (!s) return;
        edit(reverseRange(lp.raw, S(s[0]), S(s[1])), lp.region, 'Al revés', '⇆ Dado vuelta');
      }),
      btn('▶ Oír', 'Escuchar la selección (o todo el loop)', () => {
        const s = api.selection() || lp.region;
        const src = A.ctx.createBufferSource(), g = A.ctx.createGain();
        src.buffer = copyRange(lp.raw, S(s[0]), S(s[1]));
        g.gain.value = lp.volume;
        src.connect(g).connect(A.loopBus);
        src.start(); src.onended = () => g.disconnect();
      }),
      btn('🎯 Solo esto', 'Que el loop sea solo la selección (como mover I y F)', () => {
        const s = need(); if (!s) return;
        begin(); lp.region = [s[0], s[1]]; end(); api.setSelection(null); toast('🎯 El loop ahora es la selección');
      }),
      btn('🥁 A un pad', 'Manda la selección a una pista de batería', e => {
        const s = need(); if (!s) return;
        const b = copyRange(lp.raw, S(s[0]), S(s[1]));
        popover(e.currentTarget, [
          h('h4', {}, 'Mandar el pedazo a…'),
          h('div', { class: 'btn-row' }, ...Array.from({ length: 8 }, (_, i) => h('button', { class: 'sbtn', onclick: async () => {
            closePopover();
            await setCustomSample(i, normalizeBuffer(b), `Loop ${lp.i + 1} · pedazo`);
            toast(`🥁 Pedazo en la pista ${i + 1}`);
          } }, `${i + 1} · ${trackName(i)}`))),
        ]).style.setProperty('--c', col);
      }),
    ];
  };

  const ed = editor({
    title: `Loop ${lp.i + 1}`, color: col,
    buffer: () => lp.raw,
    region: () => [lp.region[0] / lp.raw.duration, lp.region[1] / lp.raw.duration],
    setRegion: (a, b) => { lp.region = [a * lp.raw.duration, b * lp.raw.duration]; },
    commit: { begin, end },
    fades: { get: () => [lp.fadeIn, lp.fadeOut] },
    snapGrid: () => 60 / lp.recBpm,
    gridOrigin: () => lp.region[0],
    playhead: () => {
      const ph = lp.phase();
      return ph == null ? null : (lp.region[0] + ph * (lp.region[1] - lp.region[0])) / lp.raw.duration;
    },
    select: { onChange: () => updSquare() },
    toolbar,
    extra: [
      () => toggle('🧲 Ajustar al tiempo', true, v => ed.setSnap(v)),
      () => slider({ label: 'Fade in', min: 0, max: 0.5, step: 0.005, value: lp.fadeIn, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { if (!before) begin(); lp.fadeIn = v; ed.redraw(); clearTimeout(ed._t); ed._t = setTimeout(() => { lp.setEdit({ fadeIn: v }); lp.pushUndo('Fade', before); before = null; }, 350); } }),
      () => slider({ label: 'Fade out', min: 0, max: 0.5, step: 0.005, value: lp.fadeOut, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { if (!before) begin(); lp.fadeOut = v; ed.redraw(); clearTimeout(ed._t); ed._t = setTimeout(() => { lp.setEdit({ fadeOut: v }); lp.pushUndo('Fade', before); before = null; }, 350); } }),
      () => h('button', { class: 'sbtn', onclick: () => { begin(); lp.region = [0, lp.raw.duration]; end(); ed.redraw(); } }, '↔ Todo'),
      () => squareBtn,
      () => h('div', { class: 'hint' }, 'Arrastrá sobre la onda para seleccionar · tocá para poner el cursor de pegado · dos dedos: zoom y mover · las manijas I/F de arriba marcan qué parte suena.'),
    ],
  });
  updSquare();
}

// Lo copiado, adaptado al tempo de este loop (sin cambiar el tono)
async function clipFor(lp) {
  if (!clip) { toast('Primero copiá o cortá un pedazo'); return null; }
  if (Math.abs(clip.bpm - lp.recBpm) < 0.05) return clip.buf;
  return stretchBuffer(clip.buf, lp.recBpm / clip.bpm);
}

// ---------- Samples ----------
export function openSampleEditor(i) {
  const tr = app.tracks[i], p = app.state.tracks[i].params, col = TRACK_COLORS[i];
  if (!tr.buffer) return;
  let sens = 0.5;
  const sliceInfo = h('span', { class: 'hint' });
  const updInfo = () => { sliceInfo.textContent = p.slices.length ? `${p.slices.length} slices` : 'sin slices'; };
  updInfo();
  const sliceTog = toggle('✂ Modo slices', p.sliceMode, v => { undoTrack(i, 'Modo slices'); p.sliceMode = v; app.emit('sound', i); });
  const ed = editor({
    title: `Pista ${i + 1} · ${soundName(i)}`, color: col,
    buffer: () => tr.buffer,
    region: () => [p.start, p.end],
    setRegion: (a, b) => { p.start = a; p.end = b; },
    commit: { begin: () => undoTrack(i, 'Región'), end: () => { app.emit('param', i, 'start'); app.emit('param', i, 'end'); audition(i); } },
    fades: { get: () => [p.fadeIn, p.fadeOut] },
    snapGrid: null,
    playhead: null,
    slices: {
      get: () => p.slices,
      begin: () => undoTrack(i, 'Slice'),
      end: () => { p.slices.sort((a, b) => a - b); app.emit('sound', i); },
      move: (k, f) => { const s = p.slices; s[k] = Math.max(k ? s[k - 1] + 0.001 : 0, Math.min(k < s.length - 1 ? s[k + 1] - 0.001 : 1, f)); },
      add: f => { undoTrack(i, 'Slice'); p.slices.push(f); p.slices.sort((a, b) => a - b); updInfo(); app.emit('sound', i); },
    },
    extra: [
      () => slider({ label: 'Fade in', min: 0, max: 2, step: 0.005, value: p.fadeIn, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { undoTrack(i, 'Fade', 'fade' + i); p.fadeIn = v; ed.redraw(); } }),
      () => slider({ label: 'Fade out', min: 0, max: 2, step: 0.005, value: p.fadeOut, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { undoTrack(i, 'Fade', 'fade' + i); p.fadeOut = v; ed.redraw(); } }),
      () => h('button', { class: 'sbtn', onclick: () => audition(i) }, '▶ Escuchar'),
      () => h('button', { class: 'sbtn', onclick: async () => { await normalizeTrack(i); ed.refresh(); } }, '📈 Normalizar'),
      () => h('div', { class: 'sep' }),
      () => slider({ label: 'Sensibilidad', value: sens, fmt: v => Math.round(v * 100) + '%', onInput: v => { sens = v; } }),
      () => h('button', { class: 'sbtn on', onclick: () => {
        undoTrack(i, 'Slices auto');
        const all = detectTransients(tr.buffer, sens, 32);
        p.slices = all.filter(s => s >= p.start - 0.001 && s < p.end);
        if (!p.slices.length || p.slices[0] > p.start + 0.002) p.slices.unshift(p.start);
        p.sliceMode = true; sliceTog.set(true);
        updInfo(); ed.redraw(); app.emit('sound', i);
        toast(`✂ ${p.slices.length} slices`);
      } }, '✂ Auto'),
      () => h('button', { class: 'sbtn', onclick: () => {
        if (ed.selSlice < 0) { toast('Tocá la manija de un slice para elegirlo'); return; }
        undoTrack(i, 'Slice'); p.slices.splice(ed.selSlice, 1); ed.selSlice = -1; updInfo(); ed.redraw(); app.emit('sound', i);
      } }, '🗑 Slice'),
      () => sliceTog,
      () => h('button', { class: 'sbtn', onclick: () => {
        const n = p.slices.length;
        if (!n) { toast('Primero creá slices'); return; }
        undo.pattern('Repartir slices');
        const tp = app.pattern.tracks[i];
        tp.steps.fill(null);
        for (let k = 0; k < n && k < 32; k++) tp.steps[Math.min(31, Math.round(k * tp.len / n))] = { ...mkStep(0.85), pitch: k };
        p.sliceMode = true; sliceTog.set(true);
        app.emit('pattern-edit'); app.emit('sound', i);
        toast('🥁 Slices repartidos en los pasos');
      } }, '⇢ Repartir en pasos'),
      () => sliceInfo,
      () => h('div', { class: 'hint' }, 'Doble toque sobre la onda agrega un slice. En modo slices, el teclado y los pasos eligen el slice.'),
    ],
  });
}
