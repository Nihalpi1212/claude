// Layer › New › Background from Layer / Layer from Background, Group from Layers, Delete › Hidden
// Layers, Rasterize › All Layers, Smart Objects › Convert to Layers and Select › Deselect Layers.
// Tree edits go through structural() (one undo entry each, exact restore); property edits through
// setLayerProps().
import { RasterLayer, GroupLayer, createCanvas, copyCanvas, BLEND_MODES } from '../document.js';
import { structural, setLayerProps, cloneLayer, rasterizeLayer, renderLayersFlat, releaseOrphanClips, nextLayerName } from '../layer-ops.js';
import { affineCanvas } from '../image-ops.js';
import { formDialog } from '../form.js';
import * as T from '../../../shared/pixels/transform.js';
import { labelOptions, normaliseLabel, labelOf } from './tags.js';

const isAncestor = (a, l) => {
  for (let p = l.parent; p; p = p.parent) if (p === a) return true;
  return false;
};
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const blendOptions = (group) => [...(group ? [['pass-through', 'Pass Through']] : []), ...BLEND_MODES.filter(Boolean)];
const neutralLocks = { pixels: false, position: false, transparency: false, all: false };
// Photoshop's Background cannot move or become transparent, but it can be painted on
const BACKGROUND_LOCKS = { pixels: false, position: true, transparency: true, all: false };

/** The Photoshop "Background": the bottom layer of the document, a raster layer named Background. */
export function isBackgroundLayer(layer) {
  const p = layer?.parent;
  return !!layer && layer.type === 'raster' && layer.name === 'Background' && !!p && !p.parent && p.children[0] === layer;
}

// ---- moving cloned layers through an affine matrix (Convert to Layers) ---------------------------------------

function mapPath(path, f) {
  const out = clone(path);
  for (const sp of out?.subpaths ?? []) for (const pt of sp.points ?? []) {
    const hadIn = pt.inX !== undefined, hadOut = pt.outX !== undefined;
    const inP = hadIn ? f(pt.inX, pt.inY) : null, outP = hadOut ? f(pt.outX, pt.outY) : null;
    [pt.x, pt.y] = f(pt.x, pt.y);
    if (hadIn) [pt.inX, pt.inY] = inP;
    if (hadOut) [pt.outX, pt.outY] = outP;
  }
  return out;
}

function cornerAlpha(canvas) {
  try {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
  } catch {
    return 255;
  }
}

/**
 * A source-document mask as a host-document mask: what the matrix does not cover keeps the mask's background,
 * or stays hidden when `bounded` (fill and adjustment layers reached no further than their source canvas).
 */
function mapMask(mask, m, W, H, bounded = false) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const bg = bounded ? 0 : cornerAlpha(mask);
  ctx.save();
  if (bg > 0) {
    ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mask.width, mask.height);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
  return c;
}

function scaleStyles(styles, s) {
  if (!styles || Math.abs(s - 1) < 1e-6) return styles;
  const out = clone(styles);
  for (const v of Object.values(out)) {
    if (!v || typeof v !== 'object') continue;
    for (const k of ['size', 'distance', 'width']) if (typeof v[k] === 'number') v[k] *= s;
  }
  return out;
}

/** Moves a freshly cloned layer (and its children) from a smart object's source space into the host document. */
export function mapLayerAffine(layer, m, W, H, src = null) {
  const point = (x, y) => T.applyMatrix(m, x, y);
  const translation = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && Number.isInteger(m[4]) && Number.isInteger(m[5]);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (layer.isGroup) for (const c of layer.children) mapLayerAffine(c, m, W, H, src);
  else if (layer.type === 'raster') {
    if (translation) {
      layer.x += m[4];
      layer.y += m[5];
    } else {
      const r = affineCanvas(layer.canvas, layer.x, layer.y, m);
      layer.canvas = r.canvas;
      layer.x = r.x;
      layer.y = r.y;
      layer.deep = null; // 16/32-bit samples no longer line up with the resampled proxy (lib/depth.js rebuilds them)
    }
  } else if (layer.type === 'text') {
    if (translation && !layer.transform) {
      layer.x += m[4];
      layer.y += m[5];
      if (layer.pathText?.path) layer.pathText = { ...layer.pathText, path: mapPath(layer.pathText.path, point) };
    } else layer.transform = T.multiplyMatrix(m, layer.transform ?? T.IDENTITY);
  } else if (layer.type === 'shape') {
    layer.path = mapPath(layer.path, point);
    if (layer.stroke && !translation) layer.stroke = { ...layer.stroke, width: layer.stroke.width * scale };
  } else if (layer.type === 'fill') {
    const g = layer.paint?.gradient;
    if (g?.from && g?.to) layer.paint = { ...layer.paint, gradient: { ...g, from: point(...g.from), to: point(...g.to) } };
    layer.docWidth = W;
    layer.docHeight = H;
  } else if (layer.usesMatrixTransform) layer.transform = T.multiplyMatrix(m, layer.transform ?? T.IDENTITY);
  if (src && (layer.type === 'fill' || layer.type === 'adjustment')) {
    // these layers have no extent of their own: inside the smart object they ended at its canvas, so a mask keeps them there
    let mask = layer.mask?.canvas;
    if (!mask) {
      mask = createCanvas(src.width, src.height);
      const mctx = mask.getContext('2d');
      mctx.fillStyle = '#fff';
      mctx.fillRect(0, 0, src.width, src.height);
    }
    layer.mask = { enabled: true, linked: true, ...(layer.mask ?? {}), canvas: mapMask(mask, m, W, H, true) };
  } else if (layer.mask?.canvas) layer.mask = { ...layer.mask, canvas: mapMask(layer.mask.canvas, m, W, H) };
  if (layer.styles && !translation) layer.styles = scaleStyles(layer.styles, scale);
  layer._cache = null;
  layer.touch();
  return layer;
}

// ---- install ------------------------------------------------------------------------------------------------

export function installStructure(app) {
  const doc = () => app.doc;
  const selectedOrActive = (d) => {
    const sel = d.selectedLayers();
    return sel.length ? sel : d.active ? [d.active] : [];
  };
  const hasBackground = (d) => isBackgroundLayer(d.root.children[0]);

  app.isBackgroundLayer = isBackgroundLayer;

  // ---- Background from Layer / Layer from Background ----------------------------------------------------------
  async function fromBackground(arg, ctx = null) {
    const d = doc();
    const layer = d.active;
    if (!layer) return ctx?.cancel();
    if (isBackgroundLayer(layer)) {
      // actions (lib/actions.js): a recorded { name, color, blend, opacity } skips the dialog
      let o = arg && typeof arg === 'object' ? arg : null;
      if (!o) {
        o = await formDialog(app, {
          title: 'New Layer',
          intro: 'The Background becomes an ordinary layer: it can move, hold transparency and sit anywhere in the stack.',
          fields: [
            { key: 'name', label: 'Name', type: 'text', value: 'Layer 0' },
            { key: 'color', label: 'Color', type: 'select', value: labelOf(layer), options: labelOptions() },
            { key: 'blend', label: 'Mode', type: 'select', value: layer.blend, options: blendOptions(false) },
            { key: 'opacity', label: 'Opacity', type: 'slider', value: Math.round(layer.opacity * 100), min: 0, max: 100, unit: '%' },
          ],
        });
        if (!o) return ctx?.cancel();
      }
      // "Background" again would make it the Background once more
      const name = String(o.name ?? '').trim() && String(o.name).trim() !== 'Background' ? String(o.name).trim() : 'Layer 0';
      const patch = { name, locked: { ...neutralLocks }, color: normaliseLabel(o.color), blend: BLEND_MODES.some((b) => b && b[0] === o.blend) ? o.blend : layer.blend, opacity: Math.max(0, Math.min(100, Number(o.opacity ?? layer.opacity * 100))) / 100 };
      ctx?.setReplayArg({ name: patch.name, color: patch.color ?? 'none', blend: patch.blend, opacity: Math.round(patch.opacity * 100) });
      setLayerProps(app, layer, patch, 'Layer from background');
      return layer;
    }
    if (hasBackground(d) || layer.type === 'adjustment') {
      app.dialogs.toast(hasBackground(d) ? 'This document already has a Background layer' : 'An adjustment layer has no pixels to become the Background', { kind: 'error', timeout: 2400 });
      return ctx?.cancel();
    }
    ctx?.setReplayArg({}); // actions (lib/actions.js): nothing was asked, the step replays as it is
    // the layer as it looks by itself, flattened onto the background colour, at the bottom of the stack
    const wasVisible = layer.visible;
    layer.visible = true;
    let flat;
    try {
      flat = renderLayersFlat(d, [layer]);
    } finally {
      layer.visible = wasVisible;
    }
    const canvas = createCanvas(d.width, d.height);
    const c = canvas.getContext('2d');
    c.fillStyle = app.settings.background ?? '#ffffff';
    c.fillRect(0, 0, d.width, d.height);
    c.drawImage(flat, 0, 0);
    const bg = new RasterLayer({ name: 'Background', canvas, x: 0, y: 0, locked: { ...BACKGROUND_LOCKS } });
    structural(app, 'Background from layer', () => {
      d.remove(layer);
      d.add(bg, d.root, 0);
      releaseOrphanClips(d);
      d.setActive(bg);
    }, d, { bytes: d.width * d.height * 4 });
    app.setEditingMask(false);
    return bg;
  }

  // ---- Group from Layers ----------------------------------------------------------------------------------
  async function groupFromLayers(arg, ctx = null) {
    const d = doc();
    const picked = selectedOrActive(d);
    // a layer whose group is selected too moves with its group
    const layers = picked.filter((l) => !picked.some((o) => o !== l && isAncestor(o, l)));
    if (!layers.length) return ctx?.cancel();
    let o = arg && typeof arg === 'object' ? arg : null;
    if (!o) {
      o = await formDialog(app, {
        title: 'New Group from Layers',
        fields: [
          { key: 'name', label: 'Name', type: 'text', value: nextLayerName(d, 'Group') },
          { key: 'color', label: 'Color', type: 'select', value: 'none', options: labelOptions() },
          { key: 'blend', label: 'Mode', type: 'select', value: 'pass-through', options: blendOptions(true) },
          { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 0, max: 100, unit: '%' },
        ],
      });
      if (!o) return ctx?.cancel();
    }
    const name = String(o.name ?? '').trim() || nextLayerName(d, 'Group');
    const blend = blendOptions(true).some((b) => b[0] === o.blend) ? o.blend : 'pass-through';
    const opacity = Math.max(0, Math.min(100, Number(o.opacity ?? 100))) / 100;
    ctx?.setReplayArg({ name, color: normaliseLabel(o.color) ?? 'none', blend, opacity: Math.round(opacity * 100) });
    const order = d.layers();
    layers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const top = layers[layers.length - 1];
    const g = new GroupLayer({ name, blend, opacity });
    g.color = normaliseLabel(o.color);
    structural(app, 'Group from layers', () => {
      const parent = top.parent;
      d.add(g, parent, parent.children.indexOf(top) + 1);
      for (const l of layers) d.move(l, g, g.children.length);
      releaseOrphanClips(d);
      d.setActive(g);
    });
    return g;
  }

  // ---- Delete › Hidden Layers -------------------------------------------------------------------------------
  const hiddenLayers = (d) => d.layers().filter((l) => !l.visible);
  async function deleteHidden(arg, ctx = null) {
    const d = doc();
    const hidden = hiddenLayers(d);
    if (!hidden.length) {
      app.dialogs.toast('There are no hidden layers to delete', { kind: 'info', timeout: 2200 });
      return ctx?.cancel();
    }
    // a hidden layer inside a hidden group goes with its group
    const roots = hidden.filter((l) => !hidden.some((o) => o !== l && isAncestor(o, l)));
    const gone = new Set(roots);
    for (const l of d.layers()) if (roots.some((r) => isAncestor(r, l))) gone.add(l);
    if (d.layers().every((l) => gone.has(l) || l.isGroup)) {
      app.dialogs.toast('Every layer is hidden: at least one layer has to stay', { kind: 'error', timeout: 2600 });
      return ctx?.cancel();
    }
    const quiet = arg === true || arg?.confirm === false || ctx?.source === 'action';
    if (!quiet) {
      const ok = await app.dialogs.confirm(`Delete ${hidden.length} hidden layer${hidden.length === 1 ? '' : 's'}?`, { title: 'Delete Hidden Layers', okLabel: 'Delete', danger: true });
      if (!ok) return ctx?.cancel();
    }
    ctx?.setReplayArg({ confirm: false });
    structural(app, 'Delete hidden layers', () => {
      for (const l of roots) if (l.parent) d.remove(l);
      releaseOrphanClips(d);
      // the active layer may have sat inside a hidden group that is gone now: target what is left
      const left = new Set(d.layers());
      for (const l of [...d.selected]) if (!left.has(l)) d.selected.delete(l);
      if (d.active && !left.has(d.active)) d.setActive([...d.selected][0] ?? d.root.children[d.root.children.length - 1] ?? null);
    });
    app.setEditingMask(false);
    return hidden.length;
  }

  // ---- Rasterize › All Layers ---------------------------------------------------------------------------------
  const rasterizable = (d) => d.layers().filter((l) => !l.isGroup && l.type !== 'raster' && l.type !== 'adjustment');
  async function rasterizeAll() {
    const d = doc();
    const layers = rasterizable(d);
    if (!layers.length) {
      app.dialogs.toast('Every layer is made of pixels already', { kind: 'info', timeout: 2200 });
      return 0;
    }
    await app.busy('Rasterizing layers…', async () => {
      const pairs = [];
      for (const l of layers) {
        const r = rasterizeLayer(l, d);
        if (!r) continue;
        r.name = l.name;
        r.locked = { ...l.locked };
        if (l.color) r.color = l.color;
        if (l.linked) r.linked = l.linked;
        pairs.push([l, r]);
      }
      const bytes = pairs.reduce((n, [, r]) => n + r.canvas.width * r.canvas.height * 4, 0);
      structural(app, 'Rasterize all layers', () => {
        for (const [l, r] of pairs) {
          const p = l.parent;
          if (!p) continue;
          p.children[p.children.indexOf(l)] = r;
          r.parent = p;
          l.parent = null;
          p.touch();
          if (d.selected.delete(l)) d.selected.add(r);
          if (d.active === l) d.active = r;
        }
        d.changed('tree');
      }, d, { bytes });
    });
    app.setEditingMask(false);
    return layers.length;
  }

  // ---- Smart Objects › Convert to Layers ----------------------------------------------------------------------
  async function smartToLayers(arg, ctx = null) {
    const d = doc();
    const layer = (typeof arg === 'string' && d.find(arg)) || d.active;
    if (!layer || layer.type !== 'smart') return ctx?.cancel();
    const lost = [layer.filters?.length ? 'its smart filters' : null, layer.stackMode ? 'its stack mode' : null].filter(Boolean);
    if (lost.length && ctx?.source !== 'action' && arg?.confirm !== false) {
      const ok = await app.dialogs.confirm(`"${layer.name}" loses ${lost.join(' and ')} when it becomes layers.`, { title: 'Convert to Layers', okLabel: 'Convert' });
      if (!ok) return ctx?.cancel();
    }
    const m = layer.transform ? layer.transform.slice() : T.IDENTITY.slice();
    const src = layer.source;
    const neutral = layer.opacity === 1 && (layer.fillOpacity ?? 1) === 1 && layer.blend === 'normal' && !layer.mask && !layer.styles && !layer.clip;
    const carry = { name: layer.name, visible: layer.visible, opacity: layer.opacity, blend: layer.blend, clip: layer.clip, styles: clone(layer.styles) };
    const mask = layer.mask?.canvas ? { ...layer.mask, canvas: copyCanvas(layer.mask.canvas) } : null;
    let result;
    await app.busy('Converting to layers…', async () => {
      if (src.kind !== 'document') {
        // an image source: one raster layer drawn through the smart object's matrix
        const r = affineCanvas(src.canvas, 0, 0, m);
        result = new RasterLayer({ ...carry, fillOpacity: layer.fillOpacity ?? 1, canvas: r.canvas, x: r.x, y: r.y });
        result.mask = mask;
      } else {
        const kids = src.doc.root.children.filter((c) => !c.quickMask && !c.preview).map((c) => {
          const copy = cloneLayer(c, { name: c.name });
          copy.locked = { ...c.locked };
          return mapLayerAffine(copy, m, d.width, d.height, { width: src.doc.width, height: src.doc.height });
        });
        if (kids.length === 1 && neutral) {
          // one layer and nothing on the smart object to keep: the layer itself takes its place
          result = kids[0];
          result.visible = layer.visible && result.visible;
        } else {
          // the group stands in for the object: its blend mode, opacity, mask and styles keep applying to the whole
          result = new GroupLayer({ ...carry, expanded: true });
          result.mask = mask;
          for (const k of kids) {
            k.parent = result;
            result.children.push(k);
          }
        }
      }
      if (layer.color) result.color = layer.color;
      if (layer.linked) result.linked = layer.linked;
      structural(app, 'Convert to layers', () => {
        const parent = layer.parent, i = parent.children.indexOf(layer);
        d.remove(layer);
        d.add(result, parent, i);
        releaseOrphanClips(d);
        d.setActive(result);
      });
    });
    app.setEditingMask(false);
    return result;
  }

  // ---- Deselect Layers --------------------------------------------------------------------------------------
  function deselectLayers() {
    const d = doc();
    if (!d.active && !d.selected.size) return;
    app.setEditingMask(false);
    d.selected.clear();
    d.active = null;
    d.changed('active', { layer: null });
  }

  app.commands.registerAll({
    // these stay enabled while there is something to ask about (their native menu items are): when there is nothing
    // to do the command says why instead of doing nothing silently
    'layer:from-background': {
      enabled: () => !!doc()?.active,
      run: fromBackground,
      label: () => (doc()?.active && isBackgroundLayer(doc().active) ? 'Layer from Background…' : 'Background from Layer'),
      dialog: true,
    },
    'layer:group-from-layers': { enabled: () => !!doc()?.active, run: groupFromLayers, label: 'Group from Layers…', dialog: true },
    'layer:delete-hidden': { enabled: () => !!doc(), run: deleteHidden, label: 'Delete Hidden Layers', dialog: true },
    'layer:rasterize-all': { enabled: () => !!doc(), run: rasterizeAll, label: 'Rasterize All Layers' },
    'layer:smart-to-layers': { enabled: () => doc()?.active?.type === 'smart', run: smartToLayers, label: 'Convert to Layers' },
    'select:deselect-layers': { enabled: () => !!doc() && (!!doc().active || doc().selected.size > 0), run: deselectLayers, label: 'Deselect Layers' },
  });
}
