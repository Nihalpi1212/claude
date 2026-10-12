// Postpilot service worker: shows push notifications sent by the worker, and receives photos and
// videos shared into Postpilot from other apps (Android and desktop Chrome: the manifest's
// share_target; iOS has no share target). No offline caching: the app always loads fresh from
// GitHub Pages so updates apply immediately, and every request except the share POST goes straight
// to the network (no respondWith).

// The share mailbox. js/push.js (readShared / clearShared) reads the same cache and keys.
const SHARE_CACHE = 'postpilot-share';
const shareUrl = (name) => new URL(`__shared__/${name}`, self.registration.scope).href;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.origin + url.pathname !== new URL('share-target', self.registration.scope).href) return;
  event.respondWith(receiveShare(req));
});

/** Keep the shared files (only the latest share) and open the library, which uploads them. */
async function receiveShare(req) {
  let status = '1';
  try {
    const form = await req.formData();
    const files = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size > 0);
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    const list = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = shareUrl(`file-${i}`);
      await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      list.push({ key, name: f.name || `shared-${i + 1}`, type: f.type || '', size: f.size });
    }
    const text = (name) => String(form.get(name) || '').slice(0, 2200);
    const meta = { files: list, title: text('title'), text: text('text'), url: text('url'), at: new Date().toISOString() };
    await cache.put(shareUrl('meta'), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    status = 'error';
  }
  return Response.redirect(new URL(`./#/library?shared=${status}`, self.registration.scope).href, 303);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Postpilot', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          if ('navigate' in client) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
