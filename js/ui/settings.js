// Entrada de audio: dispositivo, monitoreo, umbral, latencia (manual y automática) y medidor.
import { app } from '../app.js';
import { A, getMic, listInputs, setMonitor, inputLevel, calibrateLatency, scheduleMicClose, setInputGain, micProcessing, capture, micHold, micRelease } from '../audio/engine.js';
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

  // Prueba de entrada: graba 8 s del micrófono, dibuja el nivel y lo hace escuchar.
  // Sirve para ver si la señal ya llega cortada desde la tablet.
  const testCv = h('canvas', { class: 'in-test', width: 520, height: 90 });
  const testInfo = h('div', { class: 'hint' });
  const testBtn = h('button', { class: 'sbtn' }, '🔬 Probar la entrada (8 s)');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    const node = await getMic(s.inputId).catch(() => null);
    if (!node) { testBtn.disabled = false; toast('🎤 Sin acceso a la entrada de audio'); return; }
    micHold();
    const job = capture(node, A.ctx.currentTime + 0.05, 8);
    const rawJob = A.micSrc ? capture(A.micSrc, A.ctx.currentTime + 0.05, 8) : null;
    const t0 = performance.now();
    const iv = setInterval(() => { testBtn.textContent = `🎙 Cantá una nota larga y pareja… ${Math.max(0, 8 - Math.floor((performance.now() - t0) / 1000))}`; }, 200);
    const buf = await job.promise;
    clearInterval(iv); micRelease();
    testBtn.disabled = false; testBtn.textContent = '🔬 Probar la entrada (8 s)';
    // Diagnóstico de la entrada cruda (antes de la ganancia y los filtros de Bloop)
    const raw = rawJob ? await rawJob.promise : null;
    let diag = '';
    if (raw) {
      const r0 = raw.getChannelData(0), sr0 = raw.sampleRate;
      let mean = 0, clip = 0;
      for (const v of r0) { mean += v; if (Math.abs(v) > 0.97) clip++; }
      mean /= r0.length;
      // energía en 50 y 100 Hz (zumbido de la red) comparada con el total
      const goertzel = f => { const k = 2 * Math.cos(2 * Math.PI * f / sr0); let s1 = 0, s2 = 0; for (const v of r0) { const s0 = v - mean + k * s1 - s2; s2 = s1; s1 = s0; } return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / r0.length * 2; };
      let tot = 0; for (const v of r0) tot += (v - mean) ** 2; tot = Math.sqrt(tot / r0.length);
      const hum = Math.max(goertzel(50), goertzel(100), goertzel(150)) / Math.SQRT2;
      if (Math.abs(mean) > 0.05) diag = `⚠ Hay corriente continua en la entrada (${Math.round(Math.abs(mean) * 100)}% de escala): la tablet le manda alimentación al micrófono y el plug no la está aislando. `;
      if (tot > 0.05 && hum > tot * 0.5) diag += '⚠ Hay un zumbido fuerte de 50 Hz: la tierra del plug no hace buen contacto (típico del plug a medio meter). ';
      if (clip / r0.length > 0.01) diag += `⚠ La señal está al tope el ${Math.round(clip / r0.length * 100)}% del tiempo: la voz queda aplastada. `;
      if (diag) diag += 'Probá con el cable XLR a 3,5 enchufado hasta el fondo.';
    }
    // Nivel cada 20 ms
    const d = buf.getChannelData(0), win = Math.round(buf.sampleRate * 0.02), lv = [];
    for (let i = 0; i + win <= d.length; i += win) { let e = 0; for (let j = i; j < i + win; j++) e += d[j] * d[j]; lv.push(Math.sqrt(e / win)); }
    const g = testCv.getContext('2d'), W = testCv.width, H = testCv.height;
    const css = getComputedStyle(document.body);
    g.clearRect(0, 0, W, H);
    const toY = v => H - Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-6) + 60) / 60)) * H;
    g.strokeStyle = css.color; g.lineWidth = 1.5; g.beginPath();
    lv.forEach((v, i) => { const x = i / (lv.length - 1) * W; i ? g.lineTo(x, toY(v)) : g.moveTo(x, toY(v)); });
    g.stroke();
    // ¿Se corta? cuántas veces el nivel cae de golpe más de 15 dB y vuelve
    const dbs = lv.map(v => 20 * Math.log10(v + 1e-6));
    const loud = dbs.filter(x => x > -50), med = loud.sort((a, b) => a - b)[Math.floor(loud.length / 2)] ?? -90;
    let cuts = 0, inCut = false;
    for (const x of dbs) { if (!inCut && med > -50 && x < med - 15) { cuts++; inCut = true; } else if (inCut && x > med - 6) inCut = false; }
    testInfo.textContent = diag || (med <= -50 ? 'Llegó muy poco sonido: subí la ganancia o acercá el micrófono.'
      : cuts >= 3 ? `La señal se corta ${cuts} veces en 8 s ya al entrar a la tablet: el corte no lo hace Bloop. Mandame una captura de este gráfico.`
      : 'La señal entra pareja: el micrófono llega bien a la tablet. Escuchala abajo.');
    testInfo.className = diag ? 'warn' : 'hint';
    const src = A.ctx.createBufferSource(); src.buffer = buf; src.connect(A.master); src.start();
  });

  popover(anchor, [
    h('h4', {}, 'Entrada de audio'),
    procInfo,
    h('div', { class: 'lbl' }, 'Dispositivo (micrófono interno o interfaz USB)'),
    h('div', { class: 'btn-row' }, sel, h('button', { class: 'sbtn', onclick: fill }, '🔄')),
    h('div', { class: 'row-between' }, meter, peak),
    gainSlider,
    autoBtn,
    testBtn, testCv, testInfo,
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
