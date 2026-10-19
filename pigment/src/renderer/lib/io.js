// Open, save and export (see ARCHITECTURE.md "File formats"): raster images through the browser's
// decoders, PSD/PSB through ag-psd, and the native .pigment container (a ZIP with document.json
// plus one PNG per raster layer and mask).
import { readPsd, writePsdUint8Array, initializeCanvas } from 'ag-psd';
import { writeZip, readZip, findEntry, streamCodecs } from '../../shared/zip.js';
import { Document, RasterLayer, GroupLayer, TextLayer, createCanvas, layerFromDescription, canvasIsBlank } from './document.js';
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

async function canvasToPng(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode PNG'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Serialises a document (layers, masks, selection, channels, guides, paths) to .pigment bytes. */
export async function writePigment(doc) {
  const description = doc.describe();
  const entries = [];
  const layers = doc.layers();
  for (const layer of layers) {
    if (layer.type === 'raster') entries.push({ name: `layers/${layer.id}.png`, data: await canvasToPng(layer.canvas) });
    if (layer.mask?.canvas) entries.push({ name: `masks/${layer.id}.png`, data: await canvasToPng(layer.mask.canvas) });
    if (layer.type === 'fill' && layer.paint?.type === 'pattern' && layer.paint.pattern?.canvas) entries.push({ name: `patterns/${layer.id}.png`, data: await canvasToPng(layer.paint.pattern.canvas) });
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
      const canvas = pl.canvas ?? createCanvas(Math.max(1, (pl.right ?? 1) - left), Math.max(1, (pl.bottom ?? 1) - top));
      if (pl.text?.text && !pl.canvas) {
        layer = new TextLayer({ ...common, text: pl.text.text, x: left, y: top, font: { family: pl.text.style?.font?.name ?? 'Arial', size: pl.text.style?.fontSize ?? 24, color: rgbFromPsd(pl.text.style?.fillColor) } });
      } else {
        layer = new RasterLayer({ ...common, canvas, x: left, y: top });
        if (pl.text?.text) layer.psdText = pl.text.text;
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

function rgbFromPsd(c) {
  if (!c) return '#000000';
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  if ('r' in c) return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return '#000000';
}

/** Writes a document as PSD (raster pixels for every layer; groups, masks, opacity, blend, clipping kept). */
export function writePsdDocument(doc, compositor) {
  const toPsd = (layer) => {
    const base = { name: layer.name, hidden: !layer.visible, opacity: layer.opacity, blendMode: toPsdBlend(layer.blend === 'pass-through' && !layer.isGroup ? 'normal' : layer.blend), clipping: layer.clip };
    if (layer.isGroup) return { ...base, opened: layer.expanded, children: layer.children.filter((c) => c.type !== 'adjustment' || true).map(toPsd) };
    let canvas, x = 0, y = 0;
    if (layer.type === 'raster') {
      canvas = layer.canvas;
      x = layer.x;
      y = layer.y;
    } else if (layer.type === 'adjustment') {
      // adjustment layers are not round-tripped to PSD adjustment data; export them as empty layers named after the kind
      canvas = createCanvas(1, 1);
      base.name = `${layer.name} (${layer.kind})`;
      base.hidden = true;
    } else {
      const r = layer.render();
      canvas = r.canvas;
      x = r.x;
      y = r.y;
    }
    const out = { ...base, left: x, top: y, canvas };
    if (layer.type === 'text') out.name = layer.name;
    if (layer.mask?.canvas) {
      // alpha mask -> greyscale canvas
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
      out.mask = { left: 0, top: 0, canvas: g, defaultColor: 0, disabled: !layer.mask.enabled };
    }
    return out;
  };
  const psd = {
    width: doc.width,
    height: doc.height,
    children: doc.root.children.map(toPsd),
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
  const format = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
  return exportImage(doc, { ...exportOpts, format }, compositor);
}

/** True when saving to this path keeps all layers. */
export function isLayeredPath(path) {
  return ['pigment', 'psd'].includes(extOf(path));
}

export { canvasIsBlank };
