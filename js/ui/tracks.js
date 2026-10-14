// Pistas como baldosas grandes: toda la baldosa es un pad (y elige la pista).
import { app } from '../app.js';
import { TRACK_COLORS, SYNTH_COLOR } from '../state.js';
import { h } from './util.js';
import { selectTrack, trackName, hitLive, applyMix, loadFileToTrack } from '../actions.js';
import { PRESETS } from '../audio/presets.js';
import { input } from '../input.js';
import { bank } from '../bank.js';

export function buildTracks(el) {
  const s = app.state;
  const rows = [];

  for (let i = 0; i <= 8; i++) {
    const isSynth = i === 8;
    const ch = () => (isSynth ? s.synth : s.tracks[i]);
    const name = h('div', { class: 't-name' });
    const sub = h('div', { class: 't-sub' });
    const m = h('button', { class: 'ms m no-learn', title: 'Mute' }, 'M');
    const so = h('button', { class: 'ms s no-learn', title: 'Solo' }, 'S');
    const num = h('span', { class: 't-num' }, isSynth ? '♫' : i + 1);
    const tile = h('div', { class: 'tile' + (isSynth ? ' synth' : '') }, h('div', { class: 't-info' }, name, sub), h('div', { class: 't-ms' }, num, m, so));
    tile.style.setProperty('--c', isSynth ? SYNTH_COLOR : TRACK_COLORS[i]);

    // Toda la baldosa es un pad: velocity según la altura del toque (abajo = fuerte)
    tile.addEventListener('pointerdown', e => {
      if (e.target.closest('.ms')) return;
      selectTrack(i);
      if (isSynth) return;
      const r = tile.getBoundingClientRect();
      hitLive(i, 0.5 + 0.5 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    });
    m.addEventListener('click', () => { ch().mute = !ch().mute; applyMix(); update(); });
    so.addEventListener('click', () => { ch().solo = !ch().solo; applyMix(); update(); });

    if (!isSynth) {
      tile.addEventListener('dragover', e => { e.preventDefault(); });
      tile.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFileToTrack(i, f); });
      input.target('trk:' + i, { get label() { return `Pad ${i + 1} · ${trackName(i)}`; }, kind: 'button', el: tile, press: v => { hitLive(i, v); } });
    }
    rows.push({ tile, name, sub, m, so, isSynth, i });
    el.append(tile);
  }

  function update() {
    for (const r of rows) {
      const c = r.isSynth ? s.synth : s.tracks[r.i];
      r.tile.classList.toggle('sel', s.selected === r.i);
      r.tile.classList.toggle('muted', !app.audible(r.i));
      r.m.classList.toggle('on', c.mute);
      r.so.classList.toggle('on', c.solo);
      r.name.textContent = trackName(r.i);
      const p = !r.isSynth && c.params;
      r.sub.textContent = r.isSynth ? PRESETS[s.synth.preset].emoji + ' ' + PRESETS[s.synth.preset].name
        : (p.sliceMode && p.slices.length ? `✂ ${p.slices.length} slices` : c.sound.custom ? 'sample propio' : c.sound.bank ? (bank.packs.get(c.sound.bank)?.name || 'banco') : app.kits[c.sound.kit]?.name || '');
    }
  }
  update();
  ['select', 'sound', 'preset', 'tracks'].forEach(ev => app.on(ev, update));

  return {
    flash(i) {
      const t = rows[i].tile;
      t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit');
    },
  };
}
