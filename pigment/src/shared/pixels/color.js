// Colour conversions. Channels: r,g,b 0..255; h 0..360; s,l,v 0..1 (functions below say which);
// L*a*b* uses D65. Pure functions, no DOM.

export function rgbToHsl(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
  else if (max === G) h = ((B - R) / d + 2) * 60;
  else h = ((R - G) / d + 4) * 60;
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  const H = (((h % 360) + 360) % 360) / 360;
  if (s <= 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(H + 1 / 3) * 255, f(H) * 255, f(H - 1 / 3) * 255];
}

export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
    else if (max === G) h = ((B - R) / d + 2) * 60;
    else h = ((R - G) / d + 4) * 60;
  }
  return [h, s, v];
}

export function hsvToRgb(h, s, v) {
  const H = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(H);
  const f = H - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q];
  }
  return [r * 255, g * 255, b * 255];
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const Xn = 0.95047, Yn = 1, Zn = 1.08883;
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

export function rgbToLab(r, g, b) {
  const R = srgbToLinear(r / 255), G = srgbToLinear(g / 255), B = srgbToLinear(b / 255);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / Xn;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175) / Yn;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / Zn;
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fInv(fx) * Xn, Y = fInv(fy) * Yn, Z = fInv(fz) * Zn;
  const R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const G = X * -0.969266 + Y * 1.8760108 + Z * 0.041556;
  const B = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  const c = (v) => Math.min(255, Math.max(0, linearToSrgb(v) * 255));
  return [c(R), c(G), c(B)];
}

/** Parses '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(a)(...)' and [r,g,b,a] arrays into [r,g,b,a(0..1)]. */
export function parseColor(input, fallback = [0, 0, 0, 1]) {
  if (Array.isArray(input)) return [input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, input[3] ?? 1];
  if (typeof input !== 'string') return fallback;
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  const named = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], transparent: [0, 0, 0, 0] };
  if (named[s]) return [named[s][0], named[s][1], named[s][2], named[s][3] ?? 1];
  return fallback;
}

export const hexToRgba = parseColor;

export function rgbaToHex(rgba, withAlpha = false) {
  const h = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  const base = `#${h(rgba[0])}${h(rgba[1])}${h(rgba[2])}`;
  return withAlpha && rgba[3] !== undefined && rgba[3] < 1 ? base + h(rgba[3] * 255) : base;
}

export const rgbToHex = (r, g, b) => rgbaToHex([r, g, b]);

/** Black or white, whichever reads better on the given colour. */
export function contrastColor(rgba) {
  const c = parseColor(rgba);
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 150 ? '#000000' : '#ffffff';
}

/** Photoshop-style "colour" distance used by the magic wand / colour range (max channel difference). */
export function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}
