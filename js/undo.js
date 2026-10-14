// Deshacer / rehacer de varios niveles.
// Cada entrada sabe deshacerse y rehacerse; los patrones se guardan como "fotos" antes de editar.
import { app } from './app.js';
import { clonePattern } from './state.js';

const MAX = 40;
const past = [], future = [];
let lastKey = null, lastT = 0;

const changed = () => app.emit('undo-change');

export const undo = {
  get canUndo() { return past.length > 0; },
  get canRedo() { return future.length > 0; },

  push(entry) {
    past.push(entry);
    if (past.length > MAX) past.shift();
    future.length = 0;
    changed();
  },

  // Foto genérica: get() devuelve una copia del valor, set(v) lo restaura.
  // Llamar ANTES de modificar. Ediciones seguidas con la misma clave se agrupan.
  state(label, key, get, set) {
    const now = performance.now();
    if (key && key === lastKey && now - lastT < 1500) { lastT = now; return; }
    lastKey = key; lastT = now;
    const before = get();
    let after = null;
    this.push({ label, undo() { after = get(); set(before); }, redo() { set(after); } });
  },

  pattern(label, key = null) {
    const s = app.state, idx = s.current;
    this.state(label, key ? key + idx : null, () => clonePattern(s.patterns[idx]), v => {
      s.patterns[idx] = clonePattern(v); s.current = idx; app.emit('pattern');
    });
  },

  undo() {
    const e = past.pop();
    if (!e) { app.emit('toast', 'Nada para deshacer'); return; }
    lastKey = null;
    e.undo();
    future.push(e);
    app.emit('toast', '↶ ' + e.label);
    changed();
  },

  redo() {
    const e = future.pop();
    if (!e) { app.emit('toast', 'Nada para rehacer'); return; }
    e.redo();
    past.push(e);
    app.emit('toast', '↷ ' + e.label);
    changed();
  },
};
