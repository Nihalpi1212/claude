// Blending Options on adjustment layers (Pigment 0.4, the hunt's deferred paints-adjust item): the adjusted pixels
// are mixed back into the backdrop by opacity × fill × mask × Blend If (This Layer reads the adjusted result,
// Underlying Layer the backdrop), in the layer's blend mode, with the channels switched off keeping the backdrop.
// blend-if.js mixAdjustment is the 8-bit mix (compositor.js drawAdjustment), deep.js adjustLayerDeep the float one
// (lib/depth.js flattenDeep and the merges of 16/32-bit documents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixAdjustment, adjustmentMix } from '../../src/shared/pixels/blend-if.js';
import { applyAdjustment } from '../../src/shared/pixels/adjust.js';
import { blendPixel } from '../../src/shared/pixels/blend.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';
import { adjustLayerDeep, fromCanvasData, cloneDeep } from '../../src/shared/pixels/deep.js';

const px = (img, x, y = 0) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

/** A 256 x 1 grey ramp (value = x), opaque. */
function ramp() {
  const img = createImage(256, 1);
  for (let x = 0; x < 256; x++) setPixel(img, x, 0, [x, x, x, 1]);
  return img;
}

/** One row of the given colours (alpha 0..1). */
function row(colors) {
  const img = createImage(colors.length, 1);
  colors.forEach((c, x) => setPixel(img, x, 0, c));
  return img;
}

/** 0.3's mix (compositor.js lerpPixels): a lerp towards `after` by opacity × coverage. */
function lerp03(below, after, opacity, coverage = null) {
  const d = below.data, a = after.data;
  for (let i = 0, p = 0; p < d.length; i++, p += 4) {
    const t = opacity * (coverage ? coverage[i] / 255 : 1);
    if (t <= 0) continue;
    if (t >= 1) for (let c = 0; c < 4; c++) d[p + c] = a[p + c];
    else if (d[p + 3] === a[p + 3]) for (let c = 0; c < 3; c++) d[p + c] += (a[p + c] - d[p + c]) * t;
    else {
      const a0 = d[p + 3] / 255, a1 = a[p + 3] / 255, w0 = a0 * (1 - t), w1 = a1 * t, an = w0 + w1;
      for (let c = 0; c < 3; c++) d[p + c] = (d[p + c] * w0 + a[p + c] * w1) / an;
      d[p + 3] = an * 255;
    }
  }
  return below;
}

const blendIfGray = (thisRange = [0, 0, 255, 255], under = [0, 0, 255, 255]) => ({ gray: { this: thisRange, under } });

test('adjustmentMix is null for the 0.3 case and carries Fill as part of the opacity', () => {
  assert.equal(adjustmentMix({ blend: 'normal', opacity: 0.4, fillOpacity: 1 }, null), null);
  assert.equal(adjustmentMix({ blend: 'normal', opacity: 1, fillOpacity: 1 }, { knockout: 'deep', blendIf: blendIfGray(), channels: { r: true, g: true, b: true } }), null);
  assert.deepEqual(adjustmentMix({ blend: 'normal', opacity: 0.8, fillOpacity: 0.5 }, null), { mode: 'normal', opacity: 0.4, blendIf: null, channels: null });
  const m = adjustmentMix({ blend: 'luminosity', opacity: 1, fillOpacity: 1 }, { channels: { r: false } });
  assert.equal(m.mode, 'luminosity');
  assert.deepEqual(m.channels, { r: false });
});

test('Normal at full fill with no Blend If is 0.3 lerp exactly, mask and opacity included', () => {
  const img = ramp();
  const after = copy(img);
  applyAdjustment(after, 'invert', {});
  const cov = new Uint8ClampedArray(256).map((_, i) => (i * 7) % 256);
  const a = lerp03(copy(img), after, 0.6, cov);
  const b = mixAdjustment(copy(img), after, { mode: 'normal', opacity: 0.6, coverage: cov });
  assert.deepEqual(Array.from(b.data), Array.from(a.data));
  // over translucent pixels too
  const t = row([[200, 40, 10, 0.5], [0, 0, 0, 0], [90, 90, 90, 0.2]]);
  const tAfter = copy(t);
  tAfter.data[3] = 200; // an adjustment that changed alpha takes the premultiplied lerp
  applyAdjustment(tAfter, 'invert', {});
  assert.deepEqual(Array.from(mixAdjustment(copy(t), tAfter, { opacity: 0.5 }).data), Array.from(lerp03(copy(t), tAfter, 0.5).data));
});

test('Fill 50 % mixes like Opacity 50 % (Photoshop: Fill scales an adjustment as Opacity does)', () => {
  const img = ramp();
  const after = copy(img);
  applyAdjustment(after, 'hue-saturation', { hue: 0, saturation: 0, lightness: 60 });
  const viaFill = mixAdjustment(copy(img), after, adjustmentMix({ blend: 'normal', opacity: 1, fillOpacity: 0.5 }, null));
  const viaOpacity = lerp03(copy(img), after, 0.5);
  assert.deepEqual(Array.from(viaFill.data), Array.from(viaOpacity.data));
  assert.ok(px(viaFill, 100)[0] > 100 && px(viaFill, 100)[0] < px(after, 100)[0]);
});

test('Blend If This Layer reads the adjusted result: Curves on the highlights only', () => {
  const img = ramp();
  const after = copy(img);
  // a Curves that darkens everything by half
  applyAdjustment(after, 'curves', { rgb: [[0, 0], [255, 128]] });
  // This Layer 0/0 - 100/120: only where the adjusted value is up to 100 (split to 120) does the adjustment show
  const out = mixAdjustment(copy(img), after, { opacity: 1, blendIf: blendIfGray([0, 0, 100, 120]) });
  // input 180 -> adjusted ~90: shown in full
  assert.equal(px(out, 180)[0], px(after, 180)[0]);
  // input 250 -> adjusted ~125: past 120, hidden: the backdrop shows
  assert.equal(px(out, 250)[0], 250);
  // adjusted 110 is halfway through the split: half the change
  const x = Array.from({ length: 256 }, (_, i) => i).find((i) => px(after, i)[0] === 110);
  const half = x + (110 - x) * 0.5;
  assert.ok(Math.abs(px(out, x)[0] - half) <= 1, `${px(out, x)[0]} vs ${half}`);
});

test('Blend If Underlying Layer reads the backdrop: an Invert on the highlights only', () => {
  const img = ramp();
  const after = copy(img);
  applyAdjustment(after, 'invert', {});
  // Underlying 200/220 - 255/255: shadows of the backdrop are left alone, highlights inverted, a ramp between
  const out = mixAdjustment(copy(img), after, { opacity: 1, blendIf: blendIfGray(undefined, [200, 220, 255, 255]) });
  assert.deepEqual(px(out, 100), [100, 100, 100, 255]);
  assert.deepEqual(px(out, 199), [199, 199, 199, 255]);
  assert.deepEqual(px(out, 240), [15, 15, 15, 255]);
  const mid = px(out, 210)[0];
  assert.ok(Math.abs(mid - (210 + (45 - 210) * 0.5)) <= 1, String(mid));
  // the colour channels read their own values
  const c = row([[250, 10, 10, 1], [10, 250, 10, 1]]);
  const cAfter = copy(c);
  applyAdjustment(cAfter, 'invert', {});
  const r = mixAdjustment(copy(c), cAfter, { blendIf: { r: { this: [0, 0, 255, 255], under: [0, 0, 200, 200] } } });
  assert.deepEqual(px(r, 0), [250, 10, 10, 255]); // red 250 is past 200: hidden
  assert.deepEqual(px(r, 1), [245, 5, 245, 255]);
});

test('the channels switched off keep the backdrop (a Levels on red and blue only)', () => {
  const img = row([[100, 100, 100, 1], [30, 200, 60, 1]]);
  const after = copy(img);
  applyAdjustment(after, 'levels', { rgb: { inBlack: 0, inWhite: 128, gamma: 1, outBlack: 0, outWhite: 255 } });
  const out = mixAdjustment(copy(img), after, { channels: { r: true, g: false, b: true } });
  assert.deepEqual(px(out, 0), [px(after, 0)[0], 100, px(after, 0)[2], 255]);
  assert.deepEqual(px(out, 1), [px(after, 1)[0], 200, px(after, 1)[2], 255]);
  // with opacity the restricted channel still stays put
  const half = mixAdjustment(copy(img), after, { opacity: 0.5, channels: { g: false } });
  assert.equal(px(half, 1)[1], 200);
  assert.ok(Math.abs(px(half, 1)[0] - (30 + (px(after, 1)[0] - 30) / 2)) <= 1);
});

test('the blend mode blends the adjusted colour onto the backdrop (Curves in Luminosity keeps the hue)', () => {
  const img = row([[200, 60, 40, 1], [40, 90, 200, 1]]);
  const after = copy(img);
  applyAdjustment(after, 'curves', { rgb: [[0, 0], [128, 200], [255, 255]] });
  for (const mode of ['multiply', 'screen', 'luminosity', 'color', 'difference', 'overlay']) {
    const out = mixAdjustment(copy(img), after, { mode, opacity: 1 });
    for (let x = 0; x < 2; x++) {
      const [r, g, b] = px(img, x), [ar, ag, ab] = px(after, x);
      assert.deepEqual(px(out, x).slice(0, 3), blendPixel(mode, ar, ag, ab, r, g, b), `${mode} at ${x}`);
    }
  }
  // at 50 % the blended colour is half mixed in
  const half = mixAdjustment(copy(img), after, { mode: 'multiply', opacity: 0.5 });
  const full = blendPixel('multiply', ...px(after, 0).slice(0, 3), ...px(img, 0).slice(0, 3));
  assert.ok(Math.abs(px(half, 0)[0] - (200 + (full[0] - 200) / 2)) <= 1);
});

test('Dissolve keeps either the adjusted or the backdrop pixel, in about the right share, the same in any rect', () => {
  const W = 64, H = 64;
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, [40, 40, 40, 1]);
  const after = copy(img);
  applyAdjustment(after, 'invert', {});
  const out = mixAdjustment(copy(img), after, { mode: 'dissolve', opacity: 0.3 });
  let adjusted = 0;
  for (let p = 0; p < out.data.length; p += 4) {
    assert.ok(out.data[p] === 40 || out.data[p] === 215);
    if (out.data[p] === 215) adjusted++;
  }
  assert.ok(Math.abs(adjusted / (W * H) - 0.3) < 0.05, String(adjusted / (W * H)));
  // a 16 x 16 part at (20, 30) of the document speckles the same
  const part = createImage(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(part, x, y, [40, 40, 40, 1]);
  const pAfter = copy(part);
  applyAdjustment(pAfter, 'invert', {});
  mixAdjustment(part, pAfter, { mode: 'dissolve', opacity: 0.3, x: 20, y: 30 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.equal(px(part, x, y)[0], px(out, 20 + x, 30 + y)[0]);
});

test('transparent pixels stay transparent whatever the mix', () => {
  const img = row([[0, 0, 0, 0], [255, 255, 255, 0]]);
  const after = copy(img);
  applyAdjustment(after, 'invert', {});
  const out = mixAdjustment(copy(img), after, { mode: 'screen', opacity: 0.7, blendIf: blendIfGray([0, 0, 200, 255]) });
  assert.equal(px(out, 0)[3], 0);
  assert.equal(px(out, 1)[3], 0);
});

test('adjustLayerDeep mixes the same way in float: Blend If, channels, Fill, Multiply and Screen', () => {
  const img = ramp();
  const deep = fromCanvasData(img, 'u16');
  const run = (opts, kind = 'curves', params = { rgb: [[0, 0], [255, 128]] }) => {
    const d = cloneDeep(deep);
    adjustLayerDeep(d, kind, params, opts);
    const after8 = copy(img);
    applyAdjustment(after8, kind, params);
    const m8 = mixAdjustment(copy(img), after8, { mode: opts.mode, opacity: opts.opacity ?? 1, blendIf: opts.blendIf, channels: opts.channels });
    let max = 0;
    for (let i = 0; i < m8.data.length; i++) max = Math.max(max, Math.abs(m8.data[i] - Math.round(d.data[i] / 257)));
    return { d, max };
  };
  // the 0.3 path (no blending options) is left exactly as it was: the plain lerp
  assert.ok(run({ opacity: 0.5 }).max <= 1);
  // a 20-level split over a change of 125 levels: the 8-bit adjusted value is rounded before Blend If reads it, which
  // moves the weight by up to 1/40 there (3 levels); float reads the unrounded value
  assert.ok(run({ opacity: 1, blendIf: blendIfGray([0, 0, 100, 120]) }).max <= 3);
  assert.ok(run({ opacity: 1, blendIf: blendIfGray(undefined, [150, 200, 255, 255]) }).max <= 1);
  assert.ok(run({ opacity: 0.5, channels: { r: false } }).max <= 1);
  assert.ok(run({ opacity: 0.8, mode: 'multiply' }).max <= 1);
  assert.ok(run({ opacity: 1, mode: 'screen' }, 'invert', {}).max <= 1);
  // float keeps more than 256 levels where a split Blend If ramps the change in
  const { d } = run({ opacity: 1, blendIf: blendIfGray(undefined, [100, 200, 255, 255]) });
  const levels = new Set();
  for (let i = 0; i < d.data.length; i += 4) levels.add(d.data[i]);
  assert.ok([...levels].some((v) => v % 257 !== 0));
  // f32 too, and HDR values above 1 read as white for Blend If
  const f = fromCanvasData(img, 'f32');
  f.data[255 * 4] = f.data[255 * 4 + 1] = f.data[255 * 4 + 2] = 2;
  adjustLayerDeep(f, 'invert', {}, { blendIf: blendIfGray(undefined, [0, 0, 200, 200]) });
  assert.equal(f.data[255 * 4], 2); // hidden: the backdrop stays
  assert.ok(Math.abs(f.data[10 * 4] - (1 - 10 / 255)) < 1e-6);
});

test('a mode deep.js cannot blend in float is refused rather than drawn wrong', () => {
  const d = fromCanvasData(ramp(), 'u16');
  assert.throws(() => adjustLayerDeep(d, 'invert', {}, { mode: 'overlay' }), /overlay/);
});

test('Blend If through PSD blending ranges: written, read back, and left out when nothing is hidden', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { writePsdBuffer, readPsd } = require('ag-psd');
  const { blendIfToPsd, blendIfFromPsd } = await import('../../src/renderer/lib/io.js');
  const blendIf = { gray: { this: [0, 0, 180, 220], under: [10, 40, 255, 255] }, r: { this: [0, 0, 255, 255], under: [0, 0, 200, 200] }, g: { this: [5, 5, 255, 255], under: [0, 0, 255, 255] }, b: { this: [0, 0, 255, 255], under: [0, 0, 255, 255] } };
  const ranges = blendIfToPsd(blendIf);
  assert.deepEqual(ranges.compositeGrayBlendSource, [0, 0, 180, 220]);
  assert.deepEqual(ranges.compositeGraphBlendDestinationRange, [10, 40, 255, 255]);
  assert.deepEqual(ranges.ranges[0].destRange, [0, 0, 200, 200]);
  assert.deepEqual(ranges.ranges[1].sourceRange, [5, 5, 255, 255]);
  const buf = writePsdBuffer({ width: 4, height: 4, children: [{ name: 'Curves', fillOpacity: 0.5, adjustment: { type: 'curves', rgb: [{ input: 0, output: 0 }, { input: 255, output: 128 }] }, blendingRanges: ranges }] });
  const back = readPsd(buf, { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true }).children[0];
  assert.deepEqual(blendIfFromPsd(back.blendingRanges), blendIf);
  assert.ok(Math.abs(back.fillOpacity - 0.5) < 0.01);
  assert.equal(blendIfToPsd(null), null);
  assert.equal(blendIfToPsd({ gray: { this: [0, 0, 255, 255], under: [0, 0, 255, 255] } }), null);
  assert.equal(blendIfFromPsd({ compositeGrayBlendSource: [0, 0, 255, 255], compositeGraphBlendDestinationRange: [0, 0, 255, 255], ranges: [] }), null);
  assert.equal(blendIfFromPsd(undefined), null);
});
