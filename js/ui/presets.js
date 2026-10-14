// Navegador de presets del synth: categorías, búsqueda, favoritos, escuchar, guardar y variar.
import { app } from '../app.js';
import { PRESETS, PRESET_CATS } from '../audio/presets.js';
import { h, toast } from './util.js';
import { setPreset, presetById, varyPreset, saveUserPreset, deleteUserPreset, auditionPreset, presetLabel } from '../actions.js';

const CAT_NAME = Object.fromEntries(PRESET_CATS);

// Todos los presets como lista plana: {key, name, emoji, cat, user}
export function allPresets() {
  return [
    ...PRESETS.map((p, i) => ({ key: i, name: p.name, emoji: p.emoji, cat: p.cat })),
    ...(app.userPresets || []).map(p => ({ key: 'u:' + p.id, id: p.id, name: p.name, emoji: p.emoji, cat: 'mine', user: true })),
  ];
}

// Lista ordenada de la categoría del preset actual (para ◀ ▶)
export function stepPreset(dir) {
  const cur = app.state.synth.preset;
  const pr = presetById(cur);
  const cat = typeof cur === 'string' ? 'mine' : pr?.cat;
  const list = allPresets().filter(p => !cat || p.cat === cat);
  let k = list.findIndex(p => p.key === cur);
  k = (k + dir + list.length) % list.length;
  setPreset(list[k].key);
  auditionPreset(list[k].cat);
}

export function openPresets() {
  const s = app.state;
  const favs = new Set(s.settings.presetFavs || []);
  const cur0 = presetById(s.synth.preset);
  let cat = typeof s.synth.preset === 'string' ? 'mine' : 'all', query = '';
  void cur0;

  const grid = h('div', { class: 'bk-grid' });
  const count = h('span', { class: 'hint' });
  const current = h('b', {});
  const search = h('input', { class: 'bk-search', type: 'search', placeholder: '🔍 Buscar (ej: bajo, pad, rhodes, 80s)…' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  const catRow = h('div', { class: 'bk-cats' }, ...PRESET_CATS.map(([id, label]) => {
    const b = h('button', { class: 'chip' + (id === cat ? ' on' : '') }, label);
    b.addEventListener('click', () => { cat = id; [...catRow.children].forEach(x => x.classList.toggle('on', x === b)); render(); });
    return b;
  }));

  const sheet = h('div', { class: 'sheet' });
  const close = () => { sheet.remove(); app.off('preset', render); };
  sheet.addEventListener('pointerdown', e => { if (e.target === sheet) close(); });
  sheet.append(h('div', { class: 'sheet-card bank' },
    h('div', { class: 'sheet-head' }, h('b', {}, '🎛️ Sonidos del synth'), count, h('div', { style: { flex: 1 } }),
      h('span', { class: 'hint' }, 'Ahora:'), current,
      h('button', { class: 'pill', onclick: () => varyPreset() }, '🎲 Variar'),
      h('button', { class: 'pill', onclick: () => {
        const name = prompt('Nombre para tu preset', presetLabel().replace(/^\S+\s/, '').replace(' 🎲', '') + ' mío');
        if (name) saveUserPreset(name);
      } }, '💾 Guardar'),
      h('button', { class: 'round', onclick: close }, '✕')),
    h('div', { class: 'bk-main' }, search, catRow, grid),
  ));
  document.body.append(sheet);

  function render() {
    current.textContent = presetLabel();
    let list = allPresets();
    if (cat === 'fav') list = list.filter(p => favs.has(String(p.key)));
    else if (cat !== 'all') list = list.filter(p => p.cat === cat);
    if (query) list = list.filter(p => (p.name + ' ' + CAT_NAME[p.cat]).toLowerCase().includes(query));
    count.textContent = `${list.length} sonidos`;
    grid.innerHTML = '';
    if (!list.length) {
      grid.append(h('div', { class: 'hint', style: { padding: '20px' } }, cat === 'mine'
        ? 'Todavía no guardaste presets. Ajustá un sonido (o tocá 🎲 Variar) y tocá 💾 Guardar.'
        : 'No hay sonidos con ese filtro.'));
      return;
    }
    for (const p of list) {
      const fav = h('button', { class: 'bk-fav' + (favs.has(String(p.key)) ? ' on' : ''), title: 'Favorito' }, '★');
      fav.addEventListener('click', e => {
        e.stopPropagation();
        const k = String(p.key);
        favs.has(k) ? favs.delete(k) : favs.add(k);
        fav.classList.toggle('on');
        s.settings.presetFavs = [...favs];
      });
      const acts = [];
      if (p.user) {
        const del = h('button', { class: 'bk-go', style: { background: 'var(--panel2)', color: 'var(--ink)' } }, '🗑');
        del.addEventListener('click', e => { e.stopPropagation(); if (confirm(`¿Borrar «${p.name}»?`)) deleteUserPreset(p.id); });
        acts.push(del);
      }
      const card = h('div', { class: 'bk-item preset-card' + (s.synth.preset === p.key ? ' cur' : '') },
        h('div', { class: 'bk-top' }, h('span', {}, p.emoji), fav),
        h('div', { class: 'bk-name' }, p.name),
        h('div', { class: 'bk-meta' }, CAT_NAME[p.cat] || ''),
        acts.length ? h('div', { class: 'bk-acts' }, ...acts) : null);
      card.addEventListener('click', () => { setPreset(p.key); auditionPreset(p.cat); });
      grid.append(card);
    }
  }
  app.on('preset', render);
  render();
  toast('Tocá un sonido para cargarlo y escucharlo');
}
