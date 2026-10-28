// Dispositivos del Estudio: efectos de audio (cadena de cada pista), efectos MIDI e instrumentos.
// Cada efecto de audio se arma con nodos nativos de Web Audio (livianos para la tablet).
// Parámetros: { k, label, min, max, def, log?, unit?, opts? (lista de opciones) }
import { A, makeIR } from '../audio/engine.js';
import { SCALES, NOTE_NAMES } from '../scales.js';

const ctx = () => A.ctx;
const G = (v = 1) => { const g = ctx().createGain(); g.gain.value = v; return g; };
const BQ = (type, f, q = 0.7) => { const b = ctx().createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
const ramp = (param, v, t) => param.setTargetAtTime(v, t, 0.012);
const dB = v => Math.pow(10, v / 20);

export const SYNC = { '1/32': 0.125, '1/16': 0.25, '1/8T': 1 / 3, '1/8': 0.5, '3/16': 0.75, '1/4': 1, '3/8': 1.5, '1/2': 2, '1/1': 4, '2/1': 8 };
const SYNC_KEYS = Object.keys(SYNC);
const hz = v => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v)) + ' Hz';
const pct = v => Math.round(v * 100) + '%';
const db = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const ms = v => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms';

// Mezcla seco/mojado: in → dry → out ; in → [wet chain] → wet → out
function dryWet(input, output) {
  const dry = G(1), wet = G(0);
  input.connect(dry).connect(output);
  wet.connect(output);
  return { dry, wet, set(m, t) { ramp(dry.gain, Math.cos(m * Math.PI / 2), t); ramp(wet.gain, Math.sin(m * Math.PI / 2), t); } };
}

function waveCurve(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}

export const AUDIO_FX = {
  eq: {
    name: 'EQ', emoji: '📊', desc: 'Ecualizador: corte de graves + 3 bandas',
    params: [
      { k: 'cut', label: 'Corte graves', min: 20, max: 1000, def: 20, log: true, fmt: hz },
      { k: 'low', label: 'Graves', min: -15, max: 15, def: 0, fmt: db, bi: true },
      { k: 'mid', label: 'Medios', min: -15, max: 15, def: 0, fmt: db, bi: true },
      { k: 'midF', label: 'Frec. medios', min: 200, max: 6000, def: 1000, log: true, fmt: hz },
      { k: 'high', label: 'Agudos', min: -15, max: 15, def: 0, fmt: db, bi: true },
    ],
    make() {
      const lc = BQ('highpass', 20), lo = BQ('lowshelf', 220), mid = BQ('peaking', 1000, 0.9), hi = BQ('highshelf', 4500);
      lc.connect(lo).connect(mid).connect(hi);
      return { input: lc, output: hi, set(p, t) {
        ramp(lc.frequency, p.cut, t); ramp(lo.gain, p.low, t); ramp(mid.gain, p.mid, t); ramp(mid.frequency, p.midF, t); ramp(hi.gain, p.high, t);
      } };
    },
  },

  filter: {
    name: 'Filtro', emoji: '🌀', desc: 'Auto Filter: pasa-bajos/altos/banda con LFO al tempo',
    params: [
      { k: 'type', label: 'Tipo', opts: [['lowpass', 'Pasa-bajos'], ['highpass', 'Pasa-altos'], ['bandpass', 'Banda'], ['notch', 'Notch']], def: 'lowpass' },
      { k: 'freq', label: 'Frecuencia', min: 30, max: 18000, def: 18000, log: true, fmt: hz },
      { k: 'reso', label: 'Resonancia', min: 0, max: 1, def: 0.15, fmt: pct },
      { k: 'lfo', label: 'LFO', min: 0, max: 1, def: 0, fmt: pct },
      { k: 'rate', label: 'Velocidad', opts: SYNC_KEYS.map(k => [k, k]), def: '1/4' },
    ],
    make() {
      const f = BQ('lowpass', 18000), osc = ctx().createOscillator(), lg = G(0);
      osc.connect(lg).connect(f.detune); osc.start();
      return { input: f, output: f, set(p, t, bpm) {
        if (f.type !== p.type) f.type = p.type;
        ramp(f.frequency, p.freq, t); ramp(f.Q, 0.5 + p.reso * p.reso * 22, t);
        ramp(lg.gain, p.lfo * 3600, t);
        osc.frequency.setValueAtTime(bpm / 60 / (SYNC[p.rate] || 1), t);
      }, dispose() { osc.stop(); } };
    },
  },

  comp: {
    name: 'Compresor', emoji: '🗜', desc: 'Empareja el volumen y da pegada',
    params: [
      { k: 'thr', label: 'Umbral', min: -50, max: 0, def: -18, fmt: db },
      { k: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, fmt: v => v.toFixed(1) + ':1' },
      { k: 'att', label: 'Ataque', min: 0.1, max: 100, def: 10, log: true, fmt: ms },
      { k: 'rel', label: 'Release', min: 10, max: 1000, def: 150, log: true, fmt: ms },
      { k: 'gain', label: 'Ganancia', min: 0, max: 24, def: 4, fmt: db },
    ],
    make() {
      const c = ctx().createDynamicsCompressor(), out = G(1);
      c.knee.value = 6; c.connect(out);
      return { input: c, output: out, comp: c, set(p, t) {
        ramp(c.threshold, p.thr, t); ramp(c.ratio, p.ratio, t);
        ramp(c.attack, p.att / 1000, t); ramp(c.release, p.rel / 1000, t); ramp(out.gain, dB(p.gain), t);
      } };
    },
  },

  sat: {
    name: 'Saturador', emoji: '🔥', desc: 'Calidez y distorsión',
    params: [
      { k: 'drive', label: 'Drive', min: 0, max: 1, def: 0.35, fmt: pct },
      { k: 'tone', label: 'Tono', min: 800, max: 20000, def: 12000, log: true, fmt: hz },
      { k: 'mix', label: 'Mezcla', min: 0, max: 1, def: 1, fmt: pct },
      { k: 'out', label: 'Salida', min: -24, max: 6, def: -3, fmt: db },
    ],
    make() {
      const input = G(1), output = G(1), pre = G(1), sh = ctx().createWaveShaper(), lp = BQ('lowpass', 12000), dw = dryWet(input, output);
      sh.oversample = '2x';
      input.connect(pre).connect(sh).connect(lp).connect(dw.wet);
      let lastK = -1;
      return { input, output, set(p, t) {
        const k = 1 + p.drive * 14;
        if (Math.abs(k - lastK) > 0.05) { sh.curve = waveCurve(k); lastK = k; }
        ramp(pre.gain, 1 + p.drive * 1.5, t); ramp(lp.frequency, p.tone, t);
        dw.set(p.mix, t); ramp(output.gain, dB(p.out), t);
      } };
    },
  },

  delay: {
    name: 'Delay', emoji: '🔁', desc: 'Ecos al tempo, normal o ping-pong',
    params: [
      { k: 'time', label: 'Tiempo', opts: SYNC_KEYS.slice(1, 8).map(k => [k, k]), def: '3/16' },
      { k: 'fb', label: 'Repeticiones', min: 0, max: 0.92, def: 0.4, fmt: pct },
      { k: 'tone', label: 'Tono', min: 500, max: 16000, def: 4000, log: true, fmt: hz },
      { k: 'mode', label: 'Modo', opts: [['ping', 'Ping-pong'], ['mono', 'Normal']], def: 'ping' },
      { k: 'mix', label: 'Mezcla', min: 0, max: 1, def: 0.3, fmt: pct },
    ],
    make() {
      const input = G(1), output = G(1), dw = dryWet(input, output);
      const dL = ctx().createDelay(4), dR = ctx().createDelay(4), fb = G(0.4), tone = BQ('lowpass', 4000), lc = BQ('highpass', 120);
      const merger = ctx().createChannelMerger(2), pingIn = G(1), monoIn = G(0), sum = G(1);
      // ping-pong: dL → dR → (tono) → fb → dL ; normal: dL → tono → fb → dL, a los dos lados
      input.connect(dL);
      dL.connect(pingIn).connect(dR);
      dR.connect(tone); dL.connect(monoIn).connect(tone);
      tone.connect(lc).connect(fb).connect(dL);
      const lSide = G(1), rFromL = G(0);
      dL.connect(lSide).connect(merger, 0, 0);
      dR.connect(merger, 0, 1); dL.connect(rFromL).connect(merger, 0, 1);
      merger.connect(sum).connect(dw.wet);
      return { input, output, set(p, t, bpm) {
        const sec = Math.min(3.9, 60 / bpm * (SYNC[p.time] || 0.75));
        ramp(dL.delayTime, sec, t); ramp(dR.delayTime, sec, t);
        ramp(fb.gain, p.fb, t); ramp(tone.frequency, p.tone, t);
        const ping = p.mode !== 'mono';
        ramp(pingIn.gain, ping ? 1 : 0, t); ramp(monoIn.gain, ping ? 0 : 1, t); ramp(rFromL.gain, ping ? 0 : 1, t);
        dw.set(p.mix, t);
      } };
    },
  },

  reverb: {
    name: 'Reverb', emoji: '🏛', desc: 'Sala, de chica a catedral',
    params: [
      { k: 'size', label: 'Tamaño', min: 0.3, max: 8, def: 2.4, fmt: v => v.toFixed(1) + ' s' },
      { k: 'pre', label: 'Predelay', min: 0, max: 120, def: 15, fmt: ms },
      { k: 'tone', label: 'Brillo', min: 1000, max: 18000, def: 7000, log: true, fmt: hz },
      { k: 'lc', label: 'Corte graves', min: 20, max: 800, def: 180, log: true, fmt: hz },
      { k: 'mix', label: 'Mezcla', min: 0, max: 1, def: 0.3, fmt: pct },
    ],
    make() {
      const input = G(1), output = G(1), dw = dryWet(input, output);
      const pre = ctx().createDelay(0.2), conv = ctx().createConvolver(), lp = BQ('lowpass', 7000), hp = BQ('highpass', 180);
      input.connect(pre).connect(hp).connect(conv).connect(lp).connect(dw.wet);
      let size = 0, timer = null;
      return { input, output, set(p, t) {
        ramp(pre.delayTime, p.pre / 1000, t); ramp(lp.frequency, p.tone, t); ramp(hp.frequency, p.lc, t);
        dw.set(p.mix, t);
        if (Math.abs(p.size - size) > 0.05) {
          const first = !size; size = p.size;
          clearTimeout(timer);
          const doIt = () => { conv.buffer = makeIR(ctx(), size, 2.2); };
          first ? doIt() : (timer = setTimeout(doIt, 200));
        }
      } };
    },
  },

  chorus: {
    name: 'Chorus', emoji: '🌊', desc: 'Engorda y abre el estéreo',
    params: [
      { k: 'rate', label: 'Velocidad', min: 0.05, max: 6, def: 0.6, log: true, fmt: v => v.toFixed(2) + ' Hz' },
      { k: 'depth', label: 'Profundidad', min: 0, max: 1, def: 0.5, fmt: pct },
      { k: 'mix', label: 'Mezcla', min: 0, max: 1, def: 0.5, fmt: pct },
    ],
    make() {
      const input = G(1), output = G(1), dw = dryWet(input, output);
      const cL = ctx().createDelay(0.05), cR = ctx().createDelay(0.05), lfo = ctx().createOscillator();
      const gL = G(0), gR = G(0), merger = ctx().createChannelMerger(2);
      cL.delayTime.value = 0.012; cR.delayTime.value = 0.018;
      lfo.connect(gL).connect(cL.delayTime); lfo.connect(gR); gR.gain.value = 0;
      const inv = G(-1); gR.connect(inv).connect(cR.delayTime);
      lfo.start();
      input.connect(cL).connect(merger, 0, 0); input.connect(cR).connect(merger, 0, 1);
      merger.connect(dw.wet);
      return { input, output, set(p, t) {
        lfo.frequency.setValueAtTime(p.rate, t);
        ramp(gL.gain, p.depth * 0.005, t); ramp(gR.gain, p.depth * 0.005, t);
        dw.set(p.mix, t);
      }, dispose() { lfo.stop(); } };
    },
  },

  crush: {
    name: 'Bitcrusher', emoji: '👾', desc: 'Lo-fi: menos bits y menos muestras',
    params: [
      { k: 'bits', label: 'Bits', min: 2, max: 16, def: 8, fmt: v => Math.round(v) + ' bits' },
      { k: 'down', label: 'Reducción', min: 1, max: 40, def: 4, log: true, fmt: v => '÷' + Math.round(v) },
      { k: 'mix', label: 'Mezcla', min: 0, max: 1, def: 1, fmt: pct },
    ],
    make() {
      const input = G(1), output = G(1), dw = dryWet(input, output);
      const node = new AudioWorkletNode(ctx(), 'bloop-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      input.connect(node).connect(dw.wet);
      return { input, output, set(p, t) {
        node.parameters.get('bits').setValueAtTime(p.bits, t);
        node.parameters.get('down').setValueAtTime(p.down, t);
        dw.set(p.mix, t);
      }, dispose() { node.port.postMessage('stop'); } };
    },
  },

  trem: {
    name: 'Tremolo / Autopan', emoji: '〰', desc: 'Volumen o paneo que late al tempo',
    params: [
      { k: 'mode', label: 'Modo', opts: [['trem', 'Tremolo'], ['pan', 'Autopan']], def: 'trem' },
      { k: 'rate', label: 'Velocidad', opts: SYNC_KEYS.map(k => [k, k]), def: '1/8' },
      { k: 'depth', label: 'Profundidad', min: 0, max: 1, def: 0.6, fmt: pct },
    ],
    make() {
      const input = G(1), vca = G(1), pan = ctx().createStereoPanner(), lfo = ctx().createOscillator(), lt = G(0), lp = G(0);
      input.connect(vca).connect(pan);
      lfo.connect(lt).connect(vca.gain); lfo.connect(lp).connect(pan.pan); lfo.start();
      return { input, output: pan, set(p, t, bpm) {
        lfo.frequency.setValueAtTime(bpm / 60 / (SYNC[p.rate] || 0.5), t);
        const trem = p.mode !== 'pan';
        ramp(vca.gain, trem ? 1 - p.depth / 2 : 1, t);
        ramp(lt.gain, trem ? p.depth / 2 : 0, t); ramp(lp.gain, trem ? 0 : p.depth, t);
      }, dispose() { lfo.stop(); } };
    },
  },

  util: {
    name: 'Utilidad', emoji: '🎚', desc: 'Ganancia, paneo y ancho estéreo',
    params: [
      { k: 'gain', label: 'Ganancia', min: -36, max: 24, def: 0, fmt: db, bi: true },
      { k: 'width', label: 'Ancho', min: 0, max: 2, def: 1, fmt: v => (v < 0.01 ? 'Mono' : pct(v)) },
      { k: 'pan', label: 'Paneo', min: -1, max: 1, def: 0, fmt: v => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'I ' : 'D ') + Math.round(Math.abs(v) * 50)), bi: true },
    ],
    make() {
      const input = G(1), sp = ctx().createChannelSplitter(2), mg = ctx().createChannelMerger(2);
      const ll = G(1), lr = G(0), rr = G(1), rl = G(0), pan = ctx().createStereoPanner();
      input.connect(sp);
      sp.connect(ll, 0).connect(mg, 0, 0); sp.connect(rl, 1).connect(mg, 0, 0);
      sp.connect(rr, 1).connect(mg, 0, 1); sp.connect(lr, 0).connect(mg, 0, 1);
      mg.connect(pan);
      return { input, output: pan, set(p, t) {
        const g = dB(p.gain), a = (1 + p.width) / 2 * g, b = (1 - p.width) / 2 * g;
        ramp(ll.gain, a, t); ramp(rr.gain, a, t); ramp(lr.gain, b, t); ramp(rl.gain, b, t); ramp(pan.pan, p.pan, t);
      } };
    },
  },

  limiter: {
    name: 'Limitador', emoji: '🧱', desc: 'Más fuerte sin pasarse',
    params: [
      { k: 'gain', label: 'Empuje', min: 0, max: 24, def: 3, fmt: db },
      { k: 'ceil', label: 'Techo', min: -12, max: 0, def: -1, fmt: db },
      { k: 'rel', label: 'Release', min: 10, max: 800, def: 120, log: true, fmt: ms },
    ],
    make() {
      const input = G(1), c = ctx().createDynamicsCompressor(), out = G(1);
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
      input.connect(c).connect(out);
      return { input, output: out, comp: c, set(p, t) {
        ramp(input.gain, dB(p.gain), t); ramp(c.threshold, p.ceil, t); ramp(c.release, p.rel / 1000, t);
      } };
    },
  },
};

// ---------- Efectos MIDI (transforman las notas antes del instrumento) ----------
const CHORDS = {
  maj: ['Mayor', [0, 4, 7]], min: ['Menor', [0, 3, 7]], 7: ['7', [0, 4, 7, 10]], maj7: ['Maj7', [0, 4, 7, 11]],
  m7: ['m7', [0, 3, 7, 10]], sus2: ['Sus2', [0, 2, 7]], sus4: ['Sus4', [0, 5, 7]], 5: ['Quinta', [0, 7]],
  oct: ['Octava', [0, 12]], add9: ['Add9', [0, 4, 7, 14]], m9: ['m9', [0, 3, 7, 10, 14]],
};
export const MIDI_FX = {
  arp: {
    name: 'Arpegiador', emoji: '🪜', desc: 'Toca las notas del acorde una por una',
    params: [
      { k: 'mode', label: 'Modo', opts: [['up', '↑ Sube'], ['down', '↓ Baja'], ['updown', '↕ Sube y baja'], ['random', '? Azar']], def: 'up' },
      { k: 'rate', label: 'Velocidad', opts: ['1/32', '1/16', '1/8T', '1/8', '1/4'].map(k => [k, k]), def: '1/16' },
      { k: 'oct', label: 'Octavas', min: 1, max: 4, def: 1, step: 1, fmt: v => Math.round(v) + '' },
      { k: 'gate', label: 'Largo', min: 0.1, max: 1, def: 0.6, fmt: pct },
    ],
  },
  chord: {
    name: 'Acordes', emoji: '🎼', desc: 'Cada nota se vuelve un acorde',
    params: [
      { k: 'shape', label: 'Acorde', opts: Object.entries(CHORDS).map(([k, v]) => [k, v[0]]), def: 'maj' },
      { k: 'spread', label: 'Abrir', min: 0, max: 1, def: 0, fmt: pct },
    ],
  },
  scale: {
    name: 'Escala', emoji: '🎯', desc: 'Lleva cada nota a la escala elegida',
    params: [
      { k: 'root', label: 'Tónica', opts: NOTE_NAMES.map((n, i) => [i, n]), def: 9 },
      { k: 'type', label: 'Escala', opts: Object.entries(SCALES).filter(([k]) => k !== 'chromatic').map(([k, v]) => [k, v.name]), def: 'minor' },
    ],
  },
  pitch: {
    name: 'Transponer', emoji: '↕', desc: 'Sube o baja todas las notas',
    params: [{ k: 'semi', label: 'Semitonos', min: -24, max: 24, def: 0, step: 1, fmt: v => (v > 0 ? '+' : '') + Math.round(v), bi: true }],
  },
  human: {
    name: 'Humanizar', emoji: '🤲', desc: 'Pequeñas variaciones de fuerza y tiempo',
    params: [
      { k: 'vel', label: 'Fuerza', min: 0, max: 1, def: 0.3, fmt: pct },
      { k: 'time', label: 'Tiempo', min: 0, max: 30, def: 6, fmt: ms },
    ],
  },
};

export function defaultsOf(spec) {
  const p = {};
  for (const x of spec.params) p[x.k] = x.def;
  return p;
}

// Aplica los efectos MIDI (sin arpegiador) a una nota: devuelve la lista resultante
export function transformNote(nt, fxList) {
  let out = [nt];
  for (const fx of fxList) {
    if (!fx.on) continue;
    const p = fx.p;
    if (fx.type === 'pitch') out = out.map(n => ({ ...n, p: n.p + Math.round(p.semi) }));
    else if (fx.type === 'scale') {
      const iv = SCALES[p.type]?.iv || SCALES.major.iv;
      out = out.map(n => {
        const rel = ((n.p - p.root) % 12 + 12) % 12;
        let best = iv[0], bd = 99;
        for (const d of iv) { const dd = Math.abs(d - rel); if (dd < bd) { bd = dd; best = d; } }
        return { ...n, p: n.p - rel + best };
      });
    } else if (fx.type === 'chord') {
      const iv = CHORDS[p.shape]?.[1] || [0];
      out = out.flatMap(n => iv.map((d, k) => ({ ...n, p: n.p + d + (p.spread > 0.5 && k === 1 ? 12 : 0), v: n.v * (k ? 0.85 : 1) })));
    } else if (fx.type === 'human') {
      out = out.map(n => ({ ...n, v: Math.max(0.05, Math.min(1, n.v * (1 - p.vel * 0.5 * Math.random()))), dt: (n.dt || 0) + (Math.random() - 0.5) * 2 * p.time / 1000 }));
    }
  }
  return out;
}

export const AUDIO_FX_KEYS = Object.keys(AUDIO_FX);
export const MIDI_FX_KEYS = Object.keys(MIDI_FX);
