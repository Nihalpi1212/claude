// Remove location and device metadata from MP4/MOV files without re-encoding.
//
// Phones store GPS coordinates and device details in metadata boxes ('udta', 'meta', XMP 'uuid')
// inside the file. Their contents are zeroed and the boxes renamed to 'free' (same size, so no
// offsets change): every player and Instagram ignores them, and the video plays exactly as before.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'dinf', 'stbl']);
const STRIP = new Set(['udta', 'meta', 'uuid']);

function type(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function walk(bytes, view, start, end, depth, stripped) {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const t = type(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(end - at)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break; // malformed: stop rather than guess
    if (STRIP.has(t)) {
      bytes.fill(0, at + header, at + size); // erase the contents (e.g. GPS text), not just hide them
      bytes.set([0x66, 0x72, 0x65, 0x65], at + 4); // 'free'
      stripped.push(t);
    } else if (CONTAINERS.has(t) && depth < 8) {
      walk(bytes, view, at + header, at + size, depth + 1, stripped);
    }
    at += size;
  }
}

/**
 * Strip metadata boxes in place. Returns the list of box types that were neutralised.
 * Non-MP4 input (no 'ftyp' near the start) is left untouched.
 */
export function stripMp4Metadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || type(bytes, 4) !== 'ftyp') return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stripped = [];
  walk(bytes, view, 0, bytes.length, 0, stripped);
  return stripped;
}

/** Child boxes of [start, end): [{type, body, end}] (body = offset after the header). */
function boxes(bytes, view, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(end - at)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) break;
    out.push({ type: type(bytes, at + 4), body: at + header, end: at + size });
    at += size;
  }
  return out;
}

/**
 * Duration and display size of an MP4/MOV file from its 'mvhd' and video-track 'tkhd' boxes
 * (rotated phone videos report their upright size). Null fields when the file cannot be read.
 * @returns {{width: number|null, height: number|null, durationSec: number|null}}
 */
export function mp4Info(bytes) {
  const out = { width: null, height: null, durationSec: null };
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || type(bytes, 4) !== 'ftyp') return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(bytes, view, 0, bytes.length).find((b) => b.type === 'moov');
  if (!moov) return out;
  for (const b of boxes(bytes, view, moov.body, moov.end)) {
    if (b.type === 'mvhd' && b.body + 32 <= b.end) {
      const v1 = bytes[b.body] === 1;
      const scale = view.getUint32(b.body + (v1 ? 20 : 12));
      const dur = v1 ? Number(view.getBigUint64(b.body + 24)) : view.getUint32(b.body + 16);
      if (scale > 0 && dur > 0) out.durationSec = Math.round((dur / scale) * 100) / 100;
    }
    if (b.type !== 'trak' || out.width) continue;
    const parts = boxes(bytes, view, b.body, b.end);
    const mdia = parts.find((p) => p.type === 'mdia');
    const hdlr = mdia && boxes(bytes, view, mdia.body, mdia.end).find((p) => p.type === 'hdlr');
    if (!hdlr || hdlr.body + 12 > hdlr.end || type(bytes, hdlr.body + 8) !== 'vide') continue;
    const tkhd = parts.find((p) => p.type === 'tkhd');
    if (!tkhd || tkhd.end - tkhd.body < 84) continue;
    // Width and height (16.16 fixed point) are the last 8 bytes; the 3x3 matrix sits before them.
    const w = Math.round(view.getUint32(tkhd.end - 8) / 65536);
    const h = Math.round(view.getUint32(tkhd.end - 4) / 65536);
    const matrix = tkhd.end - 8 - 36;
    const a = view.getInt32(matrix);
    const bb = view.getInt32(matrix + 4);
    const turned = a === 0 && bb !== 0; // 90 or 270 degrees
    if (w && h) [out.width, out.height] = turned ? [h, w] : [w, h];
  }
  return out;
}
