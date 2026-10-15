import { app } from './app.js';
import { A, initAudio, setDelay, setMonitor, setShow } from './audio/engine.js';
import { generateKits } from './audio/drums.js';
import { DrumTrack } from './audio/sampler.js';
import { Synth } from './audio/synth.js';
import { Looper } from './audio/looper.js';
import { PRESETS, PRESET_DEFAULTS } from './audio/presets.js';
import { seq } from './sequencer.js';
import {
  defaultState, migrateState, kvGet, kvSet, kvDel, kvKeys, storeToBuffer, bufferToStore, serializeState, NUM_LOOPS,
} from './state.js';
import { applyMix, applySynth, selectTrack, hitLive, noteOn, noteOff, restoreBankSound } from './actions.js';
import { bank } from './bank.js';
import { input } from './input.js';
import { buildTopbar } from './ui/topbar.js';
import { buildTracks } from './ui/tracks.js';
import { buildGrid } from './ui/grid.js';
import { buildLoops } from './ui/loops.js';
import { buildDock } from './ui/dock.js';
import { buildPadView, setView } from './ui/padview.js';
import { buildCountIn } from './ui/countin.js';
import { registerParamTargets } from './ui/params.js';
import { registerMixerTargets } from './ui/mixer.js';
import { buildLearnBar } from './ui/controllers.js';
import { toast } from './ui/util.js';

const $ = id => document.getElementById(id);

// Service worker (offline). En localhost se omite para no cachear mientras se desarrolla (?sw=1 lo fuerza).
// Si este módulo se evaluó, todos los archivos cargaron bien (el salvavidas de index.html lo mira)
window.__bloopReady = true;

// ---------- Service worker y actualizaciones ----------
// Cada versión se guarda completa en el dispositivo. Al abrir con internet se busca una nueva;
// si aparece, se instala entera en segundo plano y:
//  - en la pantalla de inicio: se recarga sola ya actualizada;
//  - usando la app: avisa, y se aplica al volver a Bloop (si no está sonando nada).
let swReg = null, updateReady = false;
const busy = () => app.seq?.playing || app.loopers?.some(l => l.state === 'armed' || l.state === 'recording' || l.overdubbing);
if ('serviceWorker' in navigator && (location.hostname !== 'localhost' || location.search.includes('sw=1'))) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(r => { swReg = r; r.update().catch(() => {}); }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // primera instalación: nada que actualizar
    if (!app.booting && !app.booted) { location.reload(); return; }
    updateReady = true;
    showUpdateBanner();
  });
}
let updateBanner = null;
function showUpdateBanner() {
  if (updateBanner || !app.booted) return;
  updateBanner = document.createElement('div');
  updateBanner.className = 'update-banner';
  updateBanner.innerHTML = '<span>✨ Versión nueva lista</span>';
  const b = document.createElement('button');
  b.className = 'sbtn on'; b.textContent = 'Actualizar ahora';
  b.onclick = applyUpdate;
  const x = document.createElement('button');
  x.className = 'sbtn'; x.textContent = 'Después';
  x.onclick = () => { updateBanner.remove(); };
  updateBanner.append(b, x);
  document.body.append(updateBanner);
}
function applyUpdate() {
  if (app.booted) { save(); resetting = true; }
  location.reload();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (updateReady && app.booted && !busy()) { applyUpdate(); return; }
  swReg?.update().catch(() => {});
});
// Versión en uso (la de la caché que está sirviendo la app)
(window.caches ? caches.keys() : Promise.resolve([])).then(ks => {
  const k = ks.find(x => x.startsWith('bloop-'));
  app.version = k ? k.replace('bloop-', '') : 'local';
}).catch(() => { app.version = 'local'; });

$('startBtn').addEventListener('click', boot, { once: true });

async function boot() {
  const msg = $('splashMsg');
  app.booting = true;
  try {
    // Que Android no borre los proyectos guardados si le falta espacio
    navigator.storage?.persist?.().catch(() => {});
    msg.textContent = 'despertando el audio…';
    await initAudio();
    msg.textContent = 'cocinando sonidos…';
    await bank.init();
    app.kits = await bank.loadKits().catch(e => { console.warn(e); return null; }) || await generateKits();
    await loadProject();
    applyDisplay();
    buildAudio();
    await restoreBankTracks();
    await restoreLoops();
    await input.init();
    buildUI();
    startClock();
    startAutosave();
    $('splash').remove();
    $('app').hidden = false;
    app.booted = true; app.booting = false;
    if (updateReady) showUpdateBanner();
    window.dispatchEvent(new Event('resize'));
  } catch (e) {
    console.error(e);
    msg.textContent = 'Error: ' + e.message;
  }
}

// ---------- Proyecto ----------
async function loadProject() {
  let s = null;
  try { const raw = await kvGet('project'); if (raw) s = JSON.parse(raw); } catch (e) { s = null; }
  if (!s || s.version !== 1) s = defaultState();
  s = migrateState(s);
  s.queued = null;
  s.synth.params = { ...PRESET_DEFAULTS, ...(s.synth.params || PRESETS[0].params) };
  app.userPresets = (await kvGet('userPresets')) || [];
  app.state = s;
  A.inputId = s.settings.inputId;

  // Samples propios
  const used = new Set();
  for (const t of s.tracks) {
    if (!t.sound.custom) continue;
    const o = await kvGet('sample:' + t.sound.custom);
    if (o) { app.customSamples.set(t.sound.custom, storeToBuffer(A.ctx, o)); used.add('sample:' + t.sound.custom); }
    else t.sound = { kit: s.kit, idx: s.tracks.indexOf(t) };
  }
  for (const k of await kvKeys()) if (String(k).startsWith('sample:') && !used.has(k)) kvDel(k);
}

function buildAudio() {
  const s = app.state;
  app.seq = seq;
  app.tracks = s.tracks.map((t, i) => {
    const tr = new DrumTrack(i);
    const snd = t.sound;
    const kit = app.kits[snd.kit] || app.kits[0];
    tr.setBuffer(snd.custom ? app.customSamples.get(snd.custom) : (kit.sounds[snd.idx] || kit.sounds[i]).buffer);
    return tr;
  });
  app.synth = new Synth();
  app.synth.setParams(s.synth.params);
  app.synth.onNote = (midi, on, time) => seq.uiQueue.push({ time, type: 'note', midi, on });
  app.synth.getBpm = () => app.state.bpm;
  app.loopers = Array.from({ length: NUM_LOOPS }, (_, i) => new Looper(i));
  A.master.gain.value = s.master;
  A.reverbReturn.gain.value = s.revLevel;
  A.delayReturn.gain.value = s.dlyLevel ?? 0.75;
  setDelay(s.bpm, s.delayDiv, s.delayFb);
  s.settings.monitor = false; // el monitoreo (y el micrófono) nunca arrancan prendidos
  setMonitor(false);
  setShow(!!s.settings.show, s.settings.showMon ?? 0.8, s.settings.showClick ?? 0.7);
  applyMix();
}

// Pistas con sonidos del banco: si el pack ya no está, vuelve al sonido del kit
async function restoreBankTracks() {
  const s = app.state;
  for (let i = 0; i < 8; i++) {
    const snd = s.tracks[i].sound;
    if (!snd.bank) continue;
    try { await restoreBankSound(i); }
    catch (e) {
      s.tracks[i].sound = { kit: s.kit, idx: i };
      app.tracks[i].setBuffer(app.kits[s.kit].sounds[i].buffer);
      toast(`Falta el pack de «${snd.name}»: la pista ${i + 1} volvió al kit`);
    }
  }
}

async function restoreLoops() {
  for (const lp of app.loopers) {
    const o = await kvGet('loop:' + lp.i);
    if (!o) continue;
    lp.raw = storeToBuffer(A.ctx, o);
    lp.recBpm = o.recBpm; lp.bars = o.bars || 2; lp.source = o.source || 'mic';
    lp.volume = o.volume ?? 0.9;
    lp.region = o.region || [0, lp.raw.duration];
    lp.fadeIn = o.fadeIn ?? 0.003; lp.fadeOut = o.fadeOut ?? 0.003; lp.free = !!o.free;
    lp.keepPitch = o.keepPitch ?? true;
    lp.render();
    lp.state = app.pattern.loops[lp.i] ? 'playing' : 'muted';
    lp.out.gain.value = lp.state === 'muted' ? 0 : lp.volume;
  }
  const save = i => {
    const lp = app.loopers[i];
    if (lp.raw) kvSet('loop:' + i, bufferToStore(lp.raw, { recBpm: lp.recBpm, bars: lp.bars, source: lp.source, volume: lp.volume, region: lp.region, fadeIn: lp.fadeIn, fadeOut: lp.fadeOut, free: lp.free, keepPitch: lp.keepPitch }));
  };
  const t = {};
  app.on('loop-saved', i => { clearTimeout(t[i]); t[i] = setTimeout(() => save(i), 600); });
  app.on('loop-cleared', i => kvDel('loop:' + i));
}

// ---------- Pantalla: modo sol y ahorro de batería ----------
function applyDisplay() {
  const st = app.state.settings;
  document.documentElement.dataset.theme = st.theme;
  document.body.classList.toggle('eco', st.eco);
  document.querySelector('meta[name=theme-color]').content = st.theme === 'light' ? '#fffaf0' : '#15121b';
}

// ---------- Acciones globales asignables y entradas por defecto ----------
function registerGlobals() {
  const s = app.state;
  const selLoop = () => app.loopers[s.selLoop];
  const acts = {
    'act:next-pat': ['Siguiente scene', () => seq.stepPattern(1)],
    'act:prev-pat': ['Scene anterior', () => seq.stepPattern(-1)],
    // Grabar/parar: si está vacío graba, si está grabando lo cierra, si ya tiene audio graba una capa encima
    'act:loop-rec': ['Grabar / parar loop elegido', () => { const lp = selLoop(); lp.raw && lp.state !== 'recording' ? lp.overdub() : lp.tap(); }],
    'act:loop-mute': ['Mutear loop elegido', () => { const lp = selLoop(); if (lp.raw) lp.setMuted(lp.state !== 'muted', true); }],
    'act:loop-next': ['Elegir loop siguiente', () => app.emit('loop-select', (s.selLoop + 1) % NUM_LOOPS)],
    'act:loop-prev': ['Elegir loop anterior', () => app.emit('loop-select', (s.selLoop + NUM_LOOPS - 1) % NUM_LOOPS)],
    'act:next-track': ['Pista siguiente', () => selectTrack((s.selected + 1) % 9)],
    'act:prev-track': ['Pista anterior', () => selectTrack((s.selected + 8) % 9)],
  };
  for (const [id, [label, fn]] of Object.entries(acts)) input.target(id, { label, kind: 'button', press: fn });

  // Teclado / pedales sin asignar
  input.onKey((e, down) => {
    if (!down) return false;
    const c = e.code, k = e.key.toLowerCase();
    if (c === 'Space' || e.key === ' ') { seq.toggle(); return true; }
    if (c === 'ArrowRight' || c === 'PageDown') { seq.stepPattern(1); return true; }
    if (c === 'ArrowLeft' || c === 'PageUp') { seq.stepPattern(-1); return true; }
    if (/^[1-9]$/.test(e.key)) { selectTrack(+e.key - 1); return true; }
    if (k === 'r') { seq.recording = !seq.recording; app.emit('rec'); return true; }
    if (k === 'm') { const ch = s.selected === 8 ? s.synth : s.tracks[s.selected]; ch.mute = !ch.mute; applyMix(); app.emit('tracks'); return true; }
    return false;
  });

  // MIDI sin asignar: notas al teclado (synth o sampler), canal 10 → pads, CC1 → brillo del synth
  input.midiHandler = ev => {
    if (ev.cmd === 0x90 || ev.cmd === 0x80) {
      if (ev.ch === 9 && ev.d1 >= 36 && ev.d1 < 44) { if (ev.on) hitLive(ev.d1 - 36, ev.value); return; }
      if (ev.on) { noteOn(ev.d1, ev.value); ui.dock.keyboard.markDown(ev.d1, 'down', true); }
      else { noteOff(ev.d1); ui.dock.keyboard.markDown(ev.d1, 'down', false); }
    } else if (ev.cmd === 0xb0 && ev.d1 === 1) {
      s.synth.params.cutoff = ev.value; applySynth(); app.emit('param', 's', 'cutoff');
    }
  };
}

// ---------- UI ----------
const ui = {};
function buildUI() {
  const topFrame = buildTopbar($('topbar'));
  ui.tracks = buildTracks($('tracks'));
  ui.grid = buildGrid($('gridHead'), $('gridWrap'));
  ui.pads = buildPadView($('padView'));
  buildCountIn();
  const loopsFrame = buildLoops($('perf'));
  ui.dock = buildDock($('dock'));
  setView(['pads', 'keys'].includes(app.state.view) ? app.state.view : 'main');
  registerParamTargets();
  registerMixerTargets();
  registerGlobals();
  buildLearnBar();
  input.markMapped();

  app.on('toast', toast);
  app.on('reset', resetProject);
  app.on('reload', () => { resetting = true; location.reload(); });
  app.on('transport', wakeLock);
  app.on('display', applyDisplay);

  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b) b.blur(); });
  // Hora exacta de cada toque (para cuantizar donde realmente tocaste)
  document.addEventListener('pointerdown', e => { app.lastInputTs = e.timeStamp; }, true);
  document.addEventListener('contextmenu', e => { if (!e.target.closest('input,textarea')) e.preventDefault(); });

  // Bucle de animación: consume eventos programados cuando realmente suenan.
  // En modo ahorro los dibujos pesados van a ~15 cuadros por segundo.
  let last = performance.now(), lastHeavy = 0;
  const frame = (now) => {
    const dt = (now - last) / 1000; last = now;
    const t = A.ctx.currentTime - A.outLat;
    const q = seq.uiQueue;
    if (q.length) {
      const keep = [];
      for (const ev of q) {
        if (ev.time > t) { keep.push(ev); continue; }
        if (ev.type === 'step') ui.grid.setPlayhead(ev.eff);
        else if (ev.type === 'hit') { ui.tracks.flash(ev.track); ui.pads.flash(ev.track); }
        else if (ev.type === 'note') ui.dock.keyboard.setLit(ev.midi, ev.on);
      }
      seq.uiQueue = keep;
    }
    const eco = app.state.settings.eco;
    if (!eco || now - lastHeavy > 66) {
      lastHeavy = now;
      topFrame(dt);
      loopsFrame(now / 1000);
      ui.dock.frame();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  app.on('transport', () => { if (!seq.playing) ui.dock.keyboard.clearLit(); });
}

// Reloj del secuenciador en un Worker (no se frena con la UI)
function startClock() {
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),20)'], { type: 'text/javascript' })));
  w.onmessage = () => seq.tick();
  const resume = () => { if (A.ctx.state !== 'running') A.ctx.resume(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); else save(); });
  document.addEventListener('pointerdown', resume);
}

// ---------- Guardado ----------
let lastSaved = '', resetting = false;
function save() {
  if (resetting) return;
  const s = serializeState(app.state);
  if (s !== lastSaved) { lastSaved = s; kvSet('project', s); }
}
function startAutosave() {
  lastSaved = serializeState(app.state);
  setInterval(save, 2000);
  window.addEventListener('pagehide', save);
}

// Proyecto nuevo: borra todo menos los perfiles de controladores
async function resetProject() {
  resetting = true;
  seq.stop();
  for (const k of await kvKeys()) if (k !== 'mappings') await kvDel(k);
  location.reload();
}

// Mantener la pantalla encendida mientras suena
let lock = null;
async function wakeLock() {
  try {
    if (seq.playing && !lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
    else if (!seq.playing && lock) { await lock.release(); lock = null; }
  } catch (e) { /* no soportado */ }
}
