// GIF and PNG-8 (lib/modes.js): export formats registered with lib/io.js and the readers that keep a
// file's colour table, so a GIF or a palette PNG opens as an Indexed Color document instead of the
// RGBA picture a browser decode gives. Save for Web uses the same helpers for its optimised preview.
import { registerExportFormat, registerOpenFormat, decodeImage, baseName } from '../io.js';
import { SAVE_FILTERS } from '../documents.js';
import { Document, RasterLayer, createCanvas } from '../document.js';
import { flattenDocument } from '../compositor.js';
import { quantize, createMapper } from '../../../shared/pixels/quantize.js';
import { encodeGif, decodeGif, isGif, gifFrameImage } from '../../../shared/pixels/gif.js';
import { encodePng, decodePng, toRgba8, isPng, pngInfo } from '../../../shared/pixels/png.js';

/** The option fields Export As shows for GIF and PNG-8 (lib/form.js specs; their values arrive in the encoder's opts). */
const indexedFields = () => [
  { key: 'colors', label: 'Colors', type: 'number', value: 256, min: 2, max: 256 },
  { key: 'dither', label: 'Dither', type: 'select', value: 'diffusion', options: [['none', 'None'], ['diffusion', 'Diffusion'], ['pattern', 'Pattern'], ['noise', 'Noise']] },
  { key: 'transparency', label: 'Transparency', type: 'checkbox', value: true },
  { key: 'matte', label: 'Matte', type: 'color', value: '#ffffff', help: 'Blended into partly transparent pixels (and behind everything when Transparency is off)' },
];

/** The flattened document (or opts.canvas) at the export size, on opts.background when there is one. */
export function exportCanvas(doc, opts = {}, compositor) {
  let canvas = opts.canvas ?? flattenDocument(doc, compositor);
  const w = Math.max(1, Math.round(opts.width ?? canvas.width * (opts.scale ?? 1)));
  const h = Math.max(1, Math.round(opts.height ?? canvas.height * (opts.scale ?? 1)));
  if (w !== canvas.width || h !== canvas.height || opts.background) {
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    canvas = out;
  }
  return canvas;
}

/**
 * Indices for an image whose colours are (meant to be) those of an existing table: the table is kept as it is,
 * entry for entry. Returns null when the image needs a transparent entry and the table has no room for one.
 */
function indexWithTable(img, table, transparentIndex) {
  const palette = table.map((c) => [c[0], c[1], c[2]]);
  let ti = transparentIndex >= 0 && transparentIndex < palette.length ? transparentIndex : -1;
  const d = img.data;
  let needsTransparent = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 128) {
    needsTransparent = true;
    break;
  }
  if (needsTransparent && ti < 0) {
    if (palette.length >= 256) return null;
    ti = palette.length;
    palette.push([0, 0, 0]);
  }
  const mapper = createMapper(palette, ti);
  const indices = new Uint8Array(img.width * img.height);
  let prevKey = -1, prev = 0;
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    if (d[i + 3] < 128) {
      indices[p] = ti;
      continue;
    }
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    if (key !== prevKey) {
      prevKey = key;
      prev = mapper.nearest(d[i], d[i + 1], d[i + 2]);
    }
    indices[p] = prev;
  }
  return { palette, indices, transparentIndex: needsTransparent || transparentIndex >= 0 ? ti : -1 };
}

/**
 * Quantises an export image. An Indexed Color document at its own size keeps its colour table (same entries,
 * same order) unless the options ask for a palette of their own or for fewer colours than the table has.
 * @param {{ colors?, palette?, forced?, transparency?, matte?, dither?, ditherAmount?, preserveExactColors?, custom? }} opts
 * @param {{ doc?: object, state?: { colorTable, transparentIndex }, resized?: boolean }} [ctx]
 */
export function quantizeForExport(img, opts = {}, { doc = null, state = null, resized = false } = {}) {
  const colors = Math.max(2, Math.min(256, Math.round(Number(opts.colors) || 256)));
  const table = doc?.mode === 'indexed' ? state?.colorTable : null;
  if (table?.length && !resized && !opts.palette && !opts.background && colors >= table.length) {
    const kept = indexWithTable(img, table, state.transparentIndex ?? -1);
    if (kept) return kept;
  }
  return quantize(img, {
    colors,
    palette: opts.palette ?? 'adaptive',
    forced: opts.forced ?? 'none',
    transparency: opts.transparency !== false,
    matte: opts.matte ?? null,
    dither: opts.dither ?? 'diffusion',
    ditherAmount: opts.ditherAmount ?? 75,
    preserveExactColors: !!opts.preserveExactColors,
    custom: opts.custom ?? null,
  });
}

/** GIF bytes of a quantised image ({ palette, indices, transparentIndex }). */
export function gifBytes(q, width, height) {
  // a GIF table holds at least two colours
  const palette = q.palette.length >= 2 ? q.palette : [...q.palette, [255, 255, 255]];
  return encodeGif([{ indices: q.indices, palette, transparentIndex: q.transparentIndex, delay: 0 }], width, height);
}

/** PNG-8 bytes of a quantised image. */
export function png8Bytes(q, width, height, { dpi = null } = {}) {
  const palette = new Uint8Array(q.palette.length * 3);
  q.palette.forEach((c, i) => palette.set([c[0], c[1], c[2]], i * 3));
  const transparency = new Uint8Array(q.palette.length).fill(255);
  if (q.transparentIndex >= 0) transparency[q.transparentIndex] = 0;
  return encodePng({ width, height, channels: 1, depth: 8, data: q.indices, palette, transparency }, { indexed: true, dpi });
}

export function installFormats(app, { modeState }) {
  const encoder = (kind) => async (doc, opts = {}, compositor) => {
    const canvas = exportCanvas(doc, opts, compositor);
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const resized = canvas.width !== doc.width || canvas.height !== doc.height || !!opts.canvas;
    const q = quantizeForExport(img, opts, { doc, state: modeState(doc), resized });
    return kind === 'gif' ? gifBytes(q, canvas.width, canvas.height) : png8Bytes(q, canvas.width, canvas.height, { dpi: doc.dpi });
  };
  registerExportFormat('gif', { name: 'GIF image', ext: 'gif', mime: 'image/gif', options: indexedFields(), encode: encoder('gif') });
  // .png keeps routing to PNG-24: PNG-8 is chosen by name in Export As and Save for Web
  registerExportFormat('png8', { name: 'PNG-8 image', ext: 'png', extensions: [], mime: 'image/png', options: indexedFields(), encode: encoder('png8') });
  // Save As offers GIF now that it can be written (documents.js owns the list; this adds one row to it)
  if (!SAVE_FILTERS.some((f) => f.extensions.includes('gif'))) SAVE_FILTERS.push({ name: 'GIF image', extensions: ['gif'] });

  registerOpenFormat({
    id: 'gif',
    name: 'GIF images',
    extensions: ['gif'],
    test: (bytes) => isGif(bytes),
    async read(bytes, { name }) {
      let gif = null;
      try {
        gif = decodeGif(bytes, { firstFrameOnly: true });
        if (gif.width * gif.height > 30000 * 30000) throw new Error('The GIF is too large');
      } catch (err) {
        console.warn('GIF colour table reader failed; using the browser decoder', err);
        gif = null;
      }
      let canvas, table = null, ti = -1;
      if (gif) {
        const img = gifFrameImage(gif, 0);
        canvas = createCanvas(gif.width, gif.height);
        canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
        const frame = gif.frames[0];
        table = frame.palette.map((c) => [c[0], c[1], c[2]]);
        ti = frame.transparentIndex >= 0 && frame.transparentIndex < table.length ? frame.transparentIndex : -1;
      } else canvas = await decodeImage(bytes, name);
      return indexedDocument(canvas, name, table, ti);
    },
  });

  // Palette PNGs (PNG-8) open as Indexed Color too, as in Photoshop. A palette whose entries are partly
  // transparent has no single transparent index: such files open as RGB through the browser decoder.
  registerOpenFormat({
    id: 'png8',
    extensions: [],
    test: (bytes) => {
      try {
        return isPng(bytes) && pngInfo(bytes).colorType === 3;
      } catch {
        return false;
      }
    },
    async read(bytes, { name }) {
      try {
        const png = await decodePng(bytes);
        const count = Math.floor((png.palette?.length ?? 0) / 3);
        const alpha = png.transparency ?? [];
        let ti = -1, soft = false;
        for (let i = 0; i < alpha.length && i < count; i++) {
          if (alpha[i] === 255) continue;
          if (alpha[i] !== 0 || ti >= 0) soft = true;
          ti = i;
        }
        if (count && !soft) {
          const img = toRgba8(png);
          const canvas = createCanvas(img.width, img.height);
          canvas.getContext('2d').putImageData(new ImageData(img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
          const table = [];
          for (let i = 0; i < count; i++) table.push([png.palette[i * 3], png.palette[i * 3 + 1], png.palette[i * 3 + 2]]);
          const doc = indexedDocument(canvas, name, table, ti);
          if (png.dpi > 0) doc.dpi = Math.round(png.dpi);
          return doc;
        }
      } catch (err) {
        console.warn('PNG palette reader failed; using the browser decoder', err);
      }
      return indexedDocument(await decodeImage(bytes, name), name, null, -1);
    },
  });
}

/** A one-layer document for a decoded picture; with a colour table it is an Indexed Color document. */
function indexedDocument(canvas, name, table, transparentIndex) {
  const doc = new Document({ width: canvas.width, height: canvas.height, name: baseName(name), mode: table ? 'indexed' : 'rgb', colorTable: table });
  const layer = new RasterLayer({ name: 'Background', canvas, x: 0, y: 0 });
  doc.root.children.push(layer);
  layer.parent = doc.root;
  doc.active = layer;
  doc.selected.add(layer);
  if (table && transparentIndex >= 0) doc.meta = { ...doc.meta, imageMode: { transparentIndex } };
  return doc;
}
