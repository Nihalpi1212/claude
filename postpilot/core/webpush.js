// Web Push without dependencies: RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID).
// Runs in browsers and Node 20+ (WebCrypto). Used by the worker to notify the owner's phone.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** New VAPID key pair: { publicKey (base64url, 65-byte raw point), privateKeyJwk } */
export async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64url(raw), privateKeyJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** Signed VAPID JWT for the push service origin. */
export async function vapidJwt({ audience, subject, privateKeyJwk, expiresInSec = 12 * 3600, nowSec = Math.floor(Date.now() / 1000) }) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: audience, exp: nowSec + expiresInSec, sub: subject })));
  const key = await subtle.importKey('jwk', { ...privateKeyJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * Encrypt a payload for one subscription (single aes128gcm record).
 * Returns the request body bytes.
 */
export async function encryptPayload({ p256dh, auth }, plaintext, { salt, serverKeyPair } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const as = serverKeyPair || (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublic = new Uint8Array(await subtle.exportKey('raw', as.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const s = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(s, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(s, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/**
 * Send one push message.
 * subscription: PushSubscription JSON { endpoint, keys: { p256dh, auth } }
 * vapid: { publicKey, privateKeyJwk, subject } (subject: 'mailto:...' or an https URL)
 * Returns { ok, status, gone } — gone=true means the subscription is dead and should be removed.
 */
export async function sendPush({ subscription, payload, vapid, ttl = 86400, urgency = 'normal', topic, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const body = await encryptPayload(subscription.keys, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await vapidJwt({ audience, subject: vapid.subject || 'mailto:owner@example.com', privateKeyJwk: vapid.privateKeyJwk });
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await doFetch(subscription.endpoint, { method: 'POST', headers, body });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
