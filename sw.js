// Service worker: guarda toda la app para usarla sin internet.
// Al cambiar cualquier archivo, subí VERSION para que la tablet baje la versión nueva.
const VERSION = 'bloop-v3';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'js/actions.js',
  'js/app.js',
  'js/audio/crush-worklet.js',
  'js/audio/drums.js',
  'js/audio/engine.js',
  'js/audio/looper.js',
  'js/audio/presets.js',
  'js/audio/recorder-worklet.js',
  'js/audio/sampler.js',
  'js/audio/synth.js',
  'js/audio/trackfx.js',
  'js/bank.js',
  'js/input.js',
  'js/main.js',
  'js/scales.js',
  'js/sequencer.js',
  'js/state.js',
  'js/ui/bank.js',
  'js/ui/controllers.js',
  'js/ui/dock.js',
  'js/ui/fx.js',
  'js/ui/grid.js',
  'js/ui/help.js',
  'js/ui/keyboard.js',
  'js/ui/knob.js',
  'js/ui/loops.js',
  'js/ui/params.js',
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
    const m = await (await fetch('packs/base/pack.json', { cache: 'no-cache' })).json();
    return ['packs/base/pack.json', ...m.sounds.map(s => 'packs/base/' + s.file)];
  } catch (e) { return []; }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll([...FILES, ...(await baseFiles())]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero caché (offline), y si hay red actualiza en segundo plano.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Los packs descargables se guardan en la base de datos de la app: no duplicarlos en caché
  const path = new URL(e.request.url).pathname;
  if (path.includes('/packs/') && !path.includes('/packs/base/')) return;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(res => {
        if (res.ok && new URL(e.request.url).origin === location.origin) cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || new Response('offline', { status: 503 });
    }),
  );
});
