// Editor de forma de onda a pantalla casi completa, para loops y samples.
// Marcadores de inicio/fin arrastrables, zoom con dos dedos (o rueda), fades,
// ajuste al compás (loops) y slices por transientes (samples).
import { app } from '../app.js';
import { detectTransients } from '../audio/engine.js';
import { TRACK_COLORS, LOOP_COLORS, mkStep } from '../state.js';
import { h, slider, toggle, toast, ink, shade } from './util.js';
import { undo } from '../undo.js';
import { audition, normalizeTrack, undoTrack, soundName } from '../actions.js';

const HANDLE = 30; // px de tolerancia para agarrar un marcador

function editor({ title, color, buffer, region, setRegion, commit, fades, fadeMax, snapGrid, playhead, extra, slices }) {
  let buf = buffer();
  const sheet = h('div', { class: 'sheet' });
  const base = h('canvas', { class: 'we-base' }), over = h('canvas', { class: 'we-over' });
  const area = h('div', { class: 'we-area' }, base, over);
  const info = h('span', { class: 'we-info' });
  const close = () => { sheet.remove(); cancelAnimationFrame(raf); app.off('loops', onLoops); };
  const onLoops = () => { if (buffer()) refresh(); };
  app.on('loops', onLoops);
  sheet.append(
    h('div', { class: 'sheet-card' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'gh-dot', style: { background: color } }), h('b', {}, title), info,
        h('div', { style: { flex: 1 } }),
        h('button', { class: 'pill', onclick: () => { undo.undo(); refresh(); } }, '↶'),
        h('button', { class: 'pill', onclick: () => { view = [0, 1]; drawBase(); } }, '⤢ Ver todo'),
        h('button', { class: 'round', onclick: close }, '✕')),
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

  function resize() {
    const r = area.getBoundingClientRect();
    for (const c of [base, over]) { c.width = r.width * dpr(); c.height = r.height * dpr(); }
    drawBase();
  }

  function snapF(f) {
    if (!snap || !snapGrid) return f;
    const g = snapGrid() / buf.duration;
    return Math.round(f / g) * g;
  }

  function drawBase() {
    const g = base.getContext('2d'), w = W(), hh = H(), mid = hh / 2;
    if (!w) return;
    g.clearRect(0, 0, w, hh);
    const d = buf.getChannelData(0), N = d.length;
    const [ra, rb] = region();
    // Grilla de tiempos
    if (snapGrid) {
      const gs = snapGrid() / buf.duration;
      const first = Math.ceil(view[0] / gs);
      for (let k = first; k * gs <= view[1]; k++) {
        g.fillStyle = k % 4 === 0 ? ink(0.18) : ink(0.07);
        g.fillRect(fx(k * gs), 0, 1, hh);
      }
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
    // Slices
    if (slices) {
      slices.get().forEach((s, k) => {
        const x = fx(s);
        g.fillStyle = k === selSlice ? ink(1) : ink(0.55);
        g.fillRect(x - dpr(), 0, 2 * dpr(), hh);
        g.beginPath(); g.roundRect ? g.roundRect(x - 14 * dpr(), hh - 30 * dpr(), 28 * dpr(), 26 * dpr(), 8 * dpr()) : g.rect(x - 14 * dpr(), hh - 30 * dpr(), 28 * dpr(), 26 * dpr()); g.fill();
        g.fillStyle = shade(1); g.font = `800 ${12 * dpr()}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(k + 1, x, hh - 17 * dpr());
      });
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
    info.textContent = `${len.toFixed(2)} s` + (snapGrid ? ` · ${(len / snapGrid()).toFixed(2)} tiempos` : '') + (view[1] - view[0] < 0.999 ? ` · zoom ×${(1 / (view[1] - view[0])).toFixed(1)}` : '');
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
  over.addEventListener('pointerdown', e => {
    over.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      drag = null;
      const [p1, p2] = [...ptrs.values()];
      pinch = { d: Math.abs(p1.x - p2.x) || 1, c: xf(((p1.x + p2.x) / 2 - base.getBoundingClientRect().left) * dpr()), v: [...view] };
      return;
    }
    const x = evX(e), y = (e.clientY - base.getBoundingClientRect().top) * dpr();
    const [ra, rb] = region();
    const near = f => Math.abs(fx(f) - x) < HANDLE * dpr();
    if (slices && y > H() - 40 * dpr()) {
      const k = slices.get().findIndex(s => near(s));
      if (k >= 0) { selSlice = k; drag = { kind: 'slice', k }; slices.begin(); drawBase(); return; }
    }
    if (near(ra) && (!near(rb) || Math.abs(fx(ra) - x) <= Math.abs(fx(rb) - x))) { drag = { kind: 'start' }; commit.begin(); return; }
    if (near(rb)) { drag = { kind: 'end' }; commit.begin(); return; }
    const now = performance.now();
    if (slices && now - lastTap < 320) { slices.add(snapF(xf(x))); selSlice = -1; drawBase(); lastTap = 0; return; }
    lastTap = now;
    drag = { kind: 'pan', x, v: [...view] };
  });
  over.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [p1, p2] = [...ptrs.values()];
      const z = Math.max(0.0005, Math.min(1, (pinch.v[1] - pinch.v[0]) * pinch.d / (Math.abs(p1.x - p2.x) || 1)));
      setView(pinch.c - (pinch.c - pinch.v[0]) / (pinch.v[1] - pinch.v[0]) * z, z);
      return;
    }
    if (!drag) return;
    const x = evX(e), f = Math.max(0, Math.min(1, snapF(xf(x))));
    const [ra, rb] = region();
    const minLen = 0.01 / buf.duration;
    if (drag.kind === 'start') setRegion(Math.min(f, rb - minLen), rb);
    else if (drag.kind === 'end') setRegion(ra, Math.max(f, ra + minLen));
    else if (drag.kind === 'slice') slices.move(drag.k, f);
    else if (drag.kind === 'pan') {
      const span = drag.v[1] - drag.v[0];
      setView(drag.v[0] - (x - drag.x) / IW() * span, span);
      return;
    }
    drawBase();
  });
  const up = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (drag && (drag.kind === 'start' || drag.kind === 'end')) commit.end();
    if (drag && drag.kind === 'slice') slices.end();
    drag = null;
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
  function refresh() { buildBlocks(); drawBase(); }

  new ResizeObserver(resize).observe(area);
  requestAnimationFrame(() => { resize(); drawOver(); });
  return {
    refresh, redraw: drawBase, close,
    setSnap(v) { snap = v; },
    get selSlice() { return selSlice; }, set selSlice(v) { selSlice = v; },
  };
}

// ---------- Loops ----------
export function openLoopEditor(lp) {
  if (!lp.raw) return;
  const col = LOOP_COLORS[lp.i];
  let before = null;
  const begin = () => { before = lp.snapshot(); };
  const end = () => {
    lp.setEdit({ region: lp.region });
    if (before) { lp.pushUndo('Recorte', before); before = null; }
  };
  const ed = editor({
    title: `Loop ${lp.i + 1}`, color: col,
    buffer: () => lp.raw,
    region: () => [lp.region[0] / lp.raw.duration, lp.region[1] / lp.raw.duration],
    setRegion: (a, b) => { lp.region = [a * lp.raw.duration, b * lp.raw.duration]; },
    commit: { begin, end },
    fades: { get: () => [lp.fadeIn, lp.fadeOut] },
    snapGrid: () => 60 / lp.recBpm,
    playhead: () => {
      const ph = lp.phase();
      return ph == null ? null : (lp.region[0] + ph * (lp.region[1] - lp.region[0])) / lp.raw.duration;
    },
    extra: [
      () => toggle('🧲 Ajustar al compás', true, v => ed.setSnap(v)),
      () => slider({ label: 'Fade in', min: 0, max: 0.5, step: 0.005, value: lp.fadeIn, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { if (!before) begin(); lp.fadeIn = v; ed.redraw(); clearTimeout(ed._t); ed._t = setTimeout(() => { lp.setEdit({ fadeIn: v }); lp.pushUndo('Fade', before); before = null; }, 350); } }),
      () => slider({ label: 'Fade out', min: 0, max: 0.5, step: 0.005, value: lp.fadeOut, fmt: v => Math.round(v * 1000) + ' ms', onInput: v => { if (!before) begin(); lp.fadeOut = v; ed.redraw(); clearTimeout(ed._t); ed._t = setTimeout(() => { lp.setEdit({ fadeOut: v }); lp.pushUndo('Fade', before); before = null; }, 350); } }),
      () => h('button', { class: 'sbtn', onclick: () => { begin(); lp.region = [0, lp.raw.duration]; end(); ed.redraw(); } }, '↔ Todo'),
    ],
  });
  void ed;
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
