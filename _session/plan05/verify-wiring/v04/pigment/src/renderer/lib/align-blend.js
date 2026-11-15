// Auto-Align Layers, Auto-Blend Layers, Photomerge, Load Files into Stack, Statistics and the smart
// object Stack Modes (see ARCHITECTURE.md "Auto-Align, Auto-Blend, Photomerge, stacks").
//
// The maths is pure and lives in src/shared/pixels/register.js (features, RANSAC, projections, seams,
// gains) and stack.js (the stack statistics); this module turns layers and files into images, draws
// the results back through canvases and records everything in the history. Each command is one undo
// entry, also when it is made of several steps (transforms, a canvas resize, masks, a fill).
import { Document, RasterLayer, createCanvas, copyCanvas, unionRect } from './document.js';
import { structural, setLayerProps, renderLayersFlat } from './layer-ops.js';
import { affineCanvas, perspectiveCanvas, canvasData, dataCanvas } from './image-ops.js';
import { formDialog } from './form.js';
import { bridge } from './bridge.js';
import { openDocument, OPEN_FILTERS, baseName } from './io.js';
import { flattenDocument } from './compositor.js';
import { contentAwareFill } from './content-aware.js';
import { SmartLayer, makeSource, attachHost } from './smart-object.js';
import * as R from '../../shared/pixels/register.js';
import { stackImages, STACK_MODES, STACK_MODE_IDS, stackModeName } from '../../shared/pixels/stack.js';

const PROJECTION_OPTIONS = [['auto', 'Auto'], ['perspective', 'Perspective'], ['collage', 'Collage'], ['cylindrical', 'Cylindrical'], ['spherical', 'Spherical'], ['reposition', 'Reposition']];
const PROJECTION_NAMES = Object.fromEntries(PROJECTION_OPTIONS);
/** The largest canvas a merge may produce (per side, and in total pixels). */
const MAX_SIDE = 30000;
const MAX_PIXELS = 160e6;

const fileName = (path) => String(path ?? '').split(/[\\/]/).pop();
const clone = (v) => JSON.parse(JSON.stringify(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Lets the busy label and cursor paint between two heavy synchronous steps. */
const breathe = () => new Promise((r) => setTimeout(r));

// ---- registration -------------------------------------------------------------------------------------------

/**
 * R.alignImages() in steps: features image by image, matches pair by pair, a pause after each, so the busy
 * cursor and label keep painting while a dozen large photographs are registered.
 */
async function alignStepwise(images, opts) {
  const feats = [];
  for (const img of images) {
    feats.push(R.detectFeatures(img));
    await breathe();
  }
  const sizes = images.map((img) => ({ width: img.width, height: img.height }));
  const edges = [];
  const match = async (pairs) => {
    for (const [a, b] of pairs) {
      const e = R.registerPair(feats[a], feats[b]);
      if (e) edges.push({ a, b, ...e });
      await breathe();
    }
  };
  let pairs = R.candidatePairs(images.length);
  const ref = opts.reference;
  if (Number.isInteger(ref) && images.length > 3) {
    // With a given reference (a stack on its first image, a locked layer) the pairs with that image usually
    // settle everything; the others, most of the work for a large stack, are matched only if an image is left
    // without a sound pair.
    await match(pairs.filter(([a, b]) => a === ref || b === ref));
    const direct = R.solveAlignment(sizes, edges, opts);
    if (direct.every((t) => t.sound || t.index === direct.reference)) return direct;
    pairs = pairs.filter(([a, b]) => a !== ref && b !== ref);
  }
  await match(pairs);
  return R.solveAlignment(sizes, edges, opts);
}

/**
 * Registers images (ImageData) and applies the optional lens corrections. Returns { images (the corrected
 * pixels, the input objects where nothing changed), corrected: boolean[], result (alignImages), notes }.
 */
async function registerImages(images, { projection = 'auto', reference = undefined, vignette = false, distortion = false } = {}) {
  const notes = [];
  let imgs = images;
  const corrected = images.map(() => false);
  let result = await alignStepwise(imgs, { projection, reference });
  if (distortion) {
    const sizes = imgs.map((i) => ({ width: i.width, height: i.height }));
    const est = R.estimateDistortion(sizes, result.samples());
    if (est.k) {
      imgs = imgs.map((img) => R.undistortImage(img, est.k));
      corrected.fill(true);
      await breathe();
      // the features moved with the pixels: register the corrected images
      result = await alignStepwise(imgs, { projection, reference });
      notes.push(`geometric distortion corrected (${est.k < 0 ? 'barrel' : 'pincushion'}, k = ${est.k.toFixed(3)})`);
    } else notes.push('geometric distortion was not corrected: the matches show none that could be measured');
  }
  if (vignette) {
    const est = R.estimateVignette(imgs, result.samples());
    if (est.amount > 0) {
      imgs = imgs.map((img, i) => R.removeVignette(corrected[i] ? img : { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }, est.amount));
      corrected.fill(true);
      notes.push(`vignette removed (${Math.round(est.amount * 100)}% towards the corners)`);
    } else notes.push('vignette was not removed: the overlaps show none that could be measured');
  }
  return { images: imgs, corrected, result, notes };
}

/**
 * Draws a canvas through one entry of alignImages(): { canvas, x, y } in the pixel space of the reference
 * image, or null when the model cannot be drawn (a corner behind the camera, an absurd size).
 */
function place(canvas, t) {
  const w = canvas.width, h = canvas.height;
  if (t.warp) {
    // cylindrical / spherical: the pure projection draws the image onto the surface around the reference camera
    if (t.bounds.width > MAX_SIDE || t.bounds.height > MAX_SIDE || t.bounds.width * t.bounds.height > Math.min(MAX_PIXELS, 16 * w * h)) return null;
    return { canvas: dataCanvas(R.projectImage(canvasData(canvas), t)), x: t.bounds.x, y: t.bounds.y };
  }
  if (t.matrix) {
    const m = t.matrix;
    // a pure shift moves the layer: its pixels are not resampled
    if (Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) return { canvas, x: Math.round(m[4]), y: Math.round(m[5]) };
    // the model maps pixel indices (centres); canvas coordinates are half a pixel further
    const mc = [m[0], m[1], m[2], m[3], m[4] + 0.5 - (m[0] + m[2]) * 0.5, m[5] + 0.5 - (m[1] + m[3]) * 0.5];
    if (t.bounds.width > MAX_SIDE || t.bounds.height > MAX_SIDE || t.bounds.width * t.bounds.height > MAX_PIXELS) return null;
    return affineCanvas(canvas, 0, 0, mc);
  }
  const H = t.homography;
  const quad = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    if (H[6] * (x - 0.5) + H[7] * (y - 0.5) + H[8] <= 1e-6) return null;
    const [u, v] = R.applyH(H, x - 0.5, y - 0.5);
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    quad.push([u + 0.5, v + 0.5]);
  }
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  if (bw > MAX_SIDE || bh > MAX_SIDE || bw * bh > MAX_PIXELS || bw * bh > 16 * w * h) return null;
  return perspectiveCanvas(canvas, 0, 0, quad, { quality: 'bilinear' });
}

/**
 * The linked mask of a layer that Auto-Align moves, taken through the same model `t`, so that it keeps hiding
 * the same pixels. Masks are document-sized: the part over the layer is cut out, placed like the layer and
 * drawn into a new mask of the same size whose remaining area keeps the old mask's background (its corner).
 * null when the model cannot be drawn.
 */
function placeMask(layer, t, origin) {
  const mask = layer.mask.canvas;
  const white = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3] >= 128;
  const local = createCanvas(layer.canvas.width, layer.canvas.height);
  const lc = local.getContext('2d');
  if (white) {
    // a revealing mask is carried as its complement (what it hides): resampling then leaves "reveal" around it
    lc.fillStyle = '#fff';
    lc.fillRect(-layer.x, -layer.y, mask.width, mask.height);
    lc.globalCompositeOperation = 'destination-out';
  }
  lc.drawImage(mask, -layer.x, -layer.y);
  const p = place(local, t);
  if (!p) return null;
  const out = createCanvas(mask.width, mask.height);
  const oc = out.getContext('2d');
  if (white) {
    oc.fillStyle = '#fff';
    oc.fillRect(0, 0, out.width, out.height);
    oc.globalCompositeOperation = 'destination-out';
  }
  oc.drawImage(p.canvas, p.x + origin.x, p.y + origin.y);
  return out;
}

/** A layer mask canvas (white, alpha = the mask value) from a plane of 0..255 values. */
function maskCanvas(plane, w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = plane[p];
  }
  const c = createCanvas(w, h);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

/** The pixels of a raster layer on a w × h frame whose origin is the document's (its mask and opacity ignored). */
function layerFrame(layer, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(layer.canvas, layer.x, layer.y);
  return ctx.getImageData(0, 0, w, h);
}

function alphaPlane(img) {
  const out = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = img.data[i];
  return out;
}

/** A copy of a canvas with its colour channels multiplied by per-channel gains. */
function gainCanvas(canvas, gain) {
  const img = canvasData(canvas);
  R.applyGain(img, gain);
  const c = createCanvas(canvas.width, canvas.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

const gainMatters = (g) => g.some((v) => Math.abs(v - 1) > 0.004);

/**
 * Seam masks (and gains) for layers given as frames of one size. method 'panorama' cuts each overlap along
 * its middle; 'stack' gives every pixel to the sharpest layer (focus stacking).
 */
async function blendPlan(frames, w, h, { method = 'panorama', seamless = true } = {}) {
  const gains = seamless ? R.gainCompensation(frames) : frames.map(() => [1, 1, 1]);
  const alphas = frames.map(alphaPlane);
  await breathe();
  let seams;
  if (method === 'stack') {
    const radius = Math.max(2, Math.round(Math.min(w, h) / 160));
    const weights = [];
    for (const f of frames) {
      weights.push(R.focusMeasure(f, radius));
      await breathe();
    }
    seams = R.seamMasks(alphas, w, h, { weights, feather: Math.max(2, Math.min(12, Math.round(Math.min(w, h) / 120))) });
  } else seams = R.seamMasks(alphas, w, h);
  return { gains, masks: seams.masks, feather: seams.feather, overlap: seams.overlap, alphas };
}

/** Coverage (0 / 255) of the pixels no frame covers, and how many there are. */
function holesOf(alphas, w, h) {
  const holes = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    let covered = false;
    for (let k = 0; k < alphas.length && !covered; k++) covered = alphas[k][i] >= 128;
    if (!covered) {
      holes[i] = 255;
      count++;
    }
  }
  return { holes, count };
}

// ---- history: several steps, one entry -------------------------------------------------------------------------

/**
 * Runs fn() (which may await and may push any number of history entries through the usual helpers) and leaves
 * exactly one entry labelled `label` behind. When fn throws, what it did is undone and nothing is recorded.
 */
async function asOneEntry(doc, label, fn) {
  const h = doc.history;
  const mark = h.mark();
  const known = new Set(mark.entries);
  const fresh = () => h.entries.slice(0, h.index + 1).filter((e) => !known.has(e));
  let result;
  try {
    result = await fn();
  } catch (err) {
    const made = fresh();
    for (let i = made.length - 1; i >= 0; i--) made[i].undo();
    h.rollback(mark);
    doc.changed('history');
    throw err;
  }
  const made = fresh();
  if (!made.length) return result;
  h.rollback(mark);
  h.push({
    label,
    undo: () => {
      for (let i = made.length - 1; i >= 0; i--) made[i].undo();
    },
    redo: () => {
      for (const e of made) e.redo();
    },
    bytes: made.reduce((n, e) => n + (e.bytes ?? 0), 0),
    at: Date.now(),
  });
  doc.changed('history');
  return result;
}

// ---- stack modes (the smart object hook) ----------------------------------------------------------------------

/** source object -> [{ key, canvas }] (the two most recent results, so undo and redo of a mode change are instant). */
const stackCache = new WeakMap();

/** One image per visible top-level layer of a stack document (bottom first), each rendered alone on the source canvas. */
function stackSamples(doc) {
  const out = [];
  for (const layer of doc.root.children) {
    if (!layer.visible || layer.type === 'adjustment' || layer.preview || layer.quickMask) continue;
    const plain = layer.type === 'raster' && !layer.mask && !layer.styles && layer.opacity === 1 && (layer.fillOpacity ?? 1) === 1 && layer.blend === 'normal' && !layer.clip;
    out.push(plain ? layerFrame(layer, doc.width, doc.height) : canvasData(renderLayersFlat(doc, [layer])));
  }
  return out;
}

const stackableLayers = (doc) => doc.root.children.filter((l) => l.visible && l.type !== 'adjustment' && !l.preview && !l.quickMask).length;

/**
 * What a smart object with a stack mode draws instead of the composite of its source: the statistic of the
 * source's layers. null (the normal composite) when the mode is "none" or the source is not a stack.
 */
function stackRender(layer) {
  const mode = layer.stackMode;
  const src = layer.source;
  if (!mode || mode === 'none' || !STACK_MODE_IDS.includes(mode) || src?.kind !== 'document') return null;
  const key = `${src.doc.version}:${src.doc.root.version}:${mode}`;
  const list = stackCache.get(src) ?? [];
  const hit = list.find((e) => e.key === key);
  if (hit) return hit.canvas;
  const samples = stackSamples(src.doc);
  if (samples.length < 2) return null;
  const canvas = dataCanvas(stackImages(samples, mode));
  stackCache.set(src, [{ key, canvas }, ...list].slice(0, 2));
  return canvas;
}

// ---- install ---------------------------------------------------------------------------------------------------

export function install(app) {
  const settingsOf = (key) => (app.settings[key] && typeof app.settings[key] === 'object' ? app.settings[key] : (app.settings[key] = {}));
  const remembered = () => settingsOf('alignBlend');
  const toast = (message, opts) => app.dialogs.toast(message, opts);
  /** A document built here exists nowhere on disk: closing it asks to save (as Contact Sheet and Image › Duplicate do). */
  const neverSaved = (doc) => {
    doc.history.savedIndex = -2;
    doc.history.onChange(); // the tab shows the unsaved dot at once
  };

  // smart-object.js asks this hook for the pixels of a smart object that has a stack mode
  SmartLayer.stackRender = stackRender;

  /** Selected raster layers, bottom first. */
  const selectedRasters = (d = app.doc) => (d ? d.layers().filter((l) => d.selected.has(l) && l.type === 'raster' && !l.preview && !l.quickMask) : []);
  const canAlign = () => selectedRasters().length >= 2;
  const reselect = (d, ids) => {
    const found = ids.map((id) => d.find(id)).filter(Boolean);
    if (!found.length) return;
    d.selected = new Set(found);
    if (!found.includes(d.active)) d.active = found[found.length - 1];
    d.changed('active', { layer: d.active });
  };

  /**
   * The registration and the blend plan are computed from the layers as they are when the command starts, over
   * several frames. Returns a test for "the document is not that document any more" (an undo, an edit, a deleted
   * layer, a closed tab): the result is then dropped instead of being applied to layers it was not made for.
   */
  const staleCheck = (d, layers) => {
    const top = () => d.history.entries[d.history.index] ?? null;
    const at = top();
    const canvases = layers.map((l) => l.canvas);
    return () => !app.docs.docs.includes(d) || top() !== at || layers.some((l, i) => d.find(l.id) !== l || l.canvas !== canvases[i]);
  };

  // ---- Auto-Align Layers ------------------------------------------------------------------------------------

  async function autoAlign(arg, ctx) {
    const d = app.doc;
    const layers = selectedRasters(d);
    if (layers.length < 2) {
      ctx?.cancel();
      return toast('Auto-Align needs two or more pixel layers selected in the Layers panel', { kind: 'error' });
    }
    const locked = layers.filter((l) => l.locked.all || l.locked.position || l.locked.pixels);
    if (locked.length > 1) {
      ctx?.cancel();
      return toast('Only one of the layers to align may be locked (it becomes the reference)', { kind: 'error' });
    }
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = remembered();
      const v = await formDialog(app, {
        title: 'Auto-Align Layers',
        width: 440,
        intro: `Registers the ${layers.length} selected layers on their common content. ${locked.length ? `"${locked[0].name}" is locked and stays where it is.` : 'The layer the others overlap best (the middle one of a row of frames) stays where it is.'}`,
        fields: [
          { key: 'projection', label: 'Projection', type: 'select', value: PROJECTION_NAMES[saved.projection] ? saved.projection : 'auto', options: PROJECTION_OPTIONS },
          { type: 'custom', render: () => el('p', 'muted', 'Auto picks the simplest motion that fits: a move, a move with rotation and scale (Collage), a perspective, or a cylinder for wide panoramas. Reposition only moves the layers and keeps the canvas; the others grow the canvas to hold every layer.') },
          { type: 'section', label: 'Lens Correction' },
          { key: 'vignette', label: 'Vignette Removal', type: 'checkbox', value: !!saved.vignette },
          { key: 'distortion', label: 'Geometric Distortion', type: 'checkbox', value: !!saved.distortion },
        ],
      });
      if (!v) return ctx?.cancel();
      o = { projection: v.projection, vignette: !!v.vignette, distortion: !!v.distortion };
      Object.assign(saved, o);
      app.saveSettingsSoon();
    }
    const projection = PROJECTION_NAMES[o.projection] ? o.projection : 'auto';
    const ids = layers.map((l) => l.id);
    const stale = staleCheck(d, layers);
    try {
      const outcome = await app.busy('Aligning layers…', async () => {
        const images = layers.map((l) => canvasData(l.canvas));
        const reference = locked.length ? layers.indexOf(locked[0]) : undefined;
        const reg = await registerImages(images, { projection, reference, vignette: !!o.vignette, distortion: !!o.distortion });
        if (stale()) return { stale: true };
        const ref = layers[reg.result.reference];
        const origin = { x: ref.x, y: ref.y };
        const skipped = [];
        const placed = [];
        layers.forEach((layer, i) => {
          const t = reg.result[i];
          if (!t.matched) {
            skipped.push(layer.name);
            return;
          }
          const source = reg.corrected[i] ? dataCanvas(reg.images[i]) : layer.canvas;
          const p = place(source, t);
          if (!p) {
            skipped.push(layer.name);
            return;
          }
          placed.push({ layer, canvas: p.canvas, x: p.x + origin.x, y: p.y + origin.y, model: t });
        });
        await breathe();
        let moved = 0;
        await asOneEntry(d, 'Auto-Align Layers', async () => {
          for (const p of placed) {
            if (p.canvas === p.layer.canvas && p.x === p.layer.x && p.y === p.layer.y) continue;
            // a linked mask goes with its layer (as under Free Transform); it is mapped before the layer moves
            const mask = p.layer.mask?.canvas && p.layer.mask.linked !== false ? placeMask(p.layer, p.model, origin) : null;
            d.history.replaceCanvas('Auto-Align Layers', p.layer, () => ({ canvas: p.canvas, x: p.x, y: p.y }));
            if (mask) setLayerProps(app, p.layer, { mask: { ...p.layer.mask, canvas: mask } }, 'Auto-Align Layers');
            moved++;
          }
          if (projection === 'reposition' || !moved) return;
          // everything but Reposition grows the canvas so that no aligned layer is cut off (like Canvas Size, twice:
          // once anchored bottom-right for the room needed on the left and top, once top-left for the rest)
          let box = { x: 0, y: 0, width: d.width, height: d.height };
          for (const p of placed) box = unionRect(box, { x: p.x, y: p.y, width: p.canvas.width, height: p.canvas.height });
          const left = Math.max(0, -box.x), top = Math.max(0, -box.y);
          const width = Math.min(MAX_SIDE, box.width), height = Math.min(MAX_SIDE, box.height);
          const canvasSize = app.commands.commands.get('image:canvas-size');
          if (!canvasSize || (width === d.width && height === d.height)) return;
          if (left || top) await canvasSize.run({ width: Math.min(MAX_SIDE, d.width + left), height: Math.min(MAX_SIDE, d.height + top), anchor: 'se', color: null });
          if (width !== d.width || height !== d.height) await canvasSize.run({ width, height, anchor: 'nw', color: null });
        });
        reselect(d, ids);
        return { moved, aligned: placed.length, skipped, projection: reg.result.projection, notes: reg.notes };
      });
      if (outcome.stale) {
        ctx?.cancel();
        return toast('The document changed while its layers were being aligned: nothing was aligned', { kind: 'error', timeout: 5000 });
      }
      app.view?.invalidate();
      const parts = [];
      if (outcome.moved) parts.push(`Aligned ${plural(outcome.aligned, 'layer')} (${PROJECTION_NAMES[outcome.projection]})`);
      else if (!outcome.skipped.length) parts.push('The layers are already aligned');
      if (outcome.skipped.length) parts.push(`${outcome.skipped.map((n) => `"${n}"`).join(', ')} could not be aligned: no common content was found`);
      parts.push(...outcome.notes);
      toast(sentence(parts), { kind: outcome.skipped.length && !outcome.moved ? 'error' : 'info', timeout: 5000 });
      ctx?.setReplayArg({ projection, vignette: !!o.vignette, distortion: !!o.distortion });
      return outcome;
    } catch (err) {
      app.reportError(err, 'Auto-Align Layers failed');
      ctx?.cancel();
    }
  }

  /** Joins message parts into one line: "First part; second part; third part". */
  const sentence = (parts) => parts.map((p, i) => (i ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('; ');

  // ---- Auto-Blend Layers ------------------------------------------------------------------------------------

  async function autoBlend(arg, ctx) {
    const d = app.doc;
    const layers = selectedRasters(d);
    if (layers.length < 2) {
      ctx?.cancel();
      return toast('Auto-Blend needs two or more pixel layers selected in the Layers panel', { kind: 'error' });
    }
    if (layers.some((l) => l.locked.all || l.locked.pixels)) {
      ctx?.cancel();
      return toast('Unlock the selected layers first: Auto-Blend adds masks and may adjust their tones', { kind: 'error' });
    }
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = remembered();
      const v = await formDialog(app, {
        title: 'Auto-Blend Layers',
        width: 440,
        intro: `Adds layer masks to the ${layers.length} selected layers so that each area shows the best layer for it. The layers stay separate and the masks stay editable.`,
        fields: [
          { key: 'method', label: 'Blend Method', type: 'segment', value: saved.method === 'stack' ? 'stack' : 'panorama', options: [['panorama', 'Panorama'], ['stack', 'Stack Images']], span: true },
          { type: 'custom', when: (x) => x.method === 'panorama', render: () => el('p', 'muted', 'Panorama: overlapping layers are cut along a soft seam through the middle of each overlap.') },
          { type: 'custom', when: (x) => x.method === 'stack', render: () => el('p', 'muted', 'Stack Images: every area is taken from the layer that is sharpest there (focus stacking). Align the layers first.') },
          { key: 'seamless', label: 'Seamless Tones and Colors', type: 'checkbox', value: saved.seamless !== false, span: true },
          { key: 'fill', label: 'Content Aware Fill Transparent Areas', type: 'checkbox', value: !!saved.fill, span: true },
        ],
      });
      if (!v) return ctx?.cancel();
      o = { method: v.method, seamless: !!v.seamless, fill: !!v.fill };
      Object.assign(saved, o);
      app.saveSettingsSoon();
    }
    const method = o.method === 'stack' ? 'stack' : 'panorama';
    const ids = layers.map((l) => l.id);
    const stale = staleCheck(d, layers);
    try {
      const outcome = await app.busy('Blending layers…', async () => {
        const w = d.width, h = d.height;
        const frames = layers.map((l) => layerFrame(l, w, h));
        await breathe();
        const plan = await blendPlan(frames, w, h, { method, seamless: o.seamless !== false });
        await breathe();
        const { holes, count } = o.fill ? holesOf(plan.alphas, w, h) : { holes: null, count: 0 };
        if (stale()) return { stale: true };
        let toned = 0, filled = false;
        await asOneEntry(d, 'Auto-Blend Layers', async () => {
          layers.forEach((layer, i) => {
            if (gainMatters(plan.gains[i])) {
              d.history.replaceCanvas('Auto-Blend Layers', layer, () => ({ canvas: gainCanvas(layer.canvas, plan.gains[i]), x: layer.x, y: layer.y }));
              toned++;
            }
            setLayerProps(app, layer, { mask: { canvas: maskCanvas(plan.masks[i], w, h), enabled: true, linked: true } }, 'Auto-Blend Layers');
          });
          if (!count || count === w * h) return;
          // like Photoshop: the fill goes on a merged copy above the blended layers, which stay as they are
          const top = layers[layers.length - 1];
          const merged = new RasterLayer({ name: `${top.name} (merged)`, canvas: renderLayersFlat(d, layers), x: 0, y: 0 });
          structural(app, 'Auto-Blend Layers', () => {
            d.add(merged, top.parent, top.parent.children.indexOf(top) + 1);
            d.setActive(merged);
          });
          app.setEditingMask?.(false);
          filled = await contentAwareFill(app, holes, { label: 'Auto-Blend Layers', quiet: true });
        });
        if (!filled) reselect(d, ids);
        return { toned, filled, holes: count, feather: plan.feather };
      });
      if (outcome.stale) {
        ctx?.cancel();
        return toast('The document changed while its layers were being blended: nothing was blended', { kind: 'error', timeout: 5000 });
      }
      app.view?.invalidate();
      const parts = [`Blended ${plural(layers.length, 'layer')} with masks (${method === 'stack' ? 'sharpest layer per area' : `seams feathered by ${Math.max(1, Math.round(outcome.feather))} px`})`];
      if (outcome.toned) parts.push(`tones matched on ${plural(outcome.toned, 'layer')}`);
      if (o.fill) parts.push(outcome.filled ? 'transparent areas filled on a merged layer' : outcome.holes ? 'the transparent areas could not be filled' : 'there were no transparent areas to fill');
      toast(sentence(parts), { timeout: 4500 });
      ctx?.setReplayArg({ method, seamless: o.seamless !== false, fill: !!o.fill });
      return outcome;
    } catch (err) {
      app.reportError(err, 'Auto-Blend Layers failed');
      ctx?.cancel();
    }
  }

  // ---- sources shared by Photomerge, Load Files into Stack and Statistics --------------------------------------

  /** Dialog fields that choose between the open documents and files. */
  function sourceFields(open) {
    const fields = [
      { key: 'source', label: 'Use', type: 'segment', value: open.length >= 2 ? 'documents' : 'files', options: [['documents', 'Open documents'], ['files', 'Files…']], span: true },
      ...open.map((d) => ({ key: `doc:${d.id}`, label: `${d.name} (${d.width} × ${d.height})`, type: 'checkbox', value: true, span: true, when: (v) => v.source === 'documents' })),
    ];
    if (!open.length) fields.push({ type: 'custom', when: (v) => v.source === 'documents', render: () => el('p', 'muted', 'No documents are open: choose Files… to pick the images.') });
    fields.push({ type: 'custom', when: (v) => v.source === 'files', render: () => el('p', 'muted', 'The file dialog opens when you confirm; pick two or more images.') });
    return fields;
  }
  const sourceOf = (v, open) => (v.source === 'documents' ? { source: 'documents', documents: open.filter((d) => v[`doc:${d.id}`]).map((d) => d.id) } : { source: 'files' });

  /** [{ name, canvas, dpi }] for a source choice; null when the file dialog was dismissed. Remembers the paths in `o`. */
  async function loadFrames(o, title) {
    if (o.source === 'files') {
      let paths = Array.isArray(o.paths) ? o.paths : null;
      if (!paths) paths = await bridge.openFileDialog({ title, multiple: true, filters: OPEN_FILTERS });
      if (!Array.isArray(paths) || !paths.length) return null;
      o.paths = paths;
      return app.busy('Opening images…', async () => {
        const out = [];
        for (const path of paths) {
          const name = fileName(path);
          const doc = await openDocument(await bridge.readFile(path), { name, path });
          out.push({ name: baseName(name), canvas: flattenDocument(doc), dpi: doc.dpi });
        }
        return out;
      });
    }
    const open = app.docs.list();
    const ids = Array.isArray(o.documents) ? o.documents : open.map((d) => d.id);
    const chosen = open.filter((d) => ids.includes(d.id));
    // replayed from an action the documents it was recorded with may be gone: all open documents are used then.
    // A choice made in the dialog is taken as it is, also when it is too small (the command says so)
    const stale = chosen.length < ids.length && chosen.length < 2;
    return (stale ? open : chosen).map((d) => ({ name: baseName(d.name), canvas: copyCanvas(flattenDocument(d, d.view?.compositor)), dpi: d.dpi }));
  }

  /** Adds a finished layer to a document that is not shown yet (no history exists for it). */
  function pushLayer(doc, layer) {
    layer.parent = doc.root;
    doc.root.children.push(layer);
    doc.active = layer;
    doc.selected = new Set([layer]);
  }

  // ---- Photomerge ------------------------------------------------------------------------------------------------

  async function photomerge(arg, ctx) {
    const open = app.docs.list();
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = settingsOf('photomerge');
      const v = await formDialog(app, {
        title: 'Photomerge',
        width: 480,
        okLabel: 'Merge',
        intro: 'Registers overlapping photographs and puts them, one layer each, into a new document that is large enough for all of them.',
        fields: [
          ...sourceFields(open),
          { type: 'section', label: 'Layout' },
          { key: 'layout', label: 'Layout', type: 'select', value: PROJECTION_NAMES[saved.layout] ? saved.layout : 'auto', options: PROJECTION_OPTIONS },
          { key: 'blend', label: 'Blend Images Together', type: 'checkbox', value: saved.blend !== false, span: true },
          { key: 'vignette', label: 'Vignette Removal', type: 'checkbox', value: !!saved.vignette, span: true },
          { key: 'distortion', label: 'Geometric Distortion Correction', type: 'checkbox', value: !!saved.distortion, span: true },
          { key: 'fill', label: 'Content Aware Fill Transparent Areas', type: 'checkbox', value: !!saved.fill, span: true },
        ],
      });
      if (!v) return ctx?.cancel();
      o = { ...sourceOf(v, open), layout: v.layout, blend: !!v.blend, vignette: !!v.vignette, distortion: !!v.distortion, fill: !!v.fill };
      Object.assign(saved, { layout: o.layout, blend: o.blend, vignette: o.vignette, distortion: o.distortion, fill: o.fill });
      app.saveSettingsSoon();
    }
    const layout = PROJECTION_NAMES[o.layout] ? o.layout : 'auto';
    try {
      const frames = await loadFrames(o, 'Photomerge: choose the photographs');
      if (!frames) return ctx?.cancel();
      if (frames.length < 2) {
        ctx?.cancel();
        return toast('Photomerge needs at least two overlapping images', { kind: 'error' });
      }
      const built = await app.busy('Merging photographs…', async () => {
        const reg = await registerImages(frames.map((f) => canvasData(f.canvas)), { projection: layout, vignette: !!o.vignette, distortion: !!o.distortion });
        await breathe();
        const placed = [];
        const lost = [];
        frames.forEach((f, i) => {
          const t = reg.result[i];
          const p = t.matched ? place(reg.corrected[i] ? dataCanvas(reg.images[i]) : f.canvas, t) : null;
          if (p) placed.push({ name: f.name, canvas: p.canvas, x: p.x, y: p.y });
          else lost.push(f);
        });
        if (placed.length < 2) return { error: 'No overlap was found between the images: nothing to merge' };
        let box = null;
        for (const p of placed) {
          const r = { x: p.x, y: p.y, width: p.canvas.width, height: p.canvas.height };
          box = box ? unionRect(box, r) : r;
        }
        if (box.width > MAX_SIDE || box.height > MAX_SIDE || box.width * box.height > MAX_PIXELS) return { error: `The merged image would be ${box.width} × ${box.height} px, which is too large: try the Cylindrical layout or smaller images` };
        const doc = new Document({ width: box.width, height: box.height, dpi: frames[0].dpi || 72, name: 'Panorama' });
        const layers = placed.map((p) => {
          // a layer keeps its own canvas: a file's flattened image may be shared with nothing else, an open document's was copied
          const layer = new RasterLayer({ name: p.name, canvas: p.canvas, x: p.x - box.x, y: p.y - box.y });
          pushLayer(doc, layer);
          return layer;
        });
        // images without a place come along hidden at the top-left, so nothing the user chose is lost silently
        for (const f of lost) pushLayer(doc, new RasterLayer({ name: f.name, canvas: f.canvas, x: 0, y: 0, visible: false }));
        await breathe();
        let holes = null, holeCount = 0, feather = 0;
        const w = doc.width, h = doc.height;
        if (o.blend !== false || o.fill) {
          const layerFrames = layers.map((l) => layerFrame(l, w, h));
          if (o.blend !== false) {
            const plan = await blendPlan(layerFrames, w, h, { method: 'panorama', seamless: true });
            layers.forEach((layer, i) => {
              if (gainMatters(plan.gains[i])) layer.canvas = gainCanvas(layer.canvas, plan.gains[i]);
              layer.mask = { canvas: maskCanvas(plan.masks[i], w, h), enabled: true, linked: true };
            });
            feather = plan.feather;
            if (o.fill) ({ holes, count: holeCount } = holesOf(plan.alphas, w, h));
          } else ({ holes, count: holeCount } = holesOf(layerFrames.map(alphaPlane), w, h));
        }
        let merged = null;
        if (o.fill && holeCount && holeCount < w * h) {
          merged = new RasterLayer({ name: 'Panorama (merged)', canvas: renderLayersFlat(doc, layers), x: 0, y: 0 });
          const top = layers[layers.length - 1];
          merged.parent = doc.root;
          doc.root.children.splice(doc.root.children.indexOf(top) + 1, 0, merged);
        }
        doc.active = merged ?? layers[layers.length - 1];
        doc.selected = new Set([doc.active]);
        return { doc, merged, holes, holeCount, lost, feather, projection: reg.result.projection, notes: reg.notes, count: layers.length };
      });
      if (built.error) {
        ctx?.cancel();
        return toast(built.error, { kind: 'error', timeout: 6000 });
      }
      app.docs.add(built.doc);
      let filled = false;
      if (built.merged) {
        filled = await contentAwareFill(app, built.holes, { label: 'Content-Aware Fill', quiet: true });
        // the fill is part of the merge, not an edit made afterwards
        built.doc.history.clear?.();
        built.doc.changed('history');
      }
      neverSaved(built.doc);
      const parts = [`Merged ${plural(built.count, 'image')} (${PROJECTION_NAMES[built.projection]}${o.blend !== false ? ', blended with masks' : ''})`];
      if (built.lost.length) parts.push(`${built.lost.map((f) => `"${f.name}"`).join(', ')} could not be placed and ${built.lost.length === 1 ? 'was' : 'were'} added hidden`);
      if (o.fill) parts.push(filled ? 'transparent areas filled on a merged layer' : built.holeCount ? 'the transparent areas could not be filled' : 'there were no transparent areas to fill');
      parts.push(...built.notes);
      toast(sentence(parts), { timeout: 5000 });
      ctx?.setReplayArg(clone(o));
      return built.doc;
    } catch (err) {
      app.reportError(err, 'Photomerge failed');
      ctx?.cancel();
    }
  }

  // ---- Load Files into Stack, Statistics ------------------------------------------------------------------------

  /**
   * Builds a stack document from frames: one layer per image on a canvas as large as the largest image, the
   * first image at the bottom. With `align` the images are registered on the first one (the canvas keeps its
   * size, as a stack is meant to be compared pixel by pixel). Returns { doc, layers, notes, lost }.
   */
  async function buildStack(frames, { align = false, name = 'Stack' } = {}) {
    const w = Math.max(...frames.map((f) => f.canvas.width)), h = Math.max(...frames.map((f) => f.canvas.height));
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error('The images are too large to stack');
    const doc = new Document({ width: w, height: h, dpi: frames[0].dpi || 72, name });
    let positions = frames.map((f) => ({ canvas: f.canvas, x: 0, y: 0 }));
    const notes = [];
    const lost = [];
    if (align && frames.length > 1) {
      const reg = await registerImages(frames.map((f) => canvasData(f.canvas)), { projection: 'auto', reference: 0 });
      positions = frames.map((f, i) => {
        const p = reg.result[i].matched ? place(f.canvas, reg.result[i]) : null;
        if (!p) lost.push(f.name);
        return p ?? { canvas: f.canvas, x: 0, y: 0 };
      });
      notes.push(`aligned (${PROJECTION_NAMES[reg.result.projection]})`);
      if (lost.length) notes.push(`${lost.map((n) => `"${n}"`).join(', ')} could not be aligned`);
    }
    const layers = frames.map((f, i) => {
      const layer = new RasterLayer({ name: f.name, canvas: positions[i].canvas, x: positions[i].x, y: positions[i].y });
      pushLayer(doc, layer);
      return layer;
    });
    return { doc, layers, notes, lost };
  }

  /** Wraps the layers of a stack document into one smart object in a new document of the same size. */
  function stackAsSmartObject(stack, name, mode = null) {
    const host = new Document({ width: stack.width, height: stack.height, dpi: stack.dpi, name });
    const smart = new SmartLayer({ name, source: makeSource({ kind: 'document', doc: stack, name }), stackMode: mode && mode !== 'none' ? mode : null });
    pushLayer(host, smart);
    attachHost(smart, host);
    return { host, smart };
  }

  async function loadStack(arg, ctx) {
    const open = app.docs.list();
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = settingsOf('loadStack');
      const v = await formDialog(app, {
        title: 'Load Files into Stack',
        width: 480,
        intro: 'Loads each image as a layer of one new document.',
        fields: [
          ...sourceFields(open),
          { key: 'align', label: 'Attempt to Automatically Align Source Images', type: 'checkbox', value: !!saved.align, span: true },
          { key: 'smart', label: 'Create Smart Object after Loading Layers', type: 'checkbox', value: !!saved.smart, span: true },
        ],
      });
      if (!v) return ctx?.cancel();
      o = { ...sourceOf(v, open), align: !!v.align, smart: !!v.smart };
      Object.assign(saved, { align: o.align, smart: o.smart });
      app.saveSettingsSoon();
    }
    try {
      const frames = await loadFrames(o, 'Load Files into Stack: choose the images');
      if (!frames) return ctx?.cancel();
      if (!frames.length) {
        ctx?.cancel();
        return toast('Load Files into Stack needs at least one image', { kind: 'error' });
      }
      const built = await app.busy('Loading the stack…', async () => {
        const stack = await buildStack(frames, { align: !!o.align, name: frames.length ? `${frames[0].name} stack` : 'Stack' });
        if (!o.smart) return stack;
        return { ...stack, ...stackAsSmartObject(stack.doc, stack.doc.name) };
      });
      const doc = built.host ?? built.doc;
      app.docs.add(doc);
      neverSaved(doc);
      toast(sentence([`Loaded ${plural(frames.length, 'image')} into ${o.smart ? 'a smart object' : 'layers'}`, ...built.notes]), { timeout: 4000 });
      ctx?.setReplayArg(clone(o));
      return doc;
    } catch (err) {
      app.reportError(err, 'Load Files into Stack failed');
      ctx?.cancel();
    }
  }

  async function statistics(arg, ctx) {
    const open = app.docs.list();
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = settingsOf('statistics');
      const v = await formDialog(app, {
        title: 'Image Statistics',
        width: 480,
        okLabel: 'OK',
        intro: 'Stacks the images in a smart object and shows one statistic of them per pixel. The stack mode can be changed later under Layer › Smart Objects › Stack Mode.',
        fields: [
          { key: 'mode', label: 'Choose Stack Mode', type: 'select', value: STACK_MODE_IDS.includes(saved.mode) && saved.mode !== 'none' ? saved.mode : 'median', options: STACK_MODES.filter(([id]) => id !== 'none') },
          ...sourceFields(open),
          { key: 'align', label: 'Attempt to Automatically Align Source Images', type: 'checkbox', value: !!saved.align, span: true },
        ],
      });
      if (!v) return ctx?.cancel();
      o = { ...sourceOf(v, open), mode: v.mode, align: !!v.align };
      Object.assign(saved, { mode: o.mode, align: o.align });
      app.saveSettingsSoon();
    }
    const mode = STACK_MODE_IDS.includes(o.mode) && o.mode !== 'none' ? o.mode : 'median';
    try {
      const frames = await loadFrames(o, 'Statistics: choose the images');
      if (!frames) return ctx?.cancel();
      if (frames.length < 2) {
        ctx?.cancel();
        return toast('Statistics needs at least two images', { kind: 'error' });
      }
      const built = await app.busy(`Computing the ${stackModeName(mode).toLowerCase()} of the stack…`, async () => {
        const stack = await buildStack(frames, { align: !!o.align, name: `${stackModeName(mode)} of ${frames.length} images` });
        const wrapped = stackAsSmartObject(stack.doc, stack.doc.name, mode);
        await breathe();
        stackRender(wrapped.smart); // computed here, under the busy cursor, not at the first paint
        return { ...stack, ...wrapped };
      });
      app.docs.add(built.host);
      neverSaved(built.host);
      toast(sentence([`${stackModeName(mode)} of ${plural(frames.length, 'image')} in a smart object`, ...built.notes]), { timeout: 4000 });
      ctx?.setReplayArg(clone({ ...o, mode }));
      return built.host;
    } catch (err) {
      app.reportError(err, 'Statistics failed');
      ctx?.cancel();
    }
  }

  // ---- Layer > Smart Objects > Stack Mode ------------------------------------------------------------------------

  const activeSmart = () => (app.doc?.active?.type === 'smart' ? app.doc.active : null);

  async function setStackMode(arg) {
    const layer = activeSmart();
    if (!layer) return;
    const mode = STACK_MODE_IDS.includes(arg) ? arg : 'none';
    const current = layer.stackMode ?? 'none';
    if (mode === current) return;
    if (layer.locked.all) {
      // the native menu's radio already moved: put it back
      app.syncUiState();
      return toast(`"${layer.name}" is locked`, { kind: 'error' });
    }
    if (mode !== 'none') {
      if (layer.source?.kind !== 'document' || stackableLayers(layer.source.doc) < 2) {
        app.syncUiState();
        return toast('A stack mode needs a smart object that holds two or more layers (File › Scripts › Load Files into Stack makes one)', { kind: 'error', timeout: 5000 });
      }
      const probe = { stackMode: mode, source: layer.source };
      await app.busy(`Stack Mode: ${stackModeName(mode)}…`, async () => stackRender(probe));
    }
    setLayerProps(app, layer, { stackMode: mode === 'none' ? null : mode }, `Stack Mode: ${stackModeName(mode)}`);
    app.syncUiState();
    app.view?.invalidate();
  }

  app.commands.registerAll({
    'edit:auto-align': { enabled: canAlign, run: autoAlign, label: 'Auto-Align Layers…', dialog: true },
    'edit:auto-blend': { enabled: canAlign, run: autoBlend, label: 'Auto-Blend Layers…', dialog: true },
    'file:automate-photomerge': { run: photomerge, label: 'Photomerge…', dialog: true },
    'file:script-load-stack': { run: loadStack, label: 'Load Files into Stack…', dialog: true },
    'file:script-statistics': { run: statistics, label: 'Statistics…', dialog: true },
    'layer:stack-mode': { enabled: () => !!activeSmart(), run: setStackMode, label: 'Stack Mode' },
  });

  // ---- for other modules and tests --------------------------------------------------------------------------------
  app.alignBlend = {
    /**
     * Registers images of one size on each other and returns them resampled into their common frame (same
     * size, same order; Merge to HDR aligns its exposures with it). Where an aligned image has no pixels the
     * original ones are kept, so the result has no holes.
     */
    async alignImages(images, { projection = 'auto' } = {}) {
      if (!Array.isArray(images) || images.length < 2) return images;
      const result = await alignStepwise(images, { projection });
      const ref = images[result.reference];
      const rect = { x: 0, y: 0, width: ref.width, height: ref.height };
      return images.map((img, i) => {
        const t = result[i];
        if (!t.matched || img.width !== rect.width || img.height !== rect.height) return img;
        let model = t;
        const m = t.matrix;
        if (m && Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) {
          // a pure shift is applied in whole pixels: the exposure keeps its sharpness
          const dx = Math.round(m[4]), dy = Math.round(m[5]);
          if (!dx && !dy) return img;
          model = { ...t, homography: [1, 0, dx, 0, 1, dy, 0, 0, 1] };
        }
        const out = R.applyAlignment(img, model, rect);
        const d = out.data, s = img.data;
        for (let k = 0; k < d.length; k += 4) if (d[k + 3] < 255) {
          d[k] = s[k];
          d[k + 1] = s[k + 1];
          d[k + 2] = s[k + 2];
          d[k + 3] = s[k + 3];
        }
        return typeof ImageData === 'function' ? new ImageData(d, out.width, out.height) : out;
      });
    },
    register: registerImages,
    place,
    stackRender,
    stackSamples,
    modes: STACK_MODES,
  };
}
