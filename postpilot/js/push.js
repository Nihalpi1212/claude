// Service worker and push notifications: register sw.js on app start (push notifications and the
// Android share target), subscribe this device, store the subscription (encrypted) in
// settings.notifications so the worker can notify the owner, and read what was shared into Postpilot.

import { generateVapidKeys, fromB64url } from '../core/webpush.js';
import { mutate, readDoc } from './data.js';

export const NOTIFY_EVENTS = [
  { id: 'published', label: 'A post was published' },
  { id: 'failed', label: 'A post failed to publish' },
  { id: 'approval', label: 'Autopilot drafts need approval' },
  { id: 'dm', label: 'New direct messages' },
  { id: 'comment', label: 'New comments' },
  { id: 'account', label: 'Instagram connection problems' },
  { id: 'reminder', label: 'Time to post a reminder post by hand' },
  { id: 'report', label: 'Monthly report is ready' },
  { id: 'collab', label: 'New collaboration invites' },
];

export function defaultNotifications() {
  return {
    vapid: null,
    subscriptions: [],
    events: { published: true, failed: true, approval: true, dm: true, comment: false, account: true, reminder: true, report: true, collab: true },
  };
}

/**
 * Whether a reminder post's notification can reach a phone (the worker checks the same, see
 * worker/jobs/publish.mjs): 'ok', 'no_devices' (no device has notifications turned on) or 'off'
 * (the reminder event is turned off in Settings).
 */
export function reminderDelivery(settings) {
  const cfg = (settings && settings.notifications) || {};
  const subs = (cfg.subscriptions || []).filter((s) => s && s.endpoint && s.keys);
  if (!cfg.vapid || !subs.length) return 'no_devices';
  if (cfg.events && cfg.events.reminder === false) return 'off';
  return 'ok';
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iOS only allows web push for apps added to the Home Screen. */
export function needsHomeScreenInstall() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return ios && !standalone;
}

async function registration() {
  return navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname });
}

/**
 * Register the service worker on app start, so notifications and sharing into Postpilot work without
 * turning on push first. Never throws; resolves with the registration or null.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await registration();
  } catch {
    return null; // e.g. a private window that blocks service workers
  }
}

// ---- Shared into Postpilot (manifest share_target -> sw.js) ----
// sw.js keeps only the latest share in this cache: __shared__/meta (JSON) and __shared__/file-<i>.

const SHARE_CACHE = 'postpilot-share';
const shareKey = (name) => new URL(`../__shared__/${name}`, import.meta.url).href;

/**
 * What another app shared into Postpilot, or null: { files: File[], title, text, url, at }.
 * Files that can no longer be read are left out.
 */
export async function readShared() {
  if (!('caches' in globalThis)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match(shareKey('meta'));
  if (!metaRes) return null;
  const meta = await metaRes.json().catch(() => null);
  if (!meta) return null;
  const files = [];
  for (const f of meta.files || []) {
    const res = await cache.match(f.key);
    if (!res) continue;
    const blob = await res.blob();
    files.push(new File([blob], f.name || 'shared', { type: f.type || blob.type || '' }));
  }
  return { files, title: meta.title || '', text: meta.text || '', url: meta.url || '', at: meta.at || null };
}

/** Forget the shared files (after they were uploaded or dismissed). */
export async function clearShared() {
  if ('caches' in globalThis) await caches.delete(SHARE_CACHE);
}

/** Ask permission, subscribe this device and save it. Returns the saved subscription. */
export async function enablePush({ deviceName } = {}) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications.');
  if (needsHomeScreenInstall()) throw new Error('On iPhone and iPad, add Postpilot to your Home Screen first (Share → Add to Home Screen), then turn on notifications from there.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings and try again.');
  let settings = await readDoc('settings');
  let vapid = settings.notifications && settings.notifications.vapid;
  if (!vapid) {
    const keys = await generateVapidKeys();
    vapid = { ...keys, subject: 'mailto:postpilot@users.noreply.github.com' };
    await mutate('settings', (s) => {
      s.notifications = { ...defaultNotifications(), ...(s.notifications || {}) };
      if (!s.notifications.vapid) s.notifications.vapid = vapid;
      vapid = s.notifications.vapid;
    }, { message: 'create push keys' });
  }
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const appKey = fromB64url(vapid.publicKey);
  if (sub) {
    const current = sub.options && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (!current || current.length !== appKey.length || current.some((b, i) => b !== appKey[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  const json = sub.toJSON();
  const record = { endpoint: json.endpoint, keys: json.keys, device: deviceName || describeDevice(), createdAt: new Date().toISOString() };
  await mutate('settings', (s) => {
    s.notifications = { ...defaultNotifications(), ...(s.notifications || {}) };
    s.notifications.subscriptions = [...s.notifications.subscriptions.filter((x) => x.endpoint !== record.endpoint), record];
  }, { message: 'add push device' });
  return record;
}

/** Endpoint of this device's current subscription, or null. */
export async function currentEndpoint() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(new URL('../', import.meta.url).pathname);
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? sub.endpoint : null;
}

export async function removeDevice(endpoint) {
  const mine = await currentEndpoint().catch(() => null);
  if (mine === endpoint) {
    const reg = await navigator.serviceWorker.getRegistration(new URL('../', import.meta.url).pathname);
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe().catch(() => {});
  }
  await mutate('settings', (s) => {
    if (s.notifications) s.notifications.subscriptions = (s.notifications.subscriptions || []).filter((x) => x.endpoint !== endpoint);
  }, { message: 'remove push device' });
}

function describeDevice() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}
