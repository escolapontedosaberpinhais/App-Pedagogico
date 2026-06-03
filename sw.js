const CACHE = 'ponte-saber-v17';
const STATIC = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firebase, APIs externas: sempre online
  if (url.includes('firestore') || url.includes('firebase') ||
      url.includes('googleapis') || url.includes('groq.com') ||
      url.includes('script.google.com')) {
    return;
  }

  // HTML (navegacao): network-first - sempre busca versao mais recente
  if (e.request.mode === 'navigate' ||
      url.endsWith('/') || url.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Outros assets (icones, manifest): cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

self.addEventListener('push', e => {
  let data = { titulo: 'Ponte do Saber', descricao: 'Nova pendencia de correcao', tab: 'correcao' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch(err) {}
  e.waitUntil(
    self.registration.showNotification(data.titulo, {
      body: data.descricao,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'pontesaber-push',
      data: { tab: data.tab || 'correcao' },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = e.notification.data?.tab || 'correcao';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'SHOW_TAB', tab });
          return client.focus();
        }
      }
      return clients.openWindow('/?tab=' + tab);
    })
  );
});