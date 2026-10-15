// Dock inferior con pestañas: Teclado · Sonido · FX
import { h } from './util.js';
import { buildKeyboard } from './keyboard.js';
import { buildParams } from './params.js';
import { buildFx } from './fx.js';
import { openMixer } from './mixer.js';
import { app } from '../app.js';

export function buildDock(el) {
  const kb = buildKeyboard();
  const params = buildParams();
  const fx = buildFx();
  const views = { keys: kb.el, sound: params.el, fx: fx.el };
  const tabs = h('div', { class: 'dock-tabs' });
  const holder = h('div', { style: { flex: 1, minWidth: 0, display: 'flex' } });
  const btns = {};
  let current = null;
  const show = k => {
    current = k;
    holder.innerHTML = ''; holder.append(views[k]);
    Object.entries(btns).forEach(([kk, b]) => b.classList.toggle('on', kk === k));
    if (k === 'keys') requestAnimationFrame(kb.refresh);
    if (k === 'sound') requestAnimationFrame(params.refresh);
  };
  [['keys', '🎹', 'Teclas'], ['sound', '🎛️', 'Sonido'], ['fx', '✨', 'FX']].forEach(([k, ic, lbl]) => {
    btns[k] = h('button', { class: 'dock-tab', onclick: () => show(k) }, h('div', {}, ic, h('span', {}, lbl)));
    tabs.append(btns[k]);
  });
  // El mixer se abre a pantalla completa
  tabs.append(h('button', { class: 'dock-tab', onclick: openMixer }, h('div', {}, '🎚️', h('span', {}, 'Mixer'))));
  el.append(tabs, holder);
  show('keys');
  // En el modo Teclado el dock muestra siempre las teclas
  app.on('view', () => { if (app.state.view === 'keys' && current !== 'keys') show('keys'); });
  return {
    keyboard: kb,
    show,
    frame() { if (current === 'fx') fx.frame(); },
  };
}
