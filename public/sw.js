const CACHE = 'smart-capturer-v8';
const ASSETS = ['/', '/capture', '/work', '/styles.css?v=7', '/app.js?v=7', '/direct-camera.js?v=6', '/launch-context.js?v=5', '/manifest.webmanifest?v=5'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
