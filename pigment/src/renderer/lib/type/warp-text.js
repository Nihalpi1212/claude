// Warp Text (0.5, type-menu-commands; ARCHITECTURE.md "0.5 features", S11.3, S11.4).
//
// typeOptions.warp = { style, horizontal, bend, hDistort, vDistort } (model.js normalizeWarp) stays live on the layer:
// the text render stage `warp` (order 100) bends the drawing each time the text is drawn, so the text stays editable
// (Photoshop's warped text; it is edited unwarped, review decision 15). The bend is Free Transform's Warp: the 16
// control points of a style (warp.js presetControls, read only) over the text's box, a bicubic Bézier patch
// (shared/pixels/warp.js bezierPoint). Vertical warps the transposed box, so Arc bends sideways.
//   - geometry(layer) is the patch as a point map in the layer's base space: the anti-alias stage above draws its
//     outlines through it, and Create Work Path / Convert to Shape keep the warp;
//   - render draws the warped outlines with Canvas 2D (the engine's smooth look) when every character has an
//     outline, else resamples the engine's drawing through a mesh of the patch;
//   - bounds is the box of the warped drawing (hit testing, the layer's bounds).
// The box: a paragraph's frame, or the union of a point text's lines. Text on a path and stacked text are never
// warped (the stage leaves text extensions alone); the command refuses them, as Photoshop greys Warp Text there.
import { registerTextRenderStage } from './api.js';
import { layerOutlines, paintOutlines, mappedPolygons, polygonsBounds } from './outlines.js';
import { createCanvas, textExtensionFor } from '../document.js';
import { WARP_STYLES, normalizeWarp } from './model.js';
import { bezierPoint, regularGrid, mapGrid, meshWarp } from '../../../shared/pixels/warp.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

/** Photoshop's names of the fifteen styles, in its menu order (WARP_STYLES; warp.js WARP_PRESETS has the same). */
export const WARP_STYLE_LABELS = Object.freeze({
  arc: 'Arc', 'arc-lower': 'Arc Lower', 'arc-upper': 'Arc Upper', arch: 'Arch', bulge: 'Bulge', 'shell-lower': 'Shell Lower', 'shell-upper': 'Shell Upper',
  flag: 'Flag', wave: 'Wave', fish: 'Fish', rise: 'Rise', fisheye: 'Fisheye', inflate: 'Inflate', squeeze: 'Squeeze', twist: 'Twist',
});

/** The warp box of a laid-out text in base space: a paragraph's frame, or the lines of point text; null when empty. */
export function warpBox(layer, lay) {
  if (!lay) return null;
  if (layer.width != null) {
    const w = lay.frame?.width ?? layer.width;
    const h = lay.frame?.height ?? lay.height;
    return w >= 1 && h >= 1 ? { x: layer.x, y: layer.y, width: w, height: h } : null;
  }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const line of lay.lines ?? []) {
    if (!line.visible) continue;
    x1 = Math.min(x1, line.x);
    x2 = Math.max(x2, line.x + (line.width ?? 0));
    y1 = Math.min(y1, line.top);
    y2 = Math.max(y2, line.top + (line.height ?? 0));
  }
  if (x1 === Infinity || x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * The warp as a point map over `box`: { mapPoint(x, y) → [x, y], box, controls }. `controlsFor(rect, style, bend,
 * hDistort, vDistort)` gives the 16 control points (warp.js presetControls in the app). A vertical warp works on the
 * transposed box, its two distortions swapped so that Horizontal Distortion still tapers left to right.
 */
export function warpGeometry(box, warp, controlsFor) {
  const w = normalizeWarp(warp);
  if (!w || !box || !(box.width > 0) || !(box.height > 0)) return null;
  const h = w.horizontal;
  const R = h ? box : { x: box.y, y: box.x, width: box.height, height: box.width };
  const controls = h ? controlsFor(R, w.style, w.bend, w.hDistort, w.vDistort) : controlsFor(R, w.style, w.bend, w.vDistort, w.hDistort);
  const out = [0, 0];
  return {
    box,
    controls,
    mapPoint(x, y) {
      const px = h ? x : y, py = h ? y : x;
      bezierPoint(controls, (px - R.x) / R.width, (py - R.y) / R.height, out);
      return h ? [out[0], out[1]] : [out[1], out[0]];
    },
  };
}

/** The box of a rectangle mapped by a geometry (sampled on a grid: a strong warp can fold an edge inward). */
export function mappedRectBounds(rect, geo, n = 16) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const [x, y] = geo.mapPoint(rect.x + (rect.width * j) / n, rect.y + (rect.height * i) / n);
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return { x: Math.floor(x1) - 2, y: Math.floor(y1) - 2, width: Math.max(1, Math.ceil(x2) - Math.floor(x1) + 4), height: Math.max(1, Math.ceil(y2) - Math.floor(y1) + 4) };
}

const colorOf = (st) => rgbaToHex(parseColor(st.color), true);

/** The engine's drawing resampled through a mesh of the patch (text without outlines). */
function warpRaster(base, geo) {
  const w = base.canvas.width, h = base.canvas.height;
  const img = base.canvas.getContext('2d').getImageData(0, 0, w, h);
  const n = Math.max(8, Math.min(48, Math.ceil(Math.max(w, h) / 24)));
  const src = regularGrid({ x: 0, y: 0, width: w, height: h }, n, n);
  const dst = mapGrid(src, ([x, y]) => geo.mapPoint(x + base.x, y + base.y));
  const r = meshWarp({ width: w, height: h, data: img.data }, src, dst, { interp: 'bilinear' });
  const canvas = createCanvas(r.image.width, r.image.height);
  if (!r.empty) canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.data.buffer, r.image.data.byteOffset, r.image.data.length), r.image.width, r.image.height), 0, 0);
  return { canvas, x: r.x, y: r.y };
}

/** Installs the `warp` text render stage. `controlsFor` is warp.js presetControls. Returns the unregister function. */
export function installWarpStage(controlsFor) {
  const geoCache = new WeakMap(); // layer -> { key, geo }
  const boundsCache = new WeakMap(); // layer -> { version, geo, bounds }
  const geometryOf = (layer, lay) => {
    const warp = layer.typeOptions?.warp;
    const box = warpBox(layer, lay);
    const key = box ? `${JSON.stringify(warp)}|${box.x}|${box.y}|${box.width}|${box.height}` : '';
    const hit = geoCache.get(layer);
    if (hit && hit.key === key) return hit.geo;
    const geo = box ? warpGeometry(box, warp, controlsFor) : null;
    geoCache.set(layer, { key, geo });
    return geo;
  };
  return registerTextRenderStage({
    id: 'warp',
    order: 100,
    test: (layer) => !!layer.typeOptions?.warp && !textExtensionFor(layer),
    geometry: (layer) => geometryOf(layer, layer.layout()),
    bounds(layer, next, lay) {
      const geo = geometryOf(layer, lay);
      if (!geo) return next();
      // hit tests ask often: kept per layer version and warp
      const hit = boundsCache.get(layer);
      if (hit && hit.version === layer.version && hit.geo === geo) return { ...hit.bounds };
      const ol = layerOutlines(layer);
      let b = null;
      if (ol?.complete) {
        // the warped glyphs themselves (the engine's box is padded, and a warp would blow the padding up)
        const polys = ol.runs.flatMap((r) => mappedPolygons([...r.subpaths, ...r.decorations], (x, y) => geo.mapPoint(x, y), { tol: 0.5, maxSeg: 6 }));
        const bb = polygonsBounds(polys);
        if (bb) {
          const pad = Math.ceil(Math.max(2, ...ol.runs.map((r) => (r.stroke?.width ?? 0) + (r.bold ? r.style.size / 30 : 0) + 2)));
          b = { x: Math.floor(bb.x1) - pad, y: Math.floor(bb.y1) - pad, width: Math.ceil(bb.x2) - Math.floor(bb.x1) + pad * 2, height: Math.ceil(bb.y2) - Math.floor(bb.y1) + pad * 2 };
        }
      }
      b ??= mappedRectBounds(next(), geo);
      boundsCache.set(layer, { version: layer.version, geo, bounds: b });
      return { ...b };
    },
    render(layer, next, lay) {
      const geo = geometryOf(layer, lay);
      if (!geo) return next();
      const ol = layerOutlines(layer);
      if (ol?.complete) {
        let pad = 2;
        for (const r of ol.runs) pad = Math.max(pad, (r.stroke?.width ?? 0) + (r.bold ? r.style.size / 30 : 0) + 2);
        const polys = ol.runs.flatMap((r) => mappedPolygons([...r.subpaths, ...r.decorations], (x, y) => geo.mapPoint(x, y), { tol: 0.2, maxSeg: 3 }));
        const bb = polygonsBounds(polys);
        if (!bb) return next();
        const x0 = Math.floor(bb.x1 - pad), y0 = Math.floor(bb.y1 - pad);
        const canvas = createCanvas(Math.max(1, Math.ceil(bb.x2 + pad) - x0), Math.max(1, Math.ceil(bb.y2 + pad) - y0));
        paintOutlines(canvas.getContext('2d'), ol, (x, y) => {
          const p = geo.mapPoint(x, y);
          return [p[0] - x0, p[1] - y0];
        }, { tol: 0.2, maxSeg: 3, colorOf });
        return { canvas, x: x0, y: y0 };
      }
      return warpRaster(next(), geo);
    },
  });
}

// ---- the dialog ---------------------------------------------------------------------------------------------------

/** The dialog's starting values: the layer's warp, else Photoshop's defaults for a new style. */
export function dialogValues(warp) {
  const w = normalizeWarp(warp);
  return w ? { style: w.style, horizontal: w.horizontal ? 'horizontal' : 'vertical', bend: w.bend, hDistort: w.hDistort, vDistort: w.vDistort } : { style: 'none', horizontal: 'horizontal', bend: 50, hDistort: 0, vDistort: 0 };
}

/** The warp a dialog's values describe: null for None. */
export function warpFromValues(v) {
  if (!v || v.style === 'none' || !WARP_STYLES.includes(v.style)) return null;
  return normalizeWarp({ style: v.style, horizontal: v.horizontal !== 'vertical', bend: Number(v.bend), hDistort: Number(v.hDistort), vDistort: Number(v.vDistort) });
}

/** The fields of the Warp Text dialog (form.js). */
export function dialogFields() {
  const off = (v) => v.style === 'none';
  return [
    { key: 'style', label: 'Style', type: 'select', value: 'none', options: [['none', 'None'], ...WARP_STYLES.map((s) => [s, WARP_STYLE_LABELS[s]])] },
    { key: 'horizontal', label: '', type: 'segment', value: 'horizontal', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], disabled: off },
    { key: 'bend', label: 'Bend', type: 'slider', value: 50, min: -100, max: 100, step: 1, unit: '%', disabled: off },
    { key: 'hDistort', label: 'Horizontal Distortion', type: 'slider', value: 0, min: -100, max: 100, step: 1, unit: '%', disabled: off },
    { key: 'vDistort', label: 'Vertical Distortion', type: 'slider', value: 0, min: -100, max: 100, step: 1, unit: '%', disabled: off },
  ];
}
