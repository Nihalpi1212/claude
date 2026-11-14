// Lens Correction (src/shared/pixels/lens.js): the radial model, chromatic aberration, vignette, the transform
// group, edge modes, auto scale, the horizon detector and the dialog helpers. Numbers, not just "does not throw".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lensCorrect, detectHorizon, autoScaleFactor, effectiveScale, vignetteGain, isNeutral, straightenAngle, gridLines,
  LENS_DEFAULTS, LENS_FIELDS, LENS_FILTERS,
} from '../../src/shared/pixels/lens.js';
import { FILTERS, applyFilter } from '../../src/shared/pixels/filters.js';
import { createImage, setPixel, randomSeeded, cloneImage } from '../../src/shared/pixels/core.js';
import { rotate90, rotate180, rotate270 } from '../../src/shared/pixels/transform.js';

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const K1 = 0.4, K2 = 0.1, KEYSTONE = 0.4, CHROMA = 0.01;

/** Opaque noise. */
function noise(w, h, seed = 3) {
  const rnd = randomSeeded(seed);
  const img = createImage(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rnd() * 256;
    img.data[i + 1] = rnd() * 256;
    img.data[i + 2] = rnd() * 256;
    img.data[i + 3] = 255;
  }
  return img;
}

/** A smooth opaque image (resampling twice barely changes it). */
function smooth(w, h) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setPixel(img, x, y, [128 + 100 * Math.sin(x / 17), 128 + 100 * Math.cos(y / 13), 128 + 90 * Math.sin((x + y) / 23), 1]);
  }
  return img;
}

function solid(w, h, rgba) {
  const img = createImage(w, h);
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  return img;
}

/** Sub-pixel position of a bright feature along a row of one channel (intensity-weighted centroid). */
function centroid(img, y, channel, x0 = 0, x1 = img.width) {
  let sum = 0, moment = 0;
  for (let x = x0; x < x1; x++) {
    const v = img.data[(y * img.width + x) * 4 + channel];
    sum += v;
    moment += v * (x + 0.5);
  }
  return sum ? moment / sum : NaN;
}

/** Mean absolute colour difference over the pixels both images hold opaque, and the share of such pixels. */
function compare(a, b, inside = () => true) {
  let sum = 0, n = 0, total = 0, max = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!inside(x, y)) continue;
    total++;
    const p = (y * a.width + x) * 4;
    if (a.data[p + 3] < 250 || b.data[p + 3] < 250) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p + c] - b.data[p + c]);
      sum += d;
      if (d > max) max = d;
    }
  }
  return { mean: n ? sum / (n * 3) : Infinity, share: total ? n / total : 0, max };
}

/** Width in pixels of the white run of row y (sum of the red channel / 255, so partial edge pixels count partly). */
const rowWidth = (img, y) => {
  let s = 0;
  for (let x = 0; x < img.width; x++) s += (img.data[(y * img.width + x) * 4] * img.data[(y * img.width + x) * 4 + 3]) / 255;
  return s / 255;
};
const colHeight = (img, x) => {
  let s = 0;
  for (let y = 0; y < img.height; y++) s += (img.data[(y * img.width + x) * 4] * img.data[(y * img.width + x) * 4 + 3]) / 255;
  return s / 255;
};

/** A white rectangle centred on a transparent image. */
function whiteBox(w, h, bw, bh) {
  const img = createImage(w, h);
  const x0 = (w - bw) / 2, y0 = (h - bh) / 2;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) setPixel(img, x, y, [255, 255, 255, 1]);
  return img;
}

/** Sky over ground, split by a line through the centre that is tilted by `deg` (clockwise positive). */
function horizonImage(w, h, deg, { seed = 0, offset = 0 } = {}) {
  const rnd = seed ? randomSeeded(seed) : null;
  const img = createImage(w, h);
  const t = Math.tan((deg * Math.PI) / 180);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = h / 2 + offset + (x + 0.5 - w / 2) * t;
    // one pixel of antialiasing across the edge
    const k = Math.max(0, Math.min(1, y + 1 - edge));
    const n = rnd ? (rnd() - 0.5) * 24 : 0;
    setPixel(img, x, y, [110 + (40 - 110) * k + n, 170 + (90 - 170) * k + n, 230 + (40 - 230) * k + n, 1]);
  }
  return img;
}

test('registry: lens-correction is a real special kind with a custom opener and the final parameter names', () => {
  const def = FILTERS['lens-correction'];
  assert.equal(def, LENS_FILTERS['lens-correction']);
  assert.equal(def.name, 'Lens Correction');
  assert.equal(def.category, 'special');
  assert.equal(def.ui, 'custom');
  assert.equal(def.placeholder, undefined);
  assert.deepEqual(Object.keys(def.defaults), ['distortion', 'chromaRC', 'chromaBY', 'chromaGM', 'vignette', 'vignetteMidpoint', 'vertical', 'horizontal', 'angle', 'scale', 'edge', 'autoScale', 'background']);
  assert.deepEqual({ ...def.defaults }, { ...LENS_DEFAULTS });
  assert.equal(def.defaults.scale, 100);
  assert.equal(def.defaults.vignetteMidpoint, 50);
  assert.equal(def.defaults.edge, 'transparent');
  for (const f of LENS_FIELDS) assert.ok(f.key in def.defaults, `${f.key} is a parameter`);
  assert.ok(isNeutral({}));
  assert.ok(isNeutral({ angle: 360 }));
  assert.ok(!isNeutral({ distortion: 1 }));
  assert.ok(isNeutral({ autoScale: true, edge: 'repeat' }), 'auto scale alone has nothing to hide');
  assert.ok(!isNeutral({ scale: 101 }) && !isNeutral({ angle: 0.01 }) && !isNeutral({ vignette: -1 }));
});

test('distortion 0 (the defaults) is the identity, as a new image and through the registry', () => {
  const img = noise(37, 23);
  const out = lensCorrect(img, {});
  assert.notEqual(out, img);
  assert.notEqual(out.data, img.data);
  assert.deepEqual(out.data, img.data);
  assert.deepEqual(lensCorrect(img, { distortion: 0, angle: 0, scale: 100, vignette: 0 }).data, img.data);
  const copy = cloneImage(img);
  assert.equal(applyFilter(copy, 'lens-correction', {}), copy);
  assert.deepEqual(copy.data, img.data);
  // junk values fall back to the defaults instead of producing NaN pixels
  assert.deepEqual(lensCorrect(img, { distortion: NaN, angle: 'x', scale: undefined, edge: 'nonsense' }).data, img.data);
  // empty images pass through
  assert.equal(lensCorrect(createImage(0, 0), { angle: 10 }).data.length, 0);
});

test('the radial model moves a point to the radius the formula gives and leaves the corners in place', () => {
  const W = 400, H = 300, cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
  // a white vertical bar 120 px right of the centre on black
  const img = solid(W, H, [0, 0, 0, 255]);
  for (let y = 0; y < H; y++) for (let x = 318; x < 322; x++) setPixel(img, x, y, [255, 255, 255, 1]);
  const srcR = 120 / R;
  const g = (r, a) => (r * (1 + K1 * a * r * r + K2 * a * a * r ** 4)) / (1 + K1 * a + K2 * a * a);
  const row = Math.floor(cy);
  // barrel (negative): a destination radius r reads the source at g(r), so the bar appears where g(r) = srcR
  const barrel = lensCorrect(img, { distortion: -60 });
  let lo = 0, hi = 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid, 0.6) < srcR) lo = mid;
    else hi = mid;
  }
  const expectBarrel = cx + lo * R;
  assert.ok(expectBarrel > 320 + 15, 'the centre is magnified: the bar moves outwards');
  assert.ok(Math.abs(centroid(barrel, row, 0, 240, W) - expectBarrel) < 0.75, `barrel: bar at ${centroid(barrel, row, 0, 240, W)}, expected ${expectBarrel}`);
  // pincushion (positive): reads at g^-1(r), so the bar appears at g(srcR)
  const pin = lensCorrect(img, { distortion: 60 });
  const expectPin = cx + g(srcR, 0.6) * R;
  assert.ok(expectPin < 320 - 10, 'the centre shrinks: the bar moves inwards');
  assert.ok(Math.abs(centroid(pin, row, 0, 200, W) - expectPin) < 0.75, `pincushion: bar at ${centroid(pin, row, 0, 200, W)}, expected ${expectPin}`);
  // corners: g(1) = 1 whatever the amount
  const grad = smooth(W, H);
  for (const d of [-80, 80]) {
    const out = lensCorrect(grad, { distortion: d, edge: 'repeat' });
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
      const a = px(out, x, y), b = px(grad, x, y);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c] - b[c]) <= 6, `corner ${x},${y} channel ${c}: ${a[c]} vs ${b[c]} at ${d}`);
    }
  }
  // pincushion leaves empty areas along the edges (their middles), barrel fills the frame
  assert.equal(px(pin, cx, 0)[3], 0);
  assert.equal(px(pin, 0, row)[3], 0);
  assert.ok(barrel.data.every((v, i) => i % 4 !== 3 || v === 255));
});

test('barrel then pincushion of the same magnitude is near-identity (and exactly inverse the other way round)', () => {
  const img = smooth(160, 120);
  for (const amount of [25, 60]) {
    // pincushion first keeps every pixel inside the frame, so the way back restores the whole image
    const back = lensCorrect(lensCorrect(img, { distortion: amount }), { distortion: -amount });
    const all = compare(img, back);
    assert.ok(all.mean < 0.5, `pincushion ${amount} then barrel: mean difference ${all.mean}`);
    assert.ok(all.share > 0.95, `pincushion ${amount} then barrel: ${all.share} of the pixels restored`);
    // barrel first pushes the rim out of the frame; what stayed comes back where it was
    const there = lensCorrect(lensCorrect(img, { distortion: -amount }), { distortion: amount });
    const centre = compare(img, there, (x, y) => Math.abs(x - 80) < 40 && Math.abs(y - 60) < 30);
    assert.ok(centre.mean < 0.5, `barrel ${amount} then pincushion: mean difference ${centre.mean}`);
    assert.equal(centre.share, 1);
    // and a single pass is far from the identity, so the test above means something
    assert.ok(compare(img, lensCorrect(img, { distortion: -amount, edge: 'repeat' })).mean > 5);
  }
});

test('vignette darkens (or lightens) the corners by the expected gain and the midpoint shifts the curve', () => {
  const W = 201, H = 101, cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
  const img = solid(W, H, [200, 100, 50, 180]);
  const out = lensCorrect(img, { vignette: -50 });
  // the centre pixel keeps its colour, alpha is never touched
  assert.deepEqual(px(out, 100, 50), [200, 100, 50, 180]);
  assert.ok(out.data.every((v, i) => i % 4 !== 3 || v === 180));
  // corner pixel centre: r = |(0.5 - cx, 0.5 - cy)| / R, gain 1 - 0.5 r²
  const rn = Math.hypot(0.5 - cx, 0.5 - cy) / R;
  const gain = 1 - 0.5 * rn * rn;
  assert.ok(gain > 0.5 && gain < 0.52);
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
    const p = px(out, x, y);
    assert.ok(Math.abs(p[0] - 200 * gain) <= 1 && Math.abs(p[1] - 100 * gain) <= 1 && Math.abs(p[2] - 50 * gain) <= 1, `corner ${x},${y}: ${p}`);
  }
  // half way out along the horizontal: r = 50 / R
  const rh = 50 / R;
  assert.ok(Math.abs(px(out, 150, 50)[0] - 200 * (1 - 0.5 * rh * rh)) <= 1);
  // the midpoint is the exponent: 0 -> 0.5 (wide), 50 -> 2, 100 -> 8 (corners only)
  assert.ok(Math.abs(vignetteGain({ vignette: -50, vignetteMidpoint: 50 }, 0.5) - (1 - 0.5 * 0.25)) < 1e-12);
  assert.ok(Math.abs(vignetteGain({ vignette: -50, vignetteMidpoint: 0 }, 0.5) - (1 - 0.5 * Math.sqrt(0.5))) < 1e-12);
  assert.ok(Math.abs(vignetteGain({ vignette: -50, vignetteMidpoint: 100 }, 0.5) - (1 - 0.5 * 0.5 ** 8)) < 1e-12);
  assert.equal(vignetteGain({ vignette: 0 }, 1), 1);
  const wide = lensCorrect(img, { vignette: -50, vignetteMidpoint: 0 }), tight = lensCorrect(img, { vignette: -50, vignetteMidpoint: 100 });
  assert.ok(Math.abs(px(wide, 150, 50)[0] - 200 * (1 - 0.5 * Math.sqrt(rh))) <= 1);
  assert.ok(Math.abs(px(tight, 150, 50)[0] - 200) <= 1, 'a high midpoint leaves the middle alone');
  assert.ok(Math.abs(px(tight, 0, 0)[0] - 200 * (1 - 0.5 * rn ** 8)) <= 1);
  // positive amounts lighten: gain 1 + 0.4 r² in the corner, clipped at white
  const lighter = lensCorrect(img, { vignette: 40 });
  assert.ok(Math.abs(px(lighter, 0, 0)[1] - 100 * (1 + 0.4 * rn * rn)) <= 1);
  assert.equal(px(lensCorrect(img, { vignette: 100 }), 0, 0)[0], 255);
  // -100 takes the very corner to (almost) black
  assert.ok(px(lensCorrect(img, { vignette: -100 }), 0, 0)[0] <= 5);
});

test('angle 90° equals rotate90, 180° rotate180, -90° rotate270, and 360° changes nothing', () => {
  const sq = noise(32, 32, 7);
  assert.deepEqual(lensCorrect(sq, { angle: 90 }).data, rotate90(sq).data);
  assert.deepEqual(lensCorrect(sq, { angle: -90 }).data, rotate270(sq).data);
  assert.deepEqual(lensCorrect(sq, { angle: 270 }).data, rotate270(sq).data);
  const odd = noise(31, 31, 8);
  assert.deepEqual(lensCorrect(odd, { angle: 90 }).data, rotate90(odd).data);
  const rect = noise(40, 26, 9);
  assert.deepEqual(lensCorrect(rect, { angle: 180 }).data, rotate180(rect).data);
  assert.deepEqual(lensCorrect(rect, { angle: 360 }).data, rect.data);
  // a small clockwise turn moves a point right of the centre downwards
  const dot = solid(101, 101, [0, 0, 0, 255]);
  for (let y = 48; y < 53; y++) for (let x = 88; x < 93; x++) setPixel(dot, x, y, [255, 255, 255, 1]);
  const turned = lensCorrect(dot, { angle: 20 });
  let sy = 0, sx = 0, n = 0;
  for (let y = 0; y < 101; y++) for (let x = 0; x < 101; x++) {
    const v = turned.data[(y * 101 + x) * 4];
    sx += v * (x + 0.5);
    sy += v * (y + 0.5);
    n += v;
  }
  const rad = (20 * Math.PI) / 180;
  assert.ok(Math.abs(sx / n - (50.5 + 40 * Math.cos(rad))) < 0.3, `x ${sx / n}`);
  assert.ok(Math.abs(sy / n - (50.5 + 40 * Math.sin(rad))) < 0.3, `y ${sy / n}`);
});

test('scale enlarges about the centre and the edge modes fill what a smaller image leaves', () => {
  const box = whiteBox(120, 80, 20, 10);
  const big = lensCorrect(box, { scale: 150 });
  assert.ok(Math.abs(rowWidth(big, 40) - 30) < 0.01, `width ${rowWidth(big, 40)}`);
  assert.ok(Math.abs(colHeight(big, 60) - 15) < 0.01, `height ${colHeight(big, 60)}`);
  // 50 %: the image occupies the middle half
  const img = noise(80, 60, 4);
  const half = lensCorrect(img, { scale: 50 });
  assert.equal(px(half, 5, 5)[3], 0);
  assert.equal(px(half, 79, 30)[3], 0);
  assert.equal(px(half, 40, 30)[3], 255);
  let opaque = 0;
  for (let i = 3; i < half.data.length; i += 4) if (half.data[i] === 255) opaque++;
  assert.ok(Math.abs(opaque - 40 * 30) <= 140, `${opaque} opaque pixels`);
  // edge extension repeats the border pixels: the top-left corner area takes the colour of the image's corner
  const flat = solid(80, 60, [10, 200, 30, 255]);
  setPixel(flat, 0, 0, [250, 0, 0, 1]);
  const rep = lensCorrect(flat, { scale: 50, edge: 'repeat' });
  assert.ok(rep.data.every((v, i) => i % 4 !== 3 || v === 255));
  assert.deepEqual(px(rep, 3, 3), [250, 0, 0, 255]);
  assert.deepEqual(px(rep, 76, 3), [10, 200, 30, 255]);
  // wrap tiles the image: at 50 % a destination pixel 40 px left of another reads the same source pixel
  const wrap = lensCorrect(img, { scale: 50, edge: 'wrap' });
  assert.ok(wrap.data.every((v, i) => i % 4 !== 3 || v === 255));
  assert.deepEqual(px(wrap, 10, 20), px(wrap, 50, 20));
  assert.deepEqual(px(wrap, 30, 5), px(wrap, 30, 35));
  // background colour: from the params, or from the option
  const bgP = lensCorrect(img, { scale: 50, edge: 'background', background: '#102030' });
  assert.deepEqual(px(bgP, 2, 2), [16, 32, 48, 255]);
  assert.deepEqual(px(bgP, 40, 30), px(half, 40, 30));
  const bgO = lensCorrect(img, { scale: 50, edge: 'background' }, { background: [200, 100, 0, 1] });
  assert.deepEqual(px(bgO, 78, 58), [200, 100, 0, 255]);
  assert.deepEqual(px(lensCorrect(img, { scale: 50, edge: 'background' }), 2, 2), [255, 255, 255, 255]);
  // the layer's own transparency is not filled by the background colour
  const hole = cloneImage(img);
  for (let y = 25; y < 35; y++) for (let x = 35; x < 45; x++) setPixel(hole, x, y, [0, 0, 0, 0]);
  assert.equal(px(lensCorrect(hole, { scale: 50, edge: 'background' }), 40, 30)[3], 0);
});

test('perspective is a keystone about the centre: vertical widens the bottom, horizontal the right side', () => {
  const W = 200, H = 160;
  const box = whiteBox(W, H, 80, 80);
  // forward map (x, y) -> (x, y) / (1 - K (h xn + v yn)): a row at normalised height yn is scaled by 1 / (1 - K v yn)
  const v = lensCorrect(box, { vertical: 50 });
  for (const yn of [-0.25, 0.25]) {
    const s = 1 / (1 - KEYSTONE * 0.5 * yn);
    const y = Math.round(H / 2 + yn * (H / 2) * s);
    assert.ok(Math.abs(rowWidth(v, y) - 80 * s) < 1.2, `row at ${yn}: ${rowWidth(v, y)} vs ${80 * s}`);
  }
  assert.ok(rowWidth(v, 110) > rowWidth(v, 50) + 10, 'the bottom is wider');
  const vNeg = lensCorrect(box, { vertical: -50 });
  assert.ok(rowWidth(vNeg, 50) > rowWidth(vNeg, 110) + 10, 'negative widens the top');
  const h = lensCorrect(box, { horizontal: 50 });
  for (const xn of [-0.2, 0.2]) {
    const s = 1 / (1 - KEYSTONE * 0.5 * xn);
    const x = Math.round(W / 2 + xn * (W / 2) * s);
    assert.ok(Math.abs(colHeight(h, x) - 80 * s) < 1.2, `column at ${xn}: ${colHeight(h, x)} vs ${80 * s}`);
  }
  assert.ok(colHeight(h, 125) > colHeight(h, 75) + 8, 'the right side is taller');
  // the centre stays where it is
  assert.deepEqual(px(v, 100, 80), [255, 255, 255, 255]);
  assert.deepEqual(px(h, 100, 80), [255, 255, 255, 255]);
});

test('chromatic aberration moves one channel radially against the others', () => {
  const W = 800, H = 100, cx = W / 2;
  const img = solid(W, H, [0, 0, 0, 255]);
  for (let y = 0; y < H; y++) for (let x = 698; x < 702; x++) setPixel(img, x, y, [255, 255, 255, 1]);
  const at = (o, c) => centroid(o, 50, c, 650, 750);
  assert.ok(Math.abs(at(img, 0) - 700) < 1e-9);
  // red magnified by 1 %: its bar is read 1 % further out, so it appears at 300 / 1.01 from the centre
  const rc = lensCorrect(img, { chromaRC: 100 });
  assert.ok(Math.abs(at(rc, 0) - (cx + 300 / (1 + CHROMA))) < 0.05, `red at ${at(rc, 0)}`);
  assert.ok(Math.abs(at(rc, 1) - 700) < 0.05 && Math.abs(at(rc, 2) - 700) < 0.05, 'green and blue stay');
  const by = lensCorrect(img, { chromaBY: -100 });
  assert.ok(Math.abs(at(by, 2) - (cx + 300 / (1 - CHROMA))) < 0.05, `blue at ${at(by, 2)}`);
  assert.ok(Math.abs(at(by, 0) - 700) < 0.05 && Math.abs(at(by, 1) - 700) < 0.05);
  const gm = lensCorrect(img, { chromaGM: 50 });
  assert.ok(Math.abs(at(gm, 1) - (cx + 300 / (1 + CHROMA / 2))) < 0.05, `green at ${at(gm, 1)}`);
  // the centre of the image does not move
  const mid = solid(W, H, [0, 0, 0, 255]);
  for (let y = 0; y < H; y++) for (let x = 398; x < 402; x++) setPixel(mid, x, y, [255, 255, 255, 1]);
  assert.ok(Math.abs(centroid(lensCorrect(mid, { chromaRC: 100, chromaBY: -100 }), 50, 0) - 400) < 0.05);
  // fully opaque input stays opaque away from the border
  assert.equal(px(rc, 400, 50)[3], 255);
});

test('auto scale picks the smallest scale that hides the empty edges', () => {
  assert.equal(autoScaleFactor(200, 100, {}), 1);
  assert.equal(autoScaleFactor(200, 100, { distortion: -50 }), 1, 'barrel fills the frame already');
  // a rotated w x h rectangle covers the frame when scaled by cos + max(w/h, h/w) sin (a little more for the pixel centres)
  const rot = autoScaleFactor(400, 200, { angle: 10 });
  const ideal = Math.cos((10 * Math.PI) / 180) + 2 * Math.sin((10 * Math.PI) / 180);
  assert.ok(rot >= ideal - 1e-3 && rot < ideal * 1.02, `${rot} vs ${ideal}`);
  assert.ok(Math.abs(effectiveScale(400, 200, { angle: 10, autoScale: true, scale: 110 }) - rot * 1.1) < 1e-9);
  assert.equal(effectiveScale(400, 200, { angle: 10, scale: 110 }), 1.1);
  const img = noise(120, 80, 5);
  for (const params of [{ angle: 10 }, { angle: -33 }, { distortion: 70 }, { vertical: 60, horizontal: -40 }, { distortion: 40, angle: 5, vertical: -30, chromaRC: 100 }]) {
    const plain = lensCorrect(img, params);
    let holes = 0;
    for (let i = 3; i < plain.data.length; i += 4) if (plain.data[i] < 255) holes++;
    assert.ok(holes > 50, `${JSON.stringify(params)} leaves empty areas without auto scale (${holes})`);
    const auto = lensCorrect(img, { ...params, autoScale: true });
    for (let i = 3; i < auto.data.length; i += 4) assert.equal(auto.data[i], 255, `${JSON.stringify(params)}: pixel ${(i - 3) / 4} is covered`);
    // and it is the smallest: 3 % less leaves a hole again
    const f = autoScaleFactor(120, 80, params);
    assert.ok(f > 1.01);
    const less = lensCorrect(img, { ...params, scale: f * 97 });
    let gaps = 0;
    for (let i = 3; i < less.data.length; i += 4) if (less.data[i] < 255) gaps++;
    assert.ok(gaps > 0, `${JSON.stringify(params)}: ${f} is not larger than needed`);
  }
});

test('rect limits the pixels written, the geometry stays that of the whole image', () => {
  const img = noise(60, 40, 6);
  const params = { distortion: 30, angle: 7, vignette: -30 };
  const full = lensCorrect(img, params);
  const rect = { x: 10, y: 8, width: 25, height: 20 };
  const part = lensCorrect(img, params, { rect });
  const viaFilter = applyFilter(cloneImage(img), 'lens-correction', params, rect);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) {
    const inside = x >= 10 && x < 35 && y >= 8 && y < 28;
    assert.deepEqual(px(part, x, y), inside ? px(full, x, y) : px(img, x, y), `${x},${y}`);
    assert.deepEqual(px(viaFilter, x, y), px(part, x, y));
  }
  assert.deepEqual(applyFilter(cloneImage(img), 'lens-correction', params).data, full.data);
});

test('transparency: colours are alpha weighted and empty images stay empty', () => {
  const img = createImage(60, 60);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) setPixel(img, x, y, [255, 0, 0, 1]);
  const out = lensCorrect(img, { angle: 17, distortion: 20 });
  let partial = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3];
    if (!a) continue;
    if (a < 255) partial++;
    // no dark fringe: wherever something shows it is pure red
    assert.equal(out.data[i], 255);
    assert.equal(out.data[i + 1], 0);
    assert.equal(out.data[i + 2], 0);
  }
  assert.ok(partial > 20, 'the turned edges are antialiased');
  const empty = lensCorrect(createImage(30, 20), { angle: 5, vignette: 50, distortion: -40 });
  assert.ok(empty.data.every((v) => v === 0));
});

test('detectHorizon finds a drawn 3° horizon within 0.5°, other tilts too, and nothing in a flat image', () => {
  const found = detectHorizon(horizonImage(400, 300, 3));
  assert.ok(found, 'a horizon was found');
  assert.ok(Math.abs(found.angle - 3) < 0.5, `angle ${found.angle}`);
  assert.ok(found.confidence > 0.8, `confidence ${found.confidence}`);
  // the fitted line runs through the drawn one
  const t = Math.tan((3 * Math.PI) / 180);
  assert.ok(Math.abs(found.line.y0 - (150 - 200 * t)) < 2.5, `left end ${found.line.y0}`);
  assert.ok(Math.abs(found.line.y1 - (150 + 200 * t)) < 2.5, `right end ${found.line.y1}`);
  for (const deg of [-7, -1.5, 0, 0.8, 12, 25]) {
    const h = detectHorizon(horizonImage(360, 240, deg, { seed: 11, offset: -20 }));
    assert.ok(h && Math.abs(h.angle - deg) < 0.5, `${deg}°: found ${h?.angle}`);
  }
  // a thin dark line on a light background, with a shorter vertical line that must not win
  const line = solid(300, 200, [235, 235, 235, 255]);
  const tl = Math.tan((3 * Math.PI) / 180);
  for (let x = 0; x < 300; x++) {
    const y = Math.round(100 + (x - 150) * tl);
    for (let k = -1; k <= 1; k++) setPixel(line, x, y + k, [20, 20, 20, 1]);
  }
  for (let y = 20; y < 90; y++) setPixel(line, 80, y, [20, 20, 20, 1]);
  const thin = detectHorizon(line);
  assert.ok(thin && Math.abs(thin.angle - 3) < 0.5, `thin line: ${thin?.angle}`);
  // a real-sized layer (the detector works on a reduced copy)
  const big = detectHorizon(horizonImage(2000, 1500, -4.2, { seed: 3 }));
  assert.ok(big && Math.abs(big.angle + 4.2) < 0.5, `2000x1500: ${big?.angle}`);
  assert.ok(Math.abs(big.line.y1 - big.line.y0 - 2000 * Math.tan((-4.2 * Math.PI) / 180)) < 12);
  // nothing to find
  assert.equal(detectHorizon(solid(200, 100, [90, 90, 90, 255])), null);
  assert.equal(detectHorizon(createImage(200, 100)), null);
  assert.equal(detectHorizon(createImage(4, 4)), null);
});

test('correcting by the detected angle levels the horizon', () => {
  const img = horizonImage(400, 300, 5, { seed: 2 });
  const h = detectHorizon(img);
  assert.ok(Math.abs(h.angle - 5) < 0.5);
  const fixed = lensCorrect(img, { angle: -h.angle, autoScale: true });
  const after = detectHorizon(fixed);
  assert.ok(after && Math.abs(after.angle) < 0.5, `after the correction: ${after?.angle}`);
  // sky above, ground below, on both sides of the picture
  for (const x of [40, 360]) {
    assert.ok(px(fixed, x, 110)[2] > 180, `sky at ${x}`);
    assert.ok(px(fixed, x, 190)[2] < 90, `ground at ${x}`);
  }
});

test('straightenAngle and gridLines serve the dialog', () => {
  const t3 = Math.tan((3 * Math.PI) / 180);
  assert.ok(Math.abs(straightenAngle(0, 0, 100, 100 * t3) - 3) < 1e-9);
  assert.ok(Math.abs(straightenAngle(100, 100 * t3, 0, 0) - 3) < 1e-9, 'the drawing direction does not matter');
  assert.ok(Math.abs(straightenAngle(10, 50, 110, 50 - 100 * t3) + 3) < 1e-9);
  // a nearly vertical line measures against the vertical: top leaning right is a clockwise tilt
  assert.ok(Math.abs(straightenAngle(50, 100, 50 + 100 * t3, 0) - 3) < 1e-9);
  assert.ok(Math.abs(straightenAngle(50, 0, 50 + 100 * t3, 100) + 3) < 1e-9);
  assert.equal(straightenAngle(5, 5, 5, 5), 0);
  assert.equal(straightenAngle(0, 0, 10, 0), 0);
  assert.ok(Math.abs(straightenAngle(0, 0, 10, 10)) === 45);
  // drawing along the tilted horizon and subtracting the result levels it
  const img = horizonImage(300, 200, 6);
  const drawn = straightenAngle(20, 100 + (20 - 150) * Math.tan((6 * Math.PI) / 180), 280, 100 + (280 - 150) * Math.tan((6 * Math.PI) / 180));
  assert.ok(Math.abs(drawn - 6) < 1e-9);
  const level = detectHorizon(lensCorrect(img, { angle: 0 - drawn, edge: 'repeat' }));
  assert.ok(Math.abs(level.angle) < 0.5);

  const g = gridLines(200, 100, 64);
  assert.deepEqual(g.xs, [36, 100, 164]);
  assert.deepEqual(g.ys, [50]);
  assert.deepEqual(gridLines(200, 100, 64, { offsetX: 10, offsetY: -10 }).xs, [46, 110, 174]);
  assert.deepEqual(gridLines(200, 100, 64, { offsetX: 10, offsetY: -10 }).ys, [40]);
  assert.deepEqual(gridLines(100, 100, 50).xs, [0, 50, 100]);
  assert.ok(gridLines(100, 100, 0).xs.length <= 51, 'a zero size does not loop forever');
});

test('a 2000x1500 layer is corrected in interactive time', () => {
  const img = noise(2000, 1500, 12);
  const t = performance.now();
  const out = lensCorrect(img, { distortion: 30, angle: 3, vertical: 20, vignette: -40, chromaRC: 30, autoScale: true });
  const ms = performance.now() - t;
  assert.equal(out.width, 2000);
  assert.ok(ms < 4000, `${ms.toFixed(0)} ms`);
});
