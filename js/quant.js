// Cuantización de lo que tocás en vivo (pasos y loops).
// Como en Ableton: una grilla (1/4, 1/8, 1/16, 1/32 o tresillos) y una intensidad (cuánto
// se acerca cada golpe a la grilla). El swing de Bloop se respeta: los 1/16 impares van
// atrasados, así lo cuantizado suena con el mismo swing que la batería.

// Tamaño de cada grilla en pasos de 1/16
export const GRIDS = { '1/4': 4, '1/8': 2, '1/8T': 4 / 3, '1/16': 1, '1/16T': 2 / 3, '1/32': 0.5 };
export const GRID_KEYS = ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T'];

// Posición en pasos tal como suena (con swing) → posición "derecha" (sin swing), y al revés.
// El swing corre el 1/16 impar de k+1 a k+1+sw dentro de cada par de pasos.
function unswing(p, sw) {
  if (!sw) return p;
  const m = Math.floor(p / 2) * 2, x = p - m, mid = 1 + sw;
  return m + (x < mid ? x / mid : 1 + (x - mid) / (1 - sw));
}
function reswing(u, sw) {
  if (!sw) return u;
  const m = Math.floor(u / 2) * 2, x = u - m, mid = 1 + sw;
  return m + (x < 1 ? x * mid : mid + (x - 1) * (1 - sw));
}

/**
 * p: posición en pasos de 1/16 tal como se escuchó.
 * Devuelve la posición en pasos SIN swing (como la guarda el secuenciador) y CON swing.
 */
export function quantize(p, q, swing) {
  const sw = Math.max(0, Math.min(0.9, swing * 0.5));
  const u = unswing(p, sw);
  let f = u;
  if (q.on) {
    const g = GRIDS[q.grid] || 1;
    f = u + (Math.round(u / g) * g - u) * q.amount;
  }
  return { straight: f, swung: reswing(f, sw) };
}
