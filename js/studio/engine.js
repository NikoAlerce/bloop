// Motor del Estudio: una cadena de audio por pista (instrumento → efectos → volumen → paneo →
// envíos), el transporte en tiempos (con región de loop), la grabación de audio y MIDI,
// la automatización y la exportación. Comparte el reloj, el tempo y la mezcla final de Bloop.
import { app } from '../app.js';
import { A, getMic, capture, heardTime, encodeWav, sliceBuffer, peakOf } from '../audio/engine.js';
import { Synth } from '../audio/synth.js';
import { metroClick } from '../audio/drums.js';
import { fxParams } from '../state.js';
import { download } from '../zip.js';
import { toast } from '../ui/util.js';
import { stretchBuffer } from '../audio/stretch.js';
import { undo } from '../undo.js';
import {
  S, spb, clipNotes, audible, getBuffer, putBuffer, resolveSrc, newMidiClip, newAudioClip, newTrack, findTrack, uid,
  DRUM_NOTE, songEnd, clone, loopLen, loopStart, loopEnd,
} from './model.js';
import { AUDIO_FX, MIDI_FX, SYNC, transformNote } from './devices.js';

const ctx = () => A.ctx;
const G = (v = 1) => { const g = ctx().createGain(); g.gain.value = v; return g; };
const NOFX = fxParams();
const LOOK = 0.2, CHUNK = 0.25;
export const faderGain = v => (v / 0.8) ** 2;

// ---------- Voces de sample (Drum Rack y Sampler) ----------
function playBuf(buf, dest, t, { rate = 1, vel = 1, gain = 1, pan = 0, a = 0.001, dur = null, r = 0.04, loop = false }) {
  const c = ctx(), src = c.createBufferSource(), env = c.createGain();
  src.buffer = buf; src.playbackRate.value = rate;
  if (loop) { src.loop = true; }
  let node = env;
  src.connect(env);
  if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; env.connect(p); node = p; }
  node.connect(dest);
  const pk = gain * (0.15 + 0.85 * vel);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(pk, t + Math.max(0.001, a));
  let end = t + buf.duration / rate;
  if (dur != null) {
    const off = t + Math.max(a, dur);
    env.gain.setValueAtTime(pk, off);
    env.gain.setTargetAtTime(0, off, r / 4 + 0.002);
    end = loop ? off + r * 1.5 + 0.05 : Math.min(end, off + r * 1.5 + 0.05);
  }
  src.start(t);
  src.stop(end + 0.02);
  const v = { src, env, end, pk };
  src.onended = () => { try { node.disconnect(); env.disconnect(); } catch (e) { /* */ } };
  return v;
}
function releaseVoice(v, t, r = 0.04) {
  if (!v || v.end <= t) return;
  const g = v.env.gain;
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
  g.setTargetAtTime(0, t, r / 4 + 0.002);
  try { v.src.stop(t + r * 1.5 + 0.05); } catch (e) { /* */ }
  v.end = t;
}

class SynthInst {
  constructor(ta, inst) {
    this.s = new Synth({ bus: ta.input, revIn: ta.instRev, dlyIn: ta.instDly });
    this.s.getBpm = () => app.state.bpm;
    this.update(inst);
  }
  update(inst) { this.s.setParams(inst.params); this.s.apply(true, NOFX); }
  play(p, v, t, d) { this.s.playNote(p, v, t, d); }
  on(p, v) { this.s.noteOn(p, v); }
  off(p) { this.s.noteOff(p); }
  service(h) { this.s.service(h); }
  allOff() { this.s.allOff(); }
  dispose() { this.s.allOff(); setTimeout(() => this.s.main.dispose(), 3000); }
}

class DrumInst {
  constructor(ta, inst) { this.ta = ta; this.bufs = []; this.voices = []; this.sigs = []; this.update(inst); }
  update(inst) {
    this.inst = inst;
    inst.pads.forEach((pd, i) => {
      const sig = pd ? JSON.stringify(pd.src) : '';
      if (sig === this.sigs[i]) return;
      this.sigs[i] = sig; this.bufs[i] = null;
      if (pd) resolveSrc(pd.src).then(r => { if (this.sigs[i] === sig) this.bufs[i] = r?.buffer || r?.zones?.[0]?.buffer || null; });
    });
  }
  play(p, v, t) {
    const i = p - DRUM_NOTE, pd = this.inst.pads[i], buf = this.bufs[i];
    if (!pd || !buf) return;
    if (this.voices[i]) releaseVoice(this.voices[i], t, 0.01); // cada pad corta su sonido anterior
    if (pd.choke) this.inst.pads.forEach((o, j) => { if (j !== i && o?.choke === pd.choke && this.voices[j]) releaseVoice(this.voices[j], t, 0.01); });
    this.voices[i] = playBuf(buf, this.ta.input, t, { rate: Math.pow(2, (pd.pitch || 0) / 12), vel: v, gain: (pd.vol / 0.8) ** 2, pan: pd.pan || 0 });
  }
  on(p, v) { this.play(p, v, ctx().currentTime + 0.003); app.emit('studio-pad', p - DRUM_NOTE); }
  off() { /* one-shot */ }
  service() { /* */ }
  allOff() { const t = ctx().currentTime; this.voices.forEach(v => releaseVoice(v, t, 0.02)); }
  dispose() { this.allOff(); }
}

class SamplerInst {
  constructor(ta, inst) { this.ta = ta; this.zones = []; this.held = new Map(); this.voices = new Set(); this.sig = ''; this.update(inst); }
  update(inst) {
    this.inst = inst;
    const sig = JSON.stringify(inst.src);
    if (sig === this.sig) return;
    this.sig = sig; this.zones = [];
    resolveSrc(inst.src).then(r => {
      if (this.sig !== sig || !r) return;
      this.zones = r.zones ? r.zones.slice().sort((a, b) => a.root - b.root) : r.buffer ? [{ root: null, buffer: r.buffer }] : [];
    });
  }
  pick(p) {
    if (!this.zones.length) return null;
    const ins = this.inst;
    if (this.zones.length === 1 && this.zones[0].root == null) return { buf: this.zones[0].buffer, rate: Math.pow(2, (p - ins.root + ins.tune) / 12) };
    let z = this.zones[0];
    for (const c of this.zones) if (Math.abs(c.root - p) < Math.abs(z.root - p)) z = c;
    return { buf: z.buffer, rate: Math.pow(2, (p - z.root + ins.tune) / 12) };
  }
  play(p, v, t, d) {
    const pk = this.pick(p); if (!pk) return;
    const ins = this.inst;
    const vo = playBuf(pk.buf, this.ta.input, t, { rate: pk.rate, vel: v, gain: (ins.vol / 0.8) ** 2, a: ins.a, r: ins.r, dur: d, loop: ins.loop });
    this.voices.add(vo); vo.src.addEventListener('ended', () => this.voices.delete(vo));
  }
  on(p, v) {
    const pk = this.pick(p); if (!pk) return;
    const ins = this.inst, t = ctx().currentTime + 0.003;
    this.off(p);
    const vo = playBuf(pk.buf, this.ta.input, t, { rate: pk.rate, vel: v, gain: (ins.vol / 0.8) ** 2, a: ins.a, r: ins.r, loop: ins.loop, dur: ins.loop ? 600 : null });
    this.held.set(p, vo); this.voices.add(vo); vo.src.addEventListener('ended', () => this.voices.delete(vo));
  }
  off(p) { const v = this.held.get(p); if (v) { releaseVoice(v, ctx().currentTime, this.inst.r); this.held.delete(p); } }
  service() { /* */ }
  allOff() { const t = ctx().currentTime; this.voices.forEach(v => releaseVoice(v, t, 0.03)); this.held.clear(); }
  dispose() { this.allOff(); }
}
const INST = { synth: SynthInst, drums: DrumInst, sampler: SamplerInst };

// ---------- Audio de una pista ----------
class TrackAudio {
  constructor(t, bus) {
    this.id = t.id;
    this.input = G(1);
    this.instRev = G(0); this.instDly = G(0);
    this.fader = G(1);
    this.pan = ctx().createStereoPanner();
    this.out = G(1);
    this.revSend = G(0); this.dlySend = G(0);
    this.meter = ctx().createAnalyser(); this.meter.fftSize = 256;
    this.fader.connect(this.pan).connect(this.out).connect(bus);
    this.out.connect(this.revSend).connect(A.reverbIn);
    this.out.connect(this.dlySend).connect(A.delayIn);
    this.out.connect(this.meter);
    this.instRev.connect(A.reverbIn); this.instDly.connect(A.delayIn);
    this.devs = []; this.chainSig = null;
    this.inst = null; this.instType = null;
    this.srcs = new Set();
    this.monOn = false;
    this.input.connect(this.fader);
  }

  syncInst(t) {
    const type = t.kind === 'midi' ? t.inst?.type : null;
    if (type !== this.instType) {
      if (this.inst) this.inst.dispose();
      this.inst = type ? new INST[type](this, t.inst) : null;
      this.instType = type;
    } else if (this.inst) this.inst.update(t.inst);
  }

  syncChain(t) {
    const sig = t.devices.map(d => d.id + (d.on ? '+' : '-')).join(',');
    if (sig !== this.chainSig) {
      this.chainSig = sig;
      const keep = new Map(this.devs.map(d => [d.id, d]));
      this.input.disconnect();
      this.devs.forEach(d => { try { d.node.output.disconnect(); } catch (e) { /* */ } });
      const next = [];
      for (const d of t.devices) {
        let x = keep.get(d.id);
        if (!x) x = { id: d.id, type: d.type, node: AUDIO_FX[d.type].make() };
        keep.delete(d.id);
        next.push(x);
      }
      for (const x of keep.values()) { try { x.node.output.disconnect(); x.node.input.disconnect(); } catch (e) { /* */ } x.node.dispose?.(); }
      this.devs = next;
      let node = this.input;
      t.devices.forEach((d, k) => { if (d.on) { node.connect(this.devs[k].node.input); node = this.devs[k].node.output; } });
      node.connect(this.fader);
    }
    const now = ctx().currentTime, bpm = app.state.bpm;
    t.devices.forEach((d, k) => this.devs[k].node.set(d.p, now, bpm));
  }

  dev(id) { return this.devs.find(d => d.id === id); }

  // Escuchar la entrada (micrófono) a través de los efectos de la pista
  syncMon(t) {
    const want = t.kind === 'audio' && t.arm && t.mon;
    if (want === this.monOn) return;
    this.monOn = want;
    if (want) getMic(A.inputId).then(n => { if (this.monOn) { n.connect(this.input); A.micPinned = (A.micPinned || 0) + 1; } }).catch(() => toast('No pude abrir el micrófono'));
    else { try { A.micNode.disconnect(this.input); } catch (e) { /* */ } A.micPinned = Math.max(0, (A.micPinned || 1) - 1); }
  }

  stopSources(t = ctx().currentTime) {
    for (const s of this.srcs) { try { s.g.gain.setTargetAtTime(0, t, 0.005); s.src.stop(t + 0.03); } catch (e) { /* */ } }
    this.srcs.clear();
  }

  level() {
    const d = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(d);
    let pk = 0; for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    return pk;
  }

  dispose() {
    this.stopSources(); this.inst?.dispose();
    if (this.monOn) { this.monOn = true; this.syncMon({ kind: 'audio' }); }
    setTimeout(() => { [this.out, this.instRev, this.instDly, this.revSend, this.dlySend].forEach(n => { try { n.disconnect(); } catch (e) { /* */ } }); this.devs.forEach(d => d.node.dispose?.()); }, 2500);
  }
}

// Una pista suena si está prendida (y no la tapa un solo de otra), o si está armada (⏺):
// como el monitoreo de Ableton, armar una pista MIDI siempre deja escuchar lo que tocás
export const heard = t => audible(t) || (t.arm && t.kind === 'midi');

// Si tocás una pista que no suena, avisa por qué (una vez cada tanto)
let hintT = 0;
export function silentHint(t) {
  if (heard(t) || performance.now() - hintT < 6000) return;
  hintT = performance.now();
  const others = S().tracks.some(x => x.solo && x !== t);
  toast(others ? `«${t.name}» no suena porque otra pista está en Solo (S). Armala (⏺) o sacá el Solo.`
    : `«${t.name}» está apagada: tocá su número amarillo para prenderla, o armala (⏺).`, 4200);
}

// ---------- Automatización ----------
// Claves: 'vol', 'pan', 'rev', 'dly', 'd:<idDispositivo>:<param>'
export function autoTargets(t) {
  const out = [
    { key: 'vol', label: 'Volumen', min: 0, max: 1 },
    { key: 'pan', label: 'Paneo', min: -1, max: 1 },
    { key: 'rev', label: 'Envío reverb', min: 0, max: 1 },
    { key: 'dly', label: 'Envío delay', min: 0, max: 1 },
  ];
  for (const d of t.devices) {
    const spec = AUDIO_FX[d.type];
    for (const p of spec.params) if (!p.opts) out.push({ key: `d:${d.id}:${p.k}`, label: `${spec.name} · ${p.label}`, min: p.min, max: p.max, log: p.log, fmt: p.fmt });
  }
  if (t.inst?.type === 'synth') for (const [k, label] of [['cutoff', 'Synth · Filtro'], ['reso', 'Synth · Resonancia']]) out.push({ key: 's:' + k, label, min: 0, max: 1 });
  return out;
}
export function autoValueAt(pts, b) {
  if (!pts?.length) return null;
  if (b <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (b < pts[i][0]) { const [b0, v0] = pts[i - 1], [b1, v1] = pts[i]; return v0 + (v1 - v0) * (b - b0) / Math.max(1e-6, b1 - b0); }
  }
  return pts[pts.length - 1][1];
}

// ---------- Estudio ----------
export const studio = {
  tracks: new Map(),
  bus: null,
  playing: false, recording: false,
  cb: 0, ct: 0, jump: false, anchors: [],
  rec: null,

  init() {
    // Mismo margen que la mezcla del modo En vivo: la suma de pistas no satura el compresor
    this.bus = G(0.6);
    this.bus.connect(A.sum);
    this.preview = G(0.9); this.preview.connect(A.sum);
    let st = 0;
    app.on('bpm', () => { this.refreshDevices(); clearTimeout(st); st = setTimeout(prepareStretch, 400); });
    setTimeout(prepareStretch, 1000);
  },

  ta(id) { return this.tracks.get(id); },

  // Ajusta el audio a lo que dice el arreglo (pistas nuevas, borradas, instrumentos, efectos)
  sync() {
    const st = S(), ids = new Set(st.tracks.map(t => t.id));
    for (const [id, ta] of this.tracks) if (!ids.has(id)) { ta.dispose(); this.tracks.delete(id); }
    for (const t of st.tracks) {
      let ta = this.tracks.get(t.id);
      if (!ta) { ta = new TrackAudio(t, this.bus); this.tracks.set(t.id, ta); }
      ta.syncInst(t); ta.syncChain(t); ta.syncMon(t);
    }
    this.applyMix();
  },

  refreshDevices() { for (const t of S().tracks) this.ta(t.id)?.syncChain(t); },

  applyMix() { for (const t of S().tracks) this.applyTrack(t); },

  applyTrack(t, time = ctx().currentTime, vals = {}) {
    const ta = this.ta(t.id); if (!ta) return;
    const on = heard(t);
    const vol = vals.vol ?? t.vol, pan = vals.pan ?? t.pan, rev = vals.rev ?? t.rev, dly = vals.dly ?? t.dly;
    const g = on ? faderGain(vol) : 0;
    ta.fader.gain.setTargetAtTime(g, time, 0.012);
    ta.instRev.gain.setTargetAtTime(g, time, 0.012);
    ta.instDly.gain.setTargetAtTime(g, time, 0.012);
    ta.pan.pan.setTargetAtTime(pan, time, 0.012);
    ta.revSend.gain.setTargetAtTime(rev * rev, time, 0.012);
    ta.dlySend.gain.setTargetAtTime(dly * dly, time, 0.012);
  },

  // ---- Transporte ----
  play(from = S().pos, at = null) {
    if (this.playing) return;
    if (app.seq.playing) app.seq.stop();
    const c = ctx();
    this.playing = true;
    this.cb = Math.max(0, from);
    this.ct = at ?? c.currentTime + 0.06;
    this.jump = true;
    this.anchors = [{ t: this.ct, b: this.cb }];
    app.emit('studio-transport');
  },

  stop() {
    if (this.countClicks) { this.countClicks.forEach(o => { try { o.stop(); } catch (e) { /* */ } }); this.countClicks = null; this.countIn = null; }
    if (this.recording) this.stopRec();
    if (!this.playing) { app.emit('studio-transport'); return; }
    this.playing = false;
    const t = ctx().currentTime;
    for (const ta of this.tracks.values()) { ta.stopSources(t); ta.inst?.allOff(); }
    this.applyMix();
    app.emit('studio-transport');
  },

  toggle() { this.playing ? this.stop() : this.play(); },

  // Tiempo (en beats) que suena en el instante `time` del audio
  beatAt(time) {
    const an = this.anchors;
    if (!an.length) return S().pos;
    let a = an[0];
    for (const x of an) { if (x.t <= time + 1e-6) a = x; else break; }
    return a.b + (time - a.t) / spb();
  },
  // Lo que se escucha ahora (descontando la latencia de salida)
  heardBeat(ts) { return this.playing ? this.beatAt(heardTime(ts)) : S().pos; },

  tick() {
    this.prevInst?.inst.service(ctx().currentTime + LOOK);
    if (!this.playing) { for (const ta of this.tracks.values()) ta.inst?.service(ctx().currentTime + LOOK); return; }
    const horizon = ctx().currentTime + LOOK, st = S();
    if (this.countIn && ctx().currentTime > this.countIn.t0 + 0.5) { this.countIn = null; this.countClicks = null; }
    let guard = 0;
    while (this.ct < horizon && guard++ < 64) {
      const sp = spb(), L = st.loop;
      const loopOn = L.on && L.b > L.a && !(this.rec && this.rec.audio) && this.cb < L.b;
      let e = this.cb + CHUNK - ((this.cb + 1e-9) % CHUNK);
      if (loopOn) e = Math.min(e, L.b);
      this.schedule(this.cb, e, this.ct, sp, this.jump, loopOn ? L.b : Infinity);
      this.jump = false;
      this.ct += (e - this.cb) * sp; this.cb = e;
      if (loopOn && this.cb >= L.b - 1e-9) { this.cb = L.a; this.jump = true; }
      this.anchors.push({ t: this.ct, b: this.cb });
      if (this.anchors.length > 80) this.anchors.splice(0, this.anchors.length - 80);
    }
    for (const ta of this.tracks.values()) ta.inst?.service(horizon);
    if (this.rec && !this.rec.audio) this.growRecClips();
  },

  schedule(a, e, t0, sp, jump, loopEnd) {
    const st = S(), T = b => t0 + (b - a) * sp, now = ctx().currentTime;
    if (st.metro) {
      for (let k = Math.ceil(a - 1e-9); k < e - 1e-9; k++) metroClick(ctx(), A.clickBus, T(k), k % 4 === 0);
    }
    const bpm = app.state.bpm;
    for (const t of st.tracks) {
      const ta = this.ta(t.id); if (!ta) continue;
      this.automate(t, ta, a, T(a));
      for (const c of t.clips) {
        const ce = c.start + c.len;
        if (ce <= a || c.start >= e) continue;
        if (c.kind === 'audio') {
          const startsHere = c.start >= a && c.start < e;
          if (!startsHere && !(jump && c.start < a)) continue;
          const b0 = startsHere ? c.start : a;
          this.startAudio(ta, c, b0, Math.min(ce, loopEnd), T(b0), sp, bpm, now);
        } else if (ta.inst) {
          this.scheduleMidi(t, ta, c, a, e, T, sp, loopEnd, now);
        }
      }
    }
  },

  startAudio(ta, c, b0, b1, t, sp, bpm, now) {
    let buf = getBuffer(c.buf); if (!buf || b1 <= b0) return;
    let bufSpb = c.warp ? 60 / c.bpm : sp;              // segundos de buffer por tiempo
    let off = c.off + (b0 - c.start) * bufSpb;
    let rate = c.warp ? bpm / c.bpm : 1;
    // "Mantener el tono": versión estirada al tempo actual (si todavía no está, suena como cinta)
    const sb = stretched(c, bpm);
    if (sb) { buf = sb; bufSpb = 60 / bpm; off = c.off * (c.bpm / bpm) + (b0 - c.start) * bufSpb; rate = 1; }
    const dur = (b1 - b0) * bufSpb;
    if (off >= buf.duration) return;
    const src = ctx().createBufferSource(), g = ctx().createGain();
    src.buffer = buf; src.playbackRate.value = rate;
    src.connect(g).connect(ta.input);
    const t0 = Math.max(now, t), realDur = Math.min(dur, buf.duration - off) / rate;
    const gain = c.gain ?? 1;
    const fi = b0 > c.start + 1e-6 ? 0.004 : Math.max(0.002, c.fadeIn || 0);
    const fo = Math.max(0.002, Math.min(realDur / 2, c.fadeOut || 0.003));
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + fi);
    g.gain.setValueAtTime(gain, t0 + Math.max(fi, realDur - fo));
    g.gain.linearRampToValueAtTime(0, t0 + realDur);
    src.start(t0, off + Math.max(0, now - t) * rate, Math.min(dur, buf.duration - off));
    src.stop(t0 + realDur + 0.02);
    const rec = { src, g };
    ta.srcs.add(rec);
    src.onended = () => { ta.srcs.delete(rec); try { g.disconnect(); } catch (e) { /* */ } };
  },

  scheduleMidi(t, ta, c, a, e, T, sp, loopEnd, now) {
    const fx = t.midiFx || [];
    const arp = fx.find(f => f.type === 'arp' && f.on);
    const play = (n, b) => {
      const d = Math.max(0.01, Math.min(n.d, loopEnd - b));
      ta.inst.play(n.p, n.v, Math.max(now, T(b) + (n.dt || 0)), d * sp);
    };
    if (!arp) {
      for (const n of clipNotes(c, a, e)) {
        if (n.c < 1 && Math.random() > n.c) continue; // probabilidad de la nota
        for (const m of transformNote(n, fx)) play(m, n.s);
      }
      return;
    }
    // Arpegiador: en cada paso, las notas que están sonando (después de acordes/escala)
    const p = arp.p, r = SYNC[p.rate] || 0.25;
    const notes = clipNotes(c, Math.max(c.start, a - 16), e).flatMap(n => transformNote(n, fx).map(m => ({ ...m, s: n.s, d: n.d })));
    for (let x = Math.ceil((a - 1e-9) / r) * r; x < e - 1e-9; x += r) {
      const act = notes.filter(n => n.s <= x + 1e-6 && x < n.s + n.d - 1e-6);
      if (!act.length) continue;
      const s0 = Math.min(...act.map(n => n.s));
      let seqP = [...new Set(act.map(n => n.p))].sort((u, v) => u - v);
      const base = seqP.slice();
      for (let o = 1; o < Math.round(p.oct); o++) seqP = seqP.concat(base.map(m => m + 12 * o));
      if (p.mode === 'down') seqP.reverse();
      if (p.mode === 'updown' && seqP.length > 2) seqP = seqP.concat(seqP.slice(1, -1).reverse());
      const idx = Math.round((x - s0) / r);
      const pitch = p.mode === 'random' ? seqP[Math.floor(Math.random() * seqP.length)] : seqP[idx % seqP.length];
      const v = act.reduce((m, n) => Math.max(m, n.v), 0);
      play({ p: pitch, v, d: r * p.gate }, x);
    }
  },

  automate(t, ta, b, time) {
    const auto = t.auto || {};
    const vals = {};
    let any = false;
    for (const k of ['vol', 'pan', 'rev', 'dly']) { const v = autoValueAt(auto[k], b); if (v != null) { vals[k] = v; any = true; } }
    if (any) this.applyTrack(t, time, vals);
    for (const d of t.devices) {
      let p = null;
      for (const spec of AUDIO_FX[d.type].params) {
        const v = autoValueAt(auto[`d:${d.id}:${spec.k}`], b);
        if (v != null) { (p ||= { ...d.p })[spec.k] = v; }
      }
      if (p) ta.dev(d.id)?.node.set(p, time, app.state.bpm);
    }
    if (t.inst?.type === 'synth' && ta.inst?.s) {
      let ch = false; const pp = ta.inst.s.p;
      for (const k of ['cutoff', 'reso']) { const v = autoValueAt(auto['s:' + k], b); if (v != null) { pp[k] = v; ch = true; } }
      if (ch) ta.inst.s.apply(true, NOFX);
    }
  },

  // ---- Tocar en vivo (teclado en pantalla, teclado de la compu, MIDI) ----
  held: new Map(),
  playTarget() {
    const st = S(), sel = st.tracks.find(t => t.id === st.sel.track);
    if (sel?.kind === 'midi') return sel;
    return st.tracks.find(t => t.kind === 'midi' && t.arm) || null;
  },
  noteOn(midi, vel = 0.8, ts) {
    const t = this.playTarget(); if (!t) return false;
    silentHint(t);
    const ta = this.ta(t.id); if (!ta?.inst) return false;
    const ps = transformNote({ p: midi, v: vel }, (t.midiFx || []).filter(f => f.type !== 'arp' && f.type !== 'human')).map(n => n.p);
    this.noteOff(midi);
    ps.forEach(p => ta.inst.on(p, vel));
    this.held.set(midi, { t: t.id, ps });
    if (this.rec && this.playing) this.recNoteOn(midi, vel, ts);
    app.emit('studio-note', midi, true);
    return true;
  },
  noteOff(midi, ts) {
    const h = this.held.get(midi); if (!h) return;
    this.held.delete(midi);
    const ta = this.ta(h.t);
    h.ps.forEach(p => ta?.inst?.off(p));
    if (this.rec) this.recNoteOff(midi, ts);
    app.emit('studio-note', midi, false);
  },

  // ---- Grabación ----
  async toggleRec() { this.rec ? this.stopRec() : await this.startRec(); },

  async startRec() {
    const st = S();
    let armed = st.tracks.filter(t => t.arm);
    if (!armed.length) {
      const sel = st.tracks.find(t => t.id === st.sel.track);
      if (sel) { sel.arm = true; armed = [sel]; this.sync(); app.emit('studio'); }
    }
    if (!armed.length) { toast('Armá una pista (botón ⏺ de la pista) para grabar'); return; }
    const audioT = armed.filter(t => t.kind === 'audio'), midiT = armed.filter(t => t.kind === 'midi');
    let mic = null;
    if (audioT.length) {
      try { mic = await getMic(A.inputId); } catch (e) { toast('No pude abrir el micrófono: ' + e.message); return; }
    }
    undo.state('Grabación', null, () => clone(st.tracks), v => { st.tracks = v; this.sync(); app.emit('studio'); });
    const c = ctx();
    let tStart;
    if (!this.playing) {
      const bars = st.countIn ?? 1, beat = spb();
      const t = c.currentTime + 0.1;
      if (bars) {
        this.countClicks = [];
        for (let k = 0; k < bars * 4; k++) {
          const tt = t + k * beat, o = c.createOscillator(), g = c.createGain();
          o.frequency.value = k % 4 === 0 ? 1600 : 1050;
          g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(0.4, tt + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.05);
          o.connect(g).connect(A.clickBus); o.start(tt); o.stop(tt + 0.06);
          this.countClicks.push(o);
        }
        const ci = this.countIn = { t, t0: t + bars * 4 * beat, n: bars * 4, beat, rec: true, alive: () => this.countIn === ci && this.playing };
        app.emit('countin', ci);
      }
      tStart = t + (bars ? bars * 4 * beat : 0);
      this.play(st.pos, tStart);
    } else tStart = c.currentTime + 0.05;
    const b0 = this.beatAt(tStart);
    this.rec = { audio: audioT.length > 0, b0, tStart, tracks: armed.map(t => t.id), clips: {}, notes: new Map() };
    if (mic) {
      // la onda se va dibujando mientras grabás
      const lp = this.rec.lp = [];
      this.rec.sr = c.sampleRate;
      this.rec.job = capture(mic, tStart, 1200, p => { for (let i = 0; i < p.length; i++) lp.push(p[i]); });
    }
    // Clips MIDI: con loop prendido se graba encima (overdub) del clip del loop
    for (const t of midiT) {
      const L = st.loop;
      let clip;
      if (L.on && !this.rec.audio && b0 >= L.a - 0.01 && b0 < L.b) {
        clip = t.clips.find(x => x.kind === 'midi' && x.start <= L.a + 1e-6 && x.start + x.len >= L.b - 1e-6);
        if (!clip) { clip = newMidiClip(L.a, L.b - L.a, t.color); t.clips.push(clip); }
        clip.loopRec = true;
      } else {
        const bar = Math.floor(b0 / 4 + 1e-6) * 4;
        clip = newMidiClip(bar, 4, t.color); t.clips.push(clip);
        removeOverlaps(t, clip);
      }
      this.rec.clips[t.id] = clip.id;
    }
    st.rec = true;
    this.recording = true;
    app.emit('studio'); app.emit('studio-rec');
  },

  growRecClips() {
    const b = this.heardBeat();
    for (const t of S().tracks) {
      const id = this.rec.clips[t.id]; if (!id) continue;
      const c = t.clips.find(x => x.id === id);
      if (c && !c.loopRec && b > c.start + c.len - 0.001) { c.len = Math.ceil((b - c.start + 0.001) / 4) * 4; c.loop = c.len; app.emit('studio-draw'); }
    }
  },

  recNoteOn(midi, vel, ts) {
    const st = S(), q = app.state.recQuant;
    let b = this.heardBeat(ts);
    if (this.countIn && b < this.rec.b0 - 0.25) return;
    for (const t of st.tracks) {
      const id = this.rec.clips[t.id]; if (!id) continue;
      const c = t.clips.find(x => x.id === id); if (!c) continue;
      let rel = b - c.start;
      const LL = loopLen(c), LS = loopStart(c);
      if (c.loopRec) rel = ((rel % LL) + LL) % LL;
      if (q.on) { const g = (({ '1/4': 4, '1/8': 2, '1/8T': 4 / 3, '1/16': 1, '1/16T': 2 / 3, '1/32': 0.5 })[q.grid] || 1) / 4; rel += (Math.round(rel / g) * g - rel) * q.amount; }
      rel = Math.max(0, rel);
      if (c.loopRec && rel >= LL - 1e-6) rel = 0;
      if (c.loopRec) rel += LS;
      const nt = { p: midi, s: Math.round(rel * 1000) / 1000, d: 0.25, v: Math.round(vel * 100) / 100 };
      c.notes = c.notes.filter(n => !(n.p === midi && Math.abs(n.s - nt.s) < 0.01));
      c.notes.push(nt);
      this.rec.notes.set(midi + ':' + t.id, { nt, b, c });
    }
    app.emit('studio-draw');
  },
  recNoteOff(midi, ts) {
    const b = this.heardBeat(ts);
    for (const [k, r] of this.rec.notes) {
      if (!k.startsWith(midi + ':')) continue;
      this.rec.notes.delete(k);
      let d = b - r.b;
      if (d < 0 && r.c.loopRec) d += S().loop.b - S().loop.a;
      r.nt.d = Math.max(0.0625, Math.round(d * 1000) / 1000);
    }
    app.emit('studio-draw');
  },

  async stopRec() {
    const r = this.rec; if (!r) return;
    this.rec = null; this.recording = false; S().rec = false;
    for (const [k, x] of r.notes) x.nt.d = Math.max(0.0625, this.heardBeat() - x.b);
    for (const t of S().tracks) { const c = t.clips.find(x => x.id === r.clips[t.id]); if (c) { delete c.loopRec; if (!c.notes.length && !r.audio) t.clips = t.clips.filter(x => x !== c); } }
    app.emit('studio-rec');
    if (r.job) {
      const tEnd = ctx().currentTime;
      r.job.stop();
      const raw = await r.job.promise;
      const lat = Math.max(0, (app.state.settings.micLatency || 0) / 1000);
      const sr = raw.sampleRate, a = Math.round(lat * sr), b = Math.min(raw.length, Math.round((tEnd - r.tStart + lat) * sr));
      if (b - a > sr * 0.05) {
        const buf = sliceBuffer(raw, a, b);
        const id = putBuffer(buf);
        for (const t of S().tracks) {
          if (!r.tracks.includes(t.id) || t.kind !== 'audio') continue;
          const c = newAudioClip(Math.max(0, r.b0), buf, id, t.color, app.state.bpm, 'Grabación');
          t.clips.push(c); removeOverlaps(t, c);
          S().sel.clip = c.id; S().sel.track = t.id;
        }
        if (peakOf(buf) < 0.003) toast('La grabación quedó casi muda: revisá la entrada (☰ → 🎤)');
      }
    }
    app.emit('studio');
  },

  // ---- Exportar / pasar a audio (en tiempo real) ----
  async renderRange(node, a, b, tail) {
    if (this.playing) this.stop();
    const sp = spb(), t0 = ctx().currentTime + 0.15, dur = (b - a) * sp + tail;
    const saveLoop = S().loop.on;
    S().loop.on = false;
    const job = capture(node, t0, dur);
    this.play(a, t0);
    this.rendering = { t0, dur };
    app.emit('studio-render', true);
    const buf = await job.promise;
    this.rendering = null;
    S().loop.on = saveLoop;
    this.stop();
    app.emit('studio-render', false);
    return buf;
  },

  async exportMix() {
    const st = S(), L = st.loop;
    const a = L.on ? L.a : 0, b = L.on ? L.b : songEnd();
    if (b - a < 0.25) { toast('No hay nada para exportar todavía'); return; }
    toast(`⏺ Exportando ${Math.round((b - a) / 4)} compases en tiempo real…`, 3000);
    const buf = await this.renderRange(A.analyser, a, b, L.on ? 0 : 2);
    const d = new Date(), p = x => String(x).padStart(2, '0');
    download(encodeWav(buf), `bloop-estudio-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.wav`);
    toast('⤓ WAV listo');
  },

  // Congela una pista: la graba con sus efectos y la pone como audio en una pista nueva
  async bounce(t) {
    const end = Math.max(...t.clips.map(c => c.start + c.len), 0);
    if (!end) { toast('La pista está vacía'); return; }
    const a = Math.floor(Math.min(...t.clips.map(c => c.start)) / 4) * 4;
    toast(`⏺ Pasando «${t.name}» a audio…`, 3000);
    const ta = this.ta(t.id);
    const buf = await this.renderRange(ta.out, a, end, 1.5);
    const st = S();
    undo.state('Pasar a audio', null, () => clone(st.tracks), v => { st.tracks = v; this.sync(); app.emit('studio'); });
    const nt = newTrack('audio', { name: t.name + ' (audio)', color: t.color });
    const id = putBuffer(buf);
    const c = newAudioClip(a, buf, id, t.color, app.state.bpm, t.name);
    c.len = end - a + 1.5 / spb(); c.len = Math.ceil(c.len * 4) / 4;
    nt.clips.push(c);
    st.tracks.splice(st.tracks.indexOf(t) + 1, 0, nt);
    t.mute = true;
    this.sync(); app.emit('studio');
    toast('🧊 Listo: la original quedó muteada');
  },

  // Vista previa de un sample del navegador
  async previewBuf(buf) {
    this.stopPreview();
    const src = ctx().createBufferSource(); src.buffer = buf; src.connect(this.preview); src.start();
    this.prevSrc = src;
  },
  stopPreview() {
    try { this.prevSrc?.stop(); } catch (e) { /* */ }
    this.prevSrc = null;
    const pi = this.prevInst; this.prevInst = null;
    if (pi) { pi.inst.allOff(); clearTimeout(pi.timer); setTimeout(() => { try { pi.out.disconnect(); } catch (e) { /* */ } pi.inst.dispose(); }, 400); }
  },

  // Muestra de cómo suena un instrumento del navegador, sin agregarlo: una frase corta
  async previewInst(inst, cat = '') {
    this.stopPreview();
    const c = ctx(), out = G(0.9);
    out.connect(this.preview);
    const ta = { input: out, instRev: G(1), instDly: G(1) };
    ta.instRev.connect(A.reverbIn); ta.instDly.connect(A.delayIn);
    const I = new INST[inst.type](ta, inst);
    const me = this.prevInst = { inst: I, out, timer: 0 };
    // los samples se cargan aparte: esperar un toque a que estén
    for (let k = 0; k < 30 && (inst.type === 'drums' ? !I.bufs.some(Boolean) : inst.type === 'sampler' ? !I.zones.length : false); k++) await new Promise(r => setTimeout(r, 50));
    if (this.prevInst !== me) return;
    const t0 = c.currentTime + 0.06, b = 60 / 112 / 2; // corcheas a 112
    const seq = [];
    if (inst.type === 'drums') {
      for (let k = 0; k < 8; k++) {
        if (k === 0 || k === 5) seq.push([DRUM_NOTE, k, 0.95, 0.5]);
        if (k === 2 || k === 6) seq.push([DRUM_NOTE + 1, k, 0.9, 0.5]);
        seq.push([DRUM_NOTE + 3, k, k % 2 ? 0.45 : 0.7, 0.5]);
      }
    } else if (cat === 'bass') [36, 36, 43, 41, 36, 48, 46, 43].forEach((p, k) => seq.push([p, k, 0.85, 0.9]));
    else if (['keys', 'bell', 'pluck', 'retro'].includes(cat)) [60, 64, 67, 72, 76, 72, 67, 64].forEach((p, k) => seq.push([p, k, 0.8, 0.9]));
    else if (cat === 'lead') [72, 74, 76, 79, 76, 74, 72, 67].forEach((p, k) => seq.push([p, k, 0.85, 0.95]));
    else [57, 60, 64, 67].forEach(p => seq.push([p, 0, 0.75, 6.5]));
    for (const [p, k, v, d] of seq) I.play(p, v, t0 + k * b, d * b);
    me.timer = setTimeout(() => { if (this.prevInst === me) this.stopPreview(); }, 5200);
  },
};

// ---------- Audio estirado al tempo sin cambiar el tono (como el warp "Complex" de Ableton) ----------
const stretchCache = new Map(); // 'buf|bpm' -> AudioBuffer | 'pending'
export function stretched(c, bpm = app.state.bpm) {
  if (!c.warp || !c.keep || Math.abs(bpm - c.bpm) < 0.01) return null;
  const key = c.buf + '|' + bpm.toFixed(2);
  const v = stretchCache.get(key);
  if (v && v !== 'pending') return v;
  if (!v) {
    const src = getBuffer(c.buf);
    if (!src) return null;
    stretchCache.set(key, 'pending');
    // se agrega un poco de silencio al final: el estirador trata el audio como circular
    const pad = A.ctx.createBuffer(src.numberOfChannels, src.length + 8192, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) pad.copyToChannel(src.getChannelData(ch), ch);
    stretchBuffer(pad, bpm / c.bpm).then(b => {
      stretchCache.set(key, b);
      if (stretchCache.size > 40) stretchCache.delete(stretchCache.keys().next().value);
    });
  }
  return null;
}
// Prepara las versiones estiradas apenas cambia el tempo (así al dar play ya están)
export function prepareStretch() {
  for (const t of S().tracks) for (const c of t.clips) if (c.kind === 'audio') stretched(c);
}

// Al poner un clip, lo que queda debajo se recorta (como en Ableton)
export function removeOverlaps(t, c) {
  const a = c.start, b = c.start + c.len, out = [];
  for (const o of t.clips) {
    if (o === c) { out.push(o); continue; }
    const oa = o.start, ob = o.start + o.len;
    if (ob <= a + 1e-6 || oa >= b - 1e-6) { out.push(o); continue; }
    if (oa < a - 1e-6) { // queda la parte de la izquierda
      const left = { ...clone(o), len: a - oa };
      if (o.kind === 'midi') left.loop = Math.min(loopEnd(o), loopStart(o) + left.len);
      out.push(left);
    }
    if (ob > b + 1e-6) { // y la de la derecha
      const right = splitRight(o, b);
      out.push(right);
    }
  }
  t.clips = out;
}

// Parte derecha de un clip desde el tiempo x (absoluto)
export function splitRight(o, x) {
  const r = clone(o);
  r.id = uid('c');
  const cut = x - o.start;
  r.start = x; r.len = o.len - cut;
  if (o.kind === 'audio') r.off = o.off + cut * (o.warp ? 60 / o.bpm : spb());
  else {
    // Las notas se "despliegan" y se vuelven a armar desde el corte
    const notes = clipNotes(o, x, o.start + o.len).map(n => ({ p: n.p, s: n.s - x, d: n.d, v: n.v }));
    r.notes = notes; r.loop = r.len; r.ls = 0;
  }
  return r;
}
