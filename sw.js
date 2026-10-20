// The Pages build replaces this token with a hash of the published app shell.
const VERSION = '__CANLAB_CACHE_VERSION__';
const PREFIX = `canlab:${new URL(self.registration.scope).pathname}:`;
const CACHE = PREFIX + VERSION;
const FILES = [
  './', './index.html', './debug/', './debug/index.html',
  './debug/i18n.mjs', './debug/translations.mjs', './debug/style.css', './debug/app.mjs', './debug/pwa.mjs',
  './debug/protocol.mjs', './debug/communication.mjs', './debug/load-test.mjs',
  './docs/canbus-communication.svg', './docs/canbus-breadboard.svg',
  './manifest.webmanifest', './pwa/icons/icon-192.png', './pwa/icons/icon-512.png',
  './pwa/icons/maskable-192.png', './pwa/icons/maskable-512.png',
  './pwa/icons/apple-touch-icon-180.png', './pwa/icons/favicon-32.png'
];
const URLS = FILES.map(path => new URL(path, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS)));
  // Keep updates waiting until existing tabs close; never interrupt a USB session.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = ''; url.hash = '';
  // Cache only bundled app files, never external requests or serial log data.
  if (!URLS.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        try { await cache.put(url.href, response.clone()); } catch { /* Storage may be full. */ }
        return response;
      }
      return (await cache.match(url.href)) || response;
    } catch (error) {
      const saved = await cache.match(url.href);
      if (saved) return saved;
      throw error;
    }
  })());
});
