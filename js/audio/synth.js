// Synth polifónico/monofónico sustractivo + FM simple, con chorus estéreo.
import { A, holdParam } from './engine.js';
import { driveCurve } from './sampler.js';
import { TrackFx } from './trackfx.js';

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const cutoffHz = v => 40 * Math.pow(18000 / 40, v);
const MAX_VOICES = 10;

export class Synth {
  constructor() {
    const ctx = A.ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.input = g(0.32);
    this.shaper = ctx.createWaveShaper(); this.shaper.oversample = '2x';
    this.dry = g(1); this.wet = g(0);
    this.vol = g(0.7);
    this.revSend = g(0); this.dlySend = g(0);

    // Chorus estéreo de dos líneas moduladas
    const cL = ctx.createDelay(0.05), cR = ctx.createDelay(0.05);
    cL.delayTime.value = 0.012; cR.delayTime.value = 0.017;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.33;
    const lg = g(0.0025), lgi = g(-0.0025);
    lfo.connect(lg).connect(cL.delayTime); lfo.connect(lgi).connect(cR.delayTime); lfo.start();
    const pL = ctx.createStereoPanner(), pR = ctx.createStereoPanner(); pL.pan.value = -0.9; pR.pan.value = 0.9;

    this.fx = new TrackFx();
    this.input.connect(this.shaper);
    this.shaper.connect(this.dry).connect(this.fx.input);
    this.shaper.connect(cL).connect(pL).connect(this.wet);
    this.shaper.connect(cR).connect(pR).connect(this.wet);
    this.wet.connect(this.fx.input);
    this.fx.output.connect(this.vol);
    this.vol.connect(A.mixBus);
    this.vol.connect(this.revSend).connect(A.reverbIn);
    this.vol.connect(this.dlySend).connect(A.delayIn);

    this.voices = new Set();
    this.live = new Map();       // midi -> voz (teclado en vivo)
    this.seqVoices = [];         // voces secuenciadas pendientes de release
    this.monoVoice = null;
    this.monoStack = [];
    this.p = null;
    this._drive = -1;
    this.onNote = null;          // callback para UI (midi, on)
  }

  setParams(p) { this.p = p; }

  apply(audible, fx) {
    const p = this.p, now = A.ctx.currentTime, T = 0.02;
    if (fx) this.fx.apply(fx);
    this.vol.gain.setTargetAtTime(audible ? p.vol * p.vol * 1.4 : 0, now, T);
    this.revSend.gain.setTargetAtTime(p.rev * p.rev, now, T);
    this.dlySend.gain.setTargetAtTime(p.dly * p.dly, now, T);
    this.wet.gain.setTargetAtTime(p.chorus * 0.9, now, T);
    this.dry.gain.setTargetAtTime(1 - p.chorus * 0.35, now, T);
    if (Math.abs(p.drive - this._drive) > 0.01) {
      this.shaper.curve = p.drive > 0.01 ? driveCurve(p.drive) : null;
      this._drive = p.drive;
    }
    // Las voces sonando siguen al filtro (para poder "abrir" un pad en vivo)
    for (const v of this.voices) {
      if (v.released) continue;
      const base = this.baseCut(v.midi);
      v.base = base;
      v.filt.frequency.setTargetAtTime(base + (this.peakCut(base, v.vel) - base) * p.fs, now, 0.04);
      v.filt.Q.setTargetAtTime(0.5 + p.reso * p.reso * 22, now, 0.04);
    }
  }

  baseCut(midi) {
    const p = this.p;
    return Math.min(19000, Math.max(30, cutoffHz(p.cutoff) * Math.pow(2, (midi - 60) / 12 * p.keytrack)));
  }
  peakCut(base, vel) { return Math.min(19000, base * Math.pow(2, this.p.envAmt * 6 * (0.5 + vel * 0.5))); }

  makeVoice(midi, vel, t) {
    const ctx = A.ctx, p = this.p, f = mtof(midi);
    const out = ctx.createGain(); out.gain.value = 0;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass';
    filt.Q.value = 0.5 + p.reso * p.reso * 22;
    const mix = ctx.createGain();
    mix.connect(filt).connect(out).connect(this.input);

    const srcs = [], fosc = []; // fosc: osciladores con frecuencia relativa
    const n = Math.max(1, Math.round(p.unison));
    const level = (1 - p.mix2 * 0.4) / Math.sqrt(n);
    const mainOscs = [];
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(); o.type = p.wave; o.frequency.value = f;
      const pos = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const det = pos * p.detune * 50;
      o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = level;
      if (n > 1 && p.spread > 0) {
        const pn = ctx.createStereoPanner(); pn.pan.value = pos * p.spread;
        o.connect(og).connect(pn).connect(mix);
      } else o.connect(og).connect(mix);
      srcs.push(o); fosc.push({ o, ratio: 1, det }); mainOscs.push(o);
    }

    let fmG = null;
    if (p.fm > 0) {
      const m = ctx.createOscillator(); m.type = p.wave2; m.frequency.value = f * p.fmRatio;
      fmG = ctx.createGain();
      const idx = p.fm * f * p.fmRatio * 2;
      fmG.gain.setValueAtTime(idx, t);
      fmG.gain.setTargetAtTime(idx * 0.15, t, Math.max(0.05, p.d / 2));
      m.connect(fmG); mainOscs.forEach(o => fmG.connect(o.frequency));
      srcs.push(m); fosc.push({ o: m, ratio: p.fmRatio, det: 0 });
    } else if (p.mix2 > 0) {
      const o2 = ctx.createOscillator(); o2.type = p.wave2;
      const ratio = Math.pow(2, p.semi2 / 12);
      o2.frequency.value = f * ratio; o2.detune.value = p.fine2;
      const g2 = ctx.createGain(); g2.gain.value = p.mix2 * 0.8;
      o2.connect(g2).connect(mix);
      srcs.push(o2); fosc.push({ o: o2, ratio, det: p.fine2 });
    }
    if (p.sub > 0) {
      const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = f / 2;
      const sg = ctx.createGain(); sg.gain.value = p.sub * 0.7;
      s.connect(sg).connect(mix); srcs.push(s); fosc.push({ o: s, ratio: 0.5, det: 0 });
    }
    if (p.noise > 0) {
      const ns = ctx.createBufferSource(); ns.buffer = A.noise; ns.loop = true;
      const ng = ctx.createGain(); ng.gain.value = p.noise * 0.3;
      ns.connect(ng).connect(mix); srcs.push(ns);
    }
    // Vibrato con retardo
    if (p.vib > 0) {
      const l = ctx.createOscillator(); l.frequency.value = p.vibRate;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(p.vib * 40, t + p.vibDelay + 0.3);
      l.connect(lg); fosc.forEach(x => lg.connect(x.o.detune));
      srcs.push(l);
    }
    // Envolvente de pitch
    if (p.penv) {
      fosc.forEach(x => {
        x.o.detune.setValueAtTime(x.det + p.penv * 100, t);
        x.o.detune.linearRampToValueAtTime(x.det, t + p.ptime);
      });
    }
    // Filtro
    const base = this.baseCut(midi), peak = this.peakCut(base, vel);
    filt.frequency.setValueAtTime(base, t);
    filt.frequency.linearRampToValueAtTime(peak, t + p.fa + 0.001);
    filt.frequency.setTargetAtTime(base + (peak - base) * p.fs, t + p.fa + 0.001, p.fd / 3 + 0.001);
    // Amplitud
    const pk = 0.25 + 0.75 * vel;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(pk, t + p.a + 0.002);
    out.gain.setTargetAtTime(pk * p.s, t + p.a + 0.002, p.d / 3 + 0.001);

    srcs.forEach(s => s.start(t));
    const v = { midi, vel, out, filt, srcs, fosc, fmG, base, released: false, t0: t };
    srcs[0].onended = () => { out.disconnect(); this.voices.delete(v); };
    this.voices.add(v);
    if (this.onNote) this.onNote(midi, true, t);
    this.limit(t);
    return v;
  }

  release(v, t, rel = this.p.r) {
    if (v.released) return;
    v.released = true;
    const p = this.p;
    holdParam(v.out.gain, t);
    v.out.gain.setTargetAtTime(0, t, rel / 4 + 0.004);
    holdParam(v.filt.frequency, t);
    v.filt.frequency.setTargetAtTime(v.base, t, p.fr / 4 + 0.004);
    const end = t + rel * 1.6 + 0.08;
    v.srcs.forEach(s => { try { s.stop(end); } catch (e) { /* */ } });
    if (this.onNote) this.onNote(v.midi, false, t);
  }

  limit(t) {
    const active = [...this.voices].filter(v => !v.released);
    for (let k = 0; k < active.length - MAX_VOICES; k++) this.release(active[k], t, 0.03);
  }

  glideTo(v, midi, t) {
    const f = mtof(midi), tc = Math.max(0.003, this.p.glide / 3);
    v.fosc.forEach(x => {
      if (this.p.glide > 0.001) x.o.frequency.setTargetAtTime(f * x.ratio, t, tc);
      else x.o.frequency.setValueAtTime(f * x.ratio, t);
    });
    if (this.onNote) { this.onNote(v.midi, false, t); this.onNote(midi, true, t); }
    v.midi = midi;
  }

  // ---- En vivo ----
  noteOn(midi, vel = 0.8, t = A.ctx.currentTime) {
    if (this.p.mono) {
      this.monoStack = this.monoStack.filter(m => m !== midi); this.monoStack.push(midi);
      const v = this.monoVoice;
      if (v && !v.released) { this.glideTo(v, midi, t); return; }
      this.monoVoice = this.makeVoice(midi, vel, t);
      return;
    }
    const old = this.live.get(midi);
    if (old) this.release(old, t, 0.03);
    this.live.set(midi, this.makeVoice(midi, vel, t));
  }

  noteOff(midi, t = A.ctx.currentTime) {
    if (this.p.mono) {
      this.monoStack = this.monoStack.filter(m => m !== midi);
      const v = this.monoVoice;
      if (!v || v.released) return;
      if (this.monoStack.length) { if (v.midi === midi) this.glideTo(v, this.monoStack.at(-1), t); }
      else if (!v.seq) this.release(v, t);
      return;
    }
    const v = this.live.get(midi);
    if (v) { this.release(v, t); this.live.delete(midi); }
  }

  // ---- Secuenciado (con tiempo y duración) ----
  playNote(midi, vel, t, dur) {
    if (this.p.mono) {
      const v = this.monoVoice;
      if (v && !v.released && v.seq && v.seqEnd > t + 0.002) { // nota ligada → glide (estilo 303)
        this.glideTo(v, midi, t); v.seqEnd = Math.max(v.seqEnd, t + dur); return;
      }
      if (v && !v.released) this.release(v, v.seq ? Math.min(t, v.seqEnd) : t, 0.04);
    }
    const nv = this.makeVoice(midi, vel, t);
    nv.seq = true; nv.seqEnd = t + dur;
    this.seqVoices.push(nv);
    if (this.p.mono) this.monoVoice = nv;
  }

  service(horizon) {
    if (!this.seqVoices.length) return;
    this.seqVoices = this.seqVoices.filter(v => {
      if (v.released) return false;
      if (v.seqEnd < horizon) { this.release(v, v.seqEnd); return false; }
      return true;
    });
  }

  allOff(t = A.ctx.currentTime) {
    for (const v of this.voices) this.release(v, t, 0.05);
    this.live.clear(); this.seqVoices = []; this.monoStack = []; this.monoVoice = null;
  }
}
