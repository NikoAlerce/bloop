// Time-stretch: cambia la duración de un loop SIN cambiar su tono (WSOLA).
// Corre en un Worker para no trabar la interfaz ni el reloj del secuenciador.
// El loop se trata como circular, así el resultado también empalma sin cortes.
import { A } from './engine.js';

const WORKER_SRC = `
self.onmessage = e => {
  const { id, chans, speed, outLen } = e.data;
  const inLen = chans[0].length;
  const N = 2048, Hs = 1024, D = 320;           // ventana ~43 ms, salto de síntesis 50 %
  const Ha = Hs * speed;                        // salto de análisis según la velocidad
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const mono = new Float32Array(inLen);
  for (const c of chans) for (let i = 0; i < inLen; i++) mono[i] += c[i] / chans.length;
  const at = x => mono[((x % inLen) + inLen) % inLen];
  const out = chans.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const frames = Math.ceil(outLen / Hs);
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const outPos = k * Hs;
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      // Busca, cerca de la posición nominal, el trozo que mejor continúa al anterior
      const ref = prev + Hs;
      let bestScore = -Infinity;
      for (let d = -D; d <= D; d += 2) {
        const cand = nominal + d;
        let sc = 0;
        for (let i = 0; i < N; i += 8) sc += at(ref + i) * at(cand + i);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
    }
    for (let c = 0; c < chans.length; c++) {
      const src = chans[c], o = out[c];
      for (let i = 0; i < N; i++) {
        const si = (((best + i) % inLen) + inLen) % inLen;
        o[(outPos + i) % outLen] += src[si] * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[(outPos + i) % outLen] += win[i];
    prev = best;
  }
  for (const o of out) for (let i = 0; i < outLen; i++) o[i] /= Math.max(norm[i], 1e-3);
  self.postMessage({ id, chans: out }, out.map(o => o.buffer));
};`;

let worker = null;
const pending = new Map();
let jobId = 0;

function getWorker() {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (p) { pending.delete(e.data.id); p(e.data.chans); }
    };
  }
  return worker;
}

// speed > 1 = más rápido (más corto). Devuelve un AudioBuffer nuevo con el mismo tono.
export function stretchBuffer(buf, speed) {
  if (Math.abs(speed - 1) < 0.002) return Promise.resolve(buf);
  const outLen = Math.max(1, Math.round(buf.length / speed));
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).slice());
  const id = ++jobId;
  return new Promise(res => {
    pending.set(id, res);
    getWorker().postMessage({ id, chans, speed, outLen }, chans.map(c => c.buffer));
  }).then(out => {
    const b = A.ctx.createBuffer(out.length, outLen, buf.sampleRate);
    out.forEach((d, c) => b.copyToChannel(d, c));
    return b;
  });
}
