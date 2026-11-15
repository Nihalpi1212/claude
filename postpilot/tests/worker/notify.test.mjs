import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerEnv, visibleLines } from '../helpers/worker-env.mjs';
import { b64url, generateVapidKeys } from '../../core/webpush.js';
import { newPost } from '../../core/model.js';
import { buildPayload } from '../../worker/notify.mjs';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

async function device(url, name) {
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64url(new Uint8Array(await subtle.exportKey('raw', keys.publicKey)));
  return { keys, auth, sub: { endpoint: `${url}/push/${name}`, keys: { p256dh, auth: b64url(auth) }, device: name, createdAt: new Date().toISOString() } };
}

/** RFC 8291 decryption, as the browser does it. */
async function decrypt(body, ua, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const ikm = await hk(authSecret, secret, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

test('publishing sends a push to subscribed devices and drops dead subscriptions', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await device(env.url, 'phone');
  const old = await device(env.url, 'gone-laptop');
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone.sub, old.sub], events: { published: true, failed: true, approval: true, dm: true, comment: false, account: true } };
  });
  const asset = await env.addAsset('f01.jpg');
  await env.update('posts', (d) => void d.posts.push(newPost({ status: 'scheduled', scheduledAt: new Date(Date.now() - 1000).toISOString(), caption: 'Kiln day is here', media: [{ assetId: asset.id, kind: 'image' }] })));

  const res = await env.run({ only: ['publish'] });
  assert.equal(res.exitCode, 0);
  const toPhone = env.pushes.filter((p) => p.path === '/phone');
  assert.equal(toPhone.length, 1);
  assert.match(toPhone[0].headers.authorization, /^vapid t=.+, k=/);
  assert.equal(toPhone[0].headers['content-encoding'], 'aes128gcm');
  const payload = await decrypt(toPhone[0].body, phone.keys, phone.auth);
  assert.equal(payload.title, 'Your post is live');
  assert.equal(payload.body, 'Kiln day is here');
  assert.equal(payload.url, './#/planner');
  assert.ok(res.lines.includes('notifications: 1 sent, 1 failed'));
  assert.ok(!visibleLines(res.lines).join('\n').includes('Kiln day'));

  const settings = await env.read('settings');
  assert.deepEqual(settings.notifications.subscriptions.map((s) => s.device), ['phone'], 'the gone subscription was removed');
  const log = await env.read('log');
  assert.deepEqual(log.runs[0].notifications, { sent: 1, failed: 1, removed: 1 });
});

test('new DMs notify (even with automations off); disabled event types do not', async (t) => {
  const env = await startWorkerEnv();
  t.after(() => env.close());
  const phone = await device(env.url, 'phone');
  const vapid = { ...(await generateVapidKeys()), subject: 'mailto:owner@example.com' };
  await env.update('settings', (s) => {
    s.notifications = { vapid, subscriptions: [phone.sub], events: { dm: true, comment: false } };
  });
  await env.update('automations', (a) => void (a.enabled = false));
  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 0, 'nothing on the first run');

  env.addMessage({ username: 'mara.lens', text: 'Do you ship to Canada?' });
  env.addComment(env.graph.state.media[0].id, { username: 'fan', text: 'Gorgeous' });
  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 1, 'one push for the DM, none for comments (turned off)');
  const payload = await decrypt(env.pushes[0].body, phone.keys, phone.auth);
  assert.equal(payload.title, 'New message');
  assert.equal(payload.body, '@mara.lens: Do you ship to Canada?');
  assert.equal(payload.url, './#/inbox');

  await env.run({ only: ['automations'] });
  assert.equal(env.pushes.length, 1, 'no repeat');
});

test('payloads are coalesced per event type', () => {
  assert.equal(buildPayload('failed', [{ message: 'A' }, { message: 'B' }]).title, '2 posts failed to publish');
  assert.equal(buildPayload('approval', [{ count: 3 }]).body, '3 new posts are waiting for review.');
  assert.equal(buildPayload('comment', [{ count: 4, username: 'x', text: 'hi' }]).title, '4 new comments');
  assert.equal(buildPayload('published', [{ type: 'reel', caption: '' }]).title, 'Your reel is live');
  assert.equal(buildPayload('nope', []), null);
});
