// Select Subject / Sky / Focus Area / Object Selection (segment.js) and Refine Edge (matte.js) on
// synthetic images whose right answer is known: overlap (IoU) with the truth, where alpha may be
// fractional, and what the refinements do to an edge in numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saliency, grabCut, selectSubject, selectSky, focusArea, focusMeasure, objectSelect, maxflowGrid,
  GC_BGD, GC_FGD, GC_PR_BGD, GC_PR_FGD,
} from '../../src/shared/pixels/segment.js';
import { refineEdge, edgeBand, decontaminate, globalRefine, boxMean, gaussianBlur, minMaxFilter, guidedFilter } from '../../src/shared/pixels/matte.js';
import { createImage, randomSeeded } from '../../src/shared/pixels/core.js';
import { applyFilter } from '../../src/shared/pixels/filters.js';

const iou = (mask, truth) => {
  let both = 0, either = 0;
  for (let p = 0; p < mask.length; p++) {
    const a = mask[p] >= 128, b = !!truth[p];
    if (a && b) both++;
    if (a || b) either++;
  }
  return either ? both / either : 1;
};
const count = (mask, min = 128) => mask.reduce((n, v) => n + (v >= min ? 1 : 0), 0);

/** A disc of colour fg on bg with uniform noise of the given amplitude; truth = the disc. */
function discImage(w, h, cx, cy, r, fg, bg, noise = 0, seed = 1) {
  const img = createImage(w, h), rnd = randomSeeded(seed), truth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r, c = inside ? fg : bg, i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) img.data[i + k] = c[k] + (rnd() - 0.5) * noise;
    img.data[i + 3] = 255;
    truth[y * w + x] = inside ? 1 : 0;
  }
  return { img, truth };
}

/** A disc whose edge fades from the foreground to the background colour between r - soft and r + soft; the mask cuts it at r. */
function softDisc(w = 160, h = 120, r = 40, soft = 6) {
  const img = createImage(w, h), mask = new Uint8ClampedArray(w * h), truth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - w / 2, y - h / 2), a = Math.min(1, Math.max(0, (r + soft - d) / (2 * soft))), i = (y * w + x) * 4;
    img.data[i] = 30 + 200 * a; // red disc ...
    img.data[i + 1] = 200 - 170 * a; // ... on green
    img.data[i + 2] = 60 - 20 * a;
    img.data[i + 3] = 255;
    mask[y * w + x] = d <= r ? 255 : 0;
    truth[y * w + x] = a;
  }
  return { img, mask, truth, w, h, r, soft };
}

test('maxflowGrid: the flow equals the cheapest cut found by trying every labelling of a 3x3 grid', () => {
  const rnd = randomSeeded(7), w = 3, h = 3, n = 9;
  const DX = [1, 1, 0, -1], DY = [0, 1, 1, 1];
  for (let trial = 0; trial < 60; trial++) {
    const cap = new Int32Array(n * 8), tcap = new Int32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || nx >= w || ny >= h) continue;
      const c = Math.floor(rnd() * 10);
      cap[(y * w + x) * 8 + d] = c;
      cap[(ny * w + nx) * 8 + (d ^ 4)] = c;
    }
    for (let i = 0; i < n; i++) tcap[i] = Math.floor(rnd() * 21) - 10;
    const c0 = Int32Array.from(cap), t0 = Int32Array.from(tcap);
    const energy = (lab) => {
      let e = 0;
      for (let i = 0; i < n; i++) e += t0[i] > 0 && !lab[i] ? t0[i] : t0[i] < 0 && lab[i] ? -t0[i] : 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny >= h) continue;
        if (lab[y * w + x] !== lab[ny * w + nx]) e += c0[(y * w + x) * 8 + d];
      }
      return e;
    };
    let best = Infinity;
    for (let m = 0; m < 512; m++) best = Math.min(best, energy(Array.from({ length: n }, (_, i) => (m >> i) & 1)));
    const { source, flow } = maxflowGrid(w, h, cap, tcap);
    assert.equal(flow, best, `trial ${trial}: max-flow = min-cut`);
    assert.equal(energy(Array.from(source)), best, `trial ${trial}: the returned side is a cheapest cut`);
  }
});

test('maxflowGrid: a wall of weak arcs is where two terminals are separated', () => {
  // 6x1 strip, source at the left end, sink at the right, the arc between x = 3 and 4 is the weakest
  const w = 6, h = 1, cap = new Int32Array(w * 8), tcap = new Int32Array(w);
  for (let x = 0; x < w - 1; x++) {
    const c = x === 3 ? 2 : 9;
    cap[x * 8] = c;
    cap[(x + 1) * 8 + 4] = c;
  }
  tcap[0] = 100;
  tcap[5] = -100;
  const { source, flow } = maxflowGrid(w, h, cap, tcap);
  assert.equal(flow, 2);
  assert.deepEqual(Array.from(source), [1, 1, 1, 1, 0, 0]);
});

test('saliency: a saturated disc stands out, a plain background does not', () => {
  const { img } = discImage(200, 150, 90, 70, 40, [220, 30, 40], [200, 200, 200]);
  const s = saliency(img);
  assert.equal(s.length, 200 * 150);
  assert.ok(s[70 * 200 + 90] > 200, `disc centre ${s[70 * 200 + 90]}`);
  assert.ok(s[10 * 200 + 10] < 45, `corner ${s[10 * 200 + 10]}`);
  assert.ok(s[140 * 200 + 180] < 45, `far corner ${s[140 * 200 + 180]}`);
  // an image of one colour (with noise) has nothing salient
  const { img: flat } = discImage(120, 90, -50, -50, 1, [0, 0, 0], [120, 124, 118], 10, 3);
  assert.ok(Math.max(...saliency(flat)) < 90, `flat image stays low: ${Math.max(...saliency(flat))}`);
});

test('selectSubject: a saturated disc on a plain background, IoU > 0.9, also with noise and off centre', () => {
  const a = discImage(200, 150, 90, 70, 40, [220, 30, 40], [200, 200, 200]);
  const ma = selectSubject(a.img);
  assert.ok(iou(ma, a.truth) > 0.97, `plain: IoU ${iou(ma, a.truth)}`);
  assert.equal(ma[70 * 200 + 90], 255);
  assert.equal(ma[5 * 200 + 5], 0);
  const b = discImage(240, 160, 60, 100, 30, [20, 160, 60], [230, 220, 180], 30, 2);
  assert.ok(iou(selectSubject(b.img), b.truth) > 0.95, `noisy, off centre: IoU ${iou(selectSubject(b.img), b.truth)}`);
  // reduced for the cut (scale 100) and brought back: the edge is still found to within a pixel or two
  const c = discImage(400, 300, 220, 150, 80, [240, 200, 20], [60, 80, 120], 12, 4);
  assert.ok(iou(selectSubject(c.img, { scale: 100 }), c.truth) > 0.95, `reduced: IoU ${iou(selectSubject(c.img, { scale: 100 }), c.truth)}`);
});

test('selectSubject: two-part subject touching the frame, nothing on a flat image, opaque pixels of a cut-out', () => {
  // a pale head over a vivid checked body that leaves through the bottom edge, on a noisy gradient
  const w = 320, h = 240, img = createImage(w, h), truth = new Uint8Array(w * h), rnd = randomSeeded(11);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const head = (x - 160) ** 2 + (y - 80) ** 2 <= 35 * 35, body = Math.abs(x - 160) < 30 + (y - 110) * 0.5 && y > 110;
    const c = head ? [225 + rnd() * 10, 180 + rnd() * 10, 150 + rnd() * 10] : body ? (((x >> 3) + (y >> 3)) % 2 ? [180, 30, 40] : [30, 40, 120]) : [90 + y * 0.3 + rnd() * 12, 140 + x * 0.1 + rnd() * 12, 120 - y * 0.2 + rnd() * 12];
    img.data.set([c[0], c[1], c[2], 255], i);
    truth[y * w + x] = head || body ? 1 : 0;
  }
  assert.ok(iou(selectSubject(img), truth) > 0.93, `figure: IoU ${iou(selectSubject(img), truth)}`);
  const { img: flat } = discImage(160, 120, -50, -50, 1, [0, 0, 0], [120, 124, 118], 10, 5);
  assert.ok(count(selectSubject(flat)) < 160 * 120 * 0.01, 'a flat image has no subject');
  // a layer that is mostly transparent: its opaque pixels are the subject
  const cut = createImage(60, 40);
  for (let y = 10; y < 30; y++) for (let x = 20; x < 45; x++) cut.data.set([10, 200, 90, 255], (y * 60 + x) * 4);
  for (let y = 14; y < 18; y++) for (let x = 24; x < 30; x++) cut.data[(y * 60 + x) * 4 + 3] = 0; // a hole
  const m = selectSubject(cut);
  assert.equal(count(m), 20 * 25 - 4 * 6);
  assert.equal(m[15 * 60 + 26], 0);
  assert.equal(count(selectSubject(createImage(20, 20))), 0, 'an empty layer selects nothing');
});

test('selectSky: the blue gradient top half is the sky, the textured ground is not', () => {
  const w = 200, h = 160, img = createImage(w, h), truth = new Uint8Array(w * h), rnd = randomSeeded(3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const top = y < h / 2, t = y / (h / 2), n = rnd();
    const c = top ? [40 + 120 * t, 100 + 100 * t, 220 + 20 * t] : [60 + 60 * n, 110 + 50 * rnd(), 40 + 30 * n];
    img.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    truth[y * w + x] = top ? 1 : 0;
  }
  const m = selectSky(img);
  assert.ok(iou(m, truth) > 0.97, `IoU ${iou(m, truth)}`);
  assert.equal(m[10 * w + 100], 255);
  assert.equal(m[150 * w + 100], 0);
  // the same blue at the bottom of the frame (a lake) is not connected to the top: no sky there
  const lake = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bottom = y >= h * 0.6, n = rnd();
    const c = bottom ? [60, 120, 230] : [90 + 50 * n, 70 + 40 * rnd(), 50 + 30 * n];
    lake.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  assert.equal(count(selectSky(lake)), 0, 'blue below, nothing at the top');
  // overcast: a bright colourless smooth top third over dark ground
  const grey = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const top = y < 60, n = rnd();
    const c = top ? [225 + y * 0.2, 228 + y * 0.2, 232 + y * 0.2] : [50 + 70 * n, 60 + 60 * rnd(), 40 + 50 * n];
    grey.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  const mg = selectSky(grey);
  let hit = 0;
  for (let y = 0; y < 60; y++) for (let x = 0; x < w; x++) hit += mg[y * w + x] >= 128 ? 1 : 0;
  assert.ok(hit > 60 * w * 0.95 && count(mg) < 60 * w * 1.05, `overcast sky: ${hit} of ${60 * w}, ${count(mg)} selected`);
});

/** Noise texture, sharp on the left half and blurred on the right. */
function halfBlurred(w = 240, h = 160, radius = 3) {
  const img = createImage(w, h), truth = new Uint8Array(w * h), rnd = randomSeeded(5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = rnd() * 255, u = rnd() * 255;
    img.data.set([v, (v + u) / 2, u, 255], (y * w + x) * 4);
    truth[y * w + x] = x < w / 2 ? 1 : 0;
  }
  applyFilter(img, 'gaussian-blur', { radius }, { x: w / 2, y: 0, width: w / 2, height: h });
  return { img, truth, w, h };
}

test('focusArea: the sharp half of a half-blurred texture', () => {
  const { img, truth, w } = halfBlurred();
  const stats = {};
  const m = focusArea(img, { autoRange: true, stats });
  assert.ok(iou(m, truth) > 0.95, `IoU ${iou(m, truth)}`);
  assert.equal(m[80 * w + 30], 255);
  assert.equal(m[80 * w + 210], 0);
  assert.ok(stats.range > 15 && stats.range < 85, `auto range ${stats.range}`);
  // the measure itself: high on the sharp side, low on the blurred side
  const fm = focusMeasure(img);
  const at = (x, y) => fm.data[Math.floor((y / 160) * fm.height) * fm.width + Math.floor((x / 240) * fm.width)];
  assert.ok(at(40, 80) > 0.7, `sharp ${at(40, 80)}`);
  assert.ok(at(200, 80) < 0.4, `blurred ${at(200, 80)}`);
  assert.equal(fm.auto, stats.range);
  // range: 0 takes everything, a threshold above the sharpest takes nothing, the measure can be reused
  assert.equal(count(focusArea(img, { range: 0 })), w * 160);
  assert.equal(count(focusArea(img, { range: 100, measure: fm })), 0);
  assert.deepEqual(focusArea(img, { range: stats.range, measure: fm }), m);
  // a fixed high noise floor hides the weaker detail: less is in focus than with the low one
  assert.ok(count(focusArea(img, { range: 40, noise: 'high' })) <= count(focusArea(img, { range: 40, noise: 'low' })));
});

test('objectSelect: the object inside the rectangle or lasso, not its neighbour, never beyond the region', () => {
  const { img, truth } = discImage(300, 200, 100, 90, 35, [240, 200, 20], [70, 90, 120], 16);
  for (let y = 20; y < 60; y++) for (let x = 200; x < 260; x++) img.data.set([200, 40, 160], (y * 300 + x) * 4); // another object
  const rect = { x: 50, y: 40, width: 100, height: 100 };
  const m = objectSelect(img, rect);
  assert.ok(iou(m, truth) > 0.95, `rectangle: IoU ${iou(m, truth)}`);
  assert.equal(m[40 * 300 + 230], 0, 'the neighbour is outside the region');
  const poly = [[50, 40], [150, 45], [160, 140], [45, 135]];
  assert.ok(iou(objectSelect(img, poly), truth) > 0.95, `lasso: IoU ${iou(objectSelect(img, poly), truth)}`);
  // a region that cuts through the object: only the part inside it
  const half = objectSelect(img, { x: 100, y: 40, width: 60, height: 100 });
  for (let y = 0; y < 200; y++) for (let x = 0; x < 100; x++) assert.equal(half[y * 300 + x], 0, `(${x}, ${y}) is left of the region`);
  assert.ok(count(half) > 0.4 * count(truth, 1) && count(half) < 0.6 * count(truth, 1), `half the disc: ${count(half)} of ${count(truth, 1)}`);
  // hard edge: only 0 and 255
  assert.ok(objectSelect(img, rect, { hardEdge: true }).every((v) => v === 0 || v === 255));
  // nothing to tell apart: the region as drawn
  const { img: flat } = discImage(200, 150, -50, -50, 1, [0, 0, 0], [120, 124, 118], 10, 5);
  const whole = objectSelect(flat, { x: 40, y: 40, width: 60, height: 50 });
  assert.ok(count(whole) > 2900 && count(whole) <= 3000, `flat region: ${count(whole)} of 3000`);
  assert.equal(count(objectSelect(img, { x: 10, y: 10, width: 1, height: 1 })), 0, 'a click is not a region');
  // the region covers the whole image: its rim stands in for the background
  assert.ok(iou(objectSelect(discImage(120, 90, 60, 45, 25, [220, 30, 40], [200, 200, 200]).img, { x: 0, y: 0, width: 120, height: 90 }), discImage(120, 90, 60, 45, 25, [0, 0, 0], [0, 0, 0]).truth) > 0.9);
});

test('grabCut: sure strokes and a probable box separate two colours; the rect limits the result', () => {
  const { img, truth } = discImage(160, 120, 80, 60, 30, [30, 60, 200], [210, 190, 60], 20, 9);
  const init = new Uint8Array(160 * 120).fill(GC_PR_BGD);
  for (let y = 20; y < 100; y++) for (let x = 40; x < 120; x++) init[y * 160 + x] = GC_PR_FGD;
  for (let x = 70; x < 90; x++) init[60 * 160 + x] = GC_FGD;
  for (let x = 0; x < 160; x++) init[2 * 160 + x] = GC_BGD;
  const stats = {};
  const m = grabCut(img, init, { stats });
  assert.ok(iou(m, truth) > 0.96, `IoU ${iou(m, truth)}`);
  assert.ok(stats.cuts >= 1 && stats.nodes === 160 * 120, JSON.stringify(stats));
  // sure labels are kept whatever the colours say
  const forced = Uint8Array.from(init);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) forced[y * 160 + x] = GC_FGD;
  const mf = grabCut(img, forced, { hardEdge: true });
  assert.equal(mf[10 * 160 + 10], 255, 'sure foreground stays');
  assert.equal(mf[2 * 160 + 80], 0, 'sure background stays');
  // nothing marked foreground: an empty mask
  assert.equal(count(grabCut(img, new Uint8Array(160 * 120).fill(GC_PR_BGD))), 0);
  const limited = grabCut(img, init, { rect: { x: 80, y: 0, width: 80, height: 120 } });
  for (let y = 0; y < 120; y += 7) for (let x = 0; x < 80; x += 7) assert.equal(limited[y * 160 + x], 0);
  assert.ok(count(limited) > 0.4 * count(truth, 1));
  // transparent pixels never belong to the result
  const holed = { width: 160, height: 120, data: new Uint8ClampedArray(img.data) };
  for (let y = 55; y < 65; y++) for (let x = 75; x < 85; x++) holed.data[(y * 160 + x) * 4 + 3] = 0;
  assert.equal(grabCut(holed, init)[60 * 160 + 80], 0);
});

test('refineEdge: a hard mask over a soft-edged image gets fractional alpha in the band, and only there', () => {
  const { img, mask, truth, w, h, r } = softDisc();
  for (const mode of ['object', 'color']) {
    const out = refineEdge(img, mask, { radius: 8, mode });
    let fractional = 0, err = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, d = Math.hypot(x - w / 2, y - h / 2), inBand = Math.abs(d - r) <= 9.5;
      if (!inBand) assert.equal(out[p], mask[p], `${mode}: (${x}, ${y}) is outside the band and keeps its value`);
      else {
        if (out[p] > 0 && out[p] < 255) fractional++;
        err += Math.abs(out[p] / 255 - truth[p]);
        n++;
      }
    }
    assert.ok(fractional > 1500, `${mode}: ${fractional} fractional pixels in the band`);
    assert.ok(err / n < 0.03, `${mode}: mean error against the true alpha ${err / n}`);
  }
  // half way through the fade the alpha is about a half, a hard mask had 255 or 0 there
  const out = refineEdge(img, mask, { radius: 8 });
  const mid = out[(h / 2) * w + w / 2 + r];
  assert.ok(mid > 90 && mid < 165, `alpha at the middle of the fade ${mid}`);
  // radius 0 leaves the mask alone; the band is what edgeBand reports
  assert.deepEqual(refineEdge(img, mask, {}), mask);
  const { band, count: n8, bounds } = edgeBand(img, mask, { radius: 8 });
  assert.ok(n8 > 3500 && n8 < 4400, `band of ${n8} px (2 pi 40 16 = 4021)`);
  assert.equal(band[(h / 2) * w + w / 2], 0);
  assert.equal(band[(h / 2) * w + w / 2 + r + 3], 1);
  assert.ok(bounds.x >= 80 - 49 && bounds.x <= 80 - 46, `band bounds start at ${bounds.x}`);
  // Smart Radius narrows the band where the edge is hard
  const hard = discImage(160, 120, 80, 60, 40, [230, 30, 40], [30, 200, 60]);
  const hardMask = Uint8ClampedArray.from(hard.truth, (v) => v * 255);
  const plain = edgeBand(hard.img, hardMask, { radius: 10 }).count, smart = edgeBand(hard.img, hardMask, { radius: 10, smartRadius: true }).count;
  assert.ok(smart < plain * 0.6, `smart radius ${smart} px against ${plain}`);
  // the Refine Edge Brush: alpha is estimated in the painted area although the radius is 0
  const extra = new Uint8Array(w * h);
  for (let y = 50; y < 70; y++) for (let x = 110; x < 130; x++) extra[y * w + x] = 255;
  const brushed = refineEdge(img, mask, { radius: 0, extra, extraRadius: 10 });
  assert.ok(brushed[60 * w + 120] > 90 && brushed[60 * w + 120] < 165, `painted: ${brushed[60 * w + 120]}`);
  assert.equal(brushed[20 * w + 80], mask[20 * w + 80], 'unpainted edge is untouched');
  assert.equal(brushed[(h / 2) * w + w / 2 - r], mask[(h / 2) * w + w / 2 - r], 'the other side of the disc too');
});

test('refineEdge: Feather softens, Contrast hardens, Shift Edge moves, Smooth removes spurs', () => {
  const w = 80, h = 40, img = createImage(w, h, [128, 128, 128, 1]);
  const mask = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) mask.fill(255, y * w, y * w + 40); // left half
  const row = (m) => Array.from(m.subarray(20 * w, 21 * w));
  const soft = (m) => row(m).filter((v) => v > 0 && v < 255).length;
  const edge = (m) => row(m).reduce((s, v) => s + v, 0) / 255; // position of the edge in px
  assert.equal(soft(mask), 0);
  const f4 = refineEdge(img, mask, { feather: 4 }), f10 = refineEdge(img, mask, { feather: 10 });
  assert.ok(soft(f4) >= 6 && soft(f4) <= 14, `feather 4: ${soft(f4)} soft px`);
  assert.ok(soft(f10) > soft(f4) + 8, `feather 10: ${soft(f10)} soft px`);
  assert.ok(Math.abs(edge(f10) - 40) < 0.6, 'feather keeps the edge where it was');
  assert.ok(Math.abs(row(f10)[39] + row(f10)[40] - 255) <= 2, 'symmetric about the edge');
  assert.equal(f10[5 * w + 60], f10[20 * w + 60], 'no fade at the canvas edge: every row is the same');
  const fc = refineEdge(img, mask, { feather: 10, contrast: 80 });
  assert.ok(soft(fc) <= 4, `contrast 80 leaves ${soft(fc)} soft px of ${soft(f10)}`);
  assert.ok(Math.abs(edge(fc) - 40) < 0.6);
  // Shift Edge: +100 % of the band (max of radius, feather, 3 px) outwards, -100 % inwards
  assert.ok(Math.abs(edge(refineEdge(img, mask, { shift: 100 })) - 43) < 0.01);
  assert.ok(Math.abs(edge(refineEdge(img, mask, { shift: -100 })) - 37) < 0.01);
  assert.ok(Math.abs(edge(refineEdge(img, mask, { shift: 50 })) - 41.5) < 0.01);
  assert.ok(Math.abs(edge(refineEdge(img, mask, { feather: 10, shift: -50 })) - 35) < 0.7);
  // Smooth: a one-pixel spur and a one-pixel notch disappear, the straight edge stays
  const rough = Uint8ClampedArray.from(mask);
  rough[10 * w + 40] = 255;
  rough[10 * w + 41] = 255;
  rough[30 * w + 39] = 0;
  const sm = refineEdge(img, rough, { smooth: 50 });
  assert.ok(sm[10 * w + 41] < 40, `spur ${sm[10 * w + 41]}`);
  assert.ok(sm[30 * w + 39] > 215, `notch ${sm[30 * w + 39]}`);
  assert.ok(Math.abs(edge(sm) - 40) < 0.6);
  assert.ok(soft(sm) <= 3, 'smooth does not feather');
  // globalRefine on a plane: no option, no change; an empty or full mask stays what it is
  const plane = Float32Array.from(mask, (v) => v / 255);
  assert.deepEqual(globalRefine(Float32Array.from(plane), w, h, {}), plane);
  assert.equal(count(refineEdge(img, new Uint8ClampedArray(w * h), { feather: 5, shift: 100, smooth: 40 })), 0);
  assert.equal(count(refineEdge(img, new Uint8ClampedArray(w * h).fill(255), { feather: 5, shift: -100 }), 255), w * h);
});

test('decontaminate: the halo colour leaves the soft edge, solid and unselected pixels are untouched', () => {
  const { img, mask, w, h } = softDisc();
  const alpha = refineEdge(img, mask, { radius: 8 });
  const out = decontaminate(img, alpha, 1);
  let before = 0, after = 0, n = 0;
  for (let p = 0; p < w * h; p++) {
    if (alpha[p] === 0 || alpha[p] >= 250) {
      for (let k = 0; k < 4; k++) assert.equal(out.data[p * 4 + k], img.data[p * 4 + k]);
    } else if (alpha[p] > 20 && alpha[p] < 235) {
      before += img.data[p * 4 + 1];
      after += out.data[p * 4 + 1];
      n++;
    }
    assert.equal(out.data[p * 4 + 3], img.data[p * 4 + 3], 'alpha is not changed');
  }
  // green is the background's colour: about 118 on average in the fade, close to the disc's 30 afterwards
  assert.ok(before / n > 95, `before ${before / n}`);
  assert.ok(after / n < 60, `after ${after / n}`);
  // a nearly transparent edge pixel becomes the interior colour
  const p = (h / 2) * w + w / 2 + 44;
  assert.ok(alpha[p] > 0 && alpha[p] < 80, `alpha ${alpha[p]}`);
  assert.ok(img.data[p * 4 + 1] > 150 && out.data[p * 4 + 1] < 60 && out.data[p * 4] > 200, `(${img.data[p * 4]}, ${img.data[p * 4 + 1]}) -> (${out.data[p * 4]}, ${out.data[p * 4 + 1]})`);
  // amount scales it, 0 is a copy; the input is never modified
  const halfway = decontaminate(img, alpha, 0.5);
  assert.ok(Math.abs(halfway.data[p * 4 + 1] - (img.data[p * 4 + 1] + out.data[p * 4 + 1]) / 2) <= 1.5);
  assert.deepEqual(decontaminate(img, alpha, 0).data, img.data);
  assert.notEqual(out.data, img.data);
});

test('plane primitives: box mean, Gaussian blur, min/max filter, guided filter', () => {
  const w = 9, h = 9, plane = new Float32Array(w * h);
  plane[4 * w + 4] = 9;
  const m = boxMean(plane, w, h, 1);
  assert.ok(Math.abs(m[4 * w + 4] - 1) < 1e-6 && Math.abs(m[3 * w + 3] - 1) < 1e-6 && m[4 * w + 6] === 0);
  // windows are clipped at the border: a constant plane stays constant
  const ones = new Float32Array(w * h).fill(0.7);
  for (const v of boxMean(ones, w, h, 3)) assert.ok(Math.abs(v - 0.7) < 1e-6);
  for (const sigma of [0.6, 2, 4]) for (const v of gaussianBlur(Float32Array.from(ones), w, h, sigma)) assert.ok(Math.abs(v - 0.7) < 1e-5);
  // a small sigma is a real Gaussian: the sum is kept, the centre row follows exp(-x² / 2 sigma²)
  const g = gaussianBlur(Float32Array.from(plane), w, h, 1);
  assert.ok(Math.abs(g.reduce((s, v) => s + v, 0) - 9) < 0.05, `blur keeps the sum: ${g.reduce((s, v) => s + v, 0)}`);
  assert.ok(Math.abs(g[4 * w + 5] / g[4 * w + 4] - Math.exp(-0.5)) < 0.01 && Math.abs(g[4 * w + 6] / g[4 * w + 4] - Math.exp(-2)) < 0.01);
  // a large one is three boxes: wider, still centred and monotone
  const wide = new Float32Array(41 * 41);
  wide[20 * 41 + 20] = 100;
  gaussianBlur(wide, 41, 41, 4);
  assert.ok(Math.abs(wide.reduce((s, v) => s + v, 0) - 100) < 0.5);
  assert.ok(wide[20 * 41 + 20] > wide[20 * 41 + 24] && wide[20 * 41 + 24] > wide[20 * 41 + 28] && Math.abs(wide[20 * 41 + 24] - wide[24 * 41 + 20]) < 1e-4);
  assert.ok(Math.abs(wide[20 * 41 + 24] / wide[20 * 41 + 20] - Math.exp(-0.5)) < 0.08, `one sigma out: ${wide[20 * 41 + 24] / wide[20 * 41 + 20]}`);
  const mx = minMaxFilter(plane, w, h, 2, true), mn = minMaxFilter(mx, w, h, 2, false);
  assert.equal(mx.reduce((s, v) => s + (v === 9 ? 1 : 0), 0), 25, 'dilation by 2 is a 5x5 square');
  assert.equal(mn.reduce((s, v) => s + (v === 9 ? 1 : 0), 0), 1, 'eroding it again gives the pixel back');
  // guided filter: a noisy mask over a two-colour image snaps to the colour edge
  const W = 60, H = 40, img = createImage(W, H), p = new Float32Array(W * H), rnd = randomSeeded(4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    img.data.set(x < 30 ? [200, 40, 40, 255] : [40, 60, 200, 255], (y * W + x) * 4);
    p[y * W + x] = x < 27 + Math.round(rnd() * 6) ? 1 : 0; // ragged edge around the real one
  }
  for (const subsample of [1, 2]) {
    const q = guidedFilter(img, p, { radius: 6, eps: 1e-4, subsample });
    for (let y = 2; y < H - 2; y += 5) {
      assert.ok(q[y * W + 28] > 0.8, `subsample ${subsample}: left of the edge ${q[y * W + 28]}`);
      assert.ok(q[y * W + 31] < 0.2, `subsample ${subsample}: right of the edge ${q[y * W + 31]}`);
    }
  }
  // rect limits the filtered area, `only` the pixels evaluated
  const part = guidedFilter(img, p, { radius: 6, rect: { x: 0, y: 0, width: W, height: 10 } });
  assert.deepEqual(part.subarray(10 * W), p.subarray(10 * W));
});

test('constants: the GrabCut labels are OpenCV\'s (bit 0 = foreground)', () => {
  assert.deepEqual([GC_BGD, GC_FGD, GC_PR_BGD, GC_PR_FGD], [0, 1, 2, 3]);
});
