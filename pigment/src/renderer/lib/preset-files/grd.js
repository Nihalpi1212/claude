// Photoshop gradients (.grd, version 5: Photoshop 6 and later) for the `gradients` kind (preset-files-manager).
// Pure and Node-safe.
//
// The file is '8BGR', version 5 and one descriptor: { GrdL: [ { Grad: <gradient> } ] }. A solid gradient holds its
// name, smoothness ('Intr', 0..4096), colour stops (colour or Foreground / Background, location 0..4096, midpoint
// 0..100) and transparency stops; a noise gradient its roughness, colour model, seed, limits and options. Photoshop
// stores a stop's midpoint on the segment that ends at the stop, as Pigment's GradientDef does (G.1), so they map one
// to one. Colours other than RGB (HSB, CMYK, Lab, Grayscale) are converted to RGB as PSD gradients are (convert.js).
//
// The interpolation method (Classic, Perceptual, Linear, Smooth) belongs to the tool or effect in Photoshop, not to
// the gradient: a file read here is Classic, the method gradients in Photoshop files were made with, unless the file
// holds Photoshop's own 'gradientsInterpolationMethod' key, which Pigment writes so its own files keep the method.
//
//   readGrdFile(bytes, { name }) → { presets, groups, report }    the store read (S10.1)
//   writeGrdFile(presets) → { bytes, report }
//   gradientFromDescriptor(grad, { report }) → GradientDef | null   gradientNode(def, name) → a typed 'Grdn' node
//   registerGrdFormat()
import { Reader, Writer, tooLarge, asBytes, baseName } from './bytes.js';
import { T, writeDescriptor, enumValue, unitValue, colorFromDescriptor, rgbNode } from './descriptor.js';
import { createReader, readVersionAndDescriptor } from '#ag-psd';
import { normalizeGradient } from '../../../shared/pixels/gradient-model.js';
import { rgbFromPsd } from '../psd/convert.js';
import { registerPresetFormat } from '../presets.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const METHOD_CODES = { perceptual: 'Perc', linear: 'Lnr ', classic: 'Gcls', smooth: 'Smoo' };
const METHODS = Object.fromEntries(Object.entries(METHOD_CODES).map(([k, v]) => [v, k]));
const MODELS = { RGBC: 'rgb', HSBl: 'hsb', LbCl: 'lab', HSLC: 'hsb' };
const MODEL_CODES = { rgb: 'RGBC', hsb: 'HSBl', lab: 'LbCl' };

/** A GradientDef (G.1) for a gradient descriptor as ag-psd's reader gives it, or null. */
export function gradientFromDescriptor(g, { report = null } = {}) {
  if (!g || typeof g !== 'object') return null;
  const form = enumValue(g.GrdF);
  const method = METHODS[enumValue(g.gradientsInterpolationMethod)] ?? 'classic';
  if (form === 'ClNs') {
    if (enumValue(g.ClrS) === 'HSLC') report?.('a noise gradient in HSL (read as HSB)');
    const four = (v, d) => (Array.isArray(v) ? v.map((x) => clamp01(num(x, d * 100) / 100)) : [d, d, d, d]);
    const min = four(g['Mnm '], 0), max = four(g['Mxm '], 1);
    return normalizeGradient({
      gradientVersion: 2,
      type: 'noise',
      interpolation: 'classic',
      smoothness: 1,
      noise: { roughness: clamp01(num(g.Smth, 2048) / 4096), model: MODELS[enumValue(g.ClrS)] ?? 'rgb', min: min.slice(0, 3), max: max.slice(0, 3), restrict: !!g.VctC, transparency: !!g.ShTr, seed: Math.trunc(num(g.RndS, 1)) },
    });
  }
  const colors = Array.isArray(g.Clrs) ? g.Clrs : [];
  const alphas = Array.isArray(g.Trns) ? g.Trns : [];
  if (!colors.length) return null;
  const pos = (s) => clamp01(num(s?.Lctn, 0) / 4096);
  const mid = (s) => Math.max(0.05, Math.min(0.95, num(s?.Mdpn, 50) / 100));
  let converted = false;
  const stops = colors.map((s) => {
    const type = enumValue(s?.Type);
    if (type === 'FrgC') return { pos: pos(s), mid: mid(s), color: { ref: 'fg' } };
    if (type === 'BckC') return { pos: pos(s), mid: mid(s), color: { ref: 'bg' } };
    const c = colorFromDescriptor(s?.['Clr ']);
    if (c && !('r' in c) && !('fr' in c)) converted = true;
    const hex = c && 'fr' in c ? rgbFromPsd({ r: c.fr * 255, g: c.fg * 255, b: c.fb * 255 }) : rgbFromPsd(c, '#000000');
    return { pos: pos(s), mid: mid(s), color: hex };
  });
  if (converted) report?.('colours in HSB, CMYK, Lab or Grayscale (converted to RGB)');
  const opacityStops = alphas.length
    ? alphas.map((s) => ({ pos: pos(s), mid: mid(s), opacity: clamp01(unitValue(s?.Opct, 100) / 100) }))
    : [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }];
  return normalizeGradient({ gradientVersion: 2, type: 'solid', interpolation: method, smoothness: clamp01(num(g.Intr, 4096) / 4096), stops, opacityStops }, { keepRefs: true });
}

/** The typed 'Grdn' node of a gradient (a GradientDef or any 0.3 shape normalizeGradient reads). */
export function gradientNode(def0, name = 'Gradient', report = null) {
  const def = normalizeGradient(def0 ?? null, { keepRefs: true });
  if (def.type === 'noise' && def.noise) {
    const n = def.noise;
    const four = (v, t) => T.list([...v.slice(0, 3), t].map((x) => T.long(Math.round(clamp01(x) * 100))));
    return T.obj('Grdn', {
      'Nm  ': T.text(name),
      GrdF: T.enm('GrdF', 'ClNs'),
      ShTr: T.bool(n.transparency),
      VctC: T.bool(n.restrict),
      ClrS: T.enm('ClrS', MODEL_CODES[n.model] ?? 'RGBC'),
      RndS: T.long(n.seed),
      Smth: T.long(Math.round(clamp01(n.roughness) * 4096)),
      'Mnm ': four(n.min, 0),
      'Mxm ': four(n.max, 1),
    });
  }
  let method = def.interpolation;
  if (!METHOD_CODES[method]) {
    if (method === 'stripes') report?.(`"${name}": the Stripes method is written as Classic`);
    method = 'classic';
  }
  const loc = (p) => T.long(Math.round(clamp01(p) * 4096));
  const midNode = (m) => T.long(Math.round(Math.max(0.05, Math.min(0.95, num(m, 0.5))) * 100));
  return T.obj('Grdn', {
    'Nm  ': T.text(name),
    GrdF: T.enm('GrdF', 'CstS'),
    Intr: T.doub(Math.round(clamp01(def.smoothness) * 4096)),
    Clrs: T.list(def.stops.map((s) => T.obj('Clrt', {
      'Clr ': rgbNode(typeof s.color === 'string' ? s.color : s.color?.ref === 'bg' ? '#ffffff' : '#000000'),
      Type: T.enm('Clry', s.color?.ref === 'fg' ? 'FrgC' : s.color?.ref === 'bg' ? 'BckC' : 'UsrS'),
      Lctn: loc(s.pos),
      Mdpn: midNode(s.mid),
    }))),
    Trns: T.list(def.opacityStops.map((s) => T.obj('TrnS', { Opct: T.pct(clamp01(s.opacity)), Lctn: loc(s.pos), Mdpn: midNode(s.mid) }))),
    gradientsInterpolationMethod: T.enm('gradientInterpolationMethodType', METHOD_CODES[method]),
  });
}

/** The .grd store read: { presets, groups, report }; the gradients go into a group named after the file. */
export async function readGrdFile(input, { name = 'Gradients.grd' } = {}) {
  const bytes = asBytes(input);
  const base = baseName(name, 'Gradients');
  const out = { presets: [], groups: [], report: [] };
  const big = tooLarge(bytes, base);
  if (big) {
    out.report.push(big);
    return out;
  }
  const notes = new Map();
  const note = (what) => notes.set(what, (notes.get(what) ?? 0) + 1);
  try {
    const r = new Reader(bytes);
    if (r.sig() !== '8BGR') throw new Error('not a Photoshop gradients (.grd) file');
    const version = r.u16();
    if (version === 3) throw new Error('gradient files of Photoshop 5 (version 3) are not read: save them again from a later Photoshop');
    if (version !== 5) throw new Error(`version ${version} is not one Pigment reads`);
    const desc = readVersionAndDescriptor(createReader(bytes.buffer, bytes.byteOffset + r.o, bytes.length - r.o));
    const list = Array.isArray(desc?.GrdL) ? desc.GrdL : [];
    list.forEach((entry, i) => {
      const g = entry?.Grad ?? entry;
      const def = gradientFromDescriptor(g, { report: note });
      if (!def) {
        out.report.push(`${base}: gradient ${i + 1} could not be read`);
        return;
      }
      const label = String(g?.['Nm  '] ?? '').replace(/^\$\$\$\/[^=]*=/, '') || `Gradient ${i + 1}`;
      out.presets.push({ name: label, group: 'file', data: def });
    });
  } catch (err) {
    out.report.push(`${base}: ${err instanceof RangeError || /exceeding|offset|bounds/i.test(String(err?.message)) ? 'the file is truncated or damaged' : err?.message ?? err}`);
  }
  for (const [what, n] of notes) out.report.push(`${base}: ${n} ${n === 1 ? 'gradient has' : 'gradients have'} ${what}`);
  if (out.presets.length) out.groups.push({ id: 'file', name: base });
  else if (!out.report.length) out.report.push(`${base}: the file holds no gradients`);
  return out;
}

/** The .grd file of `gradients` presets: { bytes, report }. */
export function writeGrdFile(presets) {
  const report = [];
  const items = [];
  for (const p of presets ?? []) {
    try {
      items.push(T.obj('Grdn', { Grad: gradientNode(p?.data, String(p?.name ?? 'Gradient'), (l) => report.push(l)) }));
    } catch {
      report.push(`"${p?.name ?? '?'}" could not be written`);
    }
  }
  const w = new Writer();
  w.sig('8BGR');
  w.u16(5);
  writeDescriptor(w, T.obj('null', { GrdL: T.list(items) }));
  return { bytes: w.done(), report };
}

/** Registers .grd for the `gradients` kind (S10.1: the Gradients panel imports it with no edit). */
export function registerGrdFormat() {
  registerPresetFormat('gradients', {
    id: 'grd',
    name: 'Photoshop Gradients',
    extensions: ['grd'],
    read: (bytes, info = {}) => readGrdFile(bytes, info),
    write: async (presets) => writeGrdFile(presets).bytes,
  });
}


