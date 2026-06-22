// Service Worker — La Ciudadela · Timbre
// Maneja push notifications en background

self.addEventListener('push', event => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'Timbre', body: event.data.text() }; }

  const title   = data.title || '🔔 Timbre — La Ciudadela';
  const options = {
    body:    data.body || 'Alguien tocó el timbre',
    icon:    'https://laciudadela-dlc.github.io/img/Logo_CDLC.png',
    badge:   'https://laciudadela-dlc.github.io/img/Logo_CDLC.png',
    tag:     'timbre',          // reemplaza notificaciones anteriores del timbre
    renotify: true,
    vibrate: [200, 100, 200, 100, 200],
    data:    { url: data.url || 'https://laciudadela-dlc.github.io/' },
    actions: [
      { action: 'ver', title: 'Ver portal' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://laciudadela-dlc.github.io/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Activar inmediatamente sin esperar recarga
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
