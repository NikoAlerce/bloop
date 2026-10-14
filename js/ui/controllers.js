// Panel de controladores (MIDI, Bluetooth, teclados/pedales, gamepads) y barra del modo aprender.
import { app } from '../app.js';
import { input } from '../input.js';
import { h, popover, closePopover } from './util.js';

const TYPE = { midi: 'MIDI', ble: 'Bluetooth MIDI', keys: 'HID', gamepad: 'Gamepad' };
export const GLOBAL_ACTIONS = [
  ['act:play', 'Play / Stop'], ['act:next-pat', 'Siguiente scene'], ['act:prev-pat', 'Scene anterior'],
  ['act:loop-rec', 'Grabar / parar loop elegido'], ['act:loop-mute', 'Mutear loop elegido'],
  ['act:loop-next', 'Elegir loop siguiente'], ['act:loop-prev', 'Elegir loop anterior'],
  ['act:undo', 'Deshacer'], ['act:redo', 'Rehacer'], ['act:tap', 'Tap tempo'], ['act:rec', 'Grabar en vivo'],
  ['act:next-track', 'Pista siguiente'], ['act:prev-track', 'Pista anterior'],
];

export function openControllers(anchor) {
  const body = h('div', { class: 'ctrl-list' });
  const render = () => {
    body.innerHTML = '';
    const names = new Set([...input.devices.keys(), ...Object.keys(input.maps)]);
    for (const name of names) {
      const d = input.devices.get(name) || { name, type: 'midi', connected: false };
      const m = input.maps[name] || {};
      const entries = Object.entries(m);
      body.append(h('div', { class: 'dev' },
        h('div', { class: 'dev-head' },
          h('i', { class: 'dot' + (d.connected ? ' on' : '') }),
          h('b', {}, name), h('span', { class: 'hint' }, TYPE[d.type] || ''),
          h('div', { style: { flex: 1 } }),
          entries.length ? h('button', { class: 'sbtn', onclick: () => { if (confirm(`¿Borrar todas las asignaciones de ${name}?`)) input.clearDevice(name); } }, 'Borrar perfil') : null),
        ...entries.map(([id, tid]) => h('div', { class: 'map-row' },
          h('span', {}, input.inputLabel(name, id)), h('span', { class: 'arrow' }, '→'), h('span', {}, input.targetLabel(tid)),
          h('button', { class: 'x', onclick: () => input.unassign(name, id) }, '✕'))),
        !entries.length && d.type === 'keys' ? h('div', { class: 'hint' }, 'Por defecto: espacio = play, ← → / Re Pág / Av Pág = scene anterior/siguiente.') : null,
      ));
    }
  };
  render();
  const onCh = () => { if (document.body.contains(body)) render(); else { app.off('devices', onCh); app.off('mappings', onCh); } };
  app.on('devices', onCh); app.on('mappings', onCh);

  popover(anchor, [
    h('h4', {}, 'Controladores'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'sbtn on big', onclick: () => { closePopover(); input.setLearn(true); } }, '🎯 Asignar (modo aprender)'),
      h('button', { class: 'sbtn big', disabled: !input.bleSupported, onclick: () => input.connectBle() }, '🔵 Conectar Bluetooth MIDI')),
    body,
    h('div', { class: 'hint' },
      'MIDI USB y teclados/pedales Bluetooth se detectan solos (emparejá los pedales en Ajustes → Bluetooth de Android). ',
      'Cada controlador guarda su propio perfil de asignaciones y se carga solo al reconectarlo. Si se corta el Bluetooth, Bloop reintenta conectar.'),
  ], { cls: 'wide' });
}

// Barra flotante mientras está activo el modo aprender
export function buildLearnBar() {
  const status = h('div', { class: 'lb-status' });
  const acts = h('div', { class: 'lb-acts' }, ...GLOBAL_ACTIONS.map(([id, label]) => h('button', { class: 'chip', 'data-learn': id }, label)));
  const bar = h('div', { class: 'learn-bar', hidden: true },
    h('div', { class: 'lb-top' }, h('b', {}, '🎯 Modo asignar'), status, h('div', { style: { flex: 1 } }),
      h('button', { class: 'sbtn on no-learn', onclick: () => input.setLearn(false) }, 'Listo')),
    acts);
  document.body.append(bar);
  const upd = () => {
    bar.hidden = !input.learn.on;
    const t = input.learn.target;
    status.textContent = t ? `Ahora tocá, apretá o mové el control físico para «${input.targetLabel(t)}»` : 'Tocá un pad, loop, botón o perilla en pantalla (o una acción de abajo)';
    bar.classList.toggle('waiting', !!t);
    input.markMapped();
  };
  app.on('learn', upd); app.on('learn-target', upd); app.on('mappings', upd);
  upd();
}
