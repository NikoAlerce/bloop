// Entrada de audio: dispositivo, monitoreo, umbral, latencia (manual y automática) y medidor.
import { app } from '../app.js';
import { A, getMic, listInputs, setMonitor, inputLevel, calibrateLatency, scheduleMicClose } from '../audio/engine.js';
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

  popover(anchor, [
    h('h4', {}, 'Entrada de audio'),
    h('div', { class: 'lbl' }, 'Dispositivo (micrófono interno o interfaz USB)'),
    h('div', { class: 'btn-row' }, sel, h('button', { class: 'sbtn', onclick: fill }, '🔄')),
    h('div', { class: 'row-between' }, meter, peak),
    toggle('🎧 Escuchar la entrada (monitoreo)', s.monitor, v => { s.monitor = v; setMonitor(v); if (v) toast('Usá auriculares para evitar acople'); }),
    slider({ label: 'Umbral para grabar samples', min: 0.003, max: 0.3, step: 0.001, value: s.recThresh, fmt: db, onInput: v => { s.recThresh = v; } }),
    latSlider,
    calBtn,
    h('div', { class: 'hint' }, 'Calibrar: sin auriculares, con volumen alto. Suenan 5 clicks por el parlante y se mide cuánto tardan en volver por el micrófono. Con interfaz, conectá la salida a la entrada.'),
    h('div', { class: 'hint' }, 'La señal entra cruda: sin cancelación de eco, supresión de ruido ni ganancia automática.'),
  ], { cls: 'wide', onClose: () => { A.micPinned = false; scheduleMicClose(800); } });
}
