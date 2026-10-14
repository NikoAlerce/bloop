// Banco de sonidos: packs descargables que quedan guardados offline, el pack base que viene
// con la app y los packs que importa el usuario (que nunca salen de su dispositivo).
import { app } from './app.js';
import { A } from './audio/engine.js';
import { kvGet, kvSet, kvDel, kvKeys } from './state.js';
import { unzip } from './zip.js';

const BASE = 'base';
const AUDIO_EXT = /\.(wav|mp3|ogg|opus|m4a|aac|flac|aif|aiff|webm)$/i;

export const CATS = [
  ['all', 'Todo'], ['fav', '★'], ['kick', 'Bombos'], ['snare', 'Cajas'], ['clap', 'Palmas'], ['hat', 'Hats'],
  ['cymbal', 'Platillos'], ['tom', 'Toms'], ['perc', 'Percusión'], ['bass', 'Bajos'], ['keys', 'Teclas'],
  ['strings', 'Cuerdas'], ['winds', 'Vientos'], ['chord', 'Acordes'], ['vocal', 'Voces'], ['loop', 'Loops'],
  ['fx', 'FX'], ['texture', 'Texturas'], ['other', 'Otros'],
];

// Adivina la categoría de un sample por su nombre o carpeta (para packs importados)
export function guessCat(path) {
  const n = path.toLowerCase();
  const has = re => re.test(n);
  if (has(/loop|\d{2,3}\s?bpm|break/)) return 'loop';
  if (has(/kick|\bbd\b|bombo|bassdrum|bass drum|\bkik/)) return 'kick';
  if (has(/snare|\bsd\b|caja|\bsnr/)) return 'snare';
  if (has(/clap|palma|snap/)) return 'clap';
  if (has(/hi.?hat|\bhh\b|\bhat|\boh\b|\bch\b/)) return 'hat';
  if (has(/crash|ride|cym|splash|china/)) return 'cymbal';
  if (has(/\btom/)) return 'tom';
  if (has(/808|bass|bajo|\bsub\b|reese|wobble|growl/)) return 'bass';
  if (has(/vox|vocal|voz|voice|chant|adlib/)) return 'vocal';
  if (has(/chord|acorde|stab/)) return 'chord';
  if (has(/piano|keys|rhodes|organ|epiano|\bep\b|synth|pluck|bell|mallet|vibe|kalimba/)) return 'keys';
  if (has(/string|violin|cello|guitar|guitarra|harp/)) return 'strings';
  if (has(/flute|sax|brass|horn|trumpet|wind/)) return 'winds';
  if (has(/fx|riser|impact|sweep|noise|whoosh|drop|laser|zap/)) return 'fx';
  if (has(/vinyl|vinilo|rain|lluvia|ambien|texture|foley|field/)) return 'texture';
  if (has(/perc|shaker|conga|bongo|rim|clave|cowbell|tamb|block|guiro|cabasa|triangle/)) return 'perc';
  return 'other';
}

export const bank = {
  index: [],                 // packs publicados (packs/index.json)
  packs: new Map(),          // id -> manifiesto de packs disponibles en este dispositivo
  downloading: new Map(),    // id -> progreso 0..1
  decoded: new Map(),        // 'pack/file' -> AudioBuffer (caché en memoria)

  async init() {
    // Pack base: viene con la app (lo guarda el service worker)
    try {
      const base = await (await fetch(`packs/${BASE}/pack.json`)).json();
      base.builtin = true;
      this.packs.set(BASE, base);
    } catch (e) { console.warn('pack base', e); }
    for (const k of await kvKeys()) {
      if (!String(k).startsWith('bankpack:')) continue;
      const m = await kvGet(k);
      if (m) this.packs.set(m.id, m);
    }
    this.index = (await kvGet('bank:index'))?.packs || [];
    this.refreshIndex();
  },

  // Lista de packs publicados (si hay internet; si no, la última conocida)
  async refreshIndex() {
    try {
      const r = await fetch('packs/index.json', { cache: 'no-cache' });
      if (!r.ok) return;
      const idx = await r.json();
      this.index = idx.packs.filter(p => p.id !== BASE);
      kvSet('bank:index', { packs: this.index });
      app.emit('bank');
    } catch (e) { /* offline */ }
  },

  isInstalled(id) { return this.packs.has(id); },

  async install(id) {
    if (this.downloading.has(id)) return;
    this.downloading.set(id, 0);
    app.emit('bank');
    try {
      const man = await (await fetch(`packs/${id}/pack.json`, { cache: 'no-cache' })).json();
      const files = [...man.sounds.map(s => s.file), ...man.instruments.flatMap(i => i.zones.map(z => z.file))];
      let done = 0;
      const queue = files.slice();
      const worker = async () => {
        while (queue.length) {
          const f = queue.shift();
          if (!(await kvGet(`bankfile:${id}/${f}`))) {
            const r = await fetch(`packs/${id}/${f}`);
            if (!r.ok) throw new Error(`${f}: ${r.status}`);
            await kvSet(`bankfile:${id}/${f}`, await r.arrayBuffer());
          }
          done++;
          this.downloading.set(id, done / files.length);
          app.emit('bank-progress', id);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      await kvSet(`bankpack:${id}`, man);
      this.packs.set(id, man);
      app.emit('toast', `${man.emoji || '📦'} ${man.name} listo, disponible offline`);
    } catch (e) {
      app.emit('toast', 'No se pudo descargar el pack: ' + e.message);
    }
    this.downloading.delete(id);
    app.emit('bank');
  },

  async remove(id) {
    const m = this.packs.get(id);
    if (!m || m.builtin) return;
    for (const k of await kvKeys()) if (String(k).startsWith(`bankfile:${id}/`)) await kvDel(k);
    await kvDel(`bankpack:${id}`);
    this.packs.delete(id);
    for (const k of [...this.decoded.keys()]) if (k.startsWith(id + '/')) this.decoded.delete(k);
    app.emit('bank');
  },

  // Todos los sonidos e instrumentos disponibles, planos, para el navegador
  all() {
    const out = [];
    for (const [pid, m] of this.packs) {
      for (const s of m.sounds) out.push({ ...s, pack: pid, key: `${pid}/${s.id}`, kind: 'sound', packEmoji: m.emoji });
      for (const i of m.instruments) out.push({ ...i, pack: pid, key: `${pid}/${i.id}`, kind: 'inst', packEmoji: m.emoji });
    }
    return out;
  },

  find(pack, id) {
    const m = this.packs.get(pack);
    if (!m) return null;
    return m.sounds.find(s => s.id === id) || m.instruments.find(i => i.id === id) || null;
  },

  async bytes(pack, file) {
    const m = this.packs.get(pack);
    if (m?.builtin) return (await fetch(`packs/${pack}/${file}`)).arrayBuffer();
    const b = await kvGet(`bankfile:${pack}/${file}`);
    if (!b) throw new Error('falta ' + file);
    return b;
  },

  async buffer(pack, file) {
    const key = `${pack}/${file}`;
    if (this.decoded.has(key)) return this.decoded.get(key);
    const ab = await this.bytes(pack, file);
    const buf = await A.ctx.decodeAudioData(ab.slice(0));
    this.decoded.set(key, buf);
    if (this.decoded.size > 300) this.decoded.delete(this.decoded.keys().next().value);
    return buf;
  },

  // Devuelve {buffer} para un sonido o {zones:[{root, buffer}]} para un instrumento
  async load(pack, id) {
    const it = this.find(pack, id);
    if (!it) throw new Error('sonido no encontrado');
    if (it.zones) return { item: it, zones: await Promise.all(it.zones.map(async z => ({ root: z.root, buffer: await this.buffer(pack, z.file) }))) };
    return { item: it, buffer: await this.buffer(pack, it.file) };
  },

  // Los 4 kits por defecto salen del pack base: [{name, sounds:[{name, buffer}]}]
  async loadKits() {
    const base = this.packs.get(BASE);
    if (!base) throw new Error('sin pack base');
    const kits = [];
    for (const snd of base.sounds) {
      if (!snd.kit) continue;
      let k = kits.find(x => x.name === snd.kit);
      if (!k) kits.push(k = { name: snd.kit, sounds: [] });
      k.sounds.push({ name: snd.name, id: snd.id });
    }
    await Promise.all(kits.flatMap(k => k.sounds.map(async s => { s.buffer = await this.buffer(BASE, base.sounds.find(x => x.id === s.id).file); })));
    return kits;
  },

  // ---------- Importar packs propios (quedan solo en este dispositivo) ----------
  async importFiles(entries, packName) {
    // entries: [{name: 'carpeta/archivo.wav', data: Uint8Array|ArrayBuffer}]
    const id = 'user-' + Date.now().toString(36);
    const sounds = [];
    let k = 0;
    for (const e of entries) {
      if (!AUDIO_EXT.test(e.name) || /__MACOSX|\/\._/.test(e.name)) continue;
      const data = e.data instanceof ArrayBuffer ? e.data : e.data.slice().buffer;
      try { await A.ctx.decodeAudioData(data.slice(0)); } catch (err) { continue; } // no es audio válido
      const file = `${k++}-${e.name.split('/').pop()}`;
      await kvSet(`bankfile:${id}/${file}`, data);
      const base = e.name.split('/').pop().replace(/\.[^.]+$/, '');
      const cat = guessCat(e.name);
      const bpm = (e.name.match(/(\d{2,3})\s?bpm/i) || [])[1];
      sounds.push({ id: 's' + k, name: base.slice(0, 40), cat, tags: ['mío'], file, ...(bpm ? { bpm: +bpm } : {}), ...(cat === 'loop' ? { loop: true } : {}) });
      app.emit('bank-import', sounds.length);
    }
    if (!sounds.length) { app.emit('toast', 'No encontré audios para importar'); return null; }
    const man = { id, name: packName || 'Mis samples', emoji: '💾', desc: 'Importado en este dispositivo', license: 'Tuyo · solo en esta tablet', user: true, sounds, instruments: [] };
    await kvSet(`bankpack:${id}`, man);
    this.packs.set(id, man);
    app.emit('bank');
    app.emit('toast', `💾 ${sounds.length} sonidos importados en «${man.name}»`);
    return id;
  },

  async importZip(file) {
    const entries = await unzip(await file.arrayBuffer(), n => AUDIO_EXT.test(n) && !/__MACOSX/.test(n));
    return this.importFiles(entries, file.name.replace(/\.zip$/i, ''));
  },

  async importFileList(files, name) {
    const entries = [];
    for (const f of files) entries.push({ name: f.webkitRelativePath || f.name, data: await f.arrayBuffer() });
    const folder = files[0]?.webkitRelativePath?.split('/')[0];
    return this.importFiles(entries, name || folder || 'Mis samples');
  },
};
