export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function toast(msg, ms = 2200) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast' }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// Popover flotante; se cierra tocando afuera o con Escape.
let openPop = null;
export function popover(anchor, content, { onClose, cls = '' } = {}) {
  closePopover();
  const pop = h('div', { class: 'popover ' + cls }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let x = r.left + r.width / 2 - pr.width / 2;
  let y = r.bottom + 8;
  if (y + pr.height > innerHeight - 8) y = r.top - pr.height - 8;
  x = clamp(x, 8, innerWidth - pr.width - 8);
  y = clamp(y, 8, innerHeight - pr.height - 8);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  const away = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const esc = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc); });
  openPop = { pop, close() { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); pop.remove(); onClose && onClose(); } };
  return pop;
}
export function closePopover() { if (openPop) { const p = openPop; openPop = null; p.close(); } }

// Botón de chips (selector exclusivo)
export function chips(options, value, onPick, cls = '') {
  const wrap = h('div', { class: 'chips ' + cls });
  const set = (v) => [...wrap.children].forEach(c => c.classList.toggle('on', c.dataset.v === String(v)));
  options.forEach(o => {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    wrap.append(h('button', { class: 'chip', 'data-v': v, onclick: () => { set(v); onPick(v); } }, label));
  });
  set(value);
  wrap.set = set;
  return wrap;
}

// Botón con estado on/off
export function toggle(label, on, onChange, cls = '') {
  const b = h('button', { class: 'tog ' + cls + (on ? ' on' : '') }, label);
  b.addEventListener('click', () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); onChange(v); });
  b.set = v => b.classList.toggle('on', !!v);
  return b;
}

// Slider horizontal táctil
export function slider({ label, min = 0, max = 1, value, step = 0, fmt = v => v.toFixed(2), onInput, color }) {
  const fill = h('div', { class: 'sl-fill' });
  const val = h('span', { class: 'sl-val' });
  const track = h('div', { class: 'sl-track' }, fill);
  const el = h('div', { class: 'slider' }, h('div', { class: 'sl-head' }, h('span', {}, label), val), track);
  if (color) el.style.setProperty('--c', color);
  let v = value;
  const draw = () => { fill.style.width = ((v - min) / (max - min) * 100) + '%'; val.textContent = fmt(v); };
  const fromX = (x) => {
    const r = track.getBoundingClientRect();
    let nv = min + clamp((x - r.left) / r.width, 0, 1) * (max - min);
    if (step) nv = Math.round(nv / step) * step;
    if (nv !== v) { v = nv; draw(); onInput(v); }
  };
  track.addEventListener('pointerdown', e => { track.setPointerCapture(e.pointerId); fromX(e.clientX); });
  track.addEventListener('pointermove', e => { if (track.hasPointerCapture(e.pointerId)) fromX(e.clientX); });
  draw();
  el.set = nv => { v = nv; draw(); };
  return el;
}

export function fmtPct(v) { return Math.round(v * 100) + '%'; }

// Colores para canvas según el tema (oscuro / modo sol)
export const isLight = () => document.documentElement.dataset.theme === 'light';
export const ink = a => (isLight() ? `rgba(28,20,40,${a})` : `rgba(255,255,255,${a})`);
export const shade = a => (isLight() ? `rgba(255,250,240,${a})` : `rgba(10,8,14,${a})`);
