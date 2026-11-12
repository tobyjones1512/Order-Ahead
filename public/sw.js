// App-shell cache (network-first, so deploys show up immediately) + web push.
const CACHE = 'docket-v2';
const SHELL = ['/', '/app.js', '/ui.js', '/pricing.js', '/allergens.js', '/style.css', '/m/', '/m/m.js', '/fonts/Doto-900.woff2', '/fonts/ChivoMono-400.woff2', '/fonts/ChivoMono-500.woff2', '/fonts/ChivoMono-700.woff2'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  const d = e.data?.json() || {};
  e.waitUntil(self.registration.showNotification(d.title || 'Docket', {
    body: d.body, icon: '/icons/icon-192.png', data: d.url || '/', tag: d.tag, renotify: !!d.tag, requireInteraction: !!d.urgent, // urgent (new orders) stay on screen until tapped
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data, location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    const open = all.find((c) => c.url.startsWith(url));
    return open ? open.focus() : clients.openWindow(url);
  }));
});
