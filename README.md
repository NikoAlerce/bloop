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

### Banco de sonidos
- **📚 Sonidos** abre el banco: escuchar con un toque, mandar a cualquier pista, favoritos, búsqueda y categorías.
- **Packs descargables** que quedan offline (se bajan una vez con internet), todos **CC0**:

| Pack | Qué trae | Peso |
|---|---|---|
| 🫧 Kits Bloop | Los 4 kits por defecto (808, lofi, techno, trap/dubstep), incluidos en la app | 0.6 MB |
| 🎛️ Máquinas Bloop | 56 sonidos: bombos/cajas/hats 808, 909, trap, dubstep, toms, percusión, FX | 1.3 MB |
| 📼 Polvo Lofi | Boom bap y lo-fi: bombos y cajas sucias, acordes Rhodes, pads, vinilo, lluvia | 1.8 MB |
| 🔊 Bajos Gordos | 808 limpio/sucio/eterno, sub, reese, pluck y Rhodes (instrumentos), growls y wobbles | 3.0 MB |
| 🥁 Batería real | 141 golpes acústicos grabados (Stargate) | 2.2 MB |
| 🪘 Percusión del mundo | 87 sonidos: congas, bongós, cajón, darbuka, shakers… (VCSL) | 2.0 MB |
| 🎹 Instrumentos | Piano, piano FM, vibráfono, kalimba, marimba, glockenspiel, arpa, contrabajo, cellos, violines, flauta, saxo | 7.6 MB |
| 🔁 Loops, voces y FX | Loops de batería, bajo, guitarra y acordes con su tempo, voces y FX (Stargate) | 5.9 MB |

- **Instrumentos multisampleados**: se tocan en notas desde el teclado (modo 🥁 Sampler), el MIDI o los pasos.
- **Loops al looper** (🔁): se ajustan solos a compases enteros del tempo actual.
- **Importar tus packs** (ZIP, archivos o carpeta): se clasifican solos por nombre y quedan solo en tu tablet.
- Synth: **wobble** (LFO al filtro a tempo) y presets nuevos: 808 Glide, Reese Oscuro, Wobble Dubstep,
  Growl Monstruo, Rhodes Blonde, Pad Nostalgia, Lead Igor, Sub Lofi.
- Los packs se regeneran con `python tools/build_packs.py` (requiere ffmpeg, numpy y scipy). Créditos en [packs/CREDITS.md](packs/CREDITS.md).

## Probarlo en la PC

```bash
node server.cjs
```

y abrir http://localhost:5173 (o doble clic en `Abrir Bloop.bat`).

## Instalarlo en la tablet (offline)

**URL: https://nikoalerce.github.io/bloop/**

Android exige **HTTPS** para el audio avanzado (AudioWorklet), el micrófono y el modo offline,
así que la app tiene que publicarse una vez en un hosting HTTPS (GitHub Pages, Netlify, Cloudflare Pages…).
Después: abrir la URL en Chrome en la tablet → menú ⋮ → **Instalar app / Agregar a pantalla principal**.
A partir de ahí abre a pantalla completa y funciona sin internet.

### Actualizaciones automáticas
La app instalada **se actualiza sola al abrirla** si hay internet: carga primero de la red (con un tope de
3.5 s) y si no hay conexión usa la copia offline. Si Android la tenía abierta en segundo plano, al volver a
ella revisa si hay versión nueva: si no está sonando nada, guarda y recarga sola; si estás tocando, muestra
un aviso con el botón «Actualizar ahora». La versión actual se ve en el menú ☰.

Para publicar: `python tools/stamp.py` (calcula la versión con un hash del contenido y actualiza
`version.json` y la lista offline de `sw.js`), después commit y push.

## Archivos

- `js/audio/` — motor (buses, FX, grabador), kits de batería, sampler, synth, presets, looper
- `js/sequencer.js` — reloj, swing, probabilidad, arpegiador, beat-repeat, grabación en vivo
- `js/ui/` — barra superior, pistas, pads, piano roll, loops, teclado, sonido, FX
- `sw.js` + `manifest.webmanifest` — app instalable y offline
