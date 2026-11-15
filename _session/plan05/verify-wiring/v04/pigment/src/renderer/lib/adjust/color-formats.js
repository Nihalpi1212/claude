// Adjustment preset data of adjust-color (pure, no DOM; unit-tested in Node): Photoshop's preset files for
// Hue/Saturation (.ahu), Channel Mixer (.cha), Selective Color (.asv) and Black & White (.blw), the Photoshop-like
// built-in presets of the colour kinds, and the Adjustments panel's preset groups (several adjustment layers each).
//
// Byte layouts (big-endian, as Photoshop writes them):
//  .ahu  100 bytes: version 2 (u16), colorize flag (u8) + pad (u8), colorize hue / saturation / lightness (3 x i16;
//        hue as -180..180), Master hue / saturation / lightness (3 x i16), then for reds, yellows, greens, cyans,
//        blues, magentas: the four range bounds in degrees (4 x i16) and hue / saturation / lightness (3 x i16).
//  .cha  44 bytes: version 1 (u16), monochrome (u16), then for the red, green, blue and grey outputs: red, green, blue
//        and an unused fourth source (4 x i16, percent) and the constant (i16, percent).
//  .asv  84 bytes: version 1 (u16), method (u16: 0 relative, 1 absolute), ten records of cyan, magenta, yellow, black
//        (4 x i16, percent): the first unused, then reds, yellows, greens, cyans, blues, magentas, whites, neutrals,
//        blacks.
//  .blw  version 1 (u16), descriptor version 16 (u32), then an action descriptor with 'Rd  ', 'Yllw', 'Grn ', 'Cyn ',
//        'Bl  ', 'Mgnt' (long), 'useTint' (bool) and 'tintColor' (an RGBC object of doubles). The reader parses the
//        descriptor and takes the keys it knows, so files with more keys (Photoshop's preset kind and file name) load.
import { DEFAULT_RANGE_BOUNDS, HUE_BASES, hueSatRanges } from '../../../shared/pixels/adjust-color.js';
import { hslToRgb, rgbToHsl } from '../../../shared/pixels/color.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : 0)));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- Hue/Saturation (.ahu) -------------------------------------------------------------------------------------

export function writeAhu(params) {
  const p = params ?? {};
  const out = new Uint8Array(100);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 2);
  out[2] = p.colorize ? 1 : 0;
  const ch = clampInt(p.colorizeHue ?? 0, 0, 360);
  dv.setInt16(4, ch > 180 ? ch - 360 : ch);
  dv.setInt16(6, clampInt(p.colorizeSat ?? 25, 0, 100));
  dv.setInt16(8, clampInt(p.colorizeLight ?? 0, -100, 100));
  const { master, ranges } = hueSatRanges({ ...p, range: 'master' });
  dv.setInt16(10, clampInt(master.hue, -180, 180));
  dv.setInt16(12, clampInt(master.saturation, -100, 100));
  dv.setInt16(14, clampInt(master.lightness, -100, 100));
  HUE_BASES.forEach((base, i) => {
    const r = ranges.find((x) => x.base === base);
    const bounds = r?.bounds ?? DEFAULT_RANGE_BOUNDS[base];
    const o = 16 + i * 14;
    for (let k = 0; k < 4; k++) dv.setInt16(o + k * 2, clampInt(bounds[k], 0, 360));
    dv.setInt16(o + 8, clampInt(r?.hue ?? 0, -180, 180));
    dv.setInt16(o + 10, clampInt(r?.saturation ?? 0, -100, 100));
    dv.setInt16(o + 12, clampInt(r?.lightness ?? 0, -100, 100));
  });
  return out;
}

export function readAhu(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 100) throw new Error('This is not a Hue/Saturation file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(0);
  if (version !== 2 && version !== 1) throw new Error(`Hue/Saturation file version ${version} is not supported`);
  const report = [];
  const ch = dv.getInt16(4);
  const params = {
    hue: dv.getInt16(10), saturation: dv.getInt16(12), lightness: dv.getInt16(14),
    colorize: bytes[2] === 1, colorizeHue: ch < 0 ? ch + 360 : ch, colorizeSat: dv.getInt16(6), colorizeLight: dv.getInt16(8),
    range: 'master', ranges: [],
  };
  HUE_BASES.forEach((base, i) => {
    const o = 16 + i * 14;
    const bounds = [0, 1, 2, 3].map((k) => ((dv.getInt16(o + k * 2) % 360) + 360) % 360);
    const vals = { hue: dv.getInt16(o + 8), saturation: dv.getInt16(o + 10), lightness: dv.getInt16(o + 12) };
    const def = DEFAULT_RANGE_BOUNDS[base];
    const moved = bounds.some((v, k) => v !== def[k]);
    if (moved || vals.hue || vals.saturation || vals.lightness) params.ranges.push({ base, bounds, ...vals });
  });
  // through the same reading as the pixels (clamps, bad bounds replaced)
  params.ranges = hueSatRanges(params).ranges;
  if (version === 1) report.push('An old (version 1) Hue/Saturation file: its ranges were read with Photoshop’s later layout');
  return { params, report };
}

// ---- Channel Mixer (.cha) --------------------------------------------------------------------------------------

const MIXER_OUTPUTS = ['r', 'g', 'b', 'gray'];
const MIXER_DEFAULT = { r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 }, gray: { r: 40, g: 40, b: 20, constant: 0 } };

export function writeCha(params) {
  const p = params ?? {};
  const out = new Uint8Array(44);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1);
  dv.setUint16(2, p.monochrome ? 1 : 0);
  MIXER_OUTPUTS.forEach((o, i) => {
    const row = isObj(p[o]) ? p[o] : MIXER_DEFAULT[o];
    const at = 4 + i * 10;
    dv.setInt16(at, clampInt(row.r ?? 0, -200, 200));
    dv.setInt16(at + 2, clampInt(row.g ?? 0, -200, 200));
    dv.setInt16(at + 4, clampInt(row.b ?? 0, -200, 200));
    dv.setInt16(at + 6, 0);
    dv.setInt16(at + 8, clampInt(row.constant ?? 0, -200, 200));
  });
  return out;
}

export function readCha(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 14) throw new Error('This is not a Channel Mixer file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== 1) throw new Error('This Channel Mixer file version is not supported');
  const params = { monochrome: dv.getUint16(2) !== 0, ...clone(MIXER_DEFAULT) };
  const report = [];
  MIXER_OUTPUTS.forEach((o, i) => {
    const at = 4 + i * 10;
    if (at + 10 > bytes.length) return;
    params[o] = { r: dv.getInt16(at), g: dv.getInt16(at + 2), b: dv.getInt16(at + 4), constant: dv.getInt16(at + 8) };
  });
  if (bytes.length < 44) report.push('A short Channel Mixer file: the missing outputs keep their defaults');
  // a monochrome file written with only the first output: the grey mix is that one
  if (params.monochrome && bytes.length < 44) params.gray = { ...params.r };
  return { params, report };
}

// ---- Selective Color (.asv) ------------------------------------------------------------------------------------

const SEL_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

export function writeAsv(params) {
  const p = params ?? {};
  const out = new Uint8Array(84);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1);
  dv.setUint16(2, p.relative === false ? 1 : 0);
  SEL_RANGES.forEach((r, i) => {
    const v = isObj(p[r]) ? p[r] : {};
    const at = 4 + (i + 1) * 8;
    ['c', 'm', 'y', 'k'].forEach((c, k) => dv.setInt16(at + k * 2, clampInt(v[c] ?? 0, -100, 100)));
  });
  return out;
}

export function readAsv(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 84) throw new Error('This is not a Selective Color file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0) !== 1) throw new Error('This Selective Color file version is not supported');
  const params = { relative: dv.getUint16(2) === 0 };
  SEL_RANGES.forEach((r, i) => {
    const at = 4 + (i + 1) * 8;
    params[r] = { c: dv.getInt16(at), m: dv.getInt16(at + 2), y: dv.getInt16(at + 4), k: dv.getInt16(at + 6) };
  });
  return { params, report: [] };
}

// ---- Black & White (.blw): a small action-descriptor writer and reader -----------------------------------------

const BW_KEYS = [['reds', 'Rd  '], ['yellows', 'Yllw'], ['greens', 'Grn '], ['cyans', 'Cyn '], ['blues', 'Bl  '], ['magentas', 'Mgnt']];

class Writer {
  constructor() {
    this.parts = [];
    this.n = 0;
  }
  u8(v) {
    this.parts.push(Uint8Array.of(v & 255));
    this.n += 1;
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v);
    this.parts.push(b);
    this.n += 2;
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    this.parts.push(b);
    this.n += 4;
  }
  i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v | 0);
    this.parts.push(b);
    this.n += 4;
  }
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    this.parts.push(b);
    this.n += 8;
  }
  ascii(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    this.parts.push(b);
    this.n += b.length;
  }
  /** A key or class id: four characters with a zero length, longer names with their length. */
  id(s) {
    this.u32(s.length === 4 ? 0 : s.length);
    this.ascii(s);
  }
  unicode(s) {
    this.u32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  bytes() {
    const out = new Uint8Array(this.n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function writeDescriptor(w, cls, items) {
  w.unicode('');
  w.id(cls);
  w.u32(items.length);
  for (const [key, type, value] of items) {
    w.id(key);
    w.ascii(type);
    if (type === 'long') w.i32(value);
    else if (type === 'bool') w.u8(value ? 1 : 0);
    else if (type === 'doub') w.f64(value);
    else if (type === 'Objc') writeDescriptor(w, value.cls, value.items);
  }
}

export function writeBlw(params) {
  const p = params ?? {};
  const w = new Writer();
  w.u16(1);
  w.u32(16);
  const items = BW_KEYS.map(([k, key]) => [key, 'long', clampInt(p[k] ?? 0, -200, 300)]);
  const tint = isObj(p.tint) ? p.tint : null;
  items.push(['useTint', 'bool', !!tint]);
  const [r, g, b] = hslToRgb(Number(tint?.hue ?? 42), Math.max(0, Math.min(100, Number(tint?.sat ?? 20))) / 100, 0.5);
  items.push(['tintColor', 'Objc', { cls: 'RGBC', items: [['Rd  ', 'doub', r], ['Grn ', 'doub', g], ['Bl  ', 'doub', b]] }]);
  writeDescriptor(w, 'BanW', items);
  return w.bytes();
}

function readDescriptor(dv, o, end, depth = 0) {
  if (depth > 8) throw new Error('Nested too deeply');
  const need = (n) => {
    if (o + n > end) throw new Error('Damaged descriptor');
  };
  const id = () => {
    need(4);
    const len = dv.getUint32(o);
    o += 4;
    const n = len === 0 ? 4 : len;
    need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i));
    o += n;
    return s;
  };
  need(4);
  const nameLen = dv.getUint32(o);
  o += 4;
  need(nameLen * 2);
  o += nameLen * 2;
  id(); // class
  need(4);
  const count = dv.getUint32(o);
  o += 4;
  if (count > 1000) throw new Error('Damaged descriptor');
  const out = {};
  for (let i = 0; i < count; i++) {
    const key = id();
    need(4);
    let type = '';
    for (let k = 0; k < 4; k++) type += String.fromCharCode(dv.getUint8(o + k));
    o += 4;
    if (type === 'long') {
      need(4);
      out[key] = dv.getInt32(o);
      o += 4;
    } else if (type === 'bool') {
      need(1);
      out[key] = dv.getUint8(o) !== 0;
      o += 1;
    } else if (type === 'doub') {
      need(8);
      out[key] = dv.getFloat64(o);
      o += 8;
    } else if (type === 'UntF') {
      need(12);
      out[key] = dv.getFloat64(o + 4);
      o += 12;
    } else if (type === 'Objc' || type === 'GlbO') {
      const r = readDescriptor(dv, o, end, depth + 1);
      out[key] = r.value;
      o = r.o;
    } else if (type === 'enum') {
      const t = id();
      out[key] = { type: t, value: id() };
    } else if (type === 'TEXT') {
      need(4);
      const len = dv.getUint32(o);
      o += 4;
      need(len * 2);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint16(o + k * 2));
      o += len * 2;
      out[key] = s.replace(/\0+$/, '');
    } else throw new Error(`Unsupported descriptor value ${type}`);
  }
  return { value: out, o };
}

export function readBlw(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) throw new Error('This is not a Black & White file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // version (u16) then the descriptor version (u32, 16)
  if (dv.getUint32(2) !== 16) throw new Error('This is not a Black & White file');
  let d;
  try {
    d = readDescriptor(dv, 6, bytes.length).value;
  } catch (err) {
    throw new Error(`This Black & White file cannot be read: ${err.message}`);
  }
  const report = [];
  const params = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null };
  let found = 0;
  for (const [k, key] of BW_KEYS) {
    if (typeof d[key] === 'number') {
      params[k] = clampInt(d[key], -200, 300);
      found++;
    }
  }
  if (!found) throw new Error('This Black & White file holds no settings');
  if (d.useTint && isObj(d.tintColor)) {
    const c = d.tintColor;
    const [h, s] = rgbToHsl(Number(c['Rd  '] ?? 0), Number(c['Grn '] ?? 0), Number(c['Bl  '] ?? 0));
    params.tint = { hue: Math.round(h), sat: Math.round(s * 100) };
  }
  return { params, report };
}

// ---- Built-in presets (Photoshop-like: the names of Photoshop's lists, values close to them) ---------------------

const hsDefaults = { hue: 0, saturation: 0, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' };
const range = (base, hue, saturation, lightness) => ({ base, bounds: [...DEFAULT_RANGE_BOUNDS[base]], hue, saturation, lightness });
const hs = (id, name, o) => ({ id, name, data: { ...hsDefaults, ranges: [], ...o } });
const bw = (id, name, [reds, yellows, greens, cyans, blues, magentas]) => ({ id, name, data: { reds, yellows, greens, cyans, blues, magentas, tint: null } });
const ident = () => ({ r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 } });
const mono = (id, name, r, g, b) => ({ id, name, data: { ...ident(), gray: { r, g, b, constant: 0 }, monochrome: true } });
const hdr = (id, name, o) => ({ id, name, data: { method: 'local-adaptation', radius: 100, strength: 50, gamma: 1, exposure: 0, detail: 30, shadow: 0, highlight: 0, vibrance: 0, saturation: 20, curve: null, ...o } });

export const COLOR_BUILTINS = Object.freeze({
  'hue-saturation': [
    hs('cyanotype', 'Cyanotype', { colorize: true, colorizeHue: 205, colorizeSat: 30, colorizeLight: 0 }),
    hs('further-increase-saturation', 'Further Increase Saturation', { saturation: 40 }),
    hs('increase-saturation', 'Increase Saturation', { saturation: 20 }),
    hs('old-style', 'Old Style', { saturation: -55, ranges: [range('yellows', 0, 25, 0), range('reds', 8, 10, 0)] }),
    hs('red-boost', 'Red Boost', { ranges: [range('reds', 0, 40, 0)] }),
    hs('sepia', 'Sepia', { colorize: true, colorizeHue: 35, colorizeSat: 25, colorizeLight: 0 }),
    hs('strong-saturation', 'Strong Saturation', { saturation: 60 }),
    hs('yellow-boost', 'Yellow Boost', { ranges: [range('yellows', 0, 40, 0)] }),
  ],
  'black-white': [
    bw('blue-filter', 'Blue Filter', [0, 0, 0, 100, 150, 100]),
    bw('darker', 'Darker', [20, 40, 20, 40, 0, 60]),
    bw('green-filter', 'Green Filter', [40, 100, 150, 60, 0, 40]),
    bw('high-contrast-blue-filter', 'High Contrast Blue Filter', [-50, -50, -50, 150, 200, 150]),
    bw('high-contrast-red-filter', 'High Contrast Red Filter', [120, 120, -10, -50, -50, 120]),
    bw('infrared', 'Infrared', [-40, 235, 144, -68, -3, -107]),
    bw('lighter', 'Lighter', [60, 80, 60, 80, 40, 100]),
    bw('maximum-black', 'Maximum Black', [0, 0, 0, 0, 0, 0]),
    bw('maximum-white', 'Maximum White', [100, 100, 100, 100, 100, 100]),
    bw('neutral-density', 'Neutral Density', [128, 128, 100, 100, 128, 100]),
    bw('red-filter', 'Red Filter', [120, 110, -10, -50, -50, 120]),
    bw('yellow-filter', 'Yellow Filter', [120, 110, 40, -30, 0, 70]),
  ],
  'channel-mixer': [
    mono('bw-infrared', 'Black & White Infrared (RGB)', -70, 200, -30),
    mono('bw-blue-filter', 'Black & White with Blue Filter (RGB)', 0, 0, 100),
    mono('bw-green-filter', 'Black & White with Green Filter (RGB)', 0, 100, 0),
    mono('bw-orange-filter', 'Black & White with Orange Filter (RGB)', 50, 50, 0),
    mono('bw-red-filter', 'Black & White with Red Filter (RGB)', 100, 0, 0),
    mono('bw-yellow-filter', 'Black & White with Yellow Filter (RGB)', 34, 66, 0),
  ],
  'hdr-toning': [
    hdr('flat', 'Flat', { strength: 20, detail: 0, saturation: 0 }),
    hdr('monochromatic', 'Monochromatic', { detail: 60, saturation: -100 }),
    hdr('monochromatic-high-contrast', 'Monochromatic High Contrast', { radius: 60, strength: 80, detail: 120, saturation: -100, shadow: -30, highlight: 20 }),
    hdr('photorealistic', 'Photorealistic', { radius: 150, strength: 40, detail: 20, saturation: 15 }),
    hdr('photorealistic-high-contrast', 'Photorealistic High Contrast', { radius: 120, strength: 60, detail: 50, shadow: -20, highlight: 10, saturation: 20 }),
    hdr('saturated', 'Saturated', { detail: 50, vibrance: 40, saturation: 40 }),
    hdr('more-saturated', 'More Saturated', { detail: 70, vibrance: 60, saturation: 60 }),
    hdr('surrealistic', 'Surrealistic', { radius: 40, strength: 100, detail: 200, vibrance: 30, saturation: 30 }),
  ],
});

/** A preset's data for a kind, or null when it cannot be used (the store drops it). */
export function normalizeColorPreset(kind, data) {
  if (!isObj(data)) return null;
  if (kind === 'hue-saturation') {
    if (data.ranges !== undefined && !Array.isArray(data.ranges)) return null;
    if (Array.isArray(data.ranges)) return { ...data, ranges: hueSatRanges({ ...data, range: 'master' }).ranges };
    return data;
  }
  if (kind === 'black-white') {
    if (!BW_KEYS.some(([k]) => typeof data[k] === 'number')) return null;
    return data;
  }
  if (kind === 'channel-mixer') return ['r', 'g', 'b', 'gray'].some((k) => isObj(data[k])) || typeof data.monochrome === 'boolean' ? data : null;
  if (kind === 'selective-color') return SEL_RANGES.some((k) => isObj(data[k])) || typeof data.relative === 'boolean' ? data : null;
  return data;
}

// ---- The Adjustments panel's presets (Photoshop's "Adjustment Presets" groups) -------------------------------------

const curve = (...pts) => pts;
const L = (kind, params, name) => (name ? { kind, params, name } : { kind, params });

/**
 * Each preset adds its layers above the active layer, bottom first, grouped in a layer group named after the preset
 * when there are several (as Photoshop does). Params are merged over the kind's defaults.
 */
export const ADJUSTMENT_PANEL_PRESETS = Object.freeze([
  { id: 'portraits', name: 'Portraits', presets: [
    { id: 'bright-warm', name: 'Bright and Warm', layers: [L('curves', { rgb: curve([0, 0], [120, 140], [255, 255]) }), L('color-vibrance', { temperature: 18, vibrance: 10 })] },
    { id: 'soft-skin', name: 'Soft Skin', layers: [L('clarity-dehaze', { clarity: -30 }), L('vibrance', { vibrance: -10, saturation: 0 })] },
    { id: 'warm-contrast', name: 'Warm Contrast', layers: [L('curves', { rgb: curve([0, 0], [64, 52], [192, 205], [255, 255]) }), L('photo-filter', { color: '#ec8a00', density: 15, preserveLuminosity: true })] },
  ] },
  { id: 'landscape', name: 'Landscape', presets: [
    { id: 'vivid', name: 'Vivid', layers: [L('color-vibrance', { vibrance: 35, saturation: 5 }), L('clarity-dehaze', { clarity: 25 })] },
    { id: 'clear-distance', name: 'Clear Distance', layers: [L('clarity-dehaze', { dehaze: 35, clarity: 10 })] },
    { id: 'golden-hour', name: 'Golden Hour', layers: [L('photo-filter', { color: '#fa9600', density: 30, preserveLuminosity: true }), L('curves', { rgb: curve([0, 10], [255, 250]) })] },
  ] },
  { id: 'photo-repair', name: 'Photo Repair', presets: [
    { id: 'lift-shadows', name: 'Lift Shadows', layers: [L('curves', { rgb: curve([0, 0], [50, 75], [255, 255]) })] },
    { id: 'restore-faded', name: 'Restore Faded Colors', layers: [L('levels', { rgb: { inBlack: 20, inWhite: 235, gamma: 1, outBlack: 0, outWhite: 255 } }), L('vibrance', { vibrance: 40, saturation: 10 })] },
    { id: 'cool-cast', name: 'Remove Warm Cast', layers: [L('color-vibrance', { temperature: -20 })] },
  ] },
  { id: 'creative', name: 'Creative', presets: [
    { id: 'cross-process', name: 'Cross Process', layers: [L('curves', { rgb: curve([0, 0], [255, 255]), r: curve([0, 0], [64, 50], [192, 210], [255, 255]), g: curve([0, 0], [64, 70], [192, 200], [255, 255]), b: curve([0, 40], [255, 215]) })] },
    { id: 'vintage-fade', name: 'Vintage Fade', layers: [L('curves', { rgb: curve([0, 30], [128, 128], [255, 235]) }), L('hue-saturation', { saturation: -30 }), L('grain', { amount: 25, size: 30, roughness: 50 })] },
    { id: 'duotone-blue', name: 'Duotone Blue', layers: [L('gradient-map', { stops: [{ offset: 0, color: '#0b1e3f' }, { offset: 1, color: '#d8ecff' }], reverse: false })] },
  ] },
  { id: 'black-white', name: 'Black & White', presets: [
    { id: 'classic', name: 'Classic', layers: [L('black-white', {})] },
    { id: 'high-contrast', name: 'High Contrast', layers: [L('black-white', { reds: 120, yellows: 120, greens: -10, cyans: -50, blues: -50, magentas: 120 }), L('curves', { rgb: curve([0, 0], [64, 48], [192, 210], [255, 255]) })] },
    { id: 'infrared', name: 'Infrared', layers: [L('black-white', { reds: -40, yellows: 235, greens: 144, cyans: -68, blues: -3, magentas: -107 })] },
  ] },
  { id: 'cinematic', name: 'Cinematic', presets: [
    { id: 'teal-orange', name: 'Teal and Orange', layers: [L('color-balance', { shadows: [-15, 0, 20], midtones: [0, 0, 0], highlights: [15, 0, -15], preserveLuminosity: true })] },
    { id: 'moody', name: 'Moody', layers: [L('curves', { rgb: curve([0, 15], [128, 110], [255, 240]) }), L('hue-saturation', { saturation: -25 })] },
    { id: 'film-grain', name: 'Film Grain', layers: [L('curves', { rgb: curve([0, 12], [255, 245]) }), L('grain', { amount: 35, size: 25, roughness: 60 })] },
  ] },
].map((g) => Object.freeze({ ...g, presets: Object.freeze(g.presets.map((p) => Object.freeze(p))) })));

export { clone as clonePresetData };
