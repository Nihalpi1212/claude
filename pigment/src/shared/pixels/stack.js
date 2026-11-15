// Image stacks (Layer > Smart Objects > Stack Mode, File > Scripts > Statistics): one statistic per
// pixel and channel over a pile of registered images. Pure and DOM-free (ImageDataLike in and out).
//
// Alpha-aware: a sample whose alpha is 0 does not exist for that pixel (layers of different sizes, the
// transparent borders alignment leaves), so the statistic is taken over the layers that do cover it;
// the result's alpha is the largest alpha among them.
//
// Units. Pixel values are 0..255 and so are mean, median, minimum, maximum, range, standard deviation
// and summation (clipped). The other statistics are not pixel values, so the 8-bit result scales them
// (the `raw` option returns the plain numbers as Float32Array instead):
//   variance   σ² in levels², clipped at 255 (σ = 16 is white)
//   entropy    bits · 255 / 8   (8 bits, the most an 8-bit channel can carry, is white)
//   skewness   127.5 + 63.75 · g1   (mid grey = symmetric; ±2 fills the range)
//   kurtosis   42.5 · β2            (the normal distribution's 3 is mid grey; clipped at 6)
import { createImage } from './core.js';

/** Stack mode ids in Photoshop's menu order, with their names. */
export const STACK_MODES = [
  ['none', 'None'], ['entropy', 'Entropy'], ['kurtosis', 'Kurtosis'], ['maximum', 'Maximum'], ['mean', 'Mean'], ['median', 'Median'],
  ['minimum', 'Minimum'], ['range', 'Range'], ['skewness', 'Skewness'], ['standard-deviation', 'Standard Deviation'], ['summation', 'Summation'], ['variance', 'Variance'],
];
export const STACK_MODE_IDS = STACK_MODES.map(([id]) => id);
export const stackModeName = (id) => STACK_MODES.find(([m]) => m === id)?.[1] ?? id;

/** Insertion sort of the first m entries (stacks are short: this beats a general sort). */
function sortSamples(buf, m) {
  for (let i = 1; i < m; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
}

/** The statistics: (samples, count >= 1) -> number in the units described at the top of the file. */
const STATS = {
  mean(buf, m) {
    let s = 0;
    for (let i = 0; i < m; i++) s += buf[i];
    return s / m;
  },
  summation(buf, m) {
    let s = 0;
    for (let i = 0; i < m; i++) s += buf[i];
    return s;
  },
  maximum(buf, m) {
    let v = buf[0];
    for (let i = 1; i < m; i++) if (buf[i] > v) v = buf[i];
    return v;
  },
  minimum(buf, m) {
    let v = buf[0];
    for (let i = 1; i < m; i++) if (buf[i] < v) v = buf[i];
    return v;
  },
  range(buf, m) {
    let lo = buf[0], hi = buf[0];
    for (let i = 1; i < m; i++) {
      if (buf[i] < lo) lo = buf[i];
      else if (buf[i] > hi) hi = buf[i];
    }
    return hi - lo;
  },
  median(buf, m) {
    sortSamples(buf, m);
    return m & 1 ? buf[m >> 1] : (buf[(m >> 1) - 1] + buf[m >> 1]) / 2;
  },
  /** Sample variance (n − 1), as Photoshop documents it; 0 for a single sample. */
  variance(buf, m) {
    if (m < 2) return 0;
    let s = 0;
    for (let i = 0; i < m; i++) s += buf[i];
    const mean = s / m;
    let q = 0;
    for (let i = 0; i < m; i++) q += (buf[i] - mean) * (buf[i] - mean);
    return q / (m - 1);
  },
  'standard-deviation'(buf, m) {
    return Math.sqrt(STATS.variance(buf, m));
  },
  /** g1 = m3 / m2^1.5 with the population moments; 0 when all samples are equal. */
  skewness(buf, m) {
    let s = 0;
    for (let i = 0; i < m; i++) s += buf[i];
    const mean = s / m;
    let m2 = 0, m3 = 0;
    for (let i = 0; i < m; i++) {
      const d = buf[i] - mean;
      m2 += d * d;
      m3 += d * d * d;
    }
    m2 /= m;
    m3 /= m;
    return m2 > 1e-12 ? m3 / Math.pow(m2, 1.5) : 0;
  },
  /** β2 = m4 / m2² (not the excess: a normal distribution gives 3); 0 when all samples are equal. */
  kurtosis(buf, m) {
    let s = 0;
    for (let i = 0; i < m; i++) s += buf[i];
    const mean = s / m;
    let m2 = 0, m4 = 0;
    for (let i = 0; i < m; i++) {
      const d = (buf[i] - mean) * (buf[i] - mean);
      m2 += d;
      m4 += d * d;
    }
    m2 /= m;
    m4 /= m;
    return m2 > 1e-12 ? m4 / (m2 * m2) : 0;
  },
  /** Shannon entropy (bits) of the values the samples take at this pixel. */
  entropy(buf, m) {
    sortSamples(buf, m);
    let e = 0, run = 1;
    for (let i = 1; i <= m; i++) {
      if (i < m && buf[i] === buf[i - 1]) run++;
      else {
        const p = run / m;
        e -= p * Math.log2(p);
        run = 1;
      }
    }
    return e;
  },
};

/** Raw statistic -> 0..255 (see the top of the file). */
const TO_BYTE = {
  entropy: (v) => (v * 255) / 8,
  skewness: (v) => 127.5 + 63.75 * v,
  kurtosis: (v) => 42.5 * v,
};

/** Normal compositing of the stack, bottom image first (Stack Mode "None"). */
function compositeOver(images) {
  const { width, height } = images[0];
  const out = createImage(width, height);
  const od = out.data;
  for (let i = 0; i < od.length; i += 4) {
    let r = 0, g = 0, b = 0, a = 0; // premultiplied accumulation, a in 0..1
    for (let k = 0; k < images.length; k++) {
      const d = images[k].data;
      const sa = d[i + 3] / 255;
      if (!sa) continue;
      r = d[i] * sa + r * (1 - sa);
      g = d[i + 1] * sa + g * (1 - sa);
      b = d[i + 2] * sa + b * (1 - sa);
      a = sa + a * (1 - sa);
    }
    if (a > 0) {
      od[i] = r / a;
      od[i + 1] = g / a;
      od[i + 2] = b / a;
      od[i + 3] = a * 255;
    }
  }
  return out;
}

/**
 * Applies a stack mode to images of one size (ImageDataLike, bottom of the stack first).
 * mode: 'none' | 'entropy' | 'kurtosis' | 'maximum' | 'mean' | 'median' | 'minimum' | 'range' | 'skewness' |
 * 'standard-deviation' | 'summation' | 'variance'. Returns a new ImageDataLike; with { raw: true } the data is a
 * Float32Array holding the unscaled statistics (alpha still 0..255).
 */
export function stackImages(images, mode = 'mean', { raw = false } = {}) {
  if (!images?.length) throw new Error('A stack needs at least one image');
  const { width, height } = images[0];
  for (const img of images) if (img.width !== width || img.height !== height) throw new Error('The images of a stack must have the same size');
  if (mode === 'none') {
    const flat = compositeOver(images);
    return raw ? { width, height, data: Float32Array.from(flat.data) } : flat;
  }
  const stat = STATS[mode];
  if (!stat) throw new Error(`Unknown stack mode "${mode}"`);
  const n = images.length;
  const datas = images.map((img) => img.data);
  const out = raw ? { width, height, data: new Float32Array(width * height * 4) } : createImage(width, height);
  const od = out.data;
  const scale = raw ? null : TO_BYTE[mode] ?? null;
  const br = new Float64Array(n), bg = new Float64Array(n), bb = new Float64Array(n);
  for (let i = 0; i < od.length; i += 4) {
    let m = 0, alpha = 0;
    for (let k = 0; k < n; k++) {
      const d = datas[k];
      const a = d[i + 3];
      if (!a) continue; // a transparent sample is no sample
      if (a > alpha) alpha = a;
      br[m] = d[i];
      bg[m] = d[i + 1];
      bb[m] = d[i + 2];
      m++;
    }
    if (!m) continue;
    const r = stat(br, m), g = stat(bg, m), b = stat(bb, m);
    // Uint8ClampedArray rounds and clips on assignment
    od[i] = scale ? scale(r) : r;
    od[i + 1] = scale ? scale(g) : g;
    od[i + 2] = scale ? scale(b) : b;
    od[i + 3] = alpha;
  }
  return out;
}
