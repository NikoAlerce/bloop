// Secuenciador con planificación anticipada ("A tale of two clocks").
import { A } from './audio/engine.js';
import { metroClick } from './audio/drums.js';
import { app } from './app.js';
import { mkStep, isPatternEmpty } from './state.js';
import { undo } from './undo.js';

const LOOK = 0.22;
const ARP_RATE = { '1/8': 2, '1/16': 1, '1/16T': 2 / 3, '1/32': 0.5 };
export const ARP_RATES = Object.keys(ARP_RATE);
export const ARP_MODES = ['up', 'down', 'updown', 'random', 'order'];

export const seq = {
  playing: false, recording: false,
  g: 0, nextTime: 0, startTime: 0, barTime: 0,
  stutter: null,           // {size, anchor, startG}
  history: [],             // pasos planificados recientes {t, eff}
  uiQueue: [],             // eventos para la UI {time, type, ...}
  arpHeld: [], arpPhys: new Set(), arpNext: null, arpIdx: 0,
  recHeld: new Map(),
  songIdx: 0, songBar: 0,

  get stepDur() { return 60 / app.state.bpm / 4; },

  start(at) {
    if (this.playing) return;
    const ctx = A.ctx, st = app.state;
    this.playing = true;
    this.g = 0;
    this.startTime = this.nextTime = this.barTime = (at != null ? Math.max(ctx.currentTime + 0.005, at) : ctx.currentTime + 0.08);
    this.history = [];
    this.arpNext = null;
    this.songBar = 0;
    if (st.song.on && st.song.chain.length) { this.songIdx = 0; st.current = st.song.chain[0].pat; st.queued = null; app.emit('pattern'); }
    app.loopers.forEach(l => l.onTransportStart(this.startTime));
    app.emit('transport');
  },

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.stutter = null;
    app.state.queued = null;
    app.synth.allOff();
    app.loopers.forEach(l => l.onTransportStop());
    app.tracks.forEach(t => t.fx.openGate());
    app.synth.fx.openGate();
    this.uiQueue.push({ time: 0, type: 'step', eff: -1 });
    app.emit('transport'); app.emit('pattern');
  },

  toggle() { this.playing ? this.stop() : this.start(); },

  nextBarTime() {
    const bd = this.stepDur * 16, now = A.ctx.currentTime;
    let t = this.barTime;
    while (t < now + 0.02) t += bd;
    return t;
  },

  setStutter(size) { this.stutter = size ? { size, anchor: null, startG: null } : null; },

  // Cambia de patrón (si suena, al terminar el compás)
  goPattern(i) {
    const st = app.state;
    if (this.playing && i !== st.current) st.queued = i;
    else {
      st.current = i; st.queued = null;
      app.loopers.forEach((l, k) => l.applyScene(app.pattern.loops[k], A.ctx.currentTime));
      app.emit('pattern');
    }
    app.emit('pattern-queue');
  },
  // Siguiente/anterior scene con contenido (ideal para pedales)
  stepPattern(dir) {
    const st = app.state, from = st.queued ?? st.current;
    const full = st.patterns.map((p, i) => (isPatternEmpty(p) ? -1 : i)).filter(i => i >= 0);
    const pool = full.length > 1 ? full : [0, 1, 2, 3, 4, 5, 6, 7];
    let k = pool.indexOf(from);
    if (k < 0) k = dir > 0 ? -1 : 0;
    this.goPattern(pool[(k + dir + pool.length) % pool.length]);
  },

  tick() {
    const horizon = A.ctx.currentTime + LOOK;
    if (this.playing) {
      while (this.nextTime < horizon) {
        this.scheduleStep(this.nextTime);
        this.nextTime += this.stepDur;
        this.g++;
      }
    }
    this.tickArp(horizon);
    app.synth.service(horizon);
  },

  scheduleStep(t) {
    const st = app.state, sd = this.stepDur, now = A.ctx.currentTime;
    if (this.g % 16 === 0) {
      // Modo canción: avanza la cadena al completar los compases de cada parte
      const song = st.song;
      if (song.on && song.chain.length && t > this.startTime + 0.001) {
        this.songBar++;
        const entry = song.chain[this.songIdx % song.chain.length];
        if (this.songBar >= entry.bars) {
          this.songBar = 0;
          this.songIdx = (this.songIdx + 1) % song.chain.length;
          st.queued = song.chain[this.songIdx].pat;
        }
      }
      if (st.queued != null) {
        st.current = st.queued; st.queued = null; this.g = 0;
        app.loopers.forEach((l, i) => l.applyScene(app.pattern.loops[i], t));
        app.emit('pattern');
      }
      this.barTime = t;
    }
    let eff = this.g;
    const stt = this.stutter;
    if (stt) {
      if (stt.anchor == null) { stt.anchor = this.g - (this.g % stt.size); stt.startG = this.g; }
      eff = stt.anchor + ((this.g - stt.startG) % stt.size);
    }
    const pat = app.pattern;
    const swing = eff % 2 === 1 ? st.swing * 0.5 * sd : 0;

    pat.tracks.forEach((tp, i) => {
      const tr = st.tracks[i];
      if (tr.params.gate !== 'off') app.tracks[i].fx.scheduleGate(t + swing, sd, eff, tr.params.gate, tr.params.gateDepth);
      const step = tp.steps[eff % tp.len];
      if (!step || !app.audible(i)) return;
      if (step.prob < 1 && Math.random() > step.prob) return;
      const tt = Math.max(now, t + swing + (step.nudge || 0) * sd);
      const n = step.rat || 1;
      for (let r = 0; r < n; r++) this.hit(i, tt + r * sd / n, step.vel * (r ? 0.8 : 1), step.pitch || 0);
    });

    const sfx = st.synth.fx;
    if (sfx.gate !== 'off') app.synth.fx.scheduleGate(t + swing, sd, eff, sfx.gate, sfx.gateDepth);
    if (app.audible(8)) {
      const sp = eff % pat.synth.len;
      for (const n of pat.synth.notes) {
        if (n.step !== sp) continue;
        if (n.recAt && t - n.recAt < 0.3) continue; // recién grabada: ya sonó en vivo
        const tt = Math.max(now, t + swing + (n.nudge || 0) * sd);
        app.synth.playNote(n.midi, n.vel, tt, Math.max(0.03, n.len * sd - 0.004));
      }
    }

    if (st.metronome && this.g % 4 === 0) metroClick(A.ctx, A.sum, t, this.g % 16 === 0);

    this.history.push({ t, eff });
    if (this.history.length > 12) this.history.shift();
    this.uiQueue.push({ time: t, type: 'step', eff });
  },

  // Dispara una pista (con choke por grupo). En modo slices, el "pitch" del paso elige el slice.
  hit(i, time, vel, semis = 0) {
    const st = app.state, tr = st.tracks[i], p = tr.params;
    if (tr.choke) st.tracks.forEach((o, j) => { if (j !== i && o.choke === tr.choke) app.tracks[j].choke(time); });
    if (p.sliceMode && p.slices.length) app.tracks[i].trigger(time, vel, 0, p, { slice: semis });
    else app.tracks[i].trigger(time, vel, semis, p);
    this.uiQueue.push({ time, type: 'hit', track: i, vel });
  },

  // Paso más cercano a "ahora" (compensando latencia de salida) y desfase en pasos
  nearestStep() {
    const now = A.ctx.currentTime - A.outLat;
    let best = null;
    for (const h of this.history) if (!best || Math.abs(h.t - now) < Math.abs(best.t - now)) best = h;
    if (!best) return null;
    const off = Math.max(-0.5, Math.min(0.5, (now - best.t) / this.stepDur));
    const q = app.state.recQuant;
    return { ...best, nudge: q.on ? Math.round(off * (1 - q.amount) * 100) / 100 : Math.round(off * 100) / 100 };
  },

  // ---- Grabación en vivo ----
  recordHit(i, vel, semis = 0) {
    if (!this.recording || !this.playing) return;
    const h = this.nearestStep(); if (!h) return;
    undo.pattern('Grabación', 'rec');
    const tp = app.pattern.tracks[i];
    const s = h.eff % tp.len;
    tp.steps[s] = { ...mkStep(vel), pitch: semis, nudge: h.nudge };
    app.emit('pattern-edit');
  },

  recordNoteOn(midi, vel) {
    if (!this.recording || !this.playing) return;
    const h = this.nearestStep(); if (!h) return;
    undo.pattern('Grabación', 'rec');
    const ps = app.pattern.synth;
    const step = h.eff % ps.len;
    ps.notes = ps.notes.filter(n => !(n.step === step && n.midi === midi));
    const note = { step, midi, len: 1, vel: Math.round(vel * 100) / 100, nudge: h.nudge, recAt: h.t };
    ps.notes.push(note);
    this.recHeld.set(midi, { note, on: A.ctx.currentTime });
    app.emit('pattern-edit');
  },

  recordNoteOff(midi) {
    const r = this.recHeld.get(midi);
    if (!r) return;
    this.recHeld.delete(midi);
    const len = Math.max(1, Math.round((A.ctx.currentTime - r.on) / this.stepDur));
    r.note.len = Math.min(len, app.pattern.synth.len);
    app.emit('pattern-edit');
  },

  // ---- Arpegiador ----
  arpAdd(midi) {
    const arp = app.state.synth.arp;
    if (arp.hold && this.arpPhys.size === 0) this.arpHeld = [];
    this.arpPhys.add(midi);
    if (!this.arpHeld.includes(midi)) this.arpHeld.push(midi);
  },
  arpRemove(midi) {
    this.arpPhys.delete(midi);
    if (!app.state.synth.arp.hold) this.arpHeld = this.arpHeld.filter(m => m !== midi);
  },
  arpClear() { this.arpHeld = []; this.arpPhys.clear(); this.arpNext = null; },

  arpSequence() {
    const arp = app.state.synth.arp;
    const base = arp.mode === 'order' ? this.arpHeld.slice() : this.arpHeld.slice().sort((a, b) => a - b);
    let seqn = [];
    for (let o = 0; o < arp.oct; o++) seqn.push(...base.map(m => m + o * 12));
    if (arp.mode === 'down') seqn.reverse();
    if (arp.mode === 'updown' && seqn.length > 2) seqn = seqn.concat(seqn.slice(1, -1).reverse());
    return seqn;
  },

  tickArp(horizon) {
    const arp = app.state.synth.arp;
    if (!arp.on || !this.arpHeld.length) { this.arpNext = null; return; }
    const iv = this.stepDur * ARP_RATE[arp.rate];
    const now = A.ctx.currentTime;
    if (this.arpNext == null) {
      if (this.playing) {
        let t = this.nextTime;
        while (t - iv > now + 0.005) t -= iv;
        this.arpNext = t;
      } else this.arpNext = now + 0.01;
      this.arpIdx = 0;
    }
    while (this.arpNext < horizon) {
      const s = this.arpSequence();
      if (!s.length) break;
      const midi = arp.mode === 'random' ? s[Math.floor(Math.random() * s.length)] : s[this.arpIdx % s.length];
      this.arpIdx++;
      if (app.audible(8)) app.synth.playNote(midi, 0.8, this.arpNext, iv * arp.gate);
      if (this.recording && this.playing) {
        const h = this.history.reduce((b, x) => (!b || Math.abs(x.t - this.arpNext) < Math.abs(b.t - this.arpNext) ? x : b), null);
        if (h && Math.abs(h.t - this.arpNext) < this.stepDur * 0.5) {
          const ps = app.pattern.synth, step = h.eff % ps.len;
          if (!ps.notes.some(n => n.step === step && n.midi === midi)) {
            undo.pattern('Grabación', 'rec');
            ps.notes.push({ step, midi, len: 1, vel: 0.8, recAt: this.arpNext });
            app.emit('pattern-edit');
          }
        }
      }
      this.arpNext += iv;
    }
  },
};
