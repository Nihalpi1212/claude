// Open, save and export (see ARCHITECTURE.md "File formats"): raster images through the browser's
// decoders, PSD/PSB through ag-psd, and the native .pigment container (a ZIP with document.json
// plus one PNG per raster layer and mask).
import { initializeCanvas } from '#ag-psd';
import { writeZip, readZip, findEntry, streamCodecs } from '../../shared/zip.js';
import { DocStore } from './doc-store.js';
import { Document, RasterLayer, createCanvas, layerFromDescription, canvasIsBlank } from './document.js';
import { MODES } from '../../shared/pixels/modes.js';
import { flattenDocument } from './compositor.js';
import { Selection } from './selection.js';
import './psd/index.js'; // every PSD mapper registers (S4.1)
import { readPsdDocument } from './psd/read.js';
import { writePsdDocument } from './psd/write.js';

export const OPEN_EXTENSIONS = ['pigment', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'];
export const OPEN_FILTERS = [
  { name: 'All supported images', extensions: OPEN_EXTENSIONS },
  { name: 'Pigment documents', extensions: ['pigment'] },
  { name: 'Photoshop documents', extensions: ['psd', 'psb'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'] },
  { name: 'All files', extensions: ['*'] },
];
export const SAVE_FORMATS = {
  pigment: { name: 'Pigment document', ext: 'pigment', extensions: ['pigment'], layered: true },
  psd: { name: 'Photoshop document', ext: 'psd', extensions: ['psd'], layered: true },
  png: { name: 'PNG image', ext: 'png', extensions: ['png'], mime: 'image/png' },
  jpeg: { name: 'JPEG image', ext: 'jpg', extensions: ['jpg', 'jpeg'], mime: 'image/jpeg', lossy: true },
  webp: { name: 'WebP image', ext: 'webp', extensions: ['webp'], mime: 'image/webp', lossy: true },
};

initializeCanvas?.((w, h) => createCanvas(w, h));

// ---- format registries (0.3) --------------------------------------------------------------------------------
// Modules add readers and writers without editing this file: lib/depth.js (16-bit PNG, TIFF), lib/modes.js
// (GIF, PNG-8), later RAW and PDF importers. Built-in readers run after the registered ones.

/** @type {{ id: string, name: string, extensions: string[], test?: (bytes: Uint8Array, name: string) => boolean, read: (bytes: Uint8Array, info: { name: string, path: string|null }) => Promise<Document> }[]} */
export const OPEN_READERS = [];

/**
 * Registers a document reader. `test(bytes, name)` decides whether the reader takes the file (default: the
 * extension is one of `extensions`); `read` returns a Document (name/path/format are filled in afterwards).
 */
export function registerOpenFormat(def) {
  if (!def?.id || typeof def.read !== 'function') throw new Error('registerOpenFormat needs an id and read()');
  const existing = OPEN_READERS.findIndex((r) => r.id === def.id);
  if (existing >= 0) OPEN_READERS.splice(existing, 1);
  OPEN_READERS.push(def);
  for (const ext of def.extensions ?? []) if (!OPEN_EXTENSIONS.includes(ext)) OPEN_EXTENSIONS.push(ext);
  if (def.name && def.extensions?.length) {
    const all = OPEN_FILTERS.find((f) => f.name === 'All supported images');
    if (all) for (const ext of def.extensions) if (!all.extensions.includes(ext)) all.extensions.push(ext);
    if (!OPEN_FILTERS.some((f) => f.name === def.name)) OPEN_FILTERS.splice(Math.max(1, OPEN_FILTERS.length - 1), 0, { name: def.name, extensions: [...def.extensions] });
  }
}

/**
 * Registers an export/save format: SAVE_FORMATS[id] = { name, ext, extensions?, mime?, lossy?, layered?,
 * encode(doc, opts, compositor) -> Promise<Uint8Array>, options?: lib/form.js field specs shown in Export As
 * when the format is chosen (their values arrive in opts) }. encodeForPath() routes by extension.
 */
export function registerExportFormat(id, def) {
  if (!id || typeof def?.encode !== 'function' || !def.ext) throw new Error('registerExportFormat needs an id, ext and encode()');
  SAVE_FORMATS[id] = { ...def, id, extensions: def.extensions ?? [def.ext] };
  for (const ext of SAVE_FORMATS[id].extensions) if (!WRITE_EXTENSIONS.includes(ext)) WRITE_EXTENSIONS.push(ext);
}

/** The export format whose extension matches the path, or null. */
export function exportFormatForPath(path) {
  const ext = extOf(path);
  for (const [id, info] of Object.entries(SAVE_FORMATS)) if ((info.extensions ?? [info.ext]).includes(ext)) return { id, ...info };
  return null;
}

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

/**
 * Decodes any flat image File > Open can read to one canvas: the formats of the registered readers (TIFF, TGA,
 * 16-bit PNG, GIF with its colour table) as well as the browser's. Place, Import Image, Open as Smart Object and
 * Replace Contents list the same file types as Open, so they decode through here.
 */
export async function decodeImageFile(bytes, name = '') {
  const ext = extOf(name);
  const reader = OPEN_READERS.find((r) => (r.test ? r.test(bytes, name) : (r.extensions ?? []).includes(ext)));
  if (!reader) return decodeImage(bytes, name);
  const doc = await reader.read(bytes, { name, path: null });
  return flattenDocument(doc); // what the document shows (a colour table applied, 16 bits as their 8-bit proxy)
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
  // registered readers (16-bit PNG, TIFF, GIF with a colour table, ...) take precedence over the built-ins
  const reader = OPEN_READERS.find((r) => (r.test ? r.test(bytes, name) : (r.extensions ?? []).includes(ext)));
  if (reader) doc = await reader.read(bytes, { name, path });
  else if (ext === 'pigment' || (bytes[0] === 0x50 && bytes[1] === 0x4b)) doc = await readPigment(bytes);
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
  // smart objects: instances made by Duplicate Layer share one source; it is written once and every instance refers to it
  const sourceRefs = new Map(); // source -> id of the layer whose entry holds it
  for (const l of layers) if (l.type === 'smart' && l.source && !sourceRefs.has(l.source)) sourceRefs.set(l.source, l.id);
  const byId = new Map(layers.map((l) => [l.id, l]));
  const markRefs = (list) => {
    for (const ld of list ?? []) {
      const l = byId.get(ld.id);
      if (l?.type === 'smart') {
        const ref = sourceRefs.get(l.source);
        if (ref && ref !== l.id) ld.sourceRef = ref;
      }
      markRefs(ld.children);
    }
  };
  markRefs(description.layers);
  for (const layer of layers) {
    if (layer.type === 'raster') entries.push({ name: `layers/${layer.id}.png`, data: await canvasToPng(layer.canvas) });
    // 16/32-bit pixels (lib/depth.js): raw little-endian samples next to the 8-bit proxy, deflated by the container
    if (layer.type === 'raster' && layer.deep?.data) entries.push({ name: `layers/${layer.id}.${layer.deep.type}`, data: new Uint8Array(layer.deep.data.buffer, layer.deep.data.byteOffset, layer.deep.data.byteLength), compress: true });
    if (layer.mask?.canvas) entries.push({ name: `masks/${layer.id}.png`, data: await canvasToPng(layer.mask.canvas) });
    if (layer.type === 'fill' && layer.paint?.type === 'pattern' && layer.paint.pattern?.canvas) entries.push({ name: `patterns/${layer.id}.png`, data: await canvasToPng(layer.paint.pattern.canvas) });
    // smart objects (lib/smart-object.js): a document source is a nested .pigment, an image source a PNG
    if (layer.type === 'smart' && layer.source && sourceRefs.get(layer.source) === layer.id) {
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
  // a mode this version does not know (a damaged or newer file) opens as RGB, as an unknown depth opens as 8 bits
  const mode = typeof d.mode === 'string' && Object.prototype.hasOwnProperty.call(MODES, d.mode) ? d.mode : 'rgb';
  const doc = new Document({ width: d.width, height: d.height, dpi: d.dpi, name: d.name, mode, depth: [8, 16, 32].includes(d.depth) ? d.depth : 8 });
  if (Array.isArray(d.colorTable)) doc.colorTable = d.colorTable.filter((c) => Array.isArray(c) && c.length >= 3).map((c) => c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))));
  if (d.duotone && Array.isArray(d.duotone.inks)) doc.duotone = JSON.parse(JSON.stringify(d.duotone));
  // version 3 keeps the document collections in `store`; a version 2 file's guides come in through the legacy array
  doc.store = DocStore.fromJSON(doc, d.store, { guides: Array.isArray(d.guides) ? d.guides : [] });
  doc.paths = Array.isArray(d.paths) ? d.paths : [];
  doc.meta = d.meta ?? {};
  // a mode that lost what it shows its pixels with (the colour table, the spot channel state) is plain RGB: the
  // layers hold RGBA either way
  if ((doc.mode === 'indexed' && !doc.colorTable?.length) || (doc.mode === 'multichannel' && !doc.meta?.imageMode?.multichannel)) doc.mode = 'rgb';
  if (d.workPath?.subpaths) doc.workPath = d.workPath;
  if (d.globalLight && Number.isFinite(d.globalLight.angle)) doc.globalLight = { angle: d.globalLight.angle, altitude: d.globalLight.altitude ?? 30 };
  const smartSources = new Map(); // sourceRef -> the source shared by every instance that names it
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
      if (desc.deep === 'u16' || desc.deep === 'f32') {
        const e = findEntry(entries, `layers/${desc.id}.${desc.deep}`);
        const n = layer.canvas.width * layer.canvas.height * 4;
        const bytes = desc.deep === 'u16' ? 2 : 4;
        if (e && e.data.byteLength === n * bytes) {
          const buf = e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength); // aligned copy
          layer.deep = { type: desc.deep, data: desc.deep === 'u16' ? new Uint16Array(buf) : new Float32Array(buf) };
        }
      }
    }
    if (layer.type === 'fill') {
      layer.docWidth = doc.width;
      layer.docHeight = doc.height;
      if (layer.paint?.type === 'pattern') layer.paint.pattern = { ...(layer.paint.pattern ?? {}), canvas: await image(`patterns/${desc.id}.png`) };
    }
    if (desc.hasMask) {
      const canvas = await image(`masks/${desc.id}.png`);
      if (canvas) layer.mask = { canvas, enabled: desc.maskEnabled !== false, linked: desc.maskLinked !== false };
      // 0.4: density and feather (non-destructive, K.1) travel next to the mask; vectorMask and blending came in
      // through layerFromDescription
      if (layer.mask && Number.isFinite(desc.maskDensity)) layer.mask.density = Math.max(0, Math.min(1, desc.maskDensity));
      if (layer.mask && Number.isFinite(desc.maskFeather)) layer.mask.feather = Math.max(0, desc.maskFeather);
    }
    if (layer.type === 'smart' && typeof layer.setSource === 'function') {
      // smart objects (lib/smart-object.js): the layer was built from its description; its source follows. Instances
      // sharing one source name it with sourceRef and get the very same source object back
      const ref = typeof desc.sourceRef === 'string' && desc.sourceRef ? desc.sourceRef : desc.id;
      if (smartSources.has(ref)) layer.setSource(smartSources.get(ref), doc);
      else {
        const nested = findEntry(entries, `smart/${ref}.pigment`);
        if (nested) layer.setSource({ kind: 'document', doc: await readPigment(nested.data), name: desc.source?.name ?? null }, doc);
        else {
          const canvas = await image(`smart/${ref}.png`);
          if (canvas) layer.setSource({ kind: 'image', canvas, name: desc.source?.name ?? null }, doc);
        }
        if (nested || findEntry(entries, `smart/${ref}.png`)) smartSources.set(ref, layer.source);
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
// 0.5 (ARCHITECTURE.md "0.5 features", S4): the PSD code lives in lib/psd/ as registered mappers; importing
// lib/psd/index.js registers the built-ins and every mapper file (also in Node). These re-exports keep 0.4's names
// here (tests and callers import them from lib/io.js); the files that now hold them keep the exports (rule 2).
export { readPsdDocument } from './psd/read.js';
export { writePsdDocument } from './psd/write.js';
export { adjustmentToPsd, adjustmentFromPsd } from './psd/adjustments.js';
export { blendIfToPsd, blendIfFromPsd } from './psd/builtin.js';
export { psdExpressible, PSD_TEXT_KEYS, cssFamilyFromPsFont } from './psd/text.js';

// ---- export -------------------------------------------------------------------------------------------------

/**
 * Exports the flattened document (or a given canvas) as PNG/JPEG/WebP bytes.
 * opts: { format: 'png'|'jpeg'|'webp', quality 0..1, scale, width, height, background: hex|null (JPEG defaults to white), method }
 */
export async function exportImage(doc, opts = {}, compositor) {
  const format = opts.format ?? 'png';
  const info = SAVE_FORMATS[format] ?? SAVE_FORMATS.png;
  // formats added by registerExportFormat (GIF, PNG-8, 16-bit PNG, TIFF ...) bring their own encoder
  if (info.encode) return info.encode(doc, { ...opts, format }, compositor);
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
  if (ext === 'psd') return writePsdDocument(doc, compositor, exportOpts); // Maximize Compatibility resolved there (S4.4)
  if (!canWritePath(path)) throw new Error(`Pigment cannot write .${ext || '?'} files. Save as .pigment, .psd, .png, .jpg or .webp instead.`);
  const registered = exportFormatForPath(path);
  if (registered?.layered && registered.encode) return registered.encode(doc, { ...exportOpts, format: registered.id }, compositor);
  // an Indexed Color document saved to .png stays a palette PNG when the PNG-8 writer is registered (lib/modes/formats.js)
  if (ext === 'png' && doc.mode === 'indexed' && SAVE_FORMATS.png8?.encode && !exportOpts.format) return exportImage(doc, { ...exportOpts, format: 'png8' }, compositor);
  const format = registered?.id ?? (ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png');
  return exportImage(doc, { ...exportOpts, format }, compositor);
}

/** True when saving to this path keeps all layers. */
export function isLayeredPath(path) {
  return !!exportFormatForPath(path)?.layered;
}

export { canvasIsBlank };
