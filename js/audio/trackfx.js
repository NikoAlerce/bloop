// Inserto "color" por canal: bitcrusher → cinta/vinilo → gater rítmico.
import { A } from './engine.js';

// Patrones del gater: por cada semicorchea, ventanas [inicio, fin] abiertas (fracción del paso)
const TRANCE = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0];
export const GATES = ['off', '1/8', '1/16', '1/32', 'trance'];
function windows(mode, step) {
  switch (mode) {
    case '1/8': return step % 2 === 0 ? [[0, 0.95]] : [];
    case '1/16': return [[0, 0.5]];
    case '1/32': return [[0, 0.25], [0.5, 0.75]];
    case 'trance': return TRANCE[step % 16] ? [[0, 0.7]] : [];
    default: return null;
  }
}

let crackleBuf = null;
function crackle(ctx) {
  if (crackleBuf) return crackleBuf;
  const sr = ctx.sampleRate, len = sr * 3;
  crackleBuf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = crackleBuf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * 0.08;
      d[i] = lp * 0.12;                                        // soplido
      if (Math.random() < 0.00018) d[i] += (Math.random() * 2 - 1) * 0.9;  // pops
    }
  }
  return crackleBuf;
}

export class TrackFx {
  constructor() {
    const ctx = A.ctx;
    this.input = ctx.createGain();
    this.crush = new AudioWorkletNode(ctx, 'bloop-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    // Cinta: wow & flutter con una línea de retardo modulada + pérdida de agudos
    this.tapeDelay = ctx.createDelay(0.05);
    this.tapeDelay.delayTime.value = 0.006;
    this.wow = ctx.createOscillator(); this.wow.frequency.value = 0.55;
    this.flutter = ctx.createOscillator(); this.flutter.frequency.value = 6.3;
    this.wowG = ctx.createGain(); this.wowG.gain.value = 0;
    this.flutG = ctx.createGain(); this.flutG.gain.value = 0;
    this.wow.connect(this.wowG).connect(this.tapeDelay.delayTime);
    this.flutter.connect(this.flutG).connect(this.tapeDelay.delayTime);
    this.wow.start(); this.flutter.start();
    this.tapeLP = ctx.createBiquadFilter(); this.tapeLP.type = 'lowpass'; this.tapeLP.frequency.value = 20000; this.tapeLP.Q.value = 0.5;
    this.gate = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.crush).connect(this.tapeDelay).connect(this.tapeLP).connect(this.gate).connect(this.output);
    // Vinilo: crujido de fondo (solo suena si hay "cinta")
    this.crk = ctx.createBufferSource(); this.crk.buffer = crackle(ctx); this.crk.loop = true;
    this.crkG = ctx.createGain(); this.crkG.gain.value = 0;
    this.crk.connect(this.crkG).connect(this.output); this.crk.start();
    this.mode = 'off';
  }

  apply(p) {
    const now = A.ctx.currentTime, T = 0.03;
    this.crush.parameters.get('bits').setValueAtTime(16 - p.crush * 14, now);
    this.crush.parameters.get('down').setValueAtTime(1 + p.down * p.down * 40, now);
    const t = p.tape;
    this.wowG.gain.setTargetAtTime(t * 0.0022, now, T);
    this.flutG.gain.setTargetAtTime(t * 0.00025, now, T);
    this.tapeLP.frequency.setTargetAtTime(20000 * Math.pow(3500 / 20000, t), now, T);
    this.crkG.gain.setTargetAtTime(t * t * 0.5, now, T);
    if (p.gate === 'off' && this.mode !== 'off') this.gate.gain.setTargetAtTime(1, now, 0.01);
    this.mode = p.gate;
  }

  // Lo llama el secuenciador en cada semicorchea
  scheduleGate(t, sd, step, mode, depth) {
    const w = windows(mode, step);
    if (!w) return;
    const g = this.gate.gain, low = 1 - depth;
    g.setTargetAtTime(low, t, 0.003);
    for (const [a, b] of w) {
      g.setTargetAtTime(1, t + a * sd, 0.003);
      g.setTargetAtTime(low, t + b * sd, 0.004);
    }
  }

  openGate() { this.gate.gain.cancelScheduledValues(A.ctx.currentTime); this.gate.gain.setTargetAtTime(1, A.ctx.currentTime, 0.01); }
}
