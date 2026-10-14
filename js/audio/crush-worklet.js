// Bitcrusher: reducción de bits + sample-and-hold (baja frecuencia de muestreo).
class BloopCrush extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'down', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super(); this.ph = 0; this.hold = [0, 0]; this.alive = true;
    this.port.onmessage = e => { if (e.data === 'stop') this.alive = false; };
  }
  process(inputs, outputs, params) {
    if (!this.alive) return false; // fuera de uso: el navegador deja de llamarlo
    const inp = inputs[0], out = outputs[0];
    const bits = params.bits[0], down = params.down[0];
    if (!inp || !inp.length) { for (const o of out) o.fill(0); return true; }
    if (bits >= 15.99 && down <= 1.01) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[Math.min(c, inp.length - 1)]);
      return true;
    }
    const q = Math.pow(2, bits - 1), n = out[0].length;
    let ph = this.ph;
    for (let k = 0; k < n; k++) {
      ph += 1;
      const take = ph >= down;
      if (take) ph -= down;
      for (let c = 0; c < out.length; c++) {
        const x = inp[Math.min(c, inp.length - 1)][k];
        if (take) this.hold[c] = Math.round(x * q) / q;
        out[c][k] = this.hold[c];
      }
    }
    this.ph = ph;
    return true;
  }
}
registerProcessor('bloop-crush', BloopCrush);
