// Mixer a pantalla completa: un fader con vúmetro por canal (8 pistas, synth, 8 loops,
// retornos de reverb y delay, master). Los vúmetros solo miden mientras el mixer está abierto.
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { TRACK_COLORS, SYNTH_COLOR, LOOP_COLORS } from '../state.js';
import { h } from './util.js';
import { knob } from './knob.js';
import { applyTrack, applySynth, applyMix, trackName, faderGain } from '../actions.js';
import { input } from '../input.js';

const db = g => (g <= 0.0001 ? '-∞' : (20 * Math.log10(g) >= 0 ? '+' : '') + (20 * Math.log10(g)).toFixed(1));
const ICON = { play: '▶', stop: '■' };

// Canales: valor 0..1 del fader, cómo se aplica y dónde se mide
function channels() {
  const s = app.state;
  const list = [];
  s.tracks.forEach((t, i) => list.push({
    group: 'Pistas', name: () => trackName(i), color: TRACK_COLORS[i], learn: `p:${i}:vol`,
    get: () => t.params.vol, def: 0.8, gain: v => v * v * 1.3, unity: Math.sqrt(1 / 1.3),
    set: v => { t.params.vol = v; applyTrack(i); app.emit('param', i, 'vol'); },
    node: () => app.tracks[i].tap,
    pan: { get: () => t.params.pan, set: v => { t.params.pan = v; applyTrack(i); app.emit('param', i, 'pan'); }, learn: `p:${i}:pan` },
    mute: { get: () => t.mute, toggle: () => { t.mute = !t.mute; applyMix(); app.emit('tracks'); } },
    solo: { get: () => t.solo, toggle: () => { t.solo = !t.solo; applyMix(); app.emit('tracks'); } },
  }));
  list.push({
    group: 'Synth', name: () => 'Synth', color: SYNTH_COLOR, learn: 'p:synthLevel',
    get: () => s.synth.mixLevel ?? 0.8, def: 0.8, gain: faderGain, unity: 0.8,
    set: v => { s.synth.mixLevel = v; applySynth(); },
    node: () => app.synth.tap,
    mute: { get: () => s.synth.mute, toggle: () => { s.synth.mute = !s.synth.mute; applyMix(); app.emit('tracks'); } },
    solo: { get: () => s.synth.solo, toggle: () => { s.synth.solo = !s.synth.solo; applyMix(); app.emit('tracks'); } },
  });
  app.loopers.forEach((lp, i) => list.push({
    group: 'Loops', name: () => `Loop ${i + 1}`, color: LOOP_COLORS[i], learn: `mix:loop:${i}`,
    get: () => lp.volume, def: 0.9, gain: v => v,
    set: v => { lp.setVolume(v); clearTimeout(lp._volSave); lp._volSave = setTimeout(() => app.emit('loop-saved', i), 600); },
    node: () => lp.out, empty: () => !lp.raw,
    mute: { get: () => lp.state === 'muted', toggle: () => { if (lp.raw) lp.setMuted(lp.state !== 'muted', true); } },
  }));
  list.push({
    group: 'Efectos', name: () => 'Reverb', color: '#a29bfe', learn: 'p:revLevel',
    get: () => s.revLevel, def: 0.8, gain: v => v,
    set: v => { s.revLevel = v; A.reverbReturn.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); A.liveRevRet?.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); },
    node: () => A.reverbReturn,
  });
  list.push({
    group: 'Efectos', name: () => 'Delay', color: '#48dbb4', learn: 'p:dlyLevel',
    get: () => s.dlyLevel ?? 0.75, def: 0.75, gain: v => v,
    set: v => { s.dlyLevel = v; A.delayReturn.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); },
    node: () => A.delayReturn,
  });
  list.push({
    group: 'Master', name: () => 'Master', color: '#7cf0b0', learn: 'p:master',
    get: () => s.master, def: 0.8, gain: v => v,
    set: v => { s.master = v; A.master.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); },
    node: () => A.analyser,
  });
  return list;
}

// Destinos asignables nuevos (los demás ya existen): se registran al arrancar
export function registerMixerTargets() {
  for (const ch of channels()) {
    if (input.targets.has(ch.learn)) continue;
    input.target(ch.learn, { label: `Mixer · ${ch.name()}`, kind: 'value', get: ch.get, set: v => ch.set(v) });
  }
}

export function openMixer() {
  const chans = channels();
  const meters = [];
  const sheet = h('div', { class: 'sheet' });
  const playBtn = h('button', { class: 'round play', onclick: () => app.seq.toggle() }, ICON.play);
  const strips = h('div', { class: 'mx-strips' });
  const close = () => {
    sheet.remove();
    cancelAnimationFrame(raf);
    for (const m of meters) { try { m.src.disconnect(m.an); } catch (e) { /* */ } m.an.disconnect(); }
  };
  sheet.addEventListener('pointerdown', e => { if (e.target === sheet) close(); });
  sheet.append(h('div', { class: 'sheet-card mixer' },
    h('div', { class: 'sheet-head' }, h('b', {}, '🎚️ Mixer'), playBtn,
      h('span', { class: 'hint' }, 'Arrastrá los faders · doble toque = valor inicial · se pueden asignar a un controlador con 🎯'),
      h('div', { style: { flex: 1 } }), h('button', { class: 'round', onclick: close }, '✕')),
    strips));
  document.body.append(sheet);

  let lastGroup = null;
  const ui = chans.map(ch => {
    if (ch.group !== lastGroup) {
      strips.append(h('div', { class: 'mx-group' }, ch.group));
      lastGroup = ch.group;
    }
    // Vúmetro: un analizador por canal, conectado solo mientras el mixer está abierto
    const an = A.ctx.createAnalyser(); an.fftSize = 512;
    const src = ch.node();
    src.connect(an); an.connect(A.silent);
    const buf = new Float32Array(an.fftSize);
    const m = { an, src, buf, level: 0, peak: 0, peakT: 0 };
    meters.push(m);

    const fill = h('i', { class: 'mx-fill' });
    const thumb = h('i', { class: 'mx-thumb' });
    const unity = h('i', { class: 'mx-unity' });
    unity.style.bottom = ((ch.unity ?? 1) * 100).toFixed(1) + '%';
    const fader = h('div', { class: 'mx-fader' }, h('i', { class: 'mx-rail' }), fill, unity, thumb);
    fader.dataset.learn = ch.learn;
    const mFill = h('i', { class: 'mx-mfill' }), mPeak = h('i', { class: 'mx-mpeak' });
    const meter = h('div', { class: 'mx-meter' }, mFill, mPeak);
    const val = h('div', { class: 'mx-val' });
    const name = h('div', { class: 'mx-name' });
    const btns = h('div', { class: 'mx-btns' });
    let muteB, soloB;
    if (ch.mute) { muteB = h('button', { class: 'ms m' }, 'M'); muteB.addEventListener('click', ch.mute.toggle); btns.append(muteB); }
    if (ch.solo) { soloB = h('button', { class: 'ms s' }, 'S'); soloB.addEventListener('click', ch.solo.toggle); btns.append(soloB); }
    const top = ch.pan
      ? knob({ label: 'Pan', min: -1, max: 1, value: ch.pan.get(), def: 0, bipolar: true, size: 36, color: ch.color, learn: ch.pan.learn,
        fmt: v => v < -0.02 ? 'L' + Math.round(-v * 100) : v > 0.02 ? 'R' + Math.round(v * 100) : 'C', onInput: ch.pan.set })
      : null;
    const strip = h('div', { class: 'mx-strip' }, h('div', { class: 'mx-top' }, top ? top.el : h('div', { class: 'mx-dot' })),
      h('div', { class: 'mx-body' }, fader, meter), val, btns, name);
    strip.style.setProperty('--c', ch.color);
    strips.append(strip);

    // Arrastre vertical relativo (no salta al tocar)
    let drag = null, lastTap = 0;
    fader.addEventListener('pointerdown', e => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastTap < 300) { ch.set(ch.def); lastTap = 0; return; }
      lastTap = now;
      try { fader.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
      drag = { y: e.clientY, v: ch.get(), h: fader.getBoundingClientRect().height };
      strip.classList.add('drag');
    });
    fader.addEventListener('pointermove', e => {
      if (!drag) return;
      const fine = e.shiftKey ? 0.25 : 1;
      ch.set(Math.max(0, Math.min(1, drag.v + (drag.y - e.clientY) / drag.h * fine)));
    });
    const up = () => { drag = null; strip.classList.remove('drag'); };
    fader.addEventListener('pointerup', up);
    fader.addEventListener('pointercancel', up);
    fader.addEventListener('wheel', e => { e.preventDefault(); ch.set(Math.max(0, Math.min(1, ch.get() - Math.sign(e.deltaY) * 0.02))); }, { passive: false });

    return { ch, m, fill, thumb, unity, mFill, mPeak, val, name, strip, muteB, soloB, top };
  });
  input.markMapped();

  // Dibujo: faders siguen el estado (también si se movió una perilla o un controlador)
  let raf = 0;
  const frame = () => {
    const now = performance.now();
    playBtn.textContent = app.seq.playing ? ICON.stop : ICON.play;
    playBtn.classList.toggle('on', app.seq.playing);
    for (const u of ui) {
      const v = u.ch.get();
      const pos = (v * 100).toFixed(1) + '%';
      u.fill.style.height = pos;
      u.thumb.style.bottom = pos;
      u.val.textContent = db(u.ch.gain(v));
      u.name.textContent = u.ch.name();
      if (u.muteB) u.muteB.classList.toggle('on', u.ch.mute.get());
      if (u.soloB) u.soloB.classList.toggle('on', u.ch.solo.get());
      u.strip.classList.toggle('empty', !!(u.ch.empty && u.ch.empty()));
      u.strip.classList.toggle('muted', !!(u.ch.mute && u.ch.mute.get()));
      if (u.top && u.ch.pan && !u.strip.matches(':active')) u.top.set(u.ch.pan.get());
      // Vúmetro en dB (-60..+6), con caída suave y pico retenido 1 s
      const m = u.m;
      m.an.getFloatTimeDomainData(m.buf);
      let pk = 0;
      for (let k = 0; k < m.buf.length; k++) { const a = Math.abs(m.buf[k]); if (a > pk) pk = a; }
      m.level = Math.max(pk, m.level * 0.88);
      if (pk >= m.peak || now - m.peakT > 1000) { m.peak = pk; m.peakT = now; }
      const toPct = x => Math.max(0, Math.min(1, (20 * Math.log10(x + 1e-6) + 60) / 66));
      u.mFill.style.transform = `scaleY(${toPct(m.level).toFixed(3)})`;
      u.mPeak.style.bottom = (toPct(m.peak) * 100).toFixed(1) + '%';
      u.mPeak.classList.toggle('hot', m.peak > 0.89);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}
