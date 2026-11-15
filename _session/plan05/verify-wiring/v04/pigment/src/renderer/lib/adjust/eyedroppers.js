// Adjustment eyedroppers (adjust-tonal, I.1 / I.2): the black, grey and white point eyedroppers of Levels, Curves
// and Exposure as editor capabilities, and the sampler the adjustment frame reads the canvas with (Photoshop's
// eyedroppers follow the Eyedropper tool's Sample Size). adjust-color reuses sampleArea / sampleSizeOf for its range
// eyedroppers.
import { levelsEyedropper, curvesEyedropper, exposureEyedropper } from '../../../shared/pixels/adjust-tonal.js';
import { savedAutoOptions } from './auto-options.js';

/** The Eyedropper tool's Sample Size (1, 3, 5, 11, 31; Photoshop's adjustment eyedroppers use it too). */
export function sampleSizeOf(app) {
  let n = 3;
  try {
    const tool = app?.tools?.get?.('eyedropper');
    const v = tool?.opt?.('sample');
    if (v !== undefined && v !== null) n = Number(v);
  } catch {
    /* no tool: the default */
  }
  return [1, 3, 5, 11, 31].includes(n) ? n : 3;
}

/**
 * Average of sample(x, y) over an n x n square around (x, y), weighted by alpha (transparent pixels add no colour);
 * null when nothing under it can be read.
 */
export function sampleArea(sample, x, y, n = 1) {
  if (typeof sample !== 'function') return null;
  if (n <= 1) return sample(Math.floor(x), Math.floor(y));
  const half = Math.floor(n / 2), cx = Math.floor(x), cy = Math.floor(y);
  let r = 0, g = 0, b = 0, a = 0, w = 0, count = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const s = sample(cx + dx, cy + dy);
      if (!s) continue;
      count++;
      const al = (s[3] ?? 255) / 255;
      r += s[0] * al;
      g += s[1] * al;
      b += s[2] * al;
      a += s[3] ?? 255;
      w += al;
    }
  }
  if (!count) return null;
  if (!w) return [0, 0, 0, 0];
  return [Math.round(r / w), Math.round(g / w), Math.round(b / w), Math.round(a / count)];
}

const LABELS = {
  black: 'Sample in image to set black point',
  gray: 'Sample in image to set gray point',
  white: 'Sample in image to set white point',
};

/**
 * The three eyedroppers of a tonal editor as I.2 capabilities: [{ id, label, icon, pick(rgba, { x, y }) }].
 * `kind`: 'levels' | 'curves' | 'exposure'; getParams() / setParams(params) read and write the editor's settings;
 * `gray: false` leaves out the grey one (Gray documents).
 */
export function tonalEyedroppers(app, kind, { getParams, setParams, gray = true }) {
  const fn = kind === 'curves' ? curvesEyedropper : kind === 'exposure' ? null : levelsEyedropper;
  return ['black', 'gray', 'white'].filter((w) => gray || w !== 'gray').map((which) => ({
    id: which,
    label: LABELS[which],
    icon: `eyedropper-${which}`,
    pick(rgba) {
      if (!rgba || rgba[3] === 0) return;
      const next = fn ? fn(getParams(), which, rgba, savedAutoOptions(app)) : exposureEyedropper(getParams(), which, rgba);
      setParams(next);
    },
  }));
}
