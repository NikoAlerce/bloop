// Edición de audio tipo collage: cortar, copiar, pegar, duplicar, silenciar, invertir.
// Todas devuelven un AudioBuffer NUEVO (el original queda intacto para deshacer).
// Los empalmes llevan fundidos o crossfades de pocos milisegundos para que no hagan "click".
import { A } from './engine.js';

const XF = 0.004; // segundos de fundido en cada empalme

function make(chs, len, sr) { return A.ctx.createBuffer(Math.max(1, chs), Math.max(1, len), sr); }
const chan = (buf, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
const clampI = (buf, i) => Math.max(0, Math.min(buf.length, Math.round(i)));

// Copia de las muestras [a, b)
export function copyRange(buf, a, b) {
  a = clampI(buf, a); b = clampI(buf, b);
  const out = make(buf.numberOfChannels, b - a, buf.sampleRate);
  for (let c = 0; c < out.numberOfChannels; c++) out.copyToChannel(chan(buf, c).subarray(a, Math.max(a + 1, b)), c);
  return out;
}

// Quita [a, b) y une los dos lados con un crossfade corto
export function deleteRange(buf, a, b) {
  a = clampI(buf, a); b = clampI(buf, b);
  const L = buf.length - (b - a);
  const out = make(buf.numberOfChannels, L, buf.sampleRate);
  const X = Math.min(Math.round(XF * buf.sampleRate), a, b - a);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const s = chan(buf, c), o = out.getChannelData(c);
    o.set(s.subarray(0, a - X));
    for (let i = 0; i < X; i++) {
      const w = (i + 0.5) / X;
      o[a - X + i] = s[a - X + i] * (1 - w) + s[b - X + i] * w;
    }
    o.set(s.subarray(b), a);
  }
  return out;
}

// Fundido de entrada/salida en un rango (en el lugar; solo sobre buffers nuevos)
function fadeEdges(buf, a, b) {
  const X = Math.min(Math.round(XF * buf.sampleRate * 0.5), Math.floor((b - a) / 2));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < X; i++) { const w = i / X; d[a + i] *= w; d[b - 1 - i] *= w; }
  }
}
// Pequeño "valle" alrededor de un punto para que pegar algo ahí no haga click
function dipAt(buf, p) {
  const X = Math.round(XF * buf.sampleRate * 0.5);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 1; i <= X; i++) {
      const w = i / X;
      if (p - i >= 0) d[p - i] *= w;
      if (p + i - 1 < d.length) d[p + i - 1] *= w;
    }
  }
}

// Inserta clip en la posición p (el audio se alarga)
export function insertAt(buf, p, clip) {
  p = clampI(buf, p);
  const chs = Math.max(buf.numberOfChannels, clip.numberOfChannels);
  const out = make(chs, buf.length + clip.length, buf.sampleRate);
  for (let c = 0; c < chs; c++) {
    const s = chan(buf, c), o = out.getChannelData(c);
    o.set(s.subarray(0, p));
    o.set(chan(clip, c), p);
    o.set(s.subarray(p), p + clip.length);
  }
  dipAt(out, p); dipAt(out, p + clip.length);
  return out;
}

// Pega encima desde p, reemplazando lo que había (el largo no cambia)
export function overwriteAt(buf, p, clip) {
  p = clampI(buf, p);
  const chs = Math.max(buf.numberOfChannels, clip.numberOfChannels);
  const out = make(chs, buf.length, buf.sampleRate);
  const n = Math.min(clip.length, buf.length - p);
  for (let c = 0; c < chs; c++) {
    const s = chan(buf, c), o = out.getChannelData(c);
    o.set(s);
    o.set(chan(clip, c).subarray(0, n), p);
  }
  dipAt(out, p); dipAt(out, p + n);
  return out;
}

// Silencio en [a, b) con rampas suaves (el largo no cambia)
export function silenceRange(buf, a, b) {
  a = clampI(buf, a); b = clampI(buf, b);
  const out = copyRange(buf, 0, buf.length);
  const X = Math.round(XF * buf.sampleRate);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = a; i < b; i++) d[i] = 0;
    for (let i = 1; i <= X; i++) {
      const w = i / X;
      if (a - i >= 0) d[a - i] *= w;
      if (b + i - 1 < d.length) d[b + i - 1] *= w;
    }
  }
  return out;
}

// Da vuelta [a, b) (el largo no cambia)
export function reverseRange(buf, a, b) {
  a = clampI(buf, a); b = clampI(buf, b);
  const out = copyRange(buf, 0, buf.length);
  for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).subarray(a, b).reverse();
  fadeEdges(out, a, b);
  return out;
}

// Una posición (en segundos) después de borrar [a, b) o insertar L en p
export const afterDelete = (x, a, b) => (x <= a ? x : x >= b ? x - (b - a) : a);
export const afterInsert = (x, p, L, isEnd) => (isEnd ? (x < p ? x : x + L) : (x <= p ? x : x + L));
