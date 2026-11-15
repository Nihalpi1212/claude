// Byte helpers shared by the container chunk modules (ARCHITECTURE.md "0.5 features", S5), skeleton file. Node-safe.

export const ascii = (b, i, n) => {
  let s = '';
  for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
  return s;
};
export const asciiBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const u16be = (b, i) => (b[i] << 8) | b[i + 1];
export const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
export const u16le = (b, i) => b[i] | (b[i + 1] << 8);
export const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
export const startsWith = (b, i, s) => ascii(b, i, s.length) === s;

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const be16 = (v) => Uint8Array.of((v >>> 8) & 255, v & 255);
export const be32 = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
export const le32 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
export const le24 = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255);

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder('utf-8').decode(b);
export const latin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** A copy of `b` as its own Uint8Array (chunk values never alias the file's buffer). */
export const copyBytes = (b) => new Uint8Array(b);

/** True when the patch has a value (or null, which removes) for `kind`. */
export const touches = (patch, kind) => patch && Object.prototype.hasOwnProperty.call(patch, kind) && patch[kind] !== undefined;

// ---- Photoshop image resources ('8BIM' blocks: JPEG APP13, PSD's resource section) -----------------------------

/**
 * Parses a run of 8BIM resource blocks: [{ id, name: Uint8Array (the Pascal string, padded), data }]. Throws on damage;
 * with `onDamage` (readers only) the blocks before the damage are returned after a call to it (S5).
 */
export function parseResources(b, start = 0, end = b.length, onDamage = null) {
  const out = [];
  const damaged = (msg) => {
    if (!onDamage) throw new Error(msg);
    onDamage();
    return out;
  };
  let i = start;
  while (i + 12 <= end) {
    const sig = ascii(b, i, 4);
    if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'AgHg' && sig !== 'PHUT' && sig !== 'DCSR') return damaged('bad image resource signature');
    const id = u16be(b, i + 4);
    const nlen = b[i + 6];
    const npad = (nlen + 1) % 2 ? nlen + 2 : nlen + 1; // the Pascal string padded to an even size
    const at = i + 6 + npad;
    if (at + 4 > end) return damaged('image resource is truncated');
    const size = u32be(b, at);
    if (at + 4 + size > end) return damaged('image resource is truncated');
    out.push({ sig, id, name: b.slice(i + 6, i + 6 + npad), data: b.slice(at + 4, at + 4 + size) });
    i = at + 4 + size + (size % 2);
  }
  return out;
}

/** Serialises resource blocks again (each data padded to an even size). */
export function writeResources(list) {
  const parts = [];
  for (const r of list) {
    parts.push(asciiBytes(r.sig ?? '8BIM'), be16(r.id), r.name ?? Uint8Array.of(0, 0), be32(r.data.length), r.data);
    if (r.data.length % 2) parts.push(Uint8Array.of(0));
  }
  return concat(parts);
}

/** Replaces (data), removes (null) or keeps (undefined) the resource `id` in a block list, in place of the old one. */
export function setResource(list, id, data) {
  if (data === undefined) return list;
  const at = list.findIndex((r) => r.id === id);
  const rest = list.filter((r) => r.id !== id);
  if (data === null) return rest;
  const entry = { sig: '8BIM', id, name: Uint8Array.of(0, 0), data };
  if (at < 0) return [...rest, entry];
  rest.splice(at, 0, entry);
  return rest;
}

// ---- PSD ResolutionInfo (resource 1005) ----------------------------------------------------------------------

/** { x, y, unit } from a ResolutionInfo block (16.16 fixed pixels per inch; unit 2 shows centimetres). */
export function resolutionFromPsd(d) {
  if (!d || d.length < 16) return null;
  const hRes = u32be(d, 0) / 65536, hUnit = u16be(d, 4), vRes = u32be(d, 8) / 65536;
  if (hUnit === 2) return { x: round2(hRes / 2.54), y: round2(vRes / 2.54), unit: 'cm' };
  return { x: round2(hRes), y: round2(vRes), unit: 'in' };
}

/** A ResolutionInfo block for { x, y, unit } ('none' is written as pixels per inch). */
export function resolutionToPsd(r) {
  const cm = r.unit === 'cm';
  const ppi = (v) => Math.max(1, Math.round((cm ? v * 2.54 : v) * 65536)) >>> 0;
  const unit = cm ? 2 : 1;
  return concat([be32(ppi(r.x)), be16(unit), be16(cm ? 2 : 1), be32(ppi(r.y)), be16(unit), be16(cm ? 2 : 1)]);
}

export const round2 = (v) => Math.round(v * 100) / 100;
