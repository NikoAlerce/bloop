// Modo canción: una cadena de patrones/scenes con su cantidad de compases.
import { app } from '../app.js';
import { h, popover, toggle } from './util.js';
import { undo } from '../undo.js';

const BARS = [1, 2, 4, 8, 16];

export function openSong(anchor) {
  const s = app.state, song = s.song;
  const list = h('div', { class: 'song-chain' });
  const snap = label => undo.state(label, null, () => JSON.parse(JSON.stringify(song.chain)), v => { song.chain = JSON.parse(JSON.stringify(v)); render(); app.emit('song'); });
  const render = () => {
    list.innerHTML = '';
    song.chain.forEach((e, k) => {
      const cur = app.seq.playing && song.on && app.seq.songIdx === k;
      const chip = h('div', { class: 'song-item' + (cur ? ' cur' : '') },
        h('button', { class: 'si-main', title: 'Tocá para cambiar los compases', onclick: () => { snap('Canción'); e.bars = BARS[(BARS.indexOf(e.bars) + 1) % BARS.length]; render(); } },
          h('b', {}, 'P' + (e.pat + 1)), ` × ${e.bars}`),
        h('button', { class: 'x', onclick: () => { snap('Canción'); song.chain.splice(k, 1); render(); } }, '✕'));
      list.append(chip);
    });
    if (!song.chain.length) list.append(h('span', { class: 'hint' }, 'Agregá patrones abajo'));
  };
  render();
  const onPat = () => { if (document.body.contains(list)) render(); else app.off('pattern', onPat); };
  app.on('pattern', onPat);

  popover(anchor, [
    h('h4', {}, '🎼 Canción'),
    toggle('🎼 Modo canción', song.on, v => { song.on = v; app.emit('song'); }),
    list,
    h('div', { class: 'lbl' }, 'Agregar al final'),
    h('div', { class: 'btn-row' }, ...Array.from({ length: 8 }, (_, i) => h('button', { class: 'pat full', onclick: () => { snap('Canción'); song.chain.push({ pat: i, bars: 4 }); render(); } }, i + 1))),
    h('div', { class: 'hint' }, 'Con el modo canción encendido, Play arranca desde el principio de la cadena y cada parte cambia sola al terminar sus compases (con sus loops). Tocá una parte para cambiar cuántos compases dura.'),
  ], { cls: 'wide' });
}
