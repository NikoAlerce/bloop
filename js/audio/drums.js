// Kits de batería sintetizados offline (sin archivos → funciona sin internet).
const SR = 44100;

function render(dur, build) {
  const oc = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
  build(oc, oc.destination);
  return oc.startRendering();
}
function noiseSrc(oc, dur) {
  const b = oc.createBuffer(1, Math.ceil(dur * SR), SR);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = oc.createBufferSource(); s.buffer = b; return s;
}
function filt(oc, type, f, q = 0.7) { const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function env(oc, peak, attack, decay, t = 0) {
  const g = oc.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}
function shaper(oc, amt) {
  const ws = oc.createWaveShaper(), n = 2048, c = new Float32Array(n), k = amt * 30 + 1;
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  ws.curve = c; return ws;
}

// ---------- Generadores ----------
const kick = ({ f0 = 160, f1 = 48, pd = 0.07, dec = 0.6, click = 0.4, drive = 0.2 } = {}) => render(dec + 0.1, (oc, out) => {
  const o = oc.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(f1, pd);
  const g = oc.createGain(); g.gain.setValueAtTime(1, 0); g.gain.setValueAtTime(1, dec * 0.15);
  g.gain.exponentialRampToValueAtTime(0.0005, dec);
  o.connect(g).connect(shaper(oc, drive)).connect(out); o.start(0); o.stop(dec + 0.05);
  if (click > 0) { const n = noiseSrc(oc, 0.03); n.connect(filt(oc, 'highpass', 2500)).connect(env(oc, click, 0.0008, 0.012)).connect(out); n.start(0); }
});

const snare = ({ tone = 185, tdec = 0.12, ndec = 0.22, ncut = 1500, nmix = 0.8, tmix = 0.7 } = {}) => render(Math.max(tdec, ndec) + 0.1, (oc, out) => {
  [[tone, 'triangle', 1], [tone * 1.62, 'sine', 0.5]].forEach(([f, type, m]) => {
    const o = oc.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f * 1.35, 0); o.frequency.exponentialRampToValueAtTime(f, 0.03);
    o.connect(env(oc, tmix * m, 0.001, tdec)).connect(out); o.start(0); o.stop(tdec + 0.05);
  });
  const n = noiseSrc(oc, ndec + 0.05);
  n.connect(filt(oc, 'highpass', ncut)).connect(filt(oc, 'peaking', 5000, 1)).connect(env(oc, nmix, 0.001, ndec)).connect(out); n.start(0);
});

const clap = ({ dec = 0.3, bp = 1100, q = 1.2 } = {}) => render(dec + 0.12, (oc, out) => {
  const n = noiseSrc(oc, dec + 0.12);
  const g = oc.createGain(); g.gain.value = 0;
  [0, 0.011, 0.023].forEach(t => { g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.01); });
  g.gain.setValueAtTime(0.9, 0.034); g.gain.exponentialRampToValueAtTime(0.0005, 0.034 + dec);
  n.connect(filt(oc, 'bandpass', bp, q)).connect(filt(oc, 'highpass', 600)).connect(g).connect(out); n.start(0);
});

const hat = ({ dec = 0.06, scale = 1, hp = 7000 } = {}) => render(dec + 0.06, (oc, out) => {
  const mix = oc.createGain(); mix.gain.value = 0.25;
  [205.3, 304.4, 369.6, 522.7, 540, 800].forEach(f => {
    const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = f * scale;
    o.connect(mix); o.start(0); o.stop(dec + 0.05);
  });
  const n = noiseSrc(oc, dec + 0.05); const ng = oc.createGain(); ng.gain.value = 0.25; n.connect(ng).connect(mix); n.start(0);
  mix.connect(filt(oc, 'bandpass', 10000, 0.8)).connect(filt(oc, 'highpass', hp)).connect(env(oc, 1, 0.001, dec)).connect(out);
});

const tom = ({ f = 130, dec = 0.35 } = {}) => render(dec + 0.08, (oc, out) => {
  const o = oc.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f * 1.7, 0); o.frequency.exponentialRampToValueAtTime(f, 0.08);
  o.connect(env(oc, 1, 0.001, dec)).connect(out); o.start(0); o.stop(dec + 0.05);
  const n = noiseSrc(oc, 0.05); n.connect(filt(oc, 'bandpass', f * 4, 1)).connect(env(oc, 0.2, 0.001, 0.03)).connect(out); n.start(0);
});

const rim = ({ f = 1700 } = {}) => render(0.08, (oc, out) => {
  const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
  const o2 = oc.createOscillator(); o2.type = 'square'; o2.frequency.value = f * 0.29;
  const bp = filt(oc, 'bandpass', f, 3);
  o.connect(bp); o2.connect(bp); bp.connect(env(oc, 1.4, 0.0005, 0.035)).connect(out);
  o.start(0); o2.start(0); o.stop(0.07); o2.stop(0.07);
});

const cowbell = ({ f = 560 } = {}) => render(0.45, (oc, out) => {
  const bp = filt(oc, 'bandpass', 2400, 1.5);
  [f, f * 1.48].forEach(x => { const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = x; o.connect(bp); o.start(0); o.stop(0.42); });
  const g = oc.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.7, 0.002);
  g.gain.exponentialRampToValueAtTime(0.25, 0.04); g.gain.exponentialRampToValueAtTime(0.0005, 0.4);
  bp.connect(g).connect(out);
});

const shaker = ({ dec = 0.09 } = {}) => render(dec + 0.06, (oc, out) => {
  const n = noiseSrc(oc, dec + 0.06);
  n.connect(filt(oc, 'highpass', 5500)).connect(env(oc, 0.8, 0.018, dec)).connect(out); n.start(0);
});

const bloop = ({ f0 = 250, f1 = 900, dec = 0.18, type = 'sine' } = {}) => render(dec + 0.05, (oc, out) => {
  const o = oc.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(f1, dec * 0.6);
  o.connect(env(oc, 0.9, 0.003, dec)).connect(out); o.start(0); o.stop(dec + 0.04);
});

const zap = ({ f0 = 3000, f1 = 80, dec = 0.25 } = {}) => render(dec + 0.05, (oc, out) => {
  const o = oc.createOscillator(); o.type = 'square';
  o.frequency.setValueAtTime(f0, 0); o.frequency.exponentialRampToValueAtTime(f1, dec);
  o.connect(filt(oc, 'lowpass', 4000)).connect(env(oc, 0.6, 0.001, dec)).connect(out); o.start(0); o.stop(dec + 0.04);
});

const stab = ({ root = 57, chord = [0, 3, 7, 10, 14], dec = 0.6, cutoff = 2400 } = {}) => render(dec + 0.1, (oc, out) => {
  const lp = filt(oc, 'lowpass', cutoff, 2);
  lp.frequency.setValueAtTime(cutoff, 0); lp.frequency.exponentialRampToValueAtTime(300, dec);
  const mix = oc.createGain(); mix.gain.value = 0.18;
  chord.forEach(iv => [-8, 8].forEach(det => {
    const o = oc.createOscillator(); o.type = 'sawtooth';
    o.frequency.value = 440 * Math.pow(2, (root + iv - 69) / 12); o.detune.value = det;
    o.connect(mix); o.start(0); o.stop(dec + 0.08);
  }));
  mix.connect(lp).connect(env(oc, 1, 0.004, dec)).connect(out);
});

const mallet = ({ f = 523, dec = 0.5 } = {}) => render(dec + 0.05, (oc, out) => {
  [[1, 1, dec], [3.9, 0.35, dec * 0.15], [9.2, 0.12, dec * 0.06]].forEach(([r, a, d]) => {
    const o = oc.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
    o.connect(env(oc, a, 0.001, d)).connect(out); o.start(0); o.stop(dec + 0.04);
  });
});

const snap = () => render(0.15, (oc, out) => {
  const n = noiseSrc(oc, 0.15);
  n.connect(filt(oc, 'bandpass', 2600, 3)).connect(env(oc, 1.5, 0.0008, 0.07)).connect(out); n.start(0);
  const o = oc.createOscillator(); o.frequency.value = 1300;
  o.connect(env(oc, 0.3, 0.0005, 0.02)).connect(out); o.start(0); o.stop(0.05);
});

// ---------- Post-procesado ----------
function lofi(buf, { bits = 8, down = 3, gain = 1 } = {}) {
  const d = buf.getChannelData(0), q = Math.pow(2, bits - 1);
  let hold = 0, lp = 0;
  for (let i = 0; i < d.length; i++) {
    if (i % down === 0) hold = Math.round(d[i] * q) / q;
    lp += (hold - lp) * 0.45;
    d[i] = lp * gain + (Math.random() - 0.5) * 0.004;
  }
  return buf;
}
function normalize(buf, peak = 0.92) {
  const d = buf.getChannelData(0);
  let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
  return buf;
}

const KITS = [
  { name: 'Chicle 808', sounds: [
    ['Bombo 808', () => kick({ f0: 140, f1: 46, pd: 0.09, dec: 1.1, click: 0.2, drive: 0.15 })],
    ['Caja 808', () => snare({ tone: 190, tdec: 0.1, ndec: 0.18, ncut: 1800 })],
    ['Palmas', () => clap({ dec: 0.28 })],
    ['Hat cerrado', () => hat({ dec: 0.05 })],
    ['Hat abierto', () => hat({ dec: 0.35 })],
    ['Tom grave', () => tom({ f: 110, dec: 0.45 })],
    ['Cencerro', () => cowbell({})],
    ['Bloop', () => bloop({ f0: 300, f1: 1200, dec: 0.16 })],
  ] },
  { name: 'Polvo Lofi', lofi: true, sounds: [
    ['Bombo polvo', () => kick({ f0: 120, f1: 50, pd: 0.05, dec: 0.4, click: 0.3, drive: 0.4 })],
    ['Caja polvo', () => snare({ tone: 170, tdec: 0.08, ndec: 0.25, ncut: 900, nmix: 0.6 })],
    ['Rim', () => rim({ f: 1500 })],
    ['Hat polvo', () => hat({ dec: 0.04, scale: 0.8, hp: 5000 })],
    ['Shaker', () => shaker({ dec: 0.08 })],
    ['Tom lofi', () => tom({ f: 160, dec: 0.3 })],
    ['Marimba', () => mallet({ f: 392, dec: 0.6 })],
    ['Acorde m7', () => stab({ root: 57, chord: [0, 3, 7, 10, 14], dec: 0.9, cutoff: 1800 })],
  ] },
  { name: 'Neón Techno', sounds: [
    ['Bombo duro', () => kick({ f0: 220, f1: 52, pd: 0.04, dec: 0.45, click: 0.6, drive: 0.6 })],
    ['Caja seca', () => snare({ tone: 230, tdec: 0.06, ndec: 0.14, ncut: 2500 })],
    ['Palmas XL', () => clap({ dec: 0.45, bp: 1300 })],
    ['Hat tight', () => hat({ dec: 0.03, hp: 9000 })],
    ['Hat largo', () => hat({ dec: 0.5, scale: 1.1 })],
    ['Rim metal', () => rim({ f: 2200 })],
    ['Zap', () => zap({})],
    ['Stab rave', () => stab({ root: 60, chord: [0, 3, 7, 12], dec: 0.5, cutoff: 5000 })],
  ] },
  { name: 'Burbuja Pop', sounds: [
    ['Bombo redondo', () => kick({ f0: 120, f1: 55, pd: 0.06, dec: 0.5, click: 0.1, drive: 0 })],
    ['Chasquido', () => snap()],
    ['Caja pop', () => snare({ tone: 260, tdec: 0.1, ndec: 0.15, ncut: 2200, tmix: 0.9 })],
    ['Hat suave', () => hat({ dec: 0.06, hp: 8000 })],
    ['Shaker', () => shaker({ dec: 0.12 })],
    ['Bloop sube', () => bloop({ f0: 200, f1: 1100, dec: 0.2 })],
    ['Bloop baja', () => bloop({ f0: 900, f1: 180, dec: 0.22, type: 'triangle' })],
    ['Kalimba', () => mallet({ f: 784, dec: 0.45 })],
  ] },
];

export async function generateKits() {
  return Promise.all(KITS.map(async kit => ({
    name: kit.name,
    sounds: await Promise.all(kit.sounds.map(async ([name, gen]) => {
      let b = await gen();
      if (kit.lofi) lofi(b, { bits: 7, down: 3 });
      return { name, buffer: normalize(b) };
    })),
  })));
}

// Click del metrónomo
export function metroClick(ctx, dest, time, accent) {
  const o = ctx.createOscillator(); o.frequency.value = accent ? 1600 : 1050;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(0.35, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  o.connect(g).connect(dest); o.start(time); o.stop(time + 0.06);
}
