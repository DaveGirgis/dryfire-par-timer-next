// Service worker: precaches the whole app so it runs offline, and serves it cache-first.
// VERSION and ASSETS are written by `npm run build:sw` (tools/build-sw.mjs); don't edit them by hand.
// A new VERSION makes browsers install a fresh cache; the page then offers "Reload to update".

const VERSION = 'b37cf1762248';
const ASSETS = ["./","index.html","manifest.webmanifest","js/app.js","js/audio.js","js/db.js","js/drill.js","js/legacy.js","js/packs.js","js/runner.js","js/stats.js","packs/starter.json","icons/apple-touch-icon.png","icons/favicon-64.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","vendor/sql-wasm.js","vendor/sql-wasm.wasm"];
const CACHE = `par-timer-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('par-timer-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('./') : null);
    return hit || fetch(req);
  })());
});
