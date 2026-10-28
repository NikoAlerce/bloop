// Modo Estudio (vista Arrangement): datos del arreglo y audio de los clips.
// Todo el arreglo vive en app.state.studio (se guarda con el proyecto). El audio de los clips
// se guarda aparte en IndexedDB ('sbuf:<id>'), y nunca se modifica: editar crea un buffer nuevo
// (así deshacer es solo volver a la foto anterior del arreglo).
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { kvGet, kvSet, kvDel, kvKeys, bufferToStore, storeToBuffer, TRACK_COLORS } from '../state.js';
import { PRESETS, PRESET_DEFAULTS } from '../audio/presets.js';
import { GRIDS } from '../quant.js';

// Paleta de clips/pistas (la de Ableton, un poco más viva)
export const COLORS = ['#ff6b6b', '#ff9f43', '#fecb57', '#d6e95a', '#9be564', '#48dbb4', '#4fd1e8', '#54a0ff',
  '#7d8cff', '#a29bfe', '#c792ff', '#ff8ed4', '#e0a87c', '#b8c4a8', '#9aa7b8', '#f2f2f2'];

let n = 0;
export const uid = p => p + Date.now().toString(36).slice(-5) + (n++).toString(36) + Math.random().toString(36).slice(2, 4);
export const clone = o => JSON.parse(JSON.stringify(o));

export const spb = () => 60 / app.state.bpm;          // segundos por tiempo (negra)
export const S = () => app.state.studio;

export const DRUM_NOTE = 36;                           // C1 = pad 1 (como el Drum Rack)
export const DRUM_PADS = 16;

export function defaultStudio() {
  return {
    v: 1, tracks: [], loop: { on: false, a: 0, b: 16 }, pos: 0,
    zoom: 22, sx: 0, sy: 0, grid: 'auto', draw: false, follow: true,
    sel: { track: null, clip: null }, detail: 'clip', detailH: 300, browser: true, browserCat: 'inst',
    rec: false, countIn: 1, metro: false, nextColor: 0, kb: false,
  };
}

export function nextColor() {
  const st = S(); const c = COLORS[(st.nextColor || 0) % COLORS.length];
  st.nextColor = (st.nextColor || 0) + 3; return c;
}

export const synthInst = (preset = 0) => ({ type: 'synth', preset, params: { ...PRESET_DEFAULTS, ...(PRESETS[preset] || PRESETS[0]).params } });
// Drum Rack: 16 pads; cada pad es un sonido del kit, del banco o un buffer propio
export function drumInst(kit = app.state.kit || 0) {
  const pads = [];
  for (let i = 0; i < DRUM_PADS; i++) pads.push(i < 8 ? { src: { kit, idx: i }, vol: 0.8, pitch: 0, pan: 0 } : null);
  return { type: 'drums', pads, sel: 0 };
}
export const samplerInst = src => ({ type: 'sampler', src, root: 60, tune: 0, a: 0.002, r: 0.25, vol: 0.8, loop: false });

export function newTrack(kind, opts = {}) {
  const st = S();
  const count = st.tracks.filter(t => t.kind === kind).length + 1;
  return {
    id: uid('t'), kind, name: opts.name || (kind === 'audio' ? `Audio ${count}` : `MIDI ${count}`), color: opts.color || nextColor(),
    vol: 0.8, pan: 0, rev: 0, dly: 0, mute: false, solo: false, arm: false, mon: false, h: 76,
    inst: kind === 'midi' ? (opts.inst || synthInst(0)) : null,
    midiFx: [], devices: [], auto: {}, autoKey: 'vol', autoOn: false, clips: [],
  };
}

export function newMidiClip(start, len, color, notes = []) {
  return { id: uid('c'), kind: 'midi', start, len, loop: len, name: '', color, notes };
}
export function newAudioClip(start, buf, bufId, color, bpm = app.state.bpm, name = '') {
  return {
    id: uid('c'), kind: 'audio', start, len: buf.duration / (60 / bpm), name, color,
    buf: bufId, off: 0, gain: 1, bpm, warp: true, fadeIn: 0.003, fadeOut: 0.003,
  };
}

export const findTrack = id => S().tracks.find(t => t.id === id) || null;
export function findClip(id) {
  for (const t of S().tracks) { const c = t.clips.find(c => c.id === id); if (c) return { t, c }; }
  return null;
}
export const selTrack = () => findTrack(S().sel.track);
export const selClip = () => (S().sel.clip ? findClip(S().sel.clip) : null);

// Grilla: tamaño en tiempos. 'auto' se adapta al zoom (nunca menos de ~14 px por línea)
export const GRID_OPTS = ['auto', 'bar', '1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T', 'off'];
export function gridBeats(zoom, grid = S().grid) {
  if (grid === 'off') return 0;
  if (grid === 'bar') return 4;
  if (grid === 'auto') {
    let g = 4;
    while (g / 2 * zoom >= 14 && g > 0.125) g /= 2;
    while (g * zoom < 14) g *= 2;
    return g;
  }
  return (GRIDS[grid] || 1) / 4;
}
export const snapB = (b, g, mode = 'round') => (g ? Math[mode](b / g + 1e-9) * g : b);

// Fin del arreglo (último clip)
export function songEnd() {
  let e = 0;
  for (const t of S().tracks) for (const c of t.clips) e = Math.max(e, c.start + c.len);
  return e;
}

export function audible(t) {
  const any = S().tracks.some(x => x.solo);
  return any ? t.solo : !t.mute;
}

// Notas de un clip MIDI dentro de su largo, repitiendo el loop: [{p, s (absoluto en tiempos), d, v}]
export function clipNotes(c, from = c.start, to = c.start + c.len) {
  const out = [], L = c.loop || c.len;
  if (L <= 0) return out;
  const k0 = Math.max(0, Math.floor((from - c.start) / L) - 1);
  for (let k = k0; c.start + k * L < Math.min(to, c.start + c.len); k++) {
    for (const nt of c.notes) {
      if (nt.s >= L) continue;
      const s = c.start + k * L + nt.s;
      if (s >= c.start + c.len || s < from || s >= to) continue;
      const end = Math.min(s + nt.d, c.start + c.len, c.start + (k + 1) * L);
      out.push({ p: nt.p, s, d: Math.max(0.01, end - s), v: nt.v });
    }
  }
  return out;
}

// ---------- Buffers de audio ----------
export const buffers = new Map(); // id -> AudioBuffer
const peaksCache = new Map();

export function putBuffer(buf) {
  const id = uid('b');
  buffers.set(id, buf);
  kvSet('sbuf:' + id, bufferToStore(buf));
  return id;
}
export const getBuffer = id => buffers.get(id) || null;

export async function loadBuffers() {
  const st = S(), need = new Set();
  for (const t of st.tracks) {
    for (const c of t.clips) if (c.buf) need.add(c.buf);
    for (const p of t.inst?.pads || []) if (p?.src?.buf) need.add(p.src.buf);
    if (t.inst?.src?.buf) need.add(t.inst.src.buf);
  }
  for (const id of need) {
    if (buffers.has(id)) continue;
    const o = await kvGet('sbuf:' + id);
    if (o) buffers.set(id, storeToBuffer(A.ctx, o));
  }
  return need;
}
// Borra el audio que ya no usa nadie (ni el arreglo ni lo que se puede deshacer en esta sesión)
export async function gcBuffers(keep) {
  for (const k of await kvKeys()) {
    const s = String(k);
    if (s.startsWith('sbuf:') && !keep.has(s.slice(5)) && !buffers.has(s.slice(5))) kvDel(k);
  }
}

// Picos para dibujar la onda: min/max cada 256 muestras (canal 0+1)
export function peaksOf(id) {
  if (peaksCache.has(id)) return peaksCache.get(id);
  const b = buffers.get(id);
  if (!b) return null;
  const H = 256, n2 = Math.ceil(b.length / H), mn = new Float32Array(n2), mx = new Float32Array(n2);
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  for (let k = 0; k < n2; k++) {
    let lo = 0, hi = 0;
    for (let i = k * H, e = Math.min(b.length, i + H); i < e; i++) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    mn[k] = lo; mx[k] = hi;
  }
  const p = { mn, mx, H, sr: b.sampleRate };
  peaksCache.set(id, p);
  return p;
}

// Sonido de un pad / sampler: {kit, idx} | {bank:{pack,id}} | {buf: id}
export async function resolveSrc(src) {
  if (!src) return null;
  if (src.buf) return { buffer: buffers.get(src.buf) || null };
  if (src.bank) {
    const { bank } = await import('../bank.js');
    try { return await bank.load(src.bank.pack, src.bank.id); } catch (e) { return null; }
  }
  const kit = app.kits[src.kit] || app.kits[0];
  const s = kit?.sounds[src.idx];
  return s ? { buffer: s.buffer } : null;
}
export function srcName(src) {
  if (!src) return '—';
  if (src.name) return src.name;
  if (src.buf) return 'Grabación';
  const kit = app.kits[src.kit] || app.kits[0];
  return kit?.sounds[src.idx]?.name || '—';
}

export const trackColorFor = i => TRACK_COLORS[i % TRACK_COLORS.length];
