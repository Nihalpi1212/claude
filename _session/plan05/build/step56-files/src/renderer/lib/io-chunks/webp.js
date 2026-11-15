// WebP metadata chunks (ARCHITECTURE.md "0.5 features", S5), skeleton file. ICC: ICCP; EXIF: EXIF; XMP: "XMP ". A
// simple file (one VP8 or VP8L chunk) that gains a chunk becomes an extended one: a VP8X chunk first, with the canvas
// size from the VP8 / VP8L header and the flags set. Every other chunk is kept byte for byte, in its order.
import { ascii, asciiBytes, concat, le32, le24, u32le, u16le, startsWith, fromUtf8, utf8, copyBytes, touches } from './bytes.js';

export const support = { read: ['icc', 'exif', 'xmp'], write: ['icc', 'exif', 'xmp'] };

const FLAG = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 };

function chunksOf(b) {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') throw new Error('Not a WebP file');
  const end = Math.min(b.length, 8 + u32le(b, 4));
  const list = [];
  let i = 12;
  while (i + 8 <= end) {
    const type = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    if (i + 8 + size > end) throw new Error(`WebP chunk ${type} is truncated`);
    list.push({ type, data: b.subarray(i + 8, i + 8 + size) });
    i += 8 + size + (size % 2);
  }
  if (!list.length) throw new Error('WebP has no chunks');
  return list;
}

const raw = (c) => concat([asciiBytes(c.type), le32(c.data.length), c.data, c.data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0)]);

export function read(b) {
  const out = {};
  for (const c of chunksOf(b)) {
    if (c.type === 'ICCP' && out.icc === undefined) out.icc = copyBytes(c.data);
    else if (c.type === 'EXIF' && out.exif === undefined) out.exif = copyBytes(startsWith(c.data, 0, 'Exif\0\0') ? c.data.subarray(6) : c.data);
    else if (c.type === 'XMP ' && out.xmp === undefined) out.xmp = fromUtf8(c.data);
  }
  return out;
}

/** { width, height, alpha } of the image chunk of a simple file, for its new VP8X header. */
function canvasOf(list) {
  const vp8l = list.find((c) => c.type === 'VP8L');
  if (vp8l) {
    const d = vp8l.data;
    if (d[0] !== 0x2f) throw new Error('bad VP8L header');
    const bits = u32le(d, 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: !!((bits >>> 28) & 1) };
  }
  const vp8 = list.find((c) => c.type === 'VP8 ');
  if (vp8) {
    const d = vp8.data;
    if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error('bad VP8 header');
    return { width: u16le(d, 6) & 0x3fff, height: u16le(d, 8) & 0x3fff, alpha: list.some((c) => c.type === 'ALPH') };
  }
  throw new Error('WebP has no image chunk');
}

export function write(b, patch) {
  let list = chunksOf(b).map((c) => ({ ...c }));
  const set = (type, data) => {
    const at = list.findIndex((c) => c.type === type);
    list = list.filter((c) => c.type !== type);
    if (!data?.length) return;
    // the order of the format: VP8X, ICCP, (ANIM, ALPH, image), EXIF, XMP
    if (at >= 0) list.splice(at, 0, { type, data });
    else if (type === 'ICCP') list.splice(list[0]?.type === 'VP8X' ? 1 : 0, 0, { type, data });
    else if (type === 'EXIF') {
      const xmp = list.findIndex((c) => c.type === 'XMP ');
      list.splice(xmp >= 0 ? xmp : list.length, 0, { type, data });
    } else list.push({ type, data });
  };
  if (touches(patch, 'icc')) set('ICCP', patch.icc);
  if (touches(patch, 'exif')) set('EXIF', patch.exif);
  if (touches(patch, 'xmp')) set('XMP ', patch.xmp ? utf8(patch.xmp) : null);
  const has = (t) => list.some((c) => c.type === t);
  let vp8x = list.find((c) => c.type === 'VP8X');
  if (!vp8x && (has('ICCP') || has('EXIF') || has('XMP '))) {
    const { width, height, alpha } = canvasOf(list);
    vp8x = { type: 'VP8X', data: concat([Uint8Array.of(alpha ? FLAG.alpha : 0, 0, 0, 0), le24(width - 1), le24(height - 1)]) };
    list.unshift(vp8x);
  }
  if (vp8x) {
    const d = new Uint8Array(vp8x.data);
    let f = d[0] & ~(FLAG.icc | FLAG.exif | FLAG.xmp);
    if (has('ICCP')) f |= FLAG.icc;
    if (has('EXIF')) f |= FLAG.exif;
    if (has('XMP ')) f |= FLAG.xmp;
    d[0] = f;
    vp8x.data = d;
  }
  const body = concat([asciiBytes('WEBP'), ...list.map(raw)]);
  return concat([asciiBytes('RIFF'), le32(body.length), body]);
}
