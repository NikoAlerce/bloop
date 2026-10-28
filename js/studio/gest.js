// Gestos para los lienzos del Estudio, pensados para tablet con lápiz:
//  · Lápiz y mouse editan directo (mover, estirar, dibujar). El botón del lápiz (o clic derecho)
//    abre el menú. Pasar el lápiz sin apoyar muestra qué vas a tocar.
//  · El dedo navega: arrastrar = desplazar, pellizcar = zoom, tocar = elegir, doble toque = abrir,
//    mantener apretado = agarrar (para mover con el dedo).
export function gestures(el, h) {
  const pts = new Map();
  let mode = null, drag = null, longT = null, pinch0 = null, lastTap = { t: 0, x: 0, y: 0 };
  const pos = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const direct = e => e.pointerType !== 'touch' || h.drawTouch?.();

  const tapped = (p, e) => {
    const now = performance.now();
    const dbl = now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24;
    lastTap = dbl ? { t: 0, x: 0, y: 0 } : { t: now, x: p.x, y: p.y };
    h.tap?.(p, e, dbl);
  };

  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const p = pos(e);
    pts.set(e.pointerId, { ...p, x0: p.x, y0: p.y, type: e.pointerType, t0: performance.now(), moved: false });
    h.hover?.(null);
    if (e.pointerType === 'touch' && pts.size === 2 && mode !== 'drag') {
      clearTimeout(longT);
      const [a, b] = [...pts.values()];
      mode = 'pinch';
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      h.pinchStart?.(pinch0);
      return;
    }
    if (pts.size > 1) return;
    if (e.button === 2 || (e.buttons & 2) || (e.pointerType === 'pen' && e.button === 5)) { mode = 'ctx'; h.context?.(p, e); return; }
    if (direct(e)) {
      drag = h.down?.(p, e) || null;
      mode = drag ? 'drag' : 'press';
      return;
    }
    // Dedo sobre una agarradera (borde de un clip o nota elegidos): se arrastra directo
    const grab = h.grab?.(p, e);
    if (grab) { drag = grab; mode = 'drag'; return; }
    mode = 'press';
    longT = setTimeout(() => {
      const q = pts.get(e.pointerId);
      if (!q || q.moved || mode !== 'press') return;
      drag = h.long?.(q, e) || null;
      if (drag) { mode = 'drag'; navigator.vibrate?.(12); }
    }, 430);
  });

  el.addEventListener('pointermove', e => {
    const p = pos(e);
    const q = pts.get(e.pointerId);
    if (!q) { if (e.pointerType !== 'touch') h.hover?.(p, e); return; }
    const dx = p.x - q.x, dy = p.y - q.y;
    q.x = p.x; q.y = p.y;
    if (Math.hypot(p.x - q.x0, p.y - q.y0) > (q.type === 'touch' ? 9 : 4)) q.moved = true;
    if (mode === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      h.pinch?.(d / pinch0.d, cx, cy, cx - pinch0.cx, cy - pinch0.cy);
      pinch0 = { d, cx, cy };
      return;
    }
    if (mode === 'drag') { drag?.move?.(p, e); return; }
    if (mode === 'press' && q.moved) {
      clearTimeout(longT);
      mode = 'pan';
    }
    if (mode === 'pan') h.pan?.(dx, dy, e);
  });

  const end = e => {
    const q = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    clearTimeout(longT);
    if (!q) return;
    const p = pos(e);
    if (mode === 'drag') { drag?.up?.(p, e, !q.moved); drag = null; if (!q.moved) tapped(p, e); }
    else if (mode === 'press' && !q.moved && e.type === 'pointerup') tapped(p, e);
    else if (mode === 'pan') h.panEnd?.();
    if (mode === 'pinch' && pts.size) return;
    if (!pts.size) mode = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', e => { if (!pts.size && e.pointerType !== 'touch') h.hover?.(null); });
  el.addEventListener('wheel', e => { e.preventDefault(); h.wheel?.(pos(e), e); }, { passive: false });
}

// Ancla invisible en un punto de la pantalla (para abrir un popover donde tocaste)
export function pointAnchor(x, y) {
  let a = document.getElementById('st-anchor');
  if (!a) { a = document.createElement('div'); a.id = 'st-anchor'; a.style.cssText = 'position:fixed;width:1px;height:1px;pointer-events:none'; document.body.append(a); }
  a.style.left = x + 'px'; a.style.top = y + 'px';
  return a;
}

// Lienzo nítido: ajusta el tamaño al elemento y a la densidad de la pantalla
export function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), hh = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}
