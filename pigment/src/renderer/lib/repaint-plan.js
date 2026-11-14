// What a repaint of the document view must redo (build-repaint-speed; ARCHITECTURE.md "Repaint caches"). Pure: no
// DOM, so the unit tests run it in Node. lib/compositor.js describes the root's draw units (a layer with the clipped
// layers above it, as drawChildren draws them) and hands two descriptions here:
//
//   plan  = { global, units: [unit] }
//   unit  = { id, pkey, vkey, box, hint }
//     id    which layers the unit is made of (its structure)
//     pkey  everything else its pixels depend on: properties, masks, styles, sources (object identities)
//     vkey  the layers' versions (layer.touch() moves them)
//     box   the document box outside which the unit leaves the backdrop alone: a rect, null (it draws nothing) or
//           ALL (an adjustment layer, or a group holding one: it changes what is below it everywhere)
//     hint  only when just the versions moved and every touch since the last composite came with a dirty rect (a
//           brush dab: canvas-view's pixel hints): the rect that covers the change ({ width: 0 }: none)
//
// diffPlans compares the plan of the last composite with the current one: 'same' (nothing that draws changed: the
// active layer, the selection, guides, a history entry), 'region' (only the given rect can differ) or 'full' (redo
// from unit `from` upwards: the units below it are unchanged, so a cached composite of them can stand in).

export const ALL = Object.freeze({ all: true });

const isRect = (r) => !!r && r !== ALL && r.width > 0 && r.height > 0;

export function unionRect(a, b) {
  if (!isRect(a)) return isRect(b) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  if (!isRect(b)) return { x: a.x, y: a.y, width: a.width, height: a.height };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function intersectRect(a, b) {
  if (!isRect(a) || !isRect(b)) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x, h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/** The smallest integer rect that holds r (boxes padded by fractional style sizes). */
export function outerRect(r) {
  if (!isRect(r)) return null;
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

/**
 * @param {{ global: string, units: object[] } | null} prev the plan of the last composite (null: none)
 * @param {{ global: string, units: object[] }} next
 * @returns {{ kind: 'same' } | { kind: 'region', rect: object, from: number } | { kind: 'full', from: number }}
 *   `from`: the lowest unit that changed (a region's fallback when the region is too large to pay off)
 */
export function diffPlans(prev, next) {
  if (!prev || prev.global !== next.global) return { kind: 'full', from: 0 };
  const a = prev.units, b = next.units;
  const n = Math.min(a.length, b.length);
  let from = -1;
  let rect = null, region = true;
  for (let i = 0; i < n; i++) {
    const u = a[i], v = b[i];
    if (u.id !== v.id) {
      // a layer added, deleted or moved: everything from here up is redrawn (the units below still match)
      if (from < 0) from = i;
      return { kind: 'full', from };
    }
    if (u.pkey === v.pkey && u.vkey === v.vkey) continue;
    if (from < 0) from = i;
    if (!region) continue;
    if (u.pkey === v.pkey && v.hint) {
      rect = unionRect(rect, v.hint);
      continue;
    }
    if (u.box === ALL || v.box === ALL) {
      region = false;
      continue;
    }
    rect = unionRect(unionRect(rect, u.box), v.box);
  }
  if (a.length !== b.length) return { kind: 'full', from: from < 0 ? n : from };
  if (from < 0) return { kind: 'same' };
  if (!region) return { kind: 'full', from };
  if (!rect) return { kind: 'same' }; // only touches that changed no pixel (the end of a brush stroke)
  return { kind: 'region', rect, from };
}

/** True when the first `count` units of two plans are the same (a cached composite of them still holds). */
export function samePrefix(keys, plan, count) {
  if (!keys || keys.global !== plan.global || keys.units.length !== count || plan.units.length < count) return false;
  for (let i = 0; i < count; i++) {
    const u = keys.units[i], v = plan.units[i];
    if (u.id !== v.id || u.pkey !== v.pkey || u.vkey !== v.vkey) return false;
  }
  return true;
}
