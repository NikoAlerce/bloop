// Grabador con precisión de muestra: captura [startFrame, startFrame+length)
// o hasta recibir 'stop'. Varios trabajos en paralelo por nodo.
// La memoria se reserva de a pedazos mientras graba (una toma larga no pide todo de entrada).
const CH = 1 << 16; // muestras por pedazo (~1,4 s)

class BloopRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jobs = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') {
        this.jobs.push({ id: m.id, start: m.startFrame, len: m.length, pos: 0, L: [], R: [], live: !!m.live, lp: [], lo: 0, hi: 0, ln: 0 });
      } else if (m.type === 'stopAt') {
        const j = this.jobs.find(x => x.id === m.id);
        if (j) j.len = Math.max(0, Math.min(j.len, m.frame - j.start));
      } else if (m.type === 'peek') {
        // Copia de lo grabado hasta ahora (la grabación sigue)
        const j = this.jobs.find(x => x.id === m.id);
        const n = j ? Math.min(j.pos, j.len) : 0;
        const L = j ? this.join(j.L, n) : new Float32Array(0), R = j ? this.join(j.R, n) : new Float32Array(0);
        this.port.postMessage({ id: m.id, peek: true, L, R }, [L.buffer, R.buffer]);
      } else if (m.type === 'stop') {
        const j = this.jobs.find(x => x.id === m.id);
        if (j) this.finish(j);
      }
    };
  }

  join(chunks, n) {
    const out = new Float32Array(n);
    for (let k = 0; k * CH < n; k++) {
      const c = chunks[k];
      if (c) out.set(c.subarray(0, Math.min(CH, n - k * CH)), k * CH);
    }
    return out;
  }

  finish(j) {
    this.jobs = this.jobs.filter(x => x !== j);
    const n = Math.min(j.pos, j.len);
    const L = this.join(j.L, n), R = this.join(j.R, n);
    this.port.postMessage({ id: j.id, L, R }, [L.buffer, R.buffer]);
  }

  process(inputs) {
    const inp = inputs[0];
    const l = inp && inp[0];
    const r = inp && (inp[1] || inp[0]);
    const n = l ? l.length : 128;
    const f0 = currentFrame;
    for (const j of this.jobs.slice()) {
      const kStart = Math.max(0, j.start - f0);
      const kEnd = Math.min(n, j.start + j.len - f0);
      if (kEnd > kStart) {
        for (let k = kStart; k < kEnd; k++) {
          const idx = f0 + k - j.start, c = idx >> 16, o = idx & (CH - 1);
          if (!j.L[c]) { j.L[c] = new Float32Array(CH); j.R[c] = new Float32Array(CH); }
          const vl = l ? l[k] : 0, vr = r ? r[k] : 0;
          j.L[c][o] = vl;
          j.R[c][o] = vr;
          if (j.live) {
            // picos cada 256 muestras para dibujar la onda mientras se graba
            const v = (vl + vr) * 0.5;
            if (v < j.lo) j.lo = v; if (v > j.hi) j.hi = v;
            if (++j.ln === 256) { j.lp.push(j.lo, j.hi); j.lo = 0; j.hi = 0; j.ln = 0; }
          }
        }
        if (j.live && j.lp.length >= 32) { this.port.postMessage({ id: j.id, live: true, p: new Float32Array(j.lp) }); j.lp = []; }
        j.pos = f0 + kEnd - j.start;
      }
      if (f0 + n >= j.start + j.len) this.finish(j);
    }
    return true;
  }
}
registerProcessor('bloop-recorder', BloopRecorder);
