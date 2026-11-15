// Swatch files (ARCHITECTURE.md "0.5 features", S7.2): Adobe Swatch Exchange (.ase) and Photoshop Color Swatches
// (.aco), pure readers and writers. Owned by preset-files-manager, which registers .ase / .aco for the `swatches` kind
// (registerPresetFormat('swatches', …), registerSwatchFormats below); color-picker-swatches' Color Libraries dialog
// calls parseAse itself to build a `color-books` preset.
//
// Colours are S7.2's { space: 'rgb' | 'lab' | 'cmyk' | 'gray', values }: rgb 0..255, lab L 0..100 and a b -128..127,
// cmyk 0..100 (ink), gray 0..100 (ink: 0 is white, as Photoshop's Grayscale K). type is 'global' | 'spot' | 'process'.
//
//   parseAse(bytes) → { groups: { name, colors }[], colors, all, report }   `colors` are the colours outside any group,
//       `all` every colour in file order (extra). Never throws: a damaged file gives what came before the damage.
//   parseAco(bytes) → the same shape (an .aco file has no groups): version 2's names when the file has them, else
//       version 1's colours named by their numbers. HSB colours become RGB; colour-book colours (Pantone and others
//       store only a book index) are reported and skipped.
//   writeAse({ groups, colors }) → { bytes, report }   groups' colours inside their group, `colors` outside.
//   writeAco({ colors }) → { bytes, report }           version 1 then version 2 (with names), as Photoshop writes.
//   registerSwatchFormats() → registers both for `swatches` (idempotent; the later registration wins).
import { Reader, Writer, tooLarge, asBytes, baseName } from './bytes.js';
import { registerPresetFormat } from '../presets.js';

export const ACO_ASE_REAL = true;

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r2 = (v) => Math.round(v * 100) / 100; // .aco's 16-bit words hold hundredths of a percent
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TYPES = ['global', 'spot', 'process'];
const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');

/** '#rrggbb' of an RGB swatch colour (for names), or null. */
function hexOf(color) {
  if (color?.space !== 'rgb') return null;
  return `#${color.values.map(hex2).join('')}`;
}

function hsbToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

// ---- .ase -----------------------------------------------------------------------------------------------------------

/** parseAse(bytes) → { groups: { name, colors }[], colors, all, report }. Never throws. */
export function parseAse(input) {
  const bytes = asBytes(input);
  const out = { groups: [], colors: [], all: [], report: [] };
  const big = tooLarge(bytes);
  if (big) {
    out.report.push(big);
    return out;
  }
  const r = new Reader(bytes);
  try {
    if (r.sig() !== 'ASEF') throw new Error('not an Adobe Swatch Exchange file');
    const major = r.u16();
    r.u16();
    if (major !== 1) throw new Error(`version ${major} is not one Pigment reads`);
    const count = r.u32();
    let group = null;
    let skipped = 0;
    for (let i = 0; i < count; i++) {
      if (r.left === 0) {
        out.report.push(`the file ends after ${i} of its ${count} entries`);
        break;
      }
      const type = r.u16();
      const length = r.u32();
      const end = r.o + length;
      if (end > r.end) throw new RangeError('the file ends early');
      const b = new Reader(bytes, r.o, end);
      if (type === 0x0001) {
        const name = b.left >= 2 ? b.utf16(b.u16()) : '';
        const model = b.sig();
        let color = null;
        if (model === 'RGB ') color = { space: 'rgb', values: [b.f32(), b.f32(), b.f32()].map((v) => r4(clamp(v, 0, 1) * 255)) };
        else if (model === 'CMYK') color = { space: 'cmyk', values: [b.f32(), b.f32(), b.f32(), b.f32()].map((v) => r4(clamp(v, 0, 1) * 100)) };
        else if (model === 'LAB ') color = { space: 'lab', values: [r4(clamp(b.f32(), 0, 1) * 100), r4(clamp(b.f32(), -128, 127)), r4(clamp(b.f32(), -128, 127))] };
        else if (model === 'Gray') color = { space: 'gray', values: [r4(clamp(b.f32(), 0, 1) * 100)] };
        if (!color) skipped++;
        else {
          const t = b.left >= 2 ? b.u16() : 2;
          const entry = { name: name || hexOf(color) || `Swatch ${out.all.length + 1}`, color, type: TYPES[t] ?? 'process' };
          out.all.push(entry);
          (group ? group.colors : out.colors).push(entry);
        }
      } else if (type === 0xc001) {
        const name = b.left >= 2 ? b.utf16(b.u16()) : '';
        group = { name: name || `Group ${out.groups.length + 1}`, colors: [] };
        out.groups.push(group);
      } else if (type === 0xc002) {
        group = null;
      } else {
        skipped++;
      }
      r.o = end;
    }
    if (skipped) out.report.push(`${skipped} ${skipped === 1 ? 'entry was' : 'entries were'} skipped (a colour model or block Pigment does not read)`);
  } catch (err) {
    out.report.push(err instanceof RangeError ? `the file is truncated: ${out.all.length} ${out.all.length === 1 ? 'colour' : 'colours'} read` : String(err?.message ?? err));
  }
  return out;
}

function aseColor(w, entry, report) {
  const c = entry?.color;
  const values = Array.isArray(c?.values) ? c.values.map((v) => (Number.isFinite(v) ? v : 0)) : null;
  if (!values) {
    report.push(`"${entry?.name ?? '?'}" has no colour and was left out`);
    return false;
  }
  const name = String(entry.name ?? '');
  const len = 2 + (name.length + 1) * 2 + 4 + ({ rgb: 12, cmyk: 16, lab: 12, gray: 4 }[c.space] ?? 0) + 2;
  if (!['rgb', 'cmyk', 'lab', 'gray'].includes(c.space)) {
    report.push(`"${name}" is in a colour space .ase does not hold`);
    return false;
  }
  w.u16(0x0001);
  w.u32(len);
  w.u16(name.length + 1);
  w.utf16(name);
  w.u16(0);
  if (c.space === 'rgb') {
    w.sig('RGB ');
    for (let i = 0; i < 3; i++) w.f32(clamp(values[i] ?? 0, 0, 255) / 255);
  } else if (c.space === 'cmyk') {
    w.sig('CMYK');
    for (let i = 0; i < 4; i++) w.f32(clamp(values[i] ?? 0, 0, 100) / 100);
  } else if (c.space === 'lab') {
    w.sig('LAB ');
    w.f32(clamp(values[0] ?? 0, 0, 100) / 100);
    w.f32(clamp(values[1] ?? 0, -128, 127));
    w.f32(clamp(values[2] ?? 0, -128, 127));
  } else {
    w.sig('Gray');
    w.f32(clamp(values[0] ?? 0, 0, 100) / 100);
  }
  const t = TYPES.indexOf(entry.type ?? 'process');
  w.u16(t < 0 ? 2 : t);
  return true;
}

/** writeAse({ groups, colors }) → { bytes, report }. */
export function writeAse({ groups = [], colors = [] } = {}) {
  const report = [];
  const w = new Writer();
  w.sig('ASEF');
  w.u16(1);
  w.u16(0);
  const countAt = w.n;
  w.u32(0);
  let blocks = 0;
  for (const c of colors ?? []) if (aseColor(w, c, report)) blocks++;
  for (const g of groups ?? []) {
    const name = String(g?.name ?? 'Group');
    w.u16(0xc001);
    w.u32(2 + (name.length + 1) * 2);
    w.u16(name.length + 1);
    w.utf16(name);
    w.u16(0);
    blocks++;
    for (const c of g?.colors ?? []) if (aseColor(w, c, report)) blocks++;
    w.u16(0xc002);
    w.u32(0);
    blocks++;
  }
  w.dv().setUint32(countAt, blocks);
  return { bytes: w.done(), report };
}

// ---- .aco -----------------------------------------------------------------------------------------------------------

const ACO_BOOKS = { 3: 'Pantone', 4: 'Focoltone', 5: 'Trumatch', 6: 'Toyo', 10: 'HKS' };

/** An .aco colour record (space, four u16 words) as an S7.2 colour, or a string naming why it is skipped. */
function acoColor(space, w) {
  switch (space) {
    case 0: return { space: 'rgb', values: [w[0], w[1], w[2]].map((v) => r4((v / 65535) * 255)) };
    case 1: return { space: 'rgb', values: hsbToRgb((w[0] / 65535) * 360, w[1] / 65535, w[2] / 65535).map(r4) };
    case 2: return { space: 'cmyk', values: w.map((v) => r2(100 - (v / 65535) * 100)) };
    case 7: {
      const s = (v) => (v > 32767 ? v - 65536 : v);
      return { space: 'lab', values: [r4(clamp(w[0] / 100, 0, 100)), r4(clamp(s(w[1]) / 100, -128, 127)), r4(clamp(s(w[2]) / 100, -128, 127))] };
    }
    case 8: return { space: 'gray', values: [r4(clamp(w[0] / 100, 0, 100))] };
    case 9: return { space: 'cmyk', values: w.map((v) => r4(clamp(v / 100, 0, 100))) };
    default: return ACO_BOOKS[space] ? `${ACO_BOOKS[space]} colour-book colours` : `colour space ${space}`;
  }
}

/** parseAco(bytes) → { groups: [], colors, all, report }. Never throws. */
export function parseAco(input) {
  const bytes = asBytes(input);
  const out = { groups: [], colors: [], all: [], report: [] };
  const big = tooLarge(bytes);
  if (big) {
    out.report.push(big);
    return out;
  }
  const r = new Reader(bytes);
  const skipped = new Map();
  const readSection = (withNames) => {
    const list = [];
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const space = r.u16();
      const words = [r.u16(), r.u16(), r.u16(), r.u16()];
      let name = '';
      if (withNames) {
        const n = r.u32();
        if (n > r.left / 2) throw new RangeError('the file ends early');
        name = r.utf16(n);
      }
      list.push({ space, words, name });
    }
    return list;
  };
  let records = [];
  try {
    const version = r.u16();
    if (version !== 1 && version !== 2) throw new Error('not a Photoshop swatches (.aco) file');
    if (version === 1) {
      records = readSection(false);
      // version 2 follows version 1 in files Photoshop writes: its names win
      if (r.left >= 4 && r.view.getUint16(r.o) === 2) {
        r.u16();
        try {
          const named = readSection(true);
          if (named.length) records = named;
        } catch (err) {
          out.report.push('the named part of the file is truncated: its colours are read without names');
          void err;
        }
      }
    } else {
      records = readSection(true);
    }
  } catch (err) {
    out.report.push(err instanceof RangeError ? 'the file is truncated' : String(err?.message ?? err));
  }
  for (const rec of records) {
    const color = acoColor(rec.space, rec.words);
    if (typeof color === 'string') {
      skipped.set(color, (skipped.get(color) ?? 0) + 1);
      continue;
    }
    const entry = { name: rec.name || hexOf(color) || `Swatch ${out.all.length + 1}`, color, type: 'process' };
    out.colors.push(entry);
    out.all.push(entry);
  }
  for (const [what, n] of skipped) out.report.push(`${n} ${what} ${n === 1 ? 'was' : 'were'} skipped (Pigment has no books of its own)`);
  return out;
}

function acoWords(color) {
  const v = Array.isArray(color?.values) ? color.values.map((x) => (Number.isFinite(x) ? x : 0)) : [];
  switch (color?.space) {
    case 'rgb': return [0, ...[0, 1, 2].map((i) => Math.round((clamp(v[i] ?? 0, 0, 255) / 255) * 65535)), 0];
    case 'cmyk': return [2, ...[0, 1, 2, 3].map((i) => 65535 - Math.round((clamp(v[i] ?? 0, 0, 100) / 100) * 65535))];
    case 'lab': return [7, Math.round(clamp(v[0] ?? 0, 0, 100) * 100), Math.round(clamp(v[1] ?? 0, -128, 127) * 100) & 0xffff, Math.round(clamp(v[2] ?? 0, -128, 127) * 100) & 0xffff, 0];
    case 'gray': return [8, Math.round(clamp(v[0] ?? 0, 0, 100) * 100), 0, 0, 0];
    default: return null;
  }
}

/** writeAco({ colors }) → { bytes, report }: version 1, then version 2 with the names. */
export function writeAco({ colors = [] } = {}) {
  const report = [];
  const list = [];
  for (const c of colors ?? []) {
    const words = acoWords(c?.color);
    if (!words) report.push(`"${c?.name ?? '?'}" is in a colour space .aco does not hold`);
    else list.push({ words, name: String(c.name ?? '') });
  }
  if (list.length > 65535) {
    report.push(`only the first 65535 of ${list.length} colours fit in an .aco file`);
    list.length = 65535;
  }
  const w = new Writer();
  for (const version of [1, 2]) {
    w.u16(version);
    w.u16(list.length);
    for (const { words, name } of list) {
      for (const x of words) w.u16(x);
      if (version === 2) {
        w.u32(name.length + 1);
        w.utf16(name);
        w.u16(0);
      }
    }
  }
  return { bytes: w.done(), report };
}

// ---- the preset formats ------------------------------------------------------------------------------------------------

const isColor = (c) => c && ['rgb', 'lab', 'cmyk', 'gray'].includes(c.space) && Array.isArray(c.values);

/** A swatch preset's data for a parsed colour: S7.2's { color } plus the swatch `type` when it is not process. */
const swatchData = (c) => ({ color: { space: c.color.space, values: c.color.values.slice() }, ...(c.type && c.type !== 'process' ? { type: c.type } : {}) });

/** The store read (0.4's registerPresetFormat shape) for a parsed swatch file: one group named after the file. */
function storeRead(parsed, name) {
  const file = { id: 'file', name: baseName(name, 'Swatches') };
  const groups = [file];
  const presets = parsed.colors.map((c) => ({ name: c.name, group: 'file', data: swatchData(c) }));
  parsed.groups.forEach((g, i) => {
    const id = `g${i}`;
    groups.push({ id, name: g.name, parent: 'file' });
    for (const c of g.colors) presets.push({ name: c.name, group: id, data: swatchData(c) });
  });
  if (!presets.length && !parsed.report.length) parsed.report.push('the file holds no colours');
  return { presets, groups: presets.length ? groups : [], report: parsed.report.map((l) => `${baseName(name, 'Swatches')}: ${l}`) };
}

/** The swatches of a store write as a parse result: grouped by their preset groups (nested groups flattened). */
function selectionOf(presets, groups = []) {
  const names = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const colors = [];
  const byGroup = new Map();
  for (const p of presets ?? []) {
    if (!isColor(p?.data?.color)) continue;
    const entry = { name: p.name, color: p.data.color, type: p.data.type ?? 'process' };
    if (p.group && names.has(p.group)) {
      if (!byGroup.has(p.group)) byGroup.set(p.group, { name: names.get(p.group), colors: [] });
      byGroup.get(p.group).colors.push(entry);
    } else colors.push(entry);
  }
  return { colors, groups: [...byGroup.values()] };
}

let registered = false;
/** Registers .ase and .aco for the `swatches` kind (S7.2). */
export function registerSwatchFormats() {
  registered = true;
  registerPresetFormat('swatches', {
    id: 'ase',
    name: 'Swatch Exchange',
    extensions: ['ase'],
    read: async (bytes, { name = 'Swatches.ase' } = {}) => storeRead(parseAse(bytes), name),
    write: async (presets, { groups } = {}) => writeAse(selectionOf(presets, groups)).bytes,
  });
  registerPresetFormat('swatches', {
    id: 'aco',
    name: 'Photoshop Swatches',
    extensions: ['aco'],
    read: async (bytes, { name = 'Swatches.aco' } = {}) => storeRead(parseAco(bytes), name),
    write: async (presets, { groups } = {}) => {
      const sel = selectionOf(presets, groups);
      return writeAco({ colors: [...sel.colors, ...sel.groups.flatMap((g) => g.colors)] }).bytes;
    },
  });
  return registered;
}
