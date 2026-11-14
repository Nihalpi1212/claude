// GIF codec in plain JavaScript (see ARCHITECTURE.md "Image modes"). Browsers decode GIF files to
// RGBA and cannot write them at all, so Indexed Color documents, Save for Web and GIF export need
// this module: encodeGif() writes GIF89a with LZW compression, decodeGif() reads GIF87a/89a and
// keeps what a canvas decode throws away: the colour table and the transparent index.
//
// A frame is { indices: Uint8Array (width*height palette indices, rows top to bottom), palette:
// [[r, g, b], ...] (2..256 entries), transparentIndex: number (-1 = none), delay: milliseconds }.
// Pigment 0.3 writes one frame; the format support for several (local colour tables, delays,
// looping, disposal) is here so the animation work of 0.5 only has to supply frames.

const TEXT = (s) => Array.from(s, (c) => c.charCodeAt(0));

/** Bits needed to index `n` palette entries (GIF tables hold 2^(bits) colours, at least 2). */
function tableBits(n) {
  let bits = 1;
  while (1 << bits < n) bits++;
  return Math.min(8, bits);
}

function samePalette(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
  return true;
}

function paletteBytes(palette, bits) {
  const out = new Uint8Array(3 << bits);
  for (let i = 0; i < palette.length && i < 1 << bits; i++) {
    out[i * 3] = palette[i][0];
    out[i * 3 + 1] = palette[i][1];
    out[i * 3 + 2] = palette[i][2];
  }
  return out;
}

/** Growable byte sink. */
class Bytes {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.length = 0;
  }
  ensure(n) {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(v) {
    this.ensure(1);
    this.buf[this.length++] = v;
  }
  u16(v) {
    this.ensure(2);
    this.buf[this.length++] = v & 255;
    this.buf[this.length++] = (v >> 8) & 255;
  }
  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.length);
    this.length += arr.length;
  }
  done() {
    return this.buf.slice(0, this.length);
  }
}

/**
 * LZW-compresses palette indices the GIF way: variable-width codes starting at minCodeSize + 1
 * bits, a clear code first and whenever the 4096-entry table fills, least significant bit first,
 * cut into sub-blocks of at most 255 bytes.
 */
export function lzwEncode(indices, minCodeSize, sink = new Bytes()) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  // open-addressing hash of (prefix code << 8 | byte) -> code
  const HASH = 1 << 13, MASK = HASH - 1;
  const keys = new Int32Array(HASH).fill(-1), vals = new Int16Array(HASH);
  let acc = 0, bits = 0;
  const block = new Uint8Array(255);
  let blockLen = 0;
  const flushBlock = () => {
    if (!blockLen) return;
    sink.byte(blockLen);
    sink.bytes(block.subarray(0, blockLen));
    blockLen = 0;
  };
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block[blockLen++] = acc & 255;
      if (blockLen === 255) flushBlock();
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  if (indices.length) {
    const limit = clear - 1;
    let prefix = indices[0] & limit;
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i] & limit;
      const key = (prefix << 8) | c;
      let h = ((prefix << 4) ^ (c * 31)) & MASK;
      while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & MASK;
      if (keys[h] === key) {
        prefix = vals[h];
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        keys[h] = key;
        vals[h] = next++;
        // the decoder grows its code size one step later than its table, so the encoder switches after emitting
        if (next > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        keys.fill(-1);
        next = eoi + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = c;
    }
    emit(prefix);
  }
  emit(eoi);
  if (bits > 0) {
    block[blockLen++] = acc & 255;
    if (blockLen === 255) flushBlock();
  }
  flushBlock();
  sink.byte(0); // block terminator
  return sink;
}

/**
 * Encodes frames as a GIF89a file.
 * @param {{ indices: Uint8Array, palette: number[][], transparentIndex?: number, delay?: number, x?: number, y?: number, width?: number, height?: number, disposal?: number }[]} frames
 * @param {number} width logical screen width (frames without their own size cover it)
 * @param {number} height
 * @param {{ loop?: number|null }} [opts] loop: 0 = forever, n = repeat count, null/undefined = no loop extension (single frames never get one)
 * @returns {Uint8Array}
 */
export function encodeGif(frames, width, height, { loop = null } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('A GIF needs at least one frame');
  if (!(width > 0 && height > 0) || width > 65535 || height > 65535) throw new Error('GIF images are 1 to 65535 pixels wide and high');
  const first = frames[0];
  if (!first.palette?.length || first.palette.length > 256) throw new Error('A GIF palette holds 1 to 256 colours');
  const out = new Bytes(Math.max(1024, (width * height) >> 1));
  out.bytes(TEXT('GIF89a'));
  out.u16(width);
  out.u16(height);
  const gbits = tableBits(first.palette.length);
  out.byte(0x80 | ((gbits - 1) << 4) | (gbits - 1)); // global table, colour resolution, table size
  out.byte(0); // background colour index
  out.byte(0); // pixel aspect ratio (none)
  out.bytes(paletteBytes(first.palette, gbits));
  if (frames.length > 1 && loop !== null && loop !== undefined) {
    out.bytes([0x21, 0xff, 11, ...TEXT('NETSCAPE2.0'), 3, 1]);
    out.u16(Math.max(0, Math.min(65535, loop | 0)));
    out.byte(0);
  }
  for (const f of frames) {
    const fw = f.width ?? width, fh = f.height ?? height;
    if (!f.indices || f.indices.length < fw * fh) throw new Error('A GIF frame needs one index per pixel');
    const palette = f.palette ?? first.palette;
    if (palette.length > 256) throw new Error('A GIF palette holds 1 to 256 colours');
    const ti = f.transparentIndex ?? -1;
    const delay = Math.max(0, Math.min(65535, Math.round((f.delay ?? 0) / 10)));
    if (ti >= 0 || delay > 0 || frames.length > 1) {
      out.bytes([0x21, 0xf9, 4, (((f.disposal ?? (frames.length > 1 ? 1 : 0)) & 7) << 2) | (ti >= 0 ? 1 : 0)]);
      out.u16(delay);
      out.byte(ti >= 0 ? ti & 255 : 0);
      out.byte(0);
    }
    out.byte(0x2c);
    out.u16(f.x ?? 0);
    out.u16(f.y ?? 0);
    out.u16(fw);
    out.u16(fh);
    const local = !samePalette(palette, first.palette);
    const bits = local ? tableBits(palette.length) : gbits;
    out.byte(local ? 0x80 | (bits - 1) : 0);
    if (local) out.bytes(paletteBytes(palette, bits));
    const minCode = Math.max(2, bits);
    out.byte(minCode);
    lzwEncode(f.indices.length === fw * fh ? f.indices : f.indices.subarray(0, fw * fh), minCode, out);
  }
  out.byte(0x3b);
  return out.done();
}

/**
 * Undoes GIF LZW: `data` is the concatenated sub-blocks, `count` the number of indices expected. A stream that
 * ends (or goes wrong) before `count` indices leaves the rest at index 0, or throws with `strict`.
 */
export function lzwDecode(data, minCodeSize, count, { strict = false } = {}) {
  const out = new Uint8Array(count);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let codeSize = minCodeSize + 1, mask = (1 << codeSize) - 1, next = eoi + 1;
  let acc = 0, bits = 0, pos = 0, o = 0, prev = -1, firstByte = 0;
  while (o < count) {
    while (bits < codeSize && pos < data.length) {
      acc |= data[pos++] << bits;
      bits += 8;
    }
    if (bits < codeSize) break; // truncated stream: the rest stays index 0
    let code = acc & mask;
    acc >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      mask = (1 << codeSize) - 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev === -1) {
      if (code >= clear) break; // corrupt: the first code after a clear must be a literal
      out[o++] = code;
      prev = code;
      firstByte = code;
      continue;
    }
    const incoming = code;
    let sp = 0;
    if (code >= next) {
      // the code being defined right now (KwKwK)
      stack[sp++] = firstByte;
      code = prev;
    }
    while (code >= clear) {
      if (sp >= 4096) {
        if (strict) throw new Error('The GIF file is damaged: part of its image data is missing');
        return out; // corrupt chain
      }
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    firstByte = suffix[code];
    stack[sp++] = firstByte;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      next++;
      if (next > mask && codeSize < 12) {
        codeSize++;
        mask = (1 << codeSize) - 1;
      }
    }
    prev = incoming;
    while (sp > 0 && o < count) out[o++] = stack[--sp];
  }
  if (strict && o < count) throw new Error('The GIF file is truncated: part of its image data is missing');
  return out;
}

export const isGif = (b) => !!b && b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;

/**
 * Decodes a GIF file.
 * @param {Uint8Array} bytes
 * @param {{ firstFrameOnly?: boolean }} [opts]
 * @returns {{ width: number, height: number, loop: number|null, background: number, globalPalette: number[][]|null,
 *   frames: { x: number, y: number, width: number, height: number, indices: Uint8Array, palette: number[][], transparentIndex: number, delay: number, disposal: number, interlaced: boolean }[] }}
 */
export function decodeGif(bytes, { firstFrameOnly = false } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isGif(b)) throw new Error('This is not a GIF file');
  let p = 6;
  const u16 = () => {
    const v = b[p] | (b[p + 1] << 8);
    p += 2;
    return v;
  };
  const need = (n) => {
    if (p + n > b.length) throw new Error('The GIF file is truncated');
  };
  const readPalette = (bits) => {
    const n = 1 << bits;
    need(n * 3);
    const out = [];
    for (let i = 0; i < n; i++) out.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]);
    p += n * 3;
    return out;
  };
  const skipBlocks = () => {
    while (p < b.length) {
      const n = b[p++];
      if (!n) return;
      p += n;
    }
  };
  need(7);
  const width = u16(), height = u16();
  const flags = b[p++];
  const background = b[p++];
  p++; // aspect ratio
  const globalPalette = flags & 0x80 ? readPalette((flags & 7) + 1) : null;
  const gif = { width, height, loop: null, background, globalPalette, frames: [] };
  let gce = null;
  while (p < b.length) {
    const kind = b[p++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = b[p++];
      if (label === 0xf9 && b[p] === 4) {
        need(6);
        const f = b[p + 1];
        gce = { disposal: (f >> 2) & 7, delay: (b[p + 2] | (b[p + 3] << 8)) * 10, transparentIndex: f & 1 ? b[p + 4] : -1 };
        p += 5;
        skipBlocks();
      } else if (label === 0xff && b[p] === 11) {
        const id = String.fromCharCode(...b.subarray(p + 1, p + 12));
        p += 12;
        if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && b[p] === 3 && b[p + 1] === 1) gif.loop = b[p + 2] | (b[p + 3] << 8);
        skipBlocks();
      } else skipBlocks();
      continue;
    }
    if (kind !== 0x2c) {
      // junk between blocks: some writers pad with zeros; anything else ends the parse with what was read
      if (kind === 0) continue;
      break;
    }
    need(9);
    const x = u16(), y = u16(), w = u16(), h = u16();
    const f = b[p++];
    const palette = f & 0x80 ? readPalette((f & 7) + 1) : globalPalette;
    if (!palette) throw new Error('The GIF file has no colour table');
    need(1);
    const minCode = b[p++];
    if (minCode < 1 || minCode > 11) throw new Error('The GIF file is damaged (bad LZW code size)');
    // gather the sub-blocks
    let total = 0;
    for (let q = p; q < b.length; ) {
      const n = b[q++];
      if (!n) break;
      total += n;
      q += n;
    }
    const data = new Uint8Array(total);
    let o = 0;
    while (p < b.length) {
      const n = b[p++];
      if (!n) break;
      data.set(b.subarray(p, Math.min(b.length, p + n)), o);
      o += n;
      p += n;
    }
    // a frame cut short would show as blank rows: an error, not an image
    let indices = lzwDecode(data, minCode, w * h, { strict: true });
    const interlaced = !!(f & 0x40);
    if (interlaced) {
      const out = new Uint8Array(w * h);
      let row = 0;
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let yy = start; yy < h; yy += step) {
        out.set(indices.subarray(row * w, row * w + w), yy * w);
        row++;
      }
      indices = out;
    }
    gif.frames.push({ x, y, width: w, height: h, indices, palette, transparentIndex: gce?.transparentIndex ?? -1, delay: gce?.delay ?? 0, disposal: gce?.disposal ?? 0, interlaced });
    gce = null;
    if (firstFrameOnly) break;
  }
  if (!gif.frames.length) throw new Error('The GIF file holds no image');
  return gif;
}

/**
 * One frame placed on the logical screen as palette indices (pixels the frame does not cover get
 * `fill`, by default the frame's transparent index or 0) together with its palette.
 */
export function gifFrameIndices(gif, index = 0, fill = null) {
  const f = gif.frames[index];
  const { width: W, height: H } = gif;
  if (f.x === 0 && f.y === 0 && f.width === W && f.height === H) return f.indices;
  const out = new Uint8Array(W * H).fill(fill ?? (f.transparentIndex >= 0 ? f.transparentIndex : 0));
  for (let y = 0; y < f.height; y++) {
    const dy = f.y + y;
    if (dy < 0 || dy >= H) continue;
    const w = Math.min(f.width, W - f.x);
    if (w > 0) out.set(f.indices.subarray(y * f.width, y * f.width + w), dy * W + f.x);
  }
  return out;
}

/** RGBA ImageDataLike of one frame on the logical screen (uncovered and transparent pixels have alpha 0). */
export function gifFrameImage(gif, index = 0) {
  const f = gif.frames[index];
  const { width: W, height: H } = gif;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < f.height; y++) {
    const dy = f.y + y;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < f.width; x++) {
      const dx = f.x + x;
      if (dx < 0 || dx >= W) continue;
      const k = f.indices[y * f.width + x];
      if (k === f.transparentIndex) continue;
      const c = f.palette[k] ?? [0, 0, 0];
      const i = (dy * W + dx) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}
