// Image registration (FAST, rotated BRIEF, matching, RANSAC, alignImages), Auto-Blend's seam and gain maths,
// and the stack modes: numbers on synthetic images with a known answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage, cropImage, randomSeeded } from '../../src/shared/pixels/core.js';
import { perspective, homography as homographyFrom4 } from '../../src/shared/pixels/transform.js';
import * as R from '../../src/shared/pixels/register.js';
import { stackImages, STACK_MODE_IDS } from '../../src/shared/pixels/stack.js';

/** A busy synthetic scene: a few hundred random opaque rectangles (plenty of right-angled corners). */
function scene(width, height, seed = 7, count = 260) {
  const rnd = randomSeeded(seed);
  const img = createImage(width, height, [120, 120, 120, 1]);
  const d = img.data;
  for (let k = 0; k < count; k++) {
    const w = 6 + Math.floor(rnd() * 40), h = 6 + Math.floor(rnd() * 40);
    const x0 = Math.floor(rnd() * (width - w)), y0 = Math.floor(rnd() * (height - h));
    const r = Math.floor(rnd() * 256), g = Math.floor(rnd() * 256), b = Math.floor(rnd() * 256);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  }
  return img;
}

const crop = (img, x, y, w, h) => cropImage(img, { x, y, width: w, height: h });

test('FAST finds the corners of the squares of a synthetic board and nothing on its straight edges', () => {
  // dark squares on a light ground, like the dark fields of a checkerboard pulled apart
  const size = 20, pitch = 40, n = 3, W = 150, H = 150;
  const img = createImage(W, H, [230, 230, 230, 1]);
  const truth = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x0 = 20 + i * pitch, y0 = 20 + j * pitch;
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) img.data.set([20, 20, 20, 255], (y * W + x) * 4);
    truth.push([x0, y0], [x0 + size - 1, y0], [x0, y0 + size - 1], [x0 + size - 1, y0 + size - 1]);
  }
  const corners = R.fastCorners(img, { threshold: 40, nonmax: true });
  assert.equal(truth.length, 36);
  for (const [tx, ty] of truth) {
    const near = corners.filter((c) => Math.hypot(c.x - tx, c.y - ty) <= 1.5);
    assert.ok(near.length >= 1, `corner at ${tx},${ty} was not found`);
  }
  for (const c of corners) {
    const dist = Math.min(...truth.map(([tx, ty]) => Math.hypot(c.x - tx, c.y - ty)));
    assert.ok(dist <= 2.5, `a corner was reported at ${c.x},${c.y}, ${dist.toFixed(1)} px from any real one`);
    assert.ok(c.score > 0);
  }
  // non-maximum suppression thins the clusters: without it there are more responses, all still at the corners
  const all = R.fastCorners(img, { threshold: 40, nonmax: false });
  assert.ok(all.length > corners.length);
  assert.ok(corners.length >= 36 && corners.length <= 72, `${corners.length} corners after suppression`);
  // a flat image and a straight edge have none
  assert.equal(R.fastCorners(createImage(40, 40, [90, 90, 90, 1])).length, 0);
  const edge = createImage(40, 40, [200, 200, 200, 1]);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) edge.data.set([10, 10, 10, 255], (y * 40 + x) * 4);
  assert.equal(R.fastCorners(edge, { threshold: 30 }).length, 0);
  // the X junction of a true checkerboard is not a FAST corner (two bright and two dark arcs of four pixels)
  const board = createImage(60, 60);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) board.data.set(((x >= 30) ^ (y >= 30)) ? [20, 20, 20, 255] : [230, 230, 230, 255], (y * 60 + x) * 4);
  assert.equal(R.fastCorners(board, { threshold: 40 }).filter((c) => Math.hypot(c.x - 29.5, c.y - 29.5) < 6).length, 0);
});

test('ORB descriptors match a translated copy with more than 90% inliers', () => {
  const big = scene(420, 320, 11);
  const dx = 37, dy = -21; // b shows the scene shifted: a point at (x, y) in a is at (x - dx, y - dy) in b
  const a = crop(big, 20, 40, 300, 240), b = crop(big, 20 + dx, 40 + dy, 300, 240);
  const fa = R.detectFeatures(a), fb = R.detectFeatures(b);
  assert.ok(fa.count > 200 && fb.count > 200, `features: ${fa.count}, ${fb.count}`);
  assert.equal(fa.descriptors.length, fa.count * 8);
  const matches = R.matchDescriptors(fa, fb);
  assert.ok(matches.length > 100, `${matches.length} matches`);
  const pts = R.matchedPoints(fa, fb, matches);
  const good = pts.filter((p) => Math.hypot(p.x2 - p.x1 + dx, p.y2 - p.y1 + dy) <= 1.5).length;
  assert.ok(good / pts.length > 0.9, `${good} of ${pts.length} matches agree with the shift`);
  // the ratio test and the cross check are what keep the outliers out: without them there are more, worse matches
  const loose = R.matchDescriptors(fa, fb, { ratio: 1.01, crossCheck: false, maxDistance: 256 });
  assert.ok(loose.length > matches.length);
  // matching is symmetric under the cross check
  const back = R.matchDescriptors(fb, fa);
  assert.ok(Math.abs(back.length - matches.length) <= matches.length * 0.1);
  // upright BRIEF on single-level corners agrees too
  const ga = R.toGray(a), gb = R.toGray(b);
  const ba = R.briefDescriptors(ga, R.fastCorners(ga, { border: R.ORB_BORDER })), bb = R.briefDescriptors(gb, R.fastCorners(gb, { border: R.ORB_BORDER }));
  const bm = R.matchedPoints(ba, bb, R.matchDescriptors(ba, bb));
  assert.ok(bm.length > 80);
  assert.ok(bm.filter((p) => p.x2 - p.x1 === -dx && p.y2 - p.y1 === -dy).length / bm.length > 0.9);
});

test('rotated BRIEF survives a rotation that upright BRIEF does not', () => {
  const big = scene(360, 360, 5);
  // rotate by 30° about the centre with the pure perspective resampler (an affine quad)
  const ang = (30 * Math.PI) / 180, c = 180;
  const rot = ([x, y]) => [c + (x - c) * Math.cos(ang) - (y - c) * Math.sin(ang), c + (x - c) * Math.sin(ang) + (y - c) * Math.cos(ang)];
  const quad = [[0, 0], [360, 0], [360, 360], [0, 360]];
  const turned = perspective(big, quad, quad.map(rot), { x: 0, y: 0, width: 360, height: 360 });
  const fa = R.detectFeatures(big, { levels: 1 }), fb = R.detectFeatures(turned, { levels: 1 });
  const pts = R.matchedPoints(fa, fb, R.matchDescriptors(fa, fb));
  const ok = pts.filter((p) => {
    const [x, y] = rot([p.x1 + 0.5, p.y1 + 0.5]);
    return Math.hypot(x - 0.5 - p.x2, y - 0.5 - p.y2) <= 2.5;
  }).length;
  assert.ok(ok >= 60 && ok / pts.length > 0.8, `oriented: ${ok} of ${pts.length}`);
  const ua = R.detectFeatures(big, { levels: 1, rotate: false }), ub = R.detectFeatures(turned, { levels: 1, rotate: false });
  const upts = R.matchedPoints(ua, ub, R.matchDescriptors(ua, ub));
  const uok = upts.filter((p) => {
    const [x, y] = rot([p.x1 + 0.5, p.y1 + 0.5]);
    return Math.hypot(x - 0.5 - p.x2, y - 0.5 - p.y2) <= 2.5;
  }).length;
  assert.ok(uok < ok / 3, `upright BRIEF matched ${uok} against ${ok}`);
});

/** Point pairs under a model with noise and a share of gross outliers. */
function syntheticPairs(map, { count = 300, outliers = 0.35, noise = 0.25, seed = 3, w = 800, h = 600 } = {}) {
  const rnd = randomSeeded(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const pairs = [];
  for (let k = 0; k < count; k++) {
    const x1 = rnd() * w, y1 = rnd() * h;
    if (rnd() < outliers) pairs.push({ x1, y1, x2: rnd() * w, y2: rnd() * h, outlier: true });
    else {
      const [x2, y2] = map(x1, y1);
      pairs.push({ x1, y1, x2: x2 + gauss() * noise, y2: y2 + gauss() * noise, outlier: false });
    }
  }
  return pairs;
}

test('RANSAC recovers a known homography within 0.5 px at the corners', () => {
  const H = homographyFrom4([[0, 0], [800, 0], [800, 600], [0, 600]], [[30, 12], [770, -20], [820, 640], [-25, 580]]);
  const pairs = syntheticPairs((x, y) => R.applyH(H, x, y));
  const fit = R.ransacHomography(pairs, { threshold: 2 });
  assert.ok(fit.H, 'a model was found');
  assert.ok(Math.abs(fit.H[8] - 1) < 1e-9);
  for (const [x, y] of [[0, 0], [800, 0], [800, 600], [0, 600], [400, 300]]) {
    const [ex, ey] = R.applyH(H, x, y), [ax, ay] = R.applyH(fit.H, x, y);
    assert.ok(Math.hypot(ex - ax, ey - ay) < 0.5, `corner ${x},${y} is off by ${Math.hypot(ex - ax, ey - ay).toFixed(3)} px`);
  }
  // the consensus set is the true inliers: no outlier slipped in, nearly every inlier is there
  const truth = pairs.filter((p) => !p.outlier).length;
  assert.ok(fit.inliers.every((k) => !pairs[k].outlier));
  assert.ok(fit.inliers.length >= truth * 0.97, `${fit.inliers.length} of ${truth} inliers`);
  // deterministic for a seed
  assert.deepEqual(R.ransacHomography(pairs, { threshold: 2 }).H, fit.H);
  // too few pairs: no model
  assert.equal(R.ransacHomography(pairs.slice(0, 3)).H, null);
  // the inverse maps back
  const inv = R.invert3(fit.H);
  const [bx, by] = R.applyH(inv, ...R.applyH(fit.H, 123, 456));
  assert.ok(Math.hypot(bx - 123, by - 456) < 1e-6);
});

test('RANSAC affine, similarity and translation recover their models among outliers', () => {
  const M = [1.05, 0.08, -0.12, 0.97, 14.5, -7.25];
  const affine = R.ransacAffine(syntheticPairs((x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]), { threshold: 2 });
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(affine.matrix[i] - M[i]) < 2e-3, `affine ${i}: ${affine.matrix[i]}`);
  assert.ok(Math.abs(affine.matrix[4] - M[4]) < 0.3 && Math.abs(affine.matrix[5] - M[5]) < 0.3);

  const ang = 0.2, s = 1.1;
  const S = [s * Math.cos(ang), s * Math.sin(ang), -s * Math.sin(ang), s * Math.cos(ang), -30, 55];
  const sim = R.ransacSimilarity(syntheticPairs((x, y) => [S[0] * x + S[2] * y + S[4], S[1] * x + S[3] * y + S[5]], { outliers: 0.5 }), { threshold: 2 });
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(sim.matrix[i] - S[i]) < 2e-3, `similarity ${i}: ${sim.matrix[i]}`);
  assert.ok(Math.abs(sim.matrix[4] - S[4]) < 0.4 && Math.abs(sim.matrix[5] - S[5]) < 0.4);
  // a similarity has equal scales and a right angle
  assert.ok(Math.abs(sim.matrix[0] - sim.matrix[3]) < 1e-9 && Math.abs(sim.matrix[1] + sim.matrix[2]) < 1e-9);

  const tr = R.ransacTranslation(syntheticPairs((x, y) => [x + 41.25, y - 17.5], { outliers: 0.6 }), { threshold: 1.5 });
  assert.ok(Math.abs(tr.dx - 41.25) < 0.1 && Math.abs(tr.dy + 17.5) < 0.1, `translation ${tr.dx}, ${tr.dy}`);
  assert.ok(tr.inliers.length > 100);
});

test('alignImages of three shifted crops of one image returns the shifts within 1 px', () => {
  const big = scene(640, 420, 21, 420);
  const origins = [[10, 60], [130, 40], [260, 75]]; // top-left of each crop in the scene
  const crops = origins.map(([x, y]) => crop(big, x, y, 300, 260));
  const result = R.alignImages(crops);
  assert.equal(result.length, 3);
  assert.equal(result.projection, 'reposition'); // Auto: pure shifts need no resampling
  assert.equal(result.reference, 1); // the middle image
  const [rx, ry] = origins[result.reference];
  result.forEach((t, i) => {
    assert.ok(t.matched, `image ${i} was registered`);
    assert.ok(t.matrix, 'a translation is an affine matrix');
    const ex = origins[i][0] - rx, ey = origins[i][1] - ry;
    assert.ok(Math.abs(t.matrix[4] - ex) <= 1 && Math.abs(t.matrix[5] - ey) <= 1, `image ${i}: ${t.matrix[4].toFixed(2)}, ${t.matrix[5].toFixed(2)} for ${ex}, ${ey}`);
    assert.ok(Math.abs(t.matrix[0] - 1) < 1e-9 && Math.abs(t.matrix[1]) < 1e-9 && Math.abs(t.matrix[2]) < 1e-9 && Math.abs(t.matrix[3] - 1) < 1e-9);
    assert.ok(Math.abs(t.bounds.x - ex) <= 1 && Math.abs(t.bounds.y - ey) <= 1 && Math.abs(t.bounds.width - 300) <= 1 && Math.abs(t.bounds.height - 260) <= 1);
  });
  assert.ok(Math.abs(result.bounds.x - (origins[0][0] - rx)) <= 1 && Math.abs(result.bounds.width - (250 + 300)) <= 2);
  // an explicit reference: everything is measured from it
  const first = R.alignImages(crops, { reference: 0, projection: 'reposition' });
  assert.equal(first.reference, 0);
  assert.ok(Math.abs(first[2].matrix[4] - 250) <= 1 && Math.abs(first[2].matrix[5] - 15) <= 1);
  // images 0 and 2 overlap by only 50 px: whichever pairs matched, the chain through the middle image places both
  assert.ok(result.pairs.length >= 2);
  // rendering the alignment puts the same scene pixel in the same place
  const rect = { x: 0, y: 0, width: 300, height: 260 };
  const moved = R.applyAlignment(crops[0], result[0], rect);
  let diff = 0, count = 0;
  for (let y = 20; y < 240; y += 3) for (let x = 0; x < 300; x += 3) {
    const i = (y * 300 + x) * 4;
    if (moved.data[i + 3] !== 255) continue;
    diff += Math.abs(moved.data[i] - crops[1].data[i]) + Math.abs(moved.data[i + 1] - crops[1].data[i + 1]) + Math.abs(moved.data[i + 2] - crops[1].data[i + 2]);
    count++;
  }
  assert.ok(count > 1000 && diff / (count * 3) < 3, `mean difference ${(diff / (count * 3)).toFixed(2)} over ${count} pixels`);
});

test('alignImages chains through a middle image, reports unmatched images and honours the projection', () => {
  const big = scene(900, 300, 33, 520);
  // 0 and 2 do not overlap at all: 2 can only be placed through 1
  const crops = [crop(big, 0, 20, 300, 240), crop(big, 200, 30, 300, 240), crop(big, 400, 10, 300, 240)];
  const r = R.alignImages(crops, { projection: 'reposition' });
  assert.equal(r.reference, 1);
  assert.ok(r.every((t) => t.matched));
  assert.ok(Math.abs(r[0].matrix[4] + 200) <= 1 && Math.abs(r[0].matrix[5] + 10) <= 1);
  assert.ok(Math.abs(r[2].matrix[4] - 200) <= 1 && Math.abs(r[2].matrix[5] + 20) <= 1);
  const chained = R.alignImages(crops, { projection: 'reposition', reference: 0 });
  assert.equal(chained[2].parent, 1);
  assert.ok(Math.abs(chained[2].matrix[4] - 400) <= 1.5 && Math.abs(chained[2].matrix[5] + 10) <= 1.5);
  // an unrelated image stays where it is and says so
  const alien = R.alignImages([crops[0], crops[1], scene(300, 240, 999)], { projection: 'reposition', reference: 0 });
  assert.equal(alien[2].matched, false);
  assert.deepEqual(alien[2].homography, R.IDENTITY3);
  assert.ok(alien[1].matched);
  // collage (similarity) and perspective find the same shift on shifted images
  for (const projection of ['collage', 'perspective']) {
    const p = R.alignImages(crops.slice(0, 2), { projection, reference: 0 });
    assert.equal(p.projection, projection);
    const [x, y] = R.applyH(p[1].homography, 150, 120);
    assert.ok(Math.hypot(x - 350, y - 130) < 1.5, `${projection}: ${x.toFixed(2)}, ${y.toFixed(2)}`);
    assert.equal(!!p[1].matrix, projection === 'collage');
  }
});

test('the phases of alignImages (features, pairs, solve) give the same answer when run one by one', () => {
  // every pair for a few images; only neighbours in shooting order for many
  assert.deepEqual(R.candidatePairs(3), [[0, 1], [0, 2], [1, 2]]);
  assert.equal(R.candidatePairs(12).length, 66);
  const many = R.candidatePairs(20);
  assert.equal(many.length, 16 * 4 + 3 + 2 + 1);
  assert.ok(many.every(([a, b]) => a < b && b - a <= 4));
  assert.deepEqual(R.candidatePairs(1), []);

  const big = scene(640, 420, 21, 420);
  const origins = [[10, 60], [130, 40], [260, 75]];
  const crops = origins.map(([x, y]) => crop(big, x, y, 300, 260));
  const feats = crops.map((c) => R.detectFeatures(c));
  const edges = [];
  for (const [a, b] of R.candidatePairs(3)) {
    const e = R.registerPair(feats[a], feats[b]);
    if (e) edges.push({ a, b, ...e });
  }
  // the neighbours share 180 px and are found as pure shifts
  const e01 = edges.find((e) => e.a === 0 && e.b === 1);
  assert.ok(e01 && e01.matches > 50 && e01.T.inliers.length > 0.9 * e01.matches, `pair 0-1: ${e01?.matches} matches, ${e01?.T.inliers.length} inliers`);
  assert.ok(Math.abs(e01.T.dx + 120) <= 1 && Math.abs(e01.T.dy - 20) <= 1, `shift ${e01.T.dx}, ${e01.T.dy}`); // a point of 0 is 120 px further left and 20 px lower in 1
  assert.ok(e01.H.H && e01.S.matrix);
  const stepwise = R.solveAlignment(crops.map((c) => ({ width: c.width, height: c.height })), edges, { projection: 'auto' });
  const whole = R.alignImages(crops);
  assert.equal(stepwise.projection, whole.projection);
  assert.equal(stepwise.reference, whole.reference);
  assert.deepEqual(stepwise.bounds, whole.bounds);
  stepwise.forEach((t, i) => {
    assert.deepEqual(t.homography, whole[i].homography);
    assert.deepEqual(t.bounds, whole[i].bounds);
    assert.equal(t.parent, whole[i].parent);
  });
  assert.equal(stepwise.samples().length, 2);
  // two unrelated pictures are no pair; without edges nothing is matched and everything stays in place
  const alien = R.registerPair(feats[0], R.detectFeatures(scene(300, 260, 999)));
  // (a few chance matches may survive the ratio test; no model gathers enough of them to count as an overlap)
  assert.ok(alien === null || (alien.T.inliers.length < 8 && alien.S.inliers.length < 10 && alien.H.inliers.length < 12), `chance inliers: ${alien?.T.inliers.length}, ${alien?.S.inliers.length}, ${alien?.H.inliers.length}`);
  assert.equal(R.registerPair(feats[0], { keypoints: [], descriptors: new Uint32Array(0), count: 0, scale: 1 }), null);
  const none = R.solveAlignment([{ width: 300, height: 260 }, { width: 200, height: 100 }], [], { projection: 'auto' });
  assert.equal(none.projection, 'reposition');
  assert.deepEqual(none.map((t) => t.matched), [true, false].map((v, i) => i === none.reference ? true : false));
  assert.deepEqual(none[1 - none.reference].bounds, { x: 0, y: 0, ...(none.reference === 0 ? { width: 200, height: 100 } : { width: 300, height: 260 }) });
});

test('a weakly supported pair never short-cuts a chain of well supported neighbours', () => {
  // four images in a row, 100 px apart; hand-made pair models (pure shifts) with a given number of inliers
  const sizes = [0, 1, 2, 3].map(() => ({ width: 300, height: 200 }));
  const edge = (a, b, dx, dy, inliers) => {
    const idx = Array.from({ length: inliers }, (_, k) => k);
    const pts = idx.map((k) => ({ x1: 10 + k, y1: 20, x2: 10 + k + dx, y2: 20 + dy }));
    return { a, b, pts, matches: inliers + 30, threshold: 3, T: { dx, dy, matrix: [1, 0, 0, 1, dx, dy], inliers: idx }, S: { matrix: [1, 0, 0, 1, dx, dy], inliers: idx }, H: { H: [1, 0, dx, 0, 1, dy, 0, 0, 1], inliers: idx } };
  };
  const chainEdges = [edge(0, 1, -100, 0, 120), edge(1, 2, -100, 0, 90), edge(2, 3, -100, 0, 150)];
  // a chance agreement between the two ends, which do not overlap: 9 inliers on a wrong shift
  const chance = edge(0, 3, 40, -70, 9);
  for (const projection of ['reposition', 'collage']) {
    const r = R.solveAlignment(sizes, [chance, ...chainEdges], { projection, reference: 0 });
    assert.deepEqual(r.map((t) => t.parent), [-1, 0, 1, 2], projection);
    assert.deepEqual(r.map((t) => [t.matrix[4], t.matrix[5]]), [[0, 0], [100, 0], [200, 0], [300, 0]], projection);
    assert.deepEqual(r.map((t) => t.inliers), [0, 120, 90, 150]);
    assert.deepEqual(r.bounds, { x: 0, y: 0, width: 600, height: 200 });
  }
  // the same weak pair is taken when it is the only way to an image ...
  const alone = R.solveAlignment(sizes, [chance, chainEdges[0], chainEdges[1]], { projection: 'reposition', reference: 0 });
  assert.equal(alone[3].parent, 0);
  assert.deepEqual([alone[3].matrix[4], alone[3].matrix[5]], [-40, 70]);
  assert.equal(alone[3].matched, true);
  // … and the entry says how far it can be trusted
  assert.deepEqual(alone.map((t) => t.sound), [true, true, true, false]);
  // ... and a pair below the minimum is no pair at all
  const none = R.solveAlignment(sizes, [edge(0, 3, 40, -70, 7), chainEdges[0], chainEdges[1]], { projection: 'reposition', reference: 0 });
  assert.equal(none[3].matched, false);
  assert.deepEqual(none[3].homography, R.IDENTITY3);
  // among well supported pairs the fewest hops win, and the better supported parent among equals
  const direct = R.solveAlignment(sizes, [...chainEdges, edge(0, 2, -200, 0, 40), edge(1, 3, -200, 0, 60), edge(0, 3, -300, 0, 30)], { projection: 'reposition', reference: 0 });
  assert.deepEqual(direct.map((t) => t.parent), [-1, 0, 0, 0]);
  const tie = R.solveAlignment(sizes, [chainEdges[0], edge(0, 2, -200, 0, 40), edge(1, 3, -200, 0, 60), edge(2, 3, -100, 0, 150)], { projection: 'reposition', reference: 0 });
  assert.equal(tie[3].parent, 2); // through 1 or through 2 is two hops either way: 150 inliers beat 60
  assert.equal(tie[3].matrix[4], 300);
});

test('alignImages recovers a perspective view and Auto chooses perspective for it', () => {
  const big = scene(420, 320, 44, 360);
  const quad = [[0, 0], [420, 0], [420, 320], [0, 320]];
  const to = [[14, 6], [404, -10], [430, 330], [-8, 306]];
  const view = perspective(big, quad, to, { x: 0, y: 0, width: 420, height: 320 });
  const r = R.alignImages([big, view], { reference: 0 });
  assert.equal(r.projection, 'perspective');
  assert.equal(r[1].matrix, null);
  // view -> scene is the inverse of the warp; pixel-index coordinates are half a pixel off pixel-corner ones
  const H = homographyFrom4(to, quad);
  for (const [x, y] of [[60, 50], [360, 50], [360, 270], [60, 270], [210, 160]]) {
    const [ex, ey] = R.applyH(H, x + 0.5, y + 0.5), [ax, ay] = R.applyH(r[1].homography, x, y);
    assert.ok(Math.hypot(ex - 0.5 - ax, ey - 0.5 - ay) < 1.5, `point ${x},${y} is off by ${Math.hypot(ex - 0.5 - ax, ey - 0.5 - ay).toFixed(2)} px`);
  }
  // rendered back, it lies on the original
  const back = R.applyAlignment(view, r[1], { x: 0, y: 0, width: 420, height: 320 });
  let diff = 0, count = 0;
  for (let y = 40; y < 280; y += 2) for (let x = 40; x < 380; x += 2) {
    const i = (y * 420 + x) * 4;
    if (back.data[i + 3] < 255) continue;
    diff += Math.abs(back.data[i] - big.data[i]);
    count++;
  }
  // rectangle edges resampled twice differ; the mean stays small when the registration is right
  assert.ok(count > 5000 && diff / count < 12, `mean difference ${(diff / count).toFixed(2)}`);
});

test('focal length from a rotation homography, and the cylinder / sphere projections', () => {
  // H = K · Ry(θ) · K⁻¹ in centred coordinates
  const f = 800, th = (18 * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const H = [c, 0, s * f, 0, 1, 0, -s / f, 0, c];
  assert.ok(Math.abs(R.focalFromHomography(H) - f) < 1, `focal ${R.focalFromHomography(H)}`);
  // tilted too
  const tilt = (6 * Math.PI) / 180;
  const Rx = [1, 0, 0, 0, Math.cos(tilt), -Math.sin(tilt), 0, Math.sin(tilt), Math.cos(tilt)];
  const Ry = [c, 0, s, 0, 1, 0, -s, 0, c];
  const K = [f, 0, 0, 0, f, 0, 0, 0, 1], Ki = [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1];
  const H2 = R.multiply3(K, R.multiply3(R.multiply3(Rx, Ry), Ki));
  assert.ok(Math.abs(R.focalFromHomography(H2) - f) < 2, `focal ${R.focalFromHomography(H2)}`);
  assert.equal(R.focalFromHomography([1, 0, 30, 0, 1, 0, 0, 0, 1]), null); // a pure shift says nothing about the lens

  for (const type of ['cylindrical', 'spherical']) {
    const [u, v] = R.projectPoint(type, 500, 200, 150, 320, 40);
    const [x, y] = R.unprojectPoint(type, 500, 200, 150, u, v);
    assert.ok(Math.abs(x - 320) < 1e-9 && Math.abs(y - 40) < 1e-9);
    // the centre stays, the sides are pulled in
    assert.deepEqual(R.projectPoint(type, 500, 200, 150, 200, 150), [0, 0]);
    assert.ok(Math.abs(u) < 120 && u > 0);
  }
});

/** The 3 × 3 rotation of a camera that pans by `yaw`, tilts by `tilt` and rolls by `roll` (degrees). */
function cameraRotation(yaw, tilt = 0, roll = 0) {
  const r = Math.PI / 180;
  const cy = Math.cos(yaw * r), sy = Math.sin(yaw * r), cx = Math.cos(tilt * r), sx = Math.sin(tilt * r), cz = Math.cos(roll * r), sz = Math.sin(roll * r);
  return R.multiply3([cz, -sz, 0, sz, cz, 0, 0, 0, 1], R.multiply3([1, 0, 0, 0, cx, -sx, 0, sx, cx], [cy, 0, sy, 0, 1, 0, -sy, 0, cy]));
}

test('camera rotation from matched points: exact on clean data, close under noise, and its homography', () => {
  const f = 900, ca = [399.5, 299.5], cb = [399.5, 299.5];
  const Rt = cameraRotation(17, -3, 2);
  const Ht = R.rotationHomography(Rt, f, ca, cb);
  // K·R·K⁻¹: the principal point of a goes where the rotated axis points
  const axis = [Rt[2] / Rt[8], Rt[5] / Rt[8]];
  const [px, py] = R.applyH(Ht, ca[0], ca[1]);
  assert.ok(Math.abs(px - (cb[0] + f * axis[0])) < 1e-9 && Math.abs(py - (cb[1] + f * axis[1])) < 1e-9);
  const rnd = randomSeeded(12);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const pairs = (noise) => Array.from({ length: 120 }, () => {
    const x1 = 300 + rnd() * 480, y1 = 20 + rnd() * 560; // a strip on one side: the overlap of two panorama frames
    const [x2, y2] = R.applyH(Ht, x1, y1);
    return { x1, y1, x2: x2 + gauss() * noise, y2: y2 + gauss() * noise };
  });
  const exact = R.fitRotation(pairs(0), null, f, ca, cb);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(exact[i] - Rt[i]) < 1e-9, `element ${i}: ${exact[i]} for ${Rt[i]}`);
  // a rotation: orthonormal, determinant 1
  const RtR = R.multiply3([exact[0], exact[3], exact[6], exact[1], exact[4], exact[7], exact[2], exact[5], exact[8]], exact);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(RtR[i] - (i % 4 === 0 ? 1 : 0)) < 1e-12);
  // with half a pixel of noise the far side of the image, where there were no matches, is still within a pixel
  const noisy = R.fitRotation(pairs(0.5), null, f, ca, cb);
  const Hn = R.rotationHomography(noisy, f, ca, cb);
  for (const [x, y] of [[0, 0], [0, 599], [799, 0], [799, 599], [100, 300]]) {
    const [ex, ey] = R.applyH(Ht, x, y), [ax, ay] = R.applyH(Hn, x, y);
    assert.ok(Math.hypot(ex - ax, ey - ay) < 1, `point ${x},${y} is off by ${Math.hypot(ex - ax, ey - ay).toFixed(2)} px`);
  }
  // a free homography through the same noisy strip bends away where the rotation does not
  const Hfree = R.fitHomography(pairs(0.5));
  const off = (H) => Math.hypot(...R.applyH(H, 0, 300).map((v, k) => v - R.applyH(Ht, 0, 300)[k]));
  assert.ok(off(Hn) < off(Hfree), `rotation ${off(Hn).toFixed(2)} px, homography ${off(Hfree).toFixed(2)} px`);
  // a start homography is honoured, an index list selects pairs, too few pairs give nothing
  const started = R.fitRotation(pairs(0), [0, 5, 9, 33, 70], f, ca, cb, Ht);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(started[i] - Rt[i]) < 1e-9);
  assert.equal(R.fitRotation(pairs(0).slice(0, 1), null, f, ca, cb), null);
});

/** What a camera of focal length f sees of a far scene `master` (centred on its axis) after turning by Rm. */
function cameraView(master, Rm, f, W, H) {
  const out = createImage(W, H);
  const mw = master.width, mh = master.height, md = master.data;
  const Hc = R.multiply3([f, 0, 0, 0, f, 0, 0, 0, 1], R.multiply3(Rm, [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1]));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [u, v] = R.applyH(Hc, x - (W - 1) / 2, y - (H - 1) / 2);
    const mx = u + (mw - 1) / 2, my = v + (mh - 1) / 2;
    const x0 = Math.floor(mx), y0 = Math.floor(my);
    if (x0 < 0 || y0 < 0 || x0 >= mw - 1 || y0 >= mh - 1) continue;
    const tx = mx - x0, ty = my - y0, i = (y0 * mw + x0) * 4, o = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) out.data[o + k] = (md[i + k] * (1 - tx) + md[i + 4 + k] * tx) * (1 - ty) + (md[i + mw * 4 + k] * (1 - tx) + md[i + mw * 4 + 4 + k] * tx) * ty;
    out.data[o + 3] = 255;
  }
  return out;
}

test('a turning camera: Auto picks the cylinder for a wide pan, the cylinder and the sphere register tilt and roll too', () => {
  const f = 500, W = 480, H = 360;
  const master = scene(1500, 700, 61, 2400);
  const turns = [[-24, 1.5, 1], [0, 0, 0], [23, -2, -1.2]];
  const views = turns.map((t) => cameraView(master, cameraRotation(...t), f, W, H));
  // neither a shift nor a similarity explains a turning camera; the outer frames reach 49° off the axis, where
  // a plane draws them more than twice as wide, so Auto wraps the three on a cylinder
  const auto = R.alignImages(views);
  assert.equal(auto.projection, 'cylindrical');
  assert.equal(auto.reference, 1);
  assert.ok(auto.every((t) => t.matched && t.warp));
  const plane = R.alignImages(views, { projection: 'perspective' });
  // 98° of view: 2·f·tan(49°) = 1150 px on the plane, f·98° = 855 px on the cylinder
  assert.ok(Math.abs(plane.bounds.width - 1150) < 40 && plane.bounds.height > 1.35 * H, `plane: ${plane.bounds.width} × ${plane.bounds.height}`);
  assert.ok(Math.abs(auto.bounds.width - 855) < 25 && auto.bounds.height < 1.15 * H, `cylinder: ${auto.bounds.width} × ${auto.bounds.height}`);
  // the reference is the frame in the middle of the panorama, wherever it is in the list (the outer two share a
  // sliver at most: no pair to build on)
  const shuffled = R.alignImages([views[1], views[0], views[2]], { projection: 'cylindrical' });
  assert.equal(shuffled.reference, 0);
  assert.ok(shuffled[1].bounds.x < -150 && shuffled[2].bounds.x > 150);
  // a small turn stays on the plane
  const small = R.alignImages([cameraView(master, cameraRotation(-5, 0.5, 0.4), f, W, H), views[1], cameraView(master, cameraRotation(6, -0.4, -0.3), f, W, H)]);
  assert.equal(small.projection, 'perspective');
  assert.ok(small.every((t) => t.matched && !t.warp && (t.index === small.reference) === !!t.matrix));
  for (const type of ['cylindrical', 'spherical']) {
    const r = R.alignImages(views, { projection: type });
    assert.equal(r.projection, type);
    assert.equal(r.reference, 1);
    // the focal length comes out of the homographies
    assert.ok(Math.abs(r.focal - f) < f * 0.03, `${type}: focal ${r.focal}`);
    r.forEach((t, i) => {
      assert.ok(t.matched, `${type}: image ${i}`);
      assert.deepEqual(t.warp, { type, focal: r.focal, cx: (W - 1) / 2, cy: (H - 1) / 2 });
      assert.equal(t.matrix, null);
    });
    // the reference stays centred and gets narrower (the surface pulls its sides in): half its width is f·atan(W / 2f)
    const half = r.focal * Math.atan(W / 2 / r.focal);
    assert.ok(Math.abs(r[1].bounds.x - ((W - 1) / 2 - half)) <= 2.5 && Math.abs(r[1].bounds.width - 2 * half) <= 5, `${type}: reference ${JSON.stringify(r[1].bounds)} for half ${half.toFixed(1)}`);
    assert.ok(r[0].bounds.x < -150 && r[2].bounds.x > 150);
    const arc = (24 + 23) * (Math.PI / 180) * f; // the pan between the outer frames, on the cylinder
    assert.ok(Math.abs(r[2].bounds.x - r[0].bounds.x - arc) < 12, `${type}: ${r[2].bounds.x - r[0].bounds.x} for ${arc.toFixed(1)}`);
    // rendered onto the surface the three agree where they overlap, although the camera was tilted and rolled
    const rect = r.bounds;
    const drawn = r.map((t, i) => R.applyAlignment(views[i], t, rect));
    for (const [a, b] of [[0, 1], [1, 2]]) {
      let diff = 0, count = 0;
      for (let i = 0; i < drawn[a].data.length; i += 4 * 3) {
        if (drawn[a].data[i + 3] !== 255 || drawn[b].data[i + 3] !== 255) continue;
        diff += Math.abs(drawn[a].data[i] - drawn[b].data[i]);
        count++;
      }
      // (rectangle edges resampled twice differ by a few levels; out of register the mean is above 30)
      assert.ok(count > 8000 && diff / count < 9, `${type} ${a}-${b}: mean difference ${(diff / count).toFixed(2)} over ${count}`);
    }
    // projectImage fills the entry's bounds and nothing of the image is lost
    const own = R.projectImage(views[0], r[0]);
    assert.equal(own.width, r[0].bounds.width);
    assert.equal(own.height, r[0].bounds.height);
    let filled = 0;
    for (let i = 3; i < own.data.length; i += 4) if (own.data[i] === 255) filled++;
    assert.ok(filled > 0.8 * W * H, `${type}: ${filled} pixels drawn`);
    // the corners of the bounding box are empty: the image's edges bow on the surface
    assert.equal(own.data[3], 0);
  }
  // the centre of the reference is the surface's point of contact: that pixel is unchanged
  const cyl = R.alignImages(views, { projection: 'cylindrical' });
  const ref = R.applyAlignment(views[1], cyl[1], { x: 239, y: 179, width: 2, height: 2 });
  const mean = (img, x, y) => (img.data[(y * W + x) * 4] + img.data[(y * W + x + 1) * 4] + img.data[((y + 1) * W + x) * 4] + img.data[((y + 1) * W + x + 1) * 4]) / 4;
  assert.ok(Math.abs((ref.data[0] + ref.data[4] + ref.data[8] + ref.data[12]) / 4 - mean(views[1], 239, 179)) <= 6);
  // a given focal length is used as it is; shifted crops of a flat picture are no rotation and keep their shift
  const flat = scene(700, 300, 61, 480);
  const crops = [crop(flat, 0, 0, 320, 300), crop(flat, 190, 0, 320, 300), crop(flat, 380, 0, 320, 300)];
  const long = R.alignImages(crops, { projection: 'cylindrical', focal: 4000 });
  assert.equal(long.focal, 4000);
  assert.ok(long.every((t) => t.matched && t.warp.type === 'cylindrical'));
  // with a long lens the cylinder is almost flat: the frames sit a shift apart
  assert.ok(Math.abs(long[2].bounds.x - long[1].bounds.x - 190) <= 3 && Math.abs(long[1].bounds.x - long[0].bounds.x - 190) <= 3, `${long.map((t) => t.bounds.x)}`);
  const [hx, hy] = R.applyH(long[2].homography, 100, 100);
  assert.ok(Math.hypot(hx - 290, hy - 100) < 1.5, `${hx}, ${hy}`);
});

test('guided matching and the picture check: many more matches under a model, and no agreement with a wrong one', () => {
  const big = scene(700, 420, 71, 600);
  const a = crop(big, 0, 30, 400, 300), b = crop(big, 150, 50, 400, 300); // a point of a is 150 px further left and 20 px higher in b
  const fa = R.detectFeatures(a), fb = R.detectFeatures(b);
  assert.ok(fa.thumb && fa.thumb.width === 160 && fa.thumb.height === 120);
  const right = [1, 0, -150, 0, 1, -20, 0, 0, 1];
  const first = R.matchDescriptors(fa, fb);
  const guided = R.guidedMatches(fa, fb, right, { radius: 4 });
  const pts = R.matchedPoints(fa, fb, guided);
  // every guided match lies where the model says, each feature of b is used once
  assert.ok(pts.every((p) => Math.hypot(p.x2 - p.x1 + 150, p.y2 - p.y1 + 20) <= 4));
  assert.equal(new Set(guided.map((m) => m.b)).size, guided.length);
  assert.ok(guided.length > first.length * 0.9 && guided.length > 150, `${guided.length} guided, ${first.length} first`);
  // under a wrong model far less is found (look-alike corners near any position: what `share` and the picture check are for)
  const wrong = [1, 0, -90, 0, 1, 40, 0, 0, 1];
  assert.ok(R.guidedMatches(fa, fb, wrong, { radius: 4 }).length < guided.length / 5);
  assert.ok(R.guidedMatches(fa, fb, wrong, { radius: 4, maxDistance: 40 }).length < guided.length / 30);
  // the pictures agree under the right model and not under the wrong one, whatever the exposure
  const brighter = { width: b.width, height: b.height, data: b.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v * 1.25 + 10))) };
  const fbr = R.detectFeatures(brighter);
  assert.ok(R.pictureAgreement(fa, fb, right) > 0.85, `${R.pictureAgreement(fa, fb, right)}`);
  assert.ok(R.pictureAgreement(fa, fbr, right) > 0.8, `${R.pictureAgreement(fa, fbr, right)}`);
  assert.ok(Math.abs(R.pictureAgreement(fa, fb, wrong)) < 0.2, `${R.pictureAgreement(fa, fb, wrong)}`);
  // no verdict without an overlap
  assert.equal(R.pictureAgreement(fa, fb, [1, 0, 5000, 0, 1, 0, 0, 0, 1]), null);
  // registerPair reports how much of the overlap its models explain and what the pictures say
  const e = R.registerPair(fa, fb);
  assert.ok(e.matches > first.length * 0.9);
  assert.ok(e.T.inliers.length > 0.9 * e.matches && e.T.share > 0.6 && e.T.share <= 1.05, `share ${e.T.share}`);
  assert.ok(e.agreement > 0.85 && !e.ambiguous);
  assert.ok(e.T.tight > 0.9 * e.T.inliers.length);
  // the first round alone finds fewer
  const seedOnly = R.registerPair(fa, fb, { guided: false });
  assert.equal(seedOnly.matches, first.length);
  assert.equal(seedOnly.agreement, undefined);
});

test('pairs the pictures do not agree with, or that fit in two ways, are no overlaps', () => {
  const sizes = [0, 1, 2].map(() => ({ width: 300, height: 200 }));
  const edge = (a, b, dx, inliers, extra = {}) => {
    const idx = Array.from({ length: inliers }, (_, k) => k);
    const pts = idx.map((k) => ({ x1: 10 + k, y1: 20, x2: 10 + k + dx, y2: 20 }));
    const part = () => ({ inliers: idx, share: 0.6, tight: inliers });
    return { a, b, pts, matches: inliers + 30, threshold: 3, T: { dx, dy: 0, matrix: [1, 0, 0, 1, dx, 0], ...part() }, S: { matrix: [1, 0, 0, 1, dx, 0], ...part() }, H: { H: [1, 0, dx, 0, 1, 0, 0, 0, 1], ...part() }, agreement: 0.9, ...extra };
  };
  const solve = (edges) => R.solveAlignment(sizes, edges, { projection: 'reposition', reference: 0 });
  assert.deepEqual(solve([edge(0, 1, -100, 80), edge(1, 2, -100, 80)]).map((t) => t.matched), [true, true, true]);
  // many inliers, but the pictures disagree (a row of windows fitted onto another row of windows)
  assert.deepEqual(solve([edge(0, 1, -100, 80), edge(1, 2, -100, 80, { agreement: 0.2 })]).map((t) => t.matched), [true, true, false]);
  // … or two placements fit about equally well
  assert.deepEqual(solve([edge(0, 1, -100, 80), edge(1, 2, -100, 80, { ambiguous: true })]).map((t) => t.matched), [true, true, false]);
  // … or the model explains only a sliver of what the two share
  const thin = edge(1, 2, -100, 80);
  for (const k of ['T', 'S', 'H']) thin[k].share = 0.05;
  assert.deepEqual(solve([edge(0, 1, -100, 80), thin]).map((t) => t.matched), [true, true, false]);
  // where the pictures cannot be compared (a flat overlap) the features decide alone
  assert.deepEqual(solve([edge(0, 1, -100, 80), edge(1, 2, -100, 80, { agreement: null })]).map((t) => t.matched), [true, true, true]);
  // a half-agreed pair is used, but never in place of a chain of sound ones
  const iffy = solve([edge(0, 1, -100, 80), edge(1, 2, -100, 80), edge(0, 2, -170, 80, { agreement: 0.6 })]);
  assert.equal(iffy[2].parent, 1);
  assert.equal(iffy[2].matrix[4], 200);
  const alone = solve([edge(0, 1, -100, 80), edge(0, 2, -170, 80, { agreement: 0.6 })]);
  assert.equal(alone[2].parent, 0);
  assert.equal(alone[2].matrix[4], 170);
});

test('seam masks split the overlap in the middle, feather the seam and leave no holes', () => {
  const W = 200, H = 60;
  const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x < 120) a[y * W + x] = 255; // bottom layer: the left 120 px
    if (x >= 80) b[y * W + x] = 255; // top layer: the right 120 px; overlap 80..119
  }
  const { masks, feather, overlap } = R.seamMasks([a, b], W, H);
  assert.ok(overlap > 30 && overlap < 50, `overlap ${overlap}`);
  assert.ok(feather >= 3 && feather <= 5, `feather ${feather}`);
  const row = 30 * W;
  // the bottom layer is opaque wherever it has pixels; elsewhere its mask is black
  for (let x = 0; x < 120; x++) assert.equal(masks[0][row + x], 255, `bottom mask at ${x}`);
  assert.equal(masks[0][row + 150], 0);
  // the top layer: hidden on the left of the overlap, shown on the right, half at the seam in the middle
  assert.equal(masks[1][row + 82], 0);
  assert.equal(masks[1][row + 117], 255);
  assert.equal(masks[1][row + 160], 255);
  assert.equal(masks[1][row + 40], 0);
  let seam = -1;
  for (let x = 80; x < 120; x++) if (masks[1][row + x] >= 128) {
    seam = x;
    break;
  }
  assert.ok(Math.abs(seam - 100) <= 2, `seam at ${seam}`);
  // feathered: more than one grey step, monotonic
  let greys = 0;
  for (let x = 81; x < 120; x++) {
    assert.ok(masks[1][row + x] >= masks[1][row + x - 1]);
    if (masks[1][row + x] > 0 && masks[1][row + x] < 255) greys++;
  }
  assert.ok(greys >= 3 && greys <= 24, `${greys} feathered pixels`);
  // composited "over", every covered pixel is fully opaque
  for (let x = 0; x < W; x++) {
    const m0 = (a[row + x] / 255) * (masks[0][row + x] / 255), m1 = (b[row + x] / 255) * (masks[1][row + x] / 255);
    assert.ok(Math.abs(m1 + (1 - m1) * m0 - 1) < 1e-9, `hole at ${x}`);
  }
  // a hard seam on request; a reduced working size gives the same seam
  const hard = R.seamMasks([a, b], W, H, { feather: 0 });
  assert.ok(hard.masks[1].every((v) => v === 0 || v === 255));
  const small = R.seamMasks([a, b], W, H, { maxPixels: 3000 });
  assert.ok(small.width < W);
  let seam2 = -1;
  for (let x = 80; x < 120; x++) if (small.masks[1][row + x] >= 128) {
    seam2 = x;
    break;
  }
  assert.ok(Math.abs(seam2 - 100) <= 4, `seam on the reduced copy at ${seam2}`);
  assert.equal(small.masks[0][row + 10], 255);
  // weights override the distance: the top layer wins wherever it is the sharper one
  const wa = new Float32Array(W * H).fill(1), wb = new Float32Array(W * H).fill(5);
  const byWeight = R.seamMasks([a, b], W, H, { weights: [wa, wb], feather: 0 });
  assert.equal(byWeight.masks[1][row + 82], 255);
  // distance to the edge: the middle of a 120 px wide band is 60 px from its sides (chamfer, within 10%)
  const dist = R.distanceToEdge(a, W, 400 / 4 > H ? H : H);
  assert.ok(Math.abs(dist[row + 100] - 20) <= 2 && dist[row + 150] === 0);
});

test('focus measure prefers the sharp image; gain compensation equalises the overlap', () => {
  const sharp = scene(120, 90, 4, 80);
  // a box-blurred copy
  const soft = createImage(120, 90);
  for (let y = 0; y < 90; y++) for (let x = 0; x < 120; x++) for (let c = 0; c < 4; c++) {
    let s = 0, n = 0;
    for (let yy = Math.max(0, y - 3); yy <= Math.min(89, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(119, x + 3); xx++) {
      s += sharp.data[(yy * 120 + xx) * 4 + c];
      n++;
    }
    soft.data[(y * 120 + x) * 4 + c] = s / n;
  }
  const fs = R.focusMeasure(sharp), fb = R.focusMeasure(soft);
  let wins = 0;
  for (let i = 0; i < fs.length; i++) if (fs[i] > fb[i]) wins++;
  assert.ok(wins / fs.length > 0.9, `sharp wins ${wins} of ${fs.length}`);

  // two frames of one scene, the second 20% darker; they overlap in the middle third
  const base = scene(150, 60, 9, 90);
  const A = createImage(150, 60), B = createImage(150, 60);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 150; x++) {
    const i = (y * 150 + x) * 4;
    if (x < 100) A.data.set(base.data.subarray(i, i + 4), i);
    if (x >= 50) B.data.set([base.data[i] * 0.8, base.data[i + 1] * 0.8, base.data[i + 2] * 0.8, 255], i);
  }
  const gains = R.gainCompensation([A, B]);
  for (let c = 0; c < 3; c++) {
    assert.ok(gains[0][c] < 1 && gains[1][c] > 1, `gains ${gains[0][c]}, ${gains[1][c]}`);
    assert.ok(Math.abs(gains[1][c] * 0.8 - gains[0][c]) < 0.03, `channel ${c}: ${gains[1][c] * 0.8} vs ${gains[0][c]}`);
  }
  // frames that already agree keep their pixels; a frame that overlaps nothing keeps a gain of 1
  const same = R.gainCompensation([A, A]);
  assert.ok(same.flat().every((g) => Math.abs(g - 1) < 1e-6));
  const lone = createImage(150, 60);
  assert.deepEqual(R.gainCompensation([A, B, lone])[2], [1, 1, 1]);
  const lum = R.gainCompensation([A, B], { perChannel: false });
  assert.ok(lum[1][0] === lum[1][1] && lum[1][1] === lum[1][2]);
  const px = createImage(2, 1, [100, 50, 200, 1]);
  R.applyGain(px, [1.5, 2, 1.5]);
  assert.deepEqual(Array.from(px.data.subarray(0, 4)), [150, 100, 255, 255]);
});

test('vignette: the estimate from matched points finds the falloff, removal undoes it', () => {
  const big = scene(520, 300, 77, 400);
  const v = 0.6;
  const shoot = (x0) => {
    const img = crop(big, x0, 0, 320, 300);
    const cx = 159.5, cy = 149.5, r2 = (320 * 320 + 300 * 300) / 4;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 320; x++) {
      const g = 1 / (1 + (v * ((x - cx) ** 2 + (y - cy) ** 2)) / r2);
      const i = (y * 320 + x) * 4;
      img.data[i] *= g;
      img.data[i + 1] *= g;
      img.data[i + 2] *= g;
    }
    return img;
  };
  // a diagonal shift so matched points sit at clearly different radii in the two frames
  const frames = [shoot(0), shoot(150)];
  const r = R.alignImages(frames, { projection: 'reposition', reference: 0 });
  assert.ok(Math.abs(r[1].matrix[4] - 150) <= 1);
  const est = R.estimateVignette(frames, r.samples());
  assert.ok(est.samples >= 24, `${est.samples} samples`);
  assert.ok(Math.abs(est.amount - v) < 0.25, `estimated ${est.amount} for ${v}`);
  // removal: corners are brightened by 1 + amount, the centre stays
  const flat = createImage(101, 101, [100, 100, 100, 1]);
  R.removeVignette(flat, 0.5);
  assert.equal(flat.data[(50 * 101 + 50) * 4], 100);
  assert.ok(Math.abs(flat.data[0] - 100 * (1 + 0.5 * (2 * 50 * 50) / ((101 * 101 * 2) / 4))) <= 1);
  // clean frames: nothing to remove
  const clean = [crop(big, 0, 0, 320, 300), crop(big, 150, 0, 320, 300)];
  const rc = R.alignImages(clean, { projection: 'reposition', reference: 0 });
  assert.equal(R.estimateVignette(clean, rc.samples()).amount, 0);
});

test('radial distortion: the coefficient is recovered from point pairs and the image is undistorted', () => {
  // two views related by a homography, both seen through a lens with k = 0.06
  const k = 0.06, w = 800, h = 600, cx = (w - 1) / 2, cy = (h - 1) / 2, r2 = (w * w + h * h) / 4;
  const distort = (x, y) => {
    const dx = x - cx, dy = y - cy, s = 1 + (k * (dx * dx + dy * dy)) / r2;
    return [cx + dx * s, cy + dy * s];
  };
  const H = homographyFrom4([[0, 0], [800, 0], [800, 600], [0, 600]], [[-180, 10], [600, -15], [640, 610], [-200, 590]]);
  const rnd = randomSeeded(12);
  const pairs = [];
  while (pairs.length < 200) {
    const x = rnd() * w, y = rnd() * h;
    const [u, v] = R.applyH(H, x, y);
    if (u < 0 || v < 0 || u >= w || v >= h) continue;
    const [x1, y1] = distort(x, y), [x2, y2] = distort(u, v);
    pairs.push({ x1, y1, x2, y2 });
  }
  const sizes = [{ width: w, height: h }, { width: w, height: h }];
  const est = R.estimateDistortion(sizes, [{ a: 0, b: 1, pairs }]);
  assert.ok(Math.abs(est.k - k) < 0.01, `k = ${est.k}`);
  assert.ok(est.improvement < 0.2);
  // undistorted points fit a homography: nothing to correct
  const cleanPairs = pairs.map(() => {
    const x = rnd() * w, y = rnd() * h;
    const [u, v] = R.applyH(H, x, y);
    return { x1: x, y1: y, x2: u, y2: v };
  });
  assert.equal(R.estimateDistortion(sizes, [{ a: 0, b: 1, pairs: cleanPairs }]).k, 0);
  // undistortImage moves a pixel from its distorted position back to the true one
  const img = createImage(200, 150, [0, 0, 0, 1]);
  const kk = 0.1, ccx = 99.5, ccy = 74.5, rr = (200 * 200 + 150 * 150) / 4;
  const ux = 60, uy = 40; // offset of the true point from the centre
  const s = 1 + (kk * (ux * ux + uy * uy)) / rr;
  const px = Math.round(ccx + ux * s), py = Math.round(ccy + uy * s);
  for (let y = py - 1; y <= py + 1; y++) for (let x = px - 1; x <= px + 1; x++) img.data.set([255, 255, 255, 255], (y * 200 + x) * 4);
  const fixed = R.undistortImage(img, kk);
  assert.ok(fixed.data[(Math.round(ccy + uy) * 200 + Math.round(ccx + ux)) * 4] > 200);
  assert.deepEqual(R.undistortImage(img, 0).data, img.data);
});

// ---- stack modes ------------------------------------------------------------------------------------------------

const px = (...values) => values.map((v) => {
  const img = createImage(1, 1);
  img.data.set(Array.isArray(v) ? v : [v, v, v, 255]);
  return img;
});
const first = (img) => Array.from(img.data.subarray(0, 4));

test('stack modes: mean, maximum, minimum, range, median and summation are exact on small inputs', () => {
  const imgs = px([10, 200, 0, 255], [20, 100, 0, 255], [60, 90, 3, 255]);
  assert.deepEqual(first(stackImages(imgs, 'mean')), [30, 130, 1, 255]);
  assert.deepEqual(first(stackImages(imgs, 'maximum')), [60, 200, 3, 255]);
  assert.deepEqual(first(stackImages(imgs, 'minimum')), [10, 90, 0, 255]);
  assert.deepEqual(first(stackImages(imgs, 'range')), [50, 110, 3, 255]);
  assert.deepEqual(first(stackImages(imgs, 'median')), [20, 100, 0, 255]);
  assert.deepEqual(first(stackImages(imgs, 'summation')), [90, 255, 3, 255]); // clipped at white
  // an even count: the median is the mean of the middle two
  assert.deepEqual(first(stackImages(px(10, 20, 40, 100), 'median')), [30, 30, 30, 255]);
  // one image: every location statistic is the image; the spread statistics are zero
  for (const mode of ['mean', 'median', 'maximum', 'minimum', 'summation']) assert.deepEqual(first(stackImages(px(77), mode)), [77, 77, 77, 255]);
  for (const mode of ['range', 'variance', 'standard-deviation']) assert.deepEqual(first(stackImages(px(77), mode)), [0, 0, 0, 255]);
  // the inputs are not modified and the sizes must agree
  assert.deepEqual(first(imgs[0]), [10, 200, 0, 255]);
  assert.throws(() => stackImages([createImage(2, 1), createImage(1, 1)], 'mean'), /same size/);
  assert.throws(() => stackImages(px(1, 2), 'mode-that-does-not-exist'), /Unknown stack mode/);
  assert.equal(STACK_MODE_IDS.length, 12);
  for (const id of STACK_MODE_IDS) assert.equal(stackImages(px(5, 9, 200), id).data.length, 4, id);
});

test('stack modes: variance, standard deviation, skewness, kurtosis and entropy match their definitions', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9]; // mean 5, population variance 4
  const imgs = px(...values);
  const raw = (mode) => stackImages(imgs, mode, { raw: true }).data[0];
  assert.ok(Math.abs(raw('variance') - 32 / 7) < 1e-5); // sample variance: 32 / (8 - 1)
  assert.ok(Math.abs(raw('standard-deviation') - Math.sqrt(32 / 7)) < 1e-5);
  // m3 = 5.25, m2 = 4 -> g1 = 5.25 / 8; m4 = 44.5 -> β2 = 44.5 / 16
  assert.ok(Math.abs(raw('skewness') - 5.25 / 8) < 1e-5, `skewness ${raw('skewness')}`);
  assert.ok(Math.abs(raw('kurtosis') - 44.5 / 16) < 1e-5, `kurtosis ${raw('kurtosis')}`);
  // values 2 (1/8), 4 (3/8), 5 (2/8), 7 (1/8), 9 (1/8)
  const H = -(3 * (1 / 8) * Math.log2(1 / 8) + (3 / 8) * Math.log2(3 / 8) + (2 / 8) * Math.log2(2 / 8));
  assert.ok(Math.abs(raw('entropy') - H) < 1e-5, `entropy ${raw('entropy')}`);
  assert.equal(raw('mean'), 5);
  // the 8-bit scaling described in stack.js
  assert.deepEqual(first(stackImages(imgs, 'variance')), [5, 5, 5, 255]);
  assert.deepEqual(first(stackImages(imgs, 'standard-deviation')), [2, 2, 2, 255]);
  assert.equal(first(stackImages(imgs, 'entropy'))[0], Math.round((H * 255) / 8));
  assert.equal(first(stackImages(imgs, 'skewness'))[0], Math.round(127.5 + 63.75 * (5.25 / 8)));
  assert.equal(first(stackImages(imgs, 'kurtosis'))[0], Math.round(42.5 * (44.5 / 16)));
  // identical samples: no spread, no information, symmetric
  const flat = px(9, 9, 9);
  assert.equal(stackImages(flat, 'entropy', { raw: true }).data[0], 0);
  assert.equal(stackImages(flat, 'skewness', { raw: true }).data[0], 0);
  assert.equal(first(stackImages(flat, 'skewness'))[0], 128);
  // all different: entropy is log2(n)
  assert.ok(Math.abs(stackImages(px(1, 2, 3, 4), 'entropy', { raw: true }).data[0] - 2) < 1e-6);
});

test('stack modes skip transparent samples and "none" composites normally', () => {
  const imgs = px([100, 100, 100, 255], [0, 0, 0, 0], [200, 200, 200, 255], [9, 9, 9, 0]);
  assert.deepEqual(first(stackImages(imgs, 'mean')), [150, 150, 150, 255]);
  assert.deepEqual(first(stackImages(imgs, 'minimum')), [100, 100, 100, 255]);
  assert.deepEqual(first(stackImages(imgs, 'median')), [150, 150, 150, 255]);
  // nothing covers the pixel: it stays transparent; the alpha is the strongest sample's
  assert.deepEqual(first(stackImages(px([5, 5, 5, 0], [9, 9, 9, 0]), 'maximum')), [0, 0, 0, 0]);
  assert.deepEqual(first(stackImages(px([50, 50, 50, 128], [150, 150, 150, 64]), 'mean')), [100, 100, 100, 128]);
  // none: the top image over the ones below
  assert.deepEqual(first(stackImages(px([10, 20, 30, 255], [200, 100, 0, 255]), 'none')), [200, 100, 0, 255]);
  assert.deepEqual(first(stackImages(px([0, 0, 0, 255], [200, 100, 50, 128]), 'none')), [100, 50, 25, 255]);
  assert.deepEqual(first(stackImages(px([10, 20, 30, 255], [0, 0, 0, 0]), 'none')), [10, 20, 30, 255]);
});

test('stack median of noisy copies removes the noise; mean reduces it by about √n', () => {
  const clean = scene(64, 48, 3, 30);
  const rnd = randomSeeded(99);
  const sigma = 24;
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  const copies = [];
  for (let k = 0; k < 15; k++) {
    const img = createImage(64, 48);
    for (let i = 0; i < img.data.length; i += 4) {
      // keep the clean value away from the clipping ends so the noise stays symmetric
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(215, Math.max(40, clean.data[i + c])) + gauss() * sigma;
      img.data[i + 3] = 255;
    }
    copies.push(img);
  }
  const rms = (img) => {
    let s = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) {
      const e = img.data[i + c] - Math.min(215, Math.max(40, clean.data[i + c]));
      s += e * e;
      n++;
    }
    return Math.sqrt(s / n);
  };
  const noisy = rms(copies[0]);
  assert.ok(noisy > sigma * 0.85, `one copy is off by ${noisy}`);
  const median = rms(stackImages(copies, 'median'));
  assert.ok(median < noisy / 3, `median error ${median.toFixed(2)} against ${noisy.toFixed(2)}`);
  const mean = rms(stackImages(copies, 'mean'));
  assert.ok(Math.abs(mean - sigma / Math.sqrt(15)) < 1.5, `mean error ${mean.toFixed(2)}`);
  // the standard deviation of the stack measures the noise
  const sd = stackImages(copies, 'standard-deviation', { raw: true });
  let s = 0;
  for (let i = 0; i < sd.data.length; i += 4) s += sd.data[i];
  assert.ok(Math.abs(s / (64 * 48) - sigma) < 2, `mean standard deviation ${s / (64 * 48)}`);
});
