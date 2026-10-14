// Estructura del proyecto, demo inicial y persistencia (IndexedDB).
export const TRACK_COLORS = ['#ff6b6b', '#ff9f43', '#fecb57', '#9be564', '#48dbb4', '#54a0ff', '#a29bfe', '#ff8ed4'];
export const SYNTH_COLOR = '#c792ff';
export const LOOP_COLORS = ['#ff8ed4', '#48dbb4', '#fecb57', '#54a0ff', '#ff9f43', '#9be564', '#a29bfe', '#ff6b6b'];
export const NUM_LOOPS = 8;
export const MAX_STEPS = 32;

export const trackParams = () => ({
  vol: 0.8, pan: 0, pitch: 0, decay: 1, start: 0,
  filter: 0.5, reso: 0.1, drive: 0, rev: 0, dly: 0,
  reverse: false, mono: true,
  end: 1, fadeIn: 0, fadeOut: 0, root: 60, slices: [], sliceMode: false,
  crush: 0, down: 0, tape: 0, gate: 'off', gateDepth: 0.8,
});

// Efectos "color" por canal (también los usa el synth)
export const fxParams = () => ({ crush: 0, down: 0, tape: 0, gate: 'off', gateDepth: 0.8 });

export const mkStep = (vel = 0.8) => ({ vel, prob: 1, pitch: 0, rat: 1, nudge: 0 });

export function newPattern() {
  return {
    tracks: Array.from({ length: 8 }, () => ({ len: 16, steps: Array(MAX_STEPS).fill(null) })),
    synth: { len: 16, notes: [] },
    loops: Array(NUM_LOOPS).fill(true), // scene: qué loops suenan en este patrón
  };
}

export function clonePattern(p) { return JSON.parse(JSON.stringify(p)); }

export function isPatternEmpty(p) {
  return p.synth.notes.length === 0 && p.tracks.every(t => t.steps.every(s => !s)) && (p.loops || []).every(x => x);
}

export function defaultState() {
  const s = {
    version: 1,
    bpm: 118, swing: 0.15, metronome: false, master: 0.8,
    kit: 0, current: 0, queued: null, selected: 0,
    delayDiv: '3/16', delayFb: 0.42, revLevel: 0.8,
    settings: {
      micLatency: 30, inputId: '', monitor: false, recThresh: 0.03,
      theme: 'dark', eco: false,
    },
    recQuant: { on: true, amount: 1 },
    loopFree: false, selLoop: 0, loopPage: 0, loopScenes: true, loopScenesV2: true,
    kbTarget: 'synth', kbMode: 'piano', kbOctaves: 3, scale: { root: 9, type: 'chromatic' },
    song: { on: false, chain: [{ pat: 0, bars: 4 }, { pat: 1, bars: 4 }] },
    tracks: Array.from({ length: 8 }, (_, i) => ({
      name: '', sound: { kit: 0, idx: i }, params: trackParams(),
      mute: false, solo: false, choke: i === 3 || i === 4 ? 1 : 0,
    })),
    synth: {
      preset: 0, params: null, mute: false, solo: false, octave: 3,
      arp: { on: false, mode: 'up', rate: '1/16', oct: 1, hold: false, gate: 0.6 },
      fx: fxParams(),
    },
    patterns: Array.from({ length: 8 }, newPattern),
  };

  // Demo: un groove con acordes épicos para que suene apenas abrís.
  const p = s.patterns[0];
  const put = (pat, t, steps, vel = 0.85) => steps.forEach(i => { pat.tracks[t].steps[i] = mkStep(vel); });
  put(p, 0, [0, 4, 8, 12], 1);
  put(p, 2, [4, 12], 0.9);
  put(p, 3, [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15], 0.35);
  put(p, 3, [2, 6, 10, 14], 0.8);
  put(p, 4, [14], 0.55);
  put(p, 5, [7, 15], 0.55);
  put(p, 7, [11], 0.6);
  p.tracks[3].steps[15].prob = 0.5;
  p.tracks[5].steps[15].rat = 2;
  s.tracks[2].params.rev = 0.35;
  s.tracks[7].params.dly = 0.5;
  s.tracks[5].params.dly = 0.3;

  p.synth.len = 32;
  const chords = [[45, 57, 60, 64], [41, 57, 60, 65], [48, 55, 60, 64], [43, 55, 59, 62]];
  chords.forEach((c, k) => c.forEach(midi => p.synth.notes.push({ step: k * 8, midi, len: 7, vel: 0.75 })));

  // Patrón 2: variación más arriba
  const p2 = clonePattern(p);
  put(p2, 1, [4, 12], 0.8);
  put(p2, 4, [2, 6, 10, 14], 0.5);
  put(p2, 0, [14], 0.6);
  put(p2, 6, [3, 11], 0.5);
  s.patterns[1] = p2;
  return s;
}

// ---------- IndexedDB key-value ----------
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('bloop', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
export const kvGet = k => tx('readonly', s => s.get(k)).catch(() => null);
export const kvSet = (k, v) => tx('readwrite', s => s.put(v, k)).catch(e => console.warn('save', e));
export const kvDel = k => tx('readwrite', s => s.delete(k)).catch(() => {});
export const kvKeys = () => tx('readonly', s => s.getAllKeys()).catch(() => []);

export function bufferToStore(buf, extra = {}) {
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c).slice());
  return { sr: buf.sampleRate, ch, ...extra };
}
export function storeToBuffer(ctx, o) {
  const b = ctx.createBuffer(o.ch.length, o.ch[0].length || 1, o.sr);
  o.ch.forEach((d, c) => b.copyToChannel(d, c));
  return b;
}

// Completa campos nuevos en proyectos guardados con versiones anteriores
export function migrateState(s) {
  const def = defaultState();
  const needLoopMigration = s.loopScenesV2 === undefined; // antes de completar campos nuevos
  for (const k of Object.keys(def)) if (s[k] === undefined) s[k] = def[k];
  s.settings = { ...def.settings, ...s.settings };
  s.recQuant = { ...def.recQuant, ...s.recQuant };
  s.scale = { ...def.scale, ...s.scale };
  s.synth.arp = { ...def.synth.arp, ...s.synth.arp };
  s.synth.fx = { ...fxParams(), ...(s.synth.fx || {}) };
  s.tracks.forEach(t => { t.params = { ...trackParams(), ...t.params }; });
  // Antes cada loop quedaba activo en todas las escenas (y arrancaban todos al cambiar de escena).
  // Ahora pertenece a la escena actual; se puede sumar a otras tocándolo allí.
  if (needLoopMigration) {
    s.patterns.forEach((p, k) => { if (k !== s.current) p.loops = Array(NUM_LOOPS).fill(false); });
    s.loopScenesV2 = true;
  }
  s.patterns.forEach(p => {
    p.loops = Array.from({ length: NUM_LOOPS }, (_, i) => (p.loops ? p.loops[i] !== false : true));
    p.tracks.forEach(t => t.steps.forEach(st => { if (st && st.nudge == null) st.nudge = 0; }));
  });
  return s;
}

export function serializeState(s) {
  const { queued, ...rest } = s;
  return JSON.stringify(rest);
}
