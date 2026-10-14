// Looper. Estados: empty → armed → recording → playing ⇄ muted
// "raw" es la grabación original (nunca se modifica en el lugar); "buffer" es la región
// recortada y con fades que suena. Así recortar y deshacer no destruyen nada.
import { A, capture, getMic, sliceBuffer } from './engine.js';
import { app } from '../app.js';
import { undo } from '../undo.js';
import { setBpm } from '../actions.js';

export class Looper {
  constructor(i) {
    this.i = i;
    this.state = 'empty';
    this.bars = 2;
    this.source = 'mic';     // 'mic' | 'groove'
    this.volume = 0.9;
    this.raw = null;         // grabación completa
    this.region = [0, 0];    // segundos dentro de raw
    this.fadeIn = 0; this.fadeOut = 0; // segundos
    this.free = false;
    this.buffer = null;      // lo que suena
    this.recBpm = 120;
    this.origin = 0;
    this.src = null;
    this.job = null;
    this.peaks = null;
    this.overdubbing = false;
    this.out = A.ctx.createGain();
    this.out.gain.value = this.volume;
    this.out.connect(A.loopBus);
  }

  get rate() { return app.state.bpm / this.recBpm; }
  get period() { return this.buffer ? this.buffer.duration / this.rate : this.bars * 16 * app.seq.stepDur; }
  get hasAudio() { return !!this.raw; }

  async sourceNode() { return this.source === 'mic' ? getMic() : A.mixBus; }
  latency() { return this.source === 'mic' ? (app.state.settings.micLatency || 0) / 1000 : 0; }

  // ---------- Grabación ----------
  tap() {
    switch (this.state) {
      case 'empty': app.state.loopFree ? this.startFree() : this.arm(); break;
      case 'armed': this.cancel(); break;
      case 'recording': this.free ? this.stopFree() : this.cancel(); break;
      case 'playing': this.setMuted(true, true); break;
      case 'muted': this.setMuted(false, true); break;
    }
  }

  // Al compás: arranca en el próximo compás y dura N compases
  async arm() {
    let node;
    try { node = await this.sourceNode(); } catch (e) { app.emit('toast', '🎤 No pude acceder a la entrada de audio'); return; }
    const seq = app.seq;
    if (!seq.playing) seq.start();
    const t0 = seq.nextBarTime();
    const len = this.bars * 16 * seq.stepDur;
    this.free = false;
    this.recStart = t0; this.recLen = len;
    this.recBpm = app.state.bpm;
    this.state = 'armed';
    const job = this.job = capture(node, t0 + this.latency(), len);
    app.emit('loops');
    const buf = await job.promise;
    if (this.job !== job) return;
    this.job = null;
    if (buf.length < len * A.ctx.sampleRate * 0.9) { this.state = 'empty'; app.emit('loops'); return; }
    this.setRecorded(buf, t0);
  }

  // Libre: empieza al tocar y termina al volver a tocar
  async startFree() {
    let node;
    try { node = await this.sourceNode(); } catch (e) { app.emit('toast', '🎤 No pude acceder a la entrada de audio'); return; }
    const t0 = A.ctx.currentTime + 0.02;
    this.free = true;
    this.recStart = t0; this.recLen = 0;
    this.state = 'recording';
    const job = this.job = capture(node, t0 + this.latency(), 180);
    app.emit('loops');
    const buf = await job.promise;
    if (this.job !== job) return;
    this.job = null;
    if (buf.duration < 0.15) { this.state = 'empty'; app.emit('toast', 'Loop muy corto'); app.emit('loops'); return; }
    this.setRecorded(buf, t0);
  }

  stopFree() {
    if (!this.job) return;
    const tEnd = A.ctx.currentTime + 0.02;
    const L = tEnd - this.recStart;
    if (L < 0.15) { this.cancel(); return; }
    const seq = app.seq;
    // El primer loop libre define el tempo si no suena nada más
    const alone = !app.loopers.some(l => l !== this && l.hasAudio) && !seq.playing;
    if (alone) {
      let best = null;
      for (const n of [1, 2, 4, 8, 16]) {
        const bpm = n * 240 / L;
        if (bpm >= 40 && bpm <= 220 && (!best || Math.abs(bpm - 118) < Math.abs(best.bpm - 118))) best = { n, bpm };
      }
      if (best) {
        setBpm(best.bpm, true);
        this.bars = best.n;
        seq.start(tEnd);
        app.emit('toast', `⏱ Tempo del loop: ${best.bpm.toFixed(1)} BPM`);
      }
    } else if (!seq.playing) seq.start(tEnd);
    this.recBpm = app.state.bpm;
    this.recLen = L;
    this.job.stopAt(tEnd + this.latency());
  }

  setRecorded(buf, origin) {
    const prev = this.snapshot();
    this.raw = buf;
    this.region = [0, buf.duration];
    this.fadeIn = 0.003; this.fadeOut = 0.003;
    this.origin = origin;
    this.state = 'playing';
    app.state.patterns.forEach(p => { p.loops[this.i] = true; });
    this.render();
    if (app.seq.playing) this.play();
    this.pushUndo('Grabar loop', prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
  }

  // Carga un loop del banco. Se ajusta a la cantidad entera de compases más cercana
  // (con varispeed), así queda siempre en tiempo con la batería.
  loadBuffer(buf, bpm) {
    const prev = this.snapshot();
    this.cancel();
    this.stopSrc();
    const tempo = bpm || app.state.bpm;
    this.bars = Math.max(1, Math.round(buf.duration * tempo / 240));
    this.recBpm = this.bars * 240 / buf.duration;
    this.raw = buf;
    this.region = [0, buf.duration];
    this.fadeIn = 0.003; this.fadeOut = 0.003;
    this.free = false;
    this.state = 'playing';
    app.state.patterns.forEach(p => { p.loops[this.i] = true; });
    this.render();
    if (app.seq.playing) { this.origin = app.seq.nextBarTime(); this.play(); }
    this.out.gain.setTargetAtTime(this.volume, A.ctx.currentTime, 0.01);
    this.pushUndo('Cargar loop', prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
  }

  // Construye el buffer que suena: región + fades
  render() {
    if (!this.raw) { this.buffer = null; this.peaks = null; return; }
    const sr = this.raw.sampleRate;
    const b = sliceBuffer(this.raw, this.region[0] * sr, this.region[1] * sr);
    const fi = Math.min(b.length / 2, Math.floor(this.fadeIn * sr)), fo = Math.min(b.length / 2, Math.floor(this.fadeOut * sr));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let k = 0; k < fi; k++) d[k] *= k / fi;
      for (let k = 0; k < fo; k++) d[d.length - 1 - k] *= k / fo;
    }
    this.buffer = b;
    this.computePeaks();
  }

  play() {
    this.stopSrc();
    if (!this.buffer) return;
    const ctx = A.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = true;
    src.playbackRate.value = this.rate;
    const now = ctx.currentTime + 0.01;
    const when = Math.max(now, this.origin);
    const phase = (((when - this.origin) / this.period) % 1 + 1) % 1;
    src.connect(this.out);
    src.start(when, phase * this.buffer.duration);
    this.src = src;
    this.out.gain.setTargetAtTime(this.state === 'muted' ? 0 : this.volume, now, 0.01);
  }

  stopSrc() {
    if (this.src) { try { this.src.stop(); } catch (e) { /* */ } this.src.disconnect(); this.src = null; }
  }

  // ---------- Mute / scenes ----------
  setMuted(m, fromUser = false, time = A.ctx.currentTime) {
    if (!this.raw) return;
    this.state = m ? 'muted' : 'playing';
    this.out.gain.setTargetAtTime(m ? 0 : this.volume, time, 0.012);
    if (fromUser) app.pattern.loops[this.i] = !m; // la scene actual recuerda el estado
    app.emit('loops');
  }

  // Al cambiar de patrón: sigue lo que guardó esa scene, justo en el compás
  applyScene(on, time) {
    if (!this.raw || this.state === 'armed' || this.state === 'recording') return;
    const m = !on;
    if ((this.state === 'muted') === m) return;
    this.state = m ? 'muted' : 'playing';
    this.out.gain.setTargetAtTime(m ? 0 : this.volume, time, 0.008);
    const ms = Math.max(0, (time - A.ctx.currentTime) * 1000);
    setTimeout(() => app.emit('loops'), ms);
  }

  setVolume(v) {
    this.volume = v;
    if (this.state === 'playing') this.out.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02);
  }

  cancel() {
    if (this.job) { const j = this.job; this.job = null; j.stop(); }
    this.state = this.raw ? (this.state === 'muted' ? 'muted' : 'playing') : 'empty';
    this.overdubbing = false;
    app.emit('loops');
  }

  clear() {
    if (!this.raw) { this.cancel(); return; }
    const prev = this.snapshot();
    this.cancel();
    this.stopSrc();
    this.raw = null; this.buffer = null; this.peaks = null; this.state = 'empty';
    this.pushUndo('Borrar loop', prev);
    app.emit('loops'); app.emit('loop-cleared', this.i);
  }

  // ---------- Overdub ----------
  async overdub() {
    if (!this.raw || this.overdubbing || !app.seq.playing) return;
    let node;
    try { node = await this.sourceNode(); } catch (e) { app.emit('toast', '🎤 No pude acceder a la entrada de audio'); return; }
    const per = this.period, now = A.ctx.currentTime;
    const k = Math.ceil((now + 0.03 - this.origin) / per);
    const t0 = this.origin + k * per;
    this.overdubbing = true; this.odStart = t0;
    app.emit('loops');
    const job = this.job = capture(node, t0 + this.latency(), per);
    const add = await job.promise;
    if (this.job !== job) return;
    this.job = null; this.overdubbing = false;
    const prev = this.snapshot();
    // Se suma dentro de la región de la grabación original (raw nuevo, el viejo queda para deshacer)
    const r = this.raw, sr = r.sampleRate, a = Math.floor(this.region[0] * sr), regLen = Math.floor((this.region[1] - this.region[0]) * sr);
    const out = A.ctx.createBuffer(2, r.length, sr);
    const ratio = add.length / Math.max(1, regLen);
    for (let c = 0; c < 2; c++) {
      const s = r.getChannelData(Math.min(c, r.numberOfChannels - 1)), ad = add.getChannelData(c), o = out.getChannelData(c);
      o.set(s);
      for (let i = 0; i < regLen; i++) {
        const x = i * ratio, xi = Math.floor(x), fr = x - xi;
        o[a + i] += (ad[xi] || 0) * (1 - fr) + (ad[xi + 1] || 0) * fr;
      }
    }
    this.raw = out;
    this.render();
    if (app.seq.playing) this.play();
    this.pushUndo('Overdub', prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
  }

  // ---------- Edición ----------
  setEdit({ region, fadeIn, fadeOut }) {
    if (region) this.region = [Math.max(0, region[0]), Math.min(this.raw.duration, region[1])];
    if (fadeIn != null) this.fadeIn = fadeIn;
    if (fadeOut != null) this.fadeOut = fadeOut;
    this.render();
    if (this.src) this.play();
    app.emit('loops'); app.emit('loop-saved', this.i);
  }

  // ---------- Deshacer ----------
  snapshot() {
    return {
      raw: this.raw, region: [...this.region], fadeIn: this.fadeIn, fadeOut: this.fadeOut,
      bars: this.bars, recBpm: this.recBpm, free: this.free, origin: this.origin,
      state: this.state === 'armed' || this.state === 'recording' ? (this.raw ? 'playing' : 'empty') : this.state,
    };
  }
  restore(s) {
    this.cancel();
    Object.assign(this, { raw: s.raw, region: [...s.region], fadeIn: s.fadeIn, fadeOut: s.fadeOut, bars: s.bars, recBpm: s.recBpm, free: s.free, origin: s.origin, state: s.state });
    this.render();
    this.stopSrc();
    if (this.raw && app.seq.playing) this.play();
    this.out.gain.setTargetAtTime(this.state === 'playing' ? this.volume : 0, A.ctx.currentTime, 0.01);
    app.emit('loops');
    if (this.raw) app.emit('loop-saved', this.i); else app.emit('loop-cleared', this.i);
  }
  pushUndo(label, before) {
    let after = null;
    undo.push({
      label: `${label} ${this.i + 1}`,
      undo: () => { after = this.snapshot(); this.restore(before); },
      redo: () => this.restore(after),
    });
  }

  // ---------- Transporte ----------
  onTransportStart(t) {
    if (this.buffer) {
      this.origin = t;
      if (this.state !== 'armed' && this.state !== 'recording') {
        const on = app.pattern.loops[this.i];
        this.state = on ? 'playing' : 'muted';
      }
      this.play();
      app.emit('loops');
    }
  }
  onTransportStop() {
    this.stopSrc();
    if (this.job) this.cancel();
  }
  // Al cambiar el tempo se conserva la fase y el loop cambia de velocidad (varispeed)
  onTempo(oldBpm) {
    if (!this.buffer) return;
    const now = A.ctx.currentTime;
    const oldPer = this.buffer.duration / (oldBpm / this.recBpm);
    const ph = (((now - this.origin) / oldPer) % 1 + 1) % 1;
    this.origin = now - ph * this.period;
    if (this.src) this.src.playbackRate.setValueAtTime(this.rate, now);
  }

  computePeaks(n = 180) {
    const d = this.buffer.getChannelData(0), step = Math.max(1, Math.floor(d.length / n));
    const pk = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step; j < Math.min(d.length, (i + 1) * step); j += 4) m = Math.max(m, Math.abs(d[j]));
      pk[i] = m; max = Math.max(max, m);
    }
    if (max > 0) for (let i = 0; i < n; i++) pk[i] /= max;
    this.peaks = pk;
  }

  phase() {
    if (!this.buffer || !this.src) return null;
    const t = A.ctx.currentTime - A.outLat;
    return (((t - this.origin) / this.period) % 1 + 1) % 1;
  }
}
