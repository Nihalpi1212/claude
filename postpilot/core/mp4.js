// Remove location and device metadata from MP4/MOV files without re-encoding.
//
// Phones store GPS coordinates and device details in metadata boxes ('udta', 'meta', XMP 'uuid')
// inside the file. Renaming those boxes to 'free' (same size, so no offsets change) makes every
// player and Instagram ignore them, and the video still plays exactly as before.

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
