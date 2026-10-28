// Vista Estudio (Arrangement): barra de control, navegador a la izquierda, pistas acostadas con
// sus encabezados a la derecha (como Ableton), y abajo la vista de detalle (clip / dispositivos /
// mezcla). Pensada para tablet: el lápiz edita, el dedo navega.
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { setBpm } from '../actions.js';
import { undo } from '../undo.js';
import { h, popover, closePopover, toast } from '../ui/util.js';
import { T, FONT, ink, dark, tint } from './theme.js';
import { setView } from '../ui/padview.js';
import {
  S, COLORS, clone, uid, spb, newTrack, newMidiClip, findTrack, findClip, selClip, selTrack, gridBeats, snapB,
  GRID_OPTS, clipNotes, peaksOf, getBuffer, songEnd, audible, synthInst, drumInst,
} from './model.js';
import { studio, removeOverlaps, splitRight, autoTargets, autoValueAt, faderGain, heard } from './engine.js';
import { gestures, pointAnchor, fitCanvas } from './gest.js';
import { buildBrowser } from './browser.js';
import { buildDetail, instView, setInstView } from './detail.js';
import { buildStudioKeys } from './keys.js';
import { reverseRange } from '../audio/edit.js';
import { normalizeBuffer } from '../audio/engine.js';
import { putBuffer } from './model.js';

const RULER_H = 34, HEAD_W = 184, MIN_H = 44;
export const defaultDetailH = () => Math.round(Math.min(330, Math.max(200, innerHeight * 0.4)));

export function snapshot(label, key = null) {
  const st = S();
  undo.state(label, key, () => clone(st.tracks), v => { st.tracks = v; studio.sync(); app.emit('studio'); });
}

export function buildStudio(el) {
  const st = S();
  el.innerHTML = '';

  // ---------- Barra de control ----------
  const playBtn = h('button', { class: 'round play', title: 'Play / Stop (espacio)', html: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>' });
  playBtn.addEventListener('click', () => studio.toggle());
  const stopBtn = h('button', { class: 'round', title: 'Stop · otra vez: volver al principio', html: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>' });
  stopBtn.addEventListener('click', () => { if (!studio.playing) { st.pos = 0; arr.draw(); } studio.stop(); });
  const recBtn = h('button', { class: 'round rec', title: 'Grabar en las pistas armadas (R)', html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>' });
  recBtn.addEventListener('click', () => studio.toggleRec());
  const metro = h('button', { class: 'round', title: 'Metrónomo' }, '♩');
  metro.addEventListener('click', () => { st.metro = !st.metro; metro.classList.toggle('on', st.metro); });
  metro.classList.toggle('on', !!st.metro);
  const countBtn = h('button', { class: 'tb-btn sm', title: 'Cuenta antes de grabar (con el transporte parado)' });
  const updCount = () => { countBtn.textContent = ['⏱ Sin cuenta', '⏱ 1 compás', '⏱ 2 compases'][st.countIn ?? 1]; };
  countBtn.addEventListener('click', () => { st.countIn = ((st.countIn ?? 1) + 1) % 3; updCount(); });
  updCount();

  const bpmNum = h('span', {}, Math.round(app.state.bpm));
  const bpm = h('div', { class: 'bpm', title: 'Tempo: arrastrá o doble toque' }, h('div', {}, bpmNum, h('small', {}, 'BPM')));
  { let drag = null, lastTap = 0;
    bpm.addEventListener('pointerdown', e => {
      const now = performance.now();
      if (now - lastTap < 300) { const v = prompt('Tempo (BPM)', app.state.bpm); if (v) setBpm(+v); return; }
      lastTap = now; bpm.setPointerCapture(e.pointerId); drag = { y: e.clientY, v: app.state.bpm };
    });
    bpm.addEventListener('pointermove', e => { if (drag) setBpm(drag.v + (drag.y - e.clientY) / 4); });
    bpm.addEventListener('pointerup', () => { drag = null; });
  }
  app.on('bpm', () => { bpmNum.textContent = Math.round(app.state.bpm); arr.draw(); });

  const posLbl = h('div', { class: 'st-pos', title: 'Posición (compás . tiempo . semicorchea)' }, '1.1.1');
  const loopBtn = h('button', { class: 'tb-btn sm', title: 'Loop: repetir la región marcada en la regla (arrastrala arriba de los números)' }, '🔁 Loop');
  loopBtn.addEventListener('click', () => { st.loop.on = !st.loop.on; updLoop(); arr.draw(); });
  const updLoop = () => loopBtn.classList.toggle('on', !!st.loop.on);
  updLoop();
  const gridBtn = h('button', { class: 'tb-btn sm', title: 'Grilla para mover, estirar y dibujar' });
  const updGrid = () => { gridBtn.textContent = '▦ ' + gridLabel(st.grid); };
  gridBtn.addEventListener('click', () => popover(gridBtn, [
    h('h4', {}, 'Grilla'),
    h('div', { class: 'chips wrap' }, ...GRID_OPTS.map(g => h('button', { class: 'chip' + (st.grid === g ? ' on' : ''), onclick: () => { st.grid = g; updGrid(); arr.draw(); app.emit('studio-draw'); closePopover(); } }, gridLabel(g)))),
    h('div', { class: 'hint' }, 'Automática: se adapta al zoom, como en Ableton. Sin grilla: movés libre (o mantené Alt con el mouse).'),
  ]));
  updGrid();
  const drawBtn = h('button', { class: 'tb-btn sm', title: 'Modo dibujo (B): el lápiz crea clips y pinta notas; con este modo el dedo también dibuja' }, '✏️ Dibujar');
  drawBtn.addEventListener('click', () => { st.draw = !st.draw; updDraw(); });
  const updDraw = () => drawBtn.classList.toggle('on', !!st.draw);
  updDraw();
  const followBtn = h('button', { class: 'round', title: 'Seguir la reproducción' }, '⇥');
  followBtn.addEventListener('click', () => { st.follow = !st.follow; followBtn.classList.toggle('on', st.follow); });
  followBtn.classList.toggle('on', !!st.follow);
  const undoBtn = h('button', { class: 'round', title: 'Deshacer (Ctrl+Z)', onclick: () => undo.undo() }, '↶');
  const redoBtn = h('button', { class: 'round', title: 'Rehacer', onclick: () => undo.redo() }, '↷');
  const updUndo = () => { undoBtn.disabled = !undo.canUndo; redoBtn.disabled = !undo.canRedo; };
  app.on('undo-change', updUndo); updUndo();
  // 🎹: abre el instrumento de la pista MIDI elegida en modo "Tocar" (teclado o pads)
  const kbBtn = h('button', { class: 'tb-btn sm', title: 'Tocar la pista MIDI elegida con el teclado en pantalla' }, '🎹 Tocar');
  kbBtn.addEventListener('click', () => {
    const t = studio.playTarget();
    if (!t) { toast('Elegí una pista MIDI'); return; }
    st.sel.track = t.id; st.detail = 'devices';
    setInstView(t.id, instView(t.id) === 'play' ? 'knobs' : 'play');
    if (st.detailH < 60) st.detailH = defaultDetailH();
    layout(); app.emit('studio-sel');
  });
  const brBtn = h('button', { class: 'tb-btn sm', title: 'Mostrar / ocultar el navegador' }, '📂 Navegador');
  brBtn.addEventListener('click', () => { st.browser = !st.browser; layout(); });
  const expBtn = h('button', { class: 'tb-btn sm', title: 'Exportar el tema (o la región del loop) a WAV' }, '⤓ WAV');
  expBtn.addEventListener('click', () => studio.exportMix());
  const back = h('button', { class: 'tb-btn st-back', title: 'Volver al modo En vivo' }, '🎛', h('span', {}, 'En vivo'));
  back.addEventListener('click', () => { studio.stop(); setView('main'); });
  const helpBtn = h('button', { class: 'round', title: 'Cómo se usa' }, '?');
  helpBtn.addEventListener('click', () => showStudioHelp(helpBtn));

  // 🗑 Borrar: lo elegido (varios clips, notas del piano roll, un clip o el tiempo marcado)
  const delBtn = h('button', { class: 'tb-btn sm del', title: 'Borrar lo elegido (Supr)' }, '🗑 Borrar');
  delBtn.addEventListener('click', () => { if (!(arr.many.size < 2 && detail.deleteSel())) arr.deleteSelected(); });
  // ☑ Varios: con el dedo, cada toque suma o saca clips de la selección
  const multiBtn = h('button', { class: 'tb-btn sm', title: 'Elegir varios clips: cada toque suma o saca uno (con el lápiz también podés arrastrar en el vacío)' }, '☑ Varios');
  multiBtn.addEventListener('click', () => { st.multi = !st.multi; multiBtn.classList.toggle('on', st.multi); if (!st.multi) { arr.many.clear(); arr.draw(); } });
  multiBtn.classList.toggle('on', !!st.multi);

  const bar = h('header', { class: 'st-bar' },
    back,
    h('div', { class: 'tb-group' }, playBtn, stopBtn, recBtn),
    h('div', { class: 'tb-group' }, bpm, metro, countBtn),
    posLbl,
    h('div', { class: 'tb-group' }, loopBtn, gridBtn, drawBtn, followBtn),
    h('div', { class: 'tb-group' }, undoBtn, redoBtn),
    h('div', { class: 'tb-group' }, multiBtn, delBtn),
    h('div', { class: 'tb-spacer' }),
    h('div', { class: 'tb-group' }, kbBtn, brBtn, expBtn, helpBtn));

  // ---------- Cuerpo ----------
  const browserEl = h('aside', { class: 'st-browser panel' });
  // Con el navegador cerrado queda una pestañita vertical para abrirlo de un toque
  const rail = h('button', { class: 'br-rail', title: 'Abrir el navegador' }, h('span', {}, '▶'), h('b', {}, 'Navegador'));
  rail.addEventListener('click', () => { st.browser = true; layout(); });
  const ruler = h('canvas', { class: 'st-ruler' });
  const rulerSide = h('div', { class: 'st-ruler-side' });
  const lanes = h('canvas', { class: 'st-lanes' });
  const headsIn = h('div', { class: 'st-heads-in' });
  const heads = h('div', { class: 'st-heads' }, headsIn);
  const arrEl = h('section', { class: 'st-arr panel' },
    h('div', { class: 'st-row-ruler' }, ruler, rulerSide),
    h('div', { class: 'st-row-lanes' }, lanes, heads));
  const body = h('div', { class: 'st-body' }, rail, browserEl, arrEl);
  // En pantalla angosta el navegador es un cajón: tocar el arreglo lo cierra
  arrEl.addEventListener('pointerdown', () => { if (el.classList.contains('narrow') && st.browser) { st.browser = false; layout(); } }, true);
  const splitter = h('div', { class: 'st-split', title: 'Arrastrá para cambiar el alto' }, h('i'));
  const detailEl = h('section', { class: 'st-detail panel' });
  const keysEl = h('div'); // (el teclado ahora vive en el instrumento: modo "Tocar")
  el.append(bar, body, splitter, detailEl);

  { let d = null;
    splitter.addEventListener('pointerdown', e => { splitter.setPointerCapture(e.pointerId); d = { y: e.clientY, h: st.detailH }; });
    splitter.addEventListener('pointermove', e => { if (!d) return; st.detailH = Math.max(0, Math.min(innerHeight - 220, d.h + d.y - e.clientY)); layout(); });
    splitter.addEventListener('pointerup', () => {
      if (d && Math.abs(st.detailH - d.h) < 3) st.detailH = st.detailH < 60 ? defaultDetailH() : 0; // tocar = abrir / cerrar
      else if (st.detailH < 60) st.detailH = 0;
      d = null; layout();
    });
  }

  // Todo se adapta a la pantalla: el detalle nunca tapa el arreglo, y en pantallas angostas
  // (tablet vertical) el navegador se abre encima, como un cajón
  function layout() {
    const narrow = innerWidth < 980;
    el.classList.toggle('narrow', narrow);
    el.classList.toggle('no-browser', !st.browser);
    brBtn.classList.toggle('on', !!st.browser);
    const t = studio.playTarget();
    kbBtn.classList.toggle('on', !!t && st.detailH >= 60 && st.detail === 'devices' && instView(t.id) === 'play');
    const closed = st.detailH < 60;
    el.classList.toggle('detail-closed', closed);
    const maxH = Math.max(140, innerHeight - 250);
    detailEl.style.height = (closed ? 40 : Math.min(st.detailH, maxH)) + 'px';
    requestAnimationFrame(() => { arr.draw(); detail.render(); });
  }

  // ---------- Arreglo ----------
  const arr = buildArrangement({ ruler, rulerSide, lanes, heads, headsIn, posLbl });
  const detail = buildDetail(detailEl, { arr });
  const keys = buildStudioKeys(keysEl);
  const browser = buildBrowser(browserEl, { arr });

  const updTransport = () => {
    playBtn.classList.toggle('on', studio.playing);
    recBtn.classList.toggle('on', !!studio.rec);
  };
  app.on('studio-transport', updTransport);
  app.on('studio-rec', updTransport);
  app.on('studio', () => { arr.renderHeads(); arr.draw(); detail.render(); keys.render(); });
  app.on('studio-draw', () => { arr.draw(); detail.draw(); });
  app.on('studio-draw-arr', () => arr.draw());
  app.on('studio-sel', () => { arr.renderHeads(); arr.draw(); detail.render(); keys.render(); });
  app.on('theme', () => arr.draw());
  app.on('studio-layout', layout);
  window.addEventListener('resize', () => { if (app.state.view === 'studio') layout(); });

  layout();
  arr.renderHeads();

  return {
    frame() {
      arr.frame();
      detail.frame();
    },
    layout,
    key(e, down) { return studioKey(e, down, { arr, detail, keys, drawBtn: () => { st.draw = !st.draw; updDraw(); } }); },
    browser,
  };
}

const gridLabel = g => ({ auto: 'Auto', bar: 'Compás', off: 'Libre' })[g] || g;

// ---------- Atajos de teclado (con teclado físico o Bluetooth) ----------
function studioKey(e, down, ui) {
  if (!down) return ui.keys.qwerty(e, false);
  const st = S(), k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (ui.detail.key(e)) return true;
  if (e.code === 'Space') { studio.toggle(); return true; }
  if (mod && k === 'z') { e.shiftKey ? undo.redo() : undo.undo(); return true; }
  if (mod && k === 'y') { undo.redo(); return true; }
  if (mod && k === 'd') { const sc = selClip(); if (sc) duplicateClip(sc.t, sc.c); return true; }
  if (mod && k === 'c') { const sc = selClip(); if (sc) copyClip(sc.c); return true; }
  if (mod && k === 'v') {
    const t = selTrack();
    if (t && clipboard && clipboard.kind === t.kind) {
      snapshot('Pegar clip');
      const c = clone(clipboard); c.id = uid('c'); c.start = st.pos; t.clips.push(c); removeOverlaps(t, c);
      st.sel.clip = c.id; st.pos = c.start + c.len; app.emit('studio');
    }
    return true;
  }
  if (mod && k === 'e') { const sc = selClip(); if (sc) splitAt(sc.t, sc.c, st.pos); return true; }
  if (mod && k === 'l') { const sc = selClip(); if (sc) { st.loop = { on: true, a: sc.c.start, b: sc.c.start + sc.c.len }; app.emit('studio-draw'); } return true; }
  if (k === 'delete' || k === 'backspace') { if (ui.arr.many.size < 2 && ui.detail.deleteSel?.()) return true; ui.arr.deleteSelected(); return true; }
  if (k === 'b' && !mod) { ui.drawBtn(); return true; }
  if (k === 'r' && !mod) { studio.toggleRec(); return true; }
  return ui.keys.qwerty(e, true);
}

// ---------- Operaciones con clips ----------
export function duplicateClip(t, c) {
  snapshot('Duplicar clip');
  const d = clone(c); d.id = uid('c'); d.start = c.start + c.len;
  t.clips.push(d); removeOverlaps(t, d);
  S().sel.clip = d.id;
  app.emit('studio');
}
export function deleteClip(t, c) {
  snapshot('Borrar clip');
  t.clips = t.clips.filter(x => x !== c);
  if (S().sel.clip === c.id) S().sel.clip = null;
  app.emit('studio');
}
export function splitAt(t, c, x) {
  if (x <= c.start + 1e-3 || x >= c.start + c.len - 1e-3) { toast('Poné el cursor (tocá la pista) dentro del clip para dividirlo'); return; }
  snapshot('Dividir clip');
  const r = splitRight(c, x);
  c.len = x - c.start;
  if (c.kind === 'midi') c.loop = Math.min(c.loop, c.len);
  t.clips.push(r);
  app.emit('studio');
}

// ---------- Ayuda ----------
function showStudioHelp(anchor) {
  popover(anchor, [
    h('h4', {}, 'Estudio · cómo se usa'),
    h('div', { class: 'help-list' },
      h('p', {}, '✏️ ', h('b', {}, 'Lápiz:'), ' mové y estirá clips, dibujá notas y automatización. El botón del lápiz abre el menú. Si lo pasás sin apoyar, te muestra qué vas a tocar.'),
      h('p', {}, '👆 ', h('b', {}, 'Dedo:'), ' arrastrá para moverte, pellizcá para hacer zoom, doble toque para crear un clip MIDI, mantené apretado para agarrar un clip.'),
      h('p', {}, '📂 ', h('b', {}, 'Navegador:'), ' arrastrá instrumentos, efectos y samples a una pista (o al espacio vacío para una pista nueva). Tocar un sample lo hace sonar.'),
      h('p', {}, '⏺ ', h('b', {}, 'Grabar:'), ' armá la pista (⏺ en su encabezado) y apretá ⏺ arriba. Audio = micrófono; MIDI = teclado 🎹 o controlador. Con 🔁 Loop prendido, el MIDI se graba encima en capas.'),
      h('p', {}, '🔁 ', h('b', {}, 'Loop:'), ' arrastrá sobre la parte de arriba de la regla para marcar la región.'),
      h('p', {}, '⌨️ Espacio play · Ctrl+D duplicar · Ctrl+E dividir · Supr borrar · B dibujar · Ctrl+Z deshacer'),
    ),
  ], { cls: 'wide' });
}

// =====================================================================
// Arreglo: regla + carriles (lienzo) + encabezados (DOM)
// =====================================================================
function buildArrangement({ ruler, rulerSide, lanes, heads, headsIn, posLbl }) {
  const st = S();
  let hover = null, tsel = null, ghost = null, drop = null;
  const many = new Set(); // clips elegidos (además del principal st.sel.clip)
  const isSel = c => c.id === st.sel.clip || many.has(c.id);
  // Clips elegidos con su pista: [{t, c}]
  const selected = () => {
    const ids = new Set(many); if (st.sel.clip) ids.add(st.sel.clip);
    const out = [];
    for (const t of st.tracks) for (const c of t.clips) if (ids.has(c.id)) out.push({ t, c });
    return out;
  };
  function deleteSelected() {
    const list = selected();
    if (list.length) {
      snapshot(list.length > 1 ? `Borrar ${list.length} clips` : 'Borrar clip');
      const ids = new Set(list.map(x => x.c.id));
      for (const t of st.tracks) t.clips = t.clips.filter(c => !ids.has(c.id));
      many.clear(); st.sel.clip = null;
      app.emit('studio');
      toast(list.length > 1 ? `🗑 ${list.length} clips borrados (↶ para deshacer)` : '🗑 Clip borrado');
      return true;
    }
    if (tsel) { deleteTime(tsel); return true; }
    toast('Elegí uno o varios clips para borrar');
    return false;
  }
  function deleteTime(sel) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    snapshot('Borrar tiempo');
    for (const t of st.tracks.slice(st.tracks.indexOf(sel.t0), st.tracks.indexOf(sel.t1) + 1)) {
      const tmp = newMidiClip(a, b - a); tmp.kind = '__cut';
      t.clips.push(tmp); removeOverlaps(t, tmp); t.clips = t.clips.filter(c => c !== tmp);
    }
    tsel = null; app.emit('studio');
  }

  const X = b => (b - st.sx) * st.zoom;
  const B = x => x / st.zoom + st.sx;
  const totalH = () => st.tracks.reduce((a, t) => a + t.h, 0);
  function trackAt(y) {
    let y0 = -st.sy;
    for (const t of st.tracks) { if (y >= y0 && y < y0 + t.h) return { t, y0 }; y0 += t.h; }
    return null;
  }
  const trackY = t => { let y0 = -st.sy; for (const x of st.tracks) { if (x === t) return y0; y0 += x.h; } return y0; };
  const g = () => gridBeats(st.zoom);
  const clamp = () => {
    st.zoom = Math.max(1.5, Math.min(480, st.zoom));
    st.sx = Math.max(0, st.sx);
    const r = lanes.getBoundingClientRect();
    st.sy = Math.max(0, Math.min(Math.max(0, totalH() + 120 - r.height), st.sy));
  };

  // ---- Dibujo ----
  let raf = 0;
  const draw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };

  function paint() {
    if (app.state.view !== 'studio') return;
    clamp();
    paintLanes(); compose(); paintRuler();
    headsIn.style.transform = `translateY(${-st.sy}px)`;
  }

  // Los carriles se dibujan en un lienzo aparte; mientras suena solo se repinta el cabezal encima
  const base = document.createElement('canvas');
  function compose() {
    const g2 = lanes.getContext('2d');
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.clearRect(0, 0, lanes.width, lanes.height);
    g2.drawImage(base, 0, 0);
    if (studio.playing) {
      const dpr = lanes.width / Math.max(1, lanes.clientWidth);
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.fillStyle = studio.rec ? T.rec : T.playhead;
      g2.fillRect(Math.round(X(studio.heardBeat())), 0, 2, lanes.clientHeight);
    }
  }

  function gridLines(gc, w, hh, y0 = 0) {
    const gb = g(), first = Math.floor(st.sx / (gb || 1)) * (gb || 1);
    const bar = st.zoom * 4 < 22 ? 16 : 4; // muy lejos: líneas cada 4 compases
    for (let b = first; X(b) < w; b += gb || 1) {
      if (b < 0) continue;
      const x = Math.round(X(b)) + 0.5;
      gc.fillStyle = b % bar === 0 ? dark(0.55) : b % 1 === 0 && st.zoom > 10 ? dark(0.28) : dark(0.14);
      if (b % bar !== 0 && b % 4 === 0) gc.fillStyle = dark(0.4);
      gc.fillRect(x, y0, 1, hh);
    }
  }

  function paintLanes() {
    const { w, h: hh } = fitCanvas(lanes);
    if (base.width !== lanes.width || base.height !== lanes.height) { base.width = lanes.width; base.height = lanes.height; }
    const gc = base.getContext('2d');
    gc.setTransform(lanes.width / Math.max(1, w), 0, 0, lanes.width / Math.max(1, w), 0, 0);
    gc.fillStyle = '#1c1c1c'; gc.fillRect(0, 0, w, hh);
    let y0 = -st.sy;
    st.tracks.forEach((t, i) => {
      if (y0 + t.h > 0 && y0 < hh) {
        gc.fillStyle = t.id === st.sel.track ? T.laneSel : i % 2 ? T.laneAlt : T.lane;
        gc.fillRect(0, y0, w, t.h - 1);
        gc.fillStyle = T.laneEdge; gc.fillRect(0, y0 + t.h - 1, w, 1);
      }
      y0 += t.h;
    });
    gridLines(gc, w, Math.min(hh, y0));
    if (st.loop.on) { gc.fillStyle = ink(0.035); gc.fillRect(X(st.loop.a), 0, (st.loop.b - st.loop.a) * st.zoom, Math.min(hh, y0)); }
    // Clips
    y0 = -st.sy;
    for (const t of st.tracks) {
      if (y0 + t.h > 0 && y0 < hh) {
        for (const c of t.clips) {
          const x = X(c.start), cw = c.len * st.zoom;
          if (x > w || x + cw < 0) continue;
          drawClip(gc, t, c, x, y0 + 1, cw, t.h - 3, isSel(c), t.autoOn);
        }
        if (t.autoOn) drawAuto(gc, t, y0, w);
        if (studio.rec && studio.rec.tracks.includes(t.id) && studio.rec.audio && t.kind === 'audio') drawRecording(gc, t, y0, w);
      }
      y0 += t.h;
    }
    // Zona para pistas nuevas
    if (y0 < hh) {
      gc.fillStyle = drop && !drop.t ? 'rgba(255,173,59,0.16)' : '#1c1c1c';
      gc.fillRect(0, y0, w, hh - y0);
      gc.fillStyle = T.dim; gc.font = '12px ' + FONT;
      if (hh - y0 > 30) gc.fillText(drop ? 'Soltá acá para una pista nueva' : 'Arrastrá acá instrumentos o samples para crear una pista', 12, y0 + 22);
    }
    // Selección de tiempo
    if (tsel) {
      const ys = trackY(tsel.t0), ye = trackY(tsel.t1) + tsel.t1.h;
      gc.fillStyle = T.timeSel;
      gc.fillRect(X(Math.min(tsel.a, tsel.b)), ys, Math.abs(tsel.b - tsel.a) * st.zoom, ye - ys);
    }
    // Fantasma (crear clip / soltar del navegador)
    const gh = ghost || (drop?.t ? drop : null);
    if (gh?.t) {
      const y = trackY(gh.t);
      gc.strokeStyle = T.accent; gc.lineWidth = 2; gc.setLineDash([5, 4]);
      gc.strokeRect(X(gh.a) + 1, y + 2, Math.max(6, (gh.b - gh.a) * st.zoom) - 2, gh.t.h - 5);
      gc.setLineDash([]);
    }
    // Marcador de inicio y cabezal
    gc.fillStyle = ink(0.45);
    const px = Math.round(X(st.pos)) + 0.5;
    for (let y = 0; y < hh; y += 8) gc.fillRect(px, y, 1, 4);
    // Lápiz en el aire
    if (hover && !studio.playing) {
      gc.fillStyle = T.accent;
      if (hover.edge) {
        const xx = X(hover.edge === 'L' ? hover.clip.start : hover.clip.start + hover.clip.len);
        gc.fillRect(xx - 2, hover.y0 + 2, 4, hover.t.h - 5);
      } else if (hover.t) gc.fillRect(Math.round(X(snapB(hover.b, g(), 'floor'))), hover.y0, 1, hover.t.h);
    }
  }

  // Clip al estilo Ableton: barra de título del color del clip, cuerpo más claro y el
  // contenido (notas u onda) en negro. Seleccionado: más claro, borde blanco y agarraderas.
  function drawClip(gc, t, c, x, y, w, hh, sel, dim) {
    const col = c.color || t.color, muted = !heard(t);
    gc.save();
    gc.globalAlpha = dim ? 0.35 : muted ? 0.5 : 1;
    rr(gc, x, y, w, hh, 2);
    gc.fillStyle = sel ? tint(col, 0.55) : tint(col, 0.22);
    gc.fill();
    gc.save(); gc.clip();
    gc.fillStyle = sel ? tint(col, 0.15) : col; gc.fillRect(x, y, w, 14);
    gc.fillStyle = 'rgba(0,0,0,0.85)'; gc.font = '11px ' + FONT;
    const nm = c.name || (c.kind === 'midi' ? t.name : 'Audio');
    const gainTxt = c.kind === 'audio' && c.gain != null && Math.abs(c.gain - 1) > 0.001 ? '  ' + (20 * Math.log10(c.gain)).toFixed(1) + ' dB' : '';
    if (w > 20) gc.fillText(nm + gainTxt, x + 4, y + 10.5, Math.max(10, w - 8));
    const by = y + 15, bh = hh - 16;
    if (c.kind === 'midi') {
      const L = c.loop || c.len;
      for (let k = 1; k * L < c.len - 1e-6; k++) { gc.fillStyle = dark(0.35); gc.fillRect(x + k * L * st.zoom, by, 1, bh); }
      const ns = clipNotes(c);
      if (ns.length) {
        let lo = 127, hi = 0;
        for (const n of c.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
        const rng = Math.max(8, hi - lo + 1), nh = Math.max(1.5, Math.min(5, bh / rng));
        gc.fillStyle = dark(0.8);
        for (const n of ns) {
          const nx = X(n.s); if (nx > x + w || nx + n.d * st.zoom < x) continue;
          const ny = by + bh - 3 - ((n.p - lo + 0.5) / rng) * (bh - 6) - nh / 2;
          gc.fillRect(nx, ny, Math.max(1.5, n.d * st.zoom - 1), nh);
        }
      }
    } else {
      const pk = peaksOf(c.buf), buf = getBuffer(c.buf);
      if (pk && buf) {
        const bufSpb = c.warp ? 60 / c.bpm : spb(), mid = by + bh / 2, amp = (bh / 2 - 1) * Math.min(2, c.gain ?? 1);
        gc.fillStyle = dark(0.75);
        const x0 = Math.max(x, 0), x1 = Math.min(x + w, lanes.clientWidth);
        for (let px = Math.floor(x0); px < x1; px++) {
          const s0 = c.off + (B(px) - c.start) * bufSpb, s1 = c.off + (B(px + 1) - c.start) * bufSpb;
          let k0 = Math.floor(s0 * pk.sr / pk.H), k1 = Math.max(k0 + 1, Math.floor(s1 * pk.sr / pk.H));
          if (k0 >= pk.mn.length || k1 <= 0) continue;
          k0 = Math.max(0, k0); k1 = Math.min(pk.mn.length, k1);
          let lo = 0, hi2 = 0;
          for (let k = k0; k < k1; k++) { if (pk.mn[k] < lo) lo = pk.mn[k]; if (pk.mx[k] > hi2) hi2 = pk.mx[k]; }
          gc.fillRect(px, mid - hi2 * amp, 1, Math.max(1, (hi2 - lo) * amp));
        }
      } else if (!buf) { gc.fillStyle = dark(0.6); gc.fillText('falta el audio', x + 5, by + 14); }
    }
    gc.restore();
    gc.lineWidth = 1; gc.strokeStyle = sel ? '#fff' : dark(0.6); rr(gc, x + 0.5, y + 0.5, w - 1, hh - 1, 2); gc.stroke();
    if (sel && w > 30) {
      gc.fillStyle = '#fff';
      gc.fillRect(x + 1, y + hh / 2 - 10, 3, 20); gc.fillRect(x + w - 4, y + hh / 2 - 10, 3, 20);
    }
    gc.restore();
  }

  // Toma en curso: clip rojo con la onda que va llegando del micrófono
  function drawRecording(gc, t, y0, w) {
    const r = studio.rec, a = X(r.b0), b = X(studio.heardBeat());
    if (b <= a) return;
    const y = y0 + 1, hh = t.h - 3;
    rr(gc, a, y, b - a, hh, 3); gc.fillStyle = '#e8484d'; gc.fill();
    gc.fillStyle = '#b8282d'; gc.fillRect(a, y, b - a, 14);
    gc.fillStyle = '#fff'; gc.font = '600 10px ' + FONT; gc.fillText('● Grabando', a + 5, y + 10);
    const lp = r.lp; if (!lp?.length) return;
    const lat = (app.state.settings.micLatency || 0) / 1000, sp = spb(), per = 256 / r.sr;
    const by = y + 15, bh = hh - 16, mid = by + bh / 2, amp = bh / 2 - 1;
    gc.fillStyle = 'rgba(0,0,0,0.7)';
    const n = lp.length / 2;
    for (let px = Math.max(0, Math.floor(a)); px < Math.min(w, b); px++) {
      // segundos dentro de la toma (ya corridos por la demora del micrófono)
      const s0 = (B(px) - r.b0) * sp + lat, s1 = (B(px + 1) - r.b0) * sp + lat;
      let k0 = Math.floor(s0 / per), k1 = Math.max(k0 + 1, Math.floor(s1 / per));
      if (k0 >= n) break; k0 = Math.max(0, k0); k1 = Math.min(n, k1);
      let lo = 0, hi = 0;
      for (let k = k0; k < k1; k++) { if (lp[2 * k] < lo) lo = lp[2 * k]; if (lp[2 * k + 1] > hi) hi = lp[2 * k + 1]; }
      gc.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
  }

  // Automatización: línea con puntos sobre la pista
  function drawAuto(gc, t, y0, w) {
    const tg = autoTargets(t).find(a => a.key === t.autoKey) || autoTargets(t)[0];
    const pts = t.auto?.[tg.key] || [];
    const top = y0 + 6, hh = t.h - 14;
    const Y = v => top + hh - norm(tg, v) * hh;
    gc.strokeStyle = t.color; gc.lineWidth = 2;
    gc.beginPath();
    if (!pts.length) {
      const v = tg.key === 'vol' ? t.vol : tg.key === 'pan' ? t.pan : tg.key === 'rev' ? t.rev : tg.key === 'dly' ? t.dly : null;
      gc.setLineDash([4, 4]);
      gc.moveTo(0, Y(v ?? (tg.min + tg.max) / 2)); gc.lineTo(w, Y(v ?? (tg.min + tg.max) / 2));
      gc.stroke(); gc.setLineDash([]);
    } else {
      gc.moveTo(0, Y(pts[0][1]));
      for (const [b, v] of pts) gc.lineTo(X(b), Y(v));
      gc.lineTo(w, Y(pts[pts.length - 1][1]));
      gc.stroke();
      gc.fillStyle = '#fff';
      for (const [b, v] of pts) { gc.beginPath(); gc.arc(X(b), Y(v), 4, 0, 7); gc.fill(); gc.strokeStyle = t.color; gc.stroke(); }
    }
    gc.fillStyle = ink(0.8); gc.font = '10px ' + FONT;
    gc.fillText('⟋ ' + tg.label, 8, y0 + t.h - 6);
  }

  function paintRuler() {
    const { g: gc, w, h: hh } = fitCanvas(ruler);
    gc.fillStyle = T.ruler; gc.fillRect(0, 0, w, hh);
    gc.fillStyle = '#151515'; gc.fillRect(0, 15, w, 1);
    // Llave del loop (franja de arriba)
    const la = X(st.loop.a), lb = X(st.loop.b);
    gc.fillStyle = st.loop.on ? T.loopOn : T.loopOff;
    gc.fillRect(la, 3, Math.max(4, lb - la), 10);
    gc.fillStyle = st.loop.on ? '#1a1a1a' : '#2a2a2a';
    gc.fillRect(la + 4, 6, Math.max(0, lb - la - 8), 4);
    // Números de compás
    const step = st.zoom * 4 < 26 ? (st.zoom * 4 < 8 ? 16 : 4) : 1;
    gc.font = '11px ' + FONT;
    for (let bar = Math.floor(st.sx / 4); X(bar * 4) < w; bar++) {
      const x = Math.round(X(bar * 4)) + 0.5;
      if (bar % step === 0) { gc.fillStyle = T.rulerText; gc.fillText(String(bar + 1), x + 3, hh - 5); gc.fillStyle = '#5a5a5a'; gc.fillRect(x, 16, 1, hh - 16); }
      else if (st.zoom > 4) { gc.fillStyle = '#444'; gc.fillRect(x, hh - 6, 1, 6); }
    }
    // Marcador de inicio
    const px = X(st.pos);
    gc.fillStyle = T.text;
    gc.beginPath(); gc.moveTo(px - 6, 16); gc.lineTo(px + 6, 16); gc.lineTo(px, 23); gc.fill();
    if (studio.playing) { gc.fillStyle = studio.rec ? T.rec : T.playhead; gc.fillRect(Math.round(X(studio.heardBeat())), 16, 2, hh - 16); }
  }

  // ---- Encabezados de pista (derecha) ----
  function renderHeads() {
    headsIn.innerHTML = '';
    st.tracks.forEach((t, i) => headsIn.append(trackHead(t, i)));
    headsIn.append(h('div', { class: 'sth-add' },
      h('button', { class: 'pill', onclick: () => addTrack('audio') }, '＋ Audio'),
      h('button', { class: 'pill', onclick: () => addTrack('midi') }, '＋ MIDI')));
    rulerSide.innerHTML = '';
    rulerSide.append(h('span', {}, st.tracks.length + ' pistas'));
    draw();
  }

  function trackHead(t, i) {
    const sel = t.id === st.sel.track;
    const name = h('div', { class: 'sth-name' }, t.kind === 'audio' ? '〰 ' : t.inst?.type === 'drums' ? '🥁 ' : t.inst?.type === 'sampler' ? '🎻 ' : '🎹 ', t.name);
    const act = h('button', { class: 'sth-b act' + (t.mute ? '' : ' on'), title: 'Prender / apagar (mute)' }, String(i + 1));
    act.addEventListener('click', e => { e.stopPropagation(); t.mute = !t.mute; studio.applyMix(); renderHeads(); app.emit('studio-draw'); });
    const solo = h('button', { class: 'sth-b solo' + (t.solo ? ' on' : ''), title: 'Solo' }, 'S');
    solo.addEventListener('click', e => { e.stopPropagation(); t.solo = !t.solo; studio.applyMix(); renderHeads(); app.emit('studio-draw'); });
    const arm = h('button', { class: 'sth-b arm' + (t.arm ? ' on' : ''), title: t.kind === 'audio' ? 'Armar para grabar el micrófono' : 'Armar para grabar lo que tocás' }, '⏺');
    arm.addEventListener('click', e => { e.stopPropagation(); t.arm = !t.arm; studio.sync(); renderHeads(); });
    const auto = h('button', { class: 'sth-b' + (t.autoOn ? ' on' : ''), title: 'Automatización: dibujá cómo cambia un parámetro' }, 'A');
    auto.addEventListener('click', e => { e.stopPropagation(); t.autoOn = !t.autoOn; if (t.autoOn && t.h < 90) t.h = 110; renderHeads(); });
    const btns = h('div', { class: 'sth-btns' }, act, solo, arm, auto);
    if (t.kind === 'audio') {
      const mon = h('button', { class: 'sth-b' + (t.mon ? ' on' : ''), title: 'Escuchar la entrada con los efectos de la pista (cuando está armada)' }, '🎧');
      mon.addEventListener('click', e => { e.stopPropagation(); t.mon = !t.mon; if (t.mon && !t.arm) t.arm = true; studio.sync(); renderHeads(); });
      btns.append(mon);
    }
    const fader = mfader(t.vol, v => { t.vol = v; studio.applyTrack(t); }, t.color);
    const meter = h('i', { class: 'sth-meter' });
    const more = h('button', { class: 'sth-more', title: 'Opciones de la pista' }, '⋯');
    more.addEventListener('click', e => { e.stopPropagation(); trackMenu(more, t); });
    const el = h('div', { class: 'sth' + (sel ? ' sel' : '') + (heard(t) ? '' : ' muted') },
      h('div', { class: 'sth-top' }, name, more), btns, h('div', { class: 'sth-vol' }, fader, meter));
    el.style.setProperty('--c', t.color);
    el.style.height = t.h + 'px';
    if (t.autoOn) {
      const tgs = autoTargets(t);
      const cur = tgs.find(a => a.key === t.autoKey) || tgs[0];
      const pick = h('button', { class: 'sth-auto' }, '⟋ ' + cur.label + ' ▾');
      pick.addEventListener('click', e => {
        e.stopPropagation();
        popover(pick, [h('h4', {}, 'Automatizar'), ...tgs.map(a => h('button', { class: 'menu-item' + (a.key === cur.key ? ' on' : ''), onclick: () => { t.autoKey = a.key; closePopover(); renderHeads(); } },
          (t.auto?.[a.key]?.length ? '● ' : '') + a.label)),
        h('button', { class: 'menu-item', onclick: () => { snapshot('Borrar automatización'); delete t.auto[cur.key]; closePopover(); studio.applyTrack(t); renderHeads(); } }, '🗑 Borrar esta automatización')]);
      });
      el.append(pick);
    }
    el.addEventListener('click', () => selectTrack(t));
    let lastTap = 0;
    name.addEventListener('pointerup', () => { const n = performance.now(); if (n - lastTap < 320) renameTrack(t); lastTap = n; });
    el._meter = meter; el._t = t;
    return el;
  }

  function selectTrack(t) {
    const changed = st.sel.track !== t.id;
    st.sel.track = t.id;
    if (st.detail === 'clip' && !(selClip()?.t === t)) st.detail = 'devices';
    if (changed || st.detail !== 'devices') app.emit('studio-sel');
  }
  function selectClip(t, c, add = false) {
    if (add) {
      // sumar o sacar este clip de la selección
      const ids = new Set(many); if (st.sel.clip) ids.add(st.sel.clip);
      if (ids.has(c.id)) ids.delete(c.id); else ids.add(c.id);
      const list = [...ids];
      st.sel.clip = ids.has(c.id) ? c.id : list[list.length - 1] || null;
      many.clear(); list.forEach(id => { if (id !== st.sel.clip) many.add(id); });
      if (st.sel.clip === c.id) st.sel.track = t.id;
      draw(); app.emit('studio-sel');
      if (ids.size > 1) toast(`${ids.size} clips elegidos`, 1000);
      return;
    }
    many.clear();
    st.sel.track = t.id; st.sel.clip = c.id;
    if (st.detail !== 'mixer') st.detail = 'clip';
    if (S().detailH < 60) S().detailH = defaultDetailH();
    app.emit('studio-sel');
  }

  function renameTrack(t) {
    const v = prompt('Nombre de la pista', t.name);
    if (v != null && v.trim()) { snapshot('Renombrar pista'); t.name = v.trim().slice(0, 32); renderHeads(); app.emit('studio-sel'); }
  }

  function addTrack(kind, opts = {}) {
    snapshot('Pista nueva');
    const t = newTrack(kind, opts);
    const at = st.tracks.findIndex(x => x.id === st.sel.track);
    st.tracks.splice(at >= 0 ? at + 1 : st.tracks.length, 0, t);
    st.sel.track = t.id; st.sel.clip = null; st.detail = 'devices';
    studio.sync(); app.emit('studio');
    return t;
  }

  function trackMenu(anchor, t) {
    popover(anchor, [
      h('h4', {}, t.name),
      h('button', { class: 'menu-item', onclick: () => { closePopover(); renameTrack(t); } }, '✎ Renombrar'),
      h('div', { class: 'swatches' }, ...COLORS.map(c => h('button', { class: 'sw' + (c === t.color ? ' on' : ''), style: { background: c }, onclick: () => { snapshot('Color'); t.color = c; closePopover(); app.emit('studio'); } }))),
      h('div', { class: 'chips' }, ...[['Chica', 52], ['Media', 76], ['Grande', 120], ['Enorme', 180]].map(([l, v]) => h('button', { class: 'chip' + (t.h === v ? ' on' : ''), onclick: () => { t.h = v; closePopover(); renderHeads(); } }, l))),
      h('button', { class: 'menu-item', onclick: () => {
        closePopover(); snapshot('Duplicar pista');
        const d = clone(t); d.id = uid('t'); d.name = t.name + ' 2'; d.clips.forEach(c => { c.id = uid('c'); }); d.devices.forEach(x => { x.id = uid('d'); }); d.arm = false;
        // la automatización apunta a los dispositivos por id: se renombra
        const map = {}; t.devices.forEach((x, k) => { map[x.id] = d.devices[k].id; });
        d.auto = Object.fromEntries(Object.entries(d.auto || {}).map(([k, v]) => [k.replace(/^d:([^:]+)/, (m, id) => 'd:' + (map[id] || id)), v]));
        st.tracks.splice(st.tracks.indexOf(t) + 1, 0, d); studio.sync(); app.emit('studio');
      } }, '⧉ Duplicar pista'),
      h('button', { class: 'menu-item', onclick: () => { closePopover(); studio.bounce(t); } }, '🧊 Pasar a audio (congelar con efectos)'),
      h('button', { class: 'menu-item danger', onclick: () => {
        closePopover(); snapshot('Borrar pista');
        st.tracks = st.tracks.filter(x => x !== t);
        if (st.sel.track === t.id) { st.sel.track = st.tracks[0]?.id || null; st.sel.clip = null; }
        studio.sync(); app.emit('studio');
      } }, '🗑 Borrar pista'),
    ]);
  }

  // ---- Interacción con los carriles ----
  function hit(p, touch = false) {
    const tr = trackAt(p.y);
    const b = B(p.x);
    if (!tr) return { b };
    const { t, y0 } = tr;
    const clip = t.clips.find(c => b >= c.start && b < c.start + c.len) || null;
    let edge = null;
    if (clip) {
      // Zona de los bordes generosa (más todavía en el clip elegido, que muestra agarraderas)
      const xl = X(clip.start), xr = X(clip.start + clip.len), wc = xr - xl;
      const near = Math.min(wc / 3, (touch ? 20 : 14) + (clip.id === st.sel.clip ? 6 : 0));
      if (p.x - xl < near) edge = 'L'; else if (xr - p.x < near) edge = 'R';
    } else {
      // un poco afuera del borde derecho también agarra
      const c2 = t.clips.find(c => p.x - X(c.start + c.len) >= 0 && p.x - X(c.start + c.len) < (touch ? 16 : 10));
      if (c2) return { t, y0, b, clip: c2, edge: 'R' };
    }
    return { t, y0, b, clip, edge };
  }

  function dragClip(hh, p, e, copy) {
    if (isSel(hh.clip) && selected().length > 1 && !copy) return dragMany(hh, p);
    const c0 = hh.clip;
    let t = hh.t, c = c0, began = false;
    const b0 = B(p.x), orig = c0.start;
    return {
      move(q, ev) {
        if (!began) {
          began = true;
          snapshot(copy ? 'Copiar clip' : 'Mover clip');
          if (copy) { c = clone(c0); c.id = uid('c'); t.clips.push(c); }
        }
        const free = ev?.altKey || st.grid === 'off';
        let ns = orig + B(q.x) - b0;
        ns = Math.max(0, free ? ns : snapB(ns, g()));
        const tr = trackAt(q.y)?.t;
        if (tr && tr !== t && tr.kind === c.kind) { t.clips = t.clips.filter(x => x !== c); tr.clips.push(c); t = tr; st.sel.track = t.id; }
        c.start = ns; draw();
      },
      up(q, ev) { if (began) { removeOverlaps(t, c); st.sel.clip = c.id; app.emit('studio'); } else if (!st.multi && !ev?.shiftKey) selectClip(t, c); },
    };
  }

  // Varios clips elegidos: se mueven juntos en el tiempo (cada uno en su pista)
  function dragMany(hh, p) {
    const list = selected(), b0 = B(p.x), anchor = hh.clip.start;
    const orig = new Map(list.map(x => [x.c, x.c.start]));
    const minStart = Math.min(...list.map(x => x.c.start));
    let began = false;
    return {
      move(q, ev) {
        if (!began) { began = true; snapshot(`Mover ${list.length} clips`); }
        const free = ev?.altKey || st.grid === 'off';
        let d = (free ? anchor + B(q.x) - b0 : snapB(anchor + B(q.x) - b0, g())) - anchor;
        d = Math.max(-minStart, d);
        for (const [c, s0] of orig) c.start = s0 + d;
        draw();
      },
      up(q, ev) { if (began) { for (const x of list) removeOverlaps(x.t, x.c); app.emit('studio'); } else if (!st.multi && !ev?.shiftKey) selectClip(hh.t, hh.clip); },
    };
  }

  function resizeClip(hh, side) {
    const t = hh.t, c = hh.clip;
    let began = false;
    const end0 = c.start + c.len, start0 = c.start;
    const orig = clone(c);
    return {
      move(q, ev) {
        if (!began) { began = true; snapshot('Estirar clip'); selectClip(t, c); }
        const free = ev?.altKey || st.grid === 'off', gg = g() || 0.25;
        let b = B(q.x); if (!free) b = snapB(b, gg);
        if (side === 'R') {
          let len = Math.max(free ? 0.0625 : gg, b - c.start);
          if (c.kind === 'audio') { const buf = getBuffer(c.buf); if (buf) len = Math.min(len, (buf.duration - c.off) / (c.warp ? 60 / c.bpm : spb())); }
          c.len = len;
        } else {
          let ns = Math.min(b, end0 - (free ? 0.0625 : gg));
          if (c.kind === 'audio') {
            const bs = c.warp ? 60 / c.bpm : spb();
            ns = Math.max(ns, start0 - orig.off / bs, 0);
            c.off = orig.off + (ns - start0) * bs;
          } else {
            ns = Math.max(0, ns);
            // contenido fijo en el tiempo: se despliegan las notas
            const notes = clipNotes(orig, Math.max(ns, start0), end0).map(n => ({ p: n.p, s: n.s - ns, d: n.d, v: n.v }));
            c.notes = notes; c.loop = end0 - ns;
          }
          c.start = ns; c.len = end0 - ns;
        }
        draw();
      },
      up() { if (began) { removeOverlaps(t, c); app.emit('studio'); } else selectClip(t, c); },
    };
  }

  function createClipDrag(hh) {
    const t = hh.t, a = Math.max(0, snapB(hh.b, g() || 1, 'floor'));
    ghost = { t, a, b: a + Math.max(g() || 1, 1) };
    return {
      move(q) { const b = snapB(B(q.x), g() || 1, 'ceil'); ghost.b = Math.max(a + (g() || 1), b); draw(); },
      up(q, ev, tap) {
        const len = tap ? 4 : ghost.b - a;
        ghost = null;
        snapshot('Clip nuevo');
        const c = newMidiClip(a, len, t.color);
        t.clips.push(c); removeOverlaps(t, c);
        selectClip(t, c); app.emit('studio');
      },
    };
  }

  function selDrag(hh, p) {
    const a = hh.b;
    return {
      move(q) {
        const tr = trackAt(q.y)?.t || hh.t;
        const i0 = st.tracks.indexOf(hh.t), i1 = st.tracks.indexOf(tr);
        tsel = { a: Math.max(0, snapB(a, g())), b: Math.max(0, snapB(B(q.x), g())), t0: st.tracks[Math.min(i0, i1)], t1: st.tracks[Math.max(i0, i1)] };
        draw();
      },
      up(q, ev, tap) {
        if (tap) { tsel = null; setCursor(hh); }
        else if (tsel && Math.abs(tsel.b - tsel.a) < 1e-6) tsel = null;
        else if (tsel) {
          // quedan elegidos los clips que toca el rectángulo
          const a = Math.min(tsel.a, tsel.b), b = Math.max(tsel.a, tsel.b);
          many.clear(); st.sel.clip = null;
          for (const t of st.tracks.slice(st.tracks.indexOf(tsel.t0), st.tracks.indexOf(tsel.t1) + 1)) {
            for (const c of t.clips) if (c.start < b && c.start + c.len > a) { if (st.sel.clip) many.add(c.id); else { st.sel.clip = c.id; st.sel.track = t.id; } }
          }
          app.emit('studio-sel');
        }
        draw();
      },
    };
  }

  function setCursor(hh) {
    st.pos = Math.max(0, snapB(hh.b, g(), 'floor'));
    st.sel.clip = null; many.clear();
    selectTrack(hh.t);
    if (studio.playing) { studio.stop(); studio.play(); }
    draw(); app.emit('studio-sel');
  }

  // Automatización: tocar agrega un punto, arrastrar mueve, doble toque borra
  function autoDrag(hh, p, e, tap = false) {
    const t = hh.t;
    const tg = autoTargets(t).find(a => a.key === t.autoKey) || autoTargets(t)[0];
    t.auto ||= {};
    const top = hh.y0 + 6, ah = t.h - 14;
    const val = y => denorm(tg, Math.max(0, Math.min(1, (top + ah - y) / ah)));
    snapshot('Automatización', 'auto' + t.id);
    let pts = t.auto[tg.key] ||= [];
    // punto cercano
    let k = pts.findIndex(([b, v]) => Math.hypot(X(b) - p.x, (top + ah - norm(tg, v) * ah) - p.y) < 14);
    if (k < 0) {
      const b = Math.max(0, st.grid === 'off' ? B(p.x) : snapB(B(p.x), g()));
      pts.push([b, val(p.y)]); pts.sort((x, y) => x[0] - y[0]);
      k = pts.findIndex(x => x[0] === b);
    }
    const isDraw = st.draw;
    let last = performance.now();
    draw();
    return {
      move(q) {
        if (isDraw) {
          // modo dibujo: va dejando puntos en la grilla
          const b = Math.max(0, snapB(B(q.x), g() || 0.25));
          pts = t.auto[tg.key] = pts.filter(x => Math.abs(x[0] - b) > 1e-6);
          pts.push([b, val(q.y)]); pts.sort((x, y) => x[0] - y[0]);
        } else {
          const b = Math.max(0, st.grid === 'off' ? B(q.x) : snapB(B(q.x), g()));
          pts[k] = [b, val(q.y)];
          pts.sort((x, y) => x[0] - y[0]);
          k = pts.findIndex(x => x[0] === b);
        }
        last = performance.now();
        if (!studio.playing) studio.applyTrack(t);
        draw();
      },
      up(q, ev, tapped) {
        if (tapped && dblAuto.t > performance.now() - 330 && dblAuto.k === k) { pts.splice(k, 1); dblAuto.t = 0; }
        else dblAuto = { t: performance.now(), k };
        draw();
      },
    };
  }
  let dblAuto = { t: 0, k: -1 };

  gestures(lanes, {
    drawTouch: () => st.draw,
    // Dedo sobre las agarraderas del clip elegido: estira directo, sin mantener apretado
    grab(p) {
      const hh = hit(p, true);
      if (hh.clip && hh.edge && hh.clip.id === st.sel.clip && !hh.t.autoOn) return resizeClip(hh, hh.edge);
      return null;
    },
    down(p, e) {
      const hh = hit(p, e.pointerType === 'touch');
      tsel = null;
      if (!hh.t) return null;
      if (hh.t.autoOn) return autoDrag(hh, p, e);
      if (hh.clip) {
        return hh.edge && !st.multi ? resizeClip(hh, hh.edge) : dragClip(hh, p, e, e.altKey);
      }
      if (st.draw && hh.t.kind === 'midi') return createClipDrag(hh);
      return selDrag(hh, p);
    },
    long(p) {
      const hh = hit(p, true);
      if (!hh.t) return null;
      if (hh.t.autoOn) return autoDrag(hh, p, {});
      if (hh.clip) return hh.edge ? resizeClip(hh, hh.edge) : dragClip(hh, p, {}, false);
      return selDrag(hh, p);
    },
    tap(p, e, dbl) {
      const hh = hit(p, e.pointerType === 'touch');
      if (!hh.t) { st.sel.clip = null; many.clear(); tsel = null; app.emit('studio-sel'); return; }
      if (hh.t.autoOn && e.pointerType === 'touch') return;
      if (hh.clip) {
        // con el modo ☑ Varios (o Shift/Ctrl) cada toque suma o saca el clip
        const add = st.multi || e.shiftKey || e.ctrlKey || e.metaKey;
        selectClip(hh.t, hh.clip, add);
        return;
      }
      if (st.multi) return;
      if (dbl && hh.t.kind === 'midi') {
        snapshot('Clip nuevo');
        const a = Math.floor(hh.b / 4) * 4, c = newMidiClip(a, 4, hh.t.color);
        hh.t.clips.push(c); removeOverlaps(hh.t, c); selectClip(hh.t, c); app.emit('studio');
        return;
      }
      tsel = null; setCursor(hh);
    },
    context(p, e) { contextMenu(p, e); },
    hover(p) {
      if (!p) { if (hover) { hover = null; draw(); } return; }
      const hh = hit(p);
      hover = hh.t ? hh : null;
      lanes.style.cursor = hh.edge ? 'ew-resize' : hh.clip ? 'grab' : hh.t?.autoOn ? 'crosshair' : st.draw ? 'crosshair' : 'default';
      draw();
    },
    pan(dx, dy) { st.sx -= dx / st.zoom; st.sy -= dy; draw(); },
    pinch(r, cx, cy, dx, dy) { const b = B(cx); st.zoom *= r; clamp(); st.sx = b - cx / st.zoom - dx / st.zoom; st.sy -= dy; draw(); },
    wheel(p, e) {
      if (e.ctrlKey || e.metaKey) { const b = B(p.x); st.zoom *= Math.exp(-e.deltaY * 0.0025); clamp(); st.sx = b - p.x / st.zoom; }
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) st.sx += (e.deltaX || e.deltaY) / st.zoom;
      else st.sy += e.deltaY;
      draw();
    },
  });

  function contextMenu(p, e) {
    const hh = hit(p, e.pointerType === 'touch');
    const anchor = pointAnchor(e.clientX, e.clientY);
    if (tsel) {
      const a = Math.min(tsel.a, tsel.b), b = Math.max(tsel.a, tsel.b), sel = tsel;
      popover(anchor, [
        h('h4', {}, `Selección · ${((b - a) / 4).toFixed(2).replace(/\.00$/, '')} compases`),
        h('button', { class: 'menu-item', onclick: () => { st.loop = { on: true, a, b }; closePopover(); tsel = null; app.emit('studio'); } }, '🔁 Hacer loop acá'),
        h('button', { class: 'menu-item', onclick: () => {
          closePopover(); snapshot('Clip nuevo');
          const ts = st.tracks.slice(st.tracks.indexOf(sel.t0), st.tracks.indexOf(sel.t1) + 1).filter(t => t.kind === 'midi');
          ts.forEach(t => { const c = newMidiClip(a, b - a, t.color); t.clips.push(c); removeOverlaps(t, c); });
          tsel = null; app.emit('studio');
        } }, '＋ Clip MIDI vacío acá'),
        h('button', { class: 'menu-item', onclick: () => {
          closePopover(); snapshot('Dividir');
          const ts = st.tracks.slice(st.tracks.indexOf(sel.t0), st.tracks.indexOf(sel.t1) + 1);
          for (const t of ts) for (const x of [a, b]) {
            const c = t.clips.find(c => x > c.start + 1e-3 && x < c.start + c.len - 1e-3);
            if (c) { const r = splitRight(c, x); c.len = x - c.start; if (c.kind === 'midi') c.loop = Math.min(c.loop, c.len); t.clips.push(r); }
          }
          tsel = null; app.emit('studio');
        } }, '✂ Dividir los clips en los bordes'),
        h('button', { class: 'menu-item danger', onclick: () => {
          closePopover(); snapshot('Borrar tiempo');
          const ts = st.tracks.slice(st.tracks.indexOf(sel.t0), st.tracks.indexOf(sel.t1) + 1);
          for (const t of ts) {
            const tmp = newMidiClip(a, b - a); tmp.kind = '__cut';
            t.clips.push(tmp); removeOverlaps(t, tmp); t.clips = t.clips.filter(c => c !== tmp);
          }
          tsel = null; app.emit('studio');
        } }, '🗑 Borrar lo seleccionado'),
      ]);
      return;
    }
    if (hh.clip) {
      const { t, clip: c } = hh;
      selectClip(t, c);
      const items = [
        h('h4', {}, c.name || (c.kind === 'midi' ? 'Clip MIDI' : 'Clip de audio')),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); duplicateClip(t, c); } }, '⧉ Duplicar  (Ctrl+D)'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); splitAt(t, c, Math.max(c.start, snapB(hh.b, g()))); } }, '✂ Dividir acá'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); st.loop = { on: true, a: c.start, b: c.start + c.len }; app.emit('studio'); } }, '🔁 Loop en este clip'),
        h('button', { class: 'menu-item', onclick: () => {
          closePopover(); const v = prompt('Nombre del clip', c.name || ''); if (v != null) { snapshot('Renombrar clip'); c.name = v.slice(0, 40); app.emit('studio'); }
        } }, '✎ Renombrar'),
        h('div', { class: 'swatches' }, ...COLORS.map(col => h('button', { class: 'sw' + (col === c.color ? ' on' : ''), style: { background: col }, onclick: () => { snapshot('Color'); c.color = col; closePopover(); app.emit('studio'); } }))),
      ];
      if (c.kind === 'audio') items.push(
        h('button', { class: 'menu-item', onclick: () => { closePopover(); audioOp(t, c, 'rev'); } }, '⇄ Al revés'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); audioOp(t, c, 'norm'); } }, '📈 Normalizar'),
      );
      items.push(h('button', { class: 'menu-item danger', onclick: () => { closePopover(); deleteClip(t, c); } }, '🗑 Borrar  (Supr)'));
      popover(anchor, items);
      return;
    }
    if (hh.t) {
      const t = hh.t, b = Math.max(0, snapB(hh.b, g(), 'floor'));
      const items = [h('h4', {}, t.name)];
      if (t.kind === 'midi') items.push(h('button', { class: 'menu-item', onclick: () => {
        closePopover(); snapshot('Clip nuevo');
        const c = newMidiClip(Math.floor(b / 4) * 4, 4, t.color); t.clips.push(c); removeOverlaps(t, c); selectClip(t, c); app.emit('studio');
      } }, '＋ Clip MIDI de 1 compás'));
      if (clipboard && clipboard.kind === (t.kind === 'midi' ? 'midi' : 'audio')) items.push(h('button', { class: 'menu-item', onclick: () => {
        closePopover(); snapshot('Pegar clip');
        const c = clone(clipboard); c.id = uid('c'); c.start = b; t.clips.push(c); removeOverlaps(t, c); selectClip(t, c); app.emit('studio');
      } }, '📋 Pegar clip acá'));
      items.push(h('button', { class: 'menu-item', onclick: () => { closePopover(); trackMenu(anchor, t); } }, '⋯ Opciones de la pista'));
      popover(anchor, items);
    }
  }

  // ---- Regla: inicio y región de loop ----
  gestures(ruler, {
    drawTouch: () => true,
    down(p) {
      const b = B(p.x);
      if (p.y < 15) {
        const la = X(st.loop.a), lb = X(st.loop.b);
        const mode = Math.abs(p.x - la) < 12 ? 'a' : Math.abs(p.x - lb) < 12 ? 'b' : p.x > la && p.x < lb ? 'move' : 'new';
        const o = { ...st.loop }, b0 = b;
        return {
          move(q) {
            const nb = Math.max(0, snapB(B(q.x), g() || 1));
            if (mode === 'a') st.loop.a = Math.min(nb, st.loop.b - (g() || 1));
            else if (mode === 'b') st.loop.b = Math.max(nb, st.loop.a + (g() || 1));
            else if (mode === 'move') { const d = snapB(B(q.x) - b0, g() || 1); st.loop.a = Math.max(0, o.a + d); st.loop.b = st.loop.a + (o.b - o.a); }
            else { const s = Math.max(0, snapB(b0, g() || 1, 'floor')); st.loop.a = Math.min(s, nb); st.loop.b = Math.max(s, nb); if (st.loop.b - st.loop.a < (g() || 1)) st.loop.b = st.loop.a + (g() || 1); }
            st.loop.on = true;
            app.emit('studio-loop'); draw();
          },
          up(q, e, tap) { if (tap) { st.loop.on = !st.loop.on; app.emit('studio-loop'); } draw(); },
        };
      }
      return { move(q) { st.pos = Math.max(0, snapB(B(q.x), g())); draw(); }, up(q) { st.pos = Math.max(0, snapB(B(q.x), g())); if (studio.playing) { studio.stop(); studio.play(); } draw(); } };
    },
    pinch(r, cx) { const b = B(cx); st.zoom *= r; clamp(); st.sx = b - cx / st.zoom; draw(); },
    wheel(p, e) { const b = B(p.x); st.zoom *= Math.exp(-e.deltaY * 0.0025); clamp(); st.sx = b - p.x / st.zoom; draw(); },
  });

  // ---- Soltar cosas del navegador ----
  function dropInfo(clientX, clientY) {
    const r = lanes.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
      const hr = heads.getBoundingClientRect();
      if (clientX >= hr.left && clientX <= hr.right && clientY >= hr.top && clientY <= hr.bottom) {
        const tr = trackAt(clientY - hr.top);
        return tr ? { t: tr.t, b: st.pos } : { t: null, b: st.pos };
      }
      return null;
    }
    const p = { x: clientX - r.left, y: clientY - r.top };
    const tr = trackAt(p.y);
    return { t: tr?.t || null, b: Math.max(0, snapB(B(p.x), g() || 1, 'floor')) };
  }

  function audioOp(t, c, op) {
    const buf = getBuffer(c.buf); if (!buf) return;
    snapshot(op === 'rev' ? 'Al revés' : 'Normalizar');
    const out = op === 'rev' ? reverseRange(buf, 0, buf.length) : normalizeBuffer(buf);
    if (op === 'rev') { const bs = c.warp ? 60 / c.bpm : spb(); c.off = Math.max(0, buf.duration - c.off - c.len * bs); }
    c.buf = putBuffer(out);
    app.emit('studio');
  }

  // ---- Animación ----
  let lastPos = '', wasPlaying = false;
  return {
    draw, renderHeads, trackAt, selectClip, selectTrack, addTrack, audioOp, many, deleteSelected,
    X, B,
    dropInfo,
    setDrop(d) { drop = d; draw(); },
    frame() {
      const b = studio.playing ? studio.heardBeat() : st.pos;
      const bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, six = Math.floor((b % 1) * 4) + 1;
      const s = `${bar}.${beat}.${six}`;
      if (s !== lastPos) { posLbl.textContent = s; lastPos = s; }
      if (studio.playing) {
        let dirty = !!(studio.rec);
        if (st.follow) {
          const w = lanes.clientWidth, x = X(b);
          if (x > w - 40 || x < 0) { st.sx = Math.max(0, b - 1); dirty = true; }
        }
        if (dirty) paint(); else { compose(); paintRuler(); }
        wasPlaying = true;
      } else if (wasPlaying) { wasPlaying = false; paint(); }
      // Medidores de las pistas
      for (const el of headsIn.children) {
        if (!el._meter) continue;
        const lv = studio.ta(el._t.id)?.level() || 0;
        el._meter.style.transform = `scaleX(${Math.min(1, Math.sqrt(lv))})`;
      }
    },
  };
}

// Valor normalizado 0..1 de un parámetro automatizable
export function norm(tg, v) {
  if (tg.log) return Math.log(v / tg.min) / Math.log(tg.max / tg.min);
  return (v - tg.min) / (tg.max - tg.min);
}
export function denorm(tg, n) {
  if (tg.log) return tg.min * Math.pow(tg.max / tg.min, n);
  return tg.min + n * (tg.max - tg.min);
}

// Fader horizontal chiquito (volumen de la pista)
export function mfader(v, onInput, color) {
  const fill = h('i');
  const el = h('div', { class: 'mfader', title: 'Volumen · doble toque = 0 dB' }, fill);
  if (color) el.style.setProperty('--c', color);
  const set = x => { v = Math.max(0, Math.min(1, x)); fill.style.width = (v * 100) + '%'; el.title = 'Volumen ' + (v > 0.001 ? (20 * Math.log10(faderGain(v))).toFixed(1) + ' dB' : '−∞'); };
  let d = null, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const now = performance.now();
    if (now - lastTap < 300) { set(0.8); onInput(v); return; }
    lastTap = now;
    el.setPointerCapture(e.pointerId); d = { x: e.clientX, v };
  });
  el.addEventListener('pointermove', e => { if (!d) return; set(d.v + (e.clientX - d.x) / el.clientWidth); onInput(v); });
  el.addEventListener('pointerup', () => { d = null; });
  el.addEventListener('click', e => e.stopPropagation());
  set(v);
  el.set = set;
  return el;
}

function rr(gc, x, y, w, hh, r) {
  r = Math.min(r, w / 2, hh / 2);
  gc.beginPath();
  gc.moveTo(x + r, y); gc.arcTo(x + w, y, x + w, y + hh, r); gc.arcTo(x + w, y + hh, x, y + hh, r);
  gc.arcTo(x, y + hh, x, y, r); gc.arcTo(x, y, x + w, y, r); gc.closePath();
}
// Portapapeles de clips (lo usa también la vista de detalle)
export let clipboard = null;
export function copyClip(c) { clipboard = clone(c); toast('📋 Clip copiado: tocá con el botón del lápiz donde pegarlo'); }
