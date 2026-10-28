// Navegador del Estudio, como el de Ableton Live: a la izquierda las etiquetas (Biblioteca y
// Lugares), al lado la lista con carpetas que se despliegan, y abajo la escucha previa con la onda.
//  · Tocar un elemento lo elige y lo hace sonar (samples, instrumentos, kits, loops).
//  · Doble toque (o el botón ⤵) lo carga en la pista elegida, o en una pista nueva.
//  · También se arrastra a una pista, al espacio vacío (pista nueva), a un pad o a los dispositivos.
import { app } from '../app.js';
import { h, toast } from '../ui/util.js';
import { bank, CATS } from '../bank.js';
import { PRESET_CATS, PRESET_DEFAULTS } from '../audio/presets.js';
import { allPresets } from '../ui/presets.js';
import { presetById } from '../actions.js';
import { isPatternEmpty } from '../state.js';
import {
  S, putBuffer, getBuffer, buffers, peaksOf, newTrack, newMidiClip, newAudioClip, drumInst, samplerInst, srcName, DRUM_NOTE, selTrack,
} from './model.js';
import { studio, removeOverlaps } from './engine.js';
import { AUDIO_FX, MIDI_FX, MIDI_FX_KEYS } from './devices.js';
import { snapshot } from './ui.js';
import { addDevice } from './detail.js';
import { fitCanvas } from './gest.js';
import { T, FONT } from './theme.js';

const LIBRARY = [
  ['inst', '🎹', 'Instrumentos'], ['drums', '🥁', 'Batería'], ['afx', '✨', 'Efectos de audio'], ['mfx', '🎼', 'Efectos MIDI'],
  ['samples', '〰', 'Samples'], ['clips', '▤', 'Clips'],
];
const PLACES = [['packs', '📦', 'Packs'], ['project', '💾', 'Proyecto actual']];
const AFX_GROUPS = [
  ['Dinámica', ['comp', 'limiter']], ['EQ y filtros', ['eq', 'filter']], ['Delay y modulación', ['delay', 'chorus', 'trem']],
  ['Reverb', ['reverb']], ['Color y distorsión', ['sat', 'crush']], ['Utilidad', ['util']],
];
const HIT_CATS = ['kick', 'snare', 'clap', 'hat', 'cymbal', 'tom', 'perc'];

export function buildBrowser(el, { arr }) {
  const st = S();
  let query = '', selKey = null, listen = true, lastTap = { key: null, t: 0 };
  if (![...LIBRARY, ...PLACES].some(([k]) => k === st.browserCat)) st.browserCat = 'inst';
  const open = new Set(['afx:Dinámica', 'afx:EQ y filtros', 'afx:Delay y modulación', 'afx:Reverb', 'afx:Color y distorsión', 'afx:Utilidad', 'clips:pats', 'clips:loops', 'drums:racks']);

  const search = h('input', { class: 'br-search', type: 'search', placeholder: 'Buscar' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); fill(); });
  const side = h('div', { class: 'br-side' });
  const list = h('div', { class: 'br-list' });
  const pvCv = h('canvas', { class: 'br-pv-cv' });
  const pvName = h('span', { class: 'br-pv-name' }, '');
  const pvBtn = h('button', { class: 'br-pv-btn on', title: 'Escuchar al elegir (preescucha)' }, '🎧');
  pvBtn.addEventListener('click', () => { listen = !listen; pvBtn.classList.toggle('on', listen); if (!listen) studio.stopPreview(); });
  const collapse = h('button', { class: 'st-collapse', title: 'Cerrar el navegador' }, '◀');
  collapse.addEventListener('click', () => { st.browser = false; app.emit('studio-layout'); });
  el.append(h('div', { class: 'br-top' }, search, collapse), h('div', { class: 'br-cols' }, side, h('div', { class: 'br-main' }, h('div', { class: 'br-colhead' }, 'Nombre'), list)),
    h('div', { class: 'br-pv' }, pvBtn, h('div', { class: 'br-pv-wave' }, pvCv, pvName)));

  function renderSide() {
    side.innerHTML = '';
    const lbl = (k, e, l) => {
      const b = h('button', { class: 'br-cat' + (st.browserCat === k ? ' on' : '') }, h('span', {}, e), l);
      b.addEventListener('click', () => { st.browserCat = k; renderSide(); fill(); list.scrollTop = 0; });
      return b;
    };
    side.append(h('div', { class: 'br-sec' }, 'Biblioteca'), ...LIBRARY.map(x => lbl(...x)), h('div', { class: 'br-sec' }, 'Lugares'), ...PLACES.map(x => lbl(...x)));
  }

  // ---- Árbol de cada etiqueta: {key, label, emoji, kids?: () => [...], item?} ----
  const folder = (key, label, kids, emoji = '') => ({ key, label, emoji, kids });
  const leaf = (key, item) => ({ key, label: item.label, emoji: item.emoji, item, hint: item.hint });
  function tree(cat) {
    if (cat === 'inst') {
      const catName = Object.fromEntries(PRESET_CATS);
      const pre = allPresets();
      const cats = [...new Set(pre.map(p => p.cat))];
      const insts = bank.all().filter(x => x.kind === 'inst');
      const packs = [...new Set(insts.map(x => x.pack))];
      return [
        folder('inst:synth', 'Synth', () => cats.map(c => folder('inst:synth:' + c, catName[c] || c, () =>
          pre.filter(p => p.cat === c).map(p => leaf('syn:' + p.key, { kind: 'synth', key: p.key, cat: p.cat, label: p.name, emoji: p.emoji || '★', hint: 'Synth' })))), '🎹'),
        folder('inst:sampled', 'Instrumentos sampleados', () => packs.map(pk => folder('inst:pk:' + pk, bank.packs.get(pk)?.name || pk, () =>
          insts.filter(x => x.pack === pk).map(it => leaf('bi:' + it.key, { kind: 'binst', pack: it.pack, id: it.id, cat: it.cat, label: it.name, emoji: '🎻', hint: 'Sampler' })), '📦')), '🎻'),
        leaf('sampler', { kind: 'sampler', label: 'Sampler vacío', emoji: '🎻', hint: 'Arrastrale un sample' }),
      ];
    }
    if (cat === 'drums') {
      const hits = bank.all().filter(x => x.kind === 'sound' && HIT_CATS.includes(x.cat));
      const catName = Object.fromEntries(CATS);
      return [
        folder('drums:racks', 'Drum Racks', () => [
          ...app.kits.map((k, i) => leaf('kit:' + i, { kind: 'kit', kit: i, label: k.name, emoji: '🥁', hint: k.sounds.length + ' sonidos' })),
          leaf('livekit', { kind: 'livekit', label: 'Los pads del modo En vivo', emoji: '🎛', hint: 'Con tus sonidos' }),
        ], '🥁'),
        folder('drums:hits', 'Golpes sueltos', () => HIT_CATS.filter(c => hits.some(x => x.cat === c)).map(c => folder('drums:hit:' + c, catName[c] || c, () =>
          hits.filter(x => x.cat === c).map(sampleLeaf))), '·'),
      ];
    }
    if (cat === 'afx') return AFX_GROUPS.map(([g, ks]) => folder('afx:' + g, g, () => ks.map(k => leaf('afx:' + k, { kind: 'afx', type: k, label: AUDIO_FX[k].name, emoji: AUDIO_FX[k].emoji, hint: AUDIO_FX[k].desc })), '📁'));
    if (cat === 'mfx') return MIDI_FX_KEYS.map(k => leaf('mfx:' + k, { kind: 'mfx', type: k, label: MIDI_FX[k].name, emoji: MIDI_FX[k].emoji, hint: MIDI_FX[k].desc }));
    if (cat === 'samples') {
      const all = bank.all().filter(x => x.kind === 'sound');
      const catName = Object.fromEntries(CATS);
      return CATS.filter(([c]) => c !== 'all' && c !== 'fav' && all.some(x => x.cat === c)).map(([c]) => folder('smp:' + c, catName[c], () => all.filter(x => x.cat === c).map(sampleLeaf), '📁'));
    }
    if (cat === 'clips') {
      const pats = [];
      app.state.patterns.forEach((p, i) => {
        if (isPatternEmpty(p)) return;
        if (p.tracks.some(tr => tr.steps.some(s => s))) pats.push(leaf('pd:' + i, { kind: 'patdrums', i, label: `Patrón ${i + 1} · batería`, emoji: '▤', hint: 'Clip MIDI' }));
        if (p.synth.notes.length) pats.push(leaf('ps:' + i, { kind: 'patsynth', i, label: `Patrón ${i + 1} · synth`, emoji: '▤', hint: 'Clip MIDI' }));
      });
      pats.push(leaf('allpats', { kind: 'allpats', label: 'Toda la canción (modo 🎼)', emoji: '🎼', hint: 'Los patrones en orden' }));
      const loops = app.loopers.filter(l => l.hasAudio).map(l => leaf('lp:' + l.i, { kind: 'loop', i: l.i, label: `Loop ${l.i + 1}`, emoji: '🔁', hint: `${l.bars} compases` }));
      return [folder('clips:pats', 'Patrones del modo En vivo', () => pats, '📁'), folder('clips:loops', 'Loops del modo En vivo', () => loops.length ? loops : [{ key: 'nolp', label: 'Todavía no grabaste loops', note: true }], '📁')];
    }
    if (cat === 'packs') {
      const out = [];
      for (const [pid, m] of bank.packs) {
        out.push(folder('pack:' + pid, m.name, () => [
          ...m.instruments.map(it => leaf('bi:' + pid + '/' + it.id, { kind: 'binst', pack: pid, id: it.id, cat: it.cat, label: it.name, emoji: '🎻', hint: 'Instrumento' })),
          ...m.sounds.map(s => sampleLeaf({ ...s, pack: pid, key: pid + '/' + s.id })),
        ], m.emoji || '📦'));
      }
      out.push({ key: 'nopk', label: 'Más packs: 📚 Sonidos en el modo En vivo', note: true });
      return out;
    }
    if (cat === 'project') {
      const seen = new Map();
      for (const t of st.tracks) for (const c of t.clips) if (c.kind === 'audio' && !seen.has(c.buf)) seen.set(c.buf, c);
      const items = [...seen.values()].map(c => leaf('pb:' + c.buf, { kind: 'projbuf', buf: c.buf, bpm: c.bpm, warp: c.warp, label: c.name || 'Audio', emoji: '〰', hint: 'Grabación / audio del proyecto' }));
      return items.length ? items : [{ key: 'nopb', label: 'Todavía no hay audio en el proyecto', note: true }];
    }
    return [];
  }
  const sampleLeaf = it => leaf('s:' + it.key, { kind: 'sample', pack: it.pack, id: it.id, label: it.name, emoji: '〰', hint: (it.bpm ? it.bpm + ' BPM · ' : '') + (it.cat || ''), bpm: it.bpm });

  // Hojas que coinciden con la búsqueda (dentro de la etiqueta elegida)
  function searchLeaves(nodes, out = []) {
    for (const n of nodes) {
      if (out.length > 300) break;
      if (n.kids) searchLeaves(n.kids(), out);
      else if (n.item && (n.label + ' ' + (n.hint || '')).toLowerCase().includes(query)) out.push(n);
    }
    return out;
  }

  function fill() {
    list.innerHTML = '';
    const roots = tree(st.browserCat);
    if (query) {
      const res = searchLeaves(roots);
      if (!res.length) list.append(h('div', { class: 'br-note' }, 'Nada con «' + query + '» acá'));
      res.forEach(n => list.append(row(n, 0)));
      return;
    }
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        list.append(row(n, depth));
        if (n.kids && open.has(n.key)) walk(n.kids(), depth + 1);
      }
    };
    walk(roots, 0);
  }

  function row(n, depth) {
    if (n.note) return h('div', { class: 'br-note', style: { paddingLeft: 10 + depth * 14 + 'px' } }, n.label);
    const isF = !!n.kids;
    const r = h('div', { class: 'br-item' + (isF ? ' folder' : '') + (selKey === n.key ? ' on' : '') },
      h('span', { class: 'br-tri', style: { marginLeft: depth * 14 + 'px' } }, isF ? (open.has(n.key) ? '▾' : '▸') : ''),
      h('span', { class: 'br-emo' }, n.emoji || ''),
      h('span', { class: 'br-txt' }, n.label, !isF && n.hint ? h('small', {}, n.hint) : null));
    if (!isF && selKey === n.key) {
      const load = h('button', { class: 'br-load', title: 'Cargar en la pista elegida (o en una nueva)' }, '⤵');
      load.addEventListener('pointerdown', e => e.stopPropagation());
      load.addEventListener('click', e => { e.stopPropagation(); applyItem(n.item, null); });
      r.append(load);
    }
    let d = null;
    r.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, on: false }; });
    r.addEventListener('pointermove', e => {
      if (!d || d.id !== e.pointerId || isF) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.on) {
        if (d.type === 'touch' ? Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) : Math.hypot(dx, dy) > 6) {
          d.on = true; r.setPointerCapture(e.pointerId); startGhost(n.item, e);
        } else return;
      }
      moveGhost(e);
    });
    r.addEventListener('pointerup', e => {
      if (!d) return;
      const was = d; d = null;
      if (was.on) { endGhost(n.item, e); return; }
      if (Math.hypot(e.clientX - was.x, e.clientY - was.y) > 8) return;
      if (isF) { open.has(n.key) ? open.delete(n.key) : open.add(n.key); fill(); return; }
      const now = performance.now();
      if (lastTap.key === n.key && now - lastTap.t < 380) { lastTap = { key: null, t: 0 }; applyItem(n.item, null); return; } // doble toque: cargar
      lastTap = { key: n.key, t: now };
      selKey = n.key; fill();
      preview(n.item);
    });
    r.addEventListener('pointercancel', () => { if (d?.on) endGhost(n.item, null); d = null; });
    return r;
  }

  // ---- Escucha previa ----
  let pvBuf = null, pvT0 = 0;
  async function preview(it) {
    pvName.textContent = it.label;
    pvBuf = null; drawPv();
    if (!listen) return;
    try {
      if (it.kind === 'sample') { const r = await bank.load(it.pack, it.id); playBuf(r.buffer || r.zones[0].buffer); }
      else if (it.kind === 'loop') playBuf(app.loopers[it.i].baseBuffer);
      else if (it.kind === 'projbuf') playBuf(getBuffer(it.buf));
      else if (it.kind === 'synth') { const pr = presetById(it.key); studio.previewInst({ type: 'synth', params: { ...PRESET_DEFAULTS, ...pr.params } }, it.cat); }
      else if (it.kind === 'binst') studio.previewInst({ ...samplerInst({ bank: { pack: it.pack, id: it.id } }), r: 0.4 }, it.cat === 'bass' ? 'bass' : 'keys');
      else if (it.kind === 'kit') studio.previewInst(drumInst(it.kit));
      else if (it.kind === 'livekit') studio.previewInst(liveKit(true));
      else if (it.kind === 'afx' || it.kind === 'mfx') { studio.stopPreview(); pvName.textContent = it.label + ' · ' + it.hint; }
      else studio.stopPreview();
    } catch (e) { toast('No pude cargar ese sonido'); }
  }
  function playBuf(buf) {
    if (!buf) return;
    pvBuf = buf; pvT0 = performance.now();
    studio.previewBuf(buf);
    drawPv(); animPv();
  }
  function drawPv(ph = null) {
    const { g, w, h: hh } = fitCanvas(pvCv);
    g.fillStyle = '#181818'; g.fillRect(0, 0, w, hh);
    if (!pvBuf) return;
    const id = [...buffers.entries()].find(([, b]) => b === pvBuf)?.[0];
    const d = pvBuf.getChannelData(0), step = Math.max(1, Math.floor(d.length / w));
    g.fillStyle = T.accent;
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = x * step, e = Math.min(d.length, i + step); i < e; i += 4) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(x, hh / 2 - hi * hh / 2, 1, Math.max(1, (hi - lo) * hh / 2));
    }
    if (ph != null) { g.fillStyle = '#fff'; g.fillRect(ph * w, 0, 1.5, hh); }
    void id;
  }
  function animPv() {
    const b = pvBuf; if (!b) return;
    const f = () => {
      if (pvBuf !== b) return;
      const ph = (performance.now() - pvT0) / 1000 / b.duration;
      if (ph > 1) { drawPv(); return; }
      drawPv(ph); requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }

  // ---- Fantasma que sigue al dedo o al lápiz ----
  let ghost = null;
  function startGhost(it, e) {
    ghost = h('div', { class: 'drag-ghost' }, (it.emoji || '') + ' ' + it.label);
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

  async function loadPad(i, it) {
    const t = selTrack();
    if (!t || t.inst?.type !== 'drums') return;
    snapshot('Sonido del pad');
    const pd = t.inst.pads[i] || { vol: 0.8, pitch: 0, pan: 0 };
    t.inst.pads[i] = { ...pd, src: { bank: { pack: it.pack, id: it.id }, name: it.label } };
    t.inst.sel = i;
    studio.sync(); app.emit('studio');
  }

  // ---- Cargar: en una pista existente o en una nueva ----
  async function applyItem(it, target) {
    studio.stopPreview();
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
          toast('🎹 «' + it.label + '» cargado');
          break;
        }
        case 'afx': case 'mfx': {
          if (!t) t = selTrack();
          if (!t) { toast('Elegí o creá una pista primero'); return; }
          addDevice(t, it.kind === 'mfx' ? 'midi' : 'audio', it.type);
          break;
        }
        case 'sample': case 'loop': case 'projbuf': {
          let buf, bpm = null, name = it.label, bufId = null;
          if (it.kind === 'loop') { const lp = app.loopers[it.i]; buf = lp.baseBuffer; bpm = lp.recBpm; }
          else if (it.kind === 'projbuf') { buf = getBuffer(it.buf); bufId = it.buf; bpm = it.warp ? it.bpm : null; }
          else { const r = await bank.load(it.pack, it.id); buf = r.buffer || r.zones[0].buffer; bpm = it.bpm || null; }
          if (!buf) return;
          // Sobre una pista MIDI: va al pad elegido o se vuelve un sampler
          if (t && t.kind === 'midi') {
            snapshot('Sample');
            const src = it.kind === 'sample' ? { bank: { pack: it.pack, id: it.id }, name } : { buf: bufId || putBuffer(buf), name };
            if (t.inst.type === 'drums') { const i = t.inst.sel || 0; t.inst.pads[i] = { ...(t.inst.pads[i] || { vol: 0.8, pitch: 0, pan: 0 }), src }; }
            else t.inst = { ...samplerInst(src), root: 60 };
            studio.sync(); app.emit('studio');
            toast(t.inst.type === 'drums' ? `🥁 En el pad ${(t.inst.sel || 0) + 1}` : '🎻 Sampler listo');
            return;
          }
          if (!t || t.kind !== 'audio') t = arr.addTrack('audio', { name });
          snapshot('Agregar audio');
          const id = bufId || putBuffer(buf);
          const c = newAudioClip(b, buf, id, t.color, bpm || app.state.bpm, name);
          c.warp = !!bpm;
          if (!bpm) c.len = buf.duration / (60 / app.state.bpm);
          t.clips.push(c); removeOverlaps(t, c);
          S().sel.track = t.id; S().sel.clip = c.id; S().detail = 'clip';
          app.emit('studio');
          break;
        }
        case 'patdrums': case 'patsynth': case 'allpats': {
          await importPatterns(it, t, b);
          break;
        }
      }
    } catch (e) { console.error(e); toast('No se pudo: ' + e.message); }
  }

  function compatible(it) {
    const t = selTrack();
    if (!t) return null;
    if (it.kind === 'afx') return t;
    if (it.kind === 'mfx') return t.kind === 'midi' ? t : null;
    if (['sample', 'loop', 'projbuf'].includes(it.kind)) return t.kind === 'audio' ? t : null;
    if (it.kind === 'patdrums') return t.kind === 'midi' && t.inst.type === 'drums' ? t : null;
    if (it.kind === 'patsynth') return t.kind === 'midi' && t.inst.type !== 'drums' ? t : null;
    return null; // los instrumentos van en una pista nueva (salvo que los sueltes sobre una)
  }

  renderSide(); fill();
  app.on('bank', () => fill());
  app.on('loops', () => { if (st.browserCat === 'clips') fill(); });
  app.on('studio', () => { if (st.browserCat === 'project') fill(); });
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
// (temp: solo para escuchar; los samples propios no se guardan)
export function liveKit(temp = false) {
  const inst = drumInst();
  app.state.tracks.forEach((tr, i) => {
    const snd = tr.sound;
    let src;
    if (snd.custom) {
      const b = app.customSamples.get(snd.custom);
      if (b && temp) { buffers.set('tmp-' + snd.custom, b); src = { buf: 'tmp-' + snd.custom, name: snd.name || 'Sample' }; }
      else src = b ? { buf: putBuffer(b), name: snd.name || 'Sample' } : null;
    } else if (snd.bank) src = { bank: { pack: snd.bank, id: snd.id }, name: snd.name };
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

async function importPatterns(it, target, b) {
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
    st.tracks = st.tracks.filter(t => t.clips.length || (t !== td && t !== ts));
  }
  studio.sync(); app.emit('studio');
  toast('🎛 Traído al Estudio');
}
