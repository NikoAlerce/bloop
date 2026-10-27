// Contexto de audio, bus maestro, efectos de envío y grabación.
export const A = { ctx: null, outLat: 0 };

const DELAY_BEATS = { '1/16': 0.25, '1/8T': 1 / 3, '1/8': 0.5, '3/16': 0.75, '1/4': 1 };
export const DELAY_DIVS = Object.keys(DELAY_BEATS);

// Modo de audio: 'stable' usa un búfer algo más grande (sin cortes en tablets/teléfonos),
// 'fast' la menor latencia posible (computadoras potentes). Se guarda por dispositivo.
export function audioMode() {
  let m = null;
  try { m = localStorage.getItem('bloop-audio-mode'); } catch (e) { /* */ }
  if (m === 'stable' || m === 'fast') return m;
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'stable' : 'fast';
}
export function setAudioMode(m) { try { localStorage.setItem('bloop-audio-mode', m); } catch (e) { /* */ } }

export async function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  A.mode = audioMode();
  const ctx = A.ctx = new AC({ latencyHint: A.mode === 'stable' ? 'balanced' : 'interactive' });
  // Si Android tarda en dar el audio (otra app lo tiene, etc.) no nos quedamos esperando:
  // se reintenta con el próximo toque en pantalla.
  if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]);
  // Latencia leída siempre en vivo (al arrancar suele informar un valor menor al real)
  Object.defineProperty(A, 'outLat', { configurable: true, get: () => (ctx.outputLatency || 0) + (ctx.baseLatency || 0) });
  const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const biquad = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };

  // Bus: pistas+synth+FX → filtro performance → suma ← loops → comp → master → limitador
  A.mixBus = gain(0.6);   // margen: la suma de pistas y synth no empuja al compresor todo el tiempo
  A.loopBus = gain(1);
  A.sum = gain(1);
  A.perfHP = biquad('highpass', 10);
  A.perfLP = biquad('lowpass', 22000);
  A.comp = ctx.createDynamicsCompressor();
  // Compresión de "pegamento": suave y lenta (rápida distorsiona los graves)
  A.comp.threshold.value = -12; A.comp.knee.value = 12; A.comp.ratio.value = 2;
  A.comp.attack.value = 0.02; A.comp.release.value = 0.3;
  A.master = gain(0.8);
  A.limiter = ctx.createDynamicsCompressor();
  A.limiter.threshold.value = -1; A.limiter.knee.value = 1; A.limiter.ratio.value = 20;
  A.limiter.attack.value = 0.002; A.limiter.release.value = 0.2;
  A.analyser = ctx.createAnalyser();
  A.analyser.fftSize = 1024; A.analyser.smoothingTimeConstant = 0.6;

  A.mixBus.connect(A.perfHP).connect(A.perfLP).connect(A.sum);
  A.loopBus.connect(A.sum);
  // Protector final: deja pasar la señal limpia y redondea solo los picos que se pasarían de 0 dB
  // (en vez del recorte digital áspero que suena a chisporroteo)
  A.safety = ctx.createWaveShaper();
  const n = 4096, curve = new Float32Array(n), knee = 0.9;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    curve[i] = Math.sign(x) * (ax <= knee ? ax : knee + (0.98 - knee) * Math.tanh((ax - knee) / (0.98 - knee)));
  }
  A.safety.curve = curve;
  A.safety.oversample = '2x';
  A.sum.connect(A.comp).connect(A.master).connect(A.limiter).connect(A.safety).connect(A.analyser).connect(ctx.destination);
  A.silent = gain(0);
  A.silent.connect(ctx.destination);
  // Clicks (metrónomo y cuenta regresiva): en el modo show van solo a los auriculares
  A.clickBus = gain(1);
  A.clickBus.connect(A.sum);

  // Reverb (IR generada)
  A.reverbIn = gain(1);
  const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.02;
  A.convolver = ctx.createConvolver();
  A.convolver.buffer = makeIR(ctx, 2.6, 2.4);
  A.reverbReturn = gain(0.8);
  A.reverbIn.connect(pre).connect(A.convolver).connect(A.reverbReturn).connect(A.mixBus);

  // Delay ping-pong con tono cálido en la realimentación
  A.delayIn = gain(1);
  const dL = ctx.createDelay(3), dR = ctx.createDelay(3);
  A.delayFb = gain(0.42);
  const tone = biquad('lowpass', 3600);
  const lowcut = biquad('highpass', 180);
  const merger = ctx.createChannelMerger(2);
  A.delayReturn = gain(0.75);
  A.delayIn.connect(dL);
  dL.connect(dR);
  dR.connect(tone).connect(lowcut).connect(A.delayFb).connect(dL);
  dL.connect(merger, 0, 0);
  dR.connect(merger, 0, 1);
  merger.connect(A.delayReturn).connect(A.mixBus);
  A.dL = dL; A.dR = dR;
  A.baseFb = 0.42;

  // Bus de "lo que toco en vivo": lo alimentan los canales de vivo (pads, teclado, MIDI).
  // Sus envíos a reverb/delay van a una copia propia que se crea solo al grabar con esa fuente.
  A.liveBus = gain(1);
  A.liveRevIn = gain(1);
  A.liveDlyIn = gain(1);
  A.liveRec = null;

  // Ruido compartido
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  A.noise = nb;

  // Entrada (micrófono / interfaz): dispositivo → ganancia de entrada → protector suave →
  // nodo fijo que usan la grabación, el medidor y el monitoreo
  A.micIn = gain(1);
  A.micClip = ctx.createWaveShaper();
  {
    const n = 2048, c = new Float32Array(n), knee = 0.8;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
      c[i] = Math.sign(x) * (ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee)));
    }
    A.micClip.curve = c;
  }
  A.micNode = gain(1);
  A.micIn.connect(A.micClip).connect(A.micNode);
  A.micMeter = ctx.createAnalyser(); A.micMeter.fftSize = 512;
  A.micNode.connect(A.micMeter);
  A.monitor = gain(0);
  A.micNode.connect(A.monitor).connect(A.sum);

  // Modo show: la salida estéreo se usa como dos salidas mono.
  // Izquierda = público (mezcla, sin click) · Derecha = tus auriculares (mezcla + click, con su volumen)
  A.showSplit = ctx.createChannelSplitter(2);
  A.showPub = gain(0.5);  // (L + R) / 2
  A.showMon = gain(0.5);
  A.showMonVol = gain(0.8);
  A.showClick = gain(0.7);
  A.showMonSum = gain(1);
  A.showMerge = ctx.createChannelMerger(2);
  A.showSplit.connect(A.showPub, 0); A.showSplit.connect(A.showPub, 1);
  A.showSplit.connect(A.showMon, 0); A.showSplit.connect(A.showMon, 1);
  A.showMon.connect(A.showMonVol).connect(A.showMonSum);
  A.showClick.connect(A.showMonSum);
  A.showPub.connect(A.showMerge, 0, 0);
  A.showMonSum.connect(A.showMerge, 0, 1);
  A.showMerge.connect(ctx.destination);
  A.showOn = false;

  await ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
  await ctx.audioWorklet.addModule('js/audio/crush-worklet.js');
}

export function makeIR(ctx, secs, decay) {
  const sr = ctx.sampleRate, len = Math.floor(sr * secs);
  const b = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * (1 - (0.1 + 0.8 * t) * 0.85); // se oscurece con el tiempo
      d[i] = lp * Math.pow(1 - t, decay);
    }
    const fade = Math.floor(sr * 0.004);
    for (let i = 0; i < fade; i++) d[i] *= i / fade;
  }
  return b;
}

// Latencia de salida actual (cambia después de arrancar, sobre todo en Android)
export function outLatency() { return (A.ctx.outputLatency || 0) + (A.ctx.baseLatency || 0); }

// Momento (en tiempo del audio) que se estaba ESCUCHANDO cuando ocurrió un evento de la página
// (toque, tecla, MIDI). Usa el reloj de salida real del navegador: compensa la latencia de la
// tablet y la demora del propio evento, para que la cuantización caiga en el paso correcto.
export function heardTime(eventTimeStamp) {
  const ctx = A.ctx;
  const evt = eventTimeStamp ?? performance.now();
  try {
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) return ts.contextTime + (evt - ts.performanceTime) / 1000;
  } catch (e) { /* */ }
  return ctx.currentTime - outLatency() - (performance.now() - evt) / 1000;
}

export function setDelay(bpm, div, fb) {
  const t = Math.min(2.9, (60 / bpm) * (DELAY_BEATS[div] ?? 0.75));
  const now = A.ctx.currentTime;
  A.delayTime = t;
  for (const d of [A.dL, A.dR, A.pdL, A.pdR]) if (d) d.delayTime.setTargetAtTime(t, now, 0.04);
  if (fb != null) {
    A.baseFb = fb; A.delayFb.gain.setTargetAtTime(fb, now, 0.04);
    if (A.pFb) A.pFb.gain.setTargetAtTime(fb, now, 0.04);
  }
}

// Cadena "impresa": entrada seca + su propia reverb y delay (iguales a los generales).
// La usan la fuente "🎹 Solo lo que toco" y el re-tocado de notas cuantizadas.
export function makePrint() {
  const ctx = A.ctx;
  const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const bus = g(1), revIn = g(1), dlyIn = g(1), out = g(1);
  bus.connect(out);
  const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.02;
  const conv = ctx.createConvolver(); conv.buffer = A.convolver.buffer;
  const revRet = g(A.reverbReturn.gain.value);
  revIn.connect(pre).connect(conv).connect(revRet).connect(out);
  const dL = ctx.createDelay(3), dR = ctx.createDelay(3);
  dL.delayTime.value = dR.delayTime.value = A.delayTime || 0.375;
  const fb = g(A.baseFb);
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 3600;
  const lowcut = ctx.createBiquadFilter(); lowcut.type = 'highpass'; lowcut.frequency.value = 180;
  const merger = ctx.createChannelMerger(2);
  dlyIn.connect(dL); dL.connect(dR);
  dR.connect(tone).connect(lowcut).connect(fb).connect(dL);
  dL.connect(merger, 0, 0); dR.connect(merger, 0, 1);
  merger.connect(g(A.delayReturn.gain.value)).connect(out);
  const dispose = () => { [bus, revIn, dlyIn, out, fb, dL, dR, conv].forEach(n => { try { n.disconnect(); } catch (e) { /* */ } }); };
  return { bus, revIn, dlyIn, out, revRet, dL, dR, fb, dispose };
}

// Fuente "🎹 Solo lo que toco": lo tocado en vivo + su propia reverb y delay, sin la base.
// Se arma la primera vez que se usa.
export function liveSource() {
  if (A.liveRec) return A.liveRec;
  const pr = makePrint();
  A.liveBus.connect(pr.bus);
  A.liveRevIn.connect(pr.revIn);
  A.liveDlyIn.connect(pr.dlyIn);
  A.liveRec = pr.out;
  A.liveRevRet = pr.revRet;
  A.pdL = pr.dL; A.pdR = pr.dR; A.pFb = pr.fb;
  return A.liveRec;
}

// Pad XY: x = filtro (izq LP · der HP), y = resonancia + realimentación del delay
export function setPerf(x, y) {
  const now = A.ctx.currentTime;
  let lp = 22000, hp = 10, qL = 0.7, qH = 0.7;
  const q = 0.7 + y * 11;
  if (x < 0.47) { lp = 22000 * Math.pow(140 / 22000, (0.47 - x) / 0.47); qL = q; }
  else if (x > 0.53) { hp = 10 * Math.pow(6500 / 10, (x - 0.53) / 0.47); qH = q; }
  A.perfLP.frequency.setTargetAtTime(lp, now, 0.03);
  A.perfHP.frequency.setTargetAtTime(hp, now, 0.03);
  A.perfLP.Q.setTargetAtTime(qL, now, 0.03);
  A.perfHP.Q.setTargetAtTime(qH, now, 0.03);
  A.delayFb.gain.setTargetAtTime(A.baseFb + y * (0.88 - A.baseFb), now, 0.05);
}

// ---------- Entrada de audio ----------
// Sin cancelación de eco, supresión de ruido ni ganancia automática: señal cruda para grabar música.
export async function getMic(deviceId) {
  const want = deviceId ?? A.inputId ?? '';
  if (A.micStream && A.micDevice === want) return A.micNode;
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: 0 };
  if (want) audio.deviceId = { exact: want };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
  catch (e) {
    if (!want) throw e;
    delete audio.deviceId; // el dispositivo ya no está: usar el predeterminado
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  closeMic();
  A.micStream = stream;
  A.micDevice = want;
  A.micSrc = A.ctx.createMediaStreamSource(stream);
  A.micSrc.connect(A.micIn);
  scheduleMicClose(4000); // si nadie lo usa enseguida, se cierra
  stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (A.micStream === stream) closeMic(); }));
  return A.micNode;
}
// El micrófono se abre solo mientras se usa: en Android, tenerlo abierto pasa el audio a un
// modo de "llamada" (peor calidad, más cortes). Cada grabación lo "toma" y lo suelta al terminar;
// sin usos (ni monitoreo, ni el panel de entrada abierto) se cierra a los pocos segundos.
let micUsers = 0, micTimer = null;
export function micHold() { micUsers++; clearTimeout(micTimer); }
export function micRelease() { micUsers = Math.max(0, micUsers - 1); scheduleMicClose(); }
export function scheduleMicClose(delay = 1500) {
  clearTimeout(micTimer);
  micTimer = setTimeout(() => { if (micUsers === 0 && !A.monitorOn && !A.micPinned) closeMic(); }, delay);
}

export function closeMic() {
  if (A.micSrc) A.micSrc.disconnect();
  if (A.micStream) A.micStream.getTracks().forEach(t => t.stop());
  A.micStream = null; A.micSrc = null; A.micDevice = null;
}
export async function listInputs() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter(d => d.kind === 'audioinput');
}
// Modo show (ver arriba). mon/click: volúmenes de los auriculares y del click (0..1)
export function setShow(on, mon = 0.8, click = 0.7) {
  const t = A.ctx.currentTime;
  A.showMonVol.gain.setTargetAtTime((mon / 0.8) ** 2, t, 0.02);
  A.showClick.gain.setTargetAtTime(click, t, 0.02);
  if (on === A.showOn) return;
  A.showOn = on;
  A.analyser.disconnect();
  A.clickBus.disconnect();
  A.monitor.disconnect();
  if (on) {
    A.analyser.connect(A.showSplit);
    A.clickBus.connect(A.showClick);
    A.monitor.connect(A.showMonSum);   // el micrófono, si lo monitoreás, solo en tus auriculares
  } else {
    A.analyser.connect(A.ctx.destination);
    A.clickBus.connect(A.sum);
    A.monitor.connect(A.sum);
  }
}

// Pitido de prueba en un solo lado (0 = izquierda/público, 1 = derecha/auriculares)
export function showTestTone(side) {
  const t = A.ctx.currentTime + 0.02, o = A.ctx.createOscillator(), g = A.ctx.createGain();
  o.frequency.value = side ? 880 : 440;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02);
  g.gain.setValueAtTime(0.25, t + 0.5); g.gain.linearRampToValueAtTime(0, t + 0.6);
  o.connect(g).connect(A.showMerge, 0, side); o.start(t); o.stop(t + 0.65);
}

export function setMonitor(on) {
  A.monitorOn = on;
  A.monitor.gain.setTargetAtTime(on ? 1 : 0, A.ctx.currentTime, 0.02);
  if (!on) scheduleMicClose();
}

// Ganancia de entrada en dB (para micrófonos que llegan bajito, como un dinámico sin preamp)
export function setInputGain(db) {
  A.micIn.gain.setTargetAtTime(Math.pow(10, (db || 0) / 20), A.ctx.currentTime, 0.02);
}

// Nivel pico de la entrada (0..1)
const meterBuf = new Float32Array(512);
export function inputLevel() {
  if (!A.micStream) return 0;
  A.micMeter.getFloatTimeDomainData(meterBuf);
  let pk = 0;
  for (let i = 0; i < meterBuf.length; i++) pk = Math.max(pk, Math.abs(meterBuf[i]));
  return pk;
}

// Mide la latencia de ida y vuelta: suena un click por los parlantes y se graba con el micrófono.
export async function calibrateLatency() {
  const node = await getMic();
  const ctx = A.ctx, t0 = ctx.currentTime + 0.25, n = 5, gap = 0.45;
  const job = capture(node, t0, n * gap + 0.5);
  for (let k = 0; k < n; k++) {
    const t = t0 + 0.2 + k * gap;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.0005); g.gain.linearRampToValueAtTime(0, t + 0.004);
    o.connect(g).connect(A.limiter); o.start(t); o.stop(t + 0.01);
  }
  const buf = await job.promise;
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  let floor = 0; // ruido de fondo antes del primer click
  for (let i = 0; i < Math.floor(0.15 * sr); i++) floor = Math.max(floor, Math.abs(d[i]));
  const res = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor((0.2 + k * gap) * sr), b = Math.min(d.length, a + Math.floor(gap * 0.9 * sr));
    let pk = 0;
    for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (pk < Math.max(0.02, floor * 4)) continue;
    const th = Math.max(floor * 3, pk * 0.35);
    for (let i = a; i < b; i++) if (Math.abs(d[i]) >= th) { res.push((i - a) / sr); break; }
  }
  if (res.length < 3) return null;
  res.sort((x, y) => x - y);
  return Math.round(res[Math.floor(res.length / 2)] * 1000);
}

// ---------- Grabación ----------
const recNodes = new Map();
const pending = new Map();
const peeks = new Map();
let jobId = 0;

function recNodeFor(src) {
  let n = recNodes.get(src);
  if (!n) {
    n = new AudioWorkletNode(A.ctx, 'bloop-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    src.connect(n);
    n.connect(A.silent);
    n.port.onmessage = (e) => {
      if (e.data.peek) { const p = peeks.get(e.data.id); if (p) { peeks.delete(e.data.id); p(e.data); } return; }
      const cb = pending.get(e.data.id);
      if (cb) { pending.delete(e.data.id); cb(e.data); }
    };
    recNodes.set(src, n);
  }
  return n;
}

// Graba `seconds` desde `startTime` (tiempo del contexto). stop() corta antes.
export function capture(src, startTime, seconds) {
  const n = recNodeFor(src);
  const id = ++jobId;
  const usesMic = src === A.micNode;
  if (usesMic) micHold();
  const sr = A.ctx.sampleRate;
  const promise = new Promise(res => pending.set(id, res)).then(({ L, R }) => {
    if (usesMic) micRelease();
    const b = A.ctx.createBuffer(2, Math.max(1, L.length), sr);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    return b;
  });
  n.port.postMessage({ type: 'start', id, startFrame: Math.round(startTime * sr), length: Math.round(seconds * sr) });
  return {
    promise,
    stop: () => n.port.postMessage({ type: 'stop', id }),
    stopAt: t => n.port.postMessage({ type: 'stopAt', id, frame: Math.round(t * sr) }),
    // Lo grabado hasta ahora, sin cortar la grabación
    peek: () => new Promise(res => { peeks.set(id, res); n.port.postMessage({ type: 'peek', id }); }).then(({ L, R }) => {
      const b = A.ctx.createBuffer(2, Math.max(1, L.length), sr);
      b.copyToChannel(L, 0); b.copyToChannel(R, 1);
      return b;
    }),
  };
}

// ---------- Utilidades de buffer ----------
export function trimAndNormalize(buf, thresh = 0.02) {
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  let start = 0, end = buf.length - 1, peak = 0;
  outer: for (; start < buf.length; start++) for (const d of chs) if (Math.abs(d[start]) > thresh) break outer;
  outer2: for (; end > start; end--) for (const d of chs) if (Math.abs(d[end]) > thresh * 0.5) break outer2;
  start = Math.max(0, start - Math.floor(buf.sampleRate * 0.003));
  const len = Math.max(1, end - start + 1);
  for (const d of chs) for (let i = start; i <= end; i++) peak = Math.max(peak, Math.abs(d[i]));
  const k = peak > 0 ? 0.95 / peak : 1;
  const out = A.ctx.createBuffer(chs.length, len, buf.sampleRate);
  chs.forEach((d, c) => {
    const o = out.getChannelData(c);
    for (let i = 0; i < len; i++) o[i] = d[start + i] * k;
    const f = Math.min(len, Math.floor(buf.sampleRate * 0.005));
    for (let i = 0; i < f; i++) o[len - 1 - i] *= i / f;
  });
  return out;
}

// WAV de 16 bits (para compartir) o 32 bits float (sin pérdida, para respaldos)
export function encodeWav(buf, float = false) {
  const nCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length, bps = float ? 4 : 2;
  const dv = new DataView(new ArrayBuffer(44 + len * nCh * bps));
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + len * nCh * bps, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * bps, true); dv.setUint16(32, nCh * bps, true);
  dv.setUint16(34, bps * 8, true); ws(36, 'data'); dv.setUint32(40, len * nCh * bps, true);
  const chs = []; for (let c = 0; c < nCh; c++) chs.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    if (float) { dv.setFloat32(o, chs[c][i], true); o += 4; continue; }
    const v = Math.max(-1, Math.min(1, chs[c][i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([dv], { type: 'audio/wav' });
}

export function peakOf(buf) {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  }
  return pk;
}

export function normalizeBuffer(buf, target = 0.95) {
  const pk = peakOf(buf), k = pk > 0 ? target / pk : 1;
  const out = A.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), o = out.getChannelData(c);
    for (let i = 0; i < s.length; i++) o[i] = s[i] * k;
  }
  return out;
}

export function sliceBuffer(buf, a, b) {
  a = Math.max(0, Math.floor(a)); b = Math.min(buf.length, Math.floor(b));
  const out = A.ctx.createBuffer(buf.numberOfChannels, Math.max(1, b - a), buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  return out;
}

// Detección de transientes (para slices): devuelve posiciones 0..1
export function detectTransients(buf, sensitivity = 0.5, maxSlices = 32) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, hop = 256, win = 512;
  const env = [];
  for (let i = 0; i + win < d.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += d[j] * d[j];
    env.push(Math.sqrt(e / win));
  }
  const flux = env.map((v, i) => (i ? Math.max(0, v - env[i - 1]) : 0));
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const sd = Math.sqrt(flux.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, flux.length));
  const th = mean + sd * (0.4 + (1 - sensitivity) * 3);
  const minGap = Math.floor(0.07 * sr / hop);
  const out = [];
  let last = -minGap;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > th && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last >= minGap) {
      out.push({ pos: Math.max(0, (i - 1) * hop) / d.length, s: flux[i] });
      last = i;
    }
  }
  out.sort((a, b) => b.s - a.s);
  const pos = out.slice(0, maxSlices - 1).map(o => o.pos).sort((a, b) => a - b);
  if (!pos.length || pos[0] > 0.01) pos.unshift(0);
  return pos;
}

// Corrige en hold el valor actual de un parámetro automatizado
export function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
}
