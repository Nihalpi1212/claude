// Photoshop action descriptors for the preset files (preset-files-manager): a small typed writer, and the reading
// helpers over ag-psd's reader. Pure and Node-safe.
//
// Writing. ag-psd's own descriptor writer picks each value's type from its key, so it can only write keys it knows;
// the preset files (.grd, .tpl, the frame of .asl) hold keys it does not. This writer writes exactly the typed nodes it
// is given, the same node shape as lib/brush/abr.js's writer (so a brush descriptor built there nests here):
//   { t: 'TEXT', v }  { t: 'bool', v }  { t: 'long', v }  { t: 'doub', v }  { t: 'UntF', units: '#Prc', v }
//   { t: 'enum', type, v }  { t: 'Objc', classId, items: { key: node } }  { t: 'VlLs', v: node[] }  { t: 'tdta', v: bytes }
//   { t: 'raw', bytes }  an Objc value already written (ag-psd's writer for keys it knows: a style's 'Lefx')
// Reading goes through ag-psd's readVersionAndDescriptor (#ag-psd), which gives plain values: UntF as { units, value },
// enums as 'Type.value', objects with _classID when asked.
import { Writer, Reader } from './bytes.js';

export const T = {
  text: (v) => ({ t: 'TEXT', v: String(v ?? '') }),
  bool: (v) => ({ t: 'bool', v: !!v }),
  long: (v) => ({ t: 'long', v: Math.round(Number(v) || 0) }),
  doub: (v) => ({ t: 'doub', v: Number(v) || 0 }),
  px: (v) => ({ t: 'UntF', units: '#Pxl', v: Number(v) || 0 }),
  pct: (v) => ({ t: 'UntF', units: '#Prc', v: (Number(v) || 0) * 100 }),
  pctOf: (v) => ({ t: 'UntF', units: '#Prc', v: Number(v) || 0 }),
  ang: (v) => ({ t: 'UntF', units: '#Ang', v: Number(v) || 0 }),
  pnt: (v) => ({ t: 'UntF', units: '#Pnt', v: Number(v) || 0 }),
  enm: (type, v) => ({ t: 'enum', type, v }),
  obj: (classId, items) => ({ t: 'Objc', classId, items }),
  list: (values) => ({ t: 'VlLs', v: values }),
  data: (bytes) => ({ t: 'tdta', v: bytes }),
  raw: (bytes) => ({ t: 'raw', bytes }),
};

/** A key or class id: four characters as a class id (length 0), else a length-prefixed ASCII string. */
function key(w, s) {
  const str = String(s ?? '');
  if (str.length === 4) {
    w.u32(0);
    w.sig(str);
  } else {
    w.u32(str.length);
    for (let i = 0; i < str.length; i++) w.u8(str.charCodeAt(i));
  }
}

function value(w, node) {
  switch (node.t) {
    case 'TEXT': w.ustr(node.v); break;
    case 'bool': w.u8(node.v ? 1 : 0); break;
    case 'long': w.i32(node.v); break;
    case 'doub': w.f64(node.v); break;
    case 'UntF': w.sig(node.units); w.f64(node.v); break;
    case 'enum': key(w, node.type); key(w, node.v); break;
    case 'Objc': structure(w, node); break;
    case 'raw': w.bytes(node.bytes); break;
    case 'tdta': w.u32(node.v.length); w.bytes(node.v); break;
    case 'VlLs':
      w.u32(node.v.length);
      for (const item of node.v) {
        w.sig(item.t === 'raw' ? 'Objc' : item.t);
        value(w, item);
      }
      break;
    default: throw new Error(`no descriptor writer for ${node.t}`);
  }
}

function structure(w, node) {
  w.ustr(node.name ?? '');
  key(w, node.classId);
  const entries = Object.entries(node.items ?? {}).filter(([, v]) => v);
  w.u32(entries.length);
  for (const [k, v] of entries) {
    key(w, k);
    w.sig(v.t === 'raw' ? 'Objc' : v.t);
    value(w, v);
  }
}

/** Writes a descriptor (version 16, then the structure) of an Objc node into a Writer. */
export function writeDescriptor(w, node) {
  w.u32(16);
  structure(w, node);
}

/** The bytes of a version-16 descriptor of an Objc node. */
export function descriptorBytes(node) {
  const w = new Writer();
  writeDescriptor(w, node);
  return w.done();
}

/**
 * An Objc value written by ag-psd's writer (for keys ag-psd knows, such as a layer style's effects): `bytes` of a
 * writeVersionAndDescriptor call; the version is dropped and the class id replaced, so it nests as a `raw` node.
 */
export function rawObjcFromAgPsd(bytes, classId) {
  // version (4) | name: u32 count + UTF-16 | class id: u32 0 + 4 chars, or u32 length + ASCII | the items
  const r = new Reader(bytes, 4);
  const n = r.u32();
  r.skip(n * 2);
  const len = r.u32();
  r.skip(len === 0 ? 4 : len);
  const head = new Writer(64);
  head.ustr('');
  key(head, classId);
  const out = new Uint8Array(head.n + (bytes.length - r.o));
  out.set(head.done(), 0);
  out.set(bytes.subarray(r.o), head.n);
  return T.raw(out);
}

// ---- reading helpers (plain values from ag-psd's reader) ---------------------------------------------------------

/** The value of an enum string 'Type.value' (ag-psd's form), or the string itself. */
export const enumValue = (v) => (typeof v === 'string' && v.includes('.') ? v.slice(v.indexOf('.') + 1) : v);
/** A UnitFloat's number (or a plain number). */
export const unitValue = (v, d = 0) => (typeof v === 'number' ? v : typeof v?.value === 'number' ? v.value : d);

/** The colour object convert.js rgbFromPsd reads ({ r, g, b } | { c, m, y, k } | { l, a, b } | { k } | { h°, s%, b% } | float rgb) of a colour descriptor. */
export function colorFromDescriptor(c) {
  if (!c || typeof c !== 'object') return null;
  if ('Rd  ' in c) return { r: Number(c['Rd  ']) || 0, g: Number(c['Grn ']) || 0, b: Number(c['Bl  ']) || 0 };
  if ('redFloat' in c) return { fr: Number(c.redFloat) || 0, fg: Number(c.greenFloat) || 0, fb: Number(c.blueFloat) || 0 };
  if ('Cyn ' in c) return { c: Number(c['Cyn ']) || 0, m: Number(c.Mgnt) || 0, y: Number(c['Ylw ']) || 0, k: Number(c.Blck) || 0 };
  if ('Lmnc' in c) return { l: Number(c.Lmnc) || 0, a: Number(c['A   ']) || 0, b: Number(c['B   ']) || 0 };
  if ('Gry ' in c) return { k: Number(c['Gry ']) || 0 };
  if ('H   ' in c) return { h: unitValue(c['H   ']), s: Number(c.Strt) || 0, b: Number(c.Brgh) || 0 }; // degrees and percents, as convert.js hsbHex reads them
  return null;
}

/** An RGBC colour node for '#rrggbb'. */
export function rgbNode(hex) {
  const h = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))?.[1] ?? '000000';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return T.obj('RGBC', { 'Rd  ': T.doub(r), 'Grn ': T.doub(g), 'Bl  ': T.doub(b) });
}
