// TIFF metadata tags (ARCHITECTURE.md "0.5 features", S5), skeleton file. ICC: tag 34675; XMP: tag 700; IPTC: tag
// 33723; resolution: tags 282, 283 and 296 (EXIF, the ExifIFD of tag 34665, is metadata-io's in 0.6). Writing rebuilds
// IFD0 at the end of the file: entries sorted by tag, values over 4 bytes appended after it, the header's offset
// updated, the next-IFD pointer kept, both byte orders. Every other byte stays where it was, so the strip offsets and
// other IFDs the old entries point to are still right.
import { concat, round2, copyBytes, touches, fromUtf8, utf8 } from './bytes.js';

export const support = { read: ['icc', 'xmp', 'iptc', 'resolution'], write: ['icc', 'xmp', 'iptc', 'resolution'] };

const TAG = { icc: 34675, xmp: 700, iptc: 33723, xRes: 282, yRes: 283, resUnit: 296 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function byteOrder(b) {
  const le = b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0;
  const be = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42;
  if (!le && !be) throw new Error('Not a TIFF file (or a BigTIFF)');
  return le;
}

function io(le) {
  const u16 = (b, i) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (b, i) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  const w16 = (v) => (le ? Uint8Array.of(v & 255, (v >>> 8) & 255) : Uint8Array.of((v >>> 8) & 255, v & 255));
  const w32 = (v) => (le ? Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255) : Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  return { u16, u32, w16, w32 };
}

/** IFD0: { at, entries: [{ tag, type, count, value: Uint8Array (file byte order) }], next }. */
function ifd0(b) {
  const le = byteOrder(b);
  const { u16, u32 } = io(le);
  const at = u32(b, 4);
  if (at < 8 || at + 2 > b.length) throw new Error('TIFF IFD0 is outside the file');
  const n = u16(b, at);
  if (at + 2 + n * 12 + 4 > b.length) throw new Error('TIFF IFD0 is truncated');
  const entries = [];
  for (let k = 0; k < n; k++) {
    const e = at + 2 + k * 12;
    const tag = u16(b, e), type = u16(b, e + 2), count = u32(b, e + 4);
    const len = (SIZE[type] ?? 1) * count;
    const off = len <= 4 ? e + 8 : u32(b, e + 8);
    if (off + len > b.length) throw new Error(`TIFF tag ${tag} is outside the file`);
    entries.push({ tag, type, count, value: b.subarray(off, off + len) });
  }
  return { le, at, entries, next: u32(b, at + 2 + n * 12) };
}

export function read(b) {
  const { le, entries } = ifd0(b);
  const { u16, u32 } = io(le);
  const get = (tag) => entries.find((e) => e.tag === tag);
  const out = {};
  const icc = get(TAG.icc);
  if (icc) out.icc = copyBytes(icc.value);
  const xmp = get(TAG.xmp);
  if (xmp) out.xmp = fromUtf8(xmp.value);
  const iptc = get(TAG.iptc);
  if (iptc) out.iptc = copyBytes(iptc.value);
  const rational = (e) => (e && e.type === 5 && e.count >= 1 ? u32(e.value, 0) / (u32(e.value, 4) || 1) : null);
  const x = rational(get(TAG.xRes)), y = rational(get(TAG.yRes));
  if (x !== null || y !== null) {
    const unitTag = get(TAG.resUnit);
    const unit = unitTag ? u16(unitTag.value, 0) : 2;
    out.resolution = { x: round2(x ?? y), y: round2(y ?? x), unit: unit === 3 ? 'cm' : unit === 1 ? 'none' : 'in' };
  }
  return out;
}

export function write(b, patch) {
  const { le, entries, next } = ifd0(b);
  const { w16, w32 } = io(le);
  let list = entries.slice();
  const set = (tag, type, value, count = value?.length) => {
    list = list.filter((e) => e.tag !== tag);
    if (value) list.push({ tag, type, count, value });
  };
  if (touches(patch, 'icc')) set(TAG.icc, 7, patch.icc?.length ? patch.icc : null);
  if (touches(patch, 'xmp')) set(TAG.xmp, 1, patch.xmp ? utf8(patch.xmp) : null);
  if (touches(patch, 'iptc')) set(TAG.iptc, 7, patch.iptc?.length ? patch.iptc : null);
  if (touches(patch, 'resolution')) {
    const r = patch.resolution;
    const rat = (v) => {
      const den = Number.isInteger(v) ? 1 : 1000;
      return concat([w32(Math.max(0, Math.round(v * den)) >>> 0), w32(den)]);
    };
    set(TAG.xRes, 5, r ? rat(r.x) : null, 1);
    set(TAG.yRes, 5, r ? rat(r.y) : null, 1);
    set(TAG.resUnit, 3, r ? concat([w16(r.unit === 'cm' ? 3 : r.unit === 'none' ? 1 : 2), w16(0)]) : null, 1);
  }
  list.sort((p, q) => p.tag - q.tag);
  // the new IFD0 at the end of the file, on a word boundary; its long values right after it
  const start = b.length + (b.length % 2);
  const dirSize = 2 + list.length * 12 + 4;
  let dataAt = start + dirSize;
  const dir = [w16(list.length)];
  const data = [];
  for (const e of list) {
    const len = e.value.length;
    let field;
    if (len <= 4) {
      field = new Uint8Array(4);
      field.set(e.value.subarray(0, len));
    } else {
      field = w32(dataAt);
      data.push(e.value);
      if (len % 2) data.push(Uint8Array.of(0));
      dataAt += len + (len % 2);
    }
    dir.push(w16(e.tag), w16(e.type), w32(e.count), field);
  }
  dir.push(w32(next));
  const head = new Uint8Array(b);
  head.set(w32(start), 4);
  return concat([head, b.length % 2 ? Uint8Array.of(0) : new Uint8Array(0), ...dir, ...data]);
}
