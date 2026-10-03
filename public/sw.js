// Service worker di Treni Live: riceve le notifiche della guida anche a schermo spento.
// Non mette niente in cache (la mappa è dal vivo: meglio sempre la versione aggiornata).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'Treni Live', body: e.data ? e.data.text() : '' };
  }
  const title = d.title || 'Treni Live';
  e.waitUntil(
    (async () => {
      // Le notifiche vanno sempre mostrate: iPhone e Chrome tolgono il permesso a chi non lo fa.
      await self.registration.showNotification(title, {
        body: d.body || '',
        tag: d.tag || 'guida',
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-badge.png',
        vibrate: [250, 120, 250],
        data: { url: d.url || '/' },
      });
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of cs) c.postMessage({ type: 'guide-push', ...d });
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (cs.length) return cs[0].focus();
      return self.clients.openWindow(e.notification.data?.url || '/');
    })()
  );
});
