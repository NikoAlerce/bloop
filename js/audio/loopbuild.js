// Arma el loop a partir de lo que tocaste en vivo (fuente 🎹).
// Como Bloop sabe el instante exacto de cada golpe/nota, corta el audio en cada uno y lo
// acomoda en la grilla (cuantización de audio), sin perder nada:
//  - un golpe un pelín antes del "1" (pre-roll) va al principio del loop
//  - un golpe justo antes del final que en realidad era el "1" de la vuelta siguiente, también
//  - las colas que pasan el final del loop se suman al principio (como Loopy)
// Los cortes llevan crossfades de pocos ms (sin clicks).
import { A } from './engine.js';

// Momentos (tiempo del AudioContext) de lo que se tocó en vivo
export const liveLog = [];
export function logLive(t) {
  liveLog.push(t);
  if (liveLog.length > 400) liveLog.splice(0, liveLog.length - 400);
}

/**
 * cap: AudioBuffer grabado desde (inicio del loop − pre) · pre/len/step en segundos
 * hits: posiciones (s) de cada golpe relativas al inicio del loop
 * place: posición (s) → dónde debe quedar (s), o null para no mover nada
 * edge: cuánto antes del 1 (o del final) un golpe todavía cuenta como el 1 (media grilla)
 */
export function buildLoop(cap, { pre, len, hits, place, edge = 0.06 }) {
  const sr = cap.sampleRate, P = Math.round(pre * sr), N = Math.max(1, Math.round(len * sr));
  const half = Math.round(edge * sr), F = Math.round(0.003 * sr);
  const out = A.ctx.createBuffer(2, N, sr);
  const src = [cap.getChannelData(0), cap.getChannelData(Math.min(1, cap.numberOfChannels - 1))];
  const dst = [out.getChannelData(0), out.getChannelData(1)];
  const capLen = cap.length;

  // Golpes en muestras; los que caen casi juntos (acorde, dos pads a la vez) cuentan como uno
  const raw = hits.map(t => Math.round(t * sr)).sort((a, b) => a - b);
  const on = [];
  for (const x of raw) if (!on.length || x - on[on.length - 1] > 0.02 * sr) on.push(x);
  const valid = on.filter(x => x >= -half && x < N + half);
  const firstAfter = on.find(x => x >= N + half);           // lo tocado después: no entra
  const before = on.filter(x => x < -half).pop();           // lo tocado antes: no entra
  const endSrc = Math.min(capLen - P, firstAfter ?? Infinity);

  // Copia el tramo [a, b) del audio (posiciones del loop) corrido "shift", con fundidos
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
    // Sin golpes registrados: el audio tal cual, con lo de antes y después dando la vuelta
    put(before != null ? before + 2 * F : -P, endSrc, 0, true, true);
    return out;
  }
  // Antes del primer golpe: colas de lo anterior, sin mover (solo dentro del loop)
  // Cada tramo va de un golpe al siguiente; el crossfade queda justo ANTES de cada golpe
  // (así el ataque del golpe siguiente no se cuela en el tramo anterior)
  if (valid[0] > 0) put(Math.max(0, before != null ? before + 2 * F : 0), valid[0], 0, before != null, true);
  for (let k = 0; k < valid.length; k++) {
    const o = valid[k], next = k + 1 < valid.length ? valid[k + 1] : endSrc;
    const shift = place ? Math.round(place(o / sr) * sr) - o : 0;
    put(o - 2 * F, next, shift, true, true);
  }
  return out;
}
