// Inserto "color" por canal: bitcrusher → cinta → gater rítmico.
// Para no gastar CPU (clave en la tablet), el bitcrusher y la cinta se crean solo cuando se usan
// y se sacan de la cadena cuando vuelven a cero. Sin efectos, el canal es input → gate → output.
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

export class TrackFx {
  constructor() {
    const ctx = A.ctx;
    this.input = ctx.createGain();
    this.gate = ctx.createGain();
    this.output = ctx.createGain();
    this.gate.connect(this.output);
    this.crush = null;   // AudioWorkletNode, solo si se usa
    this.tape = null;    // {delay, lp, oscs, gains}, solo si se usa
    this.mode = 'off';
    this.wire();
  }

  // Arma la cadena con lo que esté activo
  wire() {
    this.input.disconnect();
    if (this.crush) this.crush.disconnect();
    if (this.tape) this.tape.lp.disconnect();
    let node = this.input;
    if (this.crush) { node.connect(this.crush); node = this.crush; }
    if (this.tape) { node.connect(this.tape.delay); node = this.tape.lp; }
    node.connect(this.gate);
  }

  makeTape() {
    const ctx = A.ctx;
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.006;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 20000;
    const wow = ctx.createOscillator(); wow.frequency.value = 0.55;
    const flut = ctx.createOscillator(); flut.frequency.value = 6.3;
    const wowG = ctx.createGain(), flutG = ctx.createGain();
    wowG.gain.value = 0; flutG.gain.value = 0;
    wow.connect(wowG).connect(delay.delayTime);
    flut.connect(flutG).connect(delay.delayTime);
    wow.start(); flut.start();
    delay.connect(lp);
    return { delay, lp, wow, flut, wowG, flutG };
  }

  apply(p) {
    const now = A.ctx.currentTime, T = 0.03;
    const needCrush = p.crush > 0.005 || p.down > 0.005;
    const needTape = p.tape > 0.005;
    if (needCrush !== !!this.crush || needTape !== !!this.tape) {
      if (needCrush && !this.crush) {
        this.crush = new AudioWorkletNode(A.ctx, 'bloop-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      } else if (!needCrush && this.crush) {
        this.crush.port.postMessage('stop'); // el procesador deja de correr
        this.crush.disconnect(); this.crush = null;
      }
      if (needTape && !this.tape) this.tape = this.makeTape();
      else if (!needTape && this.tape) {
        const tp = this.tape; this.tape = null;
        tp.wow.stop(); tp.flut.stop(); tp.lp.disconnect(); tp.delay.disconnect();
      }
      this.wire();
    }
    if (this.crush) {
      this.crush.parameters.get('bits').setValueAtTime(16 - p.crush * 14, now);
      this.crush.parameters.get('down').setValueAtTime(1 + p.down * p.down * 40, now);
    }
    if (this.tape) {
      const t = p.tape;
      this.tape.wowG.gain.setTargetAtTime(t * 0.0022, now, T);
      this.tape.flutG.gain.setTargetAtTime(t * 0.00025, now, T);
      this.tape.lp.frequency.setTargetAtTime(20000 * Math.pow(3500 / 20000, t), now, T);
    }
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
