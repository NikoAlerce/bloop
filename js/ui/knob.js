// Perilla táctil: arrastrá vertical (o horizontal), doble toque = valor por defecto.
import { h, clamp } from './util.js';

const START = -135, END = 135;
const pol = (cx, cy, r, a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
function arc(cx, cy, r, a0, a1) {
  if (Math.abs(a1 - a0) < 0.5) return '';
  const [x0, y0] = pol(cx, cy, r, a0), [x1, y1] = pol(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
  return `M${x0} ${y0}A${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}

export function knob({ label, min = 0, max = 1, value = 0, def, step = 0, fmt, onInput, bipolar = false, size = 52, color, learn }) {
  def = def ?? value;
  fmt = fmt || (v => (max - min > 2 ? Math.round(v) : Math.round((v - min) / (max - min) * 100)) + '');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); return e; };
  mk('path', { d: arc(26, 26, 20, START, END), class: 'k-track' });
  const val = mk('path', { class: 'k-val' });
  mk('circle', { cx: 26, cy: 26, r: 13.5, class: 'k-body' });
  const dot = mk('circle', { r: 2.6, class: 'k-dot' });

  const lab = h('div', { class: 'k-label' }, label);
  const el = h('div', { class: 'knob' }, svg, lab);
  if (color) el.style.setProperty('--c', color);
  if (learn) el.dataset.learn = learn;

  let v = value;
  const norm = () => (v - min) / (max - min);
  const draw = () => {
    const a = START + norm() * (END - START);
    const a0 = bipolar ? 0 : START;
    val.setAttribute('d', a > a0 ? arc(26, 26, 20, a0, a) : arc(26, 26, 20, a, a0));
    const [x, y] = pol(26, 26, 9, a);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
  };
  const setV = (nv, emit = true) => {
    nv = clamp(nv, min, max);
    if (step) nv = Math.round(nv / step) * step;
    if (nv === v) return;
    v = nv; draw();
    if (emit) { lab.textContent = fmt(v); onInput && onInput(v); }
  };

  let drag = null, lastTap = 0;
  svg.addEventListener('pointerdown', e => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap < 300) { setV(def); lastTap = 0; return; }
    lastTap = now;
    svg.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, v };
    el.classList.add('active');
    lab.textContent = fmt(v);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const d = (drag.y - e.clientY) + (e.clientX - drag.x) * 0.6;
    const range = e.shiftKey ? 900 : 180;
    setV(drag.v + d / range * (max - min));
  });
  const end = () => { if (!drag) return; drag = null; el.classList.remove('active'); setTimeout(() => { if (!drag) lab.textContent = label; }, 700); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    setV(v - Math.sign(e.deltaY) * (step || (max - min) / 100));
    lab.textContent = fmt(v);
    clearTimeout(el._t); el._t = setTimeout(() => { lab.textContent = label; }, 800);
  }, { passive: false });

  draw();
  return { el, set: nv => { v = clamp(nv, min, max); draw(); }, get: () => v };
}
