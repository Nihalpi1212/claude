// Font tables (type-fonts, ARCHITECTURE.md "0.5 features", package 12; S11.1). Pure: no DOM, no HarfBuzz, so Node
// unit tests read the fixture fonts with it and the catalog reads slices of installed fonts without loading them.
//
// It reads what the font menu needs from an OpenType / TrueType file (a .ttc collection too): the names (family,
// style, PostScript name), OS/2 weight, width, italic, the classification fields (sFamilyClass, PANOSE), post's fixed
// pitch flag, a few metrics for "similar fonts", and fvar's axes and named instances (variable fonts). classify()
// turns the classification fields into the menu's filter classes.

const u8 = (b, o) => b[o];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const i16 = (b, o) => ((u16(b, o) << 16) >> 16);
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const fixed = (b, o) => (u32(b, o) | 0) / 65536;
const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Number of faces in a file (1 unless a 'ttcf' collection). */
export function faceCountOf(bytes) {
  if (!bytes || bytes.length < 12 || tagAt(bytes, 0) !== 'ttcf') return 1;
  return Math.max(1, u32(bytes, 8));
}

/** True when the bytes start like a font file we can read (TrueType, OpenType CFF, a collection). */
export function isFontFile(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const t = tagAt(bytes, 0);
  return t === 'ttcf' || t === 'OTTO' || t === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
}

/**
 * The table directory of face `index`: Map(tag -> { offset, length }), offsets from the start of the file. Returns
 * null when the bytes are not a font or the directory lies outside them (a slice too short).
 */
export function tableDirectory(bytes, index = 0) {
  if (!isFontFile(bytes)) return null;
  let at = 0;
  if (tagAt(bytes, 0) === 'ttcf') {
    const n = u32(bytes, 8);
    if (index >= n || bytes.length < 12 + 4 * (index + 1)) return null;
    at = u32(bytes, 12 + 4 * index);
  }
  if (at + 12 > bytes.length) return null;
  const numTables = u16(bytes, at + 4);
  if (at + 12 + numTables * 16 > bytes.length) return null;
  const out = new Map();
  for (let i = 0; i < numTables; i++) {
    const r = at + 12 + i * 16;
    out.set(tagAt(bytes, r), { offset: u32(bytes, r + 8), length: u32(bytes, r + 12) });
  }
  return out;
}

/** The bytes of one table (a view), or null when absent or beyond the bytes given. */
export function tableBytes(bytes, dir, tag) {
  const t = dir?.get(tag);
  if (!t || t.offset + t.length > bytes.length || !t.length) return null;
  return bytes.subarray(t.offset, t.offset + t.length);
}

// ---- name ---------------------------------------------------------------------------------------------------------

const MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
function decodeName(b, o, len, platform, encoding) {
  if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0))) {
    let s = '';
    for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(u16(b, o + i));
    return s;
  }
  if (platform === 1 && encoding === 0) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = b[o + i];
      s += c < 128 ? String.fromCharCode(c) : MAC_ROMAN_HIGH[c - 128] ?? '?';
    }
    return s;
  }
  return null;
}

/**
 * The name table: Map(nameId -> string), English names preferred (Windows en-US, then any Windows or Unicode name,
 * then Macintosh English).
 */
export function readNames(table) {
  const out = new Map();
  if (!table || table.length < 6) return out;
  const count = u16(table, 2);
  const strings = u16(table, 4);
  const rank = new Map(); // nameId -> rank of the record kept (lower is better)
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > table.length) break;
    const platform = u16(table, r), encoding = u16(table, r + 2), language = u16(table, r + 4), id = u16(table, r + 6);
    const len = u16(table, r + 8), off = strings + u16(table, r + 10);
    if (off + len > table.length) continue;
    const score = platform === 3 && language === 0x409 ? 0 : platform === 3 && (language & 0xff) === 0x09 ? 1 : platform === 0 ? 2 : platform === 1 && language === 0 ? 3 : platform === 3 ? 4 : 9;
    if (rank.has(id) && rank.get(id) <= score) continue;
    const s = decodeName(table, off, len, platform, encoding);
    if (s === null) continue;
    out.set(id, s.replace(/\0/g, '').trim());
    rank.set(id, score);
  }
  return out;
}

// ---- OS/2, post, head, hhea ----------------------------------------------------------------------------------------

/** OS/2: weight, width, selection flags, classification, PANOSE and the x / cap heights (0 when the version lacks them). */
export function readOS2(table) {
  if (!table || table.length < 68) return null;
  const version = u16(table, 0);
  return {
    version,
    avgCharWidth: i16(table, 2),
    weightClass: u16(table, 4),
    widthClass: u16(table, 6),
    familyClass: u8(table, 30),
    familySubclass: u8(table, 31),
    panose: Array.from(table.subarray(32, 42)),
    vendor: tagAt(table, 58),
    fsSelection: u16(table, 62),
    xHeight: version >= 2 && table.length >= 90 ? i16(table, 86) : 0,
    capHeight: version >= 2 && table.length >= 90 ? i16(table, 88) : 0,
  };
}

export const readPost = (table) => (table && table.length >= 16 ? { italicAngle: fixed(table, 4), isFixedPitch: u32(table, 12) !== 0 } : null);
export const readHead = (table) => (table && table.length >= 54 ? { unitsPerEm: u16(table, 18) || 1000, macStyle: u16(table, 44) } : null);

// ---- fvar ---------------------------------------------------------------------------------------------------------

const AXIS_NAMES = { wght: 'Weight', wdth: 'Width', slnt: 'Slant', ital: 'Italic', opsz: 'Optical Size' };

/**
 * fvar: { axes: [{ tag, name, min, default, max, hidden }], instances: [{ name, postScriptName | null, coords }] }, or
 * null for a font that is not variable. Names come from the name table (`names`).
 */
export function readFvar(table, names = new Map()) {
  if (!table || table.length < 16) return null;
  const axesOffset = u16(table, 4);
  const axisCount = u16(table, 8), axisSize = u16(table, 10);
  const instanceCount = u16(table, 12), instanceSize = u16(table, 14);
  if (!axisCount || axisSize < 20) return null;
  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const o = axesOffset + i * axisSize;
    if (o + 20 > table.length) return null;
    const tag = tagAt(table, o);
    const nameId = u16(table, o + 18);
    axes.push({ tag, name: names.get(nameId) || AXIS_NAMES[tag] || tag, min: fixed(table, o + 4), default: fixed(table, o + 8), max: fixed(table, o + 12), hidden: !!(u16(table, o + 16) & 1) });
  }
  const instances = [];
  const base = axesOffset + axisCount * axisSize;
  const hasPsName = instanceSize >= axisCount * 4 + 6;
  for (let i = 0; i < instanceCount; i++) {
    const o = base + i * instanceSize;
    if (o + 4 + axisCount * 4 > table.length) break;
    const coords = {};
    axes.forEach((a, k) => (coords[a.tag] = fixed(table, o + 4 + k * 4)));
    const psId = hasPsName ? u16(table, o + 4 + axisCount * 4) : 0xffff;
    instances.push({ name: names.get(u16(table, o)) || '', postScriptName: psId !== 0xffff && psId ? names.get(psId) || null : null, coords });
  }
  return { axes, instances };
}

/**
 * A named instance's PostScript name when the font does not give one: Adobe Technical Note #5902 (the variations
 * prefix, name 25, else the family without spaces; then '-' and the instance name without spaces).
 */
export function instancePostScriptName(prefix, instanceName) {
  const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');
  return `${clean(prefix)}-${clean(instanceName) || 'Regular'}`.slice(0, 63);
}

// ---- classification -------------------------------------------------------------------------------------------------

/** The font menu's classes (S11.1 FontClass). */
export const FONT_CLASSES = ['serif', 'sans-serif', 'slab-serif', 'script', 'handwritten', 'monospace', 'decorative', 'blackletter'];

const NAME_RULES = [
  [/fraktur|blackletter|textura|schwabacher|old english|gothic (text|blackletter)/i, 'blackletter'],
  [/\bmono\b|mono$|monospace|\bcode\b|courier|consolas|menlo|monaco|typewriter|fixed/i, 'monospace'],
  [/slab|rockwell|clarendon|courier/i, 'slab-serif'],
  [/hand|marker|brush|comic|chalk|crayon|kalam|caveat|permanent/i, 'handwritten'],
  [/script|cursive|calligraph|chancery|swash|zapfino|vivaldi|lucida handwriting/i, 'script'],
  [/display|decor|stencil|poster|shadow|outline|impact|ornament|dingbat|symbol|emoji/i, 'decorative'],
  [/\bsans\b|grotesk|grotesque|gothic|arial|helvetica|verdana|tahoma|segoe|roboto|inter\b|calibri|carlito|ubuntu|cantarell|lato|open sans|noto sans|dejavu sans|futura|avenir|gill|optima|trebuchet|franklin|frutiger|myriad|source sans|fira sans/i, 'sans-serif'],
  [/serif|roman|times|georgia|garamond|baskerville|bodoni|caslon|didot|palatino|cambria|caladea|book|minion|merriweather|tinos|antiqua|constantia/i, 'serif'],
];

/** A class from a family name alone (for installed families whose bytes Pigment has not read), or null. */
export function classifyName(family) {
  const f = String(family ?? '');
  for (const [re, cls] of NAME_RULES) if (re.test(f)) return cls;
  return null;
}

/**
 * The menu class of a face from its classification fields: { familyClass, familySubclass, panose, isFixedPitch, family }.
 * Fixed pitch (post) or a monospaced PANOSE proportion first, then PANOSE's family kind and serif style, then the IBM
 * family class, then the name. Returns null when nothing says.
 */
export function classify({ familyClass = 0, familySubclass = 0, panose = null, isFixedPitch = false, family = '' } = {}) {
  const p = Array.isArray(panose) || ArrayBuffer.isView(panose) ? panose : null;
  const named = classifyName(family);
  if (named === 'blackletter') return 'blackletter';
  if (isFixedPitch || (p && p[0] === 2 && p[3] === 9)) return 'monospace';
  if (p && p[0] === 3) return familyClass === 10 && [3, 5, 7].includes(familySubclass) ? 'script' : named === 'script' ? 'script' : 'handwritten';
  if (p && (p[0] === 4 || p[0] === 5)) return 'decorative';
  if (familyClass === 10) return [2, 4, 6, 8].includes(familySubclass) ? 'handwritten' : 'script';
  if (familyClass === 9 || familyClass === 12) return 'decorative';
  if (familyClass === 4 || familyClass === 5) return 'slab-serif';
  if (p && p[0] === 2 && p[1] >= 2) {
    if (p[1] === 6 || p[1] === 7) return 'slab-serif';
    if (p[1] >= 11 && p[1] <= 13) return 'sans-serif';
    if (p[1] >= 2 && p[1] <= 10) return named === 'sans-serif' ? 'sans-serif' : 'serif';
    if (p[1] === 14 || p[1] === 15) return named ?? 'sans-serif';
  }
  if (familyClass === 8) return 'sans-serif';
  if ([1, 2, 3, 7].includes(familyClass)) return 'serif';
  return named;
}

// ---- the whole face -------------------------------------------------------------------------------------------------

const ITALIC_WORDS = /italic|oblique|kursiv|slanted/i;

/**
 * Everything the font menu keeps about face `index` of a file: names, weight / italic / stretch, classification,
 * metrics for similarity (per em), variable axes and named instances. Returns null when the bytes are not a font.
 */
export function fontInfo(bytes, index = 0) {
  const dir = tableDirectory(bytes, index);
  if (!dir) return null;
  return infoFromTables((tag) => tableBytes(bytes, dir, tag));
}

/** The tables fontInfo reads. */
export const INFO_TABLES = Object.freeze(['name', 'OS/2', 'post', 'head', 'fvar']);

/**
 * Where the tables fontInfo reads lie in a file, from its first bytes (which hold the table directory): [{ tag,
 * offset, length }]. The catalog reads only these slices of an installed font. Null when the head is not a font.
 */
export function infoTableSpans(head, index = 0) {
  const dir = tableDirectory(head, index);
  if (!dir) return null;
  return INFO_TABLES.filter((t) => dir.has(t)).map((tag) => ({ tag, ...dir.get(tag) }));
}

/** fontInfo from a table getter: get(tag) -> the table's bytes or null. */
export function infoFromTables(get) {
  const names = readNames(get('name'));
  const os2 = readOS2(get('OS/2'));
  const post = readPost(get('post'));
  const head = readHead(get('head'));
  const fvar = readFvar(get('fvar'), names);
  const family = names.get(16) || names.get(1) || '';
  const subfamily = names.get(17) || names.get(2) || 'Regular';
  const italic = !!(os2 && os2.fsSelection & 0x201) || !!(head && head.macStyle & 2) || ITALIC_WORDS.test(subfamily);
  const upem = head?.unitsPerEm ?? 1000;
  const info = {
    family,
    subfamily,
    fullName: names.get(4) || `${family} ${subfamily}`.trim(),
    postScriptName: names.get(6) || '',
    variationsPrefix: names.get(25) || null,
    weight: os2?.weightClass || (/bold/i.test(subfamily) ? 700 : 400),
    italic,
    stretch: os2?.widthClass || 5,
    classification: classify({ familyClass: os2?.familyClass ?? 0, familySubclass: os2?.familySubclass ?? 0, panose: os2?.panose ?? null, isFixedPitch: !!post?.isFixedPitch, family }),
    metrics: {
      xHeight: os2?.xHeight ? os2.xHeight / upem : null,
      capHeight: os2?.capHeight ? os2.capHeight / upem : null,
      avgWidth: os2?.avgCharWidth ? os2.avgCharWidth / upem : null,
    },
    variable: !!fvar,
    axes: fvar?.axes ?? [],
    instances: [],
  };
  if (fvar) {
    const prefix = info.variationsPrefix || family;
    info.instances = fvar.instances.map((inst) => {
      const name = inst.name || 'Regular';
      const coords = inst.coords;
      const wght = coords.wght;
      return {
        name,
        postScriptName: inst.postScriptName || instancePostScriptName(prefix, name),
        weight: Number.isFinite(wght) ? Math.round(wght) : info.weight,
        italic: info.italic || coords.ital >= 1 || (Number.isFinite(coords.slnt) && coords.slnt !== 0) || ITALIC_WORDS.test(name),
        coords,
      };
    });
  }
  return info;
}

/**
 * How alike two faces look, 0 (unrelated) .. 1, from their class, x-height, cap height, average width and weight:
 * the "similar fonts" filter of the font menu.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  let s = a.classification && a.classification === b.classification ? 0.4 : a.classification && b.classification ? 0 : 0.15;
  const near = (x, y, span) => (Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, 1 - Math.abs(x - y) / span) : 0.5);
  s += 0.2 * near(a.metrics?.xHeight, b.metrics?.xHeight, 0.15);
  s += 0.15 * near(a.metrics?.capHeight, b.metrics?.capHeight, 0.15);
  s += 0.15 * near(a.metrics?.avgWidth, b.metrics?.avgWidth, 0.25);
  s += 0.1 * near(a.weight, b.weight, 400);
  return Math.round(s * 1000) / 1000;
}
