import { app } from '../app.js';
import { A, audioMode, setAudioMode, setShow, showTestTone } from '../audio/engine.js';
import { h, popover, closePopover, toast, slider, toggle, chips } from './util.js';
import { knob } from './knob.js';
import { setBpm, loadKit, exportWav, exportStems, exportProject, importProject } from '../actions.js';
import { clonePattern, newPattern, isPatternEmpty } from '../state.js';
import { showHelp } from './help.js';
import { undo } from '../undo.js';
import { input } from '../input.js';
import { openControllers } from './controllers.js';
import { openInputSettings } from './settings.js';
import { openSong } from './song.js';
import { setView } from './padview.js';
import { COUNT_OPTS } from './countin.js';
import { GRID_KEYS } from '../quant.js';

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
};

export function buildTopbar(el) {
  const s = app.state;

  const logo = h('canvas', { width: 80, height: 80 });
  const play = h('button', { class: 'round play', title: 'Play / Stop (espacio)', html: ICON.play, onclick: () => app.seq.toggle() });
  const rec = h('button', { class: 'round rec', title: 'Grabar en vivo (R)', html: ICON.rec, onclick: () => { app.seq.recording = !app.seq.recording; app.emit('rec'); } });
  const qBtn = h('button', { class: 'tb-btn q', title: 'Cuantización de la grabación en vivo' });
  qBtn.addEventListener('click', () => openQuant(qBtn));
  const metro = h('button', { class: 'round', title: 'Metrónomo', onclick: () => { s.metronome = !s.metronome; metro.classList.toggle('on', s.metronome); } }, '♩');
  metro.classList.toggle('on', s.metronome);
  input.target('act:play', { label: 'Play / Stop', kind: 'button', el: play, press: () => app.seq.toggle() });
  input.target('act:rec', { label: 'Grabar en vivo', kind: 'button', el: rec, press: () => { app.seq.recording = !app.seq.recording; app.emit('rec'); } });
  input.target('act:metro', { label: 'Metrónomo', kind: 'button', el: metro, press: () => { s.metronome = !s.metronome; metro.classList.toggle('on', s.metronome); } });

  // BPM: arrastrar vertical, rueda o doble toque para escribir
  const bpmNum = h('span', {}, Math.round(s.bpm));
  const bpm = h('div', { class: 'bpm', title: 'Arrastrá para cambiar el tempo' }, h('div', {}, bpmNum, h('small', {}, 'BPM')));
  let drag = null, lastTap = 0;
  bpm.addEventListener('pointerdown', e => {
    const now = performance.now();
    if (now - lastTap < 300) { const v = prompt('Tempo (BPM)', s.bpm); if (v) setBpm(+v); return; }
    lastTap = now;
    bpm.setPointerCapture(e.pointerId); drag = { y: e.clientY, v: s.bpm };
  });
  bpm.addEventListener('pointermove', e => { if (drag) setBpm(drag.v + (drag.y - e.clientY) / 4); });
  bpm.addEventListener('pointerup', () => { drag = null; });
  bpm.addEventListener('wheel', e => { e.preventDefault(); setBpm(s.bpm - Math.sign(e.deltaY)); }, { passive: false });
  input.target('p:bpm', { label: 'Tempo', kind: 'value', el: bpm, get: () => (s.bpm - 40) / 180, set: v => setBpm(40 + v * 180) });
  const taps = [];
  const tapTempo = () => {
    const t = performance.now();
    if (taps.length && t - taps.at(-1) > 2000) taps.length = 0;
    taps.push(t); if (taps.length > 5) taps.shift();
    if (taps.length >= 3) setBpm(60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1)));
  };
  const tap = h('button', { class: 'round small-txt', title: 'Tap tempo', onclick: tapTempo }, 'tap');
  input.target('act:tap', { label: 'Tap tempo', kind: 'button', el: tap, press: tapTempo });
  const swing = knob({ label: 'Swing', value: s.swing, def: 0, size: 38, color: '#fecb57', learn: 'p:swing', fmt: v => Math.round(50 + v * 25) + '%', onInput: v => { s.swing = v; } });
  input.target('p:swing', { label: 'Swing', kind: 'value', get: () => s.swing, set: v => { s.swing = v; swing.set(v); } });

  // Deshacer / rehacer
  const undoBtn = h('button', { class: 'round', title: 'Deshacer', onclick: () => undo.undo() }, '↶');
  const redoBtn = h('button', { class: 'round', title: 'Rehacer', onclick: () => undo.redo() }, '↷');
  input.target('act:undo', { label: 'Deshacer', kind: 'button', el: undoBtn, press: () => undo.undo() });
  input.target('act:redo', { label: 'Rehacer', kind: 'button', el: redoBtn, press: () => undo.redo() });
  const updUndo = () => { undoBtn.disabled = !undo.canUndo; redoBtn.disabled = !undo.canRedo; };
  app.on('undo-change', updUndo); updUndo();

  // Vistas: Pads (drum machine + loops) y Teclado (loops arriba + teclado abajo)
  const toggleView = v => setView(s.view === v ? 'main' : v);
  const viewBtn = h('button', { class: 'tb-btn view', title: 'Modo Pads: pads gigantes + loops' }, '🥁', h('span', {}, 'Pads'));
  const keysBtn = h('button', { class: 'tb-btn view', title: 'Modo Teclado: loops arriba + teclado abajo' }, '🎹', h('span', {}, 'Teclado'));
  viewBtn.addEventListener('click', () => toggleView('pads'));
  keysBtn.addEventListener('click', () => toggleView('keys'));
  input.target('act:view', { label: 'Modo Pads', kind: 'button', el: viewBtn, press: () => toggleView('pads') });
  input.target('act:viewkeys', { label: 'Modo Teclado', kind: 'button', el: keysBtn, press: () => toggleView('keys') });
  const updView = () => { viewBtn.classList.toggle('on', s.view === 'pads'); keysBtn.classList.toggle('on', s.view === 'keys'); };
  app.on('view', updView);

  // Patrones / scenes
  let copyMode = false;
  const pats = h('div', { class: 'pats' });
  const patBtns = [];
  for (let i = 0; i < 8; i++) {
    const b = h('button', { class: 'pat' }, i + 1);
    b.addEventListener('click', () => {
      if (copyMode) {
        undo.state(`Copiar patrón ${s.current + 1} → ${i + 1}`, null, () => clonePattern(s.patterns[i]), v => { s.patterns[i] = clonePattern(v); app.emit('pattern'); });
        s.patterns[i] = clonePattern(app.pattern);
        copyMode = false;
        toast(`📋 Patrón ${s.current + 1} → ${i + 1}`);
        renderPats(); return;
      }
      app.seq.goPattern(i);
    });
    input.target('pat:' + i, { label: `Patrón ${i + 1}`, kind: 'button', el: b, press: () => app.seq.goPattern(i) });
    patBtns.push(b); pats.append(b);
  }
  const patMenu = h('button', { class: 'round', title: 'Patrón: copiar, borrar' }, '⋯');
  patMenu.addEventListener('click', () => popover(patMenu, [
    h('h4', {}, `Patrón ${s.current + 1}`),
    h('button', { class: 'menu-item', onclick: () => { copyMode = true; closePopover(); renderPats(); toast('Tocá el patrón de destino'); } }, '📋 Copiar a otro patrón…'),
    h('button', { class: 'menu-item', onclick: () => {
      closePopover();
      undo.pattern('Borrar patrón');
      s.patterns[s.current] = newPattern(); app.emit('pattern');
    } }, '🗑 Borrar este patrón'),
    h('div', { class: 'hint' }, 'Cada patrón es una scene: guarda el beat, el synth y qué loops suenan. Muteá loops dentro de un patrón y lo recuerda.'),
  ]));
  const songBtn = h('button', { class: 'tb-btn', title: 'Modo canción' }, '🎼');
  songBtn.addEventListener('click', () => openSong(songBtn));
  function renderPats() {
    patBtns.forEach((b, i) => {
      b.classList.toggle('cur', i === s.current);
      b.classList.toggle('queued', i === s.queued);
      b.classList.toggle('full', !isPatternEmpty(s.patterns[i]));
      b.classList.toggle('copy-target', copyMode && i !== s.current);
    });
    songBtn.classList.toggle('on', s.song.on);
  }

  // Controladores
  const ctrlBtn = h('button', { class: 'tb-btn ctrl', title: 'Controladores y asignaciones' }, '🎛', h('span', { class: 'ctrl-n' }));
  ctrlBtn.addEventListener('click', () => openControllers(ctrlBtn));
  const updCtrl = () => {
    const n = [...input.devices.values()].filter(d => d.connected && d.type !== 'keys').length;
    ctrlBtn.lastChild.textContent = n ? ' ' + n : '';
    ctrlBtn.classList.toggle('has', n > 0);
    ctrlBtn.classList.toggle('on', input.learn.on);
  };
  app.on('devices', updCtrl); app.on('learn', updCtrl); updCtrl();
  app.on('device-activity', () => { ctrlBtn.classList.remove('blink'); void ctrlBtn.offsetWidth; ctrlBtn.classList.add('blink'); });

  const master = knob({ label: 'Master', value: s.master, def: 0.8, size: 38, color: '#7cf0b0', learn: 'p:master', onInput: v => { s.master = v; A.master.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); } });
  input.target('p:master', { label: 'Volumen master', kind: 'value', get: () => s.master, set: v => { s.master = v; master.set(v); A.master.gain.setTargetAtTime(v, A.ctx.currentTime, 0.02); } });
  const meterFill = h('i');
  const meter = h('div', { class: 'meter', title: 'Salida' }, meterFill);
  const menu = h('button', { class: 'round', title: 'Menú' }, '☰');
  menu.addEventListener('click', () => openMenu(menu));

  el.append(
    h('div', { class: 'logo' }, logo, h('span', {}, 'bloop')),
    h('div', { class: 'tb-group' }, play, rec, qBtn, metro),
    h('div', { class: 'tb-group' }, bpm, tap, swing.el),
    h('div', { class: 'tb-group' }, viewBtn, keysBtn, undoBtn, redoBtn),
    h('div', { class: 'tb-group' }, pats, patMenu, songBtn),
    h('div', { class: 'tb-spacer' }),
    h('div', { class: 'tb-group' }, ctrlBtn, master.el, meter, menu),
  );

  const updQ = () => {
    const q = s.recQuant;
    qBtn.textContent = q.on ? `Q ${q.grid || '1/16'}` + (q.amount < 1 ? ` ${Math.round(q.amount * 100)}%` : '') : 'Q off';
    qBtn.classList.toggle('on', q.on);
  };
  updQ();
  function openQuant(anchor) {
    const q = s.recQuant;
    popover(anchor, [
      h('h4', {}, 'Cuantizar grabación en vivo'),
      toggle(q.on ? 'Cuantizar: sí' : 'Cuantizar: no', q.on, v => { q.on = v; anchor.focus(); updQ(); closePopover(); openQuant(anchor); }),
      h('div', { class: 'lbl' }, 'Grilla'),
      chips(GRID_KEYS.map(g => [g, g.replace('T', ' tresillo')]), q.grid || '1/16', v => { q.grid = v; updQ(); }),
      h('div', { class: 'hint' }, '1/16 para casi todo · 1/8 si tocás simple y querés que quede bien firme · 1/32 para redobles y hi-hats rápidos · tresillos para shuffle y trap. El swing de arriba se respeta.'),
      slider({ label: 'Intensidad', value: q.amount, step: 0.05, fmt: v => Math.round(v * 100) + '%', onInput: v => { q.amount = v; updQ(); } }),
      h('div', { class: 'hint' }, '100% = todo cae justo en la grilla. Menos = conserva parte de tu groove (como en Ableton). Sin cuantizar se guarda tu timing real. Vale para los pasos y para los loops con 🎹.'),
      h('div', { class: 'lbl' }, '⏱ Cuenta regresiva'),
      chips(COUNT_OPTS, s.countIn ?? 1, v => { s.countIn = +v; app.emit('countin-opt'); }),
      h('div', { class: 'hint' }, 'Con todo parado, al grabar un loop (o dar play con ⏺ activado) suenan clicks antes de empezar.'),
    ]);
  }

  app.on('transport', () => { play.classList.toggle('on', app.seq.playing); play.innerHTML = app.seq.playing ? ICON.stop : ICON.play; renderPats(); });
  app.on('rec', () => rec.classList.toggle('on', app.seq.recording));
  app.on('bpm', () => { bpmNum.textContent = Math.round(s.bpm); });
  ['pattern', 'pattern-edit', 'pattern-queue', 'song', 'loops'].forEach(ev => app.on(ev, renderPats));
  renderPats();

  // Animación del logo + vúmetro
  const lc = logo.getContext('2d');
  const data = new Uint8Array(A.analyser.fftSize);
  let level = 0, ph = 0;
  return function frame(dt) {
    A.analyser.getByteTimeDomainData(data);
    let pk = 0;
    for (let i = 0; i < data.length; i += 2) pk = Math.max(pk, Math.abs(data[i] - 128) / 128);
    level = Math.max(pk, level * 0.9);
    meterFill.style.height = Math.min(100, level * 100) + '%';
    if (s.settings.eco) return;
    ph += dt * (1 + level * 4);
    lc.clearRect(0, 0, 80, 80);
    const g = lc.createLinearGradient(0, 0, 80, 80);
    g.addColorStop(0, '#ff8ed4'); g.addColorStop(0.5, '#c792ff'); g.addColorStop(1, '#48dbb4');
    lc.fillStyle = g;
    lc.beginPath();
    for (let a = 0; a <= 64; a++) {
      const t = a / 64 * Math.PI * 2;
      const r = 28 + 3 * Math.sin(t * 3 + ph * 1.3) + 2 * Math.sin(t * 5 - ph) + level * 9 * Math.sin(t * 7 + ph * 3);
      const x = 40 + Math.cos(t) * r, y = 40 + Math.sin(t) * r;
      a ? lc.lineTo(x, y) : lc.moveTo(x, y);
    }
    lc.fill();
  };
}

export function toggleFullscreen() {
  const d = document;
  if (!d.fullscreenElement) {
    d.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  } else d.exitFullscreen?.();
}

function openMenu(anchor) {
  const s = app.state;
  const applyShow = () => setShow(!!s.settings.show, s.settings.showMon ?? 0.8, s.settings.showClick ?? 0.7);
  const file = h('input', { type: 'file', accept: '.bloop,.zip,application/zip,application/octet-stream', hidden: true, onchange: e => { const f = e.target.files[0]; if (f && confirm('¿Reemplazar el proyecto actual por el del archivo?')) { closePopover(); importProject(f); } } });
  popover(anchor, [
    h('h4', {}, 'Bloop'),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); showHelp(); } }, '❓ Cómo se usa'),
    h('div', { class: 'hint' }, `Versión ${app.version || 'local'} · se actualiza sola al abrirla con internet`),
    h('div', { class: 'lbl' }, 'Pantalla'),
    h('div', { class: 'btn-row' },
      toggle('☀️ Modo sol', s.settings.theme === 'light', v => { s.settings.theme = v ? 'light' : 'dark'; app.emit('display'); }, 'sbtn'),
      toggle('🔋 Ahorro', s.settings.eco, v => { s.settings.eco = v; app.emit('display'); }, 'sbtn'),
      h('button', { class: 'sbtn', onclick: () => { closePopover(); toggleFullscreen(); } }, '⛶ Pantalla completa')),
    h('div', { class: 'lbl' }, 'Audio'),
    chips([['stable', '🛡️ Estable (tablet)'], ['fast', '⚡ Baja latencia']], audioMode(), v => { setAudioMode(v); toast('Se aplica la próxima vez que abras Bloop'); }),
    h('div', { class: 'hint' }, `Latencia actual: ${Math.round(((A.ctx.baseLatency || 0) + (A.ctx.outputLatency || 0)) * 1000)} ms. Si el sonido se corta o chisporrotea, usá Estable y el modo 🔋 Ahorro.`),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openInputSettings(anchor); } }, '🎤 Entrada de audio, latencia y monitoreo'),
    h('div', { class: 'lbl' }, '🎧 Modo show (en vivo)'),
    toggle('🎧 Izquierda: público · Derecha: mis auriculares', !!s.settings.show, v => {
      s.settings.show = v; applyShow();
      toast(v ? '🎧 Modo show: el click y tu volumen de auriculares van solo por la derecha' : 'Salida estéreo normal');
    }),
    slider({ label: 'Volumen de mis auriculares', value: s.settings.showMon ?? 0.8, fmt: v => Math.round(v * 100) + '%', onInput: v => { s.settings.showMon = v; applyShow(); } }),
    slider({ label: 'Volumen del click (solo auriculares)', value: s.settings.showClick ?? 0.7, fmt: v => Math.round(v * 100) + '%', onInput: v => { s.settings.showClick = v; applyShow(); } }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'sbtn', onclick: () => showTestTone(0) }, '🔊 Probar público (izq.)'),
      h('button', { class: 'sbtn', onclick: () => showTestTone(1) }, '🎧 Probar auriculares (der.)')),
    h('div', { class: 'hint' }, 'Usá un cable 3,5 mm a 2 RCA: blanco (izquierda) al parlante o consola, rojo (derecha) a tus auriculares. Cada lado sale en mono. El metrónomo y la cuenta regresiva suenan solo en tus auriculares.'),
    h('div', { class: 'lbl' }, 'Cargar kit completo'),
    h('div', { class: 'btn-row' }, ...app.kits.map((k, i) => h('button', { class: 'sbtn', onclick: () => { closePopover(); loadKit(i); } }, k.name))),
    h('div', { class: 'lbl' }, 'Exportar mezcla (WAV)'),
    h('div', { class: 'btn-row' }, ...[2, 4, 8, 16].map(b => h('button', { class: 'sbtn', onclick: () => { closePopover(); exportWav(b); } }, `${b} comp.`))),
    h('div', { class: 'lbl' }, 'Exportar stems (ZIP con un WAV por pista y loop)'),
    h('div', { class: 'btn-row' }, ...[4, 8, 16, 32].map(b => h('button', { class: 'sbtn', onclick: () => { closePopover(); exportStems(b); } }, `${b} comp.`))),
    h('div', { class: 'lbl' }, 'Proyecto'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'sbtn', onclick: () => { closePopover(); exportProject(); } }, '💾 Guardar archivo'),
      h('button', { class: 'sbtn', onclick: () => file.click() }, '📂 Abrir archivo'), file,
      h('button', { class: 'sbtn', onclick: () => {
        if (!confirm('¿Empezar un proyecto nuevo? Se borra el actual (patrones, samples grabados y loops). Podés guardarlo antes como archivo.')) return;
        app.emit('reset');
      } }, '✨ Nuevo')),
  ]);
}
