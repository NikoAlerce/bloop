// Service worker: la app funciona sin internet y se actualiza sola al abrirla.
// VERSION y FILES los escribe tools/stamp.py (no editar a mano).
const VERSION = 'bloop-2026-10-15-b846cb61';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/actions.js',
  'js/app.js',
  'js/audio/crush-worklet.js',
  'js/audio/drums.js',
  'js/audio/edit.js',
  'js/audio/engine.js',
  'js/audio/loopbuild.js',
  'js/audio/looper.js',
  'js/audio/presets.js',
  'js/audio/recorder-worklet.js',
  'js/audio/sampler.js',
  'js/audio/stretch.js',
  'js/audio/synth.js',
  'js/audio/trackfx.js',
  'js/bank.js',
  'js/input.js',
  'js/main.js',
  'js/quant.js',
  'js/scales.js',
  'js/sequencer.js',
  'js/state.js',
  'js/ui/bank.js',
  'js/ui/controllers.js',
  'js/ui/countin.js',
  'js/ui/dock.js',
  'js/ui/fx.js',
  'js/ui/grid.js',
  'js/ui/help.js',
  'js/ui/keyboard.js',
  'js/ui/knob.js',
  'js/ui/loops.js',
  'js/ui/mixer.js',
  'js/ui/padview.js',
  'js/ui/params.js',
  'js/ui/presets.js',
  'js/ui/roll.js',
  'js/ui/settings.js',
  'js/ui/song.js',
  'js/ui/topbar.js',
  'js/ui/tracks.js',
  'js/ui/util.js',
  'js/ui/waveeditor.js',
  'js/undo.js',
  'js/zip.js',
];

// El pack base (los kits por defecto) se guarda junto con la app; la lista sale de su pack.json
async function baseFiles() {
  try {
    const m = await (await fetch('packs/base/pack.json', { cache: 'reload' })).json();
    return ['packs/base/pack.json', ...m.sounds.map(s => 'packs/base/' + s.file)];
  } catch (e) { return []; }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // 'reload' saltea la caché HTTP del navegador/CDN: se guarda la versión recién publicada
    await c.addAll([...FILES, ...(await baseFiles())].map(f => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Estrategia: CACHÉ DE LA VERSIÓN COMPLETA. Cada versión se descarga entera al instalarse
// (atómica), así nunca se mezclan archivos de dos versiones. Cuando hay una versión nueva, este
// service worker se reemplaza y la página se recarga sola (ver main.js).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Los packs descargables se guardan en la base de datos de la app: no duplicarlos en caché
  if (url.pathname.includes('/packs/') && !url.pathname.includes('/packs/base/')) return;
  // version.json: siempre de la red (sirve para saber si hay novedades)
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || new Response('{}'))));
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch (err) { return new Response('offline', { status: 503 }); }
  })());
});
