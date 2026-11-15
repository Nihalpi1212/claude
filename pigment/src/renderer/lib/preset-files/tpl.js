// Photoshop tool presets (.tpl) for the `tool-presets` kind (preset-files-manager), with the brushes and patterns they
// use (kinds `brushes`, `patterns`). Pure and Node-safe. The brush of a painting preset is brush-settings-panel's
// half (S10.6): its descriptor is read with parseBrushDescriptor (#ag-psd) and mapped by brushFromAgPsd; written with
// lib/brush/abr.js's brushDescriptor when that file has it.
//
// The layout read and written here: '8BTP', version 1 and minor 2, then '8BIM' sections as in an .abr file of
// version 6.2: 'samp' (the sampled tips, length-prefixed records), 'patt' (patterns, length-prefixed) and 'desc' (a
// version-16 descriptor whose list holds the presets). Each preset is an object with 'Nm  ' (its name), 'Tool' (an
// object whose class is Photoshop's tool class, holding the tool options: 'Md  ' mode, 'Opct' opacity, 'flow', and for
// type tools a 'TxtS' text style), and 'Brsh' (the brush descriptor of a painting tool). Pigment adds 'pigmentData',
// its own options as JSON text, so its files keep every option Photoshop's keys do not name. The reader is lenient:
// any section order, any list of named objects in the descriptor, unknown keys skipped. The layout is not public: it
// follows the .abr structure this was checked against, not files Photoshop wrote (none could be used here).
//
//   readTplFile(bytes, { name }) → { items, groups, report }      the format's read (S10.1)
//   writeTplFile(presets, { readBlob, patternPixels }) → { bytes, report }
//   TOOL_CLASSES  Pigment tool id → Photoshop tool class
//   registerTplFormat(app) → unregister
import { Reader, Writer, tooLarge, asBytes, baseName } from './bytes.js';
import { T, writeDescriptor, enumValue, unitValue, colorFromDescriptor, rgbNode } from './descriptor.js';
import { readPatternList, writePatternList, patternItem, patternRgba, patternIdFor } from './pat.js';
import { createReader, readVersionAndDescriptor, parseBrushDescriptor } from '#ag-psd';
import * as abr from '../brush/abr.js';
import { normalizeBrush } from '../brush/preset.js';
import { rgbFromPsd } from '../psd/convert.js';
import { registerPresetFileFormat } from '../preset-formats.js';
import { decodePng, toRgba8 } from '../../../shared/pixels/png.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stripLocalized = (s) => String(s ?? '').replace(/\0+$/, '').replace(/^\$\$\$\/[^=]*=/, '');

/** Pigment's tool ids and Photoshop's tool classes (scripting names; the four-letter ids are read too). */
export const TOOL_CLASSES = Object.freeze({
  brush: 'paintbrushTool', pencil: 'pencilTool', eraser: 'eraserTool', 'color-replace': 'colorReplacementBrushTool',
  clone: 'cloneStampTool', 'pattern-stamp': 'patternStampTool', 'history-brush': 'historyBrushTool', heal: 'magicStampTool',
  'spot-heal': 'spotHealingBrushTool', patch: 'patchSelection', 'red-eye': 'redEyeTool', 'eraser-bg': 'backgroundEraserTool',
  'eraser-magic': 'magicEraserTool', blur: 'blurTool', sharpen: 'sharpenTool', smudge: 'smudgeTool', dodge: 'dodgeTool',
  burn: 'burnInTool', sponge: 'saturationTool', gradient: 'gradientTool', bucket: 'bucketTool', type: 'typeCreateOrEditTool',
  move: 'moveTool', crop: 'cropTool', 'perspective-crop': 'perspectiveCropTool', eyedropper: 'eyedropperTool',
  'color-sampler': 'colorSamplerTool', ruler: 'rulerTool', 'pen-tool': 'penTool', 'pen-free': 'freeformPenTool',
  'object-select': 'magicLassoTool', 'adjustment-brush': 'adjustmentBrushTool', hand: 'handTool', zoom: 'zoomTool',
});
const SHORT = { PbTl: 'brush', PcTl: 'pencil', ErTl: 'eraser', ClTl: 'clone', PaTl: 'pattern-stamp', HstB: 'history-brush', BlTl: 'blur', ShTl: 'sharpen', SmTl: 'smudge', DdTl: 'dodge', BrTl: 'burn', GrTl: 'gradient', BckT: 'bucket', TxtT: 'type', MvTl: 'move', CrpT: 'crop', EyDr: 'eyedropper' };
const FROM_CLASS = Object.fromEntries([...Object.entries(TOOL_CLASSES).map(([k, v]) => [v, k]), ...Object.entries(SHORT)]);
// Photoshop's text tools: the vertical and the mask tools are presets of the Type tool in Pigment
FROM_CLASS.typeVerticalCreateOrEditTool = 'type';
FROM_CLASS.typeCreateMaskTool = 'type';
FROM_CLASS.typeVerticalCreateMaskTool = 'type';

// BlnM codes of the paint modes (ag-psd's table)
const BLEND_CODES = {
  normal: 'Nrml', dissolve: 'Dslv', behind: 'Bhnd', clear: 'Clar', darken: 'Drkn', multiply: 'Mltp', 'color-burn': 'CBrn', 'linear-burn': 'linearBurn',
  'darker-color': 'darkerColor', lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg', 'linear-dodge': 'linearDodge', 'lighter-color': 'lighterColor',
  overlay: 'Ovrl', 'soft-light': 'SftL', 'hard-light': 'HrdL', 'vivid-light': 'vividLight', 'linear-light': 'linearLight', 'pin-light': 'pinLight',
  'hard-mix': 'hardMix', difference: 'Dfrn', exclusion: 'Xclu', subtract: 'blendSubtraction', divide: 'blendDivide', hue: 'H   ', saturation: 'Strt',
  color: 'Clr ', luminosity: 'Lmns',
};
const BLEND_FROM = Object.fromEntries(Object.entries(BLEND_CODES).map(([k, v]) => [v, k]));

// ---- sampled tips ('samp', as in .abr 6.2) ------------------------------------------------------------------------

function unpackPlane(r, w, h) {
  const counts = [];
  for (let y = 0; y < h; y++) counts.push(r.u16());
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const end = r.o + counts[y];
    let x = 0;
    while (r.o < end && x < w) {
      const n = r.u8();
      if (n < 128) {
        for (let k = 0; k <= n; k++) {
          const v = r.u8();
          if (x < w) out[y * w + x] = v;
          x++;
        }
      } else if (n > 128) {
        const v = r.u8();
        for (let k = 0; k < 257 - n && x < w; k++) out[y * w + x++] = v;
      }
    }
    r.o = end;
  }
  return out;
}

/** The 'samp' section: Map(sample id → { width, height, alpha }), and report lines. */
function readSamples(bytes, start, end, report) {
  const samples = new Map();
  const r = new Reader(bytes, start, end);
  while (r.left >= 4) {
    let length = r.u32();
    while (length & 3) length++;
    const next = r.o + length;
    try {
      const sub = new Reader(bytes, r.o, Math.min(next, end));
      const id = sub.pascal(1);
      // the record holds 264 bytes before the bounds in minor version 2, 10 in minor version 1
      const at = sub.o;
      let ok = false;
      for (const skip of [264, 10]) {
        sub.o = at + skip;
        if (sub.left < 19) continue;
        const top = sub.i32(), left = sub.i32(), bottom = sub.i32(), right = sub.i32();
        const depth = sub.i16();
        const compression = sub.u8();
        const w = right - left, h = bottom - top;
        if (!(w > 0 && h > 0 && w * h <= 64 * 1024 * 1024) || (depth !== 8 && depth !== 16) || compression > 1) continue;
        let alpha;
        if (compression === 1) {
          if (depth !== 8) throw new Error('16-bit compressed tips are not read');
          alpha = unpackPlane(sub, w, h);
        } else if (depth === 8) alpha = sub.take(w * h).slice();
        else {
          alpha = new Uint8Array(w * h);
          for (let i = 0; i < alpha.length; i++) alpha[i] = sub.u16() >> 8;
        }
        samples.set(id, { width: w, height: h, alpha });
        ok = true;
        break;
      }
      if (!ok) report.push('a brush tip could not be read');
    } catch (err) {
      report.push(err instanceof RangeError ? 'a brush tip is truncated' : `a brush tip could not be read (${err?.message ?? err})`);
    }
    if (next > end) break;
    r.o = next;
  }
  return samples;
}

function writeSample(o, s) {
  const len = o.lengthField();
  const start = o.n;
  o.pascal(s.id, 1);
  o.zeros(264);
  o.i32(0);
  o.i32(0);
  o.i32(s.height);
  o.i32(s.width);
  o.i16(8);
  o.u8(0);
  o.bytes(s.alpha);
  len();
  o.pad4(start - 4);
}

/** The coverage (0..255) of a tip PNG: luma times alpha (an 8-bit grey PNG reads as its grey). */
async function coverageOf(bytes) {
  const img = toRgba8(await decodePng(asBytes(bytes)));
  const alpha = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(((0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * d[i * 4 + 3]) / 255);
  return { width: img.width, height: img.height, alpha };
}

const uuidOf = (hash) => {
  const h = String(hash ?? '').replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase();
  return `$${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// ---- reading -------------------------------------------------------------------------------------------------------

/** The sections of the file: { samp, patt, desc } byte ranges, or null when the file has no '8BIM' sections. */
function sections(bytes, r, report) {
  const out = {};
  let found = false;
  while (r.left >= 12) {
    const at = r.o;
    if (r.sig() !== '8BIM') {
      r.o = at;
      break;
    }
    found = true;
    const type = r.sig();
    let size = r.u32();
    const start = r.o;
    const end = Math.min(r.end, start + size);
    if (start + size > r.end) report.push(`the ${type} section is truncated`);
    out[type] = { start, end };
    while (size % 4) size++;
    if (start + size >= r.end) break;
    r.o = start + size;
  }
  return found ? out : null;
}

/** Every version-16 descriptor the bytes hold, when the file has no sections (a lenient scan). */
function scanDescriptors(bytes, from) {
  const found = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = from; o + 16 < bytes.length && found.length < 64; o++) {
    if (dv.getUint32(o) !== 16) continue;
    try {
      const reader = createReader(bytes.buffer, bytes.byteOffset + o, bytes.length - o);
      const desc = readVersionAndDescriptor(reader, true);
      found.push(desc);
      o += Math.max(0, reader.offset - 1);
    } catch {
      // not a descriptor here
    }
  }
  return found;
}

/** The preset objects of a descriptor: the first list of objects that carry a name (Pigment's 'Prst' first). */
function presetList(desc) {
  if (!isObject(desc)) return [];
  if (Array.isArray(desc.Prst)) return desc.Prst.filter(isObject);
  for (const v of Object.values(desc)) if (Array.isArray(v) && v.some((x) => isObject(x) && 'Nm  ' in x)) return v.filter(isObject);
  return 'Nm  ' in desc && ('Tool' in desc || 'Brsh' in desc) ? [desc] : [];
}

function optionsFromTool(tool) {
  const out = {};
  if (!isObject(tool)) return out;
  if (typeof tool.Opct === 'number' || typeof tool.Opct?.value === 'number') out.opacity = Math.max(0, Math.min(1, unitValue(tool.Opct, 100) / 100));
  if (typeof tool.flow === 'number' || typeof tool.flow?.value === 'number') out.flow = Math.max(0, Math.min(1, unitValue(tool.flow, 100) / 100));
  const mode = BLEND_FROM[enumValue(tool['Md  '])];
  if (mode) out.blend = mode;
  if (typeof tool['Rpt '] === 'boolean') out.airbrush = tool['Rpt '];
  return out;
}

function typeFromTool(tool) {
  const s = isObject(tool?.TxtS) ? tool.TxtS : null;
  if (!s) return null;
  const char = {};
  if (typeof s.fontPostScriptName === 'string' && s.fontPostScriptName) char.postScriptName = s.fontPostScriptName;
  if (typeof s.FntN === 'string' && s.FntN) char.fontFamily = s.FntN;
  const size = unitValue(s['Sz  '], NaN);
  if (Number.isFinite(size) && size > 0) char.size = size;
  if (Number.isFinite(s.Trck)) char.tracking = s.Trck;
  const c = colorFromDescriptor(s['Clr ']);
  if (c) char.color = rgbFromPsd(c, '#000000');
  return Object.keys(char).length ? { char, para: {} } : null;
}

/** The .tpl read: { items, groups, report }. The tool presets go into a group named after the file. Never throws. */
export async function readTplFile(input, { name = 'Tool Presets.tpl' } = {}) {
  const bytes = asBytes(input);
  const base = baseName(name, 'Tool Presets');
  const items = [];
  const report = [];
  const big = tooLarge(bytes, base);
  if (big) return { items, groups: [], report: [big] };
  const lines = [];
  let samples = new Map();
  let patterns = [];
  let descs = [];
  try {
    const r = new Reader(bytes);
    const sig = r.sig();
    if (sig !== '8BTP') throw new Error('not a Photoshop tool presets (.tpl) file');
    r.u16();
    r.u16();
    const found = sections(bytes, r, lines);
    if (found) {
      if (found.samp) samples = readSamples(bytes, found.samp.start, found.samp.end, lines);
      if (found.patt) {
        const res = readPatternList(bytes, found.patt.start, found.patt.end);
        patterns = res.patterns;
        lines.push(...res.report);
      }
      if (found.desc) {
        try {
          descs = [readVersionAndDescriptor(createReader(bytes.buffer, bytes.byteOffset + found.desc.start, found.desc.end - found.desc.start), true)];
        } catch (err) {
          lines.push(`the presets could not be read (${err?.message ?? err})`);
        }
      }
    } else descs = scanDescriptors(bytes, 8);
  } catch (err) {
    lines.push(err instanceof RangeError ? 'the file is truncated' : String(err?.message ?? err));
  }
  // the patterns textured brushes use come in as `patterns` presets, named by $presetRef
  const patternRefs = new Map();
  for (const [i, p] of patterns.entries()) {
    const ref = `pattern-${i}`;
    try {
      items.push(await patternItem(p, ref));
      if (p.id) patternRefs.set(p.id, ref);
    } catch (err) {
      lines.push(`the pattern "${p?.name ?? '?'}" could not be stored (${err?.message ?? err})`);
    }
  }
  let count = 0;
  for (const desc of descs) {
    for (const entry of presetList(desc)) {
      const label = stripLocalized(entry['Nm  ']) || `Tool Preset ${count + 1}`;
      let pigment = null;
      if (typeof entry.pigmentData === 'string') {
        try {
          pigment = JSON.parse(entry.pigmentData);
        } catch {
          pigment = null;
        }
      }
      const toolObj = isObject(entry.Tool) ? entry.Tool : null;
      const toolClass = toolObj?._classID ?? enumValue(entry.Tool);
      const tool = typeof pigment?.tool === 'string' ? pigment.tool : FROM_CLASS[toolClass] ?? null;
      if (!tool) {
        lines.push(`"${label}" is a preset of a tool Pigment does not have (${toolClass ?? 'unknown'})`);
        continue;
      }
      const data = { tool, options: isObject(pigment?.options) ? pigment.options : optionsFromTool(toolObj) };
      const type = isObject(pigment?.type) ? pigment.type : typeFromTool(toolObj);
      if (type) data.type = type;
      if (typeof pigment?.color === 'string') data.color = pigment.color;
      const item = { kind: 'tool-presets', name: label, group: 'file', data };
      if (isObject(entry.Brsh)) {
        try {
          const raw = entry.Brsh;
          const parsed = { ...parseBrushDescriptor(raw), buildUp: raw['Rpt '] === true, smoothCurves: raw.Smoo === true };
          const res = abr.brushFromAgPsd(parsed, samples, { patternRef: (id) => (patternRefs.has(id) ? { $presetRef: { kind: 'patterns', ref: patternRefs.get(id) } } : null) });
          data.brush = res.preset;
          if (Object.keys(res.blobs ?? {}).length) item.blobs = res.blobs;
          for (const l of res.report ?? []) lines.push(`"${label}": ${l}`);
        } catch (err) {
          lines.push(`"${label}": its brush could not be read (${err?.message ?? err})`);
        }
      }
      items.push(item);
      count++;
    }
  }
  for (const l of lines) report.push(`${base}: ${l}`);
  if (!count && !report.length) report.push(`${base}: the file holds no tool presets`);
  return { items, groups: count ? [{ kind: 'tool-presets', id: 'file', name: base }] : [], report };
}

// ---- writing -------------------------------------------------------------------------------------------------------

/** The typed brush descriptor of a preset: brush-settings-panel's when it has landed, else the tip alone. */
function brushNode(preset, ids) {
  if (typeof abr.brushDescriptor === 'function') return abr.brushDescriptor(preset, ids);
  const p = normalizeBrush(preset);
  return T.obj('brushPreset', {
    'Nm  ': T.text(ids.name),
    Brsh: T.obj('computedBrush', { Dmtr: T.px(p.tip.size), Hrdn: T.pct(p.tip.hardness), Angl: T.ang(p.tip.angle), Rndn: T.pct(p.tip.roundness), Spcn: T.pct(p.tip.spacing), Intr: T.bool(p.tip.spacingOn !== false), flipX: T.bool(p.tip.flipX), flipY: T.bool(p.tip.flipY) }),
    Spcn: T.pct(p.tip.spacing),
    useBrushSize: T.bool(true),
  });
}

function toolNode(data) {
  const o = data.options ?? {};
  const items = {};
  if (Number.isFinite(o.opacity)) items.Opct = T.long(o.opacity * 100);
  if (Number.isFinite(o.flow)) items.flow = T.long(o.flow * 100);
  if (typeof o.blend === 'string' && BLEND_CODES[o.blend]) items['Md  '] = T.enm('BlnM', BLEND_CODES[o.blend]);
  if (typeof o.airbrush === 'boolean') items['Rpt '] = T.bool(o.airbrush);
  const c = data.type?.char;
  if (c) {
    const s = {};
    if (c.postScriptName) s.fontPostScriptName = T.text(c.postScriptName);
    if (c.fontFamily) s.FntN = T.text(c.fontFamily);
    if (Number.isFinite(c.size)) s['Sz  '] = T.pnt(c.size);
    if (Number.isFinite(c.tracking)) s.Trck = T.long(c.tracking);
    if (typeof c.color === 'string') s['Clr '] = rgbNode(c.color);
    if (Object.keys(s).length) items.TxtS = T.obj('TxtS', s);
  }
  return T.obj(TOOL_CLASSES[data.tool] ?? data.tool, items);
}

/**
 * The .tpl file of `tool-presets` presets: { bytes, report }. readBlob(kind, name) reads the brush tips (`brushes`);
 * patternPixels(presetId) → { name, width, height, data } | null gives a textured brush's pattern.
 */
export async function writeTplFile(presets, { readBlob = null, patternPixels = null } = {}) {
  const report = [];
  const samples = new Map(); // blob -> { id, width, height, alpha }
  const patterns = new Map(); // presetId -> { id, name, width, height, data }
  const entries = [];
  for (const p of presets ?? []) {
    const name = String(p?.name ?? 'Tool Preset');
    const data = p?.data;
    if (!isObject(data) || typeof data.tool !== 'string') {
      report.push(`"${name}" is not a tool preset and was left out`);
      continue;
    }
    const items = { 'Nm  ': T.text(name), Tool: toolNode(data) };
    if (isObject(data.brush)) {
      const brush = normalizeBrush(data.brush);
      const ids = { name, tip: null, dual: null, pattern: null };
      for (const [key, tip] of [['tip', brush.tip], ['dual', brush.dualBrush.enabled ? brush.dualBrush.tip : null]]) {
        if (!tip || tip.kind !== 'sampled' || !tip.sample?.blob) continue;
        let s = samples.get(tip.sample.blob);
        if (!s) {
          try {
            const bytes = await readBlob?.('brushes', tip.sample.blob);
            if (bytes?.length) {
              s = { id: uuidOf(tip.sample.hash || tip.sample.blob), ...(await coverageOf(bytes)) };
              samples.set(tip.sample.blob, s);
            }
          } catch {
            s = null;
          }
        }
        if (s) ids[key] = s.id;
        else report.push(`"${name}": ${key === 'tip' ? 'its' : 'its dual brush'} tip image is missing; written as a round tip`);
      }
      if (brush.texture.enabled) {
        const pid = brush.texture.pattern?.presetId ?? null;
        let pat = pid ? patterns.get(pid) : null;
        if (!pat && pid && patternPixels) {
          try {
            const px = await patternPixels(pid);
            if (px?.data) {
              pat = { id: patternIdFor(px.data, px.width, px.height), name: px.name ?? brush.texture.pattern?.name ?? 'Pattern', width: px.width, height: px.height, data: px.data };
              patterns.set(pid, pat);
            }
          } catch {
            pat = null;
          }
        }
        if (pat) ids.pattern = { id: pat.id, name: pat.name };
        else report.push(`"${name}": its texture's pattern is missing; written without the texture`);
      }
      items.Brsh = brushNode(brush, ids);
    }
    const own = { tool: data.tool, options: data.options ?? {} };
    if (isObject(data.type)) own.type = data.type;
    if (typeof data.color === 'string') own.color = data.color;
    items.pigmentData = T.text(JSON.stringify(own));
    entries.push(T.obj('toolPreset', items));
  }
  const o = new Writer();
  o.sig('8BTP');
  o.u16(1);
  o.u16(2);
  const section = (type, body) => {
    o.sig('8BIM');
    o.sig(type);
    const len = o.lengthField();
    const start = o.n;
    body();
    len();
    o.pad4(start);
  };
  if (samples.size) section('samp', () => samples.forEach((s) => writeSample(o, s)));
  if (patterns.size) section('patt', () => writePatternList(o, [...patterns.values()]));
  section('desc', () => writeDescriptor(o, T.obj('null', { Prst: T.list(entries) })));
  return { bytes: o.done(), report };
}

/** The pixels of a `patterns` preset for writers: { name, width, height, data } or null. */
export function appPresetPixels(app, readBlob) {
  return async (presetId) => {
    await app?.presets?.ready?.('patterns');
    const p = app?.presets?.get?.('patterns', presetId);
    const px = p ? await patternRgba(p.data, (n) => readBlob('patterns', n)) : null;
    return px ? { name: p.name, ...px } : null;
  };
}

/** Registers .tpl (tool presets, their brushes and patterns) with the preset files of S10.1. */
export function registerTplFormat(app) {
  return registerPresetFileFormat({
    id: 'tpl',
    name: 'Photoshop Tool Presets',
    extensions: ['tpl'],
    kinds: ['tool-presets', 'brushes', 'patterns'],
    read: (bytes, ctx = {}) => readTplFile(bytes, ctx),
    async write(selection, ctx) {
      const presets = (selection ?? []).filter((s) => s.kind === 'tool-presets').flatMap((s) => s.presets ?? []);
      const { bytes, report } = await writeTplFile(presets, { readBlob: ctx.readBlob, patternPixels: appPresetPixels(app, ctx.readBlob) });
      if (report.length) app?.dialogs?.alert?.('Some tool presets were written without parts Photoshop files cannot hold', { title: 'Export Tool Presets', detail: report.join('\n') });
      return bytes;
    },
  });
}
