// Service worker for the X32 Auto-Director PWA.
// Strategy: network-FIRST (this is a live control surface — always prefer the
// server), with the cached app shell as an offline fallback so the page still
// opens when the network drops. API and WebSocket traffic is never intercepted.
const CACHE = 'x32-director-v1';
const SHELL = [
  '/', '/control',
  '/static/style.css', '/static/app.js',
  '/static/control.css', '/static/control.js',
  '/static/icons/icon-192.png', '/static/icons/icon-512.png', '/static/icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((u) => c.add(u)));  // resilient: one 404 won't abort
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch API calls or the WebSocket — they must always hit the network.
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname === '/ws') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      // Refresh the cached shell in the background.
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    } catch {
      const cached = await caches.match(e.request);
      return cached || caches.match('/');
    }
  })());
});
