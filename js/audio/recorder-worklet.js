// Grabador con precisión de muestra: captura [startFrame, startFrame+length)
// o hasta recibir 'stop'. Varios trabajos en paralelo por nodo.
class BloopRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jobs = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') {
        this.jobs.push({
          id: m.id, start: m.startFrame, len: m.length, pos: 0,
          L: new Float32Array(m.length), R: new Float32Array(m.length),
        });
      } else if (m.type === 'stopAt') {
        const j = this.jobs.find(x => x.id === m.id);
        if (j) j.len = Math.max(0, Math.min(j.len, m.frame - j.start));
      } else if (m.type === 'peek') {
        // Copia de lo grabado hasta ahora (la grabación sigue)
        const j = this.jobs.find(x => x.id === m.id);
        const n = j ? Math.min(j.pos, j.len) : 0;
        const L = j ? j.L.slice(0, n) : new Float32Array(0), R = j ? j.R.slice(0, n) : new Float32Array(0);
        this.port.postMessage({ id: m.id, peek: true, L, R }, [L.buffer, R.buffer]);
      } else if (m.type === 'stop') {
        const j = this.jobs.find(x => x.id === m.id);
        if (j) this.finish(j);
      }
    };
  }

  finish(j) {
    this.jobs = this.jobs.filter(x => x !== j);
    const n = Math.min(j.pos, j.len);
    const L = j.L.slice(0, n), R = j.R.slice(0, n);
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
          const idx = f0 + k - j.start;
          j.L[idx] = l ? l[k] : 0;
          j.R[idx] = r ? r[k] : 0;
        }
        j.pos = f0 + kEnd - j.start;
      }
      if (f0 + n >= j.start + j.len) this.finish(j);
    }
    return true;
  }
}
registerProcessor('bloop-recorder', BloopRecorder);
