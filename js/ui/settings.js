// Entrada de audio: dispositivo, monitoreo, umbral, latencia (manual y automática) y medidor.
import { app } from '../app.js';
import { A, getMic, listInputs, setMonitor, inputLevel, calibrateLatency, scheduleMicClose, setInputGain, micProcessing } from '../audio/engine.js';
import { h, popover, slider, toggle, toast } from './util.js';

const db = v => (v > 0 ? (20 * Math.log10(v)).toFixed(0) + ' dB' : '-∞');

export async function openInputSettings(anchor) {
  const s = app.state.settings;
  A.micPinned = true; // abierto mientras se ve este panel (para el medidor)
  try { await getMic(s.inputId); } catch (e) { toast('🎤 Sin acceso a la entrada de audio'); }
  const sel = h('select', { class: 'select' });
  const fill = async () => {
    const devs = await listInputs();
    sel.innerHTML = '';
    sel.append(h('option', { value: '' }, 'Predeterminada del sistema'));
    devs.forEach((d, k) => { if (d.deviceId && d.deviceId !== 'default') sel.append(h('option', { value: d.deviceId }, d.label || `Entrada ${k + 1}`)); });
    sel.value = s.inputId || '';
  };
  await fill();
  sel.addEventListener('change', async () => {
    s.inputId = sel.value; A.inputId = sel.value;
    try { await getMic(sel.value); toast('🎤 Entrada: ' + sel.selectedOptions[0].textContent); } catch (e) { toast('No pude abrir esa entrada'); }
  });
  navigator.mediaDevices.addEventListener?.('devicechange', fill);

  const fillBar = h('i'), peak = h('span', { class: 'hint' });
  const meter = h('div', { class: 'in-meter big on' }, fillBar);
  let hold = 0;
  const tick = () => {
    if (!document.body.contains(meter)) return;
    const l = inputLevel();
    hold = Math.max(l, hold * 0.97);
    fillBar.style.width = Math.min(100, Math.sqrt(l) * 100) + '%';
    fillBar.classList.toggle('clip', l > 0.97);
    peak.textContent = 'pico ' + db(hold);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Ganancia de entrada: a mano o automática (escucha unos segundos y deja el pico cerca de -6 dB)
  const gainSlider = slider({ label: 'Ganancia del micrófono', min: 0, max: 40, step: 1, value: s.inputGain || 0, fmt: v => '+' + v + ' dB', onInput: v => { s.inputGain = v; setInputGain(v); } });
  const autoBtn = h('button', { class: 'sbtn on' }, '✨ Ganancia automática');
  autoBtn.addEventListener('click', async () => {
    autoBtn.disabled = true;
    let pk = 0;
    const end = performance.now() + 4000;
    while (performance.now() < end) {
      autoBtn.textContent = `🎤 Tocá o cantá fuerte… ${Math.ceil((end - performance.now()) / 1000)}`;
      pk = Math.max(pk, inputLevel());
      await new Promise(r => setTimeout(r, 30));
    }
    autoBtn.disabled = false; autoBtn.textContent = '✨ Ganancia automática';
    const cur = Math.pow(10, (s.inputGain || 0) / 20), raw = pk / cur;
    if (raw < 0.0005) { toast('No llegó sonido: revisá que el micrófono esté enchufado en la hembra rosa'); return; }
    const dbv = Math.max(0, Math.min(40, Math.round(20 * Math.log10(0.35 / raw))));
    s.inputGain = dbv; setInputGain(dbv); gainSlider.set(dbv);
    toast(`🎚 Ganancia del micrófono: +${dbv} dB`);
  });

  const latSlider = slider({ label: 'Compensación de latencia', min: 0, max: 400, step: 1, value: s.micLatency, fmt: v => v + ' ms', onInput: v => { s.micLatency = v; } });
  const calBtn = h('button', { class: 'sbtn on' }, '🎯 Calibrar automáticamente');
  calBtn.addEventListener('click', async () => {
    calBtn.disabled = true; calBtn.textContent = '🔊 Escuchando clicks…';
    const ms = await calibrateLatency().catch(() => null);
    calBtn.disabled = false; calBtn.textContent = '🎯 Calibrar automáticamente';
    if (ms == null) { toast('No escuché los clicks: subí el volumen y acercá la tablet'); return; }
    s.micLatency = ms; s.micMeasured = true; latSlider.set(ms);
    toast(`⏱ Latencia medida: ${ms} ms`);
  });

  // Lo que el sistema le está haciendo al micrófono (si algo está prendido, puede "cortar y soltar")
  const pr = micProcessing();
  const on = [pr.eco && 'cancelación de eco', pr.ruido && 'supresión de ruido', pr.volumen && 'volumen automático'].filter(Boolean);
  const procInfo = h('div', { class: on.length ? 'warn' : 'hint' }, on.length
    ? `⚠ El sistema le aplica al micrófono: ${on.join(', ')}. Eso puede cortar y soltar la voz. En Samsung: bajá la cortina de arriba mientras Bloop usa el micrófono → "Modo de micrófono" → Estándar.`
    : `Entrada${pr.label ? ': ' + pr.label : ''} · sin procesamiento del sistema (según la tablet). Si igual la voz "corta y suelta", en Samsung revisá en la cortina de arriba "Modo de micrófono" → Estándar.`);

  popover(anchor, [
    h('h4', {}, 'Entrada de audio'),
    procInfo,
    h('div', { class: 'lbl' }, 'Dispositivo (micrófono interno o interfaz USB)'),
    h('div', { class: 'btn-row' }, sel, h('button', { class: 'sbtn', onclick: fill }, '🔄')),
    h('div', { class: 'row-between' }, meter, peak),
    gainSlider,
    autoBtn,
    h('div', { class: 'hint' }, 'Un micrófono dinámico enchufado directo llega bajito: subí la ganancia hasta que el medidor llegue más o menos a la mitad cuando tocás o cantás fuerte, nunca al rojo.'),
    toggle('🎧 Escuchar la entrada (monitoreo)', s.monitor, v => { s.monitor = v; setMonitor(v, s.monVol ?? 0.6); if (v) toast('Usá auriculares para evitar acople'); }),
    slider({ label: 'Volumen de la voz en vivo', value: s.monVol ?? 0.6, fmt: v => Math.round(v * 100) + '%', onInput: v => { s.monVol = v; setMonitor(s.monitor, v); } }),
    slider({ label: 'Umbral para grabar samples', min: 0.003, max: 0.3, step: 0.001, value: s.recThresh, fmt: db, onInput: v => { s.recThresh = v; } }),
    latSlider,
    calBtn,
    h('div', { class: 'hint' }, 'Calibrar: sin auriculares, con volumen alto. Suenan 5 clicks por el parlante y se mide cuánto tardan en volver por el micrófono. Con interfaz, conectá la salida a la entrada.'),
    h('div', { class: 'hint' }, 'La señal entra cruda: sin cancelación de eco, supresión de ruido ni ganancia automática.'),
  ], { cls: 'wide', onClose: () => { A.micPinned = false; scheduleMicClose(800); } });
}
