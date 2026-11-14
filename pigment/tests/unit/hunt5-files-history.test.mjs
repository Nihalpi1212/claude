// Regression tests from the 0.4 cross-feature hunt, area "files, history": the pure parts. A PSD keeps the colour
// ranges of a Hue/Saturation layer (with their bounds), and reads them back; 0.3's single range is written as that
// range, not as Master.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentToPsd, adjustmentFromPsd } from '../../src/renderer/lib/io.js';
import { DEFAULT_RANGE_BOUNDS } from '../../src/shared/pixels/adjust-color.js';

test('Hue/Saturation colour ranges go to PSD and come back with their bounds', () => {
  const params = {
    hue: 5, saturation: 0, lightness: 0,
    ranges: [
      { base: 'reds', hue: 20, saturation: 10, lightness: 0 },
      { base: 'blues', bounds: [190, 220, 260, 290], hue: -30, saturation: 0, lightness: 5 },
    ],
  };
  const psd = adjustmentToPsd('hue-saturation', params);
  assert.equal(psd.master.hue, 5);
  assert.deepEqual(psd.reds, { a: 315, b: 345, c: 15, d: 45, hue: 20, saturation: 10, lightness: 0 });
  assert.deepEqual(psd.blues, { a: 190, b: 220, c: 260, d: 290, hue: -30, saturation: 0, lightness: 5 });
  // an unused range has its default bounds and changes nothing, as Photoshop writes it
  assert.deepEqual(psd.greens, { a: 75, b: 105, c: 135, d: 165, hue: 0, saturation: 0, lightness: 0 });
  const back = adjustmentFromPsd(psd);
  assert.equal(back.kind, 'hue-saturation');
  assert.equal(back.params.hue, 5);
  assert.deepEqual(back.params.ranges, [
    { base: 'reds', bounds: [315, 345, 15, 45], hue: 20, saturation: 10, lightness: 0 },
    { base: 'blues', bounds: [190, 220, 260, 290], hue: -30, saturation: 0, lightness: 5 },
  ]);
});

test('a 0.3 single-range Hue/Saturation is written as that range; a file with zero bounds reads the defaults', () => {
  const psd = adjustmentToPsd('hue-saturation', { range: 'greens', hue: 10, saturation: -5, lightness: 0 });
  assert.equal(psd.master.hue, 0);
  assert.equal(psd.greens.hue, 10);
  assert.equal(psd.greens.saturation, -5);
  // what Pigment 0.3 wrote: every range record zero, bounds too
  const zero = { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 };
  const old = adjustmentFromPsd({ type: 'hue/saturation', master: { ...zero, hue: 12 }, reds: { ...zero, saturation: 40 }, yellows: zero, greens: zero, cyans: zero, blues: zero, magentas: zero });
  assert.equal(old.params.hue, 12);
  assert.deepEqual(old.params.ranges, [{ base: 'reds', bounds: [...DEFAULT_RANGE_BOUNDS.reds], hue: 0, saturation: 40, lightness: 0 }]);
});
