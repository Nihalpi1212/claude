// Photoshop styles (.asl): the container, names and groups (preset-files-manager); the effects are psd-layers'
// (S4.6: stylesFromPsd / stylesToPsd, the rule-12 split). Kinds `styles` and `patterns`: the patterns a style uses
// come with it as `patterns` presets, and the style names them through `$presetRef` (S10.5), so the stored style
// holds `{ presetId, name }` refs. Pure and Node-safe.
//
// The file: version 2, '8BSL', the patterns section (version 3, a u32 length, length-prefixed pattern records), the
// style count, then each style (a u32 length): a descriptor { 'Nm  ': name, Idnt: id } and a descriptor of class
// 'Styl' { documentMode, Lefx: <the layer effects, as a PSD layer's lfx2 holds them>, blendOptions? }, padded to 4.
// Blending options: Photoshop's "Include Layer Blending Options" keeps them in 'blendOptions'; the advanced options
// Pigment's style presets hold (knockout, blend interior and clipped layers as a group, transparency shapes the layer,
// the masks hide effects) are read from and written to it under the names Photoshop's scripting uses for them; a
// style's blend mode, opacity and fill opacity are not part of Pigment's style presets and are reported.
//
//   readAslFile(bytes, { name }) → { items, groups, report }       the format's read (S10.1)
//   writeAslFile(presets, { patternPixels }) → { bytes, report }   patternPixels(ref) → { width, height, data } | null
//   registerAslFormat(app) → unregister
import { Reader, Writer, tooLarge, asBytes, baseName } from './bytes.js';
import { T, writeDescriptor, rawObjcFromAgPsd, enumValue, unitValue } from './descriptor.js';
import { readPatternList, writePatternList, patternItem, patternRgba } from './pat.js';
import { createReader, createWriter, readVersionAndDescriptor, writeVersionAndDescriptor, parseEffects, serializeEffects } from '#ag-psd';
import { stylesFromPsd, stylesToPsd, effectsDescriptor } from '../psd/effects.js';
import { psdFeatures } from '../psd/registry.js';
import { registerPresetFileFormat } from '../preset-formats.js';
import { decodePng, toRgba8 } from '../../../shared/pixels/png.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// a pattern handed to stylesFromPsd under this name comes back in the style's PatternRef: it is turned into a
// $presetRef to the file's own pattern item (the ref's data URL is dropped: the store keeps { presetId, name })
const MARK = '\u0001asl-pattern:';
const stripLocalized = (s) => String(s ?? '').replace(/\0+$/, '').replace(/^\$\$\$\/[^=]*=/, '');

/** Replaces every PatternRef whose name carries MARK by a $presetRef (deep; a copy). */
function markedToRefs(v, seen) {
  if (Array.isArray(v)) return v.map((x) => markedToRefs(x, seen));
  if (!isObject(v)) return v;
  if (typeof v.name === 'string' && v.name.startsWith(MARK)) {
    const id = v.name.slice(MARK.length);
    seen.add(id);
    return { $presetRef: { kind: 'patterns', ref: `pattern:${id}` } };
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, markedToRefs(x, seen)]));
}

const BLEND_KEYS = [
  ['blendInterior', 'interiorAsGroup', false],
  ['blendClipping', 'clippedAsGroup', true],
  ['transparencyShapesLayer', 'transparencyShapes', true],
  ['layerMaskAsGlobalMask', 'maskHidesEffects', false],
  ['vectorMaskAsGlobalMask', 'vectorMaskHidesEffects', false],
];
const KNOCKOUT = { none: 'none', shallow: 'shallow', deep: 'deep', Shlw: 'shallow', Deep: 'deep', None: 'none' };

/** Pigment's style `blending` (advanced options only) from a 'blendOptions' descriptor, and the report lines. */
function blendingFrom(b, report, name) {
  if (!isObject(b)) return null;
  const out = {};
  for (const [key, field, def] of BLEND_KEYS) if (typeof b[key] === 'boolean' && b[key] !== def) out[field] = b[key];
  const k = KNOCKOUT[enumValue(b.knockout)] ?? null;
  if (k && k !== 'none') out.knockout = k;
  const mode = enumValue(b['Md  ']);
  const notDefault = (mode && mode !== 'Nrml') || unitValue(b.Opct, 100) !== 100 || unitValue(b.fillOpacity, 100) !== 100;
  if (notDefault) report.push(`"${name}": its blend mode, opacity and fill opacity are not part of Pigment's styles`);
  return Object.keys(out).length ? out : null;
}

function blendingNode(blending) {
  if (!isObject(blending)) return null;
  const items = {};
  for (const [key, field, def] of BLEND_KEYS) if (typeof blending[field] === 'boolean' && blending[field] !== def) items[key] = T.bool(blending[field]);
  if (blending.knockout === 'shallow' || blending.knockout === 'deep') items.knockout = T.enm('knockout', blending.knockout);
  return Object.keys(items).length ? T.obj('blendOptions', items) : null;
}

/** The .asl read: { items, groups, report }. The styles go into a group named after the file. Never throws. */
export async function readAslFile(input, { name = 'Styles.asl' } = {}) {
  const bytes = asBytes(input);
  const base = baseName(name, 'Styles');
  const items = [];
  const report = [];
  const big = tooLarge(bytes, base);
  if (big) return { items, groups: [], report: [big] };
  if (!psdFeatures().effects) report.push(`${base}: layer effects in styles are read once PSD layer effects are part of Pigment`);
  const patternInfos = new Map(); // id -> ag-psd PatternInfo, named with MARK
  const patternPixels = new Map(); // id -> decoded pattern
  const styles = [];
  try {
    const r = new Reader(bytes);
    const version = r.u16();
    if (r.sig() !== '8BSL') throw new Error('not a Photoshop styles (.asl) file');
    if (version !== 2) report.push(`${base}: version ${version} is read as version 2`);
    r.u16(); // the patterns section's version (3)
    const patLength = r.u32();
    const patEnd = Math.min(r.end, r.o + patLength);
    const pats = readPatternList(bytes, r.o, patEnd);
    for (const line of pats.report) report.push(`${base}: ${line}`);
    for (const p of pats.patterns) {
      if (!p.id || patternPixels.has(p.id)) continue;
      patternPixels.set(p.id, p);
      patternInfos.set(p.id, { name: `${MARK}${p.id}`, id: p.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) });
    }
    if (r.o + patLength > r.end) throw new RangeError('the file ends early');
    r.o += patLength;
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      if (r.left < 4) {
        report.push(`${base}: the file ends after ${i} of its ${count} styles`);
        break;
      }
      const length = r.u32();
      const start = r.o;
      const end = Math.min(r.end, start + length);
      try {
        const ag = createReader(bytes.buffer, bytes.byteOffset + start, end - start);
        const head = readVersionAndDescriptor(ag);
        const body = readVersionAndDescriptor(ag);
        styles.push({ name: stripLocalized(head?.['Nm  ']) || `Style ${i + 1}`, body });
      } catch (err) {
        report.push(`${base}: style ${i + 1} ${start + length > r.end ? 'is truncated' : `could not be read (${err?.message ?? err})`}`);
      }
      if (start + length > r.end) break;
      r.o = start + length;
      r.align4(0);
    }
  } catch (err) {
    report.push(`${base}: ${err instanceof RangeError ? 'the file is truncated' : err?.message ?? err}`);
  }
  const used = new Set();
  for (const s of styles) {
    const lefx = s.body?.Lefx ?? null;
    let fx = null;
    let lines = [];
    if (lefx) {
      try {
        const res = stylesFromPsd(parseEffects(lefx, false), { patterns: patternInfos, descriptor: lefx });
        fx = res.styles;
        lines = res.report;
      } catch (err) {
        lines = [`its effects could not be read (${err?.message ?? err})`];
      }
    }
    for (const l of lines) report.push(`${base}: "${s.name}": ${l}`);
    const blending = blendingFrom(s.body?.blendOptions, report, s.name);
    if (!fx && !blending && psdFeatures().effects) {
      report.push(`${base}: "${s.name}" has no effect Pigment reads`);
      continue;
    }
    const data = { styles: markedToRefs(fx ?? {}, used) };
    if (blending) data.blending = blending;
    items.push({ kind: 'styles', name: s.name, group: 'file', data });
  }
  // the patterns the styles use come in too (an unused pattern of the file is not imported: Photoshop keeps the
  // patterns of a style set with the styles)
  for (const id of used) {
    const p = patternPixels.get(id);
    if (p) items.unshift(await patternItem({ ...p, name: p.name || 'Pattern' }, `pattern:${id}`));
  }
  const hasStyles = items.some((it) => it.kind === 'styles');
  if (!hasStyles && !report.length) report.push(`${base}: the file holds no styles`);
  return { items, groups: hasStyles ? [{ kind: 'styles', id: 'file', name: base }] : [], report };
}

/** Every PatternRef ({ presetId } or { dataUrl }) in a style's data. */
function patternRefs(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => patternRefs(x, out));
  else if (isObject(v)) {
    if ((typeof v.presetId === 'string' || typeof v.dataUrl === 'string') && !('styles' in v)) out.push(v);
    else Object.values(v).forEach((x) => patternRefs(x, out));
  }
  return out;
}
const refKey = (ref) => (typeof ref === 'string' ? ref : ref?.presetId ? `id:${ref.presetId}` : ref?.dataUrl ? `url:${ref.dataUrl}` : null);

/** The pixels of a pattern given as a data URL (0.4's PatternRefs carry one): a PNG decoded in pure code. */
export async function dataUrlPixels(url) {
  const m = /^data:image\/png;base64,(.*)$/.exec(String(url ?? ''));
  if (!m) return null;
  const s = atob(m[1]);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return toRgba8(await decodePng(bytes));
}

/**
 * The .asl file of `styles` presets: { bytes, report }. patternPixels(ref) gives the pixels of a style's pattern
 * ({ presetId, name } or a data URL ref); a pattern without pixels leaves its effect out, reported.
 */
export async function writeAslFile(presets, { patternPixels = null } = {}) {
  const report = [];
  const patterns = new Map(); // id -> { name, id, width, height, data }
  const styles = [];
  for (const p of presets ?? []) {
    const name = String(p?.name ?? 'Style');
    const data = p?.data ?? {};
    const pixels = new Map();
    for (const ref of patternRefs(data.styles)) {
      const key = refKey(ref);
      if (!key || pixels.has(key)) continue;
      let px = null;
      try {
        px = (await patternPixels?.(ref)) ?? (ref.dataUrl ? await dataUrlPixels(ref.dataUrl) : null);
      } catch {
        px = null;
      }
      pixels.set(key, px);
    }
    let effects = null, extra = {}, used = [];
    try {
      const res = stylesToPsd(data.styles ?? {}, { resolvePattern: (ref) => pixels.get(refKey(ref)) ?? null });
      effects = res.effects;
      extra = res.extra;
      used = res.patterns;
      for (const l of res.report) report.push(`"${name}": ${l}`);
    } catch (err) {
      report.push(`"${name}": its effects could not be written (${err?.message ?? err})`);
    }
    for (const info of used ?? []) {
      if (!info?.id || patterns.has(info.id)) continue;
      patterns.set(info.id, { name: info.name ?? 'Pattern', id: info.id, width: info.bounds.w, height: info.bounds.h, data: info.data });
    }
    let lefx = null;
    try {
      const desc = effectsDescriptor(serializeEffects, effects ?? { scale: 1 }, extra, { typed: false });
      const w = createWriter(4096);
      writeVersionAndDescriptor(w, '', 'Lefx', desc);
      lefx = rawObjcFromAgPsd(new Uint8Array(w.buffer, 0, w.offset), 'Lefx');
    } catch (err) {
      report.push(`"${name}": its effects could not be written (${err?.message ?? err})`);
      continue;
    }
    if (!psdFeatures().effects) report.push(`"${name}": layer effects are written once PSD layer effects are part of Pigment`);
    styles.push({ name, lefx, blend: blendingNode(data.blending), id: styleId(name, styles.length) });
  }
  const o = new Writer();
  o.u16(2);
  o.sig('8BSL');
  o.u16(3);
  const patLen = o.lengthField();
  writePatternList(o, [...patterns.values()]);
  patLen();
  o.u32(styles.length);
  for (const s of styles) {
    const len = o.lengthField();
    const start = o.n;
    writeDescriptor(o, T.obj('null', { 'Nm  ': T.text(s.name), Idnt: T.text(s.id) }));
    writeDescriptor(o, T.obj('Styl', { documentMode: T.obj('documentMode', {}), ...(s.blend ? { blendOptions: s.blend } : {}), Lefx: s.lefx }));
    o.pad4(start);
    len();
  }
  return { bytes: o.done(), report };
}

function styleId(name, i) {
  let h = 0x811c9dc5;
  for (const c of `${name}|${i}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const hex = h.toString(16).padStart(8, '0');
  return `${hex}-${hex.slice(0, 4)}-4${hex.slice(5, 8)}-8${hex.slice(1, 4)}-${hex}${hex.slice(0, 4)}`;
}

/** The pixels of a style's pattern ref through the app's `patterns` presets (or the ref's own data URL). */
export function appPatternPixels(app, readBlob) {
  return async (ref) => {
    if (ref?.presetId) {
      await app?.presets?.ready?.('patterns');
      const preset = app?.presets?.get?.('patterns', ref.presetId);
      const px = preset ? await patternRgba(preset.data, (n) => readBlob('patterns', n)) : null;
      if (px) return px;
    }
    return ref?.dataUrl ? dataUrlPixels(ref.dataUrl) : null;
  };
}

/** Registers .asl (styles and their patterns) with the preset files of S10.1. Returns the unregister function. */
export function registerAslFormat(app) {
  return registerPresetFileFormat({
    id: 'asl',
    name: 'Photoshop Styles',
    extensions: ['asl'],
    kinds: ['styles', 'patterns'],
    read: (bytes, ctx = {}) => readAslFile(bytes, ctx),
    async write(selection, ctx) {
      const presets = (selection ?? []).filter((s) => s.kind === 'styles').flatMap((s) => s.presets ?? []);
      const { bytes, report } = await writeAslFile(presets, { patternPixels: appPatternPixels(app, ctx.readBlob) });
      if (report.length) app?.dialogs?.alert?.('Some styles were written without parts Photoshop files cannot hold', { title: 'Export Styles', detail: report.join('\n') });
      return bytes;
    },
  });
}
