// Envelope encryption shared by the browser app and the Node worker (WebCrypto only).
//
// A random 256-bit data key encrypts every private file. The data key itself is
// stored in the repo "wrapped" (encrypted) by a key derived from the owner's
// passphrase, and handed to the worker directly through the POSTPILOT_DATA_KEY
// Actions secret. Changing the passphrase re-wraps the same data key; js/session.js
// rotateDataKey() replaces the data key and re-encrypts everything.

const subtle = globalThis.crypto.subtle;
const MAGIC = [0x50, 0x50, 0x31]; // "PP1"
const IV_BYTES = 12;

export const KDF_ITERATIONS = 600000;

export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase does not unlock this data.');
    this.name = 'WrongPassphraseError';
  }
}

export class DecryptError extends Error {
  constructor(message = 'Could not decrypt data. The data key may be wrong or the file is damaged.') {
    super(message);
    this.name = 'DecryptError';
  }
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  // getRandomValues is limited to 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function b64encode(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const clean = String(str).replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(str) {
  return new TextEncoder().encode(str);
}

export function fromUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

export function randomToken(bytes = 16) {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateDataKey() {
  return randomBytes(32);
}

export async function importDataKey(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new DecryptError('The data key must be 32 bytes.');
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveWrappingKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Build the plaintext keyring.json stored at the root of the data branch. */
export async function createKeyring(passphrase, dataKeyRaw, iterations = KDF_ITERATIONS) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = randomBytes(16);
  const kek = await deriveWrappingKey(passphrase, salt, iterations);
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, kek, dataKeyRaw));
  return {
    v: 1,
    app: 'postpilot',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64encode(salt) },
    wrapped: b64encode(concat(iv, ct)),
    createdAt: new Date().toISOString(),
  };
}

/** Returns the raw 32-byte data key, or throws WrongPassphraseError. */
export async function unlockKeyring(keyring, passphrase) {
  if (!keyring || keyring.v !== 1 || !keyring.kdf || !keyring.wrapped) throw new Error('keyring.json is missing or damaged.');
  const kek = await deriveWrappingKey(passphrase, b64decode(keyring.kdf.salt), keyring.kdf.iterations);
  const blob = b64decode(keyring.wrapped);
  try {
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, IV_BYTES) }, kek, blob.subarray(IV_BYTES));
    return new Uint8Array(raw);
  } catch {
    throw new WrongPassphraseError();
  }
}

export async function encryptBytes(key, bytes) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return concat(new Uint8Array(MAGIC), iv, ct);
}

export async function decryptBytes(key, data) {
  if (!data || data.length < MAGIC.length + IV_BYTES + 16 || MAGIC.some((b, i) => data[i] !== b)) {
    throw new DecryptError('This file is not a Postpilot encrypted file.');
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, data.subarray(MAGIC.length + IV_BYTES)));
  } catch {
    throw new DecryptError();
  }
}

export async function encryptJSON(key, value) {
  return encryptBytes(key, utf8(JSON.stringify(value)));
}

export async function decryptJSON(key, data) {
  return JSON.parse(fromUtf8(await decryptBytes(key, data)));
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const COMMON_PASSPHRASES = [
  'password', 'passphrase', 'instagram', 'postpilot', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'iloveyou', 'letmein',
  'welcome', 'sunflower', 'sunflowers', 'football', 'baseball', 'dragon', 'monkey', 'princess', 'master', 'shadow',
  'superman', 'starwars', 'whatever', 'trustno', 'abcdefgh', 'abcdefghij', 'changeme', 'secret', 'mypassword',
  'mysecret', 'loveyou', 'admin', 'administrator', 'photography', 'photographer', 'creator', 'business', 'socialmedia',
];

/**
 * Why a passphrase is too weak to protect a keyring that anyone can download and attack offline,
 * or null when it is acceptable. Rules: 12+ characters, not a common password (ignoring digits and
 * symbols), not repetitive, and either 3+ words, 16+ characters, or 3 character classes.
 */
export function passphraseProblem(passphrase) {
  const p = String(passphrase || '').normalize('NFKC');
  if (p.length < 12) return 'Use at least 12 characters. A short sentence of three or four words works well.';
  const letters = p.toLowerCase().replace(/[^a-z]/g, '');
  if (COMMON_PASSPHRASES.some((w) => letters === w || letters === w + w)) return 'That passphrase is too common. Use a sentence only you would think of.';
  if (new Set(p.toLowerCase()).size < 6) return 'That passphrase is too repetitive. Mix in more different characters or words.';
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 2).length;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (words >= 3 || p.length >= 16 || classes >= 3) return null;
  return 'Make it stronger: use three or more words, or at least 16 characters.';
}
