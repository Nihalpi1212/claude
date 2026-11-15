// .abr brushes (ARCHITECTURE.md "0.5 features", S10.6; brush-settings-panel): Photoshop brush files to and from
// BrushPresets, and the .abr preset file format (kinds `brushes` and `patterns`: a textured brush brings its pattern).
//
//   brushFromAgPsd(brush, samples, { patternRef }) → { preset, blobs, report }   ag-psd's Brush (readAbr's shape, also
//       what parseBrushDescriptor gives for a .tpl tool preset's brush) to a BrushPreset: every section Photoshop
//       stores is mapped (tip, Shape Dynamics, Scattering, Texture, Dual Brush, Color Dynamics, Transfer, Brush Pose,
//       Noise, Wet Edges, Protect Texture, the captured tool settings); what Pigment cannot paint is reported. Pure and
//       synchronous (preset-files-manager's .tpl calls it): a sampled tip's coverage becomes an 8-bit grey PNG written
//       with stored deflate blocks, named by its SHA-1, so the same tip always gives the same blob.
//   readAbrFile(bytes, { name }) → { items, groups, report }   the format's read (S10.1): versions 1 and 2 (Photoshop 7
//       and older: computed and sampled tips) and 6 to 10 (sections samp, desc, patt; phry and unknown sections are
//       skipped). Each brush is read on its own, so one Pigment cannot read is reported and the rest come in. The
//       brushes go into one group named after the file, as Photoshop does; patterns become `patterns` presets and a
//       textured brush names its pattern with a $presetRef.
//   writeAbrFile(presets, { readBlob, patternPixels }) → Uint8Array   version 6.2 with samp, patt and desc: computed and
//       sampled tips (the dual brush's too) and every section; build-up and the Smoothing box as 'Rpt ' and 'Smoo'.
//   brushDescriptor(preset, ids) → the typed descriptor tree writeAbrFile writes (for tests).
//   registerAbrFormat(app) → unregister   registers 'abr' with registerPresetFileFormat (install of the panel).
//
// The descriptor keys and units are those ag-psd reads (node_modules/ag-psd/dist/abr.js, MIT); the descriptor is
// written by this file's own small typed writer rather than ag-psd's, which picks value types by key and does not
// know the brush keys. Reading goes through ag-psd's descriptor reader, parseBrushDescriptor and readPattern (#ag-psd).
import { brushFromLegacy, normalizeBrush, DEFAULT_BRUSH } from './preset.js';
import { createReader, createWriter, readVersionAndDescriptor, parseBrushDescriptor, readPattern, writePattern } from '#ag-psd';
import { decodePng, toRgba8, encodeRgba8 } from '../../../shared/pixels/png.js';
import { registerPresetFileFormat } from '../preset-formats.js';

export const ABR_REAL = true;

const num = (v) => (Number.isFinite(v) ? v : undefined);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// percentages arrive as value / 100: four decimals keep 12 % as 0.12, not 0.12000000000000001
const frac = (v, def = 0) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- ag-psd's names to Pigment's --------------------------------------------------------------------------------

const CONTROL = { off: 'off', fade: 'fade', 'pen pressure': 'pen-pressure', 'pen tilt': 'pen-tilt', 'stylus wheel': 'stylus-wheel', rotation: 'rotation', 'initial direction': 'initial-direction', direction: 'direction', 'initial rotation': 'initial-rotation' };
// the ABR control numbers (bVTy), in ag-psd's order
const CONTROL_CODES = ['off', 'fade', 'pen-pressure', 'pen-tilt', 'stylus-wheel', 'initial-direction', 'direction', 'initial-rotation', 'rotation'];

// BlnM codes: the modes texture, dual brush and tool options use (ag-psd's table)
const BLEND_CODES = {
  normal: 'Nrml', dissolve: 'Dslv', darken: 'Drkn', multiply: 'Mltp', 'color-burn': 'CBrn', 'linear-burn': 'linearBurn', 'darker-color': 'darkerColor',
  lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg', 'linear-dodge': 'linearDodge', 'lighter-color': 'lighterColor', overlay: 'Ovrl',
  'soft-light': 'SftL', 'hard-light': 'HrdL', 'vivid-light': 'vividLight', 'linear-light': 'linearLight', 'pin-light': 'pinLight', 'hard-mix': 'hardMix',
  difference: 'Dfrn', exclusion: 'Xclu', subtract: 'blendSubtraction', divide: 'blendDivide', hue: 'H   ', saturation: 'Strt', color: 'Clr ', luminosity: 'Lmns',
  'linear-height': 'linearHeight', height: 'Hght',
};
const TEXTURE_CODE = { ...BLEND_CODES, subtract: 'Sbtr' };
// ag-psd's decoded names ('color burn') to Pigment's ids ('color-burn')
const kebab = (name) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
const TEXTURE_FROM = { subtraction: 'subtract' };

function control(d) {
  return { type: CONTROL[d?.control] ?? 'off', fadeSteps: Number.isFinite(d?.steps) ? clamp(Math.round(d.steps), 1, 9999) : 25 };
}

function tipFrom(shape, name, samples, blobs, report, what) {
  const tip = {
    kind: 'computed',
    size: num(shape?.size),
    hardness: shape?.type === 'computed' ? frac(shape.hardness, 1) : 1,
    angle: num(shape?.angle),
    roundness: Number.isFinite(shape?.roundness) ? frac(shape.roundness) : undefined,
    spacing: Number.isFinite(shape?.spacing) ? frac(shape.spacing) : undefined,
    flipX: !!shape?.flipX,
    flipY: !!shape?.flipY,
    spacingOn: shape?.spacingOn !== false,
  };
  for (const k of Object.keys(tip)) if (tip[k] === undefined) delete tip[k];
  if (shape?.type === 'sampled') {
    const sample = samples?.get?.(shape.sampledData) ?? null;
    if (sample?.alpha && sample.width > 0 && sample.height > 0 && sample.alpha.length >= sample.width * sample.height) {
      const png = greyPng(sample.width, sample.height, sample.alpha);
      const hash = sha1Hex(png);
      const blob = `tip-${hash}.png`;
      blobs[blob] = png;
      tip.kind = 'sampled';
      tip.sample = { blob, hash, width: sample.width, height: sample.height };
    } else report.push(`"${name}": ${what} sampled tip is missing from the file; a round tip is used`);
  } else if (shape?.type && shape.type !== 'computed') {
    // erodible, airbrush and bristle tips (0.10): kept as data, painted as a round tip until then
    report.push(`"${name}": ${what} ${shape.type === 'tips' ? 'erodible or airbrush' : 'bristle'} tip paints as a round tip in Pigment`);
    tip.extras = { abr: JSON.parse(JSON.stringify(shape)) };
  }
  return tip;
}

/**
 * ag-psd's Brush and its samples (id → { width, height, alpha }) to a BrushPreset, its tip blobs and a report. A
 * texture's pattern is whatever patternRef(id, name) returns (the .abr reader gives a $presetRef to the file's own
 * pattern); without one the texture uses the current pattern, reported. Never throws.
 */
export function brushFromAgPsd(brush, samples = new Map(), { patternRef = null } = {}) {
  const report = [];
  const blobs = {};
  const name = typeof brush?.name === 'string' && brush.name ? brush.name : 'Brush';
  try {
    const b = isObject(brush) ? brush : {};
    const shape = isObject(b.shape) ? b.shape : {};
    const out = { tip: tipFrom(shape, name, samples, blobs, report, 'its') };
    const sd = b.shapeDynamics;
    if (sd) {
      out.shapeDynamics = {
        enabled: true,
        sizeJitter: frac(sd.sizeDynamics?.jitter), sizeControl: control(sd.sizeDynamics), minimumDiameter: frac(sd.minimumDiameter ?? sd.sizeDynamics?.minimum),
        tiltScale: frac(sd.tiltScale), angleJitter: frac(sd.angleDynamics?.jitter), angleControl: control(sd.angleDynamics),
        roundnessJitter: frac(sd.roundnessDynamics?.jitter), roundnessControl: control(sd.roundnessDynamics), minimumRoundness: frac(sd.minimumRoundness ?? sd.roundnessDynamics?.minimum, 0.25),
        flipXJitter: !!sd.flipX, flipYJitter: !!sd.flipY, brushProjection: !!sd.brushProjection,
      };
    }
    const sc = b.scatter;
    if (sc) {
      out.scattering = {
        enabled: true, scatter: frac(sc.scatterDynamics?.jitter), bothAxes: !!sc.bothAxes, scatterControl: control(sc.scatterDynamics),
        count: Number.isFinite(sc.count) ? sc.count : 1, countJitter: frac(sc.countDynamics?.jitter), countControl: control(sc.countDynamics),
      };
    }
    const tx = b.texture;
    if (tx) {
      const mode = TEXTURE_FROM[kebab(tx.blendMode)] ?? kebab(tx.blendMode);
      out.texture = {
        enabled: true, invert: !!tx.invert, scale: frac(tx.scale, 1), brightness: num(tx.brightness) ?? 0, contrast: num(tx.contrast) ?? 0,
        eachTip: !!tx.textureEachTip, mode: DEFAULT_BRUSH.texture.mode, depth: frac(tx.depth, 1), minimumDepth: frac(tx.depthMinimum),
        depthJitter: frac(tx.depthDynamics?.jitter), depthControl: control(tx.depthDynamics),
      };
      if (TEXTURE_CODE[mode] && ['multiply', 'subtract', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height', 'height'].includes(mode)) out.texture.mode = mode;
      else report.push(`"${name}": its texture mode ${tx.blendMode} is read as Multiply`);
    }
    const db = b.dualBrush;
    if (db) {
      const mode = kebab(db.blendMode);
      const dtip = tipFrom(db.shape, name, samples, blobs, report, 'its dual brush');
      if (Number.isFinite(db.spacing)) dtip.spacing = frac(db.spacing);
      out.dualBrush = {
        enabled: true, mode: ['multiply', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height'].includes(mode) ? mode : 'color-burn',
        flip: !!db.flip, tip: dtip, scatter: db.useScatter === false ? 0 : frac(db.scatterDynamics?.jitter), bothAxes: !!db.bothAxes,
        count: Number.isFinite(db.count) ? db.count : 1, countJitter: frac(db.countDynamics?.jitter),
      };
    }
    const cd = b.colorDynamics;
    if (cd) {
      out.colorDynamics = {
        enabled: true, perTip: cd.perTip !== false, fbJitter: frac(cd.foregroundBackground?.jitter), fbControl: control(cd.foregroundBackground),
        hueJitter: frac(cd.hue), saturationJitter: frac(cd.saturation), brightnessJitter: frac(cd.brightness), purity: frac(cd.purity),
      };
    }
    const tr = b.transfer;
    if (tr) {
      out.transfer = {
        enabled: true,
        opacityJitter: frac(tr.opacityDynamics?.jitter), opacityControl: control(tr.opacityDynamics), minimumOpacity: frac(tr.opacityDynamics?.minimum),
        flowJitter: frac(tr.flowDynamics?.jitter), flowControl: control(tr.flowDynamics), minimumFlow: frac(tr.flowDynamics?.minimum),
        wetnessJitter: frac(tr.wetnessDynamics?.jitter), wetnessControl: control(tr.wetnessDynamics), mixJitter: frac(tr.mixDynamics?.jitter), mixControl: control(tr.mixDynamics),
      };
    }
    const bp = b.brushPose;
    if (bp) {
      const tilt = (v) => {
        const n = Number(v) || 0;
        return frac(clamp(Math.abs(n) > 1 ? n / 100 : n, -1, 1));
      };
      out.brushPose = {
        enabled: true, tiltX: tilt(bp.tiltX), tiltY: tilt(bp.tiltY), rotation: ((((Number(bp.angle) || 0) % 360) + 360) % 360), pressure: frac(bp.pressure, 1),
        overrideTilt: !!(bp.overrideTiltX || bp.overrideTiltY), overrideRotation: !!bp.overrideAngle, overridePressure: !!bp.overridePressure,
      };
    }
    out.noise = !!b.noise;
    out.wetEdges = !!b.wetEdges;
    out.protectTexture = !!b.protectTexture;
    // Pigment's reader passes the raw descriptor's build-up and Smoothing boxes (ag-psd does not read them)
    out.buildUp = !!b.buildUp;
    out.smoothCurves = !!b.smoothCurves;
    const to = b.toolOptions;
    if (to && to.brushPreset !== false) {
      const tool = {};
      if (Number.isFinite(to.opacity)) tool.opacity = clamp(to.opacity / 100, 0.01, 1);
      if (Number.isFinite(to.flow)) tool.flow = clamp(to.flow / 100, 0.01, 1);
      const mode = kebab(to.mode);
      if (BLEND_CODES[mode] || mode === 'behind' || mode === 'clear') tool.blend = mode;
      if (to.smoothing && Number.isFinite(to.smoothingValue)) tool.smoothing = clamp(to.smoothingValue / 100, 0, 1);
      if (to.type && to.type !== 'brush') report.push(`"${name}": a ${to.type} preset's tool settings are read as the Brush's`);
      if (Object.keys(tool).length) out.tool = tool;
    }
    const preset = normalizeBrush(out);
    if (tx) {
      const ref = typeof patternRef === 'function' ? patternRef(tx.id, tx.name) : null;
      if (ref) preset.texture.pattern = ref;
      else report.push(`"${name}": its texture pattern "${tx.name ?? tx.id ?? '?'}" is not in the file; the current pattern is used`);
    }
    return { preset, blobs, report };
  } catch (err) {
    report.push(`"${name}" could not be read (${err?.message ?? err}); a round brush is used`);
    return { preset: normalizeBrush(brushFromLegacy({})), blobs: {}, report };
  }
}

// ---- reading files ------------------------------------------------------------------------------------------------

class Bytes {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.o = 0;
  }
  need(n) {
    if (this.o + n > this.bytes.length) throw new Error('the file is truncated');
  }
  u8() { this.need(1); return this.bytes[this.o++]; }
  i16() { this.need(2); const v = this.view.getInt16(this.o); this.o += 2; return v; }
  u16() { this.need(2); const v = this.view.getUint16(this.o); this.o += 2; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.o); this.o += 4; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.o); this.o += 4; return v; }
  sig() { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.o, this.o + 4)); this.o += 4; return s; }
  take(n) { this.need(n); const b = this.bytes.subarray(this.o, this.o + n); this.o += n; return b; }
  pascal() { const n = this.u8(); return String.fromCharCode(...this.take(n)); }
}

/** PackBits rows of an 8-bit plane, after the row byte counts (Photoshop's RLE). */
function unpackRows(r, w, h) {
  const counts = [];
  for (let y = 0; y < h; y++) counts.push(r.u16());
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const end = r.o + counts[y];
    let x = 0;
    while (r.o < end && x < w) {
      let n = r.u8();
      if (n > 127) n -= 256;
      if (n >= 0) {
        const run = r.take(Math.min(n + 1, end - r.o));
        out.set(run.subarray(0, Math.min(run.length, w - x)), y * w + x);
        x += run.length;
      } else if (n !== -128) {
        const v = r.u8();
        for (let k = 0; k < 1 - n && x < w; k++) out[y * w + x++] = v;
      }
    }
    r.o = end;
  }
  return out;
}

function readSampleData(r, w, h, depth, compression) {
  if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) throw new Error('a sample has an invalid size');
  if (depth !== 8 && depth !== 16) throw new Error(`a sample has ${depth} bits`);
  if (compression === 1) {
    if (depth !== 8) throw new Error('16-bit compressed samples are not read');
    return unpackRows(r, w, h);
  }
  if (compression !== 0) throw new Error('a sample has an unknown compression');
  if (depth === 8) return r.take(w * h).slice();
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = r.u16() >> 8;
  return out;
}

/** Photoshop 7 and older (.abr versions 1 and 2): computed and sampled brushes, no dynamics. */
function readOldAbr(r, version, report) {
  const count = r.i16();
  const brushes = [];
  const samples = new Map();
  for (let i = 0; i < count && r.o < r.bytes.length; i++) {
    const type = r.i16();
    const size = r.i32();
    const next = r.o + size;
    try {
      if (type === 1) {
        r.i32(); // misc
        const spacing = r.i16(), diameter = r.i16(), roundness = r.i16(), angle = r.i16(), hardness = r.i16();
        brushes.push({ name: `Brush ${diameter}`, shape: { type: 'computed', size: diameter, hardness: hardness / 100, angle, roundness: roundness / 100, spacing: spacing / 100, spacingOn: spacing > 0 } });
      } else if (type === 2) {
        r.i32(); // misc
        const spacing = r.i16();
        let name = '';
        if (version === 2) {
          const n = r.i32();
          for (let k = 0; k < n; k++) {
            const c = r.u16();
            if (c) name += String.fromCharCode(c);
          }
        }
        r.u8(); // antialiasing
        for (let k = 0; k < 4; k++) r.i16(); // the short bounds
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const depth = r.i16();
        const compression = r.u8();
        const w = right - left, h = bottom - top;
        const alpha = readSampleData(r, w, h, depth, compression);
        const id = `old-${i}`;
        samples.set(id, { width: w, height: h, alpha });
        brushes.push({ name: name || `Sampled Brush ${i + 1}`, shape: { type: 'sampled', size: Math.max(w, h), angle: 0, roundness: 1, spacing: spacing / 100, spacingOn: spacing > 0, sampledData: id } });
      } else report.push(`brush ${i + 1} has an unknown type (${type}) and was skipped`);
    } catch (err) {
      report.push(`brush ${i + 1} could not be read (${err?.message ?? err})`);
    }
    r.o = next;
  }
  return { brushes, samples, patterns: [], raws: [] };
}

/** Photoshop 7.0.1 and later (.abr versions 6 to 10): the sections samp, desc and patt. */
function readNewAbr(r, report) {
  const minor = r.i16();
  if (minor !== 1 && minor !== 2) throw new Error(`.abr minor version ${minor} is not one Pigment reads`);
  const samples = new Map();
  const brushes = [];
  const raws = [];
  const patterns = [];
  while (r.o + 12 <= r.bytes.length) {
    if (r.sig() !== '8BIM') throw new Error('a section of the file is damaged');
    const type = r.sig();
    let size = r.u32();
    const start = r.o;
    const end = Math.min(r.bytes.length, start + size);
    if (start + size > r.bytes.length) report.push(`the ${type} section is truncated`);
    try {
      if (type === 'samp') {
        while (r.o + 4 <= end) {
          let length = r.u32();
          while (length & 3) length++;
          const next = r.o + length;
          try {
            const id = r.pascal();
            r.take(minor === 1 ? 10 : 264);
            const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
            const depth = r.i16();
            const compression = r.u8();
            samples.set(id, { width: right - left, height: bottom - top, alpha: readSampleData(r, right - left, bottom - top, depth, compression) });
          } catch (err) {
            report.push(`a brush tip could not be read (${err?.message ?? err})`);
          }
          r.o = next;
        }
      } else if (type === 'desc') {
        const reader = createReader(r.bytes.buffer, r.bytes.byteOffset + start, end - start);
        const desc = readVersionAndDescriptor(reader, true);
        for (const raw of Array.isArray(desc?.Brsh) ? desc.Brsh : []) {
          try {
            brushes.push(parseBrushDescriptor(raw));
            raws.push(raw);
          } catch (err) {
            report.push(`the brush "${raw?.['Nm  '] ?? '?'}" could not be read (${err?.message ?? err})`);
          }
        }
      } else if (type === 'patt') {
        const reader = createReader(r.bytes.buffer, r.bytes.byteOffset + start, end - start);
        while (reader.offset < end - start) {
          try {
            patterns.push(readPattern(reader));
          } catch (err) {
            report.push(`a pattern could not be read (${err?.message ?? err})`);
            break;
          }
        }
      }
      // 'phry' (the preset hierarchy) and sections of later releases are skipped
    } catch (err) {
      report.push(`the ${type} section could not be read (${err?.message ?? err})`);
    }
    while (size % 4) size++;
    r.o = start + size;
  }
  if (r.o < r.bytes.length) report.push('the file ends in the middle of a section');
  return { brushes, samples, patterns, raws };
}

const randomBlob = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}.png`;

/**
 * The .abr format's read (S10.1): { items, groups, report }. The brushes go into a group named after the file; each
 * pattern of the file becomes a `patterns` item that the textured brushes name with a $presetRef. Never throws.
 */
export async function readAbrFile(bytes, { name = 'Brushes.abr' } = {}) {
  const report = [];
  const items = [];
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/\.abr$/i, '') || 'Brushes';
  let parsed;
  try {
    const r = new Bytes(bytes);
    const version = r.i16();
    if (version === 1 || version === 2) parsed = readOldAbr(r, version, report);
    else if (version >= 6 && version <= 10) parsed = readNewAbr(r, report);
    else throw new Error(`.abr version ${version} is not one Pigment reads`);
  } catch (err) {
    report.push(`${base}: ${err?.message ?? err}`);
    return { items, groups: [], report };
  }
  if (!parsed.brushes.length && !report.length) report.push(`${base}: the file holds no brushes`);
  const patternRefs = new Map();
  for (const [i, p] of parsed.patterns.entries()) {
    try {
      const png = await encodeRgba8({ width: p.bounds.w, height: p.bounds.h, data: p.data });
      const ref = `pattern-${i}`;
      const blob = randomBlob('p-abr');
      items.push({ kind: 'patterns', ref, name: p.name || `Pattern ${i + 1}`, data: { width: p.bounds.w, height: p.bounds.h, blob, mode: 'rgb' }, blobs: { [blob]: png } });
      if (p.id) patternRefs.set(p.id, ref);
    } catch (err) {
      report.push(`the pattern "${p?.name ?? '?'}" could not be stored (${err?.message ?? err})`);
    }
  }
  const lines = [];
  parsed.brushes.forEach((b, i) => {
    const raw = parsed.raws[i];
    const brush = raw ? { ...b, buildUp: raw['Rpt '] === true, smoothCurves: raw.Smoo === true } : b;
    const res = brushFromAgPsd(brush, parsed.samples, { patternRef: (id) => (patternRefs.has(id) ? { $presetRef: { kind: 'patterns', ref: patternRefs.get(id) } } : null) });
    lines.push(...res.report);
    items.push({ kind: 'brushes', name: b.name || `Brush ${i + 1}`, group: 'file', data: res.preset, blobs: res.blobs });
  });
  report.push(...lines);
  return { items, groups: parsed.brushes.length ? [{ kind: 'brushes', id: 'file', name: base }] : [], report };
}

// ---- writing files --------------------------------------------------------------------------------------------

// typed descriptor values: the writer below writes exactly these
const T = {
  text: (v) => ({ t: 'TEXT', v: String(v ?? '') }),
  bool: (v) => ({ t: 'bool', v: !!v }),
  long: (v) => ({ t: 'long', v: Math.round(Number(v) || 0) }),
  doub: (v) => ({ t: 'doub', v: Number(v) || 0 }),
  px: (v) => ({ t: 'UntF', units: '#Pxl', v: Number(v) || 0 }),
  pct: (v) => ({ t: 'UntF', units: '#Prc', v: (Number(v) || 0) * 100 }),
  ang: (v) => ({ t: 'UntF', units: '#Ang', v: Number(v) || 0 }),
  enm: (type, v) => ({ t: 'enum', type, v }),
  obj: (classId, items) => ({ t: 'Objc', classId, items }),
  list: (values) => ({ t: 'VlLs', v: values }),
};

const dynamics = (c, jitter, minimum = 0) => T.obj('brVr', {
  bVTy: T.long(Math.max(0, CONTROL_CODES.indexOf(c?.type ?? 'off'))),
  fStp: T.long(c?.fadeSteps ?? 25),
  jitter: T.pct(jitter),
  'Mnm ': T.pct(minimum),
});

function tipShape(tip, sampleId) {
  const common = { Dmtr: T.px(tip.size), Angl: T.ang(tip.angle), Rndn: T.pct(tip.roundness), Spcn: T.pct(tip.spacing), Intr: T.bool(tip.spacingOn), flipX: T.bool(tip.flipX), flipY: T.bool(tip.flipY) };
  if (tip.kind === 'sampled' && sampleId) return T.obj('sampledBrush', { 'Nm  ': T.text(''), ...common, sampledData: T.text(sampleId) });
  return T.obj('computedBrush', { ...common, Hrdn: T.pct(tip.kind === 'sampled' ? 1 : tip.hardness) });
}

/**
 * A preset as the typed descriptor of one brush of an .abr 'desc' section. ids: { tip, dual } sample ids of its
 * sampled tips, pattern: { id, name } of its texture's pattern in the file (or null: the texture is written off).
 */
export function brushDescriptor(preset, { name = 'Brush', tip = null, dual = null, pattern = null } = {}) {
  const p = normalizeBrush(preset);
  const sd = p.shapeDynamics, sc = p.scattering, tx = p.texture, db = p.dualBrush, cd = p.colorDynamics, tr = p.transfer, bp = p.brushPose;
  const items = {
    'Nm  ': T.text(name),
    Brsh: tipShape(p.tip, tip),
    useTipDynamics: T.bool(sd.enabled),
    flipX: T.bool(sd.flipXJitter),
    flipY: T.bool(sd.flipYJitter),
    brushProjection: T.bool(sd.brushProjection),
    minimumDiameter: T.pct(sd.minimumDiameter),
    minimumRoundness: T.pct(sd.minimumRoundness),
    tiltScale: T.pct(sd.tiltScale),
    szVr: dynamics(sd.sizeControl, sd.sizeJitter, sd.minimumDiameter),
    angleDynamics: dynamics(sd.angleControl, sd.angleJitter),
    roundnessDynamics: dynamics(sd.roundnessControl, sd.roundnessJitter, sd.minimumRoundness),
    useScatter: T.bool(sc.enabled),
    Spcn: T.pct(p.tip.spacing),
    'Cnt ': T.long(sc.count),
    bothAxes: T.bool(sc.bothAxes),
    countDynamics: dynamics(sc.countControl, sc.countJitter),
    scatterDynamics: dynamics(sc.scatterControl, sc.scatter),
    dualBrush: T.obj('dualBrush', {
      useDualBrush: T.bool(db.enabled),
      Flip: T.bool(db.flip),
      Brsh: tipShape(db.tip, dual),
      BlnM: T.enm('BlnM', BLEND_CODES[db.mode] ?? 'CBrn'),
      useScatter: T.bool(db.scatter > 0),
      Spcn: T.pct(db.tip.spacing),
      'Cnt ': T.long(db.count),
      bothAxes: T.bool(db.bothAxes),
      countDynamics: dynamics({ type: 'off' }, db.countJitter),
      scatterDynamics: dynamics({ type: 'off' }, db.scatter),
    }),
    brushGroup: T.obj('null', {}),
    useTexture: T.bool(tx.enabled && !!pattern),
    TxtC: T.bool(tx.eachTip),
    interpretation: T.bool(false),
    textureBlendMode: T.enm('BlnM', TEXTURE_CODE[tx.mode] ?? 'Mltp'),
    textureDepth: T.pct(tx.depth),
    minimumDepth: T.pct(tx.minimumDepth),
    textureDepthDynamics: dynamics(tx.depthControl, tx.depthJitter, tx.minimumDepth),
    textureScale: T.pct(tx.scale),
    InvT: T.bool(tx.invert),
    protectTexture: T.bool(p.protectTexture),
    textureBrightness: T.long(tx.brightness),
    textureContrast: T.long(tx.contrast),
    usePaintDynamics: T.bool(tr.enabled),
    prVr: dynamics(tr.flowControl, tr.flowJitter, tr.minimumFlow),
    opVr: dynamics(tr.opacityControl, tr.opacityJitter, tr.minimumOpacity),
    wtVr: dynamics(tr.wetnessControl, tr.wetnessJitter),
    mxVr: dynamics(tr.mixControl, tr.mixJitter),
    useColorDynamics: T.bool(cd.enabled),
    clVr: dynamics(cd.fbControl, cd.fbJitter),
    'H   ': T.pct(cd.hueJitter),
    Strt: T.pct(cd.saturationJitter),
    Brgh: T.pct(cd.brightnessJitter),
    purity: T.pct(cd.purity),
    colorDynamicsPerTip: T.bool(cd.perTip),
    Wtdg: T.bool(p.wetEdges),
    Nose: T.bool(p.noise),
    'Rpt ': T.bool(p.buildUp),
    Smoo: T.bool(p.smoothCurves),
    useBrushSize: T.bool(true),
    useBrushPose: T.bool(bp.enabled),
    overridePoseAngle: T.bool(bp.overrideRotation),
    overridePoseTiltX: T.bool(bp.overrideTilt),
    overridePoseTiltY: T.bool(bp.overrideTilt),
    overridePosePressure: T.bool(bp.overridePressure),
    brushPosePressure: T.pct(bp.pressure),
    brushPoseTiltX: T.long(bp.tiltX * 100),
    brushPoseTiltY: T.long(bp.tiltY * 100),
    brushPoseAngle: T.long(bp.rotation),
  };
  if (tx.enabled && pattern) items.Txtr = T.obj('Ptrn', { 'Nm  ': T.text(pattern.name ?? ''), Idnt: T.text(pattern.id) });
  if (p.tool) {
    const to = { brushPreset: T.bool(true) };
    if (p.tool.flow !== undefined) to.flow = T.long(p.tool.flow * 100);
    if (p.tool.opacity !== undefined) to.Opct = T.long(p.tool.opacity * 100);
    // Behind and Clear have no code other readers know: written as Normal (reported by writeAbrFile)
    to['Md  '] = T.enm('BlnM', BLEND_CODES[p.tool.blend ?? 'normal'] ?? 'Nrml');
    to.smoothing = T.bool(p.tool.smoothing !== undefined && p.tool.smoothing > 0);
    to.smoothingValue = T.long((p.tool.smoothing ?? 0) * 100);
    items.toolOptions = T.obj('PbTl', to);
  }
  return T.obj('brushPreset', items);
}

class Out {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.n = 0;
  }
  room(k) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  dv() {
    return new DataView(this.buf.buffer);
  }
  u8(v) { this.room(1); this.buf[this.n++] = v & 255; }
  i16(v) { this.room(2); this.dv().setInt16(this.n, v); this.n += 2; }
  u16(v) { this.room(2); this.dv().setUint16(this.n, v); this.n += 2; }
  i32(v) { this.room(4); this.dv().setInt32(this.n, v); this.n += 4; }
  u32(v) { this.room(4); this.dv().setUint32(this.n, v >>> 0); this.n += 4; }
  f64(v) { this.room(8); this.dv().setFloat64(this.n, v); this.n += 8; }
  bytes(b) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  sig(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  pad4(from) { while ((this.n - from) % 4) this.u8(0); }
  done() { return this.buf.slice(0, this.n); }
  /** A unicode string with its trailing NUL, as Photoshop writes them. */
  ustr(s) {
    this.u32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  /** A key or class id: four characters as a class id (length 0), else a length-prefixed ASCII string. */
  key(s) {
    if (s.length === 4) {
      this.u32(0);
      this.sig(s);
    } else {
      this.u32(s.length);
      for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    }
  }
}

function writeValue(o, node) {
  switch (node.t) {
    case 'TEXT': o.ustr(node.v); break;
    case 'bool': o.u8(node.v ? 1 : 0); break;
    case 'long': o.i32(node.v); break;
    case 'doub': o.f64(node.v); break;
    case 'UntF': o.sig(node.units); o.f64(node.v); break;
    case 'enum': o.key(node.type); o.key(node.v); break;
    case 'Objc': writeStructure(o, node); break;
    case 'VlLs':
      o.u32(node.v.length);
      for (const item of node.v) {
        o.sig(item.t);
        writeValue(o, item);
      }
      break;
    default: throw new Error(`no writer for ${node.t}`);
  }
}

function writeStructure(o, node) {
  o.ustr('');
  o.key(node.classId);
  const entries = Object.entries(node.items);
  o.u32(entries.length);
  for (const [k, v] of entries) {
    o.key(k);
    o.sig(v.t);
    writeValue(o, v);
  }
}

/** The coverage (0..255, white = full) of a tip blob: an 8-bit grey PNG, or any PNG read as luma x alpha. */
async function coverageOf(bytes) {
  const img = toRgba8(await decodePng(bytes));
  const alpha = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(((0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * d[i * 4 + 3]) / 255);
  return { width: img.width, height: img.height, alpha };
}

const uuidOf = (hash) => {
  const h = String(hash ?? '').replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase();
  return `$${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * An .abr file (version 6.2) of presets ({ name, data }[]): samp (the sampled tips, raw 8-bit), patt (the textures'
 * patterns, through ag-psd's writePattern) and desc. readBlob(kind, name) gives tip PNGs of `brushes`;
 * patternPixels(presetId) → { name, width, height, data (RGBA) } | null gives a texture's pattern. → { bytes, report }.
 */
export async function writeAbrFile(presets, { readBlob, patternPixels = null } = {}) {
  const report = [];
  const samples = new Map(); // blob -> { id, width, height, alpha }
  const patterns = new Map(); // presetId -> { id, name, width, height, data }
  const brushes = [];
  for (const p of presets ?? []) {
    const data = normalizeBrush(p?.data ?? p);
    const name = String(p?.name ?? 'Brush');
    const ids = { name, tip: null, dual: null, pattern: null };
    for (const [key, tip] of [['tip', data.tip], ['dual', data.dualBrush.enabled ? data.dualBrush.tip : null]]) {
      if (!tip || tip.kind !== 'sampled' || !tip.sample?.blob) continue;
      let s = samples.get(tip.sample.blob);
      if (!s) {
        try {
          const bytes = await readBlob?.('brushes', tip.sample.blob);
          if (bytes?.length) {
            s = { id: uuidOf(tip.sample.hash || tip.sample.blob), ...(await coverageOf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))) };
            samples.set(tip.sample.blob, s);
          }
        } catch {
          s = null;
        }
      }
      if (s) ids[key] = s.id;
      else report.push(`"${name}": ${key === 'tip' ? 'its' : 'its dual brush'} tip image is missing; written as a round tip`);
    }
    if (data.texture.enabled) {
      const pid = data.texture.pattern?.presetId ?? null;
      let pat = pid ? patterns.get(pid) : null;
      if (!pat && pid && patternPixels) {
        try {
          const px = await patternPixels(pid);
          if (px?.data && px.width > 0 && px.height > 0) {
            pat = { id: uuidOf(pid.split('').map((c) => c.charCodeAt(0).toString(16)).join('')), name: px.name ?? data.texture.pattern?.name ?? 'Pattern', width: px.width, height: px.height, data: px.data };
            patterns.set(pid, pat);
          }
        } catch {
          pat = null;
        }
      }
      if (pat) ids.pattern = { id: pat.id, name: pat.name };
      else report.push(`"${name}": its texture's pattern is missing; written without the texture`);
    }
    if (data.tool?.blend === 'behind' || data.tool?.blend === 'clear') report.push(`"${name}": the ${data.tool.blend === 'behind' ? 'Behind' : 'Clear'} mode is written as Normal`);
    if (data.tip.extras?.abr) report.push(`"${name}": its tip is written as a round tip`);
    brushes.push(brushDescriptor(data, ids));
  }
  const o = new Out();
  o.i16(6);
  o.i16(2);
  const section = (type, body) => {
    o.sig('8BIM');
    o.sig(type);
    const at = o.n;
    o.u32(0);
    const start = o.n;
    body();
    const size = o.n - start;
    new DataView(o.buf.buffer).setUint32(at, size);
    o.pad4(start);
  };
  section('samp', () => {
    for (const s of samples.values()) {
      const at = o.n;
      o.u32(0);
      const start = o.n;
      o.u8(s.id.length);
      for (let i = 0; i < s.id.length; i++) o.u8(s.id.charCodeAt(i));
      o.bytes(new Uint8Array(264));
      o.i32(0);
      o.i32(0);
      o.i32(s.height);
      o.i32(s.width);
      o.i16(8);
      o.u8(0);
      o.bytes(s.alpha);
      new DataView(o.buf.buffer).setUint32(at, o.n - start);
      o.pad4(start);
    }
  });
  if (patterns.size) {
    section('patt', () => {
      for (const p of patterns.values()) {
        const w = createWriter(p.width * p.height * 4 + 4096);
        writePattern(w, { name: p.name, id: p.id, x: 0, y: 0, bounds: { x: 0, y: 0, w: p.width, h: p.height }, data: p.data });
        o.bytes(new Uint8Array(w.buffer, 0, w.offset));
      }
    });
  }
  section('desc', () => {
    o.u32(16);
    writeStructure(o, T.obj('null', { Brsh: T.list(brushes) }));
  });
  return { bytes: o.done(), report };
}

// ---- the preset file format ------------------------------------------------------------------------------------

/** The pixels of a `patterns` preset (its canvas through app.patterns): { name, width, height, data } or null. */
async function patternPixelsOf(app, presetId) {
  const e = await app.patterns?.get?.(presetId);
  if (!e?.canvas) return null;
  const img = e.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, e.canvas.width, e.canvas.height);
  return { name: e.name, width: img.width, height: img.height, data: img.data };
}

/** Registers .abr (brushes and their patterns) with the preset files of S10.1. Returns the unregister function. */
export function registerAbrFormat(app) {
  let lastReport = [];
  return registerPresetFileFormat({
    id: 'abr',
    name: 'Photoshop Brushes',
    extensions: ['abr'],
    kinds: ['brushes', 'patterns'],
    read: (bytes, ctx) => readAbrFile(bytes, ctx),
    async write(selection, ctx) {
      const presets = (selection ?? []).filter((s) => s.kind === 'brushes').flatMap((s) => s.presets ?? []);
      const { bytes, report } = await writeAbrFile(presets, { readBlob: ctx.readBlob, patternPixels: (id) => patternPixelsOf(app, id) });
      lastReport = report;
      if (report.length) app.dialogs?.alert?.('Some brushes were written without parts Photoshop files cannot hold', { title: 'Export Brushes', detail: report.join('\n') });
      return bytes;
    },
    get lastReport() {
      return lastReport;
    },
  });
}

// ---- a grey PNG without compression (sync) ------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An 8-bit greyscale PNG of the coverage (white = full coverage), its zlib stream in stored blocks. */
function greyPng(w, h, alpha) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(alpha.subarray(y * w, y * w + w), y * (w + 1) + 1); // filter byte 0
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const from = b * 65535;
    const len = Math.min(65535, raw.length - from);
    z[o++] = b === blocks - 1 ? 1 : 0;
    z[o++] = len & 0xff;
    z[o++] = len >>> 8;
    z[o++] = ~len & 0xff;
    z[o++] = (~len >>> 8) & 0xff;
    z.set(raw.subarray(from, from + len), o);
    o += len;
  }
  let s1 = 1, s2 = 0;
  for (let i = 0; i < raw.length; i++) {
    s1 = (s1 + raw[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  z[o++] = adler >>> 24;
  z[o++] = (adler >>> 16) & 0xff;
  z[o++] = (adler >>> 8) & 0xff;
  z[o++] = adler & 0xff;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const chunks = [['IHDR', ihdr], ['IDAT', z.subarray(0, o)], ['IEND', new Uint8Array(0)]];
  const total = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const odv = new DataView(out.buffer);
  let p = 8;
  for (const [type, data] of chunks) {
    odv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    odv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}

// ---- SHA-1 (sync; the blob names are content addresses) ------------------------------------------------------------

function sha1Hex(bytes) {
  const ml = bytes.length;
  const n = (((ml + 8) >>> 6) + 1) << 6;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[ml] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor((ml * 8) / 0x100000000));
  dv.setUint32(n - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => v.toString(16).padStart(8, '0')).join('');
}
