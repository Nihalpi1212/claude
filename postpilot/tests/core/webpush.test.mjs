import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, generateVapidKeys, vapidJwt, sendPush, b64url, fromB64url } from '../../core/webpush.js';

const subtle = globalThis.crypto.subtle;

// Minimal RFC 8291 decryption (what a browser does) to check our encryption.
async function decrypt(body, uaKeyPair, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', uaKeyPair.publicKey));
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeyPair.privateKey, 256));
  const hk = async (s, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hk(authSecret, secret, info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(plain[plain.length - 1], 2, 'last-record padding delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('web push payload decrypts like a browser would', async () => {
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64url(new Uint8Array(await subtle.exportKey('raw', ua.publicKey)));
  const body = await encryptPayload({ p256dh, auth: b64url(auth) }, JSON.stringify({ title: 'Published ✓' }));
  assert.equal(JSON.parse(await decrypt(body, ua, auth)).title, 'Published ✓');
});

test('VAPID JWT is a valid ES256 signature over header.claims', async () => {
  const v = await generateVapidKeys();
  const jwt = await vapidJwt({ audience: 'https://web.push.apple.com', subject: 'mailto:a@b.c', privateKeyJwk: v.privateKeyJwk, nowSec: 1000 });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(c))), { aud: 'https://web.push.apple.com', exp: 1000 + 43200, sub: 'mailto:a@b.c' });
  const pub = await subtle.importKey('raw', fromB64url(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(s), new TextEncoder().encode(`${h}.${c}`)));
});

test('sendPush reports dead subscriptions', async () => {
  const v = await generateVapidKeys();
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: b64url(new Uint8Array(await subtle.exportKey('raw', ua.publicKey))), auth: b64url(new Uint8Array(16)) };
  let seen;
  const r = await sendPush({
    subscription: { endpoint: 'https://push.example.com/abc', keys },
    payload: { title: 'x' },
    vapid: v,
    fetchImpl: async (url, opts) => ((seen = opts), { status: 410 }),
  });
  assert.equal(r.gone, true);
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen.headers.Authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);
});
