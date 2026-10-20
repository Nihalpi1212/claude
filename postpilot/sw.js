// Postpilot service worker: shows push notifications sent by the worker, and receives photos and
// videos shared into Postpilot from other apps (Android and desktop Chrome: the manifest's
// share_target; iOS has no share target). No offline caching: the app always loads fresh from
// GitHub Pages so updates apply immediately, and every request except the share POST goes straight
// to the network (no respondWith).

// The share mailbox. js/push.js (readShared / clearShared) reads the same cache and keys.
const SHARE_CACHE = 'postpilot-share';
const shareUrl = (name) => new URL(`__shared__/${name}`, self.registration.scope).href;
// Bounds on what one mailbox holds (LIMITS.carouselMax files; files past either bound are skipped).
const SHARE_MAX_FILES = 10;
const SHARE_MAX_BYTES = 300 * 1024 * 1024;
const SHARE_TEXT_MAX = 2200;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.origin + url.pathname !== new URL('share-target', self.registration.scope).href) return;
  event.respondWith(receiveShare(req));
});

/**
 * Keep the shared files and open the library, which uploads them. Any website can send this POST
 * (a service worker cannot tell a share sheet from another site's form), so a share never replaces
 * one still waiting in the mailbox: the new files and text are added to it, up to SHARE_MAX_FILES
 * files and SHARE_MAX_BYTES (the rest is skipped and counted in meta.skipped). Nothing reaches the
 * library until the owner adds it there.
 */
async function receiveShare(req) {
  let status = '1';
  try {
    const form = await req.formData();
    const files = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size > 0);
    const cache = await caches.open(SHARE_CACHE);
    const prev = await cache
      .match(shareUrl('meta'))
      .then((r) => (r ? r.json() : null))
      .catch(() => null);
    const list = prev && Array.isArray(prev.files) ? prev.files : [];
    let bytes = list.reduce((n, f) => n + (Number(f.size) || 0), 0);
    let skipped = (prev && Number(prev.skipped)) || 0;
    let next = list.reduce((n, f) => Math.max(n, Number(/file-(\d+)$/.exec(f.key || '')?.[1] ?? -1) + 1), 0);
    for (const f of files) {
      if (list.length >= SHARE_MAX_FILES || bytes + f.size > SHARE_MAX_BYTES) {
        skipped++;
        continue;
      }
      const key = shareUrl(`file-${next++}`);
      await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      list.push({ key, name: f.name || `shared-${list.length + 1}`, type: f.type || '', size: f.size });
      bytes += f.size;
    }
    const text = (name) => String(form.get(name) || '').slice(0, SHARE_TEXT_MAX);
    const add = { title: text('title'), text: text('text'), url: text('url') };
    // Earlier text first; a later share's text is added below it (and its link, when it differs).
    const old = prev || { title: '', text: '', url: '' };
    const extra = [add.text, add.url && old.url && add.url !== old.url ? add.url : ''].filter((t) => t && !String(old.text || '').includes(t));
    const meta = {
      files: list,
      title: old.title || add.title,
      text: [old.text, ...extra].filter(Boolean).join('\n\n').slice(0, SHARE_TEXT_MAX),
      url: old.url || add.url,
      at: (prev && prev.at) || new Date().toISOString(),
      skipped,
    };
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
