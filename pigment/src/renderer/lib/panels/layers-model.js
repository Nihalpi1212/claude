// layers-panel-depth (package 14): the pure rules behind the Layers panel. No DOM, no document.js: the functions take
// plain layer-like objects ({ id, parent, children, isGroup, expanded, styles, ... }) so node's tests can check them.
//
//   panelRows(root, opts)            the rows in panel order (layers, smart-filter blocks, effect headers and effects)
//   listedEffects(styles)            the effects the panel lists under a layer
//   dropPlacement(y, row)            'above' | 'below' | 'into' for a drop at fraction y of a row's height
//   clipEdge(y, height)              'top' | 'bottom' | null: Alt-click on the line between two rows
//   clipCandidate(rows, i, edge)     the layer that an Alt-click on that line clips (or releases), or null
//   dragSubjects(layer, selected)    what a drag that starts on a row carries
//   transferEffects(src, dst, pick, copy)  the styles of both layers after an effect row is dropped on another layer
//   toggleEffect(styles, key, index) the styles with that effect's eye flipped
//   blendSteps(modes, isGroup)       the modes the blend-mode menu steps through
//   stepMode(steps, mode, dir)       the next or previous mode (stops at the ends, as a list box does)
//   alphaBounds(data, w, h)          the box of the non-transparent pixels of RGBA data (thumbnails: layer bounds)
//   fitBox(w, h, maxW, maxH)         the largest w x h box (same aspect) inside maxW x maxH
//   thumbSpec(size)                  thumbnail and row sizes of the Panel Options' Thumbnail Size
import { STYLE_KEYS, INSTANCE_KEYS, MAX_INSTANCES, effectInstances, setEffect } from '../../../shared/pixels/styles.js';

/** Panel Options > Thumbnail Size: the thumbnail box and the row height (medium is 0.3's size). */
export const THUMB_SIZES = Object.freeze({
  none: Object.freeze({ w: 0, h: 0, row: 26 }),
  small: Object.freeze({ w: 22, h: 18, row: 28 }),
  medium: Object.freeze({ w: 36, h: 30, row: 40 }),
  large: Object.freeze({ w: 64, h: 52, row: 62 }),
});

export function thumbSpec(size) {
  return THUMB_SIZES[size] ?? THUMB_SIZES.medium;
}

/**
 * The effects listed under a layer: those switched on, and those switched off from the panel's eye (they keep
 * `present: true`, PSD's name for "listed", so the row stays and the eye can switch them back on). An effect the
 * Layer Style dialog never switched on is not listed: the dialog stores every key, enabled or not.
 */
export function listedEffects(styles) {
  if (!styles || typeof styles !== 'object') return [];
  const out = [];
  for (const { key, name } of STYLE_KEYS) {
    effectInstances(styles, key).forEach((fx, index) => {
      if (fx.enabled || fx.present === true) out.push({ key, index, name, fx });
    });
  }
  return out;
}

/** True when nothing of the styles would be listed or drawn: the layer may drop its styles object. */
export function stylesEmpty(styles) {
  return !listedEffects(styles).length;
}

/**
 * The panel's rows, top first. Each row: { kind: 'layer' | 'filters' | 'effects' | 'effect', layer, depth, entry? }.
 *  - filter(layer) === false hides a layer (Find Layers, Isolate Layers); its group's children are still walked
 *    only through the group, so a hidden group hides what is inside it.
 *  - a smart object with smart filters gets a 'filters' row (0.3).
 *  - with showEffects, a layer with listed effects whose list is open (effectsOpen(layer), the fx twisty) gets an
 *    'effects' header and one 'effect' row per listed effect; a group's effect rows come before its children
 *    (Photoshop's order).
 */
export function panelRows(root, { filter = null, showEffects = true, effectsOpen = () => true } = {}) {
  const rows = [];
  const walk = (group, depth) => {
    const kids = group.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const layer = kids[i];
      if (filter && filter(layer) === false) continue;
      rows.push({ kind: 'layer', layer, depth });
      if (layer.type === 'smart' && layer.filters?.length) rows.push({ kind: 'filters', layer, depth });
      if (showEffects) {
        const listed = listedEffects(layer.styles);
        if (listed.length && effectsOpen(layer)) {
          rows.push({ kind: 'effects', layer, depth, count: listed.length });
          for (const entry of listed) rows.push({ kind: 'effect', layer, depth, entry });
        }
      }
      if (layer.isGroup && layer.expanded) walk(layer, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/**
 * Where a drop at fraction y (0 top .. 1 bottom) of a row goes. The lower part of an expanded group's row sits above
 * its first child, so a drop there goes into the group; a collapsed group takes drops in its middle band (0.3 rule).
 */
export function dropPlacement(y, { isGroup = false, expanded = false } = {}) {
  if (isGroup && y > 0.3 && (expanded || y < 0.7)) return 'into';
  return y < 0.5 ? 'above' : 'below';
}

/** The `mode` of app.backgroundRules.canPlace for a placement of dropPlacement. */
export const PLACE_MODE = Object.freeze({ into: 'inside', above: 'above', below: 'below' });

/** Alt-click on the line between two rows: within `band` px of the row's top or bottom edge. */
export function clipEdge(y, height, band = 5) {
  if (!(height > 0)) return null;
  if (y <= Math.min(band, height / 4)) return 'top';
  if (y >= height - Math.min(band, height / 4)) return 'bottom';
  return null;
}

const indexIn = (layer) => (layer?.parent?.children ? layer.parent.children.indexOf(layer) : -1);

/**
 * The layer an Alt-click on the line between two layer rows clips onto the layer below it (or releases): the upper of
 * the two, when the lower one is right below it in the same stack. rows are panelRows' rows (only 'layer' rows count),
 * i the index of the clicked row, edge clipEdge's answer.
 */
export function clipCandidate(rows, i, edge) {
  const layerRows = [];
  rows.forEach((r, k) => {
    if (r.kind === 'layer') layerRows.push(k);
  });
  const pos = layerRows.indexOf(i);
  if (pos < 0 || !edge) return null;
  const upperRow = edge === 'top' ? rows[layerRows[pos - 1]] : rows[i];
  const lowerRow = edge === 'top' ? rows[i] : rows[layerRows[pos + 1]];
  if (!upperRow || !lowerRow) return null;
  const upper = upperRow.layer, lower = lowerRow.layer;
  if (upper.parent !== lower.parent) return null;
  const k = indexIn(upper);
  if (k < 1 || upper.parent.children[k - 1] !== lower) return null;
  return upper;
}

const isInside = (layer, group) => {
  for (let p = layer?.parent; p; p = p.parent) if (p === group) return true;
  return false;
};

/**
 * The layers a drag started on `layer` carries: every selected layer when the row is selected (without those whose
 * group is also selected: they move with it), else that layer alone. `order` (bottom first, as doc.layers()) sorts
 * them; the result is bottom first.
 */
export function dragSubjects(layer, selected, order = null) {
  const sel = selected instanceof Set ? selected : new Set(selected ?? []);
  if (!sel.has(layer)) return [layer];
  const list = [...sel].filter((l) => l && ![...sel].some((o) => o !== l && isInside(l, o)));
  if (order) list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return list;
}

/** A drop is refused when it would put a dragged layer into itself or onto itself. */
export function dropRefused(subjects, target) {
  return subjects.some((l) => l === target || isInside(target, l));
}

const cloneFx = (fx) => JSON.parse(JSON.stringify(fx, (k, v) => (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement ? undefined : v)));

/** A copy of one effect object that keeps the references a JSON copy would lose (a decoded pattern). */
function copyEffect(fx) {
  const out = { ...fx };
  for (const k of ['texture', 'contourSub']) if (out[k] && typeof out[k] === 'object') out[k] = { ...out[k] };
  if (out.gradient && typeof out.gradient === 'object') out.gradient = cloneFx(out.gradient);
  if (Array.isArray(out.stops)) out.stops = out.stops.map((s) => ({ ...s }));
  return out;
}

/** styles with nothing listed become null, so the layer shows no fx badge and Copy Layer Style has nothing to copy. */
function tidy(styles) {
  return styles && !stylesEmpty(styles) ? styles : null;
}

/**
 * The styles of the source and target layers after effect rows are dropped from one layer onto another.
 *  - pick { key, index }: one effect. On the target it is added on top of the key's list for the keys Photoshop
 *    allows several of (at most MAX_INSTANCES; when full, it replaces the top one), and replaces the target's own
 *    effect for the others.
 *  - pick null: the whole 'Effects' block. The target takes the source's effects (its own are replaced), with Hide
 *    All Effects as the source has it.
 * copy (Alt-drag) leaves the source as it is. Returns { source, target } (either may be null: no styles left).
 */
export function transferEffects(srcStyles, dstStyles, pick = null, copy = false) {
  if (!pick) {
    const listed = listedEffects(srcStyles);
    if (!listed.length) return { source: srcStyles ?? null, target: dstStyles ?? null };
    let target = {};
    for (const { key } of STYLE_KEYS) {
      const list = effectInstances(srcStyles, key).map(copyEffect);
      if (list.length) target[key] = list.length === 1 ? list[0] : list;
    }
    if (srcStyles.hidden === true) target.hidden = true;
    target = tidy(target);
    return { source: copy ? srcStyles : null, target };
  }
  const { key, index } = pick;
  const fx = effectInstances(srcStyles, key)[index];
  if (!fx) return { source: srcStyles ?? null, target: dstStyles ?? null };
  const moved = copyEffect(fx);
  let target;
  if (INSTANCE_KEYS.includes(key)) {
    // instances the panel does not list (the dialog stores a switched-off default for every key) are dropped
    const list = effectInstances(dstStyles, key).filter((x) => x.enabled || x.present === true).map((x) => ({ ...x }));
    // the list's top is index 0; a full list loses its top instance to the new one
    if (list.length >= MAX_INSTANCES) list.shift();
    list.unshift(moved);
    target = { ...(dstStyles && typeof dstStyles === 'object' ? dstStyles : {}) };
    target[key] = list.length === 1 ? list[0] : list.slice(0, MAX_INSTANCES);
  } else {
    target = { ...(dstStyles && typeof dstStyles === 'object' ? dstStyles : {}), [key]: moved };
  }
  const source = copy ? srcStyles ?? null : tidy(setEffect(srcStyles, key, index, null));
  return { source, target: tidy(target) };
}

/** The styles with one effect's eye flipped (the row stays listed: present). */
export function toggleEffect(styles, key, index, enabled = null) {
  const fx = effectInstances(styles, key)[index];
  if (!fx) return styles ?? null;
  const on = typeof enabled === 'boolean' ? enabled : !fx.enabled;
  return setEffect(styles, key, index, { enabled: on, present: true });
}

/** The styles without one effect (the row's Delete). */
export function removeEffect(styles, key, index) {
  if (!effectInstances(styles, key)[index]) return styles ?? null;
  return tidy(setEffect(styles, key, index, null));
}

/**
 * The modes the blend-mode menu lists and steps through: BLEND_MODES (pairs, null for separators) without the
 * separators, Pass Through first for a group.
 */
export function blendSteps(modes, isGroup = false) {
  const list = (modes ?? []).filter(Boolean).map(([m]) => m);
  return isGroup ? ['pass-through', ...list] : list;
}

/** The mode one step up (dir -1) or down (dir 1) from `mode`; the ends stop, as a list box does. */
export function stepMode(steps, mode, dir) {
  const i = steps.indexOf(mode);
  if (i < 0) return steps[0] ?? mode;
  const j = Math.max(0, Math.min(steps.length - 1, i + (dir < 0 ? -1 : 1)));
  return steps[j];
}

/** The box { x, y, w, h } of the pixels whose alpha is above `threshold` in RGBA data, or null when all are clear. */
export function alphaBounds(data, w, h, threshold = 0) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++, row += 4) {
      if (data[row] > threshold) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The largest box with the aspect of w x h that fits maxW x maxH (at least 1 x 1). */
export function fitBox(w, h, maxW, maxH) {
  if (!(w > 0) || !(h > 0)) return { w: Math.max(1, maxW), h: Math.max(1, maxH), scale: 1 };
  const scale = Math.min(maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/**
 * The eye-column sweep (drag down the eyes): every layer passed over takes the state the first eye was switched to.
 * Returns the ids to change, in the order passed, without repeats and without layers already in that state.
 */
export function sweepTargets(passed, visible) {
  const seen = new Set();
  const out = [];
  for (const l of passed) {
    if (!l || seen.has(l)) continue;
    seen.add(l);
    if (!!l.visible !== visible) out.push(l);
  }
  return out;
}

/** Every group below `root` (root itself excluded), depth first. */
export function groupsIn(root) {
  const out = [];
  const walk = (g) => {
    for (const c of g.children ?? []) {
      if (c.isGroup) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}
