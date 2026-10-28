// Vista de detalle del Estudio (abajo): Clip (piano roll / grilla de batería / onda de audio),
// Dispositivos (efectos MIDI → instrumento → efectos de audio, de izquierda a derecha)
// y Mezcla (todas las pistas como canales).
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { h, popover, closePopover, toast, toggle, ink, isLight } from '../ui/util.js';
import { knob } from '../ui/knob.js';
import { SYNTH_SPECS } from '../ui/params.js';
import { allPresets } from '../ui/presets.js';
import { presetById, setCustomSample } from '../actions.js';
import { PRESET_CATS, PRESET_DEFAULTS } from '../audio/presets.js';
import { noteName, NOTE_NAMES } from '../scales.js';
import { silenceRange, deleteRange, copyRange } from '../audio/edit.js';
import {
  S, uid, clone, spb, selClip, selTrack, findTrack, gridBeats, snapB, getBuffer, putBuffer, peaksOf, clipNotes,
  DRUM_NOTE, DRUM_PADS, srcName, synthInst, drumInst, samplerInst, audible,
} from './model.js';
import { studio, faderGain } from './engine.js';
import { AUDIO_FX, MIDI_FX, AUDIO_FX_KEYS, MIDI_FX_KEYS, defaultsOf } from './devices.js';
import { gestures, fitCanvas, pointAnchor } from './gest.js';
import { snapshot, norm, denorm, mfader, splitAt, copyClip } from './ui.js';

export function buildDetail(el, { arr }) {
  const st = S();
  const tabs = h('div', { class: 'st-dtabs' });
  const bodyEl = h('div', { class: 'st-dbody' });
  el.append(tabs, bodyEl);
  let view = null; // editor actual {draw(), frame(), deleteSel()}

  function setTab(k) { st.detail = k; render(); }

  function render() {
    if (el.hidden) return;
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
    const hide = h('button', { class: 'round sm', title: 'Ocultar el detalle' }, '▾');
    hide.addEventListener('click', () => { st.detailH = 0; app.emit('studio-layout'); });
    tabs.append(hide);

    bodyEl.innerHTML = '';
    view = null;
    if (k === 'clip') view = sc.c.kind === 'midi' ? midiEditor(bodyEl, sc.t, sc.c) : audioEditor(bodyEl, sc.t, sc.c, arr);
    else if (k === 'devices') view = deviceView(bodyEl, t);
    else view = mixerView(bodyEl);
  }

  return {
    render,
    draw() { view?.draw?.(); },
    frame() { view?.frame?.(); },
    deleteSel() { return view?.deleteSel?.() || false; },
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

  // Vista: ajustada al loop del clip
  const KEYS_W = drums ? 92 : 46, VEL_H = 54;
  const vw = () => cv.clientWidth - KEYS_W;
  const v = c._view ||= { zoom: 0, sx: 0, sy: null, rowH: drums ? 26 : 14, fold: false };
  if (!v.zoom) v.zoom = Math.max(8, (el.clientWidth - 260 - KEYS_W) / Math.max(1, c.loop || c.len));
  let hoverP = null, painting = null;

  const rows = () => {
    // Batería: el pad 1 arriba; solo los pads con sonido o con golpes
    if (drums) {
      const out = [];
      for (let i = 0; i < DRUM_PADS; i++) if (t.inst.pads[i] || c.notes.some(n => n.p === DRUM_NOTE + i)) out.push(DRUM_NOTE + i);
      if (v.allPads) return Array.from({ length: DRUM_PADS }, (_, i) => DRUM_NOTE + i);
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
    v.sy = drums ? 0 : Math.max(0, i * v.rowH - 120);
  }
  const X = b => KEYS_W + (b - v.sx) * v.zoom;
  const B = x => (x - KEYS_W) / v.zoom + v.sx;
  const gridH = () => cv.clientHeight - VEL_H;
  const rowAt = y => { const rs = rows(), i = Math.floor((y + v.sy) / v.rowH); return i >= 0 && i < rs.length ? rs[i] : null; };
  const rowY = p => rows().indexOf(p) * v.rowH - v.sy;
  const gb = () => gridBeats(v.zoom * 1.6);
  const L = () => c.loop || c.len;

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
    side.append(
      h('div', { class: 'dside-row' }, h('b', {}, 'Loop'), h('div', { class: 'stepper sm' },
        h('button', { onclick: () => setLoop(L() <= 1 ? L() / 2 : L() - (L() > 4 ? 4 : 1)) }, '−'), loopLbl,
        h('button', { onclick: () => setLoop(L() < 1 ? L() * 2 : L() + (L() >= 4 ? 4 : 1)) }, '＋'))),
      h('button', { class: 'pill', title: 'Duplica el loop con sus notas (como en Ableton)', onclick: () => {
        snapshot('Duplicar loop');
        const l = L(); c.notes = c.notes.filter(n => n.s < l); c.notes = c.notes.concat(c.notes.map(n => ({ ...n, s: n.s + l })));
        c.loop = l * 2; if (c.len < c.loop) c.len = c.loop; renderSide(); app.emit('studio');
      } }, '×2 Duplicar loop'),
      h('button', { class: 'pill', title: 'Lleva las notas a la grilla', onclick: () => {
        snapshot('Cuantizar');
        const g = gb() || 0.25; c.notes.forEach(n => { n.s = Math.max(0, snapB(n.s, g)); });
        dedupe(); app.emit('studio-draw');
      } }, '🧲 Cuantizar'),
      h('div', { class: 'dside-row' }, h('b', {}, 'Transp.'), h('div', { class: 'stepper sm' },
        h('button', { onclick: () => transpose(-12) }, '−8'), h('button', { onclick: () => transpose(-1) }, '−1'),
        h('button', { onclick: () => transpose(1) }, '+1'), h('button', { onclick: () => transpose(12) }, '+8'))),
      drums ? toggle('Los 16 pads', !!v.allPads, x => { v.allPads = x; v.sy = 0; draw(); }) : toggle('Plegar', v.fold, x => { v.fold = x; v.sy = 0; draw(); }),
      h('button', { class: 'pill', onclick: () => copyClip(c) }, '📋 Copiar clip'),
      h('button', { class: 'pill danger', onclick: () => { if (!c.notes.length) return; snapshot('Borrar notas'); c.notes = []; app.emit('studio-draw'); } }, '🗑 Borrar notas'),
      h('div', { class: 'hint' }, drums
        ? 'Lápiz o dedo: tocá un casillero para poner o sacar un golpe. Arrastrá un golpe para moverlo. Abajo, la fuerza.'
        : 'Tocá para poner o sacar una nota. Arrastrá para moverla, del borde derecho para alargarla. Las teclas de la izquierda suenan.'),
    );
  }
  function transpose(d) {
    snapshot('Transponer', 'tr' + c.id);
    if (drums) return;
    c.notes.forEach(n => { n.p = Math.max(0, Math.min(127, n.p + d)); });
    app.emit('studio-draw');
  }
  const dedupe = () => {
    const seen = new Set();
    c.notes = c.notes.filter(n => { const k = n.p + ':' + n.s.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  renderSide();

  // ---- Dibujo ----
  function draw() {
    if (!cv.isConnected) return;
    const { g, w, h: hh } = fitCanvas(cv);
    const gh = hh - VEL_H, rs = rows();
    if (drums) v.rowH = Math.max(16, Math.min(34, Math.floor(gh / rs.length)));
    v.sy = Math.max(0, Math.min(Math.max(0, rs.length * v.rowH - gh), v.sy));
    v.sx = Math.max(0, v.sx);
    g.clearRect(0, 0, w, hh);
    // Filas
    rs.forEach((p, i) => {
      const y = i * v.rowH - v.sy;
      if (y + v.rowH < 0 || y > gh) return;
      const black = [1, 3, 6, 8, 10].includes(p % 12);
      g.fillStyle = drums ? (i % 2 ? ink(0.025) : ink(0.045)) : black ? ink(0.012) : ink(0.045);
      g.fillRect(KEYS_W, y, w - KEYS_W, v.rowH - 1);
      if (!drums && p % 12 === 0) { g.fillStyle = ink(0.12); g.fillRect(KEYS_W, y + v.rowH - 1, w, 1); }
    });
    // Grilla y loop
    const gg = gb() || 0.25;
    for (let b = Math.floor(v.sx / gg) * gg; X(b) < w; b += gg) {
      if (b < 0) continue;
      g.fillStyle = b % 4 === 0 ? ink(0.2) : b % 1 === 0 ? ink(0.09) : ink(0.04);
      g.fillRect(Math.round(X(b)), 0, 1, gh);
    }
    g.fillStyle = shadeOut(); g.fillRect(X(L()), 0, Math.max(0, w - X(L())), gh);
    g.fillStyle = '#7cf0b0'; g.fillRect(X(L()) - 1, 0, 2, gh);
    // Repeticiones (fantasmas) y notas
    const col = c.color || t.color;
    const vis = b => X(b) < w && X(b) > KEYS_W - 400;
    for (let k = 1; k * L() < c.len; k++) for (const n of c.notes) {
      const s = n.s + k * L(); if (!vis(s)) continue;
      const y = rowY(n.p); if (y < -v.rowH || y > gh) continue;
      g.fillStyle = ink(0.12); g.fillRect(X(s), y + 1, Math.max(3, n.d * v.zoom - 1), v.rowH - 2);
    }
    for (const n of c.notes) {
      if (!vis(n.s)) continue;
      const y = rowY(n.p); if (y < -v.rowH || y > gh) continue;
      const x = X(n.s), nw = Math.max(drums ? 8 : 4, n.d * v.zoom - 1);
      g.fillStyle = col; g.globalAlpha = 0.45 + 0.55 * n.v;
      g.fillRect(x, y + 1, nw, v.rowH - 2);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.strokeRect(x + 0.5, y + 1.5, nw - 1, v.rowH - 3);
    }
    // Lápiz en el aire
    if (hoverP && hoverP.p != null && hoverP.x > KEYS_W) {
      const y = rowY(hoverP.p), b = snapB(B(hoverP.x), gg, 'floor');
      g.strokeStyle = 'rgba(255,142,212,0.8)'; g.lineWidth = 1.5;
      g.strokeRect(X(b) + 0.5, y + 1, gg * v.zoom - 1, v.rowH - 2);
    }
    // Cabezal
    if (studio.playing) {
      const hb = studio.heardBeat();
      if (hb >= c.start && hb < c.start + c.len) {
        const rel = (hb - c.start) % L();
        g.fillStyle = isLight() ? '#120d1a' : '#fff'; g.fillRect(Math.round(X(rel)), 0, 2, hh);
      }
    }
    // Teclas / nombres de los pads
    g.fillStyle = isLight() ? '#efe7da' : '#1a1522'; g.fillRect(0, 0, KEYS_W, gh);
    g.font = `600 ${drums ? 11 : 9}px ${getComputedStyle(document.body).fontFamily}`;
    rs.forEach((p, i) => {
      const y = i * v.rowH - v.sy;
      if (y + v.rowH < 0 || y > gh) return;
      if (drums) {
        const pd = t.inst.pads[p - DRUM_NOTE];
        g.fillStyle = held.has(p) ? col : ink(0.06); g.fillRect(2, y + 1, KEYS_W - 4, v.rowH - 2);
        g.fillStyle = pd ? ink(0.85) : ink(0.3);
        g.fillText(`${p - DRUM_NOTE + 1} ${pd ? srcName(pd.src) : '—'}`.slice(0, 13), 6, y + v.rowH / 2 + 4);
      } else {
        const black = [1, 3, 6, 8, 10].includes(p % 12);
        g.fillStyle = held.has(p) ? col : black ? (isLight() ? '#2a2233' : '#0d0a12') : (isLight() ? '#fff' : '#d9d2e6');
        g.fillRect(0, y + 0.5, black ? KEYS_W * 0.62 : KEYS_W - 2, v.rowH - 1);
        if (p % 12 === 0 && v.rowH >= 9) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillText(noteName(p), KEYS_W - 26, y + v.rowH - 3); }
      }
    });
    // Fuerza (velocity)
    g.fillStyle = ink(0.04); g.fillRect(0, gh, w, VEL_H);
    g.fillStyle = ink(0.12); g.fillRect(0, gh, w, 1);
    g.fillStyle = ink(0.45); g.font = '600 10px sans-serif'; g.fillText('Fuerza', 6, gh + VEL_H / 2 + 3);
    for (const n of c.notes) {
      if (!vis(n.s)) continue;
      const x = X(n.s), bh = (VEL_H - 8) * n.v;
      g.fillStyle = col; g.fillRect(x, gh + VEL_H - 3 - bh, 3, bh);
      g.beginPath(); g.arc(x + 1.5, gh + VEL_H - 3 - bh, 3, 0, 7); g.fill();
    }
  }
  const shadeOut = () => (isLight() ? 'rgba(60,40,80,0.08)' : 'rgba(0,0,0,0.28)');

  // ---- Interacción ----
  const held = new Set();
  const audition = (p, on) => {
    const ta = studio.ta(t.id); if (!ta?.inst) return;
    if (on) { ta.inst.on(p, 0.85); held.add(p); } else { ta.inst.off(p); held.delete(p); }
    draw();
  };
  const noteAt = (p, b) => c.notes.find(n => n.p === p && b >= n.s - 1e-6 && b < n.s + Math.max(n.d, drums ? 0.12 : 0));

  function editDown(pt, e, touch) {
    if (pt.y > gridH()) return velDrag(pt);
    if (pt.x < KEYS_W) {
      const p = rowAt(pt.y); if (p == null) return null;
      audition(p, true);
      return { move() { /* */ }, up() { audition(p, false); } };
    }
    const p = rowAt(pt.y), b = B(pt.x);
    if (p == null || b < 0) return null;
    const gg = gb() || 0.25;
    const n = noteAt(p, b);
    if (n) {
      const right = !drums && X(n.s + n.d) - pt.x < (touch ? 14 : 8) && n.d * v.zoom > 16;
      const o = { ...n }, b0 = b, p0 = p;
      let began = false;
      let copy = e.ctrlKey || e.metaKey;
      return {
        move(q, ev) {
          if (!began) { began = true; snapshot(right ? 'Alargar nota' : 'Mover nota'); if (copy) c.notes.push({ ...o }); }
          const free = ev?.altKey;
          if (right) n.d = Math.max(free ? 0.03 : gg, (free ? B(q.x) : snapB(B(q.x), gg)) - n.s);
          else {
            const ns = o.s + B(q.x) - b0;
            n.s = Math.max(0, Math.min(L() - 0.001, free ? ns : snapB(ns, gg)));
            const np = rowAt(q.y); if (np != null && np !== n.p) { n.p = np; if (!drums || true) { audition(np, true); setTimeout(() => audition(np, false), 120); } }
          }
          app.emit('studio-draw');
        },
        up(q, ev, tap) {
          if (!began && tap) { snapshot('Borrar nota'); c.notes = c.notes.filter(x => x !== n); app.emit('studio-draw'); }
          else if (began) { dedupe(); app.emit('studio-draw'); }
        },
      };
    }
    // Nota nueva (y en modo dibujo, pintar varias arrastrando)
    if (b >= L()) return null;
    snapshot('Nota nueva');
    const s0 = snapB(b, gg, 'floor');
    const nn = { p, s: s0, d: drums ? gg : gg, v: 0.8 };
    c.notes.push(nn);
    audition(p, true); setTimeout(() => audition(p, false), 140);
    app.emit('studio-draw');
    const paint = st.draw || drums;
    return {
      move(q) {
        if (paint) {
          const s = snapB(B(q.x), gg, 'floor'), pp = drums ? (rowAt(q.y) ?? p) : p;
          if (s >= 0 && s < L() && !noteAt(pp, s + 1e-4)) { c.notes.push({ p: pp, s, d: gg, v: 0.8 }); app.emit('studio-draw'); }
        } else {
          nn.d = Math.max(gg, snapB(B(q.x), gg, 'ceil') - nn.s);
          app.emit('studio-draw');
        }
      },
      up() { /* */ },
    };
  }

  // Pintar la fuerza: arrastrá sobre las barritas
  function velDrag(pt) {
    snapshot('Fuerza', 'vel' + c.id);
    const set = q => {
      const val = Math.max(0.05, Math.min(1, (gridH() + VEL_H - 3 - q.y) / (VEL_H - 8)));
      const b = B(q.x), tol = 6 / v.zoom;
      let hitAny = false;
      for (const n of c.notes) if (Math.abs(n.s - b) < tol) { n.v = Math.round(val * 100) / 100; hitAny = true; }
      if (hitAny) draw();
    };
    set(pt);
    return { move: set, up() { app.emit('studio-draw'); } };
  }

  gestures(cv, {
    drawTouch: () => false,
    down: (p, e) => editDown(p, e, false),
    long: p => editDown(p, {}, true),
    tap(p, e) {
      if (e.pointerType !== 'touch') return;
      // dedo: tocar pone o saca una nota (como pintar cuadraditos)
      if (p.y > gridH()) { const d = velDrag(p); d.up(); return; }
      if (p.x < KEYS_W) { const r = rowAt(p.y); if (r != null) { audition(r, true); setTimeout(() => audition(r, false), 220); } return; }
      const r = rowAt(p.y), b = B(p.x); if (r == null || b < 0 || b >= L()) return;
      const n = noteAt(r, b), gg = gb() || 0.25;
      snapshot(n ? 'Borrar nota' : 'Nota nueva');
      if (n) c.notes = c.notes.filter(x => x !== n);
      else { c.notes.push({ p: r, s: snapB(b, gg, 'floor'), d: gg, v: 0.8 }); audition(r, true); setTimeout(() => audition(r, false), 140); }
      app.emit('studio-draw');
    },
    context(p, e) {
      popover(pointAnchor(e.clientX, e.clientY), [
        h('h4', {}, 'Notas'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); snapshot('Cuantizar'); const g = gb() || 0.25; c.notes.forEach(n => { n.s = snapB(n.s, g); }); dedupe(); app.emit('studio-draw'); } }, '🧲 Cuantizar todo'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); snapshot('Legato'); const ns = c.notes.slice().sort((a, b) => a.s - b.s); ns.forEach((n, i) => { const nx = ns.find((m, j) => j > i && m.s > n.s + 1e-6); n.d = (nx ? nx.s : L()) - n.s; }); app.emit('studio-draw'); } }, '⟿ Legato (hasta la siguiente)'),
        h('button', { class: 'menu-item', onclick: () => { closePopover(); snapshot('Fuerza pareja'); c.notes.forEach(n => { n.v = 0.8; }); app.emit('studio-draw'); } }, '▬ Fuerza pareja'),
        h('button', { class: 'menu-item danger', onclick: () => { closePopover(); snapshot('Borrar notas'); c.notes = []; app.emit('studio-draw'); } }, '🗑 Borrar todas'),
      ]);
    },
    hover(p) { hoverP = p ? { x: p.x, p: p.y < gridH() ? rowAt(p.y) : null } : null; cv.style.cursor = p && p.x > KEYS_W && p.y < gridH() ? 'crosshair' : 'default'; draw(); },
    pan(dx, dy) { v.sx -= dx / v.zoom; v.sy -= dy; draw(); },
    pinch(r, cx, cy, dx, dy) { const b = B(cx); v.zoom = Math.max(4, Math.min(600, v.zoom * r)); v.sx = b - (cx - KEYS_W) / v.zoom - dx / v.zoom; v.sy -= dy; draw(); },
    wheel(p, e) {
      if (e.ctrlKey || e.metaKey) { const b = B(p.x); v.zoom = Math.max(4, Math.min(600, v.zoom * Math.exp(-e.deltaY * 0.003))); v.sx = b - (p.x - KEYS_W) / v.zoom; }
      else if (e.shiftKey) v.sx += e.deltaY / v.zoom;
      else v.sy += e.deltaY;
      draw();
    },
  });

  requestAnimationFrame(draw);
  return {
    draw,
    frame() { if (studio.playing) draw(); },
  };
}

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
  const el = h('div', { class: 'dev inst' }, h('div', { class: 'dev-head' }, h('b', {}, 'Instrumento'), h('div', { style: { flex: 1 } }), kinds), body);
  const refresh = () => studio.ta(t.id)?.inst?.update(t.inst);

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
    const strip = h('div', { class: 'mstrip' + (t.id === st.sel.track ? ' sel' : '') + (audible(t) ? '' : ' muted') },
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
