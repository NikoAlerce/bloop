// Navegador del Estudio (barra de la izquierda, como en Ableton): instrumentos, efectos de audio,
// efectos MIDI, samples del banco y lo que hiciste en el modo En vivo (loops y patrones).
// Se arrastra a una pista (o al espacio vacío para una pista nueva). Tocar un sample lo hace sonar.
import { app } from '../app.js';
import { h, toast } from '../ui/util.js';
import { bank, CATS } from '../bank.js';
import { PRESETS, PRESET_CATS, PRESET_DEFAULTS } from '../audio/presets.js';
import { allPresets } from '../ui/presets.js';
import { presetById } from '../actions.js';
import { isPatternEmpty } from '../state.js';
import {
  S, uid, putBuffer, newTrack, newMidiClip, newAudioClip, synthInst, drumInst, samplerInst, srcName, DRUM_NOTE, selTrack,
} from './model.js';
import { studio, removeOverlaps } from './engine.js';
import { AUDIO_FX, MIDI_FX, AUDIO_FX_KEYS, MIDI_FX_KEYS } from './devices.js';
import { snapshot } from './ui.js';
import { addDevice } from './detail.js';

const SECTIONS = [
  ['inst', '🎹', 'Instrumentos'], ['drums', '🥁', 'Batería'], ['afx', '✨', 'Efectos de audio'], ['mfx', '🎼', 'Efectos MIDI'],
  ['samples', '🔊', 'Samples'], ['live', '🎛', 'Desde En vivo'],
];

export function buildBrowser(el, { arr }) {
  const st = S();
  let query = '', sampleCat = 'all';
  const search = h('input', { class: 'br-search', type: 'search', placeholder: '🔍 Buscar…' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); fill(); });
  const cats = h('div', { class: 'br-cats' });
  const list = h('div', { class: 'br-list' });
  el.append(h('div', { class: 'panel-title' }, 'Navegador'), search, cats, list);

  function renderCats() {
    cats.innerHTML = '';
    for (const [k, e, l] of SECTIONS) {
      const b = h('button', { class: 'br-cat' + (st.browserCat === k ? ' on' : '') }, h('span', {}, e), l);
      b.addEventListener('click', () => { st.browserCat = k; renderCats(); fill(); });
      cats.append(b);
    }
  }

  const match = s => !query || s.toLowerCase().includes(query);

  function items() {
    const k = st.browserCat, out = [];
    if (k === 'inst') {
      out.push({ head: 'Synth' });
      const catName = Object.fromEntries(PRESET_CATS);
      let last = null;
      for (const p of allPresets()) {
        if (!match(p.name)) continue;
        if (p.cat !== last) { out.push({ sub: catName[p.cat] || p.cat }); last = p.cat; }
        out.push({ kind: 'synth', key: p.key, label: p.name, emoji: p.emoji || '★', hint: 'Synth' });
      }
      const insts = bank.all().filter(x => x.kind === 'inst' && match(x.name));
      if (insts.length) {
        out.push({ head: 'Instrumentos sampleados' });
        for (const it of insts) out.push({ kind: 'binst', pack: it.pack, id: it.id, label: it.name, emoji: it.packEmoji || '🎻', hint: 'Sampler' });
      }
      out.push({ head: 'Sampler' });
      out.push({ kind: 'sampler', label: 'Sampler vacío', emoji: '🎻', hint: 'Arrastrale un sample' });
    } else if (k === 'drums') {
      out.push({ head: 'Drum Rack' });
      app.kits.forEach((kit, i) => { if (match(kit.name)) out.push({ kind: 'kit', kit: i, label: kit.name, emoji: '🥁', hint: kit.sounds.length + ' sonidos' }); });
      out.push({ kind: 'livekit', label: 'Los pads del modo En vivo', emoji: '🎛', hint: 'Con tus sonidos' });
      const hits = bank.all().filter(x => x.kind === 'sound' && ['kick', 'snare', 'clap', 'hat', 'cymbal', 'tom', 'perc'].includes(x.cat) && match(x.name));
      if (hits.length) {
        out.push({ head: 'Golpes sueltos (arrastralos a un pad)' });
        for (const it of hits.slice(0, 400)) out.push({ kind: 'sample', pack: it.pack, id: it.id, label: it.name, emoji: '·', hint: it.cat, bpm: it.bpm });
      }
    } else if (k === 'afx') {
      for (const key of AUDIO_FX_KEYS) { const f = AUDIO_FX[key]; if (match(f.name + f.desc)) out.push({ kind: 'afx', type: key, label: f.name, emoji: f.emoji, hint: f.desc }); }
    } else if (k === 'mfx') {
      for (const key of MIDI_FX_KEYS) { const f = MIDI_FX[key]; if (match(f.name + f.desc)) out.push({ kind: 'mfx', type: key, label: f.name, emoji: f.emoji, hint: f.desc }); }
    } else if (k === 'samples') {
      out.push({ chips: true });
      const all = bank.all().filter(x => x.kind === 'sound' && (sampleCat === 'all' || x.cat === sampleCat) && match(x.name + ' ' + (x.tags || []).join(' ')));
      for (const it of all.slice(0, 600)) out.push({ kind: 'sample', pack: it.pack, id: it.id, label: it.name, emoji: it.packEmoji || '🔊', hint: (it.bpm ? it.bpm + ' BPM · ' : '') + it.cat, bpm: it.bpm });
      if (!all.length) out.push({ note: 'No hay samples con ese filtro. Descargá packs desde 📚 Sonidos en el modo En vivo.' });
    } else if (k === 'live') {
      const lps = app.loopers.filter(l => l.hasAudio);
      out.push({ head: 'Loops' });
      if (!lps.length) out.push({ note: 'Todavía no grabaste loops.' });
      for (const l of lps) out.push({ kind: 'loop', i: l.i, label: `Loop ${l.i + 1}`, emoji: '🔁', hint: `${l.bars} compases · ${{ mic: '🎤', keys: '🎹', groove: '🥁' }[l.source] || ''}` });
      out.push({ head: 'Patrones (scenes)' });
      app.state.patterns.forEach((p, i) => {
        if (isPatternEmpty(p)) return;
        if (p.tracks.some(t => t.steps.some(s => s))) out.push({ kind: 'patdrums', i, label: `Patrón ${i + 1} · batería`, emoji: '🥁', hint: 'Como clip MIDI' });
        if (p.synth.notes.length) out.push({ kind: 'patsynth', i, label: `Patrón ${i + 1} · synth`, emoji: '🎹', hint: 'Como clip MIDI' });
      });
      out.push({ kind: 'allpats', label: 'Toda la canción (modo 🎼)', emoji: '🎼', hint: 'La cadena de patrones en orden' });
    }
    return out;
  }

  function fill() {
    list.innerHTML = '';
    for (const it of items()) {
      if (it.head) { list.append(h('div', { class: 'br-head' }, it.head)); continue; }
      if (it.sub) { list.append(h('div', { class: 'br-sub' }, it.sub)); continue; }
      if (it.note) { list.append(h('div', { class: 'hint' }, it.note)); continue; }
      if (it.chips) {
        const row = h('div', { class: 'chips wrap br-chips' }, ...CATS.filter(([k]) => k !== 'fav').map(([k, l]) => h('button', { class: 'chip' + (sampleCat === k ? ' on' : ''), onclick: () => { sampleCat = k; fill(); } }, l)));
        list.append(row); continue;
      }
      list.append(row(it));
    }
  }

  function row(it) {
    const add = h('button', { class: 'br-add', title: 'Agregar a la pista elegida (o en una nueva)' }, '＋');
    const r = h('div', { class: 'br-item' }, h('span', { class: 'br-emo' }, it.emoji), h('div', { class: 'br-txt' }, h('b', {}, it.label), it.hint ? h('small', {}, it.hint) : null), add);
    add.addEventListener('click', e => { e.stopPropagation(); applyItem(it, null); });
    // Arrastrar: con el dedo, moviendo hacia los costados (para arriba/abajo desplaza la lista)
    let d = null;
    r.addEventListener('pointerdown', e => {
      if (e.target === add) return;
      d = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, on: false };
    });
    r.addEventListener('pointermove', e => {
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.on) {
        if (d.type === 'touch' ? Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) : Math.hypot(dx, dy) > 6) {
          d.on = true; r.setPointerCapture(e.pointerId); startGhost(it, e);
        } else return;
      }
      moveGhost(e);
    });
    const end = e => {
      if (!d) return;
      const was = d; d = null;
      if (was.on) { endGhost(it, e); return; }
      if (e.type === 'pointerup' && Math.hypot(e.clientX - was.x, e.clientY - was.y) < 8) tapItem(it, r);
    };
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', e => { if (d?.on) { endGhost(it, null); } d = null; });
    return r;
  }

  // ---- Fantasma que sigue al dedo o al lápiz ----
  let ghost = null;
  function startGhost(it, e) {
    ghost = h('div', { class: 'drag-ghost' }, it.emoji + ' ' + it.label);
    document.body.append(ghost);
    moveGhost(e);
  }
  function moveGhost(e) {
    if (!ghost) return;
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const di = arr.dropInfo(e.clientX, e.clientY);
    arr.setDrop(di ? { ...di, a: di.b, b: di.b + 4 } : null);
    document.querySelectorAll('.dpad.drop, .dev.inst.drop').forEach(x => x.classList.remove('drop'));
    const under = document.elementFromPoint(e.clientX, e.clientY);
    under?.closest?.('.dpad')?.classList.add('drop');
    if (!under?.closest?.('.dpad')) under?.closest?.('.dev.inst')?.classList.add('drop');
  }
  function endGhost(it, e) {
    ghost?.remove(); ghost = null;
    arr.setDrop(null);
    document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
    if (!e) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const pad = under?.closest?.('.dpad');
    if (pad && it.kind === 'sample') { loadPad(+pad.dataset.pad, it); return; }
    if (under?.closest?.('.st-detail')) { applyItem(it, { t: selTrack(), b: S().pos, detail: true }); return; }
    const di = arr.dropInfo(e.clientX, e.clientY);
    if (di) applyItem(it, di);
  }

  async function tapItem(it, r) {
    if (it.kind === 'sample') {
      try { const { buffer, zones } = await bank.load(it.pack, it.id); studio.previewBuf(buffer || zones[0].buffer); } catch (e) { toast('No pude cargar ese sonido'); }
      list.querySelectorAll('.br-item.on').forEach(x => x.classList.remove('on'));
      r.classList.add('on');
      return;
    }
    if (it.kind === 'loop') { const lp = app.loopers[it.i]; if (lp.baseBuffer) studio.previewBuf(lp.baseBuffer); return; }
    if (it.kind === 'synth') {
      // prueba rápida del preset sin agregarlo
      toast('Tocá ＋ (o arrastralo) para usarlo · ' + it.label, 1500);
      return;
    }
    toast('Arrastralo a una pista o tocá ＋', 1500);
  }

  async function loadPad(i, it) {
    const t = selTrack();
    if (!t || t.inst?.type !== 'drums') return;
    snapshot('Sonido del pad');
    const pd = t.inst.pads[i] || { vol: 0.8, pitch: 0, pan: 0 };
    t.inst.pads[i] = { ...pd, src: { bank: { pack: it.pack, id: it.id }, name: it.label } };
    t.inst.sel = i;
    studio.sync(); app.emit('studio');
  }

  // ---- Aplicar: agrega a una pista existente o crea una nueva ----
  async function applyItem(it, target) {
    target ||= { t: compatible(it), b: S().pos };
    let t = target.t;
    const b = Math.max(0, target.b ?? S().pos);
    try {
      switch (it.kind) {
        case 'synth': case 'kit': case 'binst': case 'sampler': case 'livekit': {
          const inst = await instFor(it);
          if (t && t.kind === 'midi' && target.t) {
            snapshot('Cambiar instrumento');
            t.inst = inst;
            if (!t.clips.length) t.name = it.label;
          } else t = arr.addTrack('midi', { inst, name: it.label });
          S().sel.track = t.id; S().detail = 'devices';
          studio.sync(); app.emit('studio');
          break;
        }
        case 'afx': case 'mfx': {
          if (!t) t = selTrack();
          if (!t) { toast('Elegí o creá una pista primero'); return; }
          addDevice(t, it.kind === 'mfx' ? 'midi' : 'audio', it.type);
          break;
        }
        case 'sample': case 'loop': {
          let buf, bpm = null, name = it.label;
          if (it.kind === 'loop') { const lp = app.loopers[it.i]; buf = lp.baseBuffer; bpm = lp.recBpm; }
          else { const r = await bank.load(it.pack, it.id); buf = r.buffer || r.zones[0].buffer; bpm = it.bpm || null; }
          if (!buf) return;
          // Soltado sobre una pista MIDI: sampler o pad
          if (t && t.kind === 'midi') {
            snapshot('Sample');
            const src = it.kind === 'loop' ? { buf: putBuffer(buf), name } : { bank: { pack: it.pack, id: it.id }, name };
            if (t.inst.type === 'drums') { const i = t.inst.sel || 0; t.inst.pads[i] = { ...(t.inst.pads[i] || { vol: 0.8, pitch: 0, pan: 0 }), src }; }
            else t.inst = { ...samplerInst(src), root: 60 };
            studio.sync(); app.emit('studio');
            toast(t.inst.type === 'drums' ? `🥁 En el pad ${(t.inst.sel || 0) + 1}` : '🎻 Sampler listo');
            return;
          }
          if (!t || t.kind !== 'audio') t = arr.addTrack('audio', { name });
          snapshot('Agregar audio');
          const id = putBuffer(buf);
          const c = newAudioClip(b, buf, id, t.color, bpm || app.state.bpm, name);
          c.warp = !!bpm;
          if (!bpm) c.len = buf.duration / (60 / app.state.bpm);
          t.clips.push(c); removeOverlaps(t, c);
          S().sel.track = t.id; S().sel.clip = c.id; S().detail = 'clip';
          app.emit('studio');
          break;
        }
        case 'patdrums': case 'patsynth': case 'allpats': {
          await importPatterns(it, t, b, arr);
          break;
        }
      }
    } catch (e) { console.error(e); toast('No se pudo: ' + e.message); }
  }

  function compatible(it) {
    const t = selTrack();
    if (!t) return null;
    if (['afx'].includes(it.kind)) return t;
    if (['mfx'].includes(it.kind)) return t.kind === 'midi' ? t : null;
    if (['sample', 'loop'].includes(it.kind)) return t.kind === 'audio' ? t : null;
    if (['patdrums'].includes(it.kind)) return t.kind === 'midi' && t.inst.type === 'drums' ? t : null;
    if (['patsynth'].includes(it.kind)) return t.kind === 'midi' && t.inst.type !== 'drums' ? t : null;
    return null; // los instrumentos van en una pista nueva (salvo que los sueltes sobre una)
  }

  renderCats(); fill();
  app.on('bank', () => { if (['samples', 'drums', 'inst'].includes(st.browserCat)) fill(); });
  app.on('loops', () => { if (st.browserCat === 'live') fill(); });
  app.on('studio-view', fill);
  return { fill };
}

async function instFor(it) {
  if (it.kind === 'synth') { const pr = presetById(it.key); return { type: 'synth', preset: it.key, params: { ...PRESET_DEFAULTS, ...pr.params } }; }
  if (it.kind === 'kit') return drumInst(it.kit);
  if (it.kind === 'livekit') return liveKit();
  if (it.kind === 'binst') return { ...samplerInst({ bank: { pack: it.pack, id: it.id }, name: it.label }), r: 0.4 };
  return samplerInst({ kit: app.state.kit || 0, idx: 5, name: srcName({ kit: app.state.kit || 0, idx: 5 }) });
}

// Drum Rack con los 8 sonidos de los pads del modo En vivo
export function liveKit() {
  const inst = drumInst();
  app.state.tracks.forEach((tr, i) => {
    const snd = tr.sound;
    let src;
    if (snd.custom) { const b = app.customSamples.get(snd.custom); src = b ? { buf: putBuffer(b), name: snd.name || 'Sample' } : null; }
    else if (snd.bank) src = { bank: { pack: snd.bank, id: snd.id }, name: snd.name };
    else src = { kit: snd.kit, idx: snd.idx };
    if (src) inst.pads[i] = { src, vol: tr.params.vol, pitch: tr.params.pitch || 0, pan: tr.params.pan || 0, choke: tr.choke || 0 };
  });
  return inst;
}

// Patrones del modo En vivo → clips MIDI
function patternDrumNotes(p) {
  const notes = [];
  let len = 1;
  p.tracks.forEach((tp, i) => {
    len = Math.max(len, tp.len);
    for (let s = 0; s < tp.len; s++) {
      const step = tp.steps[s]; if (!step) continue;
      const n = step.rat || 1;
      for (let r = 0; r < n; r++) notes.push({ p: DRUM_NOTE + i, s: (s + (step.nudge || 0) + r / n) / 4, d: 0.25 / n, v: step.vel * (r ? 0.8 : 1) });
    }
  });
  return { notes, len: Math.ceil(len / 16) * 4 };
}
function patternSynthNotes(p) {
  return { notes: p.synth.notes.map(n => ({ p: n.midi, s: (n.step + (n.nudge || 0)) / 4, d: n.len / 4, v: n.vel })), len: Math.ceil(p.synth.len / 16) * 4 };
}

async function importPatterns(it, target, b, arr) {
  const st = S();
  const pats = app.state.patterns;
  snapshot('Traer patrones');
  const ensure = (kind) => {
    if (kind === 'drums') {
      if (target && target.kind === 'midi' && target.inst.type === 'drums') return target;
      let t = st.tracks.find(x => x.kind === 'midi' && x.inst.type === 'drums' && x.name === 'Batería (En vivo)');
      if (!t) { t = newTrack('midi', { inst: liveKit(), name: 'Batería (En vivo)' }); st.tracks.push(t); }
      return t;
    }
    if (target && target.kind === 'midi' && target.inst.type !== 'drums') return target;
    let t = st.tracks.find(x => x.kind === 'midi' && x.name === 'Synth (En vivo)');
    if (!t) { t = newTrack('midi', { inst: { type: 'synth', preset: app.state.synth.preset, params: { ...app.state.synth.params } }, name: 'Synth (En vivo)' }); st.tracks.push(t); }
    return t;
  };
  const put = (t, start, pat, kind, bars) => {
    const { notes, len } = kind === 'drums' ? patternDrumNotes(pat) : patternSynthNotes(pat);
    if (!notes.length) return 0;
    const L = bars ? bars * 4 : len;
    const c = newMidiClip(start, L, t.color, notes);
    c.loop = len; c.name = `Patrón ${pats.indexOf(pat) + 1}`;
    t.clips.push(c); removeOverlaps(t, c);
    return L;
  };
  const start = Math.floor(b / 4) * 4;
  if (it.kind === 'patdrums') put(ensure('drums'), start, pats[it.i], 'drums');
  else if (it.kind === 'patsynth') put(ensure('synth'), start, pats[it.i], 'synth');
  else {
    const chain = app.state.song.chain.length ? app.state.song.chain : [{ pat: app.state.current, bars: 4 }];
    let x = start;
    const td = ensure('drums'), ts = ensure('synth');
    for (const e of chain) {
      put(td, x, pats[e.pat], 'drums', e.bars);
      put(ts, x, pats[e.pat], 'synth', e.bars);
      x += e.bars * 4;
    }
    // las pistas que quedaron vacías se sacan
    st.tracks = st.tracks.filter(t => t.clips.length || (t !== td && t !== ts));
  }
  studio.sync(); app.emit('studio');
  toast('🎛 Traído al Estudio');
}
