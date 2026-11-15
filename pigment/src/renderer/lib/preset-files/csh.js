// Photoshop custom shapes (.csh) for the `shapes` kind (preset-files-manager; the paths are psd-layers' half, S4.6:
// pathFromPsd / pathToPsd). Pure and Node-safe.
//
// The file is 'cush', version 2 and the shapes: each a unicode name, a Pascal id, its bounds and Photoshop's path
// records (the vector mask records of PSD, 26 bytes each, 8.24 fixed-point fractions of the shape's box). Reading goes
// through ag-psd's readCsh and pathFromPsd; the path is then put in the 0..1 box the `shapes` kind keeps (S10.5), and
// the shape's own proportions are kept beside it as `width` / `height` (Photoshop's Defined Proportions). Writing
// builds the records here from pathToPsd's knots (ag-psd has no .csh writer).
//
//   readCshFile(bytes, { name }) → { presets, groups, report }   the store read (S10.1)
//   writeCshFile(presets) → { bytes, report }
//   registerCshFormat()
import { Writer, tooLarge, asBytes, baseName } from './bytes.js';
import { readCsh } from '#ag-psd';
import { pathFromPsd, pathToPsd } from '../psd/vector.js';
import { psdFeatures } from '../psd/registry.js';
import { registerPresetFormat } from '../presets.js';

const OPS = ['exclude', 'combine', 'subtract', 'intersect']; // Photoshop's boolean operation numbers
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** A Path scaled by (sx, sy). */
function scalePath(path, sx, sy) {
  const pt = (p) => {
    const out = { x: r6(p.x * sx), y: r6(p.y * sy) };
    if (p.inX !== undefined) Object.assign(out, { inX: r6(p.inX * sx), inY: r6(p.inY * sy) });
    if (p.outX !== undefined) Object.assign(out, { outX: r6(p.outX * sx), outY: r6(p.outY * sy) });
    return out;
  };
  return { subpaths: path.subpaths.map((sp) => ({ ...sp, points: sp.points.map(pt) })) };
}

/** The .csh store read: { presets, groups, report }; the shapes go into a group named after the file. */
export async function readCshFile(input, { name = 'Shapes.csh' } = {}) {
  const bytes = asBytes(input);
  const base = baseName(name, 'Shapes');
  const out = { presets: [], groups: [], report: [] };
  const big = tooLarge(bytes, base);
  if (big) {
    out.report.push(big);
    return out;
  }
  if (!psdFeatures().vectorMasks) out.report.push(`${base}: shape outlines are read once PSD vector masks are part of Pigment`);
  let csh = null;
  try {
    csh = readCsh(bytes);
  } catch (err) {
    // ag-psd stops at the damage: read the shapes before it one at a time
    csh = readPartial(bytes);
    out.report.push(`${base}: ${csh.shapes.length ? `the file is damaged after ${csh.shapes.length} ${csh.shapes.length === 1 ? 'shape' : 'shapes'}` : /signature|version/i.test(String(err?.message)) ? 'not a Photoshop custom shapes (.csh) file' : 'the file is truncated or damaged'}`);
  }
  csh.shapes.forEach((s, i) => {
    const w = s.width > 0 ? s.width : 1, h = s.height > 0 ? s.height : 1;
    const path = pathFromPsd(s.paths, w, h);
    const label = String(s.name ?? '').replace(/\0+$/, '') || `Shape ${i + 1}`;
    if (!path) {
      if (psdFeatures().vectorMasks) out.report.push(`${base}: "${label}" has no outline`);
      return;
    }
    out.presets.push({ name: label, group: 'file', data: { path: scalePath(path, 1 / w, 1 / h), width: w, height: h } });
  });
  if (out.presets.length) out.groups.push({ id: 'file', name: base });
  else if (!out.report.length) out.report.push(`${base}: the file holds no shapes`);
  return out;
}

/** The shapes before a damaged one: readCsh with the count patched, the largest count it reads (a binary search). */
function readPartial(bytes) {
  if (bytes.length < 12) return { shapes: [] };
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  const attempt = (n) => {
    const copy = bytes.slice();
    new DataView(copy.buffer).setUint32(8, n);
    try {
      return readCsh(copy);
    } catch {
      return null;
    }
  };
  // readCsh of all `count` failed; the first n shapes read whenever n is at most the last whole one
  let lo = 0, hi = Math.max(0, count - 1);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (attempt(mid)) lo = mid;
    else hi = mid - 1;
  }
  return (lo && attempt(lo)) || { shapes: [] };
}

/** The 26-byte records of one subpath (knots as fractions of the box). */
function writeSubpath(w, p) {
  w.u16(p.open ? 3 : 0);
  w.u16(p.knots.length);
  w.i16(p.operation ? OPS.indexOf(p.operation) : -1);
  w.u16(p.fillRule === 'non-zero' ? 2 : 1);
  w.zeros(18);
  for (const { linked, points } of p.knots) {
    w.u16(p.open ? (linked ? 4 : 5) : linked ? 1 : 2);
    for (const i of [1, 0, 3, 2, 5, 4]) w.i32(Math.round(Math.max(-127, Math.min(127, points[i])) * (1 << 24)));
  }
}

/** The .csh file of `shapes` presets: { bytes, report }. */
export function writeCshFile(presets) {
  const report = [];
  const shapes = [];
  for (const p of presets ?? []) {
    const records = pathToPsd(p?.data?.path, 1, 1);
    if (!records) {
      report.push(`"${p?.name ?? '?'}" has no outline and was left out`);
      continue;
    }
    const wPx = Math.max(1, Math.round(Number(p.data.width) || 100));
    const hPx = Math.max(1, Math.round(Number(p.data.height) || 100));
    shapes.push({ name: String(p.name ?? 'Shape'), records, wPx, hPx, id: `pigment-${shapes.length + 1}` });
  }
  const w = new Writer();
  w.sig('cush');
  w.u32(2);
  w.u32(shapes.length);
  for (const s of shapes) {
    w.ustr(s.name);
    w.pad4(0);
    w.u32(1);
    const size = w.lengthField();
    w.pascal(s.id, 1);
    w.u32(0);
    w.u32(0);
    w.u32(s.hPx);
    w.u32(s.wPx);
    // the path fill rule record, then the initial fill rule record, as PSD vector masks begin
    w.u16(6);
    w.zeros(24);
    w.u16(8);
    w.u16(0);
    w.zeros(22);
    for (const sp of s.records) writeSubpath(w, sp);
    size();
  }
  return { bytes: w.done(), report };
}

/** Registers .csh for the `shapes` kind (S10.1). */
export function registerCshFormat() {
  registerPresetFormat('shapes', {
    id: 'csh',
    name: 'Photoshop Custom Shapes',
    extensions: ['csh'],
    read: (bytes, info = {}) => readCshFile(bytes, info),
    write: async (presets) => writeCshFile(presets).bytes,
  });
}
