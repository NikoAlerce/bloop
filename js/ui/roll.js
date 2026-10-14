// Piano roll táctil sobre canvas para el synth.
import { ink, shade, isLight } from './util.js';
import { app } from '../app.js';
import { A } from '../audio/engine.js';
import { MAX_STEPS } from '../state.js';
import { undo } from '../undo.js';
import { scaleActive, inScale } from '../scales.js';

const BLACK = [1, 3, 6, 8, 10];
const GUTTER = 38;

export class Roll {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'roll';
    this.g = this.canvas.getContext('2d');
    this.low = 40; this.rows = 24;
    this.play = -1;
    this.drags = new Map();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointercancel', e => this.up(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => { e.preventDefault(); this.wheel(e); }, { passive: false });
  }

  get ps() { return app.pattern.synth; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    this.W = r.width; this.H = r.height;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rows = Math.max(14, Math.min(36, Math.round(r.height / 11)));
    this.fit();
    this.draw();
  }

  // Centra la vista en las notas existentes
  fit() {
    const ns = this.ps.notes;
    if (!ns.length) return;
    const lo = Math.min(...ns.map(n => n.midi)), hi = Math.max(...ns.map(n => n.midi));
    if (lo >= this.low && hi < this.low + this.rows) return;
    this.low = Math.max(12, Math.round((lo + hi) / 2 - this.rows / 2));
  }

  scroll(d) { this.low = Math.max(12, Math.min(96, this.low + d)); this.draw(); }

  get cw() { return (this.W - GUTTER) / MAX_STEPS; }
  get ch() { return this.H / this.rows; }
  cell(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, step: Math.floor((x - GUTTER) / this.cw), midi: this.low + this.rows - 1 - Math.floor(y / this.ch) };
  }
  noteAt(step, midi) { return this.ps.notes.find(n => n.midi === midi && step >= n.step && step < n.step + n.len); }

  audition(midi) { app.synth.playNote(midi, 0.75, A.ctx.currentTime + 0.01, 0.22); }

  down(e) {
    const c = this.cell(e);
    if (c.x < GUTTER) { this.audition(c.midi); return; }
    if (c.step < 0 || c.step >= MAX_STEPS) return;
    this.canvas.setPointerCapture(e.pointerId);
    undo.pattern('Notas');
    const n = this.noteAt(c.step, c.midi);
    if (n) {
      if (e.button === 2) { this.remove(n); return; }
      const atEnd = c.step === n.step + n.len - 1 && n.len > 1 || ((c.x - GUTTER) / this.cw - n.step - n.len) > -0.35;
      this.drags.set(e.pointerId, { n, mode: atEnd ? 'resize' : 'move', c0: c, orig: { ...n }, moved: false });
    } else {
      if (e.button !== 0) return;
      const nn = { step: c.step, midi: c.midi, len: 1, vel: 0.8 };
      this.ps.notes.push(nn);
      this.audition(c.midi);
      this.drags.set(e.pointerId, { n: nn, mode: 'resize', c0: c, orig: { ...nn }, moved: true, created: true });
      this.changed();
    }
  }

  move(e) {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    const c = this.cell(e);
    const ds = c.step - d.c0.step, dm = c.midi - d.c0.midi;
    if (ds || dm) d.moved = true;
    if (d.mode === 'resize') {
      d.n.len = Math.max(1, Math.min(MAX_STEPS - d.n.step, d.orig.len + ds));
    } else {
      const midi = d.orig.midi + dm;
      if (midi !== d.n.midi) this.audition(midi);
      d.n.step = Math.max(0, Math.min(MAX_STEPS - d.n.len, d.orig.step + ds));
      d.n.midi = midi;
    }
    this.changed();
  }

  up(e) {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    this.drags.delete(e.pointerId);
    if (!d.moved && !d.created) this.remove(d.n);
    // Evita notas duplicadas en la misma celda
    const ns = this.ps.notes;
    this.ps.notes = ns.filter(n => n === d.n || !(n.step === d.n.step && n.midi === d.n.midi));
    this.changed();
  }

  wheel(e) {
    const c = this.cell(e), n = this.noteAt(c.step, c.midi);
    if (n) { undo.pattern('Velocity', 'vel'); n.vel = Math.max(0.1, Math.min(1, n.vel - Math.sign(e.deltaY) * 0.05)); this.changed(); }
    else this.scroll(e.deltaY > 0 ? -1 : 1);
  }

  remove(n) { this.ps.notes = this.ps.notes.filter(x => x !== n); this.changed(); }
  changed() { this.draw(); app.emit('pattern-edit'); }

  setPlayhead(eff) { this.play = eff; this.draw(); }

  draw() {
    const g = this.g, W = this.W, H = this.H;
    if (!W) return;
    const cw = this.cw, ch = this.ch, len = this.ps.len;
    g.clearRect(0, 0, W, H);
    g.fillStyle = (isLight() ? 'rgba(60,40,90,0.22)' : 'rgba(0,0,0,0.22)'); g.fillRect(0, 0, W, H);
    for (let r = 0; r < this.rows; r++) {
      const midi = this.low + this.rows - 1 - r, pc = midi % 12, y = r * ch;
      const black = BLACK.includes(pc);
      if (black) { g.fillStyle = (isLight() ? 'rgba(60,40,90,0.18)' : 'rgba(0,0,0,0.18)'); g.fillRect(GUTTER, y, W - GUTTER, ch); }
      if (scaleActive()) { g.fillStyle = inScale(midi) ? 'rgba(199,146,255,0.07)' : (isLight() ? 'rgba(60,40,90,0.28)' : 'rgba(0,0,0,0.28)'); g.fillRect(GUTTER, y, W - GUTTER, ch); }
      g.fillStyle = black ? '#2b2335' : '#e8def5';
      g.fillRect(0, y + 0.5, GUTTER - 4, ch - 1);
      if (pc === 0) {
        g.fillStyle = ink(0.12); g.fillRect(GUTTER, y + ch - 1, W - GUTTER, 1);
        g.fillStyle = '#5b4c70'; g.font = '700 9px system-ui'; g.fillText('C' + (Math.floor(midi / 12) - 1), 4, y + ch - 4);
      }
    }
    for (let k = 0; k <= MAX_STEPS; k++) {
      const x = GUTTER + k * cw;
      g.fillStyle = k % 4 === 0 ? ink(0.12) : ink(0.04);
      g.fillRect(x, 0, 1, H);
    }
    if (len < MAX_STEPS) { g.fillStyle = shade(0.6); g.fillRect(GUTTER + len * cw, 0, W, H); }
    if (this.play >= 0) {
      g.fillStyle = ink(0.1);
      g.fillRect(GUTTER + (this.play % len) * cw, 0, cw, H);
    }
    for (const n of this.ps.notes) {
      const r = this.low + this.rows - 1 - n.midi;
      if (r < 0 || r >= this.rows) continue;
      const x = GUTTER + (n.step + (n.nudge || 0)) * cw + 1.5, y = r * ch + 1.5, w = n.len * cw - 3, hh = ch - 3;
      const active = this.play >= 0 && (this.play % len) >= n.step && (this.play % len) < n.step + n.len;
      const grd = g.createLinearGradient(x, 0, x + w, 0);
      grd.addColorStop(0, '#ff8ed4'); grd.addColorStop(1, '#c792ff');
      g.globalAlpha = 0.45 + 0.55 * n.vel;
      g.fillStyle = active ? '#ffffff' : grd;
      g.beginPath(); g.roundRect ? g.roundRect(x, y, w, hh, Math.min(6, hh / 2)) : g.rect(x, y, w, hh); g.fill();
      g.globalAlpha = 1;
      g.fillStyle = (isLight() ? 'rgba(60,40,90,0.35)' : 'rgba(0,0,0,0.35)'); g.fillRect(x + w - 5, y + 3, 2, hh - 6);
    }
    // Notas fuera de vista: indicadores
    const above = this.ps.notes.some(n => n.midi >= this.low + this.rows), below = this.ps.notes.some(n => n.midi < this.low);
    g.fillStyle = '#ff8ed4';
    if (above) { g.beginPath(); g.moveTo(W / 2 - 8, 8); g.lineTo(W / 2 + 8, 8); g.lineTo(W / 2, 1); g.fill(); }
    if (below) { g.beginPath(); g.moveTo(W / 2 - 8, H - 8); g.lineTo(W / 2 + 8, H - 8); g.lineTo(W / 2, H - 1); g.fill(); }
  }
}
