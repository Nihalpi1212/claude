// Push notifications to the owner's devices (settings.notifications, see js/push.js and sw.js).
//
// Jobs queue events with ctx.notify(event, detail) during the run; sendNotifications() coalesces
// them into at most one push per event type and sends them with Web Push (core/webpush.js) to every
// subscribed device. Payloads are end-to-end encrypted to the device, so they may name the post or
// the sender. Subscriptions the push service reports as gone (404/410) are removed from settings.
//
// Events (settings.notifications.events toggles): published, failed, approval, dm, comment, account.

import { sendPush } from '../core/webpush.js';
import { describeError } from './context.mjs';

export const NOTIFY_DEFAULTS = { published: true, failed: true, approval: true, dm: true, comment: false, account: true };
const MAX_BODY = 180;

const clip = (s, n = MAX_BODY) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n, one, many) => (n === 1 ? one : many.replace('{n}', n));
const TYPE_NAMES = { feed: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };

/** Build one payload {title, body, tag, url} from all queued items of one event type. */
export function buildPayload(event, items) {
  const n = items.reduce((sum, it) => sum + (it.count || 1), 0);
  const first = items[0] || {};
  switch (event) {
    case 'published':
      return {
        title: n === 1 ? `Your ${TYPE_NAMES[first.type] || 'post'} is live` : `${n} posts published`,
        body: first.caption ? clip(first.caption) : 'Published on Instagram.',
        tag: 'postpilot-published',
        url: './#/planner',
      };
    case 'failed':
      return {
        title: plural(n, 'A post failed to publish', '{n} posts failed to publish'),
        body: clip(first.message || 'Open Postpilot to see what went wrong.'),
        tag: 'postpilot-failed',
        url: './#/planner',
      };
    case 'approval':
      return {
        title: 'Autopilot drafts need your approval',
        body: plural(n, '1 new post is waiting for review.', '{n} new posts are waiting for review.'),
        tag: 'postpilot-approval',
        url: './#/autopilot',
      };
    case 'dm':
      return {
        title: plural(n, 'New message', '{n} new messages'),
        body: clip(`${first.username ? `@${first.username}: ` : ''}${first.text || 'Sent you a message.'}`),
        tag: 'postpilot-dm',
        url: './#/inbox',
      };
    case 'comment':
      return {
        title: plural(n, 'New comment', '{n} new comments'),
        body: clip(`${first.username ? `@${first.username}: ` : ''}${first.text || ''}`),
        tag: 'postpilot-comment',
        url: './#/inbox',
      };
    case 'account':
      return {
        title: 'Instagram needs attention',
        body: clip(first.message || 'Open Postpilot settings to reconnect Instagram.'),
        tag: 'postpilot-account',
        url: './#/settings',
      };
    default:
      return null;
  }
}

/**
 * Send queued notifications. Returns {sent, failed, removed}.
 * Never throws: push problems are logged to the encrypted activity log only.
 */
export async function sendNotifications(ctx, { fetchImpl } = {}) {
  const queued = ctx.notifications || [];
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!queued.length) return result;
  const cfg = ctx.settings.notifications || {};
  const subs = (cfg.subscriptions || []).filter((s) => s && s.endpoint && s.keys && s.keys.p256dh && s.keys.auth);
  if (!cfg.vapid || !cfg.vapid.privateKeyJwk || !cfg.vapid.publicKey || !subs.length) return result;
  const events = { ...NOTIFY_DEFAULTS, ...(cfg.events || {}) };

  const byEvent = new Map();
  for (const it of queued) {
    if (!events[it.event]) continue;
    if (!byEvent.has(it.event)) byEvent.set(it.event, []);
    byEvent.get(it.event).push(it);
  }
  const gone = new Set();
  for (const [event, items] of byEvent) {
    const payload = buildPayload(event, items);
    if (!payload) continue;
    for (const sub of subs) {
      if (gone.has(sub.endpoint)) continue;
      try {
        const res = await sendPush({ subscription: sub, payload, vapid: cfg.vapid, ttl: 6 * 3600, urgency: event === 'failed' || event === 'account' ? 'high' : 'normal', topic: payload.tag, fetchImpl });
        if (res.ok) result.sent++;
        else {
          result.failed++;
          if (res.gone) gone.add(sub.endpoint);
          else ctx.log('notify', 'warn', `A push notification was refused (HTTP ${res.status}).`);
        }
      } catch (err) {
        result.failed++;
        ctx.log('notify', 'warn', `Could not send a push notification: ${describeError(err)}`);
      }
    }
  }
  if (gone.size) {
    try {
      await ctx.store.transact(
        async (tx) => {
          const s = await tx.read('settings');
          if (!s.notifications) return;
          const before = (s.notifications.subscriptions || []).length;
          s.notifications.subscriptions = (s.notifications.subscriptions || []).filter((x) => !gone.has(x.endpoint));
          result.removed = before - s.notifications.subscriptions.length;
          if (result.removed) tx.write('settings', s);
        },
        { message: 'notifications: remove expired devices' },
      );
      if (result.removed) ctx.log('notify', 'info', `Removed ${result.removed} device${result.removed === 1 ? '' : 's'} that no longer accept notifications.`);
    } catch (err) {
      ctx.log('notify', 'warn', `Could not remove expired devices: ${describeError(err)}`);
    }
  }
  return result;
}
