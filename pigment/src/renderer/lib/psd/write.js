// The PSD writer (ARCHITECTURE.md "0.5 features", S4.1, S4.2, S4.4), skeleton file: 0.4's writePsdDocument as a loop
// over the registered mappers (registry.js). Each layer goes to the first kind whose match passes and whose write
// gives a record, then through every aspect in order; resources with order < 500 run before the layers, the others
// after; the save notices of the report are shown as toasts, one per code, as 0.4 did.
//
// The image-mode handling and the mask bake are 0.4's code and reach the mappers through the context: `shown`,
// `maskOf`, `modeRendered`, `asShown`. Imports beyond S4.1's list (compositor.js, mask-render.js) are the ones 0.4's
// lib/io.js already imported at top level, Node-safe.
import { writePsdUint8Array } from '#ag-psd';
import { createCanvas } from '../document.js';
import { parseColor } from '../../../shared/pixels/color.js';
import { duotoneLut } from '../../../shared/pixels/modes.js';
import { Compositor, flattenDocument, modeRendererFor } from '../compositor.js';
import { maskCanvasFor } from '../mask-render.js';
import { psdLayerKinds, psdAspects, psdResources, psdOptions } from './registry.js';
import { createReport, toastSaveNotices } from './report.js';
import { adjustmentToPsd } from './adjustments.js';

/**
 * Maximize Compatibility for a write: `opts.maximizeCompatibility` when given, else the preference
 * (`settings.psd.maximizeCompatibility`: 'never' → false, 'ask' and 'always' → true; the save option of psd-layers
 * asks before a save that can ask, S12.3).
 */
export function resolveMaximizeCompatibility(doc, opts = {}) {
  if (typeof opts.maximizeCompatibility === 'boolean') return opts.maximizeCompatibility;
  return doc?.view?.app?.settings?.psd?.maximizeCompatibility !== 'never';
}

/**
 * 0.4's image-mode analysis. A PSD written here is always RGB. Duotone and Multichannel documents keep other pixels
 * than they show (greys under the ink curves, the picture before spot channels were removed) and a Grayscale one may
 * hold coloured fill, shape or text layers it shows grey, so each layer is written the way the mode shows it, as Image
 * > Mode > RGB Color would convert it: the file opens looking like the document did.
 *
 * Layer by layer is not the same picture under an adjustment layer in a Grayscale document: Photo Filter, Color Balance
 * or a Gradient Map put colour on the grey pixels below, which the mode shows grey again and an RGB file would show
 * coloured. Then the layers are written as they are stored, and a monochrome Channel Mixer on top of them does what
 * the mode does to the composite (`greyOnTop`, the built-in composite resource adds it).
 *
 * Duotone inks are a curve of the composite's grey, not of each layer's: inked one by one, a translucent layer over a
 * different one (or an adjustment layer) blends or adjusts ink colours where the document inks the blended grey, up to
 * 15 levels off. When the layers inked one by one do not composite to the picture, they are written as stored (grey)
 * and a Gradient Map on top, one stop per grey level (the same luma), prints the composite through the inks
 * (`inksOnTop`).
 */
function imageModeOf(doc, compositor) {
  const adjusts = (group) => group.children.some((l) => l.visible && (l.type === 'adjustment' || (l.isGroup && adjusts(l))));
  const greyOnTop = doc.mode === 'grayscale' && adjusts(doc.root);
  const render = !greyOnTop && ['duotone', 'multichannel', 'grayscale'].includes(doc.mode) ? modeRendererFor(doc.mode) : null;
  const inkedCache = new Map(); // source canvas -> the same pixels the way the mode shows them
  const inked = (canvas, x, y) => {
    if (!render || !canvas?.width || !canvas.height) return canvas;
    if (!inkedCache.has(canvas)) {
      const c = createCanvas(canvas.width, canvas.height);
      c.getContext('2d').drawImage(canvas, 0, 0);
      render(doc, c, { x, y, width: c.width, height: c.height }, {});
      inkedCache.set(canvas, c);
    }
    return inkedCache.get(canvas);
  };
  const content = (group) => group.children.reduce((n, l) => n + (!l.visible || l.quickMask || l.preview || l.type === 'adjustment' ? 0 : l.isGroup ? content(l) : 1), 0);
  const layerByLayerIsShown = () => {
    const probe = new Compositor();
    probe.layerSource = (layer) => {
      const src = Compositor.prototype.layerSource.call(probe, layer);
      return src && { ...src, canvas: inked(src.canvas, src.x, src.y) };
    };
    const read = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
    const a = read(probe.composite(doc, { rawMode: true })), b = read(flattenDocument(doc, compositor));
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) return false;
    return true;
  };
  const inksOnTop = doc.mode === 'duotone' && doc.duotone?.inks?.length > 0 && (adjusts(doc.root) || content(doc.root) > 1) && !layerByLayerIsShown();
  const modeRender = inksOnTop ? null : render;
  const inks = () => {
    const lut = duotoneLut(doc.duotone);
    const hex = (v) => `#${[0, 1, 2].map((c) => lut[v * 3 + c].toString(16).padStart(2, '0')).join('')}`;
    return adjustmentToPsd('gradient-map', { stops: Array.from({ length: 256 }, (_, v) => ({ offset: v / 255, color: hex(v) })) });
  };
  return { greyOnTop, inksOnTop, inks, modeRender, shown: (canvas, x, y) => (modeRender ? inked(canvas, x, y) : canvas) };
}

/**
 * Alpha mask -> greyscale PSD mask (`parts` 'all': the raster and vector masks as one, J.8; 'raster': the raster mask
 * alone, for a mapper that writes the vector mask itself). An enabled mask is written as the effective mask (density
 * and feather baked); a disabled raster mask is written as it is, disabled (0.3). Null when there is nothing to write.
 */
function maskOfLayer(layer, doc, parts = 'all') {
  const enabled = parts === 'raster' ? !!layer.mask?.enabled : !!(layer.mask?.enabled || layer.vectorMask?.enabled);
  const effective = enabled ? maskCanvasFor(layer, doc, { purpose: 'bake', parts }) : null; // mask (K.1)
  if (!effective && !layer.mask?.canvas) return null;
  const m = effective ?? layer.mask.canvas;
  const ctx = m.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, m.width, m.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    img.data[i] = img.data[i + 1] = img.data[i + 2] = a;
    img.data[i + 3] = 255;
  }
  const g = createCanvas(m.width, m.height);
  g.getContext('2d').putImageData(img, 0, 0);
  return { left: 0, top: 0, canvas: g, defaultColor: 0, disabled: !effective };
}

/**
 * Writes a document as PSD bytes (raster pixels for every layer no mapper writes natively; groups, masks, opacity,
 * blend, clipping kept). `opts`: `{ maximizeCompatibility?: boolean, report?: Report, notices?: boolean }` (notices
 * false: no toasts; the report keeps them).
 */
export function writePsdDocument(doc, compositor, opts = {}) {
  const mode = imageModeOf(doc, compositor);
  const report = opts.report ?? createReport();
  const claims = new WeakMap();
  const claim = (layer, part) => {
    if (!claims.has(layer)) claims.set(layer, new Set());
    claims.get(layer).add(part);
  };
  const claimed = (layer, part) => !!claims.get(layer)?.has(part);
  const psd = { width: doc.width, height: doc.height, children: [] };
  const ctx = {
    doc,
    psd,
    opts: { ...opts, compositor, maximizeCompatibility: resolveMaximizeCompatibility(doc, opts) },
    report,
    claim,
    claimed,
    shown: mode.shown,
    maskOf: (layer, parts = 'all') => maskOfLayer(layer, doc, parts),
    modeRendered: !!mode.modeRender,
    // a colour is written natively only when it is what the document displays: grey in a Grayscale document
    asShown(hex) {
      if (!mode.modeRender) return true;
      const [r, g, b] = parseColor(hex ?? '#000000');
      return doc.mode === 'grayscale' && r === g && g === b;
    },
    imageMode: { greyOnTop: mode.greyOnTop, inksOnTop: mode.inksOnTop, inks: mode.inks },
    flatten: () => flattenDocument(doc, compositor),
    // ag-psd's write options (0.4's; the composite resource drops the thumbnail without Maximize Compatibility)
    psdOptions: { generateThumbnail: true, noBackground: true },
  };
  const kinds = psdLayerKinds().filter((k) => typeof k.write === 'function');
  const aspects = psdAspects().filter((a) => typeof a.write === 'function');
  const writeLayer = (layer) => {
    let rec = null;
    for (const kind of kinds) {
      if (kind.match && !kind.match(layer, ctx)) continue;
      rec = kind.write(layer, ctx);
      if (rec) break;
    }
    rec = rec ?? {};
    if (layer.isGroup && !rec.children) rec.children = layer.children.map(writeLayer);
    for (const aspect of aspects) aspect.write(layer, rec, ctx);
    return rec;
  };
  const resources = psdResources().filter((r) => typeof r.write === 'function');
  for (const r of resources) if (r.order < 500) r.write(doc, psd, ctx);
  psd.children = doc.root.children.filter((l) => !l.quickMask && !l.preview).map(writeLayer);
  for (const r of resources) if (r.order >= 500) r.write(doc, psd, ctx);
  const bytes = writePsdUint8Array(psd, psdOptions('write', ctx.psdOptions));
  if (opts.notices !== false) toastSaveNotices(doc.view?.app, report);
  return bytes;
}
