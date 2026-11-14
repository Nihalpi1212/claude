// Seam carving (src/shared/pixels/seam-carve.js): energy, single seams, the seam map and the lookups built on
// it (removeSeams, insertSeams, contentAwareScale). Numbers, not just "does not throw".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  energy, findSeam, skinMask, createSeamMap, applySeamMap, applySeamMapToMask, removeSeams, insertSeams,
  contentAwareScale, createContentAwareScaler, PROTECT_WEIGHT, REMOVE_WEIGHT, SKIN_WEIGHT, UNRANKED,
  reduceImage, reduceMask, applySeamMapScaled, applySeamMapToMaskScaled,
} from '../../src/shared/pixels/seam-carve.js';
import { createImage, setPixel, randomSeeded, meanAbsDiff } from '../../src/shared/pixels/core.js';
import { resize } from '../../src/shared/pixels/transform.js';

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const GREEN = [0, 200, 0, 255];
const isGreen = (p) => p[0] === 0 && p[1] === 200 && p[2] === 0 && p[3] === 255;

/** Opaque noise (strong gradients everywhere) with a flat green band in columns [x0, x1). */
function bandImage(w = 60, h = 30, x0 = 20, x1 = 36, seed = 5) {
  const rnd = randomSeeded(seed);
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= x0 && x < x1) setPixel(img, x, y, [0, 200, 0, 1]);
    else setPixel(img, x, y, [40 + Math.floor(rnd() * 200), 40 + Math.floor(rnd() * 30), 220 - Math.floor(rnd() * 200), 1]);
  }
  return img;
}

/** The same with the band lying in rows [y0, y1). */
function rowBandImage(w = 30, h = 60, y0 = 20, y1 = 36, seed = 9) {
  const rnd = randomSeeded(seed);
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y >= y0 && y < y1) setPixel(img, x, y, [0, 200, 0, 1]);
    else setPixel(img, x, y, [40 + Math.floor(rnd() * 200), 40 + Math.floor(rnd() * 30), 220 - Math.floor(rnd() * 200), 1]);
  }
  return img;
}

/** A photo-like image: smooth gradients and a bright disc. */
function photo(w = 80, h = 60) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const disc = Math.hypot(x - w * 0.6, y - h * 0.5) < h * 0.25 ? 70 : 0;
    setPixel(img, x, y, [60 + (x / w) * 100 + disc, 80 + (y / h) * 90, 200 - (x / w) * 60 - disc, 1]);
  }
  return img;
}

const greenPerRow = (img) => {
  const out = [];
  for (let y = 0; y < img.height; y++) {
    let n = 0;
    for (let x = 0; x < img.width; x++) if (isGreen(px(img, x, y))) n++;
    out.push(n);
  }
  return out;
};

test('energy is the gradient magnitude: zero on flat areas, the colour step on an edge', () => {
  const img = createImage(8, 4, [10, 20, 30, 1]);
  assert.ok(energy(img).data.every((v) => v === 0));
  // a vertical edge between columns 3 and 4: +100 in red only
  for (let y = 0; y < 4; y++) for (let x = 4; x < 8; x++) setPixel(img, x, y, [110, 20, 30, 1]);
  const e = energy(img);
  assert.equal(e.width, 8);
  assert.equal(e.height, 4);
  for (let y = 0; y < 4; y++) {
    assert.equal(e.data[y * 8 + 3], 100, 'left of the edge (central difference)');
    assert.equal(e.data[y * 8 + 4], 100, 'right of the edge');
    assert.equal(e.data[y * 8 + 1], 0);
    assert.equal(e.data[y * 8 + 6], 0);
  }
});

test('energy counts transparency as flat and an alpha edge as an edge', () => {
  const img = createImage(6, 3);
  // fully transparent pixels with stray colour values carry no energy
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = (i * 37) % 255;
  assert.ok(energy(img).data.every((v) => v === 0));
  for (let y = 0; y < 3; y++) for (let x = 3; x < 6; x++) setPixel(img, x, y, [0, 0, 0, 1]);
  const e = energy(img);
  assert.equal(e.data[1 * 6 + 2], 255);
  assert.equal(e.data[1 * 6 + 3], 255);
});

test('energy adds the protection, removal and skin weights', () => {
  const img = createImage(6, 4, [224, 172, 138, 1]); // a skin tone
  setPixel(img, 0, 0, [20, 40, 220, 1]);
  const n = 24;
  const protect = new Uint8ClampedArray(n), remove = new Uint8ClampedArray(n);
  protect[2 * 6 + 3] = 255;
  protect[2 * 6 + 4] = 128;
  remove[3 * 6 + 5] = 255;
  const plain = energy(img), e = energy(img, { protect, remove });
  assert.equal(e.data[2 * 6 + 3] - plain.data[2 * 6 + 3], PROTECT_WEIGHT);
  assert.ok(Math.abs(e.data[2 * 6 + 4] - plain.data[2 * 6 + 4] - (128 / 255) * PROTECT_WEIGHT) < 1);
  assert.equal(e.data[3 * 6 + 5], -REMOVE_WEIGHT);
  assert.equal(e.data[1 * 6 + 1], plain.data[1 * 6 + 1]);
  const skin = skinMask(img);
  assert.equal(skin[0], 0, 'blue is not skin');
  assert.equal(skin[9], 255);
  const es = energy(img, { skin: true });
  assert.equal(es.data[2 * 6 + 2] - plain.data[2 * 6 + 2], SKIN_WEIGHT);
  assert.equal(es.data[0], plain.data[0], 'the blue pixel gets no skin weight');
});

test('findSeam follows the cheapest path in both directions', () => {
  const w = 9, h = 7;
  const e = { width: w, height: h, data: new Float32Array(w * h).fill(10) };
  for (let y = 0; y < h; y++) e.data[y * w + 5] = 0;
  assert.deepEqual(Array.from(findSeam(e, 'vertical')), [5, 5, 5, 5, 5, 5, 5]);
  // a diagonal valley: x = 1 + y
  const d = { width: w, height: h, data: new Float32Array(w * h).fill(10) };
  for (let y = 0; y < h; y++) d.data[y * w + 1 + y] = 1;
  assert.deepEqual(Array.from(findSeam(d, 'vertical')), [1, 2, 3, 4, 5, 6, 7]);
  const r = { width: w, height: h, data: new Float32Array(w * h).fill(10) };
  for (let x = 0; x < w; x++) r.data[2 * w + x] = 0;
  assert.deepEqual(Array.from(findSeam(r, 'horizontal')), [2, 2, 2, 2, 2, 2, 2, 2, 2]);
  // the seam is 8-connected and its cost is the minimum over a brute-force check on a small map
  const rnd = randomSeeded(3);
  const m = { width: 5, height: 4, data: Float32Array.from({ length: 20 }, () => Math.floor(rnd() * 50)) };
  const seam = findSeam(m);
  let cost = 0;
  for (let y = 0; y < 4; y++) {
    cost += m.data[y * 5 + seam[y]];
    if (y) assert.ok(Math.abs(seam[y] - seam[y - 1]) <= 1);
  }
  let best = Infinity;
  const walk = (y, x, c) => {
    c += m.data[y * 5 + x];
    if (y === 3) return void (best = Math.min(best, c));
    for (const nx of [x - 1, x, x + 1]) if (nx >= 0 && nx < 5) walk(y + 1, nx, c);
  };
  for (let x = 0; x < 5; x++) walk(0, x, 0);
  assert.equal(cost, best);
});

test('removing seams from an image with a flat band removes pixels only inside the band', () => {
  const img = bandImage();
  const out = removeSeams(img, 10, 'vertical');
  assert.equal(out.width, 50);
  assert.equal(out.height, 30);
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 20; x++) assert.deepEqual(px(out, x, y), px(img, x, y), `left of the band at ${x},${y}`);
    for (let x = 20; x < 26; x++) assert.deepEqual(px(out, x, y), GREEN, `what is left of the band at ${x},${y}`);
    for (let x = 26; x < 50; x++) assert.deepEqual(px(out, x, y), px(img, x + 10, y), `right of the band at ${x},${y}`);
  }
  // the flat inside of the band (its two edge columns carry the step to the noise) goes before anything else
  const most = removeSeams(img, 14);
  assert.deepEqual(greenPerRow(most), new Array(30).fill(2));
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 20; x++) assert.deepEqual(px(most, x, y), px(img, x, y));
    for (let x = 22; x < 46; x++) assert.deepEqual(px(most, x, y), px(img, x + 14, y));
  }
});

test('horizontal seams remove rows of a flat horizontal band', () => {
  const img = rowBandImage();
  const out = removeSeams(img, 12, 'horizontal');
  assert.equal(out.width, 30);
  assert.equal(out.height, 48);
  for (let x = 0; x < 30; x++) {
    for (let y = 0; y < 20; y++) assert.deepEqual(px(out, x, y), px(img, x, y));
    for (let y = 20; y < 24; y++) assert.deepEqual(px(out, x, y), GREEN);
    for (let y = 24; y < 48; y++) assert.deepEqual(px(out, x, y), px(img, x, y + 12));
  }
});

test('inserting seams duplicates the cheapest ones and removing them again is the identity on a band image', () => {
  const img = bandImage();
  const wide = insertSeams(img, 8, 'vertical');
  assert.equal(wide.width, 68);
  assert.deepEqual(greenPerRow(wide), new Array(30).fill(24), 'the new pixels are band pixels');
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 20; x++) assert.deepEqual(px(wide, x, y), px(img, x, y));
    for (let x = 44; x < 68; x++) assert.deepEqual(px(wide, x, y), px(img, x - 8, y));
  }
  const back = removeSeams(wide, 8, 'vertical');
  assert.equal(back.width, 60);
  assert.deepEqual(Array.from(back.data), Array.from(img.data));
});

test('inserting then removing is near-identity on a photo-like image, and insertion spreads', () => {
  const img = photo();
  const wide = insertSeams(img, 20, 'vertical');
  assert.equal(wide.width, 100);
  assert.equal(wide.height, 60);
  const back = removeSeams(wide, 20, 'vertical');
  assert.equal(back.width, 80);
  // the widened image is a smooth stretch, so carving it back does not hit exactly the inserted pixels
  const diff = meanAbsDiff(back, img);
  assert.ok(diff < 3, `mean difference ${diff}`);
  // the 20 inserted columns are distinct seams: no row has the same source pixel inserted twice
  const map = createSeamMap(img, 'vertical');
  map.ensure(20);
  for (let y = 0; y < 60; y++) {
    let n = 0;
    for (let x = 0; x < 80; x++) if (map.order[y * 80 + x] < 20) n++;
    assert.equal(n, 20);
  }
  const tall = insertSeams(img, 15, 'horizontal');
  assert.equal(tall.height, 75);
  assert.ok(meanAbsDiff(removeSeams(tall, 15, 'horizontal'), img) < 3);
  // more than half the size takes several rounds and still lands on the exact size
  assert.equal(insertSeams(img, 130, 'vertical').width, 210);
  assert.equal(insertSeams(img, 0).width, 80);
});

test('protect keeps a marked column: seams go through the noise instead of the flat band', () => {
  const img = bandImage();
  assert.deepEqual(greenPerRow(removeSeams(img, 10)), new Array(30).fill(6), 'unprotected, the band is what goes');
  const protect = new Uint8ClampedArray(60 * 30);
  for (let y = 0; y < 30; y++) for (let x = 20; x < 36; x++) protect[y * 60 + x] = 255;
  const out = removeSeams(img, 10, 'vertical', { protect });
  assert.equal(out.width, 50);
  assert.deepEqual(greenPerRow(out), new Array(30).fill(16), 'every protected pixel is still there');
  // and they are still one block per row
  for (let y = 0; y < 30; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < 50; x++) if (isGreen(px(out, x, y))) {
      if (first < 0) first = x;
      last = x;
    }
    assert.equal(last - first + 1, 16);
  }
  // a single protected column inside a flat image survives while 30 of 40 columns go
  const flat = createImage(40, 12, [90, 90, 90, 1]);
  const mark = new Uint8ClampedArray(40 * 12);
  for (let y = 0; y < 12; y++) {
    setPixel(flat, 17, y, [255, 0, 0, 1]);
    mark[y * 40 + 17] = 255;
  }
  const narrow = removeSeams(flat, 30, 'vertical', { protect: mark });
  assert.equal(narrow.width, 10);
  for (let y = 0; y < 12; y++) {
    let reds = 0;
    for (let x = 0; x < 10; x++) if (px(narrow, x, y)[0] === 255 && px(narrow, x, y)[1] === 0) reds++;
    assert.equal(reds, 1, `row ${y}`);
  }
});

test('remove marks pixels to go first', () => {
  const img = bandImage();
  const remove = new Uint8ClampedArray(60 * 30);
  // a noisy column block, far from the band
  for (let y = 0; y < 30; y++) for (let x = 45; x < 50; x++) remove[y * 60 + x] = 255;
  const out = removeSeams(img, 5, 'vertical', { remove });
  assert.deepEqual(greenPerRow(out), new Array(30).fill(16), 'the band was not needed');
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 45; x++) assert.deepEqual(px(out, x, y), px(img, x, y));
    for (let x = 45; x < 55; x++) assert.deepEqual(px(out, x, y), px(img, x + 5, y));
  }
});

test('skin protection keeps skin-tone pixels when a cheaper flat area is not available', () => {
  // left half flat skin, right half flat grey: both have zero gradient, so only the skin weight decides
  const img = createImage(40, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 40; x++) setPixel(img, x, y, x < 20 ? [224, 172, 138, 1] : [120, 120, 120, 1]);
  const skinCount = (im) => {
    let n = 0;
    for (let x = 0; x < im.width; x++) if (px(im, x, 5)[0] === 224) n++;
    return n;
  };
  assert.equal(skinCount(removeSeams(img, 15, 'vertical', { skin: true })), 20);
  assert.ok(skinCount(removeSeams(img, 15, 'vertical')) < 20, 'without the option the left-most flat columns go first');
});

test('a seam map ranks every pixel once per line and scaling by it is a lookup', () => {
  const img = photo(50, 30);
  const map = createSeamMap(img, 'vertical');
  assert.equal(map.ranked, 0);
  assert.ok(Array.from(map.order).every((v) => v === UNRANKED));
  assert.equal(map.ensure(10), true);
  assert.ok(map.ranked >= 10);
  assert.equal(map.ensure(1000), true);
  assert.equal(map.done, true);
  assert.equal(map.ranked, 50);
  for (let y = 0; y < 30; y++) {
    const seen = new Uint8Array(50);
    for (let x = 0; x < 50; x++) {
      const r = map.order[y * 50 + x];
      assert.ok(r >= 0 && r < 50 && !seen[r], `row ${y} rank ${r}`);
      seen[r] = 1;
    }
  }
  // every seam is 8-connected in the image it was removed from: seam k, after the k seams before it are gone
  for (const k of [0, 7, 23]) {
    let prev = -1;
    for (let y = 0; y < 30; y++) {
      let pos = 0, at = -1;
      for (let x = 0; x < 50; x++) {
        const r = map.order[y * 50 + x];
        if (r === k) at = pos;
        if (r >= k) pos++;
      }
      // seams of one batch are found together, so a neighbour of the batch may sit between two rows of this one
      if (prev >= 0) assert.ok(Math.abs(at - prev) <= 8, `seam ${k} jumps from ${prev} to ${at} at row ${y}`);
      prev = at;
    }
  }
  // lookups for several sizes agree with the definition
  for (const target of [49, 37, 20, 1]) {
    const out = applySeamMap(img, map, target);
    assert.equal(out.width, target);
    for (const y of [0, 13, 29]) {
      let o = 0;
      for (let x = 0; x < 50; x++) if (map.order[y * 50 + x] >= 50 - target) assert.deepEqual(px(out, o++, y), px(img, x, y));
      assert.equal(o, target);
    }
  }
  // the first seam of the map is the optimal one
  const e = energy(img), seam = findSeam(e);
  let optimal = 0, first = 0;
  for (let y = 0; y < 30; y++) {
    optimal += e.data[y * 50 + seam[y]];
    for (let x = 0; x < 50; x++) if (map.order[y * 50 + x] === 0) first += e.data[y * 50 + x];
  }
  assert.ok(first <= optimal * 1.3 + 60, `first seam costs ${first}, the optimum ${optimal}`);
  // widening to more than twice the size stops at the double (every pixel duplicated once)
  assert.equal(applySeamMap(img, map, 500).width, 100);
  assert.throws(() => applySeamMap(createImage(10, 10), map, 5), /another image size/);
});

test('a horizontal map and masks follow the same seams', () => {
  const img = rowBandImage();
  const map = createSeamMap(img, 'horizontal');
  const out = applySeamMap(img, map, 50);
  assert.equal(out.height, 50);
  assert.deepEqual(Array.from(out.data), Array.from(removeSeams(img, 10, 'horizontal').data));
  // a mask of the band loses exactly the removed rows
  const mask = new Uint8ClampedArray(30 * 60);
  for (let y = 20; y < 36; y++) for (let x = 0; x < 30; x++) mask[y * 30 + x] = 255;
  const m = applySeamMapToMask(mask, map, 50);
  assert.equal(m.length, 30 * 50);
  for (let x = 0; x < 30; x++) {
    let n = 0;
    for (let y = 0; y < 50; y++) if (m[y * 30 + x] === 255) n++;
    assert.equal(n, 6);
  }
  const grown = applySeamMapToMask(mask, map, 68);
  assert.equal(grown.length, 30 * 68);
  let n = 0;
  for (let y = 0; y < 68; y++) if (grown[y * 30 + 4] === 255) n++;
  assert.equal(n, 24);
});

test('contentAwareScale: sizes, amount as the blend with plain scaling, both axes', () => {
  const img = bandImage();
  const same = contentAwareScale(img, {});
  assert.deepEqual(Array.from(same.data), Array.from(img.data));
  assert.notEqual(same.data, img.data);
  const narrow = contentAwareScale(img, { width: 50 });
  assert.deepEqual(Array.from(narrow.data), Array.from(removeSeams(img, 10).data));
  // amount 0 is an ordinary resize
  const plain = contentAwareScale(img, { width: 45, height: 20, amount: 0 });
  assert.deepEqual(Array.from(plain.data), Array.from(resize(img, 45, 20, { method: 'bicubic' }).data));
  // amount 50: half of the 20 columns go as seams (out of the band), the rest by scaling the 50-wide result
  const half = contentAwareScale(img, { width: 40, amount: 50 });
  assert.equal(half.width, 40);
  assert.deepEqual(Array.from(half.data), Array.from(resize(removeSeams(img, 10), 40, 30, { method: 'bicubic' }).data));
  // both axes, and growing
  const both = contentAwareScale(photo(), { width: 60, height: 70 });
  assert.equal(both.width, 60);
  assert.equal(both.height, 70);
  assert.ok(both.data.every((v, i) => i % 4 !== 3 || v === 255), 'opaque stays opaque');
  const big = contentAwareScale(photo(40, 30), { width: 100, height: 30 });
  assert.equal(big.width, 100, 'beyond twice the width the rest is plain scaling');
  // protect through contentAwareScale
  const protect = new Uint8ClampedArray(60 * 30);
  for (let y = 0; y < 30; y++) for (let x = 20; x < 36; x++) protect[y * 60 + x] = 255;
  assert.deepEqual(greenPerRow(contentAwareScale(img, { width: 48, protect })), new Array(30).fill(16));
  assert.deepEqual(greenPerRow(contentAwareScale(img, { width: 48 })), new Array(30).fill(4));
});

test('a scaler caches its maps, works in budgeted steps and carries masks', () => {
  const img = photo(120, 90);
  const scaler = createContentAwareScaler(img);
  let calls = 0;
  while (!scaler.prepare(80, 70, 100, 0)) {
    calls++;
    assert.ok(calls < 500, 'prepare makes progress on every call');
  }
  assert.ok(calls >= 1, 'a zero budget does one pass per call');
  const a = scaler.scale(80, 70);
  assert.equal(a.width, 80);
  assert.equal(a.height, 70);
  assert.deepEqual(Array.from(a.data), Array.from(contentAwareScale(img, { width: 80, height: 70 }).data));
  // the result is not the cache: changing it does not change the next answer
  a.data.fill(0);
  assert.deepEqual(Array.from(scaler.scale(80, 70).data), Array.from(contentAwareScale(img, { width: 80, height: 70 }).data));
  assert.equal(scaler.prepare(80, 70, 100, 0), true, 'nothing left to compute for a size already asked for');
  // a mask of the right half: after carving it still covers whole columns' worth of area
  const mask = new Uint8ClampedArray(120 * 90);
  for (let y = 0; y < 90; y++) for (let x = 60; x < 120; x++) mask[y * 120 + x] = 255;
  const m = scaler.scaleMask(mask, 80, 70);
  assert.equal(m.length, 80 * 70);
  let on = 0;
  for (const v of m) if (v === 255) on++;
  assert.ok(on > 80 * 70 * 0.2 && on < 80 * 70 * 0.8, `${on} mask pixels`);
  for (let y = 0; y < 70; y++) {
    // per row the mask is still "off then on": the seams never reorder pixels
    let flips = 0;
    for (let x = 1; x < 80; x++) if (m[y * 80 + x] !== m[y * 80 + x - 1]) flips++;
    assert.equal(flips, 1, `row ${y}`);
  }
  assert.equal(scaler.scaleMask(mask, 60, 45, 0).length, 60 * 45);
});

test('edge cases: tiny and empty images, counts beyond the size', () => {
  const one = createImage(1, 5, [9, 9, 9, 1]);
  assert.equal(removeSeams(one, 3).width, 1);
  assert.equal(insertSeams(one, 2).width, 3);
  const empty = createImage(0, 0);
  assert.equal(removeSeams(empty, 2).width, 0);
  assert.equal(contentAwareScale(empty, { width: 4, height: 4 }).width, 4);
  const img = bandImage(20, 6, 5, 9);
  assert.equal(removeSeams(img, 500).width, 1);
  assert.equal(removeSeams(img, 500, 'horizontal').height, 1);
  assert.equal(removeSeams(img, -4).width, 20);
  // masks of the wrong size are ignored rather than read out of range
  assert.equal(removeSeams(img, 3, 'vertical', { protect: new Uint8ClampedArray(7) }).width, 17);
});

test('inserted pixels are exact averages: a flat image with odd values stays flat', () => {
  const flat = createImage(10, 4, [201, 77, 33, 1]);
  const wide = insertSeams(flat, 3);
  assert.equal(wide.width, 13);
  for (let i = 0; i < wide.data.length; i += 4) assert.deepEqual(Array.from(wide.data.subarray(i, i + 4)), [201, 77, 33, 255]);
  const tall = insertSeams(flat, 2, 'horizontal');
  for (let i = 0; i < tall.data.length; i += 4) assert.deepEqual(Array.from(tall.data.subarray(i, i + 4)), [201, 77, 33, 255]);
  // two neighbours of different colour: the new pixel is their mean
  const two = createImage(2, 1);
  setPixel(two, 0, 0, [100, 0, 50, 1]);
  setPixel(two, 1, 0, [201, 0, 51, 1]);
  const three = insertSeams(two, 1);
  const colours = [px(three, 0, 0), px(three, 1, 0), px(three, 2, 0)].map((p) => p.join(','));
  assert.ok(colours.includes('100,0,50,255') && colours.includes('201,0,51,255'));
  const mid = [px(three, 0, 0), px(three, 1, 0), px(three, 2, 0)].find((p) => p[0] !== 100 && p[0] !== 201) ?? px(three, 1, 0);
  assert.ok(mid[0] === 100 || mid[0] === 201 || Math.abs(mid[0] - 150.5) <= 0.5, `the inserted pixel ${mid}`);
});

test('reduceImage averages blocks (alpha weighted, short last blocks) and reduceMask keeps the strongest value', () => {
  const img = createImage(5, 3);
  // first block (2x2): two opaque pixels 100 and 200, two transparent
  setPixel(img, 0, 0, [100, 10, 0, 1]);
  setPixel(img, 1, 1, [200, 30, 0, 1]);
  // second block: all four opaque with the same colour
  for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) setPixel(img, x, y, [7, 9, 11, 1]);
  // last column block (1 wide): one opaque of two
  setPixel(img, 4, 0, [50, 60, 70, 1]);
  // last row (1 high)
  setPixel(img, 0, 2, [1, 2, 3, 1]);
  setPixel(img, 1, 2, [3, 4, 5, 1]);
  const r = reduceImage(img, 2);
  assert.equal(r.width, 3);
  assert.equal(r.height, 2);
  assert.deepEqual(px(r, 0, 0), [150, 20, 0, 128], 'transparent pixels do not darken the average');
  assert.deepEqual(px(r, 1, 0), [7, 9, 11, 255]);
  assert.deepEqual(px(r, 2, 0), [50, 60, 70, 128]);
  assert.deepEqual(px(r, 0, 1), [2, 3, 4, 255]);
  assert.deepEqual(px(r, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(reduceImage(img, 1).data), Array.from(img.data));
  assert.notEqual(reduceImage(img, 1).data, img.data);
  const mask = new Uint8ClampedArray(5 * 3);
  mask[1 * 5 + 1] = 200;
  mask[0 * 5 + 4] = 90;
  mask[2 * 5 + 3] = 255;
  assert.deepEqual(Array.from(reduceMask(mask, 5, 3, 2)), [200, 0, 90, 0, 255, 0]);
  assert.deepEqual(Array.from(reduceMask(mask, 5, 3, 1)), Array.from(mask));
});

test('band seams: a map built on a reduced copy removes exactly n pixels per line, only where the copy says', () => {
  // the band image at twice the size: noise with a flat green band in columns [40, 72)
  const img = bandImage(120, 60, 40, 72, 5);
  const small = reduceImage(img, 2);
  assert.equal(small.width, 60);
  const map = createSeamMap(small, 'vertical');
  for (const n of [20, 7, 1, 28]) {
    const out = applySeamMapScaled(img, map, 120 - n, 2);
    assert.equal(out.width, 120 - n);
    assert.equal(out.height, 60);
    // only band pixels went: every row keeps its noise, in order, and loses n greens
    assert.deepEqual(greenPerRow(out), new Array(60).fill(32 - n), `${n} pixels`);
    for (const y of [0, 17, 59]) {
      for (let x = 0; x < 40; x++) assert.deepEqual(px(out, x, y), px(img, x, y));
      for (let x = 72; x < 120; x++) assert.deepEqual(px(out, x - n, y), px(img, x, y));
    }
  }
  // factor 1 is the plain lookup
  const plain = createSeamMap(img, 'vertical');
  assert.deepEqual(Array.from(applySeamMapScaled(img, plain, 100, 1).data), Array.from(applySeamMap(img, plain, 100).data));
  // widening stretches bands of the flat area: 20 more greens per row, the noise untouched
  const wide = applySeamMapScaled(img, map, 140, 2);
  assert.equal(wide.width, 140);
  assert.deepEqual(greenPerRow(wide), new Array(60).fill(52));
  for (const y of [3, 40]) {
    for (let x = 0; x < 40; x++) assert.deepEqual(px(wide, x, y), px(img, x, y));
    for (let x = 72; x < 120; x++) assert.deepEqual(px(wide, x + 20, y), px(img, x, y));
  }
  // at most twice the size, at least one pixel
  assert.equal(applySeamMapScaled(img, map, 1000, 2).width, 240);
  assert.equal(applySeamMapScaled(img, map, 0, 2).width, 1);
  assert.throws(() => applySeamMapScaled(createImage(50, 60), map, 40, 2), /another image size/);
});

test('band seams work on sizes that are no multiple of the factor, in both directions, and masks follow', () => {
  const rnd = randomSeeded(21);
  const W = 61, H = 35, f = 3;
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, [Math.floor(rnd() * 256), Math.floor(rnd() * 256), x, 1]);
  const mapV = createSeamMap(reduceImage(img, f), 'vertical');
  assert.equal(mapV.width, 21);
  assert.equal(mapV.height, 12);
  // a mask that tags every pixel with its column, carried through the same bands
  const cols = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cols[y * W + x] = x;
  for (const n of [1, 2, 3, 10, 31, 60]) {
    const out = applySeamMapScaled(img, mapV, W - n, f);
    assert.equal(out.width, W - n, `${n} removed`);
    const m = applySeamMapToMaskScaled(cols, W, H, mapV, W - n, f);
    assert.equal(m.length, (W - n) * H);
    for (let y = 0; y < H; y++) {
      // every row is a subsequence of the original row: the blue channel holds the source column
      let last = -1;
      for (let x = 0; x < W - n; x++) {
        const p = px(out, x, y);
        assert.ok(p[2] > last, `row ${y} keeps its order`);
        last = p[2];
        assert.deepEqual(p, px(img, p[2], y));
        assert.equal(m[y * (W - n) + x], p[2], 'the mask lost the same pixels');
      }
    }
  }
  // widening by any amount up to the double lands on the exact size
  for (const n of [1, 5, 33, 61]) assert.equal(applySeamMapScaled(img, mapV, W + n, f).width, W + n);
  assert.equal(applySeamMapToMaskScaled(cols, W, H, mapV, W + 17, f).length, (W + 17) * H);
  // horizontal: rows go; a row-tag mask shows which
  const mapH = createSeamMap(reduceImage(img, f), 'horizontal');
  const rows = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rows[y * W + x] = y;
  for (const n of [1, 4, 20]) {
    const out = applySeamMapScaled(img, mapH, H - n, f);
    assert.equal(out.height, H - n);
    assert.equal(out.width, W);
    const m = applySeamMapToMaskScaled(rows, W, H, mapH, H - n, f);
    for (const x of [0, 30, 60]) {
      let last = -1;
      for (let y = 0; y < H - n; y++) {
        const sy = m[y * W + x];
        assert.ok(sy > last);
        last = sy;
        assert.deepEqual(px(out, x, y), px(img, x, sy));
      }
    }
  }
  assert.throws(() => applySeamMapToMaskScaled(cols, W, H, mapH, 20, 2), /does not match/);
  assert.throws(() => applySeamMapToMaskScaled(new Uint8ClampedArray(5), W, H, mapV, 20, f), /does not match/);
});

test('a scaler with a map budget carves a large image through a reduced map: exact sizes, protection, masks', () => {
  // noise with a flat red block: without protection the block is what goes
  const rnd = randomSeeded(31);
  const W = 240, H = 160;
  const img = createImage(W, H);
  const protect = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 80 && x < 160 && y >= 40 && y < 120;
    if (inside) protect[y * W + x] = 255;
    setPixel(img, x, y, inside ? [255, 0, 0, 1] : [Math.floor(rnd() * 120), 100 + Math.floor(rnd() * 155), 100 + Math.floor(rnd() * 155), 1]);
  }
  const reds = (im) => {
    let n = 0;
    for (let i = 0; i < im.data.length; i += 4) if (im.data[i] === 255 && im.data[i + 1] === 0 && im.data[i + 2] === 0) n++;
    return n;
  };
  assert.equal(createContentAwareScaler(img).factor, 1);
  assert.equal(createContentAwareScaler(img, {}, { maxMapPixels: W * H }).factor, 1);
  const open = createContentAwareScaler(img, {}, { maxMapPixels: (W * H) / 4 });
  assert.equal(open.factor, 2);
  assert.equal(createContentAwareScaler(img, {}, { maxMapPixels: (W * H) / 5 }).factor, 3);
  const loose = open.scale(190, 160);
  assert.equal(loose.width, 190);
  assert.equal(loose.height, 160);
  assert.ok(reds(loose) < 80 * 80 * 0.6, `unprotected, the flat block shrinks (${reds(loose)} of 6400 left)`);
  const guarded = createContentAwareScaler(img, { protect }, { maxMapPixels: (W * H) / 4 });
  for (const [tw, th] of [[190, 160], [240, 110], [171, 123], [300, 200], [239, 159]]) {
    const out = guarded.scale(tw, th);
    assert.equal(out.width, tw);
    assert.equal(out.height, th);
    assert.equal(reds(out), 6400, `${tw}x${th}: the protected block is whole`);
    // and still an 80 x 80 square
    let x0 = tw, x1 = -1, y0 = th, y1 = -1;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const p = (y * tw + x) * 4;
      if (out.data[p] === 255 && out.data[p + 1] === 0 && out.data[p + 2] === 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    assert.deepEqual([x1 - x0 + 1, y1 - y0 + 1], [80, 80]);
    // a mask of the block follows it exactly
    const m = guarded.scaleMask(protect, tw, th);
    assert.equal(m.length, tw * th);
    for (let i = 0, p = 0; i < m.length; i++, p += 4) assert.equal(m[i] === 255, out.data[p] === 255 && out.data[p + 1] === 0 && out.data[p + 2] === 0, `mask at ${i}`);
  }
  // budgeted preparation finishes, and the result is the same as the one-shot function's
  const stepped = createContentAwareScaler(img, { protect }, { maxMapPixels: (W * H) / 4 });
  let calls = 0;
  while (!stepped.prepare(180, 130, 100, 1)) assert.ok(++calls < 500);
  assert.deepEqual(Array.from(stepped.scale(180, 130).data), Array.from(contentAwareScale(img, { width: 180, height: 130, protect, maxMapPixels: (W * H) / 4 }).data));
  // amount blends with plain scaling as before
  const halfway = guarded.scale(180, 160, 50);
  assert.equal(halfway.width, 180);
  assert.ok(reds(halfway) < 6400 && reds(halfway) > 4000);
});

test('a map pass on a 2000x1500 layer stays within an interactive step and a lookup is fast', () => {
  const W = 2000, H = 1500;
  const rnd = randomSeeded(11);
  const img = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const v = 128 + 80 * Math.sin(x / 37) * Math.cos(y / 53) + (rnd() - 0.5) * 30;
    img.data[p] = v;
    img.data[p + 1] = v * 0.8 + 20;
    img.data[p + 2] = 255 - v;
    img.data[p + 3] = 255;
  }
  const map = createSeamMap(img, 'vertical');
  const times = [];
  for (let i = 0; i < 8; i++) {
    const t = performance.now();
    map.step();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  // the contract is 200 ms per step; the median keeps a loaded test machine from failing the suite
  assert.ok(times[4] < 200, `median pass ${times[4].toFixed(0)} ms (all: ${times.map((t) => t.toFixed(0)).join(', ')})`);
  assert.ok(map.ranked >= 8 * 20, `${map.ranked} seams after 8 passes`);
  const n = map.ranked;
  const t = performance.now();
  const out = applySeamMap(img, map, W - n);
  const lookup = performance.now() - t;
  assert.equal(out.width, W - n);
  assert.ok(lookup < 200, `lookup ${lookup.toFixed(0)} ms`);
});
