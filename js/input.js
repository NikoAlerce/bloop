// Capa única de entrada: MIDI (USB y Bluetooth), teclado/pedales HID y gamepads.
// Todo se convierte en eventos {device, id, kind:'button'|'cc', on, value} y pasa por
// el mismo sistema de asignaciones ("modo aprender"), con un perfil por dispositivo.
import { app } from './app.js';
import { kvGet, kvSet } from './state.js';
import { noteName } from './scales.js';

const BLE_SVC = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_CHR = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const KEYS = 'Teclado / pedales';

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export const input = {
  devices: new Map(),   // nombre -> {name, type, connected}
  maps: {},             // nombre de dispositivo -> {idDeEntrada: idDeDestino}
  targets: new Map(),   // idDeDestino -> {label, kind:'button'|'value', press, release, set, get, el}
  learn: { on: false, target: null },
  keyHandlers: [],      // comportamiento por defecto del teclado (si la tecla no está asignada)
  midiHandler: null,    // comportamiento por defecto del MIDI
  ccState: new Map(),
  learnSeen: new Map(),
  bleDevices: new Map(),

  async init() {
    this.maps = (await kvGet('mappings')) || {};
    this.setDevice(KEYS, 'keys', true);
    this.initKeys();
    this.initMidi();
    this.initGamepads();
    this.autoBle();
    this.initLearnCapture();
  },

  // ---------- Dispositivos ----------
  setDevice(name, type, connected) {
    const d = this.devices.get(name) || { name, type };
    const was = d.connected;
    d.connected = connected; d.type = type;
    this.devices.set(name, d);
    if (was !== connected) {
      if (type !== 'keys' && was !== undefined) app.emit('toast', (connected ? '🟢 ' : '⚪ ') + name + (connected ? ' conectado' : ' desconectado'));
      if (connected && this.maps[name] && Object.keys(this.maps[name]).length && type !== 'keys') app.emit('toast', `🎛 Perfil de ${name} cargado`);
    }
    app.emit('devices');
  },
  activity(name) { const d = this.devices.get(name); if (d) { d.last = performance.now(); app.emit('device-activity', name); } },

  // ---------- Destinos ----------
  target(id, def) {
    this.targets.set(id, def);
    if (def.el) { def.el.dataset.learn = id; def.el.toggleAttribute('data-mapped', this.isMapped(id)); }
  },
  isMapped(id) { return Object.values(this.maps).some(m => Object.values(m).includes(id)); },
  markMapped() {
    for (const [id, t] of this.targets) if (t.el) t.el.toggleAttribute('data-mapped', this.isMapped(id));
    document.querySelectorAll('[data-learn]').forEach(el => el.toggleAttribute('data-mapped', this.isMapped(el.dataset.learn)));
  },

  // ---------- Despacho ----------
  dispatch(ev) {
    this.activity(ev.device);
    const L = this.learn;
    if (L.on && L.target) {
      if (ev.kind === 'button' && !ev.on) return true;
      if (ev.kind === 'cc') {
        const k = ev.device + ev.id, first = this.learnSeen.get(k);
        if (first == null) { this.learnSeen.set(k, ev.value); return true; }
        if (Math.abs(ev.value - first) < 0.08) return true;
      }
      this.assign(ev.device, ev.id, L.target);
      return true;
    }
    const tid = this.maps[ev.device]?.[ev.id];
    if (!tid) return false;
    const t = this.targets.get(tid);
    if (!t) return true;
    if (t.kind === 'value') {
      if (ev.kind === 'cc') t.set(ev.value);
      else if (ev.on) t.set(t.get() > 0.5 ? 0 : 1);
    } else if (ev.kind === 'cc') {
      const k = ev.device + ev.id, on = ev.value > 0.5, was = this.ccState.get(k);
      if (on && !was) t.press(1);
      if (!on && was && t.release) t.release();
      this.ccState.set(k, on);
    } else if (ev.on) t.press(ev.value || 1);
    else if (t.release) t.release();
    return true;
  },

  // ---------- Modo aprender ----------
  setLearn(on) {
    this.learn.on = on; this.learn.target = null;
    this.learnSeen.clear();
    document.body.classList.toggle('learning', on);
    this.highlight();
    app.emit('learn', on);
  },
  setLearnTarget(id) {
    this.learn.target = id;
    this.learnSeen.clear();
    this.highlight();
    app.emit('learn-target', id);
  },
  highlight() {
    document.querySelectorAll('.learn-target').forEach(e => e.classList.remove('learn-target'));
    if (this.learn.target) document.querySelectorAll(`[data-learn="${this.learn.target}"]`).forEach(e => e.classList.add('learn-target'));
  },
  assign(device, id, tid) {
    const m = this.maps[device] ||= {};
    m[id] = tid;
    kvSet('mappings', this.maps);
    app.emit('toast', `🎯 ${this.targetLabel(tid)} ← ${this.inputLabel(device, id)}`);
    this.learn.target = null;
    this.highlight();
    this.markMapped();
    app.emit('mappings');
  },
  unassign(device, id) {
    if (this.maps[device]) delete this.maps[device][id];
    kvSet('mappings', this.maps);
    this.markMapped();
    app.emit('mappings');
  },
  clearDevice(device) { delete this.maps[device]; kvSet('mappings', this.maps); this.markMapped(); app.emit('mappings'); },
  targetLabel(tid) { return this.targets.get(tid)?.label || tid; },
  inputLabel(device, id) {
    let m;
    if ((m = id.match(/^k:(.+)$/))) return 'Tecla ' + m[1].replace(/^Key|^Digit/, '');
    if ((m = id.match(/^n(\d+):(\d+)$/))) return `Nota ${noteName(+m[2])} · canal ${+m[1] + 1}`;
    if ((m = id.match(/^c(\d+):(\d+)$/))) return `Control ${m[2]} · canal ${+m[1] + 1}`;
    if ((m = id.match(/^pb(\d+)$/))) return `Pitch bend · canal ${+m[1] + 1}`;
    if ((m = id.match(/^b(\d+)$/))) return `Botón ${m[1]}`;
    if ((m = id.match(/^a(\d+)$/))) return `Eje ${m[1]}`;
    return id;
  },

  // Tocar un control en pantalla durante el modo aprender lo elige como destino
  initLearnCapture() {
    const grab = e => {
      if (!this.learn.on) return;
      const el = e.target.closest && e.target.closest('[data-learn]');
      if (!el || el.closest('.no-learn')) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.type === 'pointerdown') this.setLearnTarget(el.dataset.learn);
    };
    document.addEventListener('pointerdown', grab, true);
    document.addEventListener('click', grab, true);
  },

  // ---------- Teclado y pedales Bluetooth (HID) ----------
  initKeys() {
    const typing = e => e.target.closest && e.target.closest('input,textarea,select');
    window.addEventListener('keydown', e => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!e.repeat) app.lastInputTs = e.timeStamp;
      if (this.learn.on && e.key === 'Escape') { this.setLearn(false); return; }
      if (e.repeat) { if (this.maps[KEYS]?.['k:' + e.code]) e.preventDefault(); return; }
      if (this.dispatch({ device: KEYS, id: 'k:' + e.code, kind: 'button', on: true, value: 1 })) { e.preventDefault(); return; }
      for (const h of this.keyHandlers) if (h(e, true)) { e.preventDefault(); return; }
    });
    window.addEventListener('keyup', e => {
      if (typing(e)) return;
      if (this.dispatch({ device: KEYS, id: 'k:' + e.code, kind: 'button', on: false, value: 0 })) return;
      for (const h of this.keyHandlers) if (h(e, false)) return;
    });
  },
  onKey(fn) { this.keyHandlers.push(fn); },

  // ---------- MIDI (USB y Bluetooth emparejado en el sistema) ----------
  async initMidi() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const acc = this.midiAccess = await navigator.requestMIDIAccess();
      const sync = () => {
        const seen = new Set();
        acc.inputs.forEach(inp => {
          seen.add(inp.name);
          inp.onmidimessage = e => this.handleMidi(inp.name, e.data, e.timeStamp);
          this.setDevice(inp.name, this.devices.get(inp.name)?.type === 'ble' ? 'ble' : 'midi', inp.state === 'connected');
        });
        for (const d of this.devices.values()) if (d.type === 'midi' && !seen.has(d.name)) this.setDevice(d.name, 'midi', false);
      };
      sync();
      acc.onstatechange = sync;
    } catch (e) { /* sin permiso MIDI */ }
  },

  handleMidi(device, data, ts) {
    app.lastInputTs = ts ?? performance.now();
    const [s, d1, d2 = 0] = data, cmd = s & 0xf0, ch = s & 0x0f;
    let ev = null;
    if (cmd === 0x90 && d2 > 0) ev = { id: `n${ch}:${d1}`, kind: 'button', on: true, value: d2 / 127 };
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) ev = { id: `n${ch}:${d1}`, kind: 'button', on: false, value: 0 };
    else if (cmd === 0xb0) ev = { id: `c${ch}:${d1}`, kind: 'cc', value: d2 / 127 };
    else if (cmd === 0xe0) ev = { id: `pb${ch}`, kind: 'cc', value: ((d2 << 7) | d1) / 16383 };
    if (!ev) return;
    ev.device = device;
    if (this.dispatch(ev)) return;
    if (this.midiHandler) this.midiHandler({ ...ev, cmd, ch, d1, d2 });
  },

  // ---------- BLE-MIDI directo (Web Bluetooth) ----------
  get bleSupported() { return !!navigator.bluetooth; },

  async connectBle() {
    if (!navigator.bluetooth) { app.emit('toast', 'Este navegador no tiene Bluetooth web'); return; }
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SVC] }], optionalServices: [BLE_SVC] });
    } catch (e) { return; } // cancelado
    // Si ya llega por Web MIDI (emparejado en Android), se usa ese camino
    const viaMidi = this.midiAccess && [...this.midiAccess.inputs.values()].find(i => i.state === 'connected' && device.name && i.name.includes(device.name));
    if (viaMidi) { app.emit('toast', `🎹 ${device.name} ya está conectado por MIDI`); return; }
    this.watchBle(device);
    try { await this.bleConnect(device); }
    catch (e) { app.emit('toast', '🔵 No pude conectar: ' + e.message); this.bleRetry(device); }
  },

  watchBle(device) {
    if (this.bleDevices.has(device.id)) return;
    this.bleDevices.set(device.id, device);
    device.addEventListener('gattserverdisconnected', () => {
      this.setDevice(device.name, 'ble', false);
      this.bleRetry(device);
    });
  },

  async bleConnect(device) {
    const server = await timeout(device.gatt.connect(), 10000);
    const svc = await server.getPrimaryService(BLE_SVC);
    const chr = await svc.getCharacteristic(BLE_CHR);
    await chr.startNotifications();
    chr.addEventListener('characteristicvaluechanged', e => this.parseBle(device.name, e.target.value));
    this.setDevice(device.name, 'ble', true);
  },

  // Reconexión automática con espera creciente
  bleRetry(device, delay = 1000) {
    clearTimeout(device._retry);
    device._retry = setTimeout(async () => {
      if (device.gatt.connected) return;
      try { await this.bleConnect(device); }
      catch (e) { this.bleRetry(device, Math.min(15000, delay * 1.6)); }
    }, delay);
  },

  async autoBle() {
    if (!navigator.bluetooth?.getDevices) return;
    try {
      const devs = await navigator.bluetooth.getDevices();
      devs.forEach(d => { this.watchBle(d); this.setDevice(d.name, 'ble', false); this.bleRetry(d, 300); });
    } catch (e) { /* */ }
  },

  // Paquetes BLE-MIDI: cabecera, luego [timestamp] status datos… (con running status)
  parseBle(device, dv) {
    const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    let i = 1, status = 0;
    const len = s => (s >= 0xc0 && s < 0xe0 ? 1 : s >= 0xf0 ? 0 : 2);
    while (i < b.length) {
      if (b[i] & 0x80) {          // timestamp
        i++;
        if (i >= b.length) break;
        if (b[i] & 0x80) {        // status nuevo
          status = b[i++];
          if (status === 0xf0) { while (i < b.length && b[i] !== 0xf7) i++; i++; continue; }
          if (status >= 0xf8) continue;
        }
      }
      if (!status || status >= 0xf0) { i++; continue; }
      const n = len(status), msg = [status];
      for (let k = 0; k < n && i < b.length; k++) msg.push(b[i++]);
      this.handleMidi(device, msg);
    }
  },

  // ---------- Gamepads ----------
  initGamepads() {
    const name = g => g.id.split('(')[0].trim() || 'Gamepad';
    const prev = new Map();
    let polling = false;
    const poll = () => {
      const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
      if (!pads.length) { polling = false; return; }
      for (const g of pads) {
        const n = name(g), p = prev.get(g.index) || { b: [], a: [] };
        g.buttons.forEach((bt, k) => {
          if (bt.pressed !== !!p.b[k]) this.dispatch({ device: n, id: 'b' + k, kind: 'button', on: bt.pressed, value: bt.value || 1 });
          p.b[k] = bt.pressed;
        });
        g.axes.forEach((v, k) => {
          const val = Math.round((v + 1) / 2 * 100) / 100;
          if (Math.abs(val - (p.a[k] ?? val)) >= 0.02) this.dispatch({ device: n, id: 'a' + k, kind: 'cc', value: val });
          p.a[k] = val;
        });
        prev.set(g.index, p);
      }
      requestAnimationFrame(poll);
    };
    window.addEventListener('gamepadconnected', e => {
      this.setDevice(name(e.gamepad), 'gamepad', true);
      if (!polling) { polling = true; requestAnimationFrame(poll); }
    });
    window.addEventListener('gamepaddisconnected', e => this.setDevice(name(e.gamepad), 'gamepad', false));
  },
};
