// Navegador del banco de sonidos: packs (descargar / borrar / importar), categorías,
// búsqueda, favoritos, escuchar con un toque y mandar a una pista o a un loop.
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { bank, CATS } from '../bank.js';
import { TRACK_COLORS } from '../state.js';
import { h, toast } from './util.js';
import { setBankSound, setKitSound, loadBankToLoop, trackName } from '../actions.js';

const CAT_ICON = { kick: '🥁', snare: '🪘', clap: '👏', hat: '🎩', cymbal: '🔔', tom: '🛢️', perc: '🥢', bass: '🔊', keys: '🎹', strings: '🎻', winds: '🎷', chord: '🎶', vocal: '🎤', loop: '🔁', fx: '✨', texture: '🌧️', kit: '🫧', other: '•' };
const mb = n => (n / 1048576).toFixed(1) + ' MB';

let previewSrc = null;
async function preview(it) {
  try {
    const { buffer, zones } = await bank.load(it.pack, it.id);
    if (previewSrc) { try { previewSrc.stop(); } catch (e) { /* */ } }
    const ctx = A.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    let b = buffer;
    if (zones) { // instrumento: la zona más cercana a C4 (o C2 en bajos)
      const want = it.cat === 'bass' ? 36 : 60;
      const z = zones.reduce((a, c) => (Math.abs(c.root - want) < Math.abs(a.root - want) ? c : a));
      b = z.buffer;
    }
    src.buffer = b;
    g.gain.value = 0.9;
    src.connect(g).connect(A.master);
    const dur = Math.min(b.duration, it.loop || it.cat === 'loop' ? 8 : 4);
    g.gain.setValueAtTime(0.9, ctx.currentTime + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    src.start(); src.stop(ctx.currentTime + dur + 0.01);
    previewSrc = src;
  } catch (e) { toast('No pude cargar ese sonido'); }
}

export function openBank(trackIndex = null) {
  const s = app.state;
  let target = trackIndex ?? (s.selected < 8 ? s.selected : (s.lastDrum ?? 0));
  let cat = 'all', query = '', packFilter = null;
  const favs = new Set(s.settings.favs || []);
  const saveFavs = () => { s.settings.favs = [...favs]; };

  const sheet = h('div', { class: 'sheet' });
  const packsEl = h('div', { class: 'bk-packs' });
  const grid = h('div', { class: 'bk-grid' });
  const count = h('span', { class: 'hint' });
  const search = h('input', { class: 'bk-search', type: 'search', placeholder: '🔍 Buscar (ej: 808, caja, piano, lofi)…' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderGrid(); });
  const catRow = h('div', { class: 'bk-cats' }, ...CATS.map(([id, label]) => {
    const b = h('button', { class: 'chip' + (id === cat ? ' on' : '') }, label);
    b.addEventListener('click', () => { cat = id; [...catRow.children].forEach(x => x.classList.toggle('on', x === b)); renderGrid(); });
    return b;
  }));
  const targetChips = h('div', { class: 'chips' }, ...Array.from({ length: 8 }, (_, i) => {
    const b = h('button', { class: 'chip' + (i === target ? ' on' : ''), title: trackName(i), style: { background: i === target ? TRACK_COLORS[i] : '' } }, String(i + 1));
    b.addEventListener('click', () => { target = i; [...targetChips.children].forEach((x, k) => { x.classList.toggle('on', k === i); x.style.background = k === i ? TRACK_COLORS[k] : ''; }); });
    return b;
  }));

  // Importar
  const zipIn = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const filesIn = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
  const dirIn = h('input', { type: 'file', multiple: true, hidden: true });
  dirIn.setAttribute('webkitdirectory', '');
  const doImport = async fn => { toast('💾 Importando…', 4000); try { const id = await fn(); if (id) { packFilter = id; render(); } } catch (e) { toast('No pude importar: ' + e.message); } };
  zipIn.addEventListener('change', () => zipIn.files[0] && doImport(() => bank.importZip(zipIn.files[0])));
  filesIn.addEventListener('change', () => filesIn.files.length && doImport(() => bank.importFileList([...filesIn.files])));
  dirIn.addEventListener('change', () => dirIn.files.length && doImport(() => bank.importFileList([...dirIn.files])));

  const close = () => { sheet.remove(); app.off('bank', render); app.off('bank-progress', renderPacks); };
  sheet.addEventListener('pointerdown', e => { if (e.target === sheet) close(); });
  sheet.append(h('div', { class: 'sheet-card bank' },
    h('div', { class: 'sheet-head' }, h('b', {}, '📚 Banco de sonidos'), count, h('div', { style: { flex: 1 } }),
      h('span', { class: 'lbl' }, 'Mandar a la pista'), targetChips, h('button', { class: 'round', onclick: close }, '✕')),
    h('div', { class: 'bk-body' },
      h('div', { class: 'bk-side' }, packsEl,
        h('div', { class: 'bk-import' }, h('div', { class: 'lbl' }, 'Importar mis samples'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'sbtn', onclick: () => zipIn.click() }, '🗜 ZIP'),
            h('button', { class: 'sbtn', onclick: () => filesIn.click() }, '🎵 Archivos'),
            h('button', { class: 'sbtn', onclick: () => dirIn.click() }, '📁 Carpeta')),
          h('div', { class: 'hint' }, 'Los packs que importás quedan solo en esta tablet (no se publican). Se ordenan solos por nombre: kick, snare, hat, 808…'),
          zipIn, filesIn, dirIn)),
      h('div', { class: 'bk-main' }, search, catRow, grid)),
  ));
  document.body.append(sheet);

  function renderPacks() {
    packsEl.innerHTML = '';
    const mk = (id, emoji, name, info, actions, active) => {
      const row = h('div', { class: 'bk-pack' + (active ? ' on' : '') + (packFilter === id ? ' sel' : '') },
        h('span', { class: 'bk-emoji' }, emoji), h('div', { class: 'bk-pinfo' }, h('b', {}, name), h('small', {}, info)), ...actions);
      if (active) row.addEventListener('click', e => { if (e.target.closest('button')) return; packFilter = packFilter === id ? null : id; render(); });
      packsEl.append(row);
    };
    mk(null, '🗂️', 'Todos', 'lo que tenés disponible', [], true);
    for (const [id, m] of bank.packs) {
      const n = m.sounds.length + m.instruments.length;
      mk(id, m.emoji || '📦', m.name, m.builtin ? `${n} · incluido` : `${n} sonidos${m.user ? ' · tuyo' : ' · offline ✓'}`,
        m.builtin ? [] : [h('button', { class: 'x', title: 'Borrar de la tablet', onclick: () => { if (confirm(`¿Borrar «${m.name}» de la tablet?`)) bank.remove(id); } }, '✕')], true);
    }
    const avail = bank.index.filter(p => !bank.isInstalled(p.id));
    if (avail.length) packsEl.append(h('div', { class: 'lbl', style: { marginTop: '8px' } }, 'Para descargar'));
    for (const p of avail) {
      const prog = bank.downloading.get(p.id);
      const btn = prog != null
        ? h('div', { class: 'bk-prog' }, h('i', { style: { width: Math.round(prog * 100) + '%' } }))
        : h('button', { class: 'sbtn on', onclick: () => bank.install(p.id) }, '⤓ ' + mb(p.size));
      mk(p.id, p.emoji, p.name, `${p.count} sonidos · ${p.desc}`, [btn], false);
    }
    if (!avail.length && !bank.index.length) packsEl.append(h('div', { class: 'hint' }, 'Conectate a internet una vez para ver los packs para descargar.'));
  }

  function items() {
    let list = bank.all();
    if (packFilter) list = list.filter(it => it.pack === packFilter);
    if (cat === 'fav') list = list.filter(it => favs.has(it.key));
    else if (cat === 'loop') list = list.filter(it => it.loop || it.cat === 'loop' || it.cat === 'loop-drums');
    else if (cat !== 'all') list = list.filter(it => it.cat === cat);
    if (query) list = list.filter(it => (it.name + ' ' + (it.tags || []).join(' ') + ' ' + it.cat + ' ' + it.pack).toLowerCase().includes(query));
    return list;
  }

  function renderGrid() {
    const list = items();
    count.textContent = `${list.length} sonidos`;
    grid.innerHTML = '';
    if (!list.length) {
      grid.append(h('div', { class: 'hint', style: { padding: '20px' } }, bank.packs.size <= 1 ? 'Descargá un pack de la izquierda (una sola vez, con internet) o importá tus samples.' : 'No hay sonidos con ese filtro.'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of list.slice(0, 400)) {
      const isLoop = it.loop || it.cat === 'loop' || it.cat === 'loop-drums';
      const fav = h('button', { class: 'bk-fav' + (favs.has(it.key) ? ' on' : ''), title: 'Favorito' }, '★');
      fav.addEventListener('click', e => { e.stopPropagation(); favs.has(it.key) ? favs.delete(it.key) : favs.add(it.key); fav.classList.toggle('on'); saveFavs(); });
      const toTrack = h('button', { class: 'bk-go', title: 'Mandar a la pista' }, '→ ' + (target + 1));
      toTrack.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          if (it.pack === 'base' && it.kit) {
            const k = app.kits.findIndex(kk => kk.name === it.kit), si = app.kits[k].sounds.findIndex(x => x.name === it.name);
            setKitSound(target, k, si);
          } else await setBankSound(target, it.pack, it.id);
          app.seq.hit(target, A.ctx.currentTime + 0.01, 0.9);
          toast(`→ Pista ${target + 1}: ${it.name}`);
        } catch (err) { toast('No pude cargar ese sonido'); }
      });
      const actions = [toTrack];
      if (isLoop) {
        const toLoop = h('button', { class: 'bk-go loop', title: 'Mandar al loop elegido' }, '🔁 ' + (s.selLoop + 1));
        toLoop.addEventListener('click', e => { e.stopPropagation(); loadBankToLoop(s.selLoop, it.pack, it.id); });
        actions.push(toLoop);
      }
      const card = h('div', { class: 'bk-item' + (it.kind === 'inst' ? ' inst' : '') },
        h('div', { class: 'bk-top' }, h('span', {}, CAT_ICON[it.cat] || CAT_ICON[isLoop ? 'loop' : 'other'] || '•'), fav),
        h('div', { class: 'bk-name' }, it.name),
        h('div', { class: 'bk-meta' }, (it.kind === 'inst' ? `🎹 ${it.zones.length} notas` : it.bpm ? `${it.bpm} BPM` : it.dur ? it.dur.toFixed(1) + ' s' : ''), ' ', it.packEmoji || ''),
        h('div', { class: 'bk-acts' }, ...actions));
      card.addEventListener('click', () => preview(it));
      frag.append(card);
    }
    grid.append(frag);
  }

  function render() { renderPacks(); renderGrid(); }
  app.on('bank', render);
  app.on('bank-progress', renderPacks);
  render();
  bank.refreshIndex();
}
