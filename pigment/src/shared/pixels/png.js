// PNG codec in plain JavaScript, shared by the renderer and Node tests. Browsers decode PNG files
// through canvas at 8 bits per channel and only write 8-bit RGBA, so 16-bit images (Image > Mode >
// 16 Bits/Channel), palette images (PNG-8, Indexed Color) and greyscale files need this module:
// decodePng() reads every PNG colour type at 1/2/4/8/16 bits, interlaced or not, with tRNS and
// pHYs; encodePng() writes 8/16-bit greyscale/RGB with or without alpha and palette images with
// adaptive row filtering. zlib (de)compression goes through CompressionStream('deflate'), which
// exists in Chromium and in Node 18+; pass { deflate, inflate } to use another implementation.
//
// Pixel buffers are "planes": { width, height, channels: 1|2|3|4, depth: 8|16, data } where data is a
// Uint8ClampedArray (depth 8) or Uint16Array (depth 16) of width*height*channels samples, rows top to
// bottom, straight (non-premultiplied) alpha. toRgba8() turns any decode result into an RGBA
// ImageDataLike for the canvas; fromRgba8() is the inverse for encoding.

import { crc32 } from '../zip.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // colour type -> samples per pixel (palette: 1 index)
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]; // x0, y0, dx, dy

/** @typedef {{ width: number, height: number, channels: 1|2|3|4, depth: 8|16, data: Uint8ClampedArray | Uint16Array }} Planes */

export const zlibCodecs = {
  async deflate(bytes) {
    const cs = new CompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  },
  async inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  },
};

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** Splits a PNG into chunks [{ type, data }]; throws when the signature or a CRC is wrong. */
export function readChunks(bytes) {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const chunks = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    if (i + 12 + len > bytes.length) throw new Error(`PNG chunk ${type} is truncated`);
    const data = bytes.subarray(i + 8, i + 8 + len);
    const crc = u32(bytes, i + 8 + len);
    if (crc !== crc32(bytes.subarray(i + 4, i + 8 + len))) throw new Error(`PNG chunk ${type} has a bad CRC`);
    chunks.push({ type, data });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Header fields of a PNG without decoding the pixels. */
export function pngInfo(bytes) {
  const ihdr = readChunks(bytes).find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('PNG has no IHDR');
  const d = ihdr.data;
  return { width: u32(d, 0), height: u32(d, 4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the row filters of one (sub)image in place; `raw` holds (1 + stride) bytes per row. Returns the unfiltered rows (stride bytes each). */
function unfilter(raw, rows, stride, bpp) {
  const out = new Uint8Array(rows * stride);
  let prev = null;
  for (let y = 0; y < rows; y++) {
    const type = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    switch (type) {
      case 0: row.set(src); break;
      case 1: for (let i = 0; i < stride; i++) row[i] = (src[i] + (i >= bpp ? row[i - bpp] : 0)) & 255; break;
      case 2: for (let i = 0; i < stride; i++) row[i] = (src[i] + (prev ? prev[i] : 0)) & 255; break;
      case 3: for (let i = 0; i < stride; i++) row[i] = (src[i] + (((i >= bpp ? row[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1)) & 255; break;
      case 4: for (let i = 0; i < stride; i++) row[i] = (src[i] + paeth(i >= bpp ? row[i - bpp] : 0, prev ? prev[i] : 0, prev && i >= bpp ? prev[i - bpp] : 0)) & 255; break;
      default: throw new Error(`PNG row filter ${type} is invalid`);
    }
    prev = row;
  }
  return out;
}

/** Reads sample `n` (0-based, across the whole row) of a packed row at bitDepth bits. */
function sampleAt(row, n, bitDepth) {
  if (bitDepth === 8) return row[n];
  if (bitDepth === 16) return (row[n * 2] << 8) | row[n * 2 + 1];
  const bit = n * bitDepth;
  return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
}

/**
 * Decodes PNG bytes to planes plus the metadata the editor keeps.
 * @param {Uint8Array} bytes
 * @param {{ inflate?: (b: Uint8Array) => Promise<Uint8Array> }} [codecs]
 * @returns {Promise<Planes & { palette: Uint8Array | null, transparency: Uint8Array | number[] | null, dpi: number | null, colorType: number, bitDepth: number, text: Record<string, string> }>}
 *   palette: RGB triples for colour type 3 (data holds indices, depth 8); transparency: per-palette-entry alpha
 *   (type 3) or the single transparent colour (types 0 and 2, as samples); gray/RGB data at 1/2/4 bits is scaled to 8.
 */
export async function decodePng(bytes, { inflate = zlibCodecs.inflate } = {}) {
  const chunks = readChunks(bytes);
  const { width, height, bitDepth, colorType, interlace } = pngInfo(bytes);
  if (!(width > 0 && height > 0)) throw new Error('PNG has an empty image');
  if (!(colorType in CHANNELS) || ![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG colour type ${colorType} at ${bitDepth} bits is not supported`);
  if ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth < 8) throw new Error('PNG colour images need 8 or 16 bits');
  const channels = CHANNELS[colorType];
  const idat = chunks.filter((c) => c.type === 'IDAT');
  const total = idat.reduce((n, c) => n + c.data.length, 0);
  const zipped = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    zipped.set(c.data, o);
    o += c.data.length;
  }
  const raw = await inflate(zipped);
  const plte = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  const phys = chunks.find((c) => c.type === 'pHYs');
  const text = {};
  for (const c of chunks) if (c.type === 'tEXt') {
    const z = c.data.indexOf(0);
    if (z > 0) text[ascii(c.data, 0, z)] = new TextDecoder('latin1').decode(c.data.subarray(z + 1));
  }
  const depth = bitDepth === 16 ? 16 : 8;
  const data = depth === 16 ? new Uint16Array(width * height * channels) : new Uint8ClampedArray(width * height * channels);
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const scale = bitDepth < 8 && colorType !== 3 ? 255 / ((1 << bitDepth) - 1) : 1;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * channels * bitDepth) / 8);
    const need = ph * (stride + 1);
    if (offset + need > raw.length) throw new Error('PNG image data is truncated');
    const rows = unfilter(raw.subarray(offset, offset + need), ph, stride, bpp);
    offset += need;
    for (let y = 0; y < ph; y++) {
      const row = rows.subarray(y * stride, (y + 1) * stride);
      const ty = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const tx = x0 + x * dx;
        const di = (ty * width + tx) * channels;
        for (let c = 0; c < channels; c++) {
          const v = sampleAt(row, x * channels + c, bitDepth);
          data[di + c] = scale === 1 ? v : Math.round(v * scale);
        }
      }
    }
  }
  let dpi = null;
  // pixels per metre -> dpi, rounded to 1/100 so 300 dpi written as 11811 ppm reads back as exactly 300
  if (phys && phys.data.length >= 9 && phys.data[8] === 1) dpi = Math.round(u32(phys.data, 0) * 0.0254 * 100) / 100;
  let transparency = null;
  if (trns) {
    if (colorType === 3) transparency = new Uint8Array(trns.data);
    else if (colorType === 0 && trns.data.length >= 2) transparency = [(trns.data[0] << 8) | trns.data[1]];
    else if (colorType === 2 && trns.data.length >= 6) transparency = [(trns.data[0] << 8) | trns.data[1], (trns.data[2] << 8) | trns.data[3], (trns.data[4] << 8) | trns.data[5]];
    if (transparency && colorType !== 3 && bitDepth < 8) transparency = transparency.map((v) => Math.round(v * scale));
  }
  return { width, height, channels, depth, data, palette: plte ? new Uint8Array(plte.data) : null, transparency, dpi, colorType, bitDepth, text };
}

/**
 * Expands a decode result to 8-bit RGBA (straight alpha): palette lookups, grey -> RGB, tRNS colour keys,
 * 16-bit -> 8-bit by rounding. Returns { width, height, data: Uint8ClampedArray }.
 */
export function toRgba8(img) {
  const { width, height, channels, depth, data } = img;
  const out = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  const to8 = depth === 16 ? (v) => (v * 255 + 32767) / 65535 : (v) => v;
  const key = img.transparency && img.colorType !== 3 ? img.transparency : null;
  if (img.colorType === 3) {
    const pal = img.palette ?? new Uint8Array(0), alpha = img.transparency ?? null;
    for (let i = 0; i < n; i++) {
      const idx = data[i];
      out[i * 4] = pal[idx * 3] ?? 0;
      out[i * 4 + 1] = pal[idx * 3 + 1] ?? 0;
      out[i * 4 + 2] = pal[idx * 3 + 2] ?? 0;
      out[i * 4 + 3] = alpha && idx < alpha.length ? alpha[idx] : 255;
    }
    return { width, height, data: out };
  }
  for (let i = 0; i < n; i++) {
    const s = i * channels, d = i * 4;
    let a = 255;
    if (channels === 1 || channels === 2) {
      const g = data[s];
      out[d] = out[d + 1] = out[d + 2] = to8(g);
      if (channels === 2) a = to8(data[s + 1]);
      else if (key && g === key[0]) a = 0;
    } else {
      out[d] = to8(data[s]);
      out[d + 1] = to8(data[s + 1]);
      out[d + 2] = to8(data[s + 2]);
      if (channels === 4) a = to8(data[s + 3]);
      else if (key && data[s] === key[0] && data[s + 1] === key[1] && data[s + 2] === key[2]) a = 0;
    }
    out[d + 3] = a;
  }
  return { width, height, data: out };
}

/** Expands a decode result to 16-bit RGBA planes (8-bit samples are scaled by 257; palettes are looked up). */
export function toRgba16(img) {
  if (img.depth === 16 && img.channels === 4) return { width: img.width, height: img.height, channels: 4, depth: 16, data: img.data };
  const base = img.depth === 16 ? null : toRgba8(img);
  const n = img.width * img.height;
  const out = new Uint16Array(n * 4);
  if (base) for (let i = 0; i < n * 4; i++) out[i] = base.data[i] * 257;
  else {
    const { channels, data } = img;
    const key = img.transparency ?? null;
    for (let i = 0; i < n; i++) {
      const s = i * channels, d = i * 4;
      if (channels <= 2) {
        out[d] = out[d + 1] = out[d + 2] = data[s];
        out[d + 3] = channels === 2 ? data[s + 1] : key && data[s] === key[0] ? 0 : 65535;
      } else {
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = channels === 4 ? data[s + 3] : key && data[s] === key[0] && data[s + 1] === key[1] && data[s + 2] === key[2] ? 0 : 65535;
      }
    }
  }
  return { width: img.width, height: img.height, channels: 4, depth: 16, data: out };
}

/** RGBA ImageDataLike -> planes with the given channel count (alpha dropped for 1/3, grey from Rec. 601 luma for 1/2). */
export function fromRgba8(img, channels = 4) {
  const n = img.width * img.height, s = img.data;
  const out = new Uint8ClampedArray(n * channels);
  for (let i = 0; i < n; i++) {
    const r = s[i * 4], g = s[i * 4 + 1], b = s[i * 4 + 2], a = s[i * 4 + 3];
    const d = i * channels;
    if (channels <= 2) {
      out[d] = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
      if (channels === 2) out[d + 1] = a;
    } else {
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
      if (channels === 4) out[d + 3] = a;
    }
  }
  return { width: img.width, height: img.height, channels, depth: 8, data: out };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Filters one row with every type and keeps the one with the smallest sum of absolute values (the usual heuristic). */
function filterRow(row, prev, bpp, out, adaptive) {
  const stride = row.length;
  let best = 0, bestSum = Infinity;
  const candidates = adaptive ? [0, 1, 2, 3, 4] : [prev ? 4 : 1];
  const tmp = new Uint8Array(stride);
  for (const type of candidates) {
    let sum = 0;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = row[i]; break;
        case 1: v = row[i] - a; break;
        case 2: v = row[i] - b; break;
        case 3: v = row[i] - ((a + b) >> 1); break;
        default: v = row[i] - paeth(a, b, c);
      }
      v &= 255;
      tmp[i] = v;
      sum += v < 128 ? v : 256 - v;
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = type;
      out.set(tmp, 1);
      if (!adaptive) break;
    }
  }
  out[0] = best;
}

/**
 * Encodes planes to PNG bytes. img: { width, height, channels, depth, data } (depth 16 data is a
 * Uint16Array), or { ..., palette: Uint8Array RGB triples, transparency?: Uint8Array } with channels 1
 * and `indexed: true` for a palette image. Options: dpi (pHYs), text ({ keyword: value } tEXt chunks),
 * interlace (Adam7), adaptive (row filter heuristic, default true), deflate (codec).
 */
export async function encodePng(img, { dpi = null, text = null, interlace = false, adaptive = true, deflate = zlibCodecs.deflate, indexed = false } = {}) {
  const { width, height, channels, depth, data } = img;
  if (!(width > 0 && height > 0)) throw new Error('Cannot encode an empty image');
  if (![1, 2, 3, 4].includes(channels) || ![8, 16].includes(depth)) throw new Error('Unsupported plane layout');
  if (indexed && (channels !== 1 || depth !== 8 || !img.palette)) throw new Error('A palette image needs 8-bit indices and a palette');
  if (data.length < width * height * channels) throw new Error('Pixel data is too short');
  const colorType = indexed ? 3 : { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const bytesPerSample = depth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  const parts = [];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = pw * bpp;
    const out = new Uint8Array(ph * (stride + 1));
    let prev = null;
    const row = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const sy = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const si = (sy * width + x0 + x * dx) * channels;
        for (let c = 0; c < channels; c++) {
          const v = data[si + c];
          if (depth === 16) {
            row[(x * channels + c) * 2] = v >> 8;
            row[(x * channels + c) * 2 + 1] = v & 255;
          } else row[x * channels + c] = v;
        }
      }
      filterRow(row, prev, bpp, out.subarray(y * (stride + 1), (y + 1) * (stride + 1)), adaptive);
      prev = prev ?? new Uint8Array(stride);
      prev.set(row);
    }
    parts.push(out);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const raw = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    raw.set(p, o);
    o += p.length;
  }
  const zipped = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace ? 1 : 0;
  const chunks = [chunk('IHDR', ihdr)];
  if (indexed) {
    chunks.push(chunk('PLTE', img.palette));
    if (img.transparency && img.transparency.some((a) => a !== 255)) {
      let n = img.transparency.length;
      while (n > 1 && img.transparency[n - 1] === 255) n--;
      chunks.push(chunk('tRNS', img.transparency.subarray(0, n)));
    }
  }
  if (dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const p = new Uint8Array(9);
    const pv = new DataView(p.buffer);
    pv.setUint32(0, ppm);
    pv.setUint32(4, ppm);
    p[8] = 1;
    chunks.push(chunk('pHYs', p));
  }
  for (const [k, v] of Object.entries(text ?? {})) {
    const key = new TextEncoder().encode(String(k).slice(0, 79));
    const val = Uint8Array.from(String(v), (ch) => ch.charCodeAt(0) & 255);
    const t = new Uint8Array(key.length + 1 + val.length);
    t.set(key, 0);
    t.set(val, key.length + 1);
    chunks.push(chunk('tEXt', t));
  }
  // one IDAT per 1 MB keeps chunk sizes modest for other decoders
  for (let i = 0; i < zipped.length; i += 1 << 20) chunks.push(chunk('IDAT', zipped.subarray(i, Math.min(zipped.length, i + (1 << 20)))));
  if (!zipped.length) chunks.push(chunk('IDAT', new Uint8Array(0)));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  const size = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(size);
  bytes.set(SIGNATURE, 0);
  o = 8;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

/** Convenience: encodes an RGBA ImageDataLike as an 8-bit RGBA (or RGB when every alpha is 255) PNG. */
export async function encodeRgba8(img, opts = {}) {
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) {
    opaque = false;
    break;
  }
  return encodePng(fromRgba8(img, opaque ? 3 : 4), opts);
}
