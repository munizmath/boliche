const CACHE_NAME = 'boliche-shell-v4';
const SHELL = [
  './', './index.html', './styles.css?v=20261113-4', './app.js?v=20261113-4', './supabase-config.js',
  './logo.png', './share-qr.png', './manifest.webmanifest',
  './pwa-192.png', './pwa-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && (request.mode === 'navigate' || SHELL.some((asset) => {
      const shellUrl = new URL(asset, self.registration.scope);
      return url.pathname === shellUrl.pathname && url.search === shellUrl.search;
    }))) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
    }
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
