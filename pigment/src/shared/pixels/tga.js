// Truevision TGA codec (pure, shared with Node tests). decodeTga() reads colour-mapped (1/9),
// true-colour (2/10) and grey (3/11) images, raw or run-length encoded, at 8, 15/16, 24 and 32 bits
// per pixel in any of the four origins; encodeTga() writes 24 or 32-bit true colour, raw or RLE,
// top-left origin, with the TGA 2.0 footer. Pixels are 8-bit RGBA ImageDataLike with straight alpha.

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */

const FOOTER = 'TRUEVISION-XFILE.\0';

/**
 * TGA has no magic number: this checks that the header describes an image this module can read
 * (used after the file extension matched, to give a clear error instead of noise).
 */
export function isTga(bytes) {
  if (!bytes || bytes.length < 18) return false;
  const mapType = bytes[1], type = bytes[2], bpp = bytes[16];
  if (mapType > 1 || ![1, 2, 3, 9, 10, 11].includes(type)) return false;
  if (![8, 15, 16, 24, 32].includes(bpp)) return false;
  return (bytes[12] | (bytes[13] << 8)) > 0 && (bytes[14] | (bytes[15] << 8)) > 0;
}

/** Header fields without decoding: { width, height, bitsPerPixel, type, rle }. */
export function tgaInfo(bytes) {
  if (!isTga(bytes)) throw new Error('Not a TGA file');
  return { width: bytes[12] | (bytes[13] << 8), height: bytes[14] | (bytes[15] << 8), bitsPerPixel: bytes[16], type: bytes[2] & 7, rle: bytes[2] >= 8 };
}

/** One stored pixel (little-endian, `size` bytes at o) -> RGBA written at out[d..d+3]. */
function readColour(b, o, size, out, d, alphaBits) {
  if (size === 1) {
    out[d] = out[d + 1] = out[d + 2] = b[o];
    out[d + 3] = 255;
  } else if (size === 2) {
    const v = b[o] | (b[o + 1] << 8);
    out[d] = (((v >> 10) & 31) * 255 + 15) / 31 | 0;
    out[d + 1] = (((v >> 5) & 31) * 255 + 15) / 31 | 0;
    out[d + 2] = ((v & 31) * 255 + 15) / 31 | 0;
    out[d + 3] = alphaBits && !(v & 0x8000) ? 0 : 255;
  } else {
    out[d] = b[o + 2];
    out[d + 1] = b[o + 1];
    out[d + 2] = b[o];
    out[d + 3] = size === 4 && alphaBits ? b[o + 3] : 255;
  }
}

/**
 * Decodes TGA bytes to an RGBA image.
 * @param {Uint8Array} bytes
 * @returns {ImageDataLike & { bitsPerPixel: number, rle: boolean, hasAlpha: boolean }}
 */
export function decodeTga(bytes) {
  if (!isTga(bytes)) throw new Error('This is not a TGA image Pigment can read');
  const idLength = bytes[0], mapType = bytes[1], type = bytes[2] & 7, rle = bytes[2] >= 8;
  const mapStart = bytes[3] | (bytes[4] << 8), mapLength = bytes[5] | (bytes[6] << 8), mapBits = bytes[7];
  const width = bytes[12] | (bytes[13] << 8), height = bytes[14] | (bytes[15] << 8);
  const bpp = bytes[16], descriptor = bytes[17];
  const alphaBits = descriptor & 15;
  const size = bpp === 15 ? 2 : bpp >> 3;
  if (type === 1 && (!mapType || size !== 1)) throw new Error('This colour-mapped TGA is not supported');
  let at = 18 + idLength;
  // the colour map (BGR(A) entries) becomes RGBA
  let map = null;
  if (mapType === 1) {
    const esize = mapBits === 15 ? 2 : mapBits >> 3;
    if (type === 1) {
      map = new Uint8ClampedArray(mapLength * 4);
      for (let i = 0; i < mapLength && at + (i + 1) * esize <= bytes.length; i++) readColour(bytes, at + i * esize, esize, map, i * 4, esize === 4 ? 8 : esize === 2 ? 0 : 0);
    }
    at += mapLength * esize;
  }
  const n = width * height;
  // unpack to n stored pixels of `size` bytes
  const stored = new Uint8Array(n * size);
  if (!rle) stored.set(bytes.subarray(at, Math.min(bytes.length, at + n * size)));
  else {
    let op = 0;
    while (op < stored.length && at < bytes.length) {
      const head = bytes[at++];
      const count = (head & 127) + 1;
      if (head & 128) {
        for (let k = 0; k < count && op < stored.length; k++) for (let s = 0; s < size; s++) stored[op++] = bytes[at + s] ?? 0;
        at += size;
      } else {
        const len = Math.min(count * size, stored.length - op, bytes.length - at);
        stored.set(bytes.subarray(at, at + len), op);
        op += len;
        at += count * size;
      }
    }
  }
  const data = new Uint8ClampedArray(n * 4);
  const topDown = !!(descriptor & 0x20), rightLeft = !!(descriptor & 0x10);
  // 32-bit files that declare no alpha bits but carry a non-empty alpha channel are common: trust the data then
  let useAlpha = alphaBits;
  if (size === 4 && !alphaBits) {
    let any = false;
    for (let i = 3; i < stored.length && !any; i += 4) if (stored[i]) any = true;
    if (any) useAlpha = 8;
  }
  for (let y = 0; y < height; y++) {
    const dy = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const dx = rightLeft ? width - 1 - x : x;
      const o = (y * width + x) * size, d = (dy * width + dx) * 4;
      if (map) {
        const idx = stored[o] - mapStart;
        if (idx >= 0 && idx * 4 + 3 < map.length) {
          data[d] = map[idx * 4];
          data[d + 1] = map[idx * 4 + 1];
          data[d + 2] = map[idx * 4 + 2];
          data[d + 3] = map[idx * 4 + 3];
        } else data[d + 3] = 255;
      } else readColour(stored, o, size, data, d, useAlpha);
    }
  }
  return { width, height, data, bitsPerPixel: bpp, rle, hasAlpha: !!useAlpha && size !== 1 };
}

/**
 * Encodes an RGBA image as true-colour TGA.
 * @param {ImageDataLike} img
 * @param {{ rle?: boolean, alpha?: boolean | 'auto' }} [options] rle: run-length encode (default true); alpha: write
 *   32 bits with the alpha channel (default 'auto': only when some pixel is not opaque)
 * @returns {Uint8Array}
 */
export function encodeTga(img, { rle = true, alpha = 'auto' } = {}) {
  const { width, height, data } = img;
  if (!(width > 0 && height > 0)) throw new Error('Cannot encode an empty image');
  if (width > 65535 || height > 65535) throw new Error('TGA images are limited to 65535 pixels per side');
  const n = width * height;
  let withAlpha = alpha === true;
  if (alpha === 'auto') {
    for (let i = 3; i < n * 4 && !withAlpha; i += 4) if (data[i] !== 255) withAlpha = true;
  }
  const size = withAlpha ? 4 : 3;
  const header = new Uint8Array(18);
  header[2] = rle ? 10 : 2;
  header[12] = width & 255;
  header[13] = width >> 8;
  header[14] = height & 255;
  header[15] = height >> 8;
  header[16] = size * 8;
  header[17] = 0x20 | (withAlpha ? 8 : 0); // top-left origin, alpha bits
  const body = new Uint8Array(rle ? n * (size + 1) + 16 : n * size);
  let op = 0;
  const putPixel = (i) => {
    body[op++] = data[i * 4 + 2];
    body[op++] = data[i * 4 + 1];
    body[op++] = data[i * 4];
    if (withAlpha) body[op++] = data[i * 4 + 3];
  };
  const same = (a, b) => data[a * 4] === data[b * 4] && data[a * 4 + 1] === data[b * 4 + 1] && data[a * 4 + 2] === data[b * 4 + 2] && (!withAlpha || data[a * 4 + 3] === data[b * 4 + 3]);
  if (!rle) for (let i = 0; i < n; i++) putPixel(i);
  else {
    // packets never cross a scan line (the specification recommends it and old readers need it)
    for (let y = 0; y < height; y++) {
      const end = (y + 1) * width;
      let i = y * width;
      while (i < end) {
        let run = 1;
        while (i + run < end && run < 128 && same(i, i + run)) run++;
        if (run >= 2) {
          body[op++] = 128 | (run - 1);
          putPixel(i);
          i += run;
          continue;
        }
        const start = i;
        i++;
        while (i < end && i - start < 128 && !(i + 1 < end && same(i, i + 1))) i++;
        body[op++] = i - start - 1;
        for (let k = start; k < i; k++) putPixel(k);
      }
    }
  }
  const footer = new Uint8Array(26);
  for (let i = 0; i < FOOTER.length; i++) footer[8 + i] = FOOTER.charCodeAt(i);
  const out = new Uint8Array(18 + op + 26);
  out.set(header, 0);
  out.set(body.subarray(0, op), 18);
  out.set(footer, 18 + op);
  return out;
}
