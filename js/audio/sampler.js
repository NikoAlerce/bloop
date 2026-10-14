// Pista de sampler: voces → filtro DJ → drive → color (crush/cinta/gate) → vol → pan → envíos.
import { A, holdParam } from './engine.js';
import { TrackFx } from './trackfx.js';

export function reverseBuffer(buf) {
  const r = A.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = r.getChannelData(c), n = buf.length - 1;
    for (let i = 0; i <= n; i++) d[i] = s[n - i];
  }
  return r;
}

const curves = new Map();
export const DRIVE_RANGE = 4;
export function driveCurve(amt) {
  const key = Math.round(amt * 50);
  if (!curves.has(key)) {
    const n = 2048, c = new Float32Array(n), k = 1 + key / 50 * 12;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1) * 2 - 1) * DRIVE_RANGE; // entrada real (antes del /4)
      c[i] = Math.tanh(k * u) / Math.tanh(k);
    }
    curves.set(key, c);
  }
  return curves.get(key);
}

// Filtro bipolar: <0.5 pasa-bajos, >0.5 pasa-altos, centro = abierto
export function djFilter(v) {
  if (v < 0.49) return ['lowpass', 60 * Math.pow(20000 / 60, v / 0.49)];
  if (v > 0.51) return ['highpass', 20 * Math.pow(9000 / 20, (v - 0.51) / 0.49)];
  return ['lowpass', 20000];
}

// Región (en segundos del buffer que suena) para un disparo, con slices y reversa
export function regionOf(p, buf, slice) {
  let a = p.start, b = Math.max(p.start + 0.002, p.end ?? 1);
  const sl = p.slices || [];
  if (slice != null && sl.length) {
    if (slice < 0 || slice >= sl.length) return null;
    a = sl[slice];
    b = slice + 1 < sl.length ? sl[slice + 1] : Math.max(a + 0.002, p.end ?? 1);
  }
  if (p.reverse) [a, b] = [1 - b, 1 - a];
  return [a * buf.duration, b * buf.duration];
}

// Canal de una pista: filtro DJ → drive → color → volumen → paneo → envíos.
// Hay uno para la base (pasos del secuenciador) y otro, creado al primer uso, para lo que se
// toca en vivo (pads y teclado en modo Sampler), que también alimenta "🎹 Solo lo que toco".
class TrackStrip {
  constructor(tap, live) {
    const ctx = A.ctx;
    this.filter = ctx.createBiquadFilter();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = 'none';
    this.fx = new TrackFx();
    this.gain = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.rev = ctx.createGain(); this.rev.gain.value = 0;
    this.dly = ctx.createGain(); this.dly.gain.value = 0;
    this.pre = ctx.createGain();
    this.filter.connect(this.pre).connect(this.shaper).connect(this.fx.input);
    this.fx.output.connect(this.gain).connect(this.pan).connect(A.mixBus);
    this.pan.connect(tap);
    this.pan.connect(this.rev).connect(A.reverbIn);
    this.pan.connect(this.dly).connect(A.delayIn);
    if (live) {
      this.pan.connect(A.liveBus);
      this.rev.connect(A.liveRevIn);
      this.dly.connect(A.liveDlyIn);
    }
    this._drive = -1;
  }

  apply(p, audible) {
    const now = A.ctx.currentTime, T = 0.015;
    const comp = 1 / (1 + p.drive * 1.2);
    this.gain.gain.setTargetAtTime(audible ? p.vol * p.vol * 1.3 * comp : 0, now, T);
    this.pan.pan.setTargetAtTime(p.pan, now, T);
    this.rev.gain.setTargetAtTime(p.rev * p.rev, now, T);
    this.dly.gain.setTargetAtTime(p.dly * p.dly, now, T);
    const [type, f] = djFilter(p.filter);
    if (this.filter.type !== type) this.filter.type = type;
    this.filter.frequency.setTargetAtTime(f, now, T);
    this.filter.Q.setTargetAtTime(0.5 + p.reso * p.reso * 16, now, T);
    if (Math.abs(p.drive - this._drive) > 0.01) {
      const on = p.drive > 0.01;
      this.shaper.curve = on ? driveCurve(p.drive) : null;
      this.shaper.oversample = on ? '2x' : 'none';
      this.pre.gain.value = on ? 1 / DRIVE_RANGE : 1;
      this._drive = p.drive;
    }
    this.fx.apply(p);
  }
}

export class DrumTrack {
  constructor(i) {
    this.i = i;
    this.tap = A.ctx.createGain();   // punto de toma para stems (base + vivo)
    this.main = new TrackStrip(this.tap, false);
    this.liveStrip = null;
    this.pan = this.tap;
    this.fx = this.main.fx;
    this._apply = null;
    this.voices = [];
    this.buffer = null; this.revBuffer = null;
  }

  get live() {
    if (!this.liveStrip) {
      this.liveStrip = new TrackStrip(this.tap, true);
      if (this._apply) this.liveStrip.apply(...this._apply);
    }
    return this.liveStrip;
  }
  scheduleGate(...a) { this.main.fx.scheduleGate(...a); if (this.liveStrip) this.liveStrip.fx.scheduleGate(...a); }
  openGate() { this.main.fx.openGate(); if (this.liveStrip) this.liveStrip.fx.openGate(); }

  setBuffer(buf, root = null) {
    this.zones = buf ? [{ root, buffer: buf, rev: null }] : [];
    this.buffer = buf;
    this.revBuffer = buf ? reverseBuffer(buf) : null;
    this.zones.length && (this.zones[0].rev = this.revBuffer);
  }

  // Instrumento multisampleado: [{root, buffer}] (una zona por nota grabada)
  setZones(zones) {
    this.zones = zones.slice().sort((a, b) => a.root - b.root).map(z => ({ ...z, rev: null }));
    const mid = this.zones[Math.floor(this.zones.length / 2)];
    this.buffer = mid.buffer;
    this.revBuffer = null;
  }

  // Elige la zona y la velocidad de reproducción para una nota
  pick(p, semis) {
    if (!this.zones.length) return null;
    const z0 = this.zones[0];
    if (this.zones.length === 1 && z0.root == null) {
      return { z: z0, rate: Math.pow(2, (p.pitch + semis) / 12) };
    }
    const target = p.root + semis + p.pitch;
    let z = z0;
    for (const c of this.zones) if (Math.abs(c.root - target) < Math.abs(z.root - target)) z = c;
    return { z, rate: Math.pow(2, (target - z.root) / 12) };
  }

  apply(p, audible) {
    this._apply = [p, audible];
    this.main.apply(p, audible);
    if (this.liveStrip) this.liveStrip.apply(p, audible);
  }

  choke(time) {
    for (const v of this.voices) {
      if (v.end <= time) continue;
      // Congelar el volumen en el valor que tiene en ese instante y apagarlo suave.
      // (cancelScheduledValues solo borraba la caída y el volumen saltaba al máximo: click)
      holdParam(v.env.gain, time);
      v.env.gain.setTargetAtTime(0, time, 0.004);
      try { v.src.stop(time + 0.06); } catch (e) { /* ya detenida */ }
      v.end = time;
    }
  }

  // opt: { slice: índice, hold: true = suena hasta release() (teclado) }
  trigger(time, vel, semis, p, opt = {}) {
    const pk = this.pick(p, opt.slice != null ? 0 : semis);
    if (!pk) return null;
    const { z, rate } = pk;
    if (p.reverse && !z.rev) z.rev = reverseBuffer(z.buffer);
    const buf = p.reverse ? z.rev : z.buffer;
    const reg = regionOf(p, buf, opt.slice);
    if (!reg) return null;
    const ctx = A.ctx;
    if (p.mono && !opt.poly) this.choke(time);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    src.connect(env).connect(opt.live ? this.live.filter : this.main.filter);

    const [a, b] = reg;
    const len = (b - a) / rate;
    const peak = 0.12 + 0.88 * vel;
    const dec = p.decay < 0.995 ? Math.max(0.02, len * (0.02 + 0.98 * p.decay * p.decay)) : len;
    const fi = Math.min(dec * 0.5, Math.max(0.0015, (p.fadeIn || 0) / rate));
    const fo = Math.min(dec * 0.5, (p.fadeOut || 0) / rate);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + fi);
    if (p.decay < 0.995) {
      env.gain.setValueAtTime(peak, time + Math.max(fi, dec * 0.25));
      env.gain.exponentialRampToValueAtTime(0.0008, time + dec);
    } else if (fo > 0) {
      env.gain.setValueAtTime(peak, time + dec - fo);
      env.gain.linearRampToValueAtTime(0, time + dec);
    } else {
      env.gain.setValueAtTime(peak, time + Math.max(fi, dec - 0.003));
      env.gain.linearRampToValueAtTime(0, time + dec);
    }
    const end = time + dec + 0.01;
    src.start(time, a, b - a);
    src.stop(end + 0.02);
    const v = { src, env, end };
    this.voices.push(v);
    src.onended = () => {
      env.disconnect();
      const k = this.voices.indexOf(v);
      if (k >= 0) this.voices.splice(k, 1);
    };
    return v;
  }

  // Suelta una voz tocada desde el teclado
  release(v, time = A.ctx.currentTime) {
    if (!v || v.end <= time) return;
    const g = v.env.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(time); else { g.cancelScheduledValues(time); g.setValueAtTime(g.value, time); }
    g.setTargetAtTime(0, time, 0.02);
    try { v.src.stop(time + 0.15); } catch (e) { /* */ }
    v.end = time;
  }
}
