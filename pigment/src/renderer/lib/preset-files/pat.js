// Photoshop patterns (.pat) and the pattern records every Photoshop preset file shares (preset-files-manager).
// Pure and Node-safe.
//
// A pattern record (Photoshop's "pattern" structure, also in .asl, .abr, .tpl and PSD files): version 1, the image
// mode, the size, a unicode name, a Pascal id, a palette for Indexed patterns, then a "virtual memory array list" of
// channels (raw or PackBits, 8 or 16 bits). The reader decodes RGB, Grayscale and Indexed patterns with their
// transparency (ag-psd's readPattern drops the alpha channel and the Indexed RLE case, so this file decodes them
// itself); the writer writes RGB with PackBits and the alpha channel where the pattern is not opaque, at the slot
// ag-psd and Photoshop read it from.
//
//   readPatternRecord(reader) → { name, id, width, height, data (RGBA) }      a record without a length prefix
//   writePatternRecord(writer, { name, id, width, height, data })
//   readPatternList(bytes, offset, end) → { patterns, report }                length-prefixed records (.asl, .tpl)
//   writePatternList(writer, patterns)                                         the same, each padded to 4 bytes
//   readPatFile(bytes, { name }) → { presets, blobs, groups, report }          the store read of .pat (S10.1)
//   writePatFile(presets, { readBlob }) → { bytes, report }
//   patternRgba(data, readBlob) → { width, height, data } | null              a `patterns` preset's pixels
//   patternItem(pattern, ref) → a preset file item of kind `patterns`         (pixels as a fresh PNG side file)
//   registerPatFormat()
import { Reader, Writer, tooLarge, asBytes, baseName, freshBlob, Truncated } from './bytes.js';
import { decodePng, toRgba8, encodeRgba8 } from '../../../shared/pixels/png.js';
import { builtinPattern } from '../pattern-builtins.js';
import { registerPresetFormat } from '../presets.js';

const MODES = { 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };

/** PackBits rows: `h` u16 byte counts, then the rows. */
function unpackRows(r, w, h, out, stride, offset) {
  const counts = [];
  for (let y = 0; y < h; y++) counts.push(r.u16());
  for (let y = 0; y < h; y++) {
    const end = r.o + counts[y];
    let x = 0;
    while (r.o < end && x < w) {
      const n = r.u8();
      if (n < 128) {
        for (let k = 0; k <= n; k++) {
          const v = r.u8();
          if (x < w) out[(y * w + x) * stride + offset] = v;
          x++;
        }
      } else if (n > 128) {
        const v = r.u8();
        for (let k = 0; k < 257 - n; k++) {
          if (x < w) out[(y * w + x) * stride + offset] = v;
          x++;
        }
      }
    }
    r.o = end;
  }
}

function packRow(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out.push(257 - run, src[i]);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < src.length && lit < 128 && !(i + lit + 1 < src.length && src[i + lit] === src[i + lit + 1])) lit++;
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(src[i + k]);
    i += lit;
  }
  return out;
}

/** One pattern record (no length prefix) → { name, id, width, height, data: Uint8ClampedArray RGBA, mode }. */
export function readPatternRecord(r) {
  const version = r.u32();
  if (version !== 1) throw new Error(`pattern version ${version} is not one Pigment reads`);
  const mode = r.u32();
  const height = r.i16();
  const width = r.i16();
  const name = r.ustr();
  const id = r.pascal(1);
  let palette = null;
  if (mode === 2) {
    palette = r.take(768);
    r.skip(4);
  }
  if (mode !== 1 && mode !== 2 && mode !== 3) throw new Error(`the pattern "${name}" is in ${MODES[mode] ?? `mode ${mode}`}, which Pigment does not read`);
  if (r.u32() !== 3) throw new Error(`the pattern "${name}" is damaged`);
  const vmalLength = r.u32();
  const vmalEnd = r.o + vmalLength;
  if (vmalEnd > r.end) throw new Truncated();
  const top = r.u32(), left = r.u32(), bottom = r.u32(), right = r.u32();
  const w = right - left, h = bottom - top;
  if (!(w > 0 && h > 0 && w <= 30000 && h <= 30000)) throw new Error(`the pattern "${name}" has no pixels`);
  const channelsCount = r.u32();
  const colors = mode === 3 ? 3 : 1;
  const planes = [];
  let alpha = null;
  let colorIndex = 0;
  for (let i = 0; i < channelsCount + 2 && r.o < vmalEnd; i++) {
    if (!r.u32()) continue;
    const length = r.u32();
    const end = r.o + length;
    const depth = r.u32();
    const ct = r.u32(), cl = r.u32(), cb = r.u32(), cr = r.u32();
    r.u16();
    const compression = r.u8();
    const cw = cr - cl, ch = cb - ct;
    const plane = new Uint8Array(w * h);
    if (cw > 0 && ch > 0) {
      const tmp = new Uint8Array(cw * ch);
      if (compression === 0) {
        const bpp = depth === 16 ? 2 : 1;
        const raw = r.take(cw * ch * bpp);
        for (let k = 0; k < cw * ch; k++) tmp[k] = raw[k * bpp];
      } else if (compression === 1 && depth === 8) {
        unpackRows(r, cw, ch, tmp, 1, 0);
      } else throw new Error(`the pattern "${name}" uses ${depth}-bit compressed channels, which Pigment does not read`);
      const ox = cl - left, oy = ct - top;
      for (let y = 0; y < ch; y++) {
        const yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        for (let x = 0; x < cw; x++) {
          const xx = x + ox;
          if (xx >= 0 && xx < w) plane[yy * w + xx] = tmp[y * cw + x];
        }
      }
    }
    r.o = end;
    if (i < channelsCount) {
      if (colorIndex < colors) planes[colorIndex++] = plane;
    } else alpha = plane; // the transparency (the last written of the two extra slots)
  }
  r.o = vmalEnd;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    let rr, gg, bb;
    if (mode === 3) {
      rr = planes[0]?.[p] ?? 0;
      gg = planes[1]?.[p] ?? 0;
      bb = planes[2]?.[p] ?? 0;
    } else if (mode === 2) {
      const k = (planes[0]?.[p] ?? 0) * 3;
      rr = palette[k];
      gg = palette[k + 1];
      bb = palette[k + 2];
    } else rr = gg = bb = planes[0]?.[p] ?? 0;
    data[p * 4] = rr;
    data[p * 4 + 1] = gg;
    data[p * 4 + 2] = bb;
    data[p * 4 + 3] = alpha ? alpha[p] : 255;
  }
  void width;
  void height;
  return { name, id, width: w, height: h, data, mode: MODES[mode] };
}

/** Writes one pattern record (RGB, PackBits; the alpha channel only when a pixel is not opaque). No length prefix. */
export function writePatternRecord(o, { name = 'Pattern', id = '', width, height, data }) {
  const w = width, h = height;
  o.u32(1);
  o.u32(3);
  o.i16(h);
  o.i16(w);
  o.ustr(name);
  o.pascal(id, 1);
  o.u32(3);
  const vmal = o.lengthField();
  o.u32(0);
  o.u32(0);
  o.u32(h);
  o.u32(w);
  o.u32(24);
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) {
    opaque = false;
    break;
  }
  const channel = (offset) => {
    const rows = [];
    const row = new Uint8Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) row[x] = data[(y * w + x) * 4 + offset];
      rows.push(packRow(row));
    }
    o.u32(1);
    const len = o.lengthField();
    o.u32(8);
    o.u32(0);
    o.u32(0);
    o.u32(h);
    o.u32(w);
    o.u16(8);
    o.u8(1);
    for (const r of rows) o.u16(r.length);
    for (const r of rows) o.bytes(r);
    len();
  };
  for (let i = 0; i < 26; i++) {
    if (i < 3) channel(i);
    else if (i === 25 && !opaque) channel(3);
    else o.u32(0);
  }
  vmal();
}

/** Length-prefixed pattern records (each padded to 4 bytes), as .asl, .abr and .tpl hold them. Never throws. */
export function readPatternList(bytes, offset = 0, end = bytes.length) {
  const patterns = [];
  const report = [];
  const r = new Reader(bytes, offset, end);
  while (r.left >= 4) {
    let length;
    try {
      length = r.u32();
    } catch {
      break;
    }
    while (length % 4) length++;
    const next = r.o + length;
    try {
      patterns.push(readPatternRecord(new Reader(bytes, r.o, Math.min(next, r.end))));
    } catch (err) {
      report.push(err instanceof RangeError ? 'a pattern is truncated' : `a pattern could not be read: ${err?.message ?? err}`);
    }
    if (next > r.end) break;
    r.o = next;
  }
  return { patterns, report };
}

/** Writes length-prefixed pattern records, each padded to 4 bytes. */
export function writePatternList(o, patterns) {
  for (const p of patterns ?? []) {
    const done = o.lengthField();
    const start = o.n;
    writePatternRecord(o, p);
    o.pad4(start);
    done();
  }
}

/** A Photoshop pattern id for pixels (Photoshop's are UUIDs; any unique text reads back): a hash of the bytes. */
export function patternIdFor(data, w, h) {
  let a = 0x811c9dc5 ^ w, b = 0x01000193 ^ h, c = 0x9e3779b9, d = 0x7f4a7c15;
  for (let i = 0; i < data.length; i++) {
    a = Math.imul(a ^ data[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ a, 0x85ebca6b) >>> 0;
    c = Math.imul(c ^ b, 0xc2b2ae35) >>> 0;
    d = (d + c + data[i]) >>> 0;
  }
  const hex = [a, b, c, d].map((v) => v.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A `patterns` preset item of a preset file for decoded pixels (a fresh PNG side file): { kind, ref, name, data, blobs }. */
export async function patternItem(p, ref) {
  const blob = freshBlob('p-file');
  const png = await encodeRgba8({ width: p.width, height: p.height, data: p.data });
  return { kind: 'patterns', ...(ref ? { ref } : {}), name: p.name || 'Pattern', data: { width: p.width, height: p.height, blob, mode: 'rgb' }, blobs: { [blob]: png } };
}

/** The RGBA pixels of a `patterns` preset's data (a built-in's generator, or its PNG side file), or null. */
export async function patternRgba(data, readBlob) {
  if (!data) return null;
  if (typeof data.builtin === 'string') return builtinPattern(data.builtin);
  if (typeof data.blob !== 'string') return null;
  const bytes = await readBlob?.(data.blob);
  if (!bytes?.length) return null;
  return toRgba8(await decodePng(asBytes(bytes)));
}

// ---- .pat --------------------------------------------------------------------------------------------------------------

/**
 * The .pat store read: { presets, blobs, groups, report }. Records are read with or without a length prefix (the
 * prefix some writers add is detected); the patterns go into a group named after the file, as Photoshop does.
 */
export async function readPatFile(input, { name = 'Patterns.pat' } = {}) {
  const bytes = asBytes(input);
  const base = baseName(name, 'Patterns');
  const out = { presets: [], blobs: {}, groups: [], report: [] };
  const big = tooLarge(bytes, base);
  if (big) {
    out.report.push(big);
    return out;
  }
  const r = new Reader(bytes);
  const decoded = [];
  try {
    if (r.sig() !== '8BPT') throw new Error('not a Photoshop patterns (.pat) file');
    const version = r.u16();
    if (version !== 1) throw new Error(`version ${version} is not one Pigment reads`);
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      if (r.left < 4) {
        out.report.push(`${base}: the file ends after ${i} of its ${count} patterns`);
        break;
      }
      // a record starts with version 1; a length-prefixed record starts with its length, then version 1
      const prefixed = r.view.getUint32(r.o) !== 1 && r.left >= 8 && r.view.getUint32(r.o + 4) === 1;
      let next = null;
      if (prefixed) {
        let length = r.u32();
        while (length % 4) length++;
        next = r.o + length;
      }
      try {
        const sub = new Reader(bytes, r.o, next ?? r.end);
        decoded.push(readPatternRecord(sub));
        // without a prefix the record's own end (its channel list's length) is where the next one starts
        r.o = next === null ? sub.o : Math.min(next, r.end);
      } catch (err) {
        out.report.push(`${base}: ${err instanceof RangeError ? `pattern ${i + 1} is truncated` : err?.message ?? err}`);
        if (next === null) break; // without a length the next record cannot be found
        r.o = Math.min(next, r.end);
      }
    }
  } catch (err) {
    out.report.push(`${base}: ${err instanceof RangeError ? 'the file is truncated' : err?.message ?? err}`);
  }
  for (const p of decoded) {
    const item = await patternItem(p);
    out.presets.push({ name: item.name, group: 'file', data: item.data });
    Object.assign(out.blobs, item.blobs);
  }
  if (out.presets.length) out.groups.push({ id: 'file', name: base });
  else if (!out.report.length) out.report.push(`${base}: the file holds no patterns`);
  return out;
}

/** The .pat file of `patterns` presets: { bytes, report }. readBlob(name) reads the kind's PNG side files. */
export async function writePatFile(presets, { readBlob } = {}) {
  const report = [];
  const list = [];
  for (const p of presets ?? []) {
    let px = null;
    try {
      px = await patternRgba(p?.data, readBlob);
    } catch {
      px = null;
    }
    if (!px) {
      report.push(`"${p?.name ?? '?'}": its pixels are missing and it was left out`);
      continue;
    }
    list.push({ name: String(p.name ?? 'Pattern'), id: patternIdFor(px.data, px.width, px.height), width: px.width, height: px.height, data: px.data });
  }
  const o = new Writer();
  o.sig('8BPT');
  o.u16(1);
  o.u32(list.length);
  for (const p of list) writePatternRecord(o, p);
  return { bytes: o.done(), report };
}

/** Registers .pat for the `patterns` kind (S10.1). */
export function registerPatFormat() {
  registerPresetFormat('patterns', {
    id: 'pat',
    name: 'Photoshop Patterns',
    extensions: ['pat'],
    read: (bytes, info = {}) => readPatFile(bytes, info),
    write: async (presets, { readBlob } = {}) => (await writePatFile(presets, { readBlob })).bytes,
  });
}
