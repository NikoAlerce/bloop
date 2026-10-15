// Acciones de alto nivel que usan varias partes de la UI.
import { app } from './app.js';
import {
  A, setDelay, capture, encodeWav, getMic, trimAndNormalize, normalizeBuffer, peakOf,
} from './audio/engine.js';
import { kvSet, kvKeys, kvDel, bufferToStore, serializeState, fxParams } from './state.js';
import { PRESETS, PRESET_DEFAULTS, mutate } from './audio/presets.js';
import { toast, clamp } from './ui/util.js';
import { undo } from './undo.js';
import { snap } from './scales.js';
import { zip, unzip, download } from './zip.js';
import { bank } from './bank.js';

const st = () => app.state;
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function applyTrack(i) { app.tracks[i].apply(st().tracks[i].params, app.audible(i)); }
// Fader del canal del synth en el mixer: 0.8 = ganancia unitaria, 1 = +4 dB
export const faderGain = v => (v / 0.8) ** 2;
export function applySynth() {
  app.synth.level = faderGain(st().synth.mixLevel ?? 0.8);
  app.synth.apply(app.audible(8), st().synth.fx);
}
export function applyMix() {
  for (let i = 0; i < 8; i++) applyTrack(i);
  applySynth();
}

// exact = sin redondear (lo usa el loop libre que define el tempo)
export function setBpm(v, exact = false) {
  const s = st(), old = s.bpm;
  // exacto: sin redondear, para que el loop que define el tempo no se desfase nunca
  v = clamp(exact ? v : Math.round(v), 40, 220);
  if (v === old) return;
  s.bpm = v;
  setDelay(v, s.delayDiv, s.delayFb);
  app.loopers.forEach(l => l.onTempo(old));
  app.emit('bpm');
}

export function selectTrack(i) {
  const s = st();
  s.selected = i;
  if (i < 8) s.lastDrum = i;
  app.emit('select');
}

export function soundName(i) {
  const snd = st().tracks[i].sound;
  if (snd.custom || snd.bank) return snd.name || 'Sample';
  return app.kits[snd.kit]?.sounds[snd.idx]?.name || '—';
}
export function trackName(i) {
  if (i === 8) return 'Synth';
  return st().tracks[i].name || soundName(i);
}

// ---------- Sonidos de pista (con deshacer) ----------
function trackSnapshot(i) {
  const t = st().tracks[i], tr = app.tracks[i];
  return { sound: { ...t.sound }, name: t.name, params: JSON.parse(JSON.stringify(t.params)), buffer: tr.buffer, revBuffer: tr.revBuffer, zones: tr.zones };
}
function trackRestore(i, s) {
  const t = st().tracks[i], tr = app.tracks[i];
  t.sound = { ...s.sound }; t.name = s.name; t.params = JSON.parse(JSON.stringify(s.params));
  Object.assign(tr, { buffer: s.buffer, revBuffer: s.revBuffer, zones: s.zones });
  if (s.sound.custom && s.buffer) app.customSamples.set(s.sound.custom, s.buffer);
  applyTrack(i);
  app.emit('sound', i);
}
export function undoTrack(i, label, key = null) {
  undo.state(label, key, () => trackSnapshot(i), s => trackRestore(i, s));
}

export function setKitSound(i, kit, idx, withUndo = true) {
  if (withUndo) undoTrack(i, 'Sonido');
  const t = st().tracks[i];
  t.sound = { kit, idx };
  t.name = '';
  Object.assign(t.params, { start: 0, end: 1, slices: [], sliceMode: false, root: 60 });
  app.tracks[i].setBuffer(app.kits[kit].sounds[idx].buffer);
  app.emit('sound', i);
}

export function loadKit(k) {
  st().kit = k;
  undo.state('Kit', null, () => [...Array(8).keys()].map(trackSnapshot), arr => arr.forEach((s, i) => trackRestore(i, s)));
  for (let i = 0; i < 8; i++) setKitSound(i, k, i, false);
  toast('🥁 Kit: ' + app.kits[k].name);
}

export async function setCustomSample(i, buf, name, resetRegion = true) {
  undoTrack(i, 'Sample');
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  app.customSamples.set(id, buf);
  const t = st().tracks[i];
  t.sound = { custom: id, name };
  t.name = '';
  if (resetRegion) Object.assign(t.params, { start: 0, end: 1, slices: [], sliceMode: false, fadeIn: 0, fadeOut: 0, root: 60 });
  app.tracks[i].setBuffer(buf);
  app.emit('sound', i);
  await kvSet('sample:' + id, bufferToStore(buf, { name }));
}

// Nota base para tocar un instrumento desde los pasos (paso sin afinar = esta nota)
function homeNote(item, zones) {
  const want = item.cat === 'bass' ? 36 : 60;
  const lo = zones[0].root, hi = zones[zones.length - 1].root;
  let n = Math.min(hi, Math.max(lo, want));
  n -= ((n % 12) + 12) % 12;          // al Do más cercano hacia abajo
  return Math.max(lo - 12, n);
}

// Pone un sonido o instrumento del banco en una pista
export async function setBankSound(i, pack, id) {
  const { item, buffer, zones } = await bank.load(pack, id);
  undoTrack(i, 'Sonido');
  const t = st().tracks[i], p = t.params;
  t.sound = { bank: pack, id, name: item.name };
  t.name = '';
  Object.assign(p, { start: 0, end: 1, slices: [], sliceMode: false, fadeIn: 0, fadeOut: 0, reverse: false, pitch: 0 });
  if (zones) {
    app.tracks[i].setZones(zones);
    p.root = homeNote(item, zones);
    p.mono = false;
  } else {
    app.tracks[i].setBuffer(buffer, item.root ?? null);
    p.root = item.root ?? 60;
  }
  applyTrack(i);
  app.emit('sound', i);
}

// Carga una pista desde una referencia guardada (al abrir el proyecto)
export async function restoreBankSound(i) {
  const snd = st().tracks[i].sound;
  const { item, buffer, zones } = await bank.load(snd.bank, snd.id);
  if (zones) app.tracks[i].setZones(zones);
  else app.tracks[i].setBuffer(buffer, item.root ?? null);
}

export async function loadBankToLoop(li, pack, id) {
  const { item, buffer } = await bank.load(pack, id);
  app.loopers[li].loadBuffer(buffer, item.bpm);
  toast(`🔁 «${item.name}» en el loop ${li + 1}`);
}

export async function normalizeTrack(i) {
  const buf = app.tracks[i].buffer;
  if (!buf) return;
  await setCustomSample(i, normalizeBuffer(buf), soundName(i), false);
  toast('📈 Normalizado');
}

export async function loadFileToTrack(i, file) {
  try {
    const ab = await file.arrayBuffer();
    const buf = await A.ctx.decodeAudioData(ab);
    await setCustomSample(i, buf, file.name.replace(/\.[^.]+$/, '').slice(0, 24));
    toast('📁 Cargado: ' + file.name);
  } catch (e) {
    toast('No pude leer ese archivo de audio');
  }
}

export function audition(i, vel = 0.9) {
  app.seq.hit(i, A.ctx.currentTime + 0.005, vel);
}
export function hitLive(i, vel = 0.9) {
  app.seq.hit(i, A.ctx.currentTime + 0.005, vel, 0, true);
  app.seq.recordHit(i, vel);
}

// ---------- Notas (teclado en pantalla, MIDI, pads de escala) ----------
// Destino: el synth o la pista de sampler elegida (cromático o slices)
const held = new Map(); // midi -> {track, voice}
export function samplerTrack() { const s = st(); return s.selected < 8 ? s.selected : (s.lastDrum ?? 0); }

export function noteOn(midi, vel = 0.8) {
  midi = snap(midi);
  if (st().kbTarget === 'sample') {
    const i = samplerTrack(), p = st().tracks[i].params, k = midi - p.root;
    const old = held.get(midi);
    if (old) app.tracks[old.track].release(old.voice);
    const opt = { poly: true, hold: true, live: true };
    if (p.sliceMode && p.slices.length) opt.slice = k;
    const v = app.tracks[i].trigger(A.ctx.currentTime + 0.003, vel, p.sliceMode ? 0 : k, p, opt);
    held.set(midi, { track: i, voice: v });
    app.seq.uiQueue.push({ time: 0, type: 'hit', track: i, vel });
    app.seq.recordHit(i, vel, k);
    return;
  }
  if (st().synth.arp.on) app.seq.arpAdd(midi);
  else { app.synth.noteOn(midi, vel); app.seq.recordNoteOn(midi, vel); }
}
export function noteOff(midi) {
  midi = snap(midi);
  const h = held.get(midi);
  if (h) { app.tracks[h.track].release(h.voice); held.delete(midi); return; }
  if (st().synth.arp.on) app.seq.arpRemove(midi);
  else { app.synth.noteOff(midi); app.seq.recordNoteOff(midi); }
}

// ---------- Presets del synth (de fábrica y propios) ----------
// La clave es el número de preset de fábrica o 'u:<id>' para los guardados por el usuario.
export function presetById(k) {
  if (typeof k === 'string' && k.startsWith('u:')) return (app.userPresets || []).find(p => 'u:' + p.id === k) || null;
  return PRESETS[k] || null;
}
export function presetLabel() {
  const s = st().synth, pr = presetById(s.preset);
  if (!pr) return '🎛️ Sonido propio';
  return `${pr.emoji} ${pr.name}${s.varied ? ' 🎲' : ''}`;
}

export function setPreset(k) {
  const pr = presetById(k);
  if (!pr) return;
  const s = st().synth;
  s.preset = k;
  s.varied = false;
  s.params = { ...PRESET_DEFAULTS, ...pr.params };
  s.fx = { ...fxParams(), ...(pr.fx || {}) };
  app.synth.allOff();
  app.synth.setParams(s.params);
  applySynth();
  app.emit('preset');
}

// Variación aleatoria del sonido actual (se puede deshacer)
export function varyPreset(amount = 0.25) {
  const s = st().synth;
  undo.state('Variar sonido', null, () => ({ params: { ...s.params }, fx: { ...s.fx }, varied: s.varied }), v => {
    s.params = { ...v.params }; s.fx = { ...v.fx }; s.varied = v.varied;
    app.synth.setParams(s.params); applySynth(); app.emit('preset');
  });
  s.params = mutate(s.params, amount);
  s.varied = true;
  app.synth.setParams(s.params);
  applySynth();
  app.emit('preset');
}

export async function saveUserPreset(name) {
  const s = st().synth;
  const pr = { id: Date.now().toString(36), name: name.slice(0, 32), emoji: '⭐', cat: 'mine', params: { ...s.params }, fx: { ...s.fx } };
  app.userPresets = [...(app.userPresets || []), pr];
  await kvSet('userPresets', app.userPresets);
  s.preset = 'u:' + pr.id;
  s.varied = false;
  app.emit('preset');
  toast(`💾 Guardado: ${pr.name}`);
}

export async function deleteUserPreset(id) {
  app.userPresets = (app.userPresets || []).filter(p => p.id !== id);
  await kvSet('userPresets', app.userPresets);
  app.emit('preset');
}

// Escucha de prueba según el tipo de sonido
export function auditionPreset(cat) {
  const t = A.ctx.currentTime + 0.03;
  const notes = cat === 'bass' ? [36] : cat === 'lead' || cat === 'fx' ? [60] : [60, 64, 67, 71];
  notes.forEach(m => app.synth.playNote(m, 0.8, t, cat === 'pluck' || cat === 'bell' ? 0.3 : 0.9));
}

// ---------- Grabación a pistas ----------
// Graba la mezcla (sin loops) N compases y la pone en una pista
export async function resampleToTrack(i, bars = 1) {
  const seq = app.seq;
  if (!seq.playing) seq.start();
  const t0 = seq.nextBarTime(), len = bars * 16 * seq.stepDur;
  toast('⟲ Resample en el próximo compás…');
  const buf = await capture(A.mixBus, t0, len).promise;
  await setCustomSample(i, normalizeBuffer(buf), `Resample ${bars}c`);
  st().tracks[i].params.mono = true;
  toast('✨ Resample listo en la pista ' + (i + 1));
}

// Micrófono → pista. Graba hasta 90 s; el silencio antes de superar el umbral se descarta.
let micJob = null;
export async function toggleMicRecord(i) {
  if (micJob) {
    const j = micJob; micJob = null;
    j.stop();
    const buf = await j.promise;
    app.emit('mic-rec', false);
    if (peakOf(buf) < st().settings.recThresh) { toast('No llegó sonido por encima del umbral'); return; }
    await setCustomSample(i, trimAndNormalize(buf, st().settings.recThresh), 'Mic ' + new Date().toLocaleTimeString().slice(0, 5));
    toast('🎤 Sample grabado');
    return;
  }
  let node;
  try { node = await getMic(); } catch (e) { toast('🎤 Sin acceso a la entrada de audio'); return; }
  micJob = capture(node, A.ctx.currentTime + 0.02, 90);
  micJob.t0 = performance.now();
  const j = micJob;
  j.promise.then(() => { if (micJob === j) { micJob = null; app.emit('mic-rec', false); toast('Llegaste al máximo de 90 s'); } });
  app.emit('mic-rec', true);
}
export const micRecInfo = () => (micJob ? { secs: (performance.now() - micJob.t0) / 1000 } : null);

// ---------- Exportación ----------
async function recordBars(nodes, bars) {
  const seq = app.seq;
  if (!seq.playing) seq.start();
  const t0 = seq.nextBarTime(), len = bars * 16 * seq.stepDur;
  toast(`⏺ Grabando ${bars} compases desde el próximo compás…`, Math.min(9000, (t0 - A.ctx.currentTime + len) * 1000));
  return Promise.all(nodes.map(n => capture(n, t0, len).promise));
}

export async function exportWav(bars = 4) {
  const [buf] = await recordBars([A.analyser], bars);
  download(encodeWav(buf), `bloop-${stamp()}.wav`);
  toast('⤓ WAV listo');
}

// Cada pista, el synth, cada loop y los retornos de FX por separado + la mezcla, en un ZIP
export async function exportStems(bars = 4) {
  const clean = s => s.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '_');
  const src = [
    ...app.tracks.map((t, i) => ({ name: `${String(i + 1).padStart(2, '0')}_${clean(trackName(i))}`, node: t.pan })),
    { name: '09_Synth', node: app.synth.vol },
    ...app.loopers.filter(l => l.hasAudio).map(l => ({ name: `Loop_${l.i + 1}`, node: l.out })),
    { name: 'FX_Reverb', node: A.reverbReturn },
    { name: 'FX_Delay', node: A.delayReturn },
    { name: '00_Mezcla', node: A.analyser, keep: true },
  ];
  const bufs = await recordBars(src.map(s => s.node), bars);
  const files = [];
  bufs.forEach((b, k) => {
    if (!src[k].keep && peakOf(b) < 1e-4) return; // pistas en silencio no se exportan
    files.push({ name: src[k].name + '.wav', data: new Uint8Array(0), blob: encodeWav(b) });
  });
  for (const f of files) f.data = new Uint8Array(await f.blob.arrayBuffer());
  download(zip(files), `bloop-stems-${stamp()}.zip`);
  toast(`⤓ ${files.length} stems listos (${A.ctx.sampleRate} Hz, 16 bits)`);
}

// ---------- Respaldo del proyecto completo ----------
export async function exportProject() {
  const files = [];
  const enc = new TextEncoder();
  const s = JSON.parse(serializeState(st()));
  const loops = [];
  for (const lp of app.loopers) {
    if (!lp.raw) continue;
    loops.push({ i: lp.i, region: lp.region, fadeIn: lp.fadeIn, fadeOut: lp.fadeOut, bars: lp.bars, recBpm: lp.recBpm, free: lp.free, source: lp.source, volume: lp.volume, muted: lp.state === 'muted', keepPitch: lp.keepPitch });
    files.push({ name: `loops/${lp.i}.wav`, data: new Uint8Array(await encodeWav(lp.raw, true).arrayBuffer()) });
  }
  for (const t of st().tracks) {
    if (!t.sound.custom) continue;
    const buf = app.customSamples.get(t.sound.custom);
    if (buf && !files.some(f => f.name === `samples/${t.sound.custom}.wav`)) {
      files.push({ name: `samples/${t.sound.custom}.wav`, data: new Uint8Array(await encodeWav(buf, true).arrayBuffer()) });
    }
  }
  files.unshift({ name: 'project.json', data: enc.encode(JSON.stringify({ app: 'bloop', version: 1, state: s, loops })) });
  download(zip(files), `proyecto-bloop-${stamp()}.bloop`);
  toast('💾 Proyecto exportado');
}

export async function importProject(file) {
  try {
    const entries = await unzip(await file.arrayBuffer());
    const meta = entries.find(e => e.name === 'project.json');
    if (!meta) throw new Error('no es un proyecto de Bloop');
    const pj = JSON.parse(new TextDecoder().decode(meta.data));
    if (pj.app !== 'bloop') throw new Error('no es un proyecto de Bloop');
    const decode = async e => A.ctx.decodeAudioData(e.data.slice().buffer);
    for (const k of await kvKeys()) if (String(k).startsWith('sample:') || String(k).startsWith('loop:')) await kvDel(k);
    for (const e of entries) {
      const m = e.name.match(/^samples\/(.+)\.wav$/);
      if (m) {
        const t = pj.state.tracks.find(tr => tr.sound.custom === m[1]);
        await kvSet('sample:' + m[1], bufferToStore(await decode(e), { name: t?.sound.name || 'Sample' }));
      }
    }
    for (const l of pj.loops) {
      const e = entries.find(x => x.name === `loops/${l.i}.wav`);
      if (e) await kvSet('loop:' + l.i, bufferToStore(await decode(e), l));
    }
    await kvSet('project', JSON.stringify(pj.state));
    app.emit('reload');
  } catch (e) {
    toast('No pude importar: ' + e.message);
  }
}
