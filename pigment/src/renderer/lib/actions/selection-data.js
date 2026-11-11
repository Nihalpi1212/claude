// Actions: a selection as step data. A tool-made selection is recorded as its result: a rectangle
// when it is one, otherwise the coverage mask run-length encoded (rows of a marquee, lasso or wand
// selection are long runs, so the data stays small). Pure: works on { width, height, mask, bounds }.

/** Largest encoded selection a step may carry (numbers in the runs array). */
export const MAX_RUNS = 60000;

/** [value, count, value, count, …] over the whole mask. */
export function encodeRuns(mask) {
  const runs = [];
  let v = mask[0], n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === v) n++;
    else {
      runs.push(v, n);
      v = mask[i];
      n = 1;
    }
  }
  if (n) runs.push(v, n);
  return runs;
}

export function decodeRuns(runs, length) {
  const mask = new Uint8ClampedArray(length);
  let at = 0;
  for (let i = 0; i + 1 < runs.length && at < length; i += 2) {
    const n = Math.min(length - at, Math.max(0, runs[i + 1] | 0));
    if (runs[i]) mask.fill(runs[i], at, at + n);
    at += n;
  }
  return mask;
}

/** The rectangle a mask is, or null when it is anything else. */
export function maskRect(mask, width, height, bounds) {
  if (!bounds) return null;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    const row = y * width;
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) if (mask[row + x] !== 255) return null;
  }
  void height;
  return [bounds.x, bounds.y, bounds.width, bounds.height];
}

/**
 * Step argument for a selection: null (no selection), { width, height, units, rect } or { width, height, units, runs };
 * undefined when the mask is too detailed to store. units 'percent' (the ruler unit when recorded) makes
 * playback scale the selection with the document, 'px' keeps pixel positions (Photoshop's rule).
 */
export function encodeSelection(sel, { width, height, units = 'px' }) {
  if (!sel || !sel.bounds) return null;
  const base = { width, height, units: units === 'percent' ? 'percent' : 'px' };
  const rect = maskRect(sel.mask, sel.width, sel.height, sel.bounds);
  if (rect) return { ...base, rect };
  const runs = encodeRuns(sel.mask);
  if (runs.length > MAX_RUNS) return undefined;
  return { ...base, runs };
}

/** Mask (Uint8ClampedArray of docWidth × docHeight) of a recorded selection in a document of another size, or null. */
export function selectionMask(arg, docWidth, docHeight) {
  if (!arg || typeof arg !== 'object') return null;
  const w = Math.max(1, arg.width | 0), h = Math.max(1, arg.height | 0);
  const percent = arg.units === 'percent';
  const sx = percent ? docWidth / w : 1, sy = percent ? docHeight / h : 1;
  const out = new Uint8ClampedArray(docWidth * docHeight);
  if (Array.isArray(arg.rect)) {
    const [x, y, rw, rh] = arg.rect;
    const x1 = Math.max(0, Math.round(x * sx)), y1 = Math.max(0, Math.round(y * sy));
    const x2 = Math.min(docWidth, Math.round((x + rw) * sx)), y2 = Math.min(docHeight, Math.round((y + rh) * sy));
    for (let yy = y1; yy < y2; yy++) if (x2 > x1) out.fill(255, yy * docWidth + x1, yy * docWidth + x2);
    return out;
  }
  if (!Array.isArray(arg.runs)) return null;
  const src = decodeRuns(arg.runs, w * h);
  if (w === docWidth && h === docHeight) return src;
  for (let y = 0; y < docHeight; y++) {
    const syy = percent ? Math.min(h - 1, Math.floor((y + 0.5) / sy)) : y;
    if (syy >= h) break;
    for (let x = 0; x < docWidth; x++) {
      const sxx = percent ? Math.min(w - 1, Math.floor((x + 0.5) / sx)) : x;
      if (sxx >= w) break;
      out[y * docWidth + x] = src[syy * w + sxx];
    }
  }
  return out;
}
