// Open, save and export (see ARCHITECTURE.md "File formats"): raster images through the browser's
// decoders, PSD/PSB through ag-psd, and the native .pigment container (a ZIP with document.json
// plus one PNG per raster layer and mask).
import { readPsd, writePsdUint8Array, initializeCanvas } from 'ag-psd';
import { writeZip, readZip, findEntry, streamCodecs } from '../../shared/zip.js';
import { Document, RasterLayer, GroupLayer, TextLayer, AdjustmentLayer, createCanvas, layerFromDescription, canvasIsBlank } from './document.js';
import { parseColor } from '../../shared/pixels/color.js';
import { flattenDocument } from './compositor.js';
import { Selection } from './selection.js';

export const OPEN_EXTENSIONS = ['pigment', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'];
export const OPEN_FILTERS = [
  { name: 'All supported images', extensions: OPEN_EXTENSIONS },
  { name: 'Pigment documents', extensions: ['pigment'] },
  { name: 'Photoshop documents', extensions: ['psd', 'psb'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'] },
  { name: 'All files', extensions: ['*'] },
];
export const SAVE_FORMATS = {
  pigment: { name: 'Pigment document', ext: 'pigment', layered: true },
  psd: { name: 'Photoshop document', ext: 'psd', layered: true },
  png: { name: 'PNG image', ext: 'png', mime: 'image/png' },
  jpeg: { name: 'JPEG image', ext: 'jpg', mime: 'image/jpeg', lossy: true },
  webp: { name: 'WebP image', ext: 'webp', mime: 'image/webp', lossy: true },
};

initializeCanvas?.((w, h) => createCanvas(w, h));

export const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name ?? '')?.[1] ?? '').toLowerCase();
/** Extensions Pigment can write (anything else is read-only: saving must go through Save As). */
export const WRITE_EXTENSIONS = ['pigment', 'psd', 'png', 'jpg', 'jpeg', 'webp'];
export const canWritePath = (path) => WRITE_EXTENSIONS.includes(extOf(path));
export const baseName = (name) => String(name ?? 'Untitled').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

/** Decodes encoded image bytes (PNG/JPEG/WebP/GIF/BMP/AVIF/SVG/ICO) to a canvas. */
export async function decodeImage(bytes, name = '') {
  const ext = extOf(name);
  const type = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' }[ext] ?? sniffType(bytes);
  const blob = new Blob([bytes], { type });
  if (type === 'image/svg+xml') {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
      const c = createCanvas(w, h);
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  const c = createCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return c;
}

function sniffType(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x3c) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Opens bytes as a Document according to the file name's extension (content sniffing as fallback). */
export async function openDocument(bytes, { name = 'Untitled', path = null } = {}) {
  const ext = extOf(name);
  let doc;
  if (ext === 'pigment' || (bytes[0] === 0x50 && bytes[1] === 0x4b)) doc = await readPigment(bytes);
  else if (ext === 'psd' || ext === 'psb' || (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53)) doc = readPsdDocument(bytes);
  else {
    const canvas = await decodeImage(bytes, name);
    doc = new Document({ width: canvas.width, height: canvas.height, name: baseName(name) });
    const layer = new RasterLayer({ name: 'Background', canvas, x: 0, y: 0 });
    doc.root.children.push(layer);
    layer.parent = doc.root;
    doc.active = layer;
    doc.selected.add(layer);
  }
  doc.name = baseName(name);
  doc.path = path;
  doc.format = ext === 'jpg' ? 'jpeg' : ext || 'png';
  return doc;
}

// ---- .pigment -----------------------------------------------------------------------------------------------

export async function canvasToPng(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Serialises a document (layers, masks, selection, channels, guides, paths) to .pigment bytes. */
export async function writePigment(doc) {
  const description = doc.describe();
  const entries = [];
  const layers = doc.layers().filter((l) => !l.quickMask && !l.preview);
  for (const layer of layers) {
    if (layer.type === 'raster') entries.push({ name: `layers/${layer.id}.png`, data: await canvasToPng(layer.canvas) });
    if (layer.mask?.canvas) entries.push({ name: `masks/${layer.id}.png`, data: await canvasToPng(layer.mask.canvas) });
    if (layer.type === 'fill' && layer.paint?.type === 'pattern' && layer.paint.pattern?.canvas) entries.push({ name: `patterns/${layer.id}.png`, data: await canvasToPng(layer.paint.pattern.canvas) });
    // smart objects (lib/smart-object.js): a document source is a nested .pigment, an image source a PNG
    if (layer.type === 'smart' && layer.source) {
      if (layer.source.kind === 'document' && layer.source.doc) entries.push({ name: `smart/${layer.id}.pigment`, data: await writePigment(layer.source.doc) });
      else if (layer.source.canvas) entries.push({ name: `smart/${layer.id}.png`, data: await canvasToPng(layer.source.canvas) });
    }
  }
  if (doc.selection && !doc.selection.isEmpty) entries.push({ name: 'selection.bin', data: doc.selection.mask, compress: true });
  for (const ch of doc.channels) entries.push({ name: `channels/${ch.id}.bin`, data: ch.mask, compress: true });
  const flat = flattenDocument(doc);
  const scale = Math.min(1, 256 / Math.max(doc.width, doc.height));
  const thumb = createCanvas(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
  thumb.getContext('2d').drawImage(flat, 0, 0, thumb.width, thumb.height);
  entries.push({ name: 'thumbnail.png', data: await canvasToPng(thumb) });
  entries.unshift({ name: 'document.json', data: new TextEncoder().encode(JSON.stringify(description)), compress: true });
  entries.unshift({ name: 'mimetype', data: new TextEncoder().encode('application/x-pigment') });
  return writeZip(entries, { deflate: streamCodecs.deflate });
}

export async function readPigment(bytes) {
  const entries = await readZip(bytes, { inflate: streamCodecs.inflate });
  const json = findEntry(entries, 'document.json');
  if (!json) throw new Error('This is not a Pigment document (document.json is missing)');
  const d = JSON.parse(new TextDecoder().decode(json.data));
  if (d.app !== 'pigment') throw new Error('This is not a Pigment document');
  const doc = new Document({ width: d.width, height: d.height, dpi: d.dpi, name: d.name });
  doc.guides = Array.isArray(d.guides) ? d.guides : [];
  doc.paths = Array.isArray(d.paths) ? d.paths : [];
  doc.meta = d.meta ?? {};
  if (d.workPath?.subpaths) doc.workPath = d.workPath;
  if (d.globalLight && Number.isFinite(d.globalLight.angle)) doc.globalLight = { angle: d.globalLight.angle, altitude: d.globalLight.altitude ?? 30 };
  const image = async (name) => {
    const e = findEntry(entries, name);
    return e ? decodeImage(e.data, 'x.png') : null;
  };
  const build = async (desc, parent) => {
    const layer = layerFromDescription({ ...desc, children: undefined });
    if (layer.type === 'raster') {
      const canvas = await image(`layers/${desc.id}.png`);
      layer.canvas = canvas ?? createCanvas(desc.width ?? 1, desc.height ?? 1);
      layer.x = desc.x ?? 0;
      layer.y = desc.y ?? 0;
    }
    if (layer.type === 'fill') {
      layer.docWidth = doc.width;
      layer.docHeight = doc.height;
      if (layer.paint?.type === 'pattern') layer.paint.pattern = { ...(layer.paint.pattern ?? {}), canvas: await image(`patterns/${desc.id}.png`) };
    }
    if (desc.hasMask) {
      const canvas = await image(`masks/${desc.id}.png`);
      if (canvas) layer.mask = { canvas, enabled: desc.maskEnabled !== false, linked: desc.maskLinked !== false };
    }
    if (layer.type === 'smart' && typeof layer.setSource === 'function') {
      // smart objects (lib/smart-object.js): the layer was built from its description; its source follows
      const nested = findEntry(entries, `smart/${desc.id}.pigment`);
      if (nested) layer.setSource({ kind: 'document', doc: await readPigment(nested.data), name: desc.source?.name ?? null }, doc);
      else {
        const canvas = await image(`smart/${desc.id}.png`);
        if (canvas) layer.setSource({ kind: 'image', canvas, name: desc.source?.name ?? null }, doc);
      }
    }
    parent.children.push(layer);
    layer.parent = parent;
    if (layer.type === 'group') for (const child of desc.children ?? []) await build(child, layer);
    return layer;
  };
  for (const desc of d.layers ?? []) await build(desc, doc.root);
  const sel = findEntry(entries, 'selection.bin');
  if (sel && sel.data.length === doc.width * doc.height) doc.selection = Selection.fromMask(doc.width, doc.height, new Uint8ClampedArray(sel.data));
  for (const ch of d.channels ?? []) {
    const e = findEntry(entries, `channels/${ch.id}.bin`);
    if (e && e.data.length === doc.width * doc.height) doc.channels.push({ id: ch.id, name: ch.name, mask: new Uint8ClampedArray(e.data) });
  }
  const active = d.active ? doc.find(d.active) : null;
  doc.active = active ?? doc.root.children[doc.root.children.length - 1] ?? null;
  if (doc.active) doc.selected.add(doc.active);
  return doc;
}

// ---- PSD ----------------------------------------------------------------------------------------------------

const PSD_TO_BLEND = { 'pass through': 'pass-through', 'linear height': 'normal', height: 'normal', subtraction: 'subtract' };
const BLEND_TO_PSD = { 'pass-through': 'pass through' };
const psdBlend = (m) => PSD_TO_BLEND[m] ?? (m ? m.replace(/ /g, '-') : 'normal');
const toPsdBlend = (m) => BLEND_TO_PSD[m] ?? m.replace(/-/g, ' ');

/** Reads PSD/PSB bytes into a Document (layers, groups, masks, opacity, blend modes, clipping, text). */
export function readPsdDocument(bytes) {
  const psd = readPsd(bytes, { skipThumbnail: true, skipLinkedFilesData: true });
  const doc = new Document({ width: psd.width, height: psd.height });
  const res = psd.imageResources?.resolutionInfo;
  if (res?.horizontalResolution) doc.dpi = Math.round(res.horizontalResolution);
  const convert = (pl, parent) => {
    let layer;
    const common = {
      name: pl.name ?? 'Layer',
      visible: !pl.hidden,
      opacity: pl.opacity ?? 1,
      fillOpacity: pl.fillOpacity ?? 1,
      blend: psdBlend(pl.blendMode),
      clip: !!pl.clipping,
      locked: { transparency: !!pl.protected?.transparency, pixels: !!pl.protected?.composite, position: !!pl.protected?.position, all: false },
    };
    if (pl.children) {
      layer = new GroupLayer({ ...common, expanded: !!pl.opened });
      if (layer.blend === 'normal' && pl.blendMode === 'pass through') layer.blend = 'pass-through';
      parent.children.push(layer);
      layer.parent = parent;
      for (const child of pl.children) convert(child, layer);
    } else {
      const left = pl.left ?? 0, top = pl.top ?? 0;
      const adj = pl.adjustment && adjustmentFromPsd(pl.adjustment);
      if (adj) {
        layer = new AdjustmentLayer({ ...common, kind: adj.kind, params: adj.params });
        if (!(pl.mask?.canvas && !pl.mask.fromVectorData)) {
          // Photoshop adjustment layers always carry a mask; an absent one means "reveal all"
          const m = createCanvas(doc.width, doc.height);
          m.getContext('2d').fillStyle = '#fff';
          m.getContext('2d').fillRect(0, 0, doc.width, doc.height);
          layer.mask = { canvas: m, enabled: true, linked: true };
        }
      } else if (pl.adjustment) {
        // an adjustment Pigment has no equivalent for: keep the slot so the layer order survives
        layer = new RasterLayer({ ...common, name: `${common.name} (${pl.adjustment.type})`, visible: false, canvas: createCanvas(1, 1), x: 0, y: 0 });
      } else if (pl.text?.text) {
        layer = textLayerFromPsd(pl, common, left, top);
      } else {
        const canvas = pl.canvas ?? createCanvas(Math.max(1, (pl.right ?? 1) - left), Math.max(1, (pl.bottom ?? 1) - top));
        layer = new RasterLayer({ ...common, canvas, x: left, y: top });
      }
      parent.children.push(layer);
      layer.parent = parent;
    }
    if (pl.mask?.canvas && !pl.mask.fromVectorData) {
      const m = createCanvas(doc.width, doc.height);
      const mctx = m.getContext('2d');
      const def = pl.mask.defaultColor ?? 255;
      mctx.fillStyle = def >= 128 ? '#fff' : 'rgba(0,0,0,0)';
      mctx.fillRect(0, 0, doc.width, doc.height);
      // PSD masks are greyscale (white = visible): convert luminance to alpha
      const src = pl.mask.canvas;
      const sctx = src.getContext('2d', { willReadFrequently: true });
      const img = sctx.getImageData(0, 0, src.width, src.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = img.data[i];
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = v;
      }
      const tmp = createCanvas(src.width, src.height);
      tmp.getContext('2d').putImageData(img, 0, 0);
      mctx.clearRect(pl.mask.left ?? 0, pl.mask.top ?? 0, src.width, src.height);
      mctx.drawImage(tmp, pl.mask.left ?? 0, pl.mask.top ?? 0);
      layer.mask = { canvas: m, enabled: !pl.mask.disabled, linked: true };
    }
    return layer;
  };
  if (psd.children?.length) for (const pl of psd.children) convert(pl, doc.root);
  else if (psd.canvas) {
    const layer = new RasterLayer({ name: 'Background', canvas: psd.canvas, x: 0, y: 0 });
    doc.root.children.push(layer);
    layer.parent = doc.root;
  }
  doc.active = doc.root.children[doc.root.children.length - 1] ?? null;
  if (doc.active) doc.selected.add(doc.active);
  return doc;
}

function rgbFromPsd(c, fallback = '#000000') {
  if (!c) return fallback;
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  if ('r' in c) return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  if ('c' in c && 'k' in c) return `#${h(255 * (1 - c.c / 100) * (1 - c.k / 100))}${h(255 * (1 - c.m / 100) * (1 - c.k / 100))}${h(255 * (1 - c.y / 100) * (1 - c.k / 100))}`;
  if ('k' in c) return `#${h(255 * (1 - c.k / 100)).repeat(3)}`;
  if ('h' in c) return hsbHex(c.h, c.s, c.b);
  if ('l' in c && 'a' in c) return c.l > 50 ? '#ffffff' : '#000000';
  return fallback;
}
function hsbHex(h, s, b) {
  const [r, g, bl] = hsbToRgb(h / 360, s / 100, b / 100);
  const hx = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(bl)}`;
}
function hsbToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}
const psdColor = (hex) => {
  const [r, g, b] = parseColor(hex);
  return { r, g, b };
};

/** Turns a PostScript font name (ArialMT, Arial-BoldMT, TimesNewRomanPS-ItalicMT) into a CSS family. */
export function cssFamilyFromPsFont(name) {
  if (!name) return 'Arial';
  if (/\s/.test(name)) return name; // already a family name (Pigment writes those)
  let n = name.replace(/(PS)?MT$/, '').replace(/-[A-Za-z]+$/, '').replace(/PS$/, '');
  n = n.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return n.trim() || name;
}

const JUSTIFY_TO_ALIGN = { left: 'left', right: 'right', center: 'center', 'justify-left': 'left', 'justify-right': 'right', 'justify-center': 'center', 'justify-all': 'left' };

/** Builds an editable TextLayer from ag-psd text data (fonts are matched by family name; one style per layer). */
function textLayerFromPsd(pl, common, left, top) {
  const t = pl.text;
  const st = t.style ?? t.styleRuns?.[0]?.style ?? {};
  const m = Array.isArray(t.transform) && t.transform.length === 6 ? t.transform : [1, 0, 0, 1, left, top];
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const size = Math.max(1, (st.fontSize ?? 24) * scale);
  const psName = st.font?.name ?? '';
  const font = {
    family: cssFamilyFromPsFont(psName),
    size,
    weight: st.fauxBold || /bold|black|heavy|semibold/i.test(psName.replace(/^[^-]*/, '')) ? 700 : 400,
    italic: !!st.fauxItalic || /italic|oblique/i.test(psName.replace(/^[^-]*/, '')),
    underline: !!st.underline,
    color: rgbFromPsd(st.fillColor),
    align: JUSTIFY_TO_ALIGN[t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style?.justification] ?? 'left',
    lineHeight: st.leading && st.autoLeading === false && st.fontSize ? Math.max(0.5, st.leading / st.fontSize) : 1.2,
    letterSpacing: st.tracking ? (st.tracking / 1000) * size : 0,
    ...(t.orientation === 'vertical' ? { orientation: 'vertical' } : {}),
  };
  const ascent = size * 0.8;
  // linear part with the scale divided out: identity means plain, unrotated text
  const lin = [m[0] / scale, m[1] / scale, m[2] / scale, m[3] / scale];
  const plain = Math.abs(lin[0] - 1) < 1e-3 && Math.abs(lin[3] - 1) < 1e-3 && Math.abs(lin[1]) < 1e-3 && Math.abs(lin[2]) < 1e-3;
  const box = t.shapeType === 'box' && Array.isArray(t.boxBounds) && t.boxBounds.length === 4 ? t.boxBounds : null;
  const width = box ? Math.max(size, (box[2] - box[0]) * scale) : null;
  // text space has its origin on the first baseline; Pigment's box starts one ascent above it
  const ox = box ? box[0] * scale : 0, oy = box ? box[1] * scale + ascent : 0;
  const props = { ...common, text: t.text.replace(/\r/g, '\n'), font, width };
  if (plain) {
    props.x = m[4] + ox;
    props.y = m[5] - ascent + oy;
  } else {
    props.x = ox;
    props.y = oy - ascent;
    props.transform = [lin[0], lin[1], lin[2], lin[3], m[4], m[5]];
  }
  return new TextLayer(props);
}

/** PSD text data for a Pigment text layer (placed on the first baseline like Photoshop). */
function textToPsd(layer) {
  const f = layer.font, ascent = f.size * 0.8;
  const base = [1, 0, 0, 1, layer.x, layer.y + ascent];
  let transform = base;
  if (layer.transform) {
    const [a, b, c, d, e, g] = layer.transform;
    transform = [a, b, c, d, a * base[4] + c * base[5] + e, b * base[4] + d * base[5] + g];
  }
  const out = {
    text: layer.text,
    orientation: f.orientation === 'vertical' ? 'vertical' : 'horizontal',
    transform,
    shapeType: layer.width === null ? 'point' : 'box',
    style: {
      font: { name: f.family },
      fontSize: f.size,
      fillColor: psdColor(f.color),
      fauxBold: (f.weight ?? 400) >= 600,
      fauxItalic: !!f.italic,
      underline: !!f.underline,
      autoLeading: Math.abs((f.lineHeight ?? 1.2) - 1.2) < 1e-6,
      leading: f.size * (f.lineHeight ?? 1.2),
      tracking: f.size ? Math.round(((f.letterSpacing ?? 0) / f.size) * 1000) : 0,
    },
    paragraphStyle: { justification: ['left', 'right', 'center'].includes(f.align) ? f.align : 'left' },
  };
  if (layer.width !== null) {
    const lay = layer.layout();
    out.boxBounds = [0, -ascent, layer.width, Math.max(lay.height, lay.lineHeight) - ascent];
  }
  return out;
}

// ---- adjustment layers <-> PSD -------------------------------------------------------------------------------
const lv = (c) => (c ? { shadowInput: c.inBlack ?? 0, highlightInput: c.inWhite ?? 255, shadowOutput: c.outBlack ?? 0, highlightOutput: c.outWhite ?? 255, midtoneInput: c.gamma ?? 1 } : undefined);
const lvBack = (c) => (c ? { inBlack: c.shadowInput ?? 0, inWhite: c.highlightInput ?? 255, gamma: c.midtoneInput ?? 1, outBlack: c.shadowOutput ?? 0, outWhite: c.highlightOutput ?? 255 } : null);
const cv = (pts) => (Array.isArray(pts) ? pts.map(([input, output]) => ({ input, output })) : undefined);
const cvBack = (pts) => (Array.isArray(pts) && pts.length ? pts.map((p) => [p.input, p.output]) : null);
const hueCh = (p) => ({ a: 0, b: 0, c: 0, d: 0, hue: p?.hue ?? 0, saturation: p?.saturation ?? 0, lightness: p?.lightness ?? 0 });
const ZERO_HUE = { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 };
const cb = (v) => ({ cyanRed: v?.[0] ?? 0, magentaGreen: v?.[1] ?? 0, yellowBlue: v?.[2] ?? 0 });
const cbBack = (v) => [v?.cyanRed ?? 0, v?.magentaGreen ?? 0, v?.yellowBlue ?? 0];
const mix = (c) => ({ red: c?.r ?? 0, green: c?.g ?? 0, blue: c?.b ?? 0, constant: c?.constant ?? 0 });
const mixBack = (c, def) => ({ r: c?.red ?? def.r, g: c?.green ?? def.g, b: c?.blue ?? def.b, constant: c?.constant ?? 0 });
const cmyk = (v) => ({ c: v?.c ?? 0, m: v?.m ?? 0, y: v?.y ?? 0, k: v?.k ?? 0 });
const SELECTIVE = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

/** PSD adjustment data for a Pigment adjustment layer, or null when the kind has no PSD equivalent. */
export function adjustmentToPsd(kind, p = {}) {
  switch (kind) {
    case 'invert': return { type: 'invert' };
    case 'brightness-contrast': return { type: 'brightness/contrast', brightness: p.brightness ?? 0, contrast: p.contrast ?? 0, useLegacy: !!p.legacy };
    case 'levels': return { type: 'levels', rgb: lv(p.rgb ?? {}), red: lv(p.r), green: lv(p.g), blue: lv(p.b) };
    case 'curves': return { type: 'curves', rgb: cv(p.rgb ?? [[0, 0], [255, 255]]), red: cv(p.r), green: cv(p.g), blue: cv(p.b) };
    case 'exposure': return { type: 'exposure', exposure: p.exposure ?? 0, offset: p.offset ?? 0, gamma: p.gamma ?? 1 };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance ?? 0, saturation: p.saturation ?? 0 };
    case 'hue-saturation': return { type: 'hue/saturation', master: hueCh(p), reds: ZERO_HUE, yellows: ZERO_HUE, greens: ZERO_HUE, cyans: ZERO_HUE, blues: ZERO_HUE, magentas: ZERO_HUE };
    case 'color-balance': return { type: 'color balance', shadows: cb(p.shadows), midtones: cb(p.midtones), highlights: cb(p.highlights), preserveLuminosity: p.preserveLuminosity !== false };
    case 'black-white': return { type: 'black & white', reds: p.reds ?? 40, yellows: p.yellows ?? 60, greens: p.greens ?? 40, cyans: p.cyans ?? 60, blues: p.blues ?? 20, magentas: p.magentas ?? 80, useTint: !!p.tint, tintColor: psdColor(p.tint || '#e6c8a0') };
    case 'photo-filter': return { type: 'photo filter', color: psdColor(p.color ?? '#ec8a00'), density: p.density ?? 25, preserveLuminosity: p.preserveLuminosity !== false };
    case 'channel-mixer': return { type: 'channel mixer', monochrome: !!p.monochrome, red: mix(p.r ?? { r: 100 }), green: mix(p.g ?? { g: 100 }), blue: mix(p.b ?? { b: 100 }), gray: mix(p.gray ?? { r: 40, g: 40, b: 20 }) };
    case 'posterize': return { type: 'posterize', levels: p.levels ?? 4 };
    case 'threshold': return { type: 'threshold', level: p.level ?? 128 };
    case 'gradient-map': {
      const stops = (p.stops?.length ? p.stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]).map((s) => ({ location: s.offset ?? s.pos ?? 0, midpoint: 0.5, color: psdColor(s.color) }));
      return { type: 'gradient map', name: 'Gradient', gradientType: 'solid', reverse: !!p.reverse, dither: false, smoothness: 1, colorStops: stops, opacityStops: [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }] };
    }
    case 'selective-color': return { type: 'selective color', mode: p.relative === false ? 'absolute' : 'relative', ...Object.fromEntries(SELECTIVE.map((k) => [k, cmyk(p[k])])) };
    default: return null;
  }
}

/** { kind, params } for ag-psd adjustment data, or null when Pigment has no such adjustment. */
export function adjustmentFromPsd(a) {
  if (!a?.type) return null;
  switch (a.type) {
    case 'invert': return { kind: 'invert', params: {} };
    case 'brightness/contrast': return { kind: 'brightness-contrast', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, legacy: !!a.useLegacy } };
    case 'levels': return { kind: 'levels', params: { perChannel: !!(a.red || a.green || a.blue), rgb: lvBack(a.rgb) ?? { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, r: lvBack(a.red), g: lvBack(a.green), b: lvBack(a.blue) } };
    case 'curves': return { kind: 'curves', params: { rgb: cvBack(a.rgb) ?? [[0, 0], [255, 255]], r: cvBack(a.red), g: cvBack(a.green), b: cvBack(a.blue) } };
    case 'exposure': return { kind: 'exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance': return { kind: 'vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': {
      const m = a.master ?? a.channels?.[0] ?? {};
      return { kind: 'hue-saturation', params: { hue: m.hue ?? 0, saturation: m.saturation ?? 0, lightness: m.lightness ?? 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' } };
    }
    case 'color balance': return { kind: 'color-balance', params: { shadows: cbBack(a.shadows), midtones: cbBack(a.midtones), highlights: cbBack(a.highlights), preserveLuminosity: a.preserveLuminosity !== false } };
    case 'black & white': return { kind: 'black-white', params: { reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80, tint: a.useTint ? rgbFromPsd(a.tintColor, '#e6c8a0') : null } };
    case 'photo filter': return { kind: 'photo-filter', params: { color: rgbFromPsd(a.color, '#ec8a00'), density: a.density ?? 25, preserveLuminosity: a.preserveLuminosity !== false } };
    case 'channel mixer': return { kind: 'channel-mixer', params: { r: mixBack(a.red, { r: 100, g: 0, b: 0 }), g: mixBack(a.green, { r: 0, g: 100, b: 0 }), b: mixBack(a.blue, { r: 0, g: 0, b: 100 }), gray: mixBack(a.gray, { r: 40, g: 40, b: 20 }), monochrome: !!a.monochrome } };
    case 'posterize': return { kind: 'posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold': return { kind: 'threshold', params: { level: a.level ?? 128 } };
    case 'gradient map': {
      const stops = (a.colorStops ?? []).map((s) => ({ offset: Math.max(0, Math.min(1, s.location ?? 0)), color: rgbFromPsd(s.color) }));
      return { kind: 'gradient-map', params: { stops: stops.length >= 2 ? stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: !!a.reverse } };
    }
    case 'selective color': return { kind: 'selective-color', params: { ...Object.fromEntries(SELECTIVE.map((k) => [k, cmyk(a[k])])), relative: a.mode !== 'absolute' } };
    default: return null;
  }
}

/** Writes a document as PSD (raster pixels for every layer; groups, masks, opacity, blend, clipping kept). */
export function writePsdDocument(doc, compositor) {
  // alpha mask -> greyscale PSD mask
  const maskOf = (layer) => {
    const m = layer.mask.canvas;
    const ctx = m.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, m.width, m.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3];
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a;
      img.data[i + 3] = 255;
    }
    const g = createCanvas(m.width, m.height);
    g.getContext('2d').putImageData(img, 0, 0);
    return { left: 0, top: 0, canvas: g, defaultColor: 0, disabled: !layer.mask.enabled };
  };
  const toPsd = (layer) => {
    const lk = layer.locked ?? {};
    const base = {
      name: layer.name,
      hidden: !layer.visible,
      opacity: layer.opacity,
      fillOpacity: layer.fillOpacity ?? 1,
      blendMode: toPsdBlend(layer.blend === 'pass-through' && !layer.isGroup ? 'normal' : layer.blend),
      clipping: layer.clip,
      protected: { transparency: !!(lk.transparency || lk.all), composite: !!(lk.pixels || lk.all), position: !!(lk.position || lk.all) },
    };
    if (layer.mask?.canvas) base.mask = maskOf(layer);
    if (layer.isGroup) return { ...base, opened: layer.expanded, children: layer.children.map(toPsd) };
    if (layer.type === 'adjustment') {
      const adjustment = adjustmentToPsd(layer.kind, layer.params);
      if (adjustment) return { ...base, adjustment };
      // no PSD equivalent: keep an empty hidden placeholder so the layer order survives
      return { ...base, name: `${layer.name} (${layer.kind})`, hidden: true, left: 0, top: 0, canvas: createCanvas(1, 1) };
    }
    let canvas, x = 0, y = 0;
    if (layer.type === 'raster') {
      canvas = layer.canvas;
      x = layer.x;
      y = layer.y;
    } else {
      const r = layer.render();
      canvas = r.canvas;
      x = r.x;
      y = r.y;
    }
    const out = { ...base, left: x, top: y, canvas };
    if (layer.type === 'text') out.text = textToPsd(layer);
    return out;
  };
  const psd = {
    width: doc.width,
    height: doc.height,
    children: doc.root.children.filter((l) => !l.quickMask && !l.preview).map(toPsd),
    canvas: flattenDocument(doc, compositor),
    imageResources: { resolutionInfo: { horizontalResolution: doc.dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: doc.dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } },
  };
  return writePsdUint8Array(psd, { generateThumbnail: true, noBackground: true });
}

// ---- export -------------------------------------------------------------------------------------------------

/**
 * Exports the flattened document (or a given canvas) as PNG/JPEG/WebP bytes.
 * opts: { format: 'png'|'jpeg'|'webp', quality 0..1, scale, width, height, background: hex|null (JPEG defaults to white), method }
 */
export async function exportImage(doc, opts = {}, compositor) {
  const format = opts.format ?? 'png';
  const info = SAVE_FORMATS[format] ?? SAVE_FORMATS.png;
  let canvas = opts.canvas ?? flattenDocument(doc, compositor);
  const w = Math.max(1, Math.round(opts.width ?? canvas.width * (opts.scale ?? 1)));
  const h = Math.max(1, Math.round(opts.height ?? canvas.height * (opts.scale ?? 1)));
  if (w !== canvas.width || h !== canvas.height || opts.background || format === 'jpeg') {
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    const bg = opts.background ?? (format === 'jpeg' ? '#ffffff' : null);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    canvas = out;
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`This system cannot encode ${info.name}`))), info.mime, info.lossy ? opts.quality ?? 0.92 : undefined));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Saves a document in the format implied by the path's extension. */
export async function encodeForPath(doc, path, compositor, exportOpts = {}) {
  const ext = extOf(path);
  if (ext === 'pigment') return writePigment(doc);
  if (ext === 'psd') return writePsdDocument(doc, compositor);
  if (!canWritePath(path)) throw new Error(`Pigment cannot write .${ext || '?'} files. Save as .pigment, .psd, .png, .jpg or .webp instead.`);
  const format = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
  return exportImage(doc, { ...exportOpts, format }, compositor);
}

/** True when saving to this path keeps all layers. */
export function isLayeredPath(path) {
  return ['pigment', 'psd'].includes(extOf(path));
}

export { canvasIsBlank };
