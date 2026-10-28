// Estética del Estudio: copia el tema oscuro por defecto de Ableton Live 11/12
// (grises planos, acentos naranja/amarillo, clips de color con el contenido en negro).
export const T = {
  font: '"Helvetica Neue", Helvetica, Arial, "Segoe UI", Roboto, sans-serif',
  bg: '#121212',
  lane: '#2b2b2b', laneAlt: '#282828', laneSel: '#353535', laneEdge: '#1b1b1b',
  ruler: '#1f1f1f', rulerText: '#a9a9a9',
  text: '#d9d9d9', dim: '#8a8a8a',
  accent: '#ffad3b',        // naranja de foco / selección
  loopOn: '#b7b7b7', loopOff: '#5a5a5a',
  timeSel: 'rgba(146,185,232,0.28)',
  playhead: '#f2f2f2', rec: '#ff4d4d',
  // Piano roll
  rollWhite: '#363636', rollBlack: '#2d2d2d', rollC: '#151515', keyW: '#d8d8d8', keyB: '#1d1d1d',
  outside: 'rgba(0,0,0,0.38)',
};
export const FONT = T.font;
export const ink = a => `rgba(255,255,255,${a})`;
export const dark = a => `rgba(0,0,0,${a})`;

// Mezcla un color #rrggbb con blanco (k>0) o negro (k<0)
export function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = k > 0 ? 255 : 0, a = Math.abs(k);
  r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
  return `rgb(${r},${g},${b})`;
}
