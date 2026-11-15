// The built-in PSD mappers (ARCHITECTURE.md "0.5 features", S4.3), skeleton file: 0.4's lib/io.js PSD code that is no
// package's, registered with `{ builtin: true }` so a package's registration of the same id always wins. Kinds: group
// 100, raster 900 (any layer no other kind wrote, as rendered pixels). Aspects: common 100, blend-if 200, raster-mask
// 300 (psd-layers re-registers it, S4.6), notices 1000 (counts what no mapper claimed). Resources: resolution 100,
// guides 200, composite and image-mode handling 900. Notices: 0.4's six save notices, 0.4's texts exactly.
import { registerPsdLayerKind, registerPsdAspect, registerPsdResource, registerPsdNotice } from './registry.js';
import { psdBlend, toPsdBlend } from './convert.js';
import { adjustmentToPsd } from './adjustments.js';
import { RasterLayer, GroupLayer, createCanvas, textExtensionFor, isDefaultBlending, effectiveBlending } from '../document.js';
import { isDefaultBlendIf, normalizeRange } from '../../../shared/pixels/blend-if.js';
import { hasEnabledStyles } from '../../../shared/pixels/styles.js';

const plural = (n, one, many) => (n === 1 ? one : many);

// ---- Blend If (the layer record's blending ranges) -------------------------------------------------------------

/**
 * Blend If as PSD's blending ranges (the layer record's blending ranges data, which ag-psd reads and writes as
 * `blendingRanges`): the composite gray source (This Layer) and destination (Underlying Layer) ranges, then a source
 * and destination pair per colour channel, R, G, B. A range is [black low, black high, white low, white high], the
 * 0..255 slider halves, as in Pigment's blendIf. Null when nothing is hidden (the record then stays as 0.3 wrote it).
 */
export function blendIfToPsd(blendIf) {
  if (isDefaultBlendIf(blendIf)) return null;
  const r = (c, which) => normalizeRange(blendIf?.[c]?.[which]);
  return {
    compositeGrayBlendSource: r('gray', 'this'),
    compositeGraphBlendDestinationRange: r('gray', 'under'),
    ranges: ['r', 'g', 'b'].map((c) => ({ sourceRange: r(c, 'this'), destRange: r(c, 'under') })),
  };
}

/** Pigment's blendIf from PSD blending ranges (blendIfToPsd's inverse), or null when they hide nothing. */
export function blendIfFromPsd(ranges) {
  if (!ranges || typeof ranges !== 'object') return null;
  const ok = (v) => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite);
  const pair = (src, dst) => ({ this: ok(src) ? normalizeRange(src) : [0, 0, 255, 255], under: ok(dst) ? normalizeRange(dst) : [0, 0, 255, 255] });
  const blendIf = { gray: pair(ranges.compositeGrayBlendSource, ranges.compositeGraphBlendDestinationRange) };
  ['r', 'g', 'b'].forEach((c, i) => {
    const e = Array.isArray(ranges.ranges) ? ranges.ranges[i] : null;
    blendIf[c] = pair(e?.sourceRange, e?.destRange);
  });
  return isDefaultBlendIf(blendIf) ? null : blendIf;
}

// ---- kinds ------------------------------------------------------------------------------------------------------

registerPsdLayerKind({
  id: 'group',
  order: 100,
  test: (pl) => !!pl.children,
  // read.js reads the children into the group, then runs the group's aspects
  read: (pl) => new GroupLayer({ expanded: !!pl.opened }),
  match: (layer) => !!layer.isGroup,
  // write.js writes the children into `children`
  write: (layer) => ({ opened: layer.expanded }),
}, { builtin: true });

registerPsdLayerKind({
  id: 'raster',
  order: 900,
  test: () => true,
  read(pl) {
    const left = pl.left ?? 0, top = pl.top ?? 0;
    const canvas = pl.canvas ?? createCanvas(Math.max(1, (pl.right ?? 1) - left), Math.max(1, (pl.bottom ?? 1) - top));
    return new RasterLayer({ canvas, x: left, y: top });
  },
  match: () => true,
  // a raster layer's own pixels; any other layer (text no kind wrote, shapes, fills, smart objects) as it renders,
  // each the way the image mode shows it (ctx.shown)
  write(layer, ctx) {
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
    return { left: x, top: y, canvas: ctx.shown(canvas, x, y) };
  },
}, { builtin: true });

// ---- aspects ----------------------------------------------------------------------------------------------------

registerPsdAspect({
  id: 'common',
  order: 100,
  read(pl, layer) {
    layer.name = pl.name ?? 'Layer';
    layer.visible = !pl.hidden;
    layer.opacity = pl.opacity ?? 1;
    layer.fillOpacity = pl.fillOpacity ?? 1;
    layer.blend = psdBlend(pl.blendMode);
    layer.clip = !!pl.clipping;
    layer.locked = { ...layer.locked, transparency: !!pl.protected?.transparency, pixels: !!pl.protected?.composite, position: !!pl.protected?.position, all: false };
  },
  write(layer, rec) {
    const lk = layer.locked ?? {};
    rec.name = layer.name;
    rec.hidden = !layer.visible;
    rec.opacity = layer.opacity;
    rec.fillOpacity = layer.fillOpacity ?? 1;
    rec.blendMode = toPsdBlend(layer.blend === 'pass-through' && !layer.isGroup ? 'normal' : layer.blend);
    rec.clipping = layer.clip;
    rec.protected = { transparency: !!(lk.transparency || lk.all), composite: !!(lk.pixels || lk.all), position: !!(lk.position || lk.all) };
  },
}, { builtin: true });

registerPsdAspect({
  id: 'blend-if',
  order: 200,
  // Blend If (the blending ranges of the layer record): adjustment layers take it too
  read(pl, layer) {
    const blendIf = blendIfFromPsd(pl.blendingRanges);
    if (blendIf) layer.blending = { ...(layer.blending ?? {}), blendIf };
  },
  write(layer, rec) {
    const blendIf = layer.blending ? blendIfToPsd(effectiveBlending(layer).blendIf) : null;
    if (blendIf) rec.blendingRanges = blendIf;
  },
}, { builtin: true });

registerPsdAspect({
  id: 'raster-mask',
  order: 300,
  read(pl, layer, ctx) {
    if (!(pl.mask?.canvas && !pl.mask.fromVectorData)) return;
    const { doc } = ctx;
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
  },
  // an enabled raster or vector mask is written as the effective mask (density, feather and, unless a mapper claimed
  // the vector mask, a linked vector mask baked into one raster mask: J.8), so Photoshop shows what Pigment shows; a
  // disabled raster mask without a vector mask is written as it is, disabled (0.3)
  write(layer, rec, ctx) {
    if (!(layer.mask?.canvas || layer.vectorMask)) return;
    const mask = ctx.maskOf(layer, ctx.claimed(layer, 'vector-mask') ? 'raster' : 'all');
    if (mask) rec.mask = mask;
  },
}, { builtin: true });

// What no mapper claimed, counted after every other aspect of the layer ran: a notice disappears exactly when a
// package starts writing the feature (S4.2)
registerPsdAspect({
  id: 'notices',
  order: 1000,
  write(layer, rec, ctx) {
    const effects = hasEnabledStyles(layer.styles) && !ctx.claimed(layer, 'effects');
    const advanced = !isDefaultBlending(layer.blending ? { ...layer.blending, blendIf: null } : null) && !ctx.claimed(layer, 'advanced-blending');
    if (effects || advanced) ctx.report.add('styled');
    // text that would be PSD text if PSD text could hold its formatting (path and stacked text, and text the image
    // mode shows in another colour, are pixels by design)
    if (layer.type === 'text' && !ctx.claimed(layer, 'text') && !textExtensionFor(layer) && ctx.asShown(layer.font?.color ?? '#000000')) ctx.report.add('pixel-text');
  },
}, { builtin: true });

// ---- resources --------------------------------------------------------------------------------------------------

registerPsdResource({
  id: 'resolution',
  order: 100,
  read(psd, doc) {
    const res = psd.imageResources?.resolutionInfo;
    if (res?.horizontalResolution) doc.dpi = Math.round(res.horizontalResolution);
  },
  write(doc, psd) {
    psd.imageResources = { ...(psd.imageResources ?? {}), resolutionInfo: { horizontalResolution: doc.dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: doc.dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } };
  },
}, { builtin: true });

registerPsdResource({
  id: 'guides',
  order: 200,
  // guides (image resource 1032): a horizontal guide sits at a y position (axis 'y')
  read(psd, doc) {
    const psdGuides = psd.imageResources?.gridAndGuidesInformation?.guides;
    if (Array.isArray(psdGuides) && psdGuides.length) doc.guides = psdGuides.map((g) => ({ axis: g.direction === 'horizontal' ? 'y' : 'x', pos: g.location }));
  },
  // positions in 1/32 px, unsigned: a guide left of or above the canvas cannot be written. The ruler origin has no
  // resource PSD files from Pigment write: it is reported
  write(doc, psd, ctx) {
    const guides = (doc.guides ?? []).filter((g) => g.pos >= 0 && g.pos * 32 < 2 ** 32);
    if (guides.length) {
      psd.imageResources = psd.imageResources ?? {};
      psd.imageResources.gridAndGuidesInformation = { guides: guides.map((g) => ({ location: g.pos, direction: g.axis === 'y' ? 'horizontal' : 'vertical' })) };
    }
    const lost = (doc.guides?.length ?? 0) - guides.length;
    const origin = doc.store?.get?.('rulerOrigin');
    const moved = !!origin && (origin.x !== 0 || origin.y !== 0);
    if (lost > 0 || moved) ctx.report.add('guides-origin', { lost: Math.max(0, lost), origin: moved });
  },
}, { builtin: true });

// The composite (and 0.4's image-mode layers on top of the others). With Maximize Compatibility the composite is the
// flattened document, as 0.4 wrote it; without, a blank white composite as Photoshop writes one, marked as not real
// merged data, and no thumbnail (S4.4). On open, a file without layers opens as its composite (0.4's fallback).
registerPsdResource({
  id: 'composite',
  order: 900,
  read(psd, doc) {
    if (psd.children?.length || !psd.canvas) return;
    const layer = new RasterLayer({ name: 'Background', canvas: psd.canvas, x: 0, y: 0 });
    doc.root.children.push(layer);
    layer.parent = doc.root;
  },
  write(doc, psd, ctx) {
    const mode = ctx.imageMode ?? {};
    // a Grayscale document whose adjustment layers would put colour on its greys: the layers as stored and a
    // monochrome Channel Mixer on top (the luma weights, to the percent) does what the mode does to the composite
    if (mode.greyOnTop) psd.children.push({ name: 'Grayscale', opacity: 1, blendMode: 'normal', adjustment: adjustmentToPsd('channel-mixer', { monochrome: true, gray: { r: 30, g: 59, b: 11, constant: 0 } }) });
    // Duotone inks that layer-by-layer inking does not reproduce: the layers as stored (grey) and a Gradient Map, one
    // stop per grey level, prints the composite through the inks
    if (mode.inksOnTop) psd.children.push({ name: 'Duotone', opacity: 1, blendMode: 'normal', adjustment: mode.inks() });
    if (ctx.opts.maximizeCompatibility !== false) {
      psd.canvas = ctx.flatten();
      return;
    }
    const blank = createCanvas(doc.width, doc.height);
    const bctx = blank.getContext('2d');
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, 0, doc.width, doc.height);
    psd.canvas = blank;
    psd.imageResources = { ...(psd.imageResources ?? {}), versionInfo: { hasRealMergedData: false, writerName: 'Pigment', readerName: 'Pigment', fileVersion: 1 } };
    ctx.psdOptions.generateThumbnail = false;
  },
}, { builtin: true });

// ---- notices (0.4's toasts, in 0.4's order) --------------------------------------------------------------------

registerPsdNotice('other-space', { when: 'save', timeout: 4000, text: (n) => `${n} Levels or Curves layer${plural(n, '', 's')} in a Gray, CMYK or Lab channel space ${plural(n, 'was', 'were')} saved without ${plural(n, 'its', 'their')} settings: PSD keeps RGB channels only` }, { builtin: true });
registerPsdNotice('styled', { when: 'save', timeout: 4000, text: (n) => `${n} layer${plural(n, '', 's')} with layer effects or Blending Options ${plural(n, 'was', 'were')} saved without them: PSD files from Pigment do not keep effects yet` }, { builtin: true });
registerPsdNotice('no-psd-adjustment', {
  when: 'save',
  timeout: 5000,
  // what changes the picture or the document without a PSD equivalent is said, as for text and channel spaces (J.8)
  text: (n, names) => `${n} adjustment layer${plural(n, '', 's')} (${[...new Set(names)].join(', ')}) ${plural(n, 'has', 'have')} no PSD equivalent and ${plural(n, 'was', 'were')} saved as ${plural(n, 'a hidden empty layer', 'hidden empty layers')}, without ${plural(n, 'its', 'their')} settings`,
}, { builtin: true });
registerPsdNotice('colorized', { when: 'save', timeout: 4000, text: (n) => `${n} Hue/Saturation layer${plural(n, '', 's')} set to Colorize ${plural(n, 'was', 'were')} saved without Colorize` }, { builtin: true });
registerPsdNotice('guides-origin', {
  when: 'save',
  timeout: 4000,
  text(n, details) {
    const { lost = 0, origin = false } = details[details.length - 1] ?? {};
    const parts = [lost > 0 ? `${lost} guide${plural(lost, '', 's')} outside the canvas` : '', origin ? 'the ruler origin' : ''].filter(Boolean);
    return parts.length ? `PSD does not keep ${parts.join(' or ')}: ${parts.length > 1 || lost > 1 ? 'they were' : 'it was'} not saved` : '';
  },
}, { builtin: true });
registerPsdNotice('pixel-text', { when: 'save', timeout: 4000, text: (n) => `${n} text layer${plural(n, '', 's')} with formatting PSD text cannot hold yet ${plural(n, 'was', 'were')} saved as pixels` }, { builtin: true });
