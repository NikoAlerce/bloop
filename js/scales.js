// Escalas para teclado, pads y MIDI.
import { app } from './app.js';

export const SCALES = {
  chromatic: { name: 'Cromática', iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { name: 'Mayor', iv: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Menor', iv: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { name: 'Dórica', iv: [0, 2, 3, 5, 7, 9, 10] },
  harmMinor: { name: 'Menor armónica', iv: [0, 2, 3, 5, 7, 8, 11] },
  pentaMaj: { name: 'Pentatónica mayor', iv: [0, 2, 4, 7, 9] },
  pentaMin: { name: 'Pentatónica menor', iv: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', iv: [0, 3, 5, 6, 7, 10] },
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

const sc = () => app.state.scale;
export const scaleActive = () => sc().type !== 'chromatic';
export function inScale(midi) {
  const { root, type } = sc();
  return SCALES[type].iv.includes(((midi - root) % 12 + 12) % 12);
}
// Nota más cercana dentro de la escala (empata hacia abajo)
export function snap(midi) {
  if (!scaleActive() || inScale(midi)) return midi;
  for (let d = 1; d < 7; d++) { if (inScale(midi - d)) return midi - d; if (inScale(midi + d)) return midi + d; }
  return midi;
}
// Grado n de la escala a partir de una nota base (la tónica más cercana debajo de base)
export function degree(base, n) {
  const { root, type } = sc(), iv = SCALES[type].iv, L = iv.length;
  const tonic = base - (((base - root) % 12) + 12) % 12;
  const o = Math.floor(n / L), k = ((n % L) + L) % L;
  return tonic + o * 12 + iv[k];
}
export const scaleLabel = () => NOTE_NAMES[sc().root] + ' ' + SCALES[sc().type].name;
