// Arma el loop a partir de lo que tocaste en vivo (fuente 🎹).
// Bloop registra cada golpe y cada nota con dos tiempos: cuándo SONÓ y cuándo lo TOCASTE
// (lo que estabas escuchando en ese instante). Lo que vale musicalmente es lo segundo:
// en la tablet hay demora entre el toque y el sonido, y no tiene que correr la grabación.
//  - Golpes cortos (pads): se corta el audio en cada golpe y se corre a su lugar.
//  - Notas (synth, sampler en notas): se re-tocan con el mismo sonido en su lugar exacto,
//    así las notas largas, acordes y colas quedan enteros y suena lo que tocaste.
import { A, heardTime, capture, makePrint, detectTransients } from './engine.js';
import { Synth } from './synth.js';
import { TrackStrip } from './sampler.js';
import { app } from '../app.js';

// Lo tocado en vivo: { t: cuándo sonó, h: cuándo lo tocaste (tiempo de la música), type, … }
export const liveLog = [];
export function logLive(t, ev = {}) {
  const ts = app.lastInputTs;
  const fresh = ts && performance.now() - ts < 80;
  liveLog.push({ t, h: heardTime(fresh ? ts : undefined), ...ev });
  if (liveLog.length > 600) liveLog.splice(0, liveLog.length - 600);
}
export const isOn = e => e.type === 'hit' || e.type === 'son' || e.type === 'pon';
export const isNote = e => e.type === 'son' || e.type === 'pon';

/**
 * Audio cortado y corrido a su lugar (para golpes).
 * cap: audio grabado desde (inicio del loop − pre) · pre/len en segundos
 * hits: [{ at: dónde está el golpe en el audio (s), want: dónde lo tocaste (s) }]
 * place: posición (s) → dónde debe quedar (s); null = donde lo tocaste
 * edge: cuánto antes del 1 (o del final) un golpe todavía cuenta como el 1
 */
export function buildLoop(cap, { pre, len, hits, place, edge = 0.06, tail = Infinity, lead = 0.006 }) {
  const sr = cap.sampleRate, P = Math.round(pre * sr), N = Math.max(1, Math.round(len * sr));
  const F = Math.round(0.003 * sr), LD = Math.max(2 * F, Math.round(lead * sr));
  const out = A.ctx.createBuffer(2, N, sr);
  const src = [cap.getChannelData(0), cap.getChannelData(Math.min(1, cap.numberOfChannels - 1))];
  const dst = [out.getChannelData(0), out.getChannelData(1)];
  const capLen = cap.length;

  // Golpes ordenados; los que caen casi juntos (dos pads a la vez) cuentan como uno
  const all = hits.slice().sort((a, b) => a.at - b.at);
  const on = [];
  for (const x of all) if (!on.length || x.at - on[on.length - 1].at > 0.02) on.push(x);
  const valid = on.filter(x => x.want >= -edge && x.want < len + edge);
  const firstAfter = on.find(x => x.want >= len + edge);     // lo tocado después: no entra
  const before = on.filter(x => x.want < -edge).pop();      // lo tocado antes: no entra
  const S = x => Math.round(x * sr);
  const endSrc = Math.min(capLen - P, firstAfter ? S(firstAfter.at) : Infinity, S(len + tail));

  // Copia el tramo [a, b) del audio (posiciones del loop, en muestras) corrido "shift"
  const put = (a, b, shift, fadeIn, fadeOut) => {
    a = Math.max(a, -P); b = Math.min(b, capLen - P);
    for (let x = a; x < b; x++) {
      let w = 1;
      if (fadeIn && x - a < 2 * F) w = (x - a) / (2 * F);
      if (fadeOut && b - x < 2 * F) w = Math.min(w, (b - x) / (2 * F));
      let d = (x + shift) % N; if (d < 0) d += N;
      const si = x + P;
      dst[0][d] += src[0][si] * w; dst[1][d] += src[1][si] * w;
    }
  };

  if (!valid.length) {
    put(before ? S(before.at) + 2 * F : -P, endSrc, 0, true, true);
    return out;
  }
  // Cada tramo va de un golpe al siguiente; el crossfade queda justo ANTES de cada golpe
  const v0 = S(valid[0].at);
  if (v0 - LD + 2 * F > 0) put(Math.max(0, before ? S(before.at) + 2 * F : 0), v0 - LD + 2 * F, 0, !!before, true);
  const shiftOf = k => S(place ? place(valid[k].want) : valid[k].want) - S(valid[k].at);
  for (let k = 0; k < valid.length; k++) {
    // El tramo arranca un poco antes del golpe (para no perder el comienzo del ataque) y
    // termina con un fundido corto justo antes del margen del golpe siguiente. Si el golpe
    // siguiente se corre más tarde que este, quedaría un hueco: el tramo se estira para
    // taparlo (sin pasar el ataque del golpe siguiente).
    const o = S(valid[k].at), sh = shiftOf(k);
    let next = endSrc;
    if (k + 1 < valid.length) {
      const gap = Math.max(0, shiftOf(k + 1) - sh);
      next = S(valid[k + 1].at) - LD + 2 * F + Math.min(gap, LD - 2 * F);
    }
    put(o - LD, Math.max(o - LD + 4 * F, next), sh, true, true);
  }
  return out;
}

// Foto del sonido en el momento de grabar (si después cambiás de preset, el loop no cambia)
export function soundSnapshot() {
  const st = app.state, copy = o => JSON.parse(JSON.stringify(o));
  return {
    synth: copy(app.synth.p), synthFx: copy(st.synth.fx), synthLevel: app.synth.level ?? 1, synthAudible: app.audible(8),
    tracks: st.tracks.map((t, i) => ({ p: copy(t.params), audible: app.audible(i), choke: t.choke })),
  };
}

/**
 * Re-toca las notas en su lugar, con el sonido de la foto, por un canal que no se escucha,
 * y devuelve el loop (las colas que pasan el final se suman al principio).
 * notes: [{ type: 'son'|'pon'|'hit', at (s, dentro del loop), dur (s), midi, vel, i, k }]
 */
export async function renderNotes(notes, { len, snap, tail = 2.5 }) {
  const ctx = A.ctx, sink = makePrint();
  const T0 = ctx.currentTime + 0.25;
  const job = capture(sink.out, T0, len + tail);

  let synth = null;
  const getSynth = () => {
    if (!synth) {
      synth = new Synth(sink);
      synth.getBpm = app.synth.getBpm;
      synth.setParams(snap.synth);
      synth.level = snap.synthLevel;
      synth.apply(snap.synthAudible, snap.synthFx);
    }
    return synth;
  };
  const strips = {}, pools = {};
  const strip = i => {
    if (!strips[i]) { strips[i] = new TrackStrip(null, false, sink); strips[i].apply(snap.tracks[i].p, snap.tracks[i].audible); }
    return strips[i];
  };
  const pool = i => (pools[i] ||= []);

  const ev = [];
  for (const n of notes) {
    const t = T0 + n.at, off = t + Math.max(0.02, n.dur || 0);
    if (n.type === 'son') {
      ev.push({ t, f: () => getSynth().noteOn(n.midi, n.vel, t) });
      ev.push({ t: off, off: true, f: () => getSynth().noteOff(n.midi, off) });
    } else if (n.type === 'hit') {
      ev.push({ t, f: () => {
        const tr = snap.tracks[n.i], p = tr.p;
        if (tr.choke) snap.tracks.forEach((o, j) => { if (j !== n.i && o.choke === tr.choke && pools[j]) app.tracks[j].choke(t, pools[j]); });
        const opt = { dest: strip(n.i), pool: pool(n.i) };
        app.tracks[n.i].trigger(t, n.vel, 0, p, p.sliceMode && p.slices.length ? { ...opt, slice: 0 } : opt);
      } });
    } else if (n.type === 'pon') {
      let voice = null;
      ev.push({ t, f: () => {
        const p = snap.tracks[n.i].p;
        const opt = { poly: true, hold: true, dest: strip(n.i), pool: pool(n.i) };
        if (p.sliceMode && p.slices.length) opt.slice = n.k;
        voice = app.tracks[n.i].trigger(t, n.vel, p.sliceMode ? 0 : n.k, p, opt);
      } });
      ev.push({ t: off, off: true, f: () => { if (voice) app.tracks[n.i].release(voice, off); } });
    }
  }
  // En orden de tiempo; si coinciden, primero se suelta y después se toca
  ev.sort((a, b) => a.t - b.t || (a.off ? -1 : 0) - (b.off ? -1 : 0));
  ev.forEach(e => e.f());

  const cap = await job.promise;
  if (synth) { synth.allOff(); synth.main.dispose(); }
  Object.values(strips).forEach(s => s.dispose());
  sink.dispose();

  // Plegado: lo que pasa del final (colas) se suma al principio
  const N = Math.max(1, Math.round(len * ctx.sampleRate));
  const out = ctx.createBuffer(2, N, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const s = cap.getChannelData(Math.min(c, cap.numberOfChannels - 1)), o = out.getChannelData(c);
    for (let i = 0; i < s.length; i++) o[i % N] += s[i];
  }
  return out;
}

/**
 * Notas tocadas dentro del loop: empareja cada nota con su "soltar" y la ubica en el loop.
 * start: inicio del loop (tiempo de la música) · place: cuantización (o null)
 */
export function collectNotes(evs, { start, len, place, edge, capEnd }) {
  const notes = [];
  evs.forEach((e, idx) => {
    if (!isOn(e)) return;
    const want = e.h - start;
    if (want < -edge || want >= len + edge) return;
    let dur = 0;
    if (e.type !== 'hit') {
      const offType = e.type === 'son' ? 'soff' : 'poff';
      const off = evs.slice(idx + 1).find(x => (x.type === offType && x.midi === e.midi) || (x.type === e.type && x.midi === e.midi));
      dur = Math.min(len, (off ? off.t : capEnd) - e.t);
    }
    let at = place ? place(want) : want;
    at = ((at % len) + len) % len;
    if (len - at < 0.002) at = 0;
    notes.push({ ...e, at, dur });
  });
  return notes;
}

// ---------- Micrófono ----------
// Golpes en un audio grabado: posición (s) del comienzo real de cada uno
export function audioOnsets(buf) {
  const sr = buf.sampleRate, d = buf.getChannelData(0);
  const pos = detectTransients(buf, 0.55, 160).map(p => Math.round(p * d.length));
  const out = [];
  for (const p0 of pos) {
    const end = Math.min(d.length, p0 + Math.round(0.04 * sr));
    let pk = 0;
    for (let i = p0; i < end; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (pk < 0.02) continue;
    // ruido justo antes, para encontrar el comienzo real (no el pico) del golpe
    const a0 = Math.max(0, p0 - Math.round(0.03 * sr));
    let noise = 0;
    for (let i = a0; i < Math.max(a0 + 1, p0 - Math.round(0.015 * sr)); i++) noise = Math.max(noise, Math.abs(d[i]));
    let st = Math.max(0, p0 - Math.round(0.015 * sr));
    const th = Math.max(noise * 2.5, pk * 0.12);
    for (let i = st; i < end; i++) if (Math.abs(d[i]) >= th) { st = i; break; }
    if (!out.length || st - out[out.length - 1] > 0.05 * sr) out.push(st);
  }
  return out.map(x => x / sr);
}

// ¿Son golpes (percusión) o algo sostenido (voz, un instrumento que suena largo)?
// En los golpes el sonido cae bastante antes del golpe siguiente.
export function isPercussive(buf, onsets) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, W = Math.round(0.01 * sr);
  const rms = a => { let e = 0; for (let i = Math.max(0, a); i < a + W && i < d.length; i++) e += d[i] * d[i]; return Math.sqrt(e / W); };
  let ok = 0, n = 0;
  for (let k = 0; k < onsets.length - 1; k++) {
    const a = Math.round(onsets[k] * sr), b = Math.round(onsets[k + 1] * sr);
    if (b - a < 5 * W) continue;
    let peak = 0;
    for (let i = a; i < a + 3 * W; i += W) peak = Math.max(peak, rms(i));
    n++;
    if (rms(b - 2 * W) < peak * 0.2) ok++;
  }
  // Solo si casi todos los golpes se apagan antes del siguiente (voz y sonidos largos: no)
  return n >= 3 && ok / n >= 0.8;
}

// Demora real del micrófono medida con los clicks de la cuenta regresiva:
// cuánto tarda cada click en salir por el parlante y volver por el micrófono.
export function measureClicks(buf, { n, beat }) {
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const abs = Array.from(d, Math.abs).sort((a, b) => a - b);
  const floor = abs[Math.floor(abs.length * 0.5)] || 0;
  const res = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor(k * beat * sr), b = Math.min(d.length, a + Math.floor(Math.min(0.5, beat * 0.9) * sr));
    let pk = 0;
    for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (pk < Math.max(0.01, floor * 6)) continue;
    const th = Math.max(floor * 4, pk * 0.35);
    for (let i = a; i < b; i++) if (Math.abs(d[i]) >= th) { res.push((i - a) / sr); break; }
  }
  if (res.length < 3) return null;
  res.sort((x, y) => x - y);
  const mid = res.slice(Math.floor(res.length / 2) - 1, Math.floor(res.length / 2) + 2);
  if (mid[mid.length - 1] - mid[0] > 0.02) return null;   // no coincide: algo más sonó
  const v = res[Math.floor(res.length / 2)];
  return v > 0.003 && v < 0.6 ? v : null;
}

// Corrimiento general de un grupo de golpes respecto de la grilla de 1/16 (lo que haya
// quedado de demora o la tendencia a tocar un poquito antes del click). Devuelve segundos.
export function globalOffset(ons, step) {
  if (ons.length < 3) return 0;
  const maxD = Math.min(0.05, step * 0.45);
  const cost = dl => ons.reduce((a, x) => { const r = (x - dl) / step; const e = (r - Math.round(r)) * step; return a + e * e; }, 0);
  let best = 0, bc = cost(0);
  for (let dl = -maxD; dl <= maxD; dl += 0.001) { const c = cost(dl); if (c < bc) { bc = c; best = dl; } }
  // solo si mejora claro (si no, los golpes no siguen la grilla y no hay nada que corregir)
  return Math.abs(best) > 0.004 && bc < cost(0) * 0.7 ? best : 0;
}
