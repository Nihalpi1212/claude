// finish-layer-menu (ARCHITECTURE.md "0.4 features", package 15): the pure rules behind the Layer menu, kept apart
// from the DOM so that Node tests check them (tests/unit/finish-layer-menu.test.mjs). Every function works on plain
// objects shaped like the document's layers ({ children, isGroup, expanded, parent }) and imports nothing.

/** The blend modes whose layer can be filled with a colour that changes nothing (New Layer, "Fill with … neutral colour"). */
export const NEUTRAL_FILLS = Object.freeze({
  // darkening modes: white leaves the image as it is
  multiply: '#ffffff', 'color-burn': '#ffffff', 'linear-burn': '#ffffff', darken: '#ffffff', 'darker-color': '#ffffff', divide: '#ffffff',
  // lightening and difference modes: black does
  screen: '#000000', 'color-dodge': '#000000', 'linear-dodge': '#000000', lighten: '#000000', 'lighter-color': '#000000',
  difference: '#000000', exclusion: '#000000', subtract: '#000000',
  // contrast modes: 50 % grey
  overlay: '#808080', 'soft-light': '#808080', 'hard-light': '#808080', 'vivid-light': '#808080', 'linear-light': '#808080', 'pin-light': '#808080',
});

/** The neutral colour of a blend mode as '#rrggbb', or null when the mode has none (Normal, Hard Mix, the HSL modes). */
export function neutralFill(mode) {
  return NEUTRAL_FILLS[mode] ?? null;
}

/** What the neutral colour is called in the dialog ("Fill with Overlay-neutral color (50% gray)"). */
export function neutralName(mode) {
  const c = neutralFill(mode);
  return c === '#ffffff' ? 'white' : c === '#000000' ? 'black' : c ? '50% gray' : null;
}

/**
 * Opacity in percent for a digit key (Photoshop): 1 … 9 give 10 % … 90 %, 0 gives 100 %; a second digit typed quickly
 * after the first makes a two-digit value (4 then 5: 45 %; 0 then 5: 5 %; 0 then 0: 0 %).
 * @param {string|null} prev  the digit typed just before, when it was quick enough to pair with this one
 * @param {string} digit
 */
export function digitPercent(prev, digit) {
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return null;
  if (prev !== null && prev !== undefined && /^[0-9]$/.test(String(prev))) return Number(prev) * 10 + d;
  return d === 0 ? 100 : d * 10;
}

/**
 * The next blend mode for Shift+= / Shift+- (Photoshop's menu order, wrapping). `modes` is the ordered list of mode
 * ids; a group also has 'pass-through' first. An unknown current mode starts from the first.
 */
export function cycleBlend(modes, current, dir, { group = false } = {}) {
  const list = group ? ['pass-through', ...modes.filter((m) => m !== 'pass-through')] : modes.filter((m) => m !== 'pass-through');
  if (!list.length) return current;
  const i = list.indexOf(current);
  if (i < 0) return list[dir > 0 ? 0 : list.length - 1];
  return list[(i + (dir > 0 ? 1 : -1) + list.length) % list.length];
}

/**
 * New order of one group's children for Layer > Arrange (bottom -> top arrays). `picked(child)` says which children
 * move; `floor` is the lowest index a moved layer may take (1 at the root above a Background, which never moves).
 * where: 'front' | 'back' | 'forward' | 'backward' | 'reverse'. Several picked layers move together and keep their
 * order (Reverse turns it round). Returns the same array when nothing changes.
 */
export function arrangeChildren(children, picked, where, floor = 0) {
  const out = children.slice();
  const isPicked = (c, i) => i >= floor && picked(c);
  const moving = out.filter(isPicked);
  if (!moving.length) return children;
  if (where === 'front' || where === 'back') {
    const rest = out.filter((c, i) => !isPicked(c, i));
    const fixed = rest.slice(0, Math.min(floor, rest.length));
    const free = rest.slice(fixed.length);
    const next = where === 'front' ? [...fixed, ...free, ...moving] : [...fixed, ...moving, ...free];
    return same(children, next) ? children : next;
  }
  if (where === 'forward') {
    // from the top down, so a block of picked layers moves up together (a block already at the top stays)
    const sel = out.map(isPicked);
    for (let i = out.length - 2; i >= floor; i--) {
      if (sel[i] && !sel[i + 1]) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
        [sel[i], sel[i + 1]] = [sel[i + 1], sel[i]];
      }
    }
    return same(children, out) ? children : out;
  }
  if (where === 'backward') {
    const sel = out.map(isPicked);
    for (let i = floor + 1; i < out.length; i++) {
      if (sel[i] && !sel[i - 1]) {
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
        [sel[i], sel[i - 1]] = [sel[i - 1], sel[i]];
      }
    }
    return same(children, out) ? children : out;
  }
  if (where === 'reverse') {
    // the picked layers swap places among the slots they take: the others stay where they are
    const slots = [];
    out.forEach((c, i) => isPicked(c, i) && slots.push(i));
    if (slots.length < 2) return children;
    const rev = slots.map((i) => out[i]).reverse();
    slots.forEach((slot, k) => (out[slot] = rev[k]));
    return out;
  }
  return children;
}

function same(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Moves that distribute boxes (Layer > Distribute). items: [{ box: { x, y, width, height } }] (at least three);
 * edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' spread that edge evenly between the outermost two,
 * 'horizontal' | 'vertical' make the gaps between the boxes equal (Photoshop's Distribute Horizontally / Vertically).
 * Returns [{ dx, dy }] in the order of `items`, whole pixels.
 */
export function distributeMoves(items, edge) {
  const n = items.length;
  const out = items.map(() => ({ dx: 0, dy: 0 }));
  if (n < 3) return out;
  const vertical = edge === 'top' || edge === 'vcenter' || edge === 'bottom' || edge === 'vertical';
  const pos = vertical ? 'y' : 'x', size = vertical ? 'height' : 'width', d = vertical ? 'dy' : 'dx';
  const at = (b) => (edge === 'left' || edge === 'top' ? b[pos] : edge === 'right' || edge === 'bottom' ? b[pos] + b[size] : b[pos] + b[size] / 2);
  if (edge === 'horizontal' || edge === 'vertical') {
    const order = items.map((it, i) => i).sort((a, b) => items[a].box[pos] - items[b].box[pos] || a - b);
    const first = items[order[0]].box, last = items[order[n - 1]].box;
    const span = last[pos] + last[size] - first[pos];
    const total = order.reduce((s, i) => s + items[i].box[size], 0);
    const gap = (span - total) / (n - 1);
    let cursor = first[pos];
    for (const i of order) {
      const b = items[i].box;
      out[i][d] = Math.round(cursor - b[pos]);
      cursor += b[size] + gap;
    }
    return out;
  }
  const order = items.map((it, i) => i).sort((a, b) => at(items[a].box) - at(items[b].box) || a - b);
  const lo = at(items[order[0]].box), hi = at(items[order[n - 1]].box);
  const step = (hi - lo) / (n - 1);
  order.forEach((i, k) => (out[i][d] = Math.round(lo + step * k - at(items[i].box))));
  return out;
}

/**
 * The rows of the Layers panel, top to bottom: a group comes before its children, and the children of a collapsed
 * group are left out (Alt+[ and Alt+] step through what the panel shows).
 */
export function panelRows(root) {
  const out = [];
  const walk = (g) => {
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      if (c.preview || c.quickMask) continue;
      out.push(c);
      if (c.isGroup && c.expanded !== false) walk(c);
    }
  };
  walk(root);
  return out;
}

/**
 * The layer that layer navigation picks. dir: 'forward' (the row above, Alt+]) | 'backward' (the row below, Alt+[) |
 * 'front' (the top row) | 'back' (the bottom row). forward and backward wrap round when `wrap` (Photoshop) and stop
 * at the end otherwise (adding to the selection never wraps). Returns null when the panel is empty.
 */
export function navigateRow(rows, active, dir, { wrap = true } = {}) {
  if (!rows.length) return null;
  if (dir === 'front') return rows[0];
  if (dir === 'back') return rows[rows.length - 1];
  const i = rows.indexOf(active);
  if (i < 0) return dir === 'forward' ? rows[rows.length - 1] : rows[0];
  const j = i + (dir === 'forward' ? -1 : 1);
  if (j >= 0 && j < rows.length) return rows[j];
  return wrap ? rows[(j + rows.length) % rows.length] : null;
}

/**
 * Background rules (L.13) on a plain tree: may `layers` go `mode` ('above' | 'below' | 'inside') `target`?
 * `background` is the document's Background layer or null. The Background stays at the bottom of the root: it
 * never moves or goes into a group, and nothing goes below it.
 */
export function canPlaceWith(background, layers, target, mode) {
  if (!background) return true;
  if ((layers ?? []).some((l) => l === background)) return false;
  if (target === background && mode !== 'above') return false;
  return true;
}

/** The properties the Background's rules lock (L.13). */
export const BACKGROUND_LOCKED_PROPS = Object.freeze(['blend', 'opacity', 'fillOpacity', 'mask', 'vectorMask', 'styles', 'position']);

/** Which layer properties a property patch touches, in the vocabulary of lockedProps(). */
export function patchProps(patch) {
  const out = [];
  for (const k of Object.keys(patch ?? {})) {
    if (k === 'blend' || k === 'opacity' || k === 'fillOpacity' || k === 'mask' || k === 'vectorMask' || k === 'styles') out.push(k);
  }
  return out;
}
