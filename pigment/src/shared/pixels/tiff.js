// Baseline TIFF codec in plain JavaScript, shared by the renderer and Node tests. Browsers do not
// decode TIFF at all, and it is the one common flat format that carries 16-bit and float samples.
//
// decodeTiff() reads the first image of a classic (not Big) TIFF: little or big endian, strips or
// tiles, chunky or planar samples, 1/2/4/8/16/32-bit unsigned integers and 32/64-bit floats,
// bilevel / grey / palette / RGB / CMYK photometrics with an optional alpha sample, uncompressed,
// PackBits, LZW and Deflate data, with the horizontal (2) and floating point (3) predictors, plus
// the resolution tags. encodeTiff() writes grey or RGB with or without alpha at 8 or 16 bits (or
// 32-bit float) in strips, uncompressed or with PackBits, LZW (default, with the predictor) or
// Deflate. JPEG-in-TIFF, CCITT fax, YCbCr and Lab are not supported and say so.
//
// Pixel buffers are the "planes" of png.js with one more depth:
//   { width, height, channels: 1|2|3|4, depth: 8|16|32, data }
// data is a Uint8ClampedArray (8), Uint16Array (16) or Float32Array (32, 0..1 = black..white) of
// width*height*channels samples, rows top to bottom, straight (non-premultiplied) alpha.
// Deflate goes through CompressionStream (Chromium, Node 18+); pass { deflate, inflate } to use
// another implementation.

import { zlibCodecs } from './png.js';

/** @typedef {{ width: number, height: number, channels: 1|2|3|4, depth: 8|16|32, data: Uint8ClampedArray | Uint16Array | Float32Array }} Planes */

const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, photometric: 262, stripOffsets: 273, orientation: 274,
  samples: 277, rowsPerStrip: 278, stripCounts: 279, xRes: 282, yRes: 283, planar: 284, resUnit: 296,
  software: 305, predictor: 317, colorMap: 320, tileWidth: 322, tileHeight: 323, tileOffsets: 324,
  tileCounts: 325, extraSamples: 338, sampleFormat: 339,
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const COMPRESSION = { none: 1, lzw: 5, deflate: 8, packbits: 32773 };
const COMPRESSION_NAME = { 1: 'none', 5: 'lzw', 8: 'deflate', 32946: 'deflate', 32773: 'packbits' };

/** True when the bytes start with a classic TIFF header (II*\0 or MM\0*). */
export function isTiff(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a);
}

// ---------------------------------------------------------------------------------------------
// Compression schemes

const TRUNCATED = 'The TIFF file is truncated or damaged: part of its image data is missing';

/** PackBits (Apple RLE) -> `expected` bytes; a truncated stream leaves zeros, or throws with `strict`. */
export function unpackBits(src, expected, { strict = false } = {}) {
  const out = new Uint8Array(expected);
  let sp = 0, op = 0;
  while (sp < src.length && op < expected) {
    const n = src[sp++];
    if (n < 128) {
      const len = Math.min(n + 1, expected - op, src.length - sp);
      out.set(src.subarray(sp, sp + len), op);
      sp += n + 1;
      op += len;
    } else if (n > 128) {
      const len = Math.min(257 - n, expected - op);
      if (sp >= src.length) break; // the run's value is missing
      const v = src[sp++];
      out.fill(v, op, op + len);
      op += len;
    }
  }
  if (strict && op < expected) throw new Error(TRUNCATED);
  return out;
}

/** PackBits of one row (TIFF packs every row on its own); appends to `out` (number[]) and returns it. */
export function packBitsRow(row, out = []) {
  const n = row.length;
  let i = 0;
  while (i < n) {
    // a run of at least 3 equal bytes (2 at the very end) becomes a repeat packet
    let run = 1;
    while (i + run < n && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3 || (run === 2 && i + run === n)) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    const start = i;
    i += run;
    while (i < n && i - start < 128) {
      let r = 1;
      while (i + r < n && r < 3 && row[i + r] === row[i]) r++;
      if (r >= 3) break;
      i++;
    }
    const len = Math.min(i, start + 128) - start;
    i = start + len;
    out.push(len - 1);
    for (let k = start; k < start + len; k++) out.push(row[k]);
  }
  return out;
}

/** TIFF LZW (MSB-first codes, 9..12 bits, "early change") -> `expected` bytes; a stream that ends early leaves zeros, or throws with `strict`. */
export function lzwDecode(src, expected, { strict = false } = {}) {
  const out = new Uint8Array(expected);
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    length[i] = 1;
  }
  let op = 0, sp = 0, bitBuf = 0, bitCnt = 0, width = 9, next = 258, old = -1;
  while (op < expected) {
    while (bitCnt < width) {
      if (sp >= src.length) {
        if (strict) throw new Error(TRUNCATED);
        return out;
      }
      bitBuf = ((bitBuf << 8) | src[sp++]) >>> 0;
      bitCnt += 8;
    }
    const code = (bitBuf >>> (bitCnt - width)) & ((1 << width) - 1);
    bitCnt -= width;
    bitBuf &= (1 << bitCnt) - 1;
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      old = -1;
      continue;
    }
    if (old === -1) {
      if (code > 255) throw new Error('TIFF LZW data is corrupt');
      out[op++] = code;
      old = code;
      continue;
    }
    if (code > next) throw new Error('TIFF LZW data is corrupt');
    // the string of `code`, or (code not in the table yet) the old string plus its own first byte
    const known = code < next;
    const len = known ? length[code] : length[old] + 1;
    let cur = known ? code : old;
    let p = op + (known ? len : len - 1) - 1;
    while (cur >= 256) {
      if (p < expected) out[p] = suffix[cur];
      p--;
      cur = prefix[cur];
    }
    if (p < expected) out[p] = cur;
    const first = cur;
    if (!known && op + len - 1 < expected) out[op + len - 1] = first;
    op += len;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      length[next] = length[old] + 1;
      next++;
      if (next >= (1 << width) - 1 && width < 12) width++;
    }
    old = code;
  }
  if (strict && op < expected) throw new Error(TRUNCATED);
  return out;
}

/** TIFF LZW encoder (the mirror of lzwDecode; table cleared when it reaches 4094 entries). */
export function lzwEncode(src) {
  const HSIZE = 16384, MASK = HSIZE - 1;
  const keys = new Int32Array(HSIZE).fill(-1), codes = new Uint16Array(HSIZE);
  let out = new Uint8Array(Math.max(64, (src.length >> 1) + 64));
  let op = 0, bitBuf = 0, bitCnt = 0, width = 9, free = 258;
  const put = (code) => {
    bitBuf = ((bitBuf << width) | code) >>> 0;
    bitCnt += width;
    while (bitCnt >= 8) {
      if (op >= out.length) {
        const grown = new Uint8Array(out.length * 2);
        grown.set(out);
        out = grown;
      }
      out[op++] = (bitBuf >>> (bitCnt - 8)) & 255;
      bitCnt -= 8;
    }
    bitBuf &= (1 << bitCnt) - 1;
  };
  const grow = () => {
    if (free === 4094) {
      put(256);
      keys.fill(-1);
      width = 9;
      free = 258;
    } else if (free > (1 << width) - 1) width++;
  };
  put(256);
  if (src.length) {
    let ent = src[0];
    for (let i = 1; i < src.length; i++) {
      const c = src[i];
      const key = (ent << 8) | c;
      let h = (Math.imul(key, 0x9e3779b1) >>> 18) & MASK;
      let found = -1;
      while (keys[h] !== -1) {
        if (keys[h] === key) {
          found = codes[h];
          break;
        }
        h = (h + 1) & MASK;
      }
      if (found >= 0) {
        ent = found;
        continue;
      }
      put(ent);
      keys[h] = key;
      codes[h] = free++;
      ent = c;
      grow();
    }
    put(ent);
    free++;
    grow();
  }
  put(257);
  if (bitCnt > 0) {
    if (op >= out.length) {
      const grown = new Uint8Array(out.length + 1);
      grown.set(out);
      out = grown;
    }
    out[op++] = (bitBuf << (8 - bitCnt)) & 255;
  }
  return out.subarray(0, op);
}

// ---------------------------------------------------------------------------------------------
// Reading

function reader(bytes) {
  const le = bytes[0] === 0x49;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    le,
    u16: (o) => view.getUint16(o, le),
    u32: (o) => view.getUint32(o, le),
    value(type, o) {
      switch (type) {
        case 1: case 2: case 7: return view.getUint8(o);
        case 6: return view.getInt8(o);
        case 3: return view.getUint16(o, le);
        case 8: return view.getInt16(o, le);
        case 4: return view.getUint32(o, le);
        case 9: return view.getInt32(o, le);
        case 5: {
          const den = view.getUint32(o + 4, le);
          return den ? view.getUint32(o, le) / den : 0;
        }
        case 10: {
          const den = view.getInt32(o + 4, le);
          return den ? view.getInt32(o, le) / den : 0;
        }
        case 11: return view.getFloat32(o, le);
        case 12: return view.getFloat64(o, le);
        default: return 0;
      }
    },
  };
}

/**
 * Reads one IFD into a Map tag -> number[] (ASCII fields become one string). Returns { tags, next, missing }:
 * `missing` lists the tags whose values lie outside the file (-1 stands for entries cut off with the directory).
 */
function readIfd(bytes, rd, offset) {
  if (offset + 2 > bytes.length) throw new Error('TIFF directory is outside the file');
  const count = rd.u16(offset);
  const tags = new Map();
  const missing = new Set();
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > bytes.length) {
      missing.add(-1);
      break;
    }
    const tag = rd.u16(e), type = rd.u16(e + 2), n = rd.u32(e + 4);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const total = size * n;
    const at = total <= 4 ? e + 8 : rd.u32(e + 8);
    if (at + total > bytes.length) {
      missing.add(tag);
      continue;
    }
    if (type === 2) {
      let s = '';
      for (let k = 0; k < n; k++) {
        const ch = bytes[at + k];
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      tags.set(tag, [s]);
      continue;
    }
    const values = new Array(n);
    for (let k = 0; k < n; k++) values[k] = rd.value(type, at + k * size);
    tags.set(tag, values);
  }
  const nextAt = offset + 2 + count * 12;
  return { tags, next: nextAt + 4 <= bytes.length ? rd.u32(nextAt) : 0, missing };
}

/** Header fields of a TIFF without decoding pixels: { width, height, bitDepth, samples, compression, littleEndian }. */
export function tiffInfo(bytes) {
  if (!isTiff(bytes)) throw new Error('Not a TIFF file');
  const rd = reader(bytes);
  const { tags } = readIfd(bytes, rd, rd.u32(4));
  const one = (t, d) => tags.get(t)?.[0] ?? d;
  return {
    width: one(TAG.width, 0), height: one(TAG.height, 0), bitDepth: one(TAG.bits, 1), samples: one(TAG.samples, 1),
    compression: COMPRESSION_NAME[one(TAG.compression, 1)] ?? String(one(TAG.compression, 1)), littleEndian: rd.le,
    float: one(TAG.sampleFormat, 1) === 3,
  };
}

/** Undoes the horizontal predictor on one row of `bytesPer`-byte words in the file's byte order. */
function unpredictRow(row, stride, bytesPer, le) {
  const n = row.length;
  if (bytesPer === 1) {
    for (let i = stride; i < n; i++) row[i] = (row[i] + row[i - stride]) & 255;
    return;
  }
  const step = stride * bytesPer;
  if (bytesPer === 2) {
    for (let i = step; i + 1 < n; i += 2) {
      const a = le ? row[i] | (row[i + 1] << 8) : (row[i] << 8) | row[i + 1];
      const b = le ? row[i - step] | (row[i - step + 1] << 8) : (row[i - step] << 8) | row[i - step + 1];
      const v = (a + b) & 0xffff;
      if (le) {
        row[i] = v & 255;
        row[i + 1] = v >> 8;
      } else {
        row[i] = v >> 8;
        row[i + 1] = v & 255;
      }
    }
    return;
  }
  for (let i = step; i + 3 < n; i += 4) {
    const rdw = (o) => (le ? (row[o] | (row[o + 1] << 8) | (row[o + 2] << 16) | (row[o + 3] << 24)) : ((row[o] << 24) | (row[o + 1] << 16) | (row[o + 2] << 8) | row[o + 3])) >>> 0;
    const v = (rdw(i) + rdw(i - step)) >>> 0;
    if (le) {
      row[i] = v & 255;
      row[i + 1] = (v >>> 8) & 255;
      row[i + 2] = (v >>> 16) & 255;
      row[i + 3] = v >>> 24;
    } else {
      row[i] = v >>> 24;
      row[i + 1] = (v >>> 16) & 255;
      row[i + 2] = (v >>> 8) & 255;
      row[i + 3] = v & 255;
    }
  }
}

/**
 * Undoes the floating point predictor (3) on one row: the bytes were split into planes (all the most
 * significant bytes first) and differenced; the result is in the file's byte order again.
 */
function unpredictFloatRow(row, stride, bytesPer, le) {
  const n = row.length;
  for (let i = stride; i < n; i++) row[i] = (row[i] + row[i - stride]) & 255;
  const count = n / bytesPer;
  const tmp = row.slice();
  for (let i = 0; i < count; i++) {
    for (let b = 0; b < bytesPer; b++) row[i * bytesPer + (le ? bytesPer - 1 - b : b)] = tmp[b * count + i];
  }
}

/**
 * Decodes the first image of a TIFF file.
 * @param {Uint8Array} bytes
 * @param {{ inflate?: (b: Uint8Array) => Promise<Uint8Array> }} [codecs]
 * @returns {Promise<Planes & { dpi: number | null, compression: string, littleEndian: boolean, bitDepth: number, float: boolean, photometric: number, pages: number }>}
 *   channels: 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA; depth 8 for 1..8-bit files (palettes are expanded),
 *   16 for 16-bit (and 32-bit integer) files, 32 for float files.
 */
export async function decodeTiff(bytes, codecs = {}) {
  try {
    return await decodeTiffImage(bytes, codecs);
  } catch (err) {
    // a damaged directory sends offsets and sizes anywhere: say what is wrong with the file, not with a typed array
    if (err instanceof RangeError && /alloc|length|size/i.test(err.message)) throw new Error('The TIFF image is too large to open', { cause: err });
    if (err instanceof RangeError || err instanceof TypeError) throw new Error('The TIFF file is damaged', { cause: err });
    throw err;
  }
}

// The most a compressed byte can stand for: PackBits turns 2 bytes into 128, Deflate reaches 1032:1 and a 12-bit
// LZW code can stand for a string of 4094 bytes. An image that needs more than its strips could ever hold has a
// damaged size field (or lost its data), which is found before any memory is asked for.
const MAX_RATIO = { 1: 1, 32773: 64, 8: 1032, 32946: 1032, 5: 4096 };
/** Pixels of the largest image decodeTiff accepts by default (a 16384 x 16384 canvas, the most a browser can show). */
export const TIFF_MAX_PIXELS = 2 ** 28;

async function decodeTiffImage(bytes, { inflate = zlibCodecs.inflate, maxPixels = TIFF_MAX_PIXELS } = {}) {
  if (!isTiff(bytes)) {
    if (bytes && bytes.length >= 4 && (bytes[2] === 0x2b || bytes[3] === 0x2b)) throw new Error('BigTIFF files are not supported');
    throw new Error('Not a TIFF file');
  }
  const rd = reader(bytes);
  const first = readIfd(bytes, rd, rd.u32(4));
  const tags = first.tags;
  let pages = 1;
  for (let next = first.next, guard = 0; next && guard < 1000; guard++) {
    try {
      next = readIfd(bytes, rd, next).next;
      pages++;
    } catch {
      break;
    }
  }
  // a tag that says how the pixels are stored and has lost its values would be read as its default (1 bit per
  // sample, no predictor, ...) and decode to noise; the resolution and text tags can go missing without harm
  const STRUCTURE = [-1, TAG.width, TAG.height, TAG.bits, TAG.compression, TAG.photometric, TAG.stripOffsets, TAG.samples, TAG.rowsPerStrip, TAG.stripCounts, TAG.planar, TAG.predictor, TAG.colorMap, TAG.tileWidth, TAG.tileHeight, TAG.tileOffsets, TAG.tileCounts, TAG.extraSamples, TAG.sampleFormat];
  if (STRUCTURE.some((t) => first.missing.has(t))) throw new Error(TRUNCATED);
  const one = (t, d) => tags.get(t)?.[0] ?? d;
  const width = one(TAG.width, 0), height = one(TAG.height, 0);
  if (!(width > 0 && height > 0)) throw new Error('TIFF has an empty image');
  if (width * height > maxPixels) throw new Error(`The TIFF image is too large to open (${width} × ${height} pixels)`);
  const samples = one(TAG.samples, 1);
  if (!(samples >= 1 && samples <= 64)) throw new Error('The TIFF file is damaged (samples per pixel)');
  const bitsList = tags.get(TAG.bits) ?? [1];
  const bits = bitsList[0];
  if (bitsList.some((b) => b !== bits)) throw new Error('TIFF files with different bit depths per sample are not supported');
  const format = one(TAG.sampleFormat, 1);
  const compression = one(TAG.compression, 1);
  const photometric = one(TAG.photometric, samples >= 3 ? 2 : 1);
  const planar = one(TAG.planar, 1);
  const predictor = one(TAG.predictor, 1);
  if (!(compression in COMPRESSION_NAME)) {
    const names = { 2: 'CCITT', 3: 'CCITT Group 3 fax', 4: 'CCITT Group 4 fax', 6: 'JPEG', 7: 'JPEG', 34712: 'JPEG 2000', 50000: 'Zstandard', 50001: 'WebP', 34925: 'LZMA' };
    throw new Error(`${names[compression] ?? `Compression ${compression}`}-compressed TIFF files are not supported`);
  }
  const float = format === 3;
  if (float ? bits !== 32 && bits !== 64 : ![1, 2, 4, 8, 16, 32].includes(bits)) throw new Error(`TIFF files with ${bits}-bit ${float ? 'float' : 'integer'} samples are not supported`);
  if (format === 2 && bits !== 8) throw new Error('TIFF files with signed integer samples are not supported');
  if (![0, 1, 2, 3, 5].includes(photometric)) throw new Error(photometric === 6 ? 'YCbCr TIFF files are not supported' : photometric === 8 || photometric === 9 ? 'Lab TIFF files are not supported' : `TIFF photometric ${photometric} is not supported`);
  const colour = photometric === 2 ? 3 : photometric === 5 ? 4 : 1;
  if (samples < colour) throw new Error('TIFF has too few samples per pixel');
  const bytesPer = bits > 8 ? bits / 8 : 1;

  // ---- gather the compressed pieces (strips or tiles) and where they go
  const tiled = tags.has(TAG.tileOffsets);
  const offsets = tags.get(tiled ? TAG.tileOffsets : TAG.stripOffsets);
  const counts = tags.get(tiled ? TAG.tileCounts : TAG.stripCounts);
  if (!offsets?.length) throw new Error('TIFF has no image data');
  const blockW = tiled ? one(TAG.tileWidth, width) : width;
  const blockH = tiled ? one(TAG.tileHeight, height) : Math.min(height, one(TAG.rowsPerStrip, height) || height);
  if (!(blockW > 0 && blockH > 0)) throw new Error('TIFF has an invalid strip or tile size');
  const across = Math.ceil(width / blockW), down = Math.ceil(height / blockH);
  const perPlane = across * down;
  const planes = planar === 2 ? samples : 1;
  const spp = planar === 2 ? 1 : samples; // samples per pixel inside one block
  const rowBytes = Math.ceil((blockW * spp * bits) / 8);
  // every strip or tile must be there, and together they must be able to hold the image they are said to hold
  if (offsets.length < planes * perPlane) throw new Error(TRUNCATED);
  let stored = 0;
  for (let i = 0; i < planes * perPlane; i++) stored += Math.max(0, Math.min(counts?.[i] ?? bytes.length, bytes.length - offsets[i]));
  if (planes * across * rowBytes * (tiled ? down * blockH : height) > stored * (MAX_RATIO[compression] ?? 1)) throw new Error(TRUNCATED);

  // decoded samples of the whole image as numbers, sample-interleaved: one typed array for every case
  const total = width * height * samples;
  const raw = float ? new Float32Array(total) : bits > 8 ? new Uint16Array(total) : new Uint8Array(total);
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  for (let plane = 0; plane < planes; plane++) {
    for (let k = 0; k < perPlane; k++) {
      const idx = plane * perPlane + k;
      const bx = (k % across) * blockW, by = Math.floor(k / across) * blockH;
      const rows = tiled ? blockH : Math.min(blockH, height - by);
      const expected = rows * rowBytes;
      const at = offsets[idx];
      const len = counts?.[idx] ?? (compression === 1 ? expected : bytes.length - at);
      // a piece that is cut short would leave part of the picture blank: that is an error, not an image
      if (!(at < bytes.length)) throw new Error(TRUNCATED);
      const src = bytes.subarray(at, Math.min(bytes.length, at + len));
      let data;
      if (compression === 1) {
        if (src.length < expected) throw new Error(TRUNCATED);
        data = new Uint8Array(expected);
        data.set(src.subarray(0, expected));
      } else if (compression === 5) data = lzwDecode(src, expected, { strict: true });
      else if (compression === 32773) data = unpackBits(src, expected, { strict: true });
      else {
        let inflated;
        try {
          inflated = await inflate(src);
        } catch {
          throw new Error(TRUNCATED);
        }
        if (inflated.length < expected) throw new Error(TRUNCATED);
        data = new Uint8Array(expected);
        data.set(inflated.subarray(0, expected));
      }
      if (predictor === 2 || predictor === 3) {
        for (let y = 0; y < rows; y++) {
          const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
          if (predictor === 2) unpredictRow(row, spp, bytesPer, rd.le);
          else unpredictFloatRow(row, spp, bytesPer, rd.le);
        }
      }
      const dv = bits > 8 ? view(data) : null;
      const copyW = Math.min(blockW, width - bx), copyH = Math.min(rows, height - by);
      const maxv = bits < 8 ? (1 << bits) - 1 : 0;
      for (let y = 0; y < copyH; y++) {
        const rowAt = y * rowBytes;
        for (let x = 0; x < copyW; x++) {
          for (let s = 0; s < spp; s++) {
            const n = x * spp + s;
            let v;
            if (bits === 8) v = data[rowAt + n];
            else if (bits === 16) v = dv.getUint16(rowAt + n * 2, rd.le);
            else if (bits === 32) v = float ? dv.getFloat32(rowAt + n * 4, rd.le) : dv.getUint32(rowAt + n * 4, rd.le) >>> 16;
            else if (bits === 64) v = dv.getFloat64(rowAt + n * 8, rd.le);
            else {
              // packed 1/2/4-bit samples: palette indices stay as they are, grey levels are scaled to 0..255
              const bit = n * bits;
              v = (data[rowAt + (bit >> 3)] >> (8 - bits - (bit & 7))) & maxv;
              if (photometric !== 3) v = Math.round((v * 255) / maxv);
            }
            raw[((by + y) * width + bx + x) * samples + (planar === 2 ? plane : s)] = v;
          }
        }
      }
    }
  }
  if (format === 2) for (let i = 0; i < raw.length; i++) raw[i] = (raw[i] + 128) & 255; // signed bytes: -128..127 -> 0..255

  // ---- photometric interpretation -> grey / RGB (+ alpha)
  const depth = float ? 32 : bits > 8 ? 16 : 8;
  const white = float ? 1 : depth === 16 ? 65535 : 255;
  const extra = tags.get(TAG.extraSamples);
  // the first extra sample is alpha when the file says so (1 premultiplied, 2 straight) or says nothing at all
  const alphaKind = samples > colour ? (extra ? extra[0] : 2) : 0;
  const hasAlpha = alphaKind === 1 || alphaKind === 2;
  const map = photometric === 3 ? tags.get(TAG.colorMap) : null;
  const outColour = photometric === 3 || colour >= 3 ? 3 : 1;
  const channels = outColour + (hasAlpha ? 1 : 0);
  const n = width * height;
  const data = float ? new Float32Array(n * channels) : depth === 16 ? new Uint16Array(n * channels) : new Uint8ClampedArray(n * channels);
  const entries = map ? map.length / 3 : 0;
  for (let i = 0; i < n; i++) {
    const s = i * samples, d = i * channels;
    const a = hasAlpha ? raw[s + colour] : white;
    if (photometric === 3) {
      const idx = raw[s];
      // a palette of 16-bit entries; files that wrote 0..255 into them are scaled up
      data[d] = idx < entries ? map[idx] >> 8 : 0;
      data[d + 1] = idx < entries ? map[entries + idx] >> 8 : 0;
      data[d + 2] = idx < entries ? map[2 * entries + idx] >> 8 : 0;
    } else if (photometric === 5) {
      // naive CMYK -> RGB (no ink profile): enough to show a press file, not to proof it
      const k = 1 - raw[s + 3] / white;
      for (let c = 0; c < 3; c++) {
        const v = white * (1 - raw[s + c] / white) * k;
        data[d + c] = float ? v : Math.round(v);
      }
    } else if (colour === 3) {
      data[d] = raw[s];
      data[d + 1] = raw[s + 1];
      data[d + 2] = raw[s + 2];
    } else data[d] = photometric === 0 ? white - raw[s] : raw[s];
    if (hasAlpha) {
      data[d + outColour] = a;
      if (alphaKind === 1 && a > 0 && a < white) {
        // associated alpha: the colours were stored multiplied by it
        for (let c = 0; c < outColour; c++) {
          const v = (data[d + c] * white) / a;
          data[d + c] = float ? v : Math.min(white, Math.round(v));
        }
      }
    }
  }
  if (map && entries) {
    // palettes written with 8-bit values in the 16-bit slots come out black: detect and rescale
    let max = 0;
    for (let i = 0; i < map.length; i++) if (map[i] > max) max = map[i];
    if (max > 0 && max < 256) {
      for (let i = 0; i < n; i++) {
        const idx = raw[i * samples], d = i * channels;
        if (idx >= entries) continue;
        data[d] = map[idx];
        data[d + 1] = map[entries + idx];
        data[d + 2] = map[2 * entries + idx];
      }
    }
  }
  const unit = one(TAG.resUnit, 2);
  const xres = one(TAG.xRes, 0);
  const dpi = xres > 0 && unit !== 1 ? Math.round((unit === 3 ? xres * 2.54 : xres) * 100) / 100 : null;
  return { width, height, channels, depth, data, dpi, compression: COMPRESSION_NAME[compression], littleEndian: rd.le, bitDepth: bits, float, photometric, pages };
}

/**
 * Expands planes (any channel count) to RGBA at their own depth:
 * { width, height, depth, data } with data Uint8ClampedArray | Uint16Array | Float32Array.
 */
export function toRgba(img) {
  const { width, height, channels, depth, data } = img;
  const n = width * height;
  if (channels === 4) return { width, height, depth, data };
  const white = depth === 32 ? 1 : depth === 16 ? 65535 : 255;
  const out = depth === 32 ? new Float32Array(n * 4) : depth === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * channels, d = i * 4;
    if (channels <= 2) {
      out[d] = out[d + 1] = out[d + 2] = data[s];
      out[d + 3] = channels === 2 ? data[s + 1] : white;
    } else {
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = white;
    }
  }
  return { width, height, depth, data: out };
}

// ---------------------------------------------------------------------------------------------
// Writing

/**
 * Encodes planes to TIFF bytes (one image, strips of about 64 KB, chunky samples).
 * @param {Planes} img depth 8 (Uint8ClampedArray / Uint8Array), 16 (Uint16Array) or 32 (Float32Array); channels 1, 2 (grey + alpha), 3 or 4
 * @param {{ compression?: 'none'|'lzw'|'packbits'|'deflate', predictor?: boolean, dpi?: number, littleEndian?: boolean,
 *   software?: string, deflate?: (b: Uint8Array) => Promise<Uint8Array> }} [options]
 *   compression defaults to 'lzw'; predictor (horizontal differencing, default on for LZW and Deflate at 8/16 bits) is ignored for float samples
 * @returns {Promise<Uint8Array>}
 */
export async function encodeTiff(img, { compression = 'lzw', predictor = true, dpi = 72, littleEndian = true, software = 'Pigment', deflate = zlibCodecs.deflate } = {}) {
  const { width, height, channels, depth, data } = img;
  if (!(width > 0 && height > 0)) throw new Error('Cannot encode an empty image');
  if (![1, 2, 3, 4].includes(channels) || ![8, 16, 32].includes(depth)) throw new Error('Unsupported plane layout');
  if (!(compression in COMPRESSION)) throw new Error(`Unknown TIFF compression: ${String(compression)}`);
  if (data.length < width * height * channels) throw new Error('Pixel data is too short');
  const le = !!littleEndian;
  const bytesPer = depth / 8;
  const rowBytes = width * channels * bytesPer;
  const usePredictor = !!predictor && depth !== 32 && (compression === 'lzw' || compression === 'deflate');
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(65536 / rowBytes) || 1));
  const stripCount = Math.ceil(height / rowsPerStrip);
  const strips = [];
  let breath = Date.now();
  for (let s = 0; s < stripCount; s++) {
    // megapixels of LZW take a noticeable while: give the event loop a turn every 40 ms (the UI stays alive)
    if (Date.now() - breath > 40) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      breath = Date.now();
    }
    const y0 = s * rowsPerStrip, rows = Math.min(rowsPerStrip, height - y0);
    const buf = new Uint8Array(rows * rowBytes);
    const dv = new DataView(buf.buffer);
    for (let y = 0; y < rows; y++) {
      const src = (y0 + y) * width * channels, dst = y * rowBytes;
      const count = width * channels;
      if (depth === 8) {
        for (let i = 0; i < count; i++) buf[dst + i] = data[src + i];
        if (usePredictor) for (let i = count - 1; i >= channels; i--) buf[dst + i] = (buf[dst + i] - buf[dst + i - channels]) & 255;
      } else if (depth === 16) {
        for (let i = 0; i < count; i++) {
          const v = usePredictor && i >= channels ? (data[src + i] - data[src + i - channels]) & 0xffff : data[src + i];
          dv.setUint16(dst + i * 2, v, le);
        }
      } else for (let i = 0; i < count; i++) dv.setFloat32(dst + i * 4, data[src + i], le);
    }
    if (compression === 'none') strips.push(buf);
    else if (compression === 'lzw') strips.push(lzwEncode(buf).slice());
    else if (compression === 'deflate') strips.push(await deflate(buf));
    else {
      const packed = [];
      for (let y = 0; y < rows; y++) packBitsRow(buf.subarray(y * rowBytes, (y + 1) * rowBytes), packed);
      strips.push(Uint8Array.from(packed));
    }
  }

  // ---- layout: header, strips, the out-of-line tag values, then the directory
  const hasAlpha = channels === 2 || channels === 4;
  const softwareBytes = Array.from(`${software}\0`, (ch) => ch.charCodeAt(0) & 127);
  const fields = []; // { tag, type, values }
  const add = (tag, type, values) => fields.push({ tag, type, values });
  add(TAG.width, 4, [width]);
  add(TAG.height, 4, [height]);
  add(TAG.bits, 3, new Array(channels).fill(depth));
  add(TAG.compression, 3, [COMPRESSION[compression]]);
  add(TAG.photometric, 3, [channels >= 3 ? 2 : 1]);
  add(TAG.stripOffsets, 4, new Array(stripCount).fill(0));
  add(TAG.orientation, 3, [1]);
  add(TAG.samples, 3, [channels]);
  add(TAG.rowsPerStrip, 4, [rowsPerStrip]);
  add(TAG.stripCounts, 4, strips.map((s) => s.length));
  const res = Math.max(1, Math.round((Number(dpi) || 72) * 10000));
  add(TAG.xRes, 5, [[res, 10000]]);
  add(TAG.yRes, 5, [[res, 10000]]);
  add(TAG.planar, 3, [1]);
  add(TAG.resUnit, 3, [2]);
  add(TAG.software, 2, softwareBytes);
  if (usePredictor) add(TAG.predictor, 3, [2]);
  if (hasAlpha) add(TAG.extraSamples, 3, [2]);
  add(TAG.sampleFormat, 3, new Array(channels).fill(depth === 32 ? 3 : 1));
  fields.sort((a, b) => a.tag - b.tag);

  let offset = 8;
  const stripOffsets = strips.map((s) => {
    const at = offset;
    offset += s.length + (s.length & 1); // word-aligned, as the specification asks
    return at;
  });
  fields.find((f) => f.tag === TAG.stripOffsets).values = stripOffsets;
  for (const f of fields) {
    f.size = TYPE_SIZE[f.type] * f.values.length;
    if (f.size > 4) {
      f.at = offset;
      offset += f.size + (f.size & 1);
    }
  }
  const ifdAt = offset;
  const totalBytes = ifdAt + 2 + fields.length * 12 + 4;
  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, ifdAt, le);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  const writeValues = (f, at) => {
    f.values.forEach((v, i) => {
      const o = at + i * TYPE_SIZE[f.type];
      if (f.type === 3) dv.setUint16(o, v, le);
      else if (f.type === 4) dv.setUint32(o, v, le);
      else if (f.type === 5) {
        dv.setUint32(o, v[0], le);
        dv.setUint32(o + 4, v[1], le);
      } else out[o] = v;
    });
  };
  dv.setUint16(ifdAt, fields.length, le);
  fields.forEach((f, i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, f.tag, le);
    dv.setUint16(e + 2, f.type, le);
    dv.setUint32(e + 4, f.values.length, le);
    if (f.size > 4) {
      dv.setUint32(e + 8, f.at, le);
      writeValues(f, f.at);
    } else writeValues(f, e + 8);
  });
  dv.setUint32(ifdAt + 2 + fields.length * 12, 0, le);
  return out;
}
