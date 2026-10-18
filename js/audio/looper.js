// Looper. Estados: empty → armed → recording → playing ⇄ muted
// "raw" es la grabación original (nunca se modifica en el lugar); "buffer" es la región
// recortada y con fades que suena. Así recortar y deshacer no destruyen nada.
import { A, capture, getMic, sliceBuffer, liveSource, holdParam, heardTime } from './engine.js';
import { stretchBuffer } from './stretch.js';
import { buildLoop, liveLog, isOn, isNote, soundSnapshot, renderNotes, collectNotes, audioOnsets, isPercussive, measureClicks, globalOffset } from './loopbuild.js';
import { quantize, GRIDS } from '../quant.js';
import { app } from '../app.js';
import { undo } from '../undo.js';
import { setBpm } from '../actions.js';

// Tempo para un loop de largo L: la cantidad de compases que da el BPM más "normal"
function bestTempo(L) {
  let best = null;
  for (const n of [1, 2, 4, 8, 16]) {
    const bpm = n * 240 / L;
    if (bpm >= 40 && bpm <= 220 && (!best || Math.abs(bpm - 118) < Math.abs(best.bpm - 118))) best = { n, bpm };
  }
  return best;
}
// Hora del último toque, si es de recién (si no, "ahora")
const freshTs = () => { const ts = app.lastInputTs; return ts && performance.now() - ts < 120 ? ts : undefined; };

export class Looper {
  constructor(i) {
    this.i = i;
    this.state = 'empty';
    this.bars = 2;
    this.source = 'keys';    // 'mic' | 'keys' | 'groove' (por defecto no abre el micrófono)
    this.volume = 0.9;
    this.keepPitch = true;   // al cambiar el BPM: time-stretch (mismo tono) o como cinta
    this.baseBuffer = null;  // región + fades a la velocidad original (recBpm)
    this.bufBpm = 120;       // tempo para el que está hecho el buffer que suena
    this._stretchSeq = 0;
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

  get rate() { return app.state.bpm / this.bufBpm; }
  get period() { return this.buffer ? this.buffer.duration / this.rate : this.bars * 16 * app.seq.stepDur; }
  get hasAudio() { return !!this.raw; }

  // 'mic' = entrada de audio · 'keys' = solo lo que tocás en vivo · 'groove' = todo lo que suena
  async sourceNode() {
    if (this.source === 'mic') return getMic();
    if (this.source === 'keys') return liveSource();
    return A.mixBus;
  }
  // Corrimiento para que lo grabado quede donde lo tocaste:
  // micrófono = latencia calibrada · lo que toco = latencia de salida (tocás sobre lo que oís)
  latency() {
    if (this.source === 'mic') return (app.state.settings.micLatency || 0) / 1000;
    if (this.source === 'keys') return A.outLat;
    return 0;
  }

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
    // Con el transporte parado: cuenta regresiva y la grabación arranca en el compás 1
    if (!seq.playing) seq.startCounted();
    const t0 = seq.nextBarTime();
    const len = this.bars * 16 * seq.stepDur;
    this.free = false;
    this.recStart = t0; this.recLen = len;
    this.recBpm = app.state.bpm;
    this.state = 'armed';
    const lat = this.latency();
    if (this.source === 'mic') return this.armMic(node, t0, len);
    if (this.source !== 'keys') {
      const job = this.job = capture(node, t0 + lat, len);
      app.emit('loops');
      const buf = await job.promise;
      if (this.job !== job) return;
      this.job = null;
      if (buf.length < len * A.ctx.sampleRate * 0.9) { this.state = 'empty'; app.emit('loops'); return; }
      this.setRecorded(buf, t0);
      return;
    }
    // Solo lo que tocás: graba un poco antes y después del loop para no perder el golpe
    // del "1" tocado apenas antes, ni las colas; después lo acomoda en la grilla.
    const step = seq.stepDur, pre = Math.min(0.5, 2.5 * step), post = Math.min(0.5, 4 * step);
    const capStart = t0 + lat - pre;
    const job = this.job = capture(node, capStart, pre + len + post);
    app.emit('loops');
    // La primera vuelta tiene que sonar justo al terminar de grabar: se arma una versión
    // provisoria un instante antes del final y después se cambia por la definitiva.
    this.peekPlay(job, t0 + len - 0.15, cap => this.keysBuild(cap, { start: t0, len, capStart }).buf);
    const cap = await job.promise;
    if (this.job !== job) return;
    this.job = null;
    if (cap.length < (pre + len) * A.ctx.sampleRate * 0.9) { this.stopSrc(); this.state = 'empty'; app.emit('loops'); return; }
    this.finishKeys(cap, { start: t0, len, capStart });
  }

  // Un instante antes de terminar la grabación arma una versión provisoria con lo grabado
  // hasta ahí, para que la primera vuelta suene a tiempo (después llega la definitiva).
  peekPlay(job, at, build) {
    setTimeout(async () => {
      if (this.job !== job) return;
      const cap = await job.peek();
      if (this.job !== job || cap.length < 0.2 * A.ctx.sampleRate) return;
      this.buffer = build(cap); this.bufBpm = this.recBpm; this.origin = this.recStart;
      this.play();
    }, Math.max(0, (at - A.ctx.currentTime) * 1000));
  }

  // ---------- Micrófono al compás ----------
  // Graba con margen antes y después; la demora real del micrófono se mide con los clicks de
  // la cuenta regresiva (si hubo) y recién al final se decide dónde empieza el loop.
  // Si lo grabado son golpes (percusión) y la Q está prendida, cada golpe va a la grilla.
  async armMic(node, t0, len) {
    const seq = app.seq, st = app.state.settings;
    const ci = seq.countIn && Math.abs(seq.countIn.t0 - t0) < 0.01 ? seq.countIn : null;
    const measuring = ci ? capture(node, ci.t, ci.n * ci.beat + 0.05).promise.then(b => measureClicks(b, ci)) : null;
    if (!ci && !st.micMeasured) app.emit('toast', '🎤 Tip: grabá con todo parado la primera vez; la cuenta regresiva mide la demora del micrófono');
    const pre = 0.3, MAXLAT = 0.6;
    const capStart = t0 - pre;
    const job = this.job = capture(node, capStart, pre + len + MAXLAT + 0.3);
    app.emit('loops');
    const slice = (cap, lat) => sliceBuffer(cap, (t0 + lat - capStart) * cap.sampleRate, (t0 + lat - capStart + len) * cap.sampleRate);
    this.peekPlay(job, t0 + len - 0.05, cap => slice(cap, (st.micLatency || 0) / 1000));
    const cap = await job.promise;
    if (this.job !== job) return;
    this.job = null;
    let lat = (st.micLatency || 0) / 1000;
    const measured = measuring ? await measuring.catch(() => null) : null;
    if (measured != null) {
      const ms = Math.round(measured * 1000);
      if (!st.micMeasured || Math.abs(ms - st.micLatency) > 8) app.emit('toast', `🎯 Demora del micrófono medida: ${ms} ms`);
      st.micLatency = ms; st.micMeasured = true;
      lat = measured;
    }
    if (cap.length < (t0 + lat - capStart + len) * cap.sampleRate * 0.98) { this.stopSrc(); this.state = 'empty'; app.emit('loops'); return; }
    const q = app.state.recQuant;
    let buf = null;
    if (q.on) {
      const startAt = t0 + lat - capStart;      // dónde empieza el loop dentro de lo grabado
      const step = seq.stepDur, edge = ((GRIDS[q.grid] || 1) * step) / 2;
      const ons = audioOnsets(cap).map(x => x - startAt).filter(x => x > -pre + 0.01);
      const inLoop = ons.filter(x => x >= -edge && x < len + edge);
      if (inLoop.length >= 2 && isPercussive(cap, ons.map(x => x + startAt))) {
        // Primero se saca el corrimiento general (si todos quedaron un poco corridos igual)
        const off = globalOffset(inLoop, step);
        const place = x => quantize(x / step, q, app.state.swing).swung * step;
        buf = buildLoop(cap, { pre: startAt, len, hits: ons.map(at => ({ at, want: at - off })), place, edge: Math.min(edge, startAt), tail: 0.25, lead: 0.012 });
      }
    }
    this.setRecorded(buf || slice(cap, lat), t0);
  }

  // ---------- "Lo que tocás" (🎹) ----------
  // Arma el loop: los golpes se corren a su lugar cortando el audio; si hay notas (synth,
  // sampler en notas) esta versión no las mueve y después se re-tocan en su lugar exacto.
  keysBuild(cap, { start, len, capStart }) {
    const lat = this.latency(), step = app.seq.stepDur, q = app.state.recQuant;
    const arp = app.state.synth.arp.on;
    const evs = liveLog.filter(e => e.t > capStart - 3 && e.t < capStart + cap.duration + 0.5);
    const place = q.on && !arp ? x => quantize(x / step, q, app.state.swing).swung * step : null;
    const pre = start + lat - capStart;
    const edge = Math.min(Math.max(0, pre), ((place ? GRIDS[q.grid] || 1 : 1) * step) / 2);
    const hasNotes = !arp && evs.some(e => isNote(e) && e.h - start >= -edge && e.h - start < len + edge);
    const hits = evs.filter(isOn).map(e => {
      const at = e.t - (start + lat);
      return { at, want: hasNotes ? at : e.h - start };
    });
    const buf = buildLoop(cap, { pre, len, hits, place: hasNotes ? null : place, edge });
    return { buf, hasNotes, evs, place, edge };
  }

  finishKeys(cap, { start, len, capStart }) {
    const r = this.keysBuild(cap, { start, len, capStart });
    this.setRecorded(r.buf, start);
    if (r.hasNotes) this.rerender(r, start, len, capStart + cap.duration);
  }

  // Re-toca las notas en su lugar con el sonido que tenían al grabar y reemplaza el audio
  async rerender({ evs, place, edge }, start, len, capEnd) {
    const notes = collectNotes(evs, { start, len, place, edge, capEnd });
    if (!notes.length) return;
    const snap = soundSnapshot();
    const rawRef = this.raw;
    app.emit('toast', place ? '🎹 Acomodando las notas al tiempo…' : '🎹 Acomodando las notas…');
    const buf = await renderNotes(notes, { len, snap });
    if (this.raw !== rawRef) return;   // se borró o se editó mientras tanto
    this.raw = buf;
    this.region = [0, buf.duration];
    this.render();
    if (this.src) this.play();
    app.emit('loops'); app.emit('loop-saved', this.i);
    app.emit('toast', '🎹 Listo: las notas quedaron en su lugar');
  }

  // Libre: empieza al tocar y termina al volver a tocar
  async startFree() {
    let node;
    try { node = await this.sourceNode(); } catch (e) { app.emit('toast', '🎤 No pude acceder a la entrada de audio'); return; }
    const t0 = A.ctx.currentTime + 0.02;
    this.free = true;
    this.recStart = t0; this.recLen = 0;
    this.state = 'recording';
    // Con 🎹 también graba un poco antes (para lo tocado junto con el toque de empezar) y
    // marca el inicio en "tiempo de la música": lo que se escuchaba al tocar.
    const keys = this.source === 'keys', lat = this.latency();
    const pre = keys ? 0.3 + lat : 0;
    const capStart = t0 + lat - pre;
    this.freePost = keys ? 0.3 : 0;
    if (keys) { this.recStartH = heardTime(freshTs()); this.freeCapStart = capStart; }
    const job = this.job = capture(node, capStart, 180);
    app.emit('loops');
    const buf = await job.promise;
    if (this.job !== job) return;
    this.job = null;
    if (buf.duration < 0.15 + pre) { this.state = 'empty'; app.emit('toast', 'Loop muy corto'); app.emit('loops'); return; }
    if (keys && this.recLen > 0) this.finishKeys(buf, { start: this.recStart, len: this.recLen, capStart });
    else this.setRecorded(buf, t0);
  }

  stopFree() {
    if (!this.job) return;
    const now = A.ctx.currentTime, tEnd = now + 0.02;
    const seq = app.seq, lat = this.latency();
    // El primer loop libre define el tempo si no suena nada más
    const alone = !app.loopers.some(l => l !== this && l.hasAudio) && !seq.playing;
    if (this.source === 'keys') return this.stopFreeKeys(alone, now, lat);
    const L = tEnd - this.recStart;
    if (L < 0.15) { this.cancel(); return; }
    if (alone) {
      const best = bestTempo(L);
      if (best) {
        setBpm(best.bpm, true);
        this.bars = best.n;
        seq.start(tEnd);
        app.emit('toast', `⏱ Tempo del loop: ${best.bpm.toFixed(1)} BPM`);
      }
      this.recBpm = app.state.bpm;
      this.recLen = L;
      this.job.stopAt(tEnd + lat);
      return;
    }
    // Ya hay tempo: el largo se ajusta a compases enteros para que el loop quede en tiempo
    const bar = 16 * seq.stepDur;
    const n = Math.max(1, Math.round(L / bar));
    const end = this.recStart + n * bar;
    this.bars = n;
    if (!seq.playing) seq.start(Math.max(now + 0.02, end));
    this.recBpm = app.state.bpm;
    this.recLen = n * bar;
    this.job.stopAt(end + lat);
    if (end > now + 0.05) app.emit('toast', `〰 Cerrando el loop en ${n} compás${n > 1 ? 'es' : ''}`);
  }

  // Libre con 🎹: todo medido en "tiempo de la música" (lo que se escuchaba en cada toque)
  stopFreeKeys(alone, now, lat) {
    const seq = app.seq;
    const endH = heardTime(freshTs());
    let start = this.recStartH ?? this.recStart;
    if (alone) {
      // Sin tempo todavía: el loop arranca en lo primero que tocaste (aunque haya sido un poco
      // después del toque de empezar) y termina en el toque de cerrar
      const first = liveLog.find(e => isOn(e) && e.h >= start - 0.15 && e.h <= start + 0.8);
      if (first) start = first.h;
      const L = endH - start;
      if (L < 0.15) { this.cancel(); return; }
      const best = bestTempo(L);
      this.recStart = start; this.recLen = L;
      if (best) {
        setBpm(best.bpm, true);
        this.bars = best.n;
        // La batería entra en el próximo compás del loop
        const barLen = L / best.n;
        seq.start(start + barLen * Math.ceil((now + 0.03 - start) / barLen));
        app.emit('toast', `⏱ Tempo del loop: ${best.bpm.toFixed(1)} BPM`);
      }
      this.recBpm = app.state.bpm;
      this.job.stopAt(start + L + lat + this.freePost);
      this.peekPlay(this.job, now, cap => this.keysBuild(cap, { start, len: L, capStart: this.freeCapStart }).buf);
      return;
    }
    // Ya hay tempo: el inicio se acomoda al tiempo más cercano y el largo a compases enteros
    const beat = 4 * seq.stepDur, bar = 4 * beat;
    if (seq.playing) start = seq.barTime + Math.round((start - seq.barTime) / beat) * beat;
    const n = Math.max(1, Math.round((endH - start) / bar));
    const end = start + n * bar;
    this.recStart = start; this.bars = n;
    this.recBpm = app.state.bpm;
    this.recLen = n * bar;
    if (!seq.playing) seq.start(Math.max(now + 0.02, end));
    this.job.stopAt(end + lat + this.freePost);
    this.peekPlay(this.job, end - 0.12, cap => this.keysBuild(cap, { start, len: n * bar, capStart: this.freeCapStart }).buf);
    if (end > now + 0.05) app.emit('toast', `〰 Cerrando el loop en ${n} compás${n > 1 ? 'es' : ''}`);
  }

  setRecorded(buf, origin) {
    const prev = this.snapshot();
    this.raw = buf;
    this.region = [0, buf.duration];
    this.fadeIn = 0.003; this.fadeOut = 0.003;
    this.origin = origin;
    this.state = 'playing';
    this.claimScene();
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
    this.claimScene();
    this.render();
    if (app.seq.playing) { this.origin = app.seq.nextBarTime(); this.play(); }
    this.out.gain.setTargetAtTime(this.volume, A.ctx.currentTime, 0.01);
    this.pushUndo('Cargar loop', prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
  }

  // Un loop nuevo suena solo en la escena donde se grabó (o en todas si las escenas no manejan loops)
  claimScene() {
    const st = app.state, all = st.loopScenes === false;
    st.patterns.forEach((p, k) => { p.loops[this.i] = all || k === st.current; });
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
    this.baseBuffer = b;
    this.buffer = b;
    this.bufBpm = this.recBpm;
    this.computePeaks();
    this.updateStretch(0);
  }

  // Si el tempo actual no es el de la grabación, prepara una versión estirada (sin cambiar
  // el tono) y la cambia sin cortes cuando está lista. Mientras tanto suena como cinta.
  updateStretch(delay = 300) {
    clearTimeout(this._stretchTimer);
    const base = this.baseBuffer;
    if (!base) return;
    const useBase = () => {
      if (this.buffer === base) return;
      this.buffer = base; this.bufBpm = this.recBpm;
      if (this.src) this.play();
    };
    const target = app.state.bpm;
    if (!this.keepPitch || Math.abs(target - this.recBpm) < 0.01) { useBase(); return; }
    const seq = ++this._stretchSeq;
    this._stretchTimer = setTimeout(async () => {
      const out = await stretchBuffer(base, target / this.recBpm);
      if (seq !== this._stretchSeq || this.baseBuffer !== base || app.state.bpm !== target) return;
      this.buffer = out; this.bufBpm = target;
      if (this.src) this.play();
      app.emit('loops');
    }, delay);
  }

  setKeepPitch(v) {
    this.keepPitch = v;
    if (!v) this._stretchSeq++;
    this.updateStretch(0);
    app.emit('loop-saved', this.i);
  }

  // Cada reproducción entra y sale con un fundido corto: cambiar de buffer (overdub, recorte)
  // o parar el transporte no hace "click".
  play() {
    const ctx = A.ctx;
    const now = ctx.currentTime + 0.01;
    const when = Math.max(now, this.origin);
    this.stopSrc(when);
    if (!this.buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = true;
    src.playbackRate.value = this.rate;
    const phase = (((when - this.origin) / this.period) % 1 + 1) % 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.008);
    src.connect(g).connect(this.out);
    src.start(when, phase * this.buffer.duration);
    this.src = src; this.srcGain = g;
    this.out.gain.setTargetAtTime(this.state === 'muted' ? 0 : this.volume, now, 0.01);
  }

  stopSrc(at = A.ctx.currentTime) {
    if (!this.src) return;
    const src = this.src, g = this.srcGain;
    this.src = null; this.srcGain = null;
    const t = Math.max(A.ctx.currentTime, at);
    if (g) {
      holdParam(g.gain, t);
      g.gain.linearRampToValueAtTime(0, t + 0.01);
    }
    try { src.stop(t + 0.015); } catch (e) { /* */ }
    setTimeout(() => { src.disconnect(); g && g.disconnect(); }, (t - A.ctx.currentTime) * 1000 + 100);
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
    if (app.state.loopScenes === false) return;
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
    if (!this.raw) { this.stopSrc(); this.buffer = null; }
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
    // Si estaba sonando estirado a otro tempo, esa versión pasa a ser la base (así la capa
    // nueva queda alineada y afinada con lo que se escuchaba)
    if (this.buffer && this.bufBpm !== this.recBpm) {
      this.raw = this.buffer; this.region = [0, this.buffer.duration]; this.recBpm = this.bufBpm;
    }
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

  // Reemplaza la grabación por una versión editada (cortar, pegar, silenciar…). Se puede deshacer.
  applyEdit(raw, region, label) {
    const prev = this.snapshot();
    this.raw = raw;
    this.region = [Math.max(0, region[0]), Math.min(raw.duration, Math.max(region[0] + 0.01, region[1]))];
    this.bars = Math.max(1, Math.round(this.regionBeats / 4));
    this.render();
    if (this.src) this.play();
    this.pushUndo(label, prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
  }
  get regionBeats() { return (this.region[1] - this.region[0]) * this.recBpm / 60; }

  // Si después de editar el loop no dura compases enteros, lo estira (o encoge) al más cercano
  // para que vuelva a quedar en tiempo con la batería. El tono se mantiene.
  squareToBars(n = Math.max(1, Math.round(this.regionBeats / 4))) {
    if (!this.raw) return 0;
    const prev = this.snapshot();
    const dur = this.region[1] - this.region[0];
    this.recBpm = n * 240 / dur;
    this.bars = n;
    this.render();
    if (this.src) this.play();
    this.pushUndo('Cuadrar', prev);
    app.emit('loops'); app.emit('loop-saved', this.i);
    return n;
  }

  // ---------- Deshacer ----------
  snapshot() {
    return {
      raw: this.raw, region: [...this.region], fadeIn: this.fadeIn, fadeOut: this.fadeOut,
      bars: this.bars, recBpm: this.recBpm, free: this.free, origin: this.origin, keepPitch: this.keepPitch,
      state: this.state === 'armed' || this.state === 'recording' ? (this.raw ? 'playing' : 'empty') : this.state,
    };
  }
  restore(s) {
    this.cancel();
    Object.assign(this, { raw: s.raw, region: [...s.region], fadeIn: s.fadeIn, fadeOut: s.fadeOut, bars: s.bars, recBpm: s.recBpm, free: s.free, origin: s.origin, state: s.state, keepPitch: s.keepPitch ?? true });
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
  // Al cambiar el tempo se conserva la fase. Al instante acompaña como cinta y, apenas está
  // lista, cambia a la versión estirada con el tono original (si «mantener tono» está activo).
  onTempo(oldBpm) {
    if (!this.buffer) return;
    const now = A.ctx.currentTime;
    const oldPer = this.buffer.duration / (oldBpm / this.bufBpm);
    const ph = (((now - this.origin) / oldPer) % 1 + 1) % 1;
    this.origin = now - ph * this.period;
    if (this.src) this.src.playbackRate.setValueAtTime(this.rate, now);
    this.updateStretch(300);
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
