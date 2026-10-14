# 🫧 Bloop — sampler groovebox

Groovebox para el navegador pensada para tablet (Galaxy Tab S10 FE), táctil y **offline**.
Mezcla de Novation Circuit Rhythm (8 pistas de sampler, 32 pads, patrones), Loopy (loops circulares)
y un synth con teclado y presets épicos. Sin dependencias: HTML + CSS + JavaScript + Web Audio.

## Qué tiene

- **8 pistas de sampler** con 4 kits sintetizados dentro de la app (Chicle 808, Polvo Lofi, Neón Techno, Burbuja Pop).
  Por pista: afinación, decay, inicio, filtro DJ (LP/HP), resonancia, drive, volumen, paneo, reverb, delay, reversa, mono, grupos de choke.
  Cargá tus archivos de audio, grabá con el micrófono o hacé **resample** de la mezcla.
- **Secuenciador de 32 pasos** por pista con largo independiente (polirritmia), velocity, probabilidad, afinación por paso,
  micro-timing y ratchets. Swing, 8 patrones con cambio al final del compás, copiar patrón, dados 🎲.
- **Synth** poli/mono: supersaw con unísono estéreo, osc 2, sub, ruido, FM, filtro con envolvente, ADSR, glide (ligaduras estilo 303),
  vibrato, pitch env, chorus, drive. 12 presets: Himno Supersaw, Blade Brass, Nube Pad, Cristal FM, Ácido 303, Sub Moog, Hoover Rave…
  **Piano roll** táctil, arpegiador (5 modos, 4 velocidades, 1–3 octavas, hold) y grabación en vivo.
- **4 loopers** sincronizados al compás (micrófono o la propia mezcla), overdub, mute, volumen; siguen el tempo.
- **Performance**: pad XY (filtro + resonancia + eco), beat-repeat, delay ping-pong sincronizado, reverb.
- Export a **WAV**, guardado automático, teclado de compu y **MIDI USB**.

### Ronda 1 de correcciones
- **Controladores**: MIDI USB, **BLE-MIDI** desde la app (Web Bluetooth, servicio estándar), pedales y teclados **Bluetooth HID**
  y **gamepads**, todos por una sola capa de entrada. **Modo aprender** (🎛 → 🎯 Asignar): tocás un control en pantalla
  y movés el físico. Acciones globales asignables (scene siguiente/anterior, grabar/parar loop elegido, play, deshacer,
  tap tempo…). Un **perfil por controlador** que se carga solo al reconectar; reconexión automática del Bluetooth.
- **Cuantización a elección**: loops "Al compás / Libre" (el primer loop libre define el tempo) y grabación en vivo
  con cuantizar sí/no + intensidad (sin cuantizar guarda el micro-timing real).
- **Editor de onda** para loops y samples: inicio/fin arrastrables, zoom con dos dedos, fades, ajuste al compás,
  normalizar y **slices automáticos por transientes** (con modo slices para pasos y teclado).
- **Deshacer/rehacer** de varios niveles (pasos, notas, grabaciones, overdub, recortes, sonidos, canción).
- **Scenes con loops** (cada patrón recuerda qué loops suenan), **8 loops** en dos páginas y **modo canción**.
- **Entrada de audio**: selector de dispositivo (interno o interfaz USB), señal cruda (sin cancelación de eco, supresión
  de ruido ni ganancia automática), **calibración automática de latencia**, medidor de entrada, monitoreo y grabación de
  samples con umbral hasta 90 s.
- **Uso al aire libre**: pads y loops ≥ 56 px, **modo sol** claro de alto contraste, **modo ahorro** y almacenamiento persistente.
- **Samples en notas** desde el teclado y el MIDI, con **escalas** y modo pads.
- **Stems** (ZIP con un WAV por pista, synth, loop y retornos de FX + la mezcla) y **respaldo del proyecto completo** en un archivo `.bloop`.
- Efectos por pista y synth: **bitcrusher**, **cinta/vinilo** y **gater** sincronizado.

## Probarlo en la PC

```bash
node server.cjs
```

y abrir http://localhost:5173 (o doble clic en `Abrir Bloop.bat`).

## Instalarlo en la tablet (offline)

Android exige **HTTPS** para el audio avanzado (AudioWorklet), el micrófono y el modo offline,
así que la app tiene que publicarse una vez en un hosting HTTPS (GitHub Pages, Netlify, Cloudflare Pages…).
Después: abrir la URL en Chrome en la tablet → menú ⋮ → **Instalar app / Agregar a pantalla principal**.
A partir de ahí abre a pantalla completa y funciona sin internet.

Para publicar una versión nueva, subí `VERSION` en `sw.js` (ej. `bloop-v2`) así la tablet descarga los cambios
la próxima vez que tenga internet.

## Archivos

- `js/audio/` — motor (buses, FX, grabador), kits de batería, sampler, synth, presets, looper
- `js/sequencer.js` — reloj, swing, probabilidad, arpegiador, beat-repeat, grabación en vivo
- `js/ui/` — barra superior, pistas, pads, piano roll, loops, teclado, sonido, FX
- `sw.js` + `manifest.webmanifest` — app instalable y offline
