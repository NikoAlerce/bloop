// Vista de detalle del Estudio (abajo): Clip (piano roll / grilla de batería / onda de audio),
// Dispositivos (efectos MIDI → instrumento → efectos de audio, de izquierda a derecha)
// y Mezcla (todas las pistas como canales).
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { h, popover, closePopover, toast, toggle } from '../ui/util.js';
import { T, FONT, ink, dark, tint } from './theme.js';
const isLight = () => false;
import { knob } from '../ui/knob.js';
import { SYNTH_SPECS } from '../ui/params.js';
import { allPresets } from '../ui/presets.js';
import { presetById, setCustomSample } from '../actions.js';
import { PRESET_CATS, PRESET_DEFAULTS } from '../audio/presets.js';
import { noteName, NOTE_NAMES, SCALES } from '../scales.js';
import { silenceRange, deleteRange, copyRange } from '../audio/edit.js';
import {
  S, uid, clone, spb, selClip, selTrack, findTrack, gridBeats, snapB, getBuffer, putBuffer, peaksOf, clipNotes,
  DRUM_NOTE, DRUM_PADS, srcName, synthInst, drumInst, samplerInst, audible,
} from './model.js';
import { studio, faderGain, silentHint, heard } from './engine.js';
import { AUDIO_FX, MIDI_FX, AUDIO_FX_KEYS, MIDI_FX_KEYS, defaultsOf } from './devices.js';
import { gestures, fitCanvas, pointAnchor } from './gest.js';
import { snapshot, norm, denorm, mfader, splitAt, copyClip, defaultDetailH } from './ui.js';
import { playSurface } from './keys.js';

export function buildDetail(el, { arr }) {
  const st = S();
  const tabs = h('div', { class: 'st-dtabs' });
  const bodyEl = h('div', { class: 'st-dbody' });
  el.append(tabs, bodyEl);
  let view = null; // editor actual {draw(), frame(), deleteSel()}

  function setTab(k) {
    st.detail = k;
    if (st.detailH < 60) { st.detailH = defaultDetailH(); app.emit('studio-layout'); return; }
    render();
  }

  function render() {
    const t = selTrack(), sc = selClip();
    let k = st.detail;
    if (k === 'clip' && !sc) k = t ? 'devices' : 'mixer';
    if (k === 'devices' && !t) k = 'mixer';
    tabs.innerHTML = '';
    const tab = (key, label, dis) => {
      const b = h('button', { class: 'st-tab' + (k === key ? ' on' : ''), disabled: dis }, label);
      b.addEventListener('click', () => setTab(key));
      tabs.append(b);
    };
    tab('clip', '▤ Clip', !sc);
    tab('devices', '🎛 Dispositivos', !t);
    tab('mixer', '🎚 Mezcla');
    if (t) {
      const lbl = h('div', { class: 'st-dtitle' }, h('i', { style: { background: t.color } }), t.name, sc && k === 'clip' ? ' · ' + (sc.c.name || (sc.c.kind === 'midi' ? 'clip MIDI' : 'clip de audio')) : '');
      tabs.append(lbl);
    }
    tabs.append(h('div', { style: { flex: 1 } }));
    const closed = st.detailH < 60;
    const hide = h('button', { class: 'st-collapse', title: closed ? 'Abrir el detalle' : 'Cerrar el detalle' }, closed ? '▴' : '▾');
    hide.addEventListener('click', () => { st.detailH = closed ? defaultDetailH() : 0; app.emit('studio-layout'); });
    tabs.append(hide);

    bodyEl.innerHTML = '';
    view = null;
    if (closed) return;
    if (k === 'clip') view = sc.c.kind === 'midi' ? midiEditor(bodyEl, sc.t, sc.c) : audioEditor(bodyEl, sc.t, sc.c, arr);
    else if (k === 'devices') view = deviceView(bodyEl, t);
    else view = mixerView(bodyEl);
  }

  return {
    render,
    draw() { view?.draw?.(); },
    frame() { view?.frame?.(); },
    deleteSel() { return view?.deleteSel?.() || false; },
    key(e) { return view?.key?.(e) || false; },
  };
}

// =====================================================================
// Piano roll / grilla de batería
// =====================================================================
function midiEditor(el, t, c) {
  const st = S();
  const drums = t.inst?.type === 'drums';
  const cv = h('canvas', { class: 'roll-cv' });
  const side = h('div', { class: 'st-dside' });
  el.append(side, h('div', { class: 'roll-wrap' }, cv));

  // Como en Ableton: regla con la llave del loop arriba, teclas a la izquierda, fuerza abajo
  const RUL_H = 22, KEYS_W = drums ? 100 : 54, VEL_H = 56;
  const v = rollViews.get(c.id) || { zoom: 0, sx: 0, sy: null, rowH: drums ? 26 : 15, fold: false, allPads: false };
  rollViews.set(c.id, v);
  if (!v.zoom) v.zoom = Math.max(8, (el.clientWidth - 260 - KEYS_W) / Math.max(1, c.loop || c.len));
  let sel = new Set(), hoverP = null, marquee = null;
  const L = () => c.loop || c.len;
  const scaleSet = () => {
    const fx = (t.midiFx || []).find(f => f.type === 'scale' && f.on);
    const sc = fx ? { root: +fx.p.root, type: fx.p.type } : app.state.scale;
    if (!sc || sc.type === 'chromatic' || !SCALES[sc.type]) return null;
    return { root: sc.root, set: new Set(SCALES[sc.type].iv.map(i => (i + sc.root) % 12)), name: NOTE_NAMES[sc.root] + ' ' + SCALES[sc.type].name };
  };

  const rows = () => {
    // Batería: el pad 1 arriba y solo los pads con sonido o con golpes
    if (drums) {
      if (v.allPads) return Array.from({ length: DRUM_PADS }, (_, i) => DRUM_NOTE + i);
      const out = [];
      for (let i = 0; i < DRUM_PADS; i++) if (t.inst.pads[i] || c.notes.some(n => n.p === DRUM_NOTE + i)) out.push(DRUM_NOTE + i);
      return out.length ? out : [DRUM_NOTE];
    }
    if (v.fold) {
      const used = [...new Set(c.notes.map(n => n.p))].sort((a, b) => b - a);
      return used.length ? used : [60];
    }
    const out = []; for (let p = 108; p >= 21; p--) out.push(p); return out;
  };
  if (v.sy == null) {
    const rs = rows();
    const center = c.notes.length ? c.notes.reduce((a, n) => a + n.p, 0) / c.notes.length : 60;
    const i = rs.findIndex(p => p <= Math.round(center));
    v.sy = drums ? 0 : Math.max(0, i * v.rowH - 110);
  }
  const X = b => KEYS_W + (b - v.sx) * v.zoom;
  const B = x => (x - KEYS_W) / v.zoom + v.sx;
  const gridBot = () => cv.clientHeight - VEL_H;
  const rowIndexAt = y => Math.floor((y - RUL_H + v.sy) / v.rowH);
  const rowAt = y => { const rs = rows(), i = rowIndexAt(y); return i >= 0 && i < rs.length ? rs[i] : null; };
  const rowY = p => RUL_H + rows().indexOf(p) * v.rowH - v.sy;
  const gb = () => gridBeats(v.zoom * 1.6) || 0.25;
  const noteAt = (p, b) => c.notes.find(n => n.p === p && b >= n.s - 1e-6 && b < n.s + Math.max(n.d, 10 / v.zoom));
  // Borde de una nota: zona generosa (un tercio de la nota, mínimo 6 px, hasta 12/18 px)
  function edgeOf(n, x, touch) {
    const xl = X(n.s), xr = X(n.s + n.d), w = xr - xl;
    const zone = Math.max(6, Math.min(w * 0.33, touch ? 18 : 12));
    if (xr - x < zone && x <= xr + 6) return 'R';
    if (x - xl < zone && w > zone * 2) return 'L';
    return null;
  }

  // ---- Panel lateral ----
  function renderSide() {
    side.innerHTML = '';
    const loopLbl = h('span', {}, fmtBeats(L()));
    const setLoop = nl => {
      nl = Math.max(0.25, Math.min(256, nl));
      snapshot('Largo del loop', 'loop' + c.id);
      c.loop = nl; if (c.len < nl) c.len = nl;
      renderSide(); app.emit('studio-draw');
    };
    const items = [
      h('div', { class: 'dside-row' }, h('b', {}, 'Loop'), h('div', { class: 'stepper sm' },
        h('button', { onclick: () => setLoop(L() <= 1 ? L() / 2 : L() - (L() > 4 ? 4 : 1)) }, '−'), loopLbl,
        h('button', { onclick: () => setLoop(L() < 1 ? L() * 2 : L() + (L() >= 4 ? 4 : 1)) }, '＋'))),
      h('button', { class: 'pill', title: 'Duplica el loop con sus notas (como en Ableton)', onclick: () => {
        snapshot('Duplicar loop');
        const l = L(); c.notes = c.notes.filter(n => n.s < l); c.notes = c.notes.concat(c.notes.map(n => ({ ...n, s: n.s + l })));
        c.loop = l * 2; if (c.len < c.loop) c.len = c.loop; renderSide(); app.emit('studio');
      } }, '×2 Duplicar loop'),
      h('button', { class: 'pill', title: 'Lleva a la grilla las notas elegidas (o todas)', onclick: quantize }, '🧲 Cuantizar'),
      h('div', { class: 'dside-row' }, h('b', {}, 'Transp.'), h('div', { class: 'stepper sm' },
        h('button', { onclick: () => transpose(-12) }, '−8'), h('button', { onclick: () => transpose(-1) }, '−1'),
        h('button', { onclick: () => transpose(1) }, '+1'), h('button', { onclick: () => transpose(12) }, '+8'))),
      drums ? toggle('Los 16 pads', !!v.allPads, x => { v.allPads = x; v.sy = 0; draw(); }) : toggle('Plegar', v.fold, x => { v.fold = x; v.sy = 0; draw(); }),
      !drums && scaleSet() ? toggle('Escala: ' + scaleSet().name, v.showScale !== false, x => { v.showScale = x; draw(); }) : null,
      h('div', { class: 'dside-row' }, h('b', {}, 'Zoom'),
        h('div', { class: 'stepper sm' },
          h('button', { title: 'Renglones más chicos', onclick: () => { zoomRows(0.8, RUL_H + (gridBot() - RUL_H) / 2); draw(); } }, '▁'),
          h('button', { title: 'Renglones más grandes', onclick: () => { zoomRows(1.25, RUL_H + (gridBot() - RUL_H) / 2); draw(); } }, '▇'),
          h('button', { title: 'Ver todo el loop', onclick: () => { v.zoom = Math.max(4, (cv.clientWidth - KEYS_W - 10) / L()); v.sx = 0; fitNotes(); draw(); } }, '⤢'))),
      h('button', { class: 'pill', onclick: () => { sel = new Set(c.notes); draw(); } }, '▦ Elegir todas'),
      h('button', { class: 'pill', onclick: () => copyClip(c) }, '📋 Copiar clip'),
      h('div', { class: 'hint' }, 'Doble toque: crea o borra una nota. Tocá para elegir, arrastrá para mover, del borde para estirar. Arrastrando en el vacío elegís varias. ✏️ Dibujar: pintás notas. Arriba, la llave gris es el largo del loop.'),
    ];
    side.append(...items.filter(Boolean));
  }
  const targets = () => (sel.size ? [...sel] : c.notes);
  // Ajusta la vista vertical para que se vean todas las notas
  function fitNotes() {
    if (drums || !c.notes.length) return;
    const rs = rows(), hi = Math.max(...c.notes.map(n => n.p)), lo = Math.min(...c.notes.map(n => n.p));
    const span = rs.indexOf(lo) - rs.indexOf(hi) + 3, room = gridBot() - RUL_H;
    v.rowH = Math.max(6, Math.min(30, room / span)); v.rowAuto = false;
    v.sy = Math.max(0, (rs.indexOf(hi) - 1) * v.rowH);
  }
  function quantize() {
    snapshot('Cuantizar');
    const g = gb(); targets().forEach(n => { n.s = Math.max(0, snapB(n.s, g)); });
    dedupe(); app.emit('studio-draw');
  }
  function transpose(d) {
    if (drums) return;
    snapshot('Transponer', 'tr' + c.id);
    targets().forEach(n => { n.p = Math.max(0, Math.min(127, n.p + d)); });
    app.emit('studio-draw');
  }
  const dedupe = () => {
    const seen = new Set();
    c.notes = c.notes.filter(n => { const k = n.p + ':' + n.s.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; });
    sel = new Set([...sel].filter(n => c.notes.includes(n)));
  };
  renderSide();

  // ---- Dibujo ----
  function draw() {
    if (!cv.isConnected) return;
    const { g, w, h: hh } = fitCanvas(cv);
    const gbot = hh - VEL_H, rs = rows(), scl = drums ? null : scaleSet();
    if (drums && v.rowAuto !== false) v.rowH = Math.max(16, Math.min(34, Math.floor((gbot - RUL_H) / rs.length)));
    v.sy = Math.max(0, Math.min(Math.max(0, rs.length * v.rowH - (gbot - RUL_H)), v.sy));
    v.sx = Math.max(0, v.sx);
    g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, w, hh);
    g.save(); g.beginPath(); g.rect(KEYS_W, RUL_H, w - KEYS_W, gbot - RUL_H); g.clip();
    // Filas
    rs.forEach((p, i) => {
      const y = RUL_H + i * v.rowH - v.sy;
      if (y + v.rowH < RUL_H || y > gbot) return;
      const black = [1, 3, 6, 8, 10].includes(p % 12);
      g.fillStyle = drums ? (i % 2 ? T.rollBlack : T.rollWhite) : black ? T.rollBlack : T.rollWhite;
      if (scl && v.showScale !== false) g.fillStyle = scl.set.has(p % 12) ? (p % 12 === scl.root ? '#4a4434' : '#3f3f3f') : '#272727';
      g.fillRect(KEYS_W, y, w - KEYS_W, v.rowH);
      g.fillStyle = !drums && p % 12 === 0 ? T.rollC : dark(0.25);
      g.fillRect(KEYS_W, y + v.rowH - 1, w - KEYS_W, 1);
    });
    // Grilla
    const gg = gb();
    for (let b = Math.floor(v.sx / gg) * gg; X(b) < w; b += gg) {
      if (b < 0) continue;
      g.fillStyle = b % 4 === 0 ? dark(0.7) : b % 1 === 0 ? dark(0.4) : dark(0.18);
      g.fillRect(Math.round(X(b)), RUL_H, 1, gbot - RUL_H);
    }
    // Fuera del loop: más oscuro, con las repeticiones como fantasmas
    g.fillStyle = T.outside; g.fillRect(X(L()), RUL_H, Math.max(0, w - X(L())), gbot);
    const col = c.color || t.color;
    const vis = (s, d) => X(s + d) > KEYS_W && X(s) < w;
    for (let k = 1; k * L() < c.len; k++) for (const n of c.notes) {
      const s = n.s + k * L(); if (!vis(s, n.d)) continue;
      const y = rowY(n.p);
      g.fillStyle = ink(0.1); g.fillRect(X(s) + 1, y + 1, Math.max(3, n.d * v.zoom - 2), v.rowH - 2);
    }
    // Notas: más fuertes = más saturadas (como Ableton); las elegidas, claras y con borde
    for (const n of c.notes) {
      if (!vis(n.s, n.d)) continue;
      const y = rowY(n.p); if (y < RUL_H - v.rowH || y > gbot) continue;
      const x = X(n.s), nw = Math.max(drums ? 8 : 4, n.d * v.zoom - 1), on = sel.has(n);
      g.fillStyle = on ? tint(col, 0.7) : tint(col, (1 - n.v) * 0.55);
      g.fillRect(x + 0.5, y + 1, nw - 0.5, v.rowH - 2);
      g.strokeStyle = on ? '#fff' : dark(0.75); g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 1.5, nw - 1, v.rowH - 3);
      if (on && nw > 14) { g.fillStyle = dark(0.5); g.fillRect(x + nw - 4, y + 3, 2, v.rowH - 6); }
    }
    // Lápiz en el aire: el casillero o el borde que vas a tocar
    if (hoverP && hoverP.x > KEYS_W && hoverP.y > RUL_H && hoverP.y < gbot) {
      const p = rowAt(hoverP.y), b = B(hoverP.x);
      const n = p != null ? noteAt(p, b) : null;
      g.strokeStyle = T.accent; g.lineWidth = 2;
      if (n && edgeOf(n, hoverP.x)) {
        const xx = edgeOf(n, hoverP.x) === 'R' ? X(n.s + n.d) : X(n.s);
        g.fillStyle = T.accent; g.fillRect(xx - 2, rowY(n.p), 4, v.rowH);
      } else if (!n && p != null) g.strokeRect(X(snapB(b, gg, 'floor')) + 1, rowY(p) + 1, gg * v.zoom - 2, v.rowH - 2);
    }
    if (marquee) {
      const x0 = X(Math.min(marquee.a, marquee.b)), x1 = X(Math.max(marquee.a, marquee.b));
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
      g.fillStyle = T.timeSel; g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = '#9cc2ee'; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    }
    // Cabezal
    if (studio.playing) {
      const hb = studio.heardBeat();
      if (hb >= c.start && hb < c.start + c.len) {
        g.fillStyle = T.playhead; g.fillRect(Math.round(X((hb - c.start) % L())), RUL_H, 2, gbot);
      }
    }
    g.restore();
    // Regla con la llave del loop
    g.fillStyle = T.ruler; g.fillRect(KEYS_W, 0, w - KEYS_W, RUL_H);
    g.fillStyle = T.loopOn; g.fillRect(Math.max(KEYS_W, X(0)), 2, Math.max(0, X(L()) - Math.max(KEYS_W, X(0))), 8);
    g.fillStyle = '#fff'; g.fillRect(X(L()) - 5, 0, 5, 12);
    g.font = '10px ' + FONT;
    for (let b = Math.floor(v.sx / 4) * 4; X(b) < w; b += 4) {
      if (X(b) < KEYS_W) continue;
      g.fillStyle = T.rulerText; g.fillText(String(Math.floor((c.start + b) / 4) + 1), X(b) + 3, RUL_H - 3);
      g.fillStyle = '#555'; g.fillRect(Math.round(X(b)), 12, 1, RUL_H - 12);
    }
    // Teclas / nombres de los pads
    g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, KEYS_W, hh);
    g.save(); g.beginPath(); g.rect(0, RUL_H, KEYS_W, gbot - RUL_H); g.clip();
    g.font = (drums ? '11px ' : '9px ') + FONT;
    rs.forEach((p, i) => {
      const y = RUL_H + i * v.rowH - v.sy;
      if (y + v.rowH < RUL_H || y > gbot) return;
      if (drums) {
        const pd = t.inst.pads[p - DRUM_NOTE];
        g.fillStyle = held.has(p) ? T.accent : i % 2 ? '#2e2e2e' : '#333';
        g.fillRect(0, y, KEYS_W - 1, v.rowH - 1);
        g.fillStyle = held.has(p) ? '#111' : pd ? T.text : T.dim;
        g.fillText(`${p - DRUM_NOTE + 1}  ${pd ? srcName(pd.src) : '—'}`.slice(0, 15), 6, y + v.rowH / 2 + 4);
      } else {
        const black = [1, 3, 6, 8, 10].includes(p % 12);
        g.fillStyle = held.has(p) ? T.accent : black ? T.keyB : T.keyW;
        g.fillRect(black ? 0 : 0, y, black ? KEYS_W * 0.62 : KEYS_W - 1, v.rowH - 1);
        if (!black) { g.fillStyle = '#9a9a9a'; g.fillRect(0, y + v.rowH - 1, KEYS_W - 1, 1); }
        if (!black && (p % 12 === 0 ? v.rowH >= 9 : v.rowH >= 17)) { g.fillStyle = p % 12 === 0 ? '#222' : '#777'; g.fillText(noteName(p), KEYS_W - 26, y + v.rowH - 4); }
      }
    });
    g.restore();
    // Fuerza (velocity)
    g.fillStyle = '#232323'; g.fillRect(0, gbot, w, VEL_H);
    g.fillStyle = '#111'; g.fillRect(0, gbot, w, 1);
    g.fillStyle = T.dim; g.font = '10px ' + FONT; g.fillText('Fuerza', 8, gbot + VEL_H / 2 + 3);
    g.save(); g.beginPath(); g.rect(KEYS_W, gbot, w - KEYS_W, VEL_H); g.clip();
    for (const n of c.notes) {
      if (!vis(n.s, n.d)) continue;
      const x = X(n.s), bh = (VEL_H - 10) * n.v, on = sel.has(n);
      g.fillStyle = on ? '#fff' : col; g.fillRect(x, gbot + VEL_H - 4 - bh, 2, bh);
      g.beginPath(); g.arc(x + 1, gbot + VEL_H - 4 - bh, 3.5, 0, 7); g.fill();
    }
    g.restore();
  }

  // ---- Sonido al tocar ----
  const held = new Set();
  const audition = (p, on) => {
    const ta = studio.ta(t.id); if (!ta?.inst) return;
    if (on) silentHint(t);
    if (on) { ta.inst.on(p, 0.85); held.add(p); } else { ta.inst.off(p); held.delete(p); }
    draw();
  };
  const blip = p => { audition(p, true); setTimeout(() => audition(p, false), 150); };

  // ---- Edición ----
  function addNote(p, b) {
    const gg = gb();
    const n = { p, s: Math.max(0, snapB(b, gg, 'floor')), d: gg, v: 0.8 };
    if (n.s >= L()) return null;
    c.notes.push(n); blip(p);
    return n;
  }

  // Mover / estirar todas las elegidas juntas
  function groupDrag(anchor, edge, p0, copy) {
    let began = false;
    const b0 = B(p0.x), r0 = rowIndexAt(p0.y), rs = rows();
    let orig = null;
    return {
      move(q, ev) {
        if (!began) {
          began = true;
          snapshot(edge ? 'Estirar notas' : 'Mover notas');
          if (copy) { const cp = [...sel].map(n => ({ ...n })); c.notes.push(...cp); }
          orig = new Map([...sel].map(n => [n, { s: n.s, d: n.d, p: n.p }]));
        }
        const free = ev?.altKey, gg = gb(), db = B(q.x) - b0, oa = orig.get(anchor);
        if (edge === 'R') {
          const end = free ? oa.s + oa.d + db : snapB(oa.s + oa.d + db, gg);
          const dd = end - (oa.s + oa.d);
          for (const [n, o] of orig) n.d = Math.max(free ? 0.02 : gg, o.d + dd);
        } else if (edge === 'L') {
          const ns = free ? oa.s + db : snapB(oa.s + db, gg), ds = ns - oa.s;
          for (const [n, o] of orig) { const s2 = Math.max(0, Math.min(o.s + o.d - (free ? 0.02 : gg), o.s + ds)); n.d = o.s + o.d - s2; n.s = s2; }
        } else {
          const ns = free ? oa.s + db : snapB(oa.s + db, gg), ds = ns - oa.s;
          const dr = rowIndexAt(q.y) - r0;
          for (const [n, o] of orig) {
            n.s = Math.max(0, Math.min(L() - 0.001, o.s + ds));
            const ri = rs.indexOf(o.p) + dr;
            if (ri >= 0 && ri < rs.length) n.p = rs[ri];
          }
          if (anchor.p !== oa.p && anchor._lp !== anchor.p) { anchor._lp = anchor.p; blip(anchor.p); }
        }
        draw(); app.emit('studio-draw-arr');
      },
      up() { if (began) { delete anchor._lp; dedupe(); app.emit('studio-draw'); } },
    };
  }

  function editDown(pt, e, touch) {
    if (pt.y < RUL_H) return rulerDrag(pt);
    if (pt.y > gridBot()) return velDrag(pt);
    if (pt.x < KEYS_W) return keysDrag(pt);
    const p = rowAt(pt.y), b = B(pt.x);
    if (p == null || b < 0) return null;
    const n = noteAt(p, b);
    // Modo dibujo: tocar una nota la borra; en el vacío pinta notas al arrastrar
    if (st.draw) {
      snapshot(n ? 'Borrar nota' : 'Dibujar notas');
      if (n) { c.notes = c.notes.filter(x => x !== n); sel.delete(n); app.emit('studio-draw'); return { move() { /* */ }, up() { /* */ } }; }
      addNote(p, b); app.emit('studio-draw');
      return {
        move(q) {
          const pp = drums ? (rowAt(q.y) ?? p) : p, bb = B(q.x);
          if (bb >= 0 && bb < L() && !noteAt(pp, snapB(bb, gb(), 'floor') + 1e-4)) { addNote(pp, bb); app.emit('studio-draw'); }
        },
        up() { /* */ },
      };
    }
    if (n) {
      if (!sel.has(n)) { if (!e.shiftKey) sel.clear(); sel.add(n); }
      blip(n.p);
      draw();
      return groupDrag(n, edgeOf(n, pt.x, touch), pt, e.altKey || e.ctrlKey || e.metaKey);
    }
    // Vacío: rectángulo para elegir varias
    const add = e.shiftKey ? new Set(sel) : new Set();
    marquee = { a: b, b, y0: pt.y, y1: pt.y };
    return {
      move(q) {
        marquee.b = B(q.x); marquee.y1 = Math.max(RUL_H, Math.min(gridBot(), q.y));
        const a0 = Math.min(marquee.a, marquee.b), a1 = Math.max(marquee.a, marquee.b);
        const r0 = rowIndexAt(Math.min(marquee.y0, marquee.y1)), r1 = rowIndexAt(Math.max(marquee.y0, marquee.y1)), rs = rows();
        sel = new Set(add);
        for (const n2 of c.notes) { const ri = rs.indexOf(n2.p); if (ri >= r0 && ri <= r1 && n2.s < a1 && n2.s + n2.d > a0) sel.add(n2); }
        draw();
      },
      up(q, ev, tap) { marquee = null; if (tap && !e.shiftKey) sel.clear(); draw(); },
    };
  }

  // Columna de teclas (como en Ableton): tocar hace sonar la nota; arrastrar para arriba o
  // abajo desplaza las notas; arrastrar hacia los costados agranda o achica los renglones
  function keysDrag(pt) {
    let p = rowAt(pt.y), moved = false;
    if (p != null) audition(p, true);
    const x0 = pt.x, y0 = pt.y, sy0 = v.sy, h0 = v.rowH;
    return {
      move(q) {
        if (!moved && Math.hypot(q.x - x0, q.y - y0) > 6) { moved = true; if (p != null) audition(p, false); p = null; }
        if (!moved) return;
        const rh = Math.max(6, Math.min(48, h0 * Math.exp((q.x - x0) / 120)));
        const anchor = (y0 - RUL_H + sy0) / h0; // renglón bajo el dedo
        if (Math.abs(rh - v.rowH) > 0.01) { v.rowH = rh; v.rowAuto = false; }
        v.sy = anchor * v.rowH - (y0 - RUL_H) - (q.y - y0);
        draw();
      },
      up() { if (p != null) audition(p, false); },
    };
  }
  function zoomRows(f, cy) {
    const anchor = (cy - RUL_H + v.sy) / v.rowH;
    v.rowH = Math.max(6, Math.min(48, v.rowH * f)); v.rowAuto = false;
    v.sy = anchor * v.rowH - (cy - RUL_H);
  }

  // Llave del loop: arrastrá su punta para cambiar el largo
  function rulerDrag(pt) {
    if (Math.abs(pt.x - X(L())) > 22) return null;
    let began = false;
    return {
      move(q) {
        if (!began) { began = true; snapshot('Largo del loop', 'loop' + c.id); }
        const nl = Math.max(gb(), snapB(B(q.x), gb()));
        c.loop = nl; if (c.len < nl) c.len = nl;
        draw(); app.emit('studio-draw-arr');
      },
      up() { if (began) { renderSide(); app.emit('studio'); } },
    };
  }

  // Fuerza: arrastrá la barrita (si es de una nota elegida, cambian todas las elegidas)
  function velDrag(pt) {
    snapshot('Fuerza', 'vel' + c.id);
    const bAt = B(pt.x), tol = 8 / v.zoom;
    const hitN = c.notes.filter(n => Math.abs(n.s - bAt) < tol);
    const group = hitN.some(n => sel.has(n)) ? [...sel] : hitN;
    const y0 = pt.y, orig = new Map(group.map(n => [n, n.v]));
    const valAt = y => Math.max(0.05, Math.min(1, (gridBot() + VEL_H - 4 - y) / (VEL_H - 10)));
    if (!group.length) {
      // sin nota debajo: pintar al pasar
      const paint = q => { const b = B(q.x); for (const n of c.notes) if (Math.abs(n.s - b) < tol) n.v = Math.round(valAt(q.y) * 100) / 100; draw(); };
      return { move: paint, up() { app.emit('studio-draw'); } };
    }
    if (group.length === 1) group[0].v = Math.round(valAt(pt.y) * 100) / 100;
    draw();
    return {
      move(q) {
        if (group.length === 1) group[0].v = Math.round(valAt(q.y) * 100) / 100;
        else { const d = (y0 - q.y) / (VEL_H - 10); for (const [n, o] of orig) n.v = Math.round(Math.max(0.05, Math.min(1, o + d)) * 100) / 100; }
        draw();
      },
      up() { app.emit('studio-draw'); },
    };
  }

  gestures(cv, {
    drawTouch: () => st.draw,
    down: (p, e) => editDown(p, e, false),
    long: p => editDown(p, {}, true),
    // Dedo sobre el borde de una nota elegida: estira directo
    grab(p) {
      if (p.y < RUL_H) return rulerDrag(p);
      if (p.x < KEYS_W && p.y < gridBot()) return keysDrag(p);
      if (p.y > gridBot()) return null;
      const r = rowAt(p.y), n = r != null ? noteAt(r, B(p.x)) : null;
      if (n && sel.has(n)) { const ed = edgeOf(n, p.x, true); if (ed) return groupDrag(n, ed, p, false); }
      return null;
    },
    tap(p, e, dbl) {
      if (st.draw || p.y < RUL_H) return;
      if (p.y > gridBot()) { if (e.pointerType === 'touch') velDrag(p).up(); return; }
      if (p.x < KEYS_W) return;
      const r = rowAt(p.y), b = B(p.x); if (r == null || b < 0) return;
      const n = noteAt(r, b);
      if (dbl) {
        // Doble toque: borra la nota, o crea una en el casillero vacío (como en Ableton)
        if (n) { snapshot('Borrar nota'); c.notes = c.notes.filter(x => x !== n); sel.delete(n); }
        else if (b < L()) { snapshot('Nota nueva'); const nn = addNote(r, b); sel = new Set(nn ? [nn] : []); }
        app.emit('studio-draw');
        return;
      }
      if (n) { if (!e.shiftKey) sel.clear(); sel.add(n); if (e.pointerType === 'touch') blip(n.p); }
      else sel.clear();
      draw();
    },
    context(p, e) {
      popover(pointAnchor(e.clientX, e.clientY), [
        h('h4', {}, sel.size ? `${sel.size} notas elegidas` : 'Notas'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); quantize(); } }, '🧲 Cuantizar'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); duplicateSel(); } }, '⧉ Duplicar  (Ctrl+D)'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); snapshot('Legato'); const ns = c.notes.slice().sort((a, b) => a.s - b.s); targets().forEach(n => { const nx = ns.find(m => m.s > n.s + 1e-6); n.d = (nx ? nx.s : L()) - n.s; }); app.emit('studio-draw'); } }, '⟿ Legato'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); snapshot('Fuerza pareja'); targets().forEach(n => { n.v = 0.8; }); app.emit('studio-draw'); } }, '▬ Fuerza pareja'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); sel = new Set(c.notes); draw(); } }, '▦ Elegir todas  (Ctrl+A)'),
        h('button', { class: 'menu-item danger', onclick: () => { closePopover(); delSel(true); } }, sel.size ? '🗑 Borrar las elegidas' : '🗑 Borrar todas'),
      ]);
    },
    hover(p) {
      hoverP = p;
      if (p && p.x > KEYS_W && p.y > RUL_H && p.y < gridBot()) {
        const r = rowAt(p.y), n = r != null ? noteAt(r, B(p.x)) : null;
        cv.style.cursor = st.draw ? 'crosshair' : n ? (edgeOf(n, p.x) ? 'ew-resize' : 'move') : 'default';
      } else cv.style.cursor = p && p.y < RUL_H && Math.abs(p.x - X(L())) < 22 ? 'ew-resize' : 'default';
      draw();
    },
    pan(dx, dy) { v.sx -= dx / v.zoom; v.sy -= dy; draw(); },
    // Pellizco: abrir en horizontal = zoom del tiempo; en vertical = renglones más grandes
    pinch(r, cx, cy, dx, dy, rx = r, ry = 1) {
      const b = B(cx); v.zoom = Math.max(4, Math.min(800, v.zoom * rx)); v.sx = b - (cx - KEYS_W) / v.zoom - dx / v.zoom;
      if (Math.abs(ry - 1) > 0.002) zoomRows(ry, cy);
      v.sy -= dy; draw();
    },
    wheel(p, e) {
      if (e.altKey) zoomRows(Math.exp(-e.deltaY * 0.003), p.y);
      else if (e.ctrlKey || e.metaKey) { const b = B(p.x); v.zoom = Math.max(4, Math.min(800, v.zoom * Math.exp(-e.deltaY * 0.003))); v.sx = b - (p.x - KEYS_W) / v.zoom; }
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) v.sx += (e.deltaX || e.deltaY) / v.zoom;
      else v.sy += e.deltaY;
      draw();
    },
  });

  function delSel(all = false) {
    if (!sel.size && !all) return false;
    snapshot('Borrar notas');
    c.notes = sel.size ? c.notes.filter(n => !sel.has(n)) : [];
    sel.clear(); app.emit('studio-draw');
    return true;
  }
  function duplicateSel() {
    const src = targets(); if (!src.length) return;
    snapshot('Duplicar notas');
    const a = Math.min(...src.map(n => n.s)), b = Math.max(...src.map(n => n.s + n.d));
    const span = Math.ceil((b - a) / gb() - 1e-6) * gb();
    const cp = src.map(n => ({ ...n, s: n.s + span })).filter(n => n.s < Math.max(L(), c.len));
    if (cp.some(n => n.s >= L())) { c.loop = Math.min(c.len, Math.max(L(), Math.ceil(Math.max(...cp.map(n => n.s + n.d)) / 4) * 4)); if (c.loop > c.len) c.len = c.loop; }
    c.notes.push(...cp); sel = new Set(cp);
    dedupe(); renderSide(); app.emit('studio-draw');
  }

  requestAnimationFrame(draw);
  return {
    draw,
    frame() { if (studio.playing) draw(); },
    deleteSel: () => delSel(false),
    key(e) {
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 'a') { sel = new Set(c.notes); draw(); return true; }
      if (mod && k.toLowerCase() === 'c' && sel.size) { const a = Math.min(...[...sel].map(n => n.s)); noteClip = [...sel].map(n => ({ ...n, s: n.s - a })); toast(`📋 ${sel.size} notas copiadas`); return true; }
      if (mod && k.toLowerCase() === 'v' && noteClip) {
        snapshot('Pegar notas');
        const at = sel.size ? Math.max(...[...sel].map(n => n.s + n.d)) : Math.max(0, Math.min(L() - 0.01, (studio.playing ? studio.heardBeat() : S().pos) - c.start));
        const cp = noteClip.map(n => ({ ...n, s: snapB(at, gb()) + n.s })).filter(n => n.s < L());
        c.notes.push(...cp); sel = new Set(cp); dedupe(); app.emit('studio-draw'); return true;
      }
      if (mod && k.toLowerCase() === 'd' && sel.size) { duplicateSel(); return true; }
      if (k === 'Escape') { sel.clear(); draw(); return true; }
      if (!sel.size) return false;
      if (k === 'ArrowUp' || k === 'ArrowDown') { transpose((k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)); return true; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        snapshot('Mover notas', 'mv' + c.id);
        const d = (k === 'ArrowRight' ? 1 : -1) * gb();
        sel.forEach(n => { n.s = Math.max(0, Math.min(L() - 0.001, n.s + d)); });
        app.emit('studio-draw'); return true;
      }
      return false;
    },
  };
}
const rollViews = new Map(); // vista (zoom, desplazamiento) de cada clip, solo en esta sesión
let noteClip = null;         // notas copiadas (Ctrl+C / Ctrl+V)

// =====================================================================
// Clip de audio: onda, selección y operaciones
// =====================================================================
function audioEditor(el, t, c, arr) {
  const cv = h('canvas', { class: 'roll-cv' });
  const side = h('div', { class: 'st-dside' });
  el.append(side, h('div', { class: 'roll-wrap' }, cv));
  let sel = null; // [a, b] en tiempos relativos al clip
  const v = { zoom: 0, sx: 0 };
  const bs = () => (c.warp ? 60 / c.bpm : spb());
  const X = b => (b - v.sx) * v.zoom + 8;
  const B = x => (x - 8) / v.zoom + v.sx;

  function renderSide() {
    side.innerHTML = '';
    const gain = knob({ label: 'Ganancia', min: -24, max: 12, value: 20 * Math.log10(c.gain || 1), def: 0, size: 44, bipolar: true, fmt: x => (x > 0 ? '+' : '') + x.toFixed(1) + ' dB',
      onInput: x => { snapshot('Ganancia', 'g' + c.id); c.gain = Math.pow(10, x / 20); app.emit('studio-draw'); } });
    const fi = knob({ label: 'Fade in', min: 0, max: 2, value: c.fadeIn || 0, def: 0.003, size: 44, fmt: x => Math.round(x * 1000) + ' ms', onInput: x => { c.fadeIn = x; } });
    const fo = knob({ label: 'Fade out', min: 0, max: 2, value: c.fadeOut || 0, def: 0.003, size: 44, fmt: x => Math.round(x * 1000) + ' ms', onInput: x => { c.fadeOut = x; } });
    const warp = toggle('🧲 Sigue el tempo', !!c.warp, x => {
      snapshot('Seguir tempo');
      // conserva el lugar en el tiempo: recalcula el largo con el nuevo modo
      const sec = c.len * bs();
      c.warp = x;
      c.len = sec / bs();
      renderSide(); app.emit('studio');
    });
    const bpmBtn = h('button', { class: 'pill', title: 'Tempo en el que se grabó el audio' }, `♩ ${Math.round(c.bpm * 10) / 10} BPM original`);
    bpmBtn.addEventListener('click', () => {
      const x = prompt('Tempo original del audio (BPM)', Math.round(c.bpm * 100) / 100);
      if (x && +x > 20 && +x < 400) { snapshot('Tempo del clip'); const sec = c.len * bs(); c.bpm = +x; c.len = sec / bs(); renderSide(); app.emit('studio'); }
    });
    const selOps = h('div', { class: 'dside-ops' },
      h('button', { class: 'pill', onclick: () => op('silence') }, '🔇 Silenciar'),
      h('button', { class: 'pill', onclick: () => op('delete') }, '✂ Borrar trozo'),
      h('button', { class: 'pill', onclick: () => op('crop') }, '⬚ Dejar solo esto'),
      h('button', { class: 'pill', onclick: () => op('split') }, '| Dividir'),
      h('button', { class: 'pill', onclick: () => op('pad') }, '🥁 A un pad'),
    );
    side.append(
      h('div', { class: 'dside-knobs' }, gain.el, fi.el, fo.el),
      warp, bpmBtn,
      h('div', { class: 'dside-row' },
        h('button', { class: 'pill', onclick: () => arr.audioOp(t, c, 'rev') }, '⇄ Al revés'),
        h('button', { class: 'pill', onclick: () => arr.audioOp(t, c, 'norm') }, '📈 Normalizar')),
      h('div', { class: 'hint' }, sel ? 'Con lo seleccionado:' : 'Marcá un trozo con el lápiz (o el dedo) para silenciarlo, borrarlo, recortar o mandarlo a un pad.'),
      sel ? selOps : null,
    );
  }

  function op(kind) {
    const buf = getBuffer(c.buf); if (!buf) return;
    const s2 = sel || [0, c.len];
    const a = Math.max(0, Math.min(s2[0], s2[1])), b = Math.min(c.len, Math.max(s2[0], s2[1]));
    const sr = buf.sampleRate, ia = Math.round((c.off + a * bs()) * sr), ib = Math.round((c.off + b * bs()) * sr);
    if (kind === 'split') { splitAt(t, c, c.start + a); return; }
    if (kind === 'pad') {
      popover(side, [h('h4', {}, 'Mandar al pad del modo En vivo'), h('div', { class: 'chips wrap' }, ...Array.from({ length: 8 }, (_, i) => h('button', { class: 'chip', onclick: async () => {
        closePopover(); await setCustomSample(i, copyRange(buf, ia, ib), (c.name || 'Estudio').slice(0, 20)); toast(`🥁 Listo en el pad ${i + 1}`);
      } }, String(i + 1))))]);
      return;
    }
    snapshot({ silence: 'Silenciar', delete: 'Borrar trozo', crop: 'Recortar' }[kind]);
    if (kind === 'silence') c.buf = putBuffer(silenceRange(buf, ia, ib));
    else if (kind === 'delete') { c.buf = putBuffer(deleteRange(buf, ia, ib)); c.len = Math.max(0.0625, c.len - (b - a)); }
    else if (kind === 'crop') { c.start += a; c.off += a * bs(); c.len = b - a; }
    sel = null; renderSide(); app.emit('studio');
  }

  function draw() {
    if (!cv.isConnected) return;
    const { g, w, h: hh } = fitCanvas(cv);
    if (!v.zoom) v.zoom = (w - 16) / Math.max(0.25, c.len);
    g.clearRect(0, 0, w, hh);
    const col = c.color || t.color;
    // Grilla
    const gg = gridBeats(v.zoom) || 1;
    for (let b = Math.max(0, Math.floor(v.sx / gg) * gg); X(b) < w; b += gg) {
      g.fillStyle = (c.start + b) % 4 === 0 ? ink(0.2) : ink(0.06);
      g.fillRect(Math.round(X(b)), 0, 1, hh);
    }
    g.fillStyle = ink(0.04); g.fillRect(X(0), 0, c.len * v.zoom, hh);
    const pk = peaksOf(c.buf), buf = getBuffer(c.buf);
    if (pk && buf) {
      const mid = hh / 2, amp = (hh / 2 - 6) * Math.min(3, c.gain ?? 1);
      g.fillStyle = col;
      for (let px = Math.max(0, Math.floor(X(0))); px < Math.min(w, X(c.len)); px++) {
        const s0 = c.off + B(px) * bs(), s1 = c.off + B(px + 1) * bs();
        let k0 = Math.floor(s0 * pk.sr / pk.H), k1 = Math.max(k0 + 1, Math.floor(s1 * pk.sr / pk.H));
        if (k0 >= pk.mn.length) break;
        k0 = Math.max(0, k0); k1 = Math.min(pk.mn.length, k1);
        let lo = 0, hi = 0;
        for (let k = k0; k < k1; k++) { if (pk.mn[k] < lo) lo = pk.mn[k]; if (pk.mx[k] > hi) hi = pk.mx[k]; }
        g.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    if (sel) {
      const a = Math.min(...sel), b = Math.max(...sel);
      g.fillStyle = 'rgba(255,142,212,0.25)'; g.fillRect(X(a), 0, (b - a) * v.zoom, hh);
      g.fillStyle = '#ff8ed4'; g.fillRect(X(a) - 1, 0, 2, hh); g.fillRect(X(b) - 1, 0, 2, hh);
    }
    if (studio.playing) {
      const rel = studio.heardBeat() - c.start;
      if (rel >= 0 && rel < c.len) { g.fillStyle = isLight() ? '#120d1a' : '#fff'; g.fillRect(Math.round(X(rel)), 0, 2, hh); }
    }
  }

  gestures(cv, {
    drawTouch: () => true,
    down(p, e) {
      const free = e.altKey, gg = gridBeats(v.zoom);
      const sn = x => Math.max(0, Math.min(c.len, free || !gg ? B(x) : snapB(B(x), gg / 2)));
      const a = sn(p.x);
      sel = [a, a]; draw();
      return { move(q) { sel[1] = sn(q.x); draw(); }, up(q, ev, tap) { if (tap || Math.abs(sel[1] - sel[0]) < 1e-4) sel = null; renderSide(); draw(); } };
    },
    pinch(r, cx) { const b = B(cx); v.zoom = Math.max(2, Math.min(2000, v.zoom * r)); v.sx = Math.max(0, b - (cx - 8) / v.zoom); draw(); },
    wheel(p, e) { const b = B(p.x); v.zoom = Math.max(2, Math.min(2000, v.zoom * Math.exp(-e.deltaY * 0.003))); v.sx = Math.max(0, b - (p.x - 8) / v.zoom); draw(); },
  });

  renderSide();
  requestAnimationFrame(draw);
  return {
    draw, frame() { if (studio.playing) draw(); },
    deleteSel() { if (!sel) return false; op('delete'); return true; },
  };
}

// =====================================================================
// Dispositivos
// =====================================================================
function deviceView(el, t) {
  const row = h('div', { class: 'dev-row' });
  el.append(row);
  const ta = () => studio.ta(t.id);

  // Canal (como el "mixer" a la izquierda en Ableton)
  const chan = h('div', { class: 'dev mix' },
    h('div', { class: 'dev-head' }, h('b', {}, '🎚 Canal')),
    h('div', { class: 'dev-knobs' },
      knob({ label: 'Volumen', value: t.vol, def: 0.8, size: 46, color: t.color, fmt: x => (x > 0.001 ? (20 * Math.log10(faderGain(x))).toFixed(1) : '−∞') + ' dB', onInput: x => { t.vol = x; studio.applyTrack(t); app.emit('studio-mixval'); } }).el,
      knob({ label: 'Paneo', min: -1, max: 1, value: t.pan, def: 0, bipolar: true, size: 46, color: t.color, fmt: panFmt, onInput: x => { t.pan = x; studio.applyTrack(t); } }).el,
      knob({ label: 'Reverb', value: t.rev, def: 0, size: 46, color: '#54a0ff', fmt: x => Math.round(x * 100) + '%', onInput: x => { t.rev = x; studio.applyTrack(t); } }).el,
      knob({ label: 'Delay', value: t.dly, def: 0, size: 46, color: '#48dbb4', fmt: x => Math.round(x * 100) + '%', onInput: x => { t.dly = x; studio.applyTrack(t); } }).el,
    ));
  row.append(chan);

  const list = (arrName) => t[arrName];
  function card(d, arrName, spec, i) {
    const on = h('button', { class: 'dev-on' + (d.on ? ' on' : ''), title: 'Prender / apagar' });
    on.addEventListener('click', () => { snapshot('Prender efecto'); d.on = !d.on; studio.sync(); renderAll(); });
    const left = h('button', { class: 'dev-x', title: 'Mover a la izquierda' }, '◀');
    left.addEventListener('click', () => move(arrName, i, -1));
    const right = h('button', { class: 'dev-x', title: 'Mover a la derecha' }, '▶');
    right.addEventListener('click', () => move(arrName, i, 1));
    const del = h('button', { class: 'dev-x', title: 'Quitar' }, '✕');
    del.addEventListener('click', () => { snapshot('Quitar efecto'); t[arrName].splice(i, 1); for (const k of Object.keys(t.auto || {})) if (k.startsWith('d:' + d.id + ':')) delete t.auto[k]; studio.sync(); renderAll(); app.emit('studio'); });
    const knobs = h('div', { class: 'dev-knobs' });
    for (const p of spec.params) knobs.append(paramCtl(d, p, () => {
      if (arrName === 'devices') ta()?.dev(d.id)?.node.set(d.p, A.ctx.currentTime, app.state.bpm);
    }, `${d.id}:${p.k}`));
    const c = h('div', { class: 'dev' + (d.on ? '' : ' off') + (arrName === 'midiFx' ? ' midi' : '') },
      h('div', { class: 'dev-head' }, on, h('b', {}, spec.emoji + ' ' + spec.name), h('div', { style: { flex: 1 } }), left, right, del), knobs);
    if (d.type === 'comp' || d.type === 'limiter') {
      const gr = h('i'); const meter = h('div', { class: 'gr-meter', title: 'Cuánto está comprimiendo' }, gr);
      c.append(meter);
      c._gr = () => { const x = ta()?.dev(d.id)?.node.comp?.reduction || 0; gr.style.width = Math.min(100, -x * 4) + '%'; };
    }
    return c;
  }
  function move(arrName, i, dir) {
    const a = t[arrName], j = i + dir;
    if (j < 0 || j >= a.length) return;
    snapshot('Mover efecto');
    [a[i], a[j]] = [a[j], a[i]];
    studio.sync(); renderAll();
  }

  const cards = [];
  function renderAll() {
    row.innerHTML = ''; row.append(chan); cards.length = 0;
    if (t.kind === 'midi') {
      t.midiFx.forEach((d, i) => row.append(card(d, 'midiFx', MIDI_FX[d.type], i)));
      row.append(instCard(t));
    }
    t.devices.forEach((d, i) => { const c = card(d, 'devices', AUDIO_FX[d.type], i); cards.push(c); row.append(c); });
    const add = h('button', { class: 'dev-add', title: 'Agregar un efecto (o arrastralo desde el navegador)' }, '＋', h('small', {}, 'Efecto'));
    add.addEventListener('click', () => popover(add, [
      h('h4', {}, 'Efectos de audio'),
      ...AUDIO_FX_KEYS.map(k => h('button', { class: 'menu-item', onclick: () => { closePopover(); addDevice(t, 'audio', k); } }, AUDIO_FX[k].emoji + ' ' + AUDIO_FX[k].name, h('small', {}, ' · ' + AUDIO_FX[k].desc))),
      t.kind === 'midi' ? h('h4', {}, 'Efectos MIDI') : null,
      ...(t.kind === 'midi' ? MIDI_FX_KEYS.map(k => h('button', { class: 'menu-item', onclick: () => { closePopover(); addDevice(t, 'midi', k); } }, MIDI_FX[k].emoji + ' ' + MIDI_FX[k].name, h('small', {}, ' · ' + MIDI_FX[k].desc))) : []),
    ], { cls: 'wide' }));
    row.append(add);
  }
  renderAll();
  return {
    frame() { for (const c of cards) c._gr?.(); },
  };
}

export function addDevice(t, kind, type) {
  snapshot('Agregar efecto');
  if (kind === 'midi') {
    if (t.kind !== 'midi') { toast('Los efectos MIDI van en pistas MIDI'); return; }
    t.midiFx.push({ id: uid('m'), type, on: true, p: defaultsOf(MIDI_FX[type]) });
  } else t.devices.push({ id: uid('d'), type, on: true, p: defaultsOf(AUDIO_FX[type]) });
  S().sel.track = t.id; S().detail = 'devices';
  studio.sync(); app.emit('studio');
}

const panFmt = x => (Math.abs(x) < 0.02 ? 'C' : (x < 0 ? 'I ' : 'D ') + Math.round(Math.abs(x) * 50));

// Control de un parámetro: perilla (numérico) o botón con opciones
function paramCtl(d, p, apply, autoKey) {
  if (p.opts) {
    const cur = () => (p.opts.find(o => String(o[0]) === String(d.p[p.k])) || p.opts[0])[1];
    const b = h('button', { class: 'dev-opt' }, h('small', {}, p.label), h('span', {}, cur()));
    b.addEventListener('click', () => popover(b, [h('h4', {}, p.label), h('div', { class: 'chips wrap' }, ...p.opts.map(([v, l]) => h('button', {
      class: 'chip' + (String(v) === String(d.p[p.k]) ? ' on' : ''),
      onclick: () => { snapshot(p.label); d.p[p.k] = v; b.lastChild.textContent = l; apply(); closePopover(); },
    }, l)))]));
    return b;
  }
  const tg = { min: p.min, max: p.max, log: p.log };
  const k = knob({
    label: p.label, min: 0, max: 1, value: norm(tg, d.p[p.k]), def: norm(tg, p.def), size: 44, bipolar: p.bi,
    step: p.step ? 1 / ((p.max - p.min) / p.step) : 0,
    fmt: x => (p.fmt ? p.fmt(denorm(tg, x)) : denorm(tg, x).toFixed(2)),
    onInput: x => { snapshot(p.label, 'p' + autoKey); let val = denorm(tg, x); if (p.step) val = Math.round(val / p.step) * p.step; d.p[p.k] = val; apply(); },
  });
  return k.el;
}

// ---- Instrumento ----
function instCard(t) {
  const ins = t.inst;
  const kinds = h('div', { class: 'chips' }, ...[['synth', '🎹 Synth'], ['drums', '🥁 Batería'], ['sampler', '🎻 Sampler']].map(([k, l]) =>
    h('button', { class: 'chip' + (ins.type === k ? ' on' : ''), onclick: () => {
      if (ins.type === k) return;
      snapshot('Cambiar instrumento');
      t.inst = k === 'synth' ? synthInst(0) : k === 'drums' ? drumInst() : samplerInst({ kit: app.state.kit || 0, idx: 5, name: srcName({ kit: app.state.kit || 0, idx: 5 }) });
      studio.sync(); app.emit('studio');
    } }, l)));
  const body = h('div', { class: 'inst-body' });
  // Dos modos, como pediste: perillas para ajustar el sonido, o un teclado grande para tocarlo
  const mode = instViews.get(t.id) || 'knobs';
  const modeChips = h('div', { class: 'chips' }, ...[['knobs', '🎛 Perillas'], ['play', ins.type === 'drums' ? '🥁 Tocar' : '🎹 Tocar']].map(([k, l]) =>
    h('button', { class: 'chip' + (mode === k ? ' on' : ''), onclick: () => { instViews.set(t.id, k); app.emit('studio-sel'); } }, l)));
  const el = h('div', { class: 'dev inst' + (mode === 'play' ? ' playing' : '') }, h('div', { class: 'dev-head' }, h('b', {}, 'Instrumento'), modeChips, h('div', { style: { flex: 1 } }), kinds), body);
  const refresh = () => studio.ta(t.id)?.inst?.update(t.inst);
  if (mode === 'play') { body.append(playSurface(t, { big: true })); return el; }

  if (ins.type === 'synth') {
    const pr = presetById(ins.preset);
    const presetBtn = h('button', { class: 'pill preset-pick' }, (pr ? (pr.emoji || '★') + ' ' + pr.name : 'Synth') + ' ▾');
    presetBtn.addEventListener('click', () => pickPreset(presetBtn, t));
    body.append(h('div', { class: 'dside-row' }, presetBtn,
      h('button', { class: 'pill', title: 'Probar', onclick: () => { const ta = studio.ta(t.id); ta?.inst?.on(60, 0.8); setTimeout(() => ta?.inst?.off(60), 500); } }, '🔊')));
    const groups = h('div', { class: 'inst-groups' });
    for (const [gname, specs] of Object.entries(SYNTH_SPECS)) {
      const gEl = h('div', { class: 'inst-group' }, h('small', {}, gname));
      for (const [k, label, o] of specs) {
        const min = o.min ?? 0, max = o.max ?? 1;
        gEl.append(knob({ label, min, max, value: ins.params[k] ?? PRESET_DEFAULTS[k], def: o.def ?? PRESET_DEFAULTS[k], step: o.step || 0, bipolar: o.bipolar, size: 38, fmt: o.fmt,
          onInput: x => { snapshot('Synth · ' + label, 'sp' + t.id + k); ins.params[k] = x; refresh(); } }).el);
      }
      groups.append(gEl);
    }
    body.append(groups);
  } else if (ins.type === 'drums') {
    const grid = h('div', { class: 'drum-grid' });
    const padEdit = h('div', { class: 'pad-edit' });
    const renderPads = () => {
      grid.innerHTML = '';
      for (let r = 3; r >= 0; r--) for (let k = 0; k < 4; k++) {
        const i = r * 4 + k, pd = ins.pads[i];
        const b = h('button', { class: 'dpad' + (ins.sel === i ? ' sel' : '') + (pd ? '' : ' empty') }, h('small', {}, String(i + 1)), pd ? srcName(pd.src) : '＋');
        b.addEventListener('pointerdown', e => { e.preventDefault(); ins.sel = i; if (pd) studio.ta(t.id)?.inst?.on(DRUM_NOTE + i, 0.85); renderPads(); renderPad(); });
        b.dataset.pad = i;
        grid.append(b);
      }
    };
    const renderPad = () => {
      padEdit.innerHTML = '';
      const i = ins.sel || 0, pd = ins.pads[i];
      const pick = h('button', { class: 'pill' }, (pd ? srcName(pd.src) : 'Elegir sonido') + ' ▾');
      pick.addEventListener('click', () => pickKitSound(pick, src => {
        snapshot('Sonido del pad');
        ins.pads[i] = { ...(ins.pads[i] || { vol: 0.8, pitch: 0, pan: 0 }), src };
        refresh(); renderPads(); renderPad(); app.emit('studio-draw');
      }));
      padEdit.append(h('b', {}, `Pad ${i + 1}`), pick);
      if (pd) {
        padEdit.append(
          knob({ label: 'Volumen', value: pd.vol, def: 0.8, size: 40, onInput: x => { pd.vol = x; refresh(); } }).el,
          knob({ label: 'Afinar', min: -24, max: 24, step: 1, value: pd.pitch || 0, def: 0, bipolar: true, size: 40, fmt: x => (x > 0 ? '+' : '') + x, onInput: x => { pd.pitch = x; refresh(); } }).el,
          knob({ label: 'Paneo', min: -1, max: 1, value: pd.pan || 0, def: 0, bipolar: true, size: 40, fmt: panFmt, onInput: x => { pd.pan = x; refresh(); } }).el,
          h('button', { class: 'pill' + (pd.choke ? ' on' : ''), title: 'Grupo de corte: los pads con grupo se cortan entre sí (hi-hat abierto/cerrado)', onclick: () => { pd.choke = pd.choke ? 0 : 1; refresh(); renderPad(); } }, '✂ Corte'),
          h('button', { class: 'pill', onclick: () => { snapshot('Vaciar pad'); ins.pads[i] = null; refresh(); renderPads(); renderPad(); } }, '🗑'),
        );
      }
      padEdit.append(h('div', { class: 'hint' }, 'Arrastrá un sample del navegador a un pad para cargarlo.'));
    };
    renderPads(); renderPad();
    body.append(h('div', { class: 'drum-wrap' }, grid, padEdit));
  } else if (ins.type === 'sampler') {
    const pick = h('button', { class: 'pill' }, '🎻 ' + srcName(ins.src) + ' ▾');
    pick.addEventListener('click', () => pickKitSound(pick, src => { snapshot('Sample'); ins.src = src; refresh(); app.emit('studio'); }));
    body.append(h('div', { class: 'dside-row' }, pick, h('span', { class: 'hint' }, 'o arrastrá un sample del navegador acá')),
      h('div', { class: 'dev-knobs' },
        knob({ label: 'Nota base', min: 24, max: 96, step: 1, value: ins.root, def: 60, size: 42, fmt: noteName, onInput: x => { ins.root = x; refresh(); } }).el,
        knob({ label: 'Afinar', min: -12, max: 12, value: ins.tune, def: 0, bipolar: true, size: 42, fmt: x => (x > 0 ? '+' : '') + x.toFixed(2), onInput: x => { ins.tune = x; refresh(); } }).el,
        knob({ label: 'Ataque', min: 0.001, max: 2, value: ins.a, def: 0.002, size: 42, fmt: x => Math.round(x * 1000) + ' ms', onInput: x => { ins.a = x; refresh(); } }).el,
        knob({ label: 'Release', min: 0.01, max: 4, value: ins.r, def: 0.25, size: 42, fmt: x => x.toFixed(2) + ' s', onInput: x => { ins.r = x; refresh(); } }).el,
        knob({ label: 'Volumen', value: ins.vol, def: 0.8, size: 42, onInput: x => { ins.vol = x; refresh(); } }).el,
        toggle('🔁 Sostener en loop', !!ins.loop, x => { ins.loop = x; refresh(); }),
      ));
  }
  el.dataset.inst = t.id;
  return el;
}

function pickPreset(anchor, t) {
  const list = allPresets();
  let cat = 'all';
  const box = h('div', { class: 'preset-list' });
  const fill = () => {
    box.innerHTML = '';
    for (const p of list.filter(x => cat === 'all' || x.cat === cat)) {
      box.append(h('button', { class: 'menu-item' + (String(p.key) === String(t.inst.preset) ? ' on' : ''), onclick: () => {
        snapshot('Preset');
        const pr = presetById(p.key);
        t.inst = { type: 'synth', preset: p.key, params: { ...PRESET_DEFAULTS, ...pr.params } };
        studio.sync(); app.emit('studio');
        const ta = studio.ta(t.id); ta?.inst?.on(60, 0.8); setTimeout(() => ta?.inst?.off(60), 450);
      } }, (p.emoji || '★') + ' ' + p.name));
    }
  };
  const cats = h('div', { class: 'chips wrap' }, ...PRESET_CATS.filter(([k]) => k !== 'fav').map(([k, l]) => h('button', { class: 'chip' + (k === cat ? ' on' : ''), onclick: e => { cat = k; [...cats.children].forEach(c => c.classList.remove('on')); e.currentTarget.classList.add('on'); fill(); } }, l)));
  fill();
  popover(anchor, [h('h4', {}, 'Sonidos del synth'), cats, box], { cls: 'wide' });
}

const instViews = new Map(); // pista -> 'knobs' | 'play'
export const instView = id => instViews.get(id) || 'knobs';
export const setInstView = (id, v) => instViews.set(id, v);

// Sonidos del kit (rápido); los del banco se arrastran desde el navegador
function pickKitSound(anchor, onPick) {
  const items = [];
  app.kits.forEach((k, ki) => {
    items.push(h('h4', {}, k.name));
    items.push(h('div', { class: 'chips wrap' }, ...k.sounds.map((s, si) => h('button', { class: 'chip', onclick: () => { closePopover(); onPick({ kit: ki, idx: si, name: s.name }); } }, s.name))));
  });
  items.push(h('div', { class: 'hint' }, 'Más sonidos: arrastralos desde 📂 Samples del navegador.'));
  popover(anchor, items, { cls: 'wide' });
}

// =====================================================================
// Mezcla
// =====================================================================
function mixerView(el) {
  const st = S();
  const row = h('div', { class: 'mix-row' });
  el.append(row);
  const strips = [];
  for (const t of st.tracks) {
    const meter = h('i');
    const fader = vfader(t.vol, x => { t.vol = x; studio.applyTrack(t); }, t.color);
    const m = h('button', { class: 'sth-b act' + (t.mute ? '' : ' on') }, 'M');
    m.addEventListener('click', () => { t.mute = !t.mute; studio.applyMix(); app.emit('studio'); });
    const s = h('button', { class: 'sth-b solo' + (t.solo ? ' on' : '') }, 'S');
    s.addEventListener('click', () => { t.solo = !t.solo; studio.applyMix(); app.emit('studio'); });
    const strip = h('div', { class: 'mstrip' + (t.id === st.sel.track ? ' sel' : '') + (heard(t) ? '' : ' muted') },
      h('div', { class: 'ms-name' }, h('i', { style: { background: t.color } }), t.name),
      knob({ label: 'Paneo', min: -1, max: 1, value: t.pan, def: 0, bipolar: true, size: 34, color: t.color, fmt: panFmt, onInput: x => { t.pan = x; studio.applyTrack(t); } }).el,
      h('div', { class: 'ms-sends' },
        knob({ label: 'Rev', value: t.rev, def: 0, size: 30, color: '#54a0ff', onInput: x => { t.rev = x; studio.applyTrack(t); } }).el,
        knob({ label: 'Dly', value: t.dly, def: 0, size: 30, color: '#48dbb4', onInput: x => { t.dly = x; studio.applyTrack(t); } }).el),
      h('div', { class: 'ms-fader' }, fader, h('div', { class: 'ms-meter' }, meter)),
      h('div', { class: 'ms-btns' }, m, s));
    strip.addEventListener('click', e => { if (e.target === strip || e.target.closest('.ms-name')) { st.sel.track = t.id; app.emit('studio-sel'); } });
    strips.push({ t, meter });
    row.append(strip);
  }
  // Master
  const mMeter = h('i');
  const master = h('div', { class: 'mstrip master' },
    h('div', { class: 'ms-name' }, '★ Master'),
    knob({ label: 'Reverb', value: app.state.revLevel, def: 0.8, size: 34, color: '#54a0ff', onInput: x => { app.state.revLevel = x; A.reverbReturn.gain.setTargetAtTime(x, A.ctx.currentTime, 0.02); } }).el,
    knob({ label: 'Delay', value: app.state.dlyLevel ?? 0.75, def: 0.75, size: 34, color: '#48dbb4', onInput: x => { app.state.dlyLevel = x; A.delayReturn.gain.setTargetAtTime(x, A.ctx.currentTime, 0.02); } }).el,
    h('div', { class: 'ms-fader' }, vfader(app.state.master, x => { app.state.master = x; A.master.gain.setTargetAtTime(x, A.ctx.currentTime, 0.02); }, '#fff'), h('div', { class: 'ms-meter' }, mMeter)));
  row.append(master);
  const buf = new Float32Array(1024);
  return {
    frame() {
      for (const s of strips) s.meter.style.height = Math.min(100, Math.sqrt(studio.ta(s.t.id)?.level() || 0) * 100) + '%';
      A.analyser.getFloatTimeDomainData(buf);
      let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
      mMeter.style.height = Math.min(100, Math.sqrt(pk) * 100) + '%';
    },
  };
}

function vfader(v, onInput, color) {
  const fill = h('i');
  const el = h('div', { class: 'vfader', title: 'Volumen · doble toque = 0 dB' }, fill);
  el.style.setProperty('--c', color);
  const set = x => { v = Math.max(0, Math.min(1, x)); fill.style.height = (v * 100) + '%'; };
  let d = null, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    const now = performance.now();
    if (now - lastTap < 300) { set(0.8); onInput(v); return; }
    lastTap = now; el.setPointerCapture(e.pointerId); d = { y: e.clientY, v };
  });
  el.addEventListener('pointermove', e => { if (!d) return; set(d.v + (d.y - e.clientY) / el.clientHeight); onInput(v); });
  el.addEventListener('pointerup', () => { d = null; });
  set(v);
  return el;
}

const fmtBeats = b => (b >= 4 && b % 4 === 0 ? `${b / 4} comp.` : b >= 1 ? `${b} tiempos` : `${b * 4}/16`);
