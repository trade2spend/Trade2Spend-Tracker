const CACHE = 't2s-v10';
const SHELL = ['./index.html','./login.html','./welcome.html','./logo.png','./manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Trade2Spend', {
    body: d.body || 'New update',
    icon: './logo.png',
    badge: './logo.png',
    tag: d.tag || 't2s-notif',
    renotify: true,
    data: { url: d.url || './#updates' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data || {}).url || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
      const w = ws.find(c => c.url.includes('trade2spend') || c.url.includes('app.trade2spend'));
      if (w) { w.focus(); return; }
      return clients.openWindow(url);
    })
  );
});
