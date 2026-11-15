// brush-settings-panel (ARCHITECTURE.md "0.5 features", package 2): the pure parts of the package's dab modifiers
// (Brush Pose, Texture, Dual Brush, Noise, Wet Edges) on the engine's coverage masks (also reduced ones) and buffer
// views, and .abr files both ways on bytes this test builds (version 6.2 through Pigment's writer, versions 1 and 2 by
// hand), with truncated and damaged files reported, never thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { traceDabs, dabModifiers, strokeReach } from '../../src/renderer/lib/brush.js';
import { normalizeBrush } from '../../src/renderer/lib/brush/preset.js';
import { posedSample, applyNoise, noisyCoverage, pixelNoise, applyWetEdges, erode, wetRadius, WET_INSIDE } from '../../src/renderer/lib/brush/extras.js';
import { patternHeights, textureBlend, applyTextureToMask, applyTextureToBuffer, tipDepth, contrastFactor } from '../../src/renderer/lib/brush/texture.js';
import { computedTipRaster, dualCombine, DualTrail, dualCoverage } from '../../src/renderer/lib/brush/dual.js';
import { ABR_REAL, brushFromAgPsd, readAbrFile, writeAbrFile, brushDescriptor } from '../../src/renderer/lib/brush/abr.js';
import { TEXTURE_MODES, DUAL_MODES } from '../../src/renderer/lib/brush/preset.js';
import { decodePng, toRgba8 } from '../../src/shared/pixels/png.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const paint = { opacity: 1, flow: 1, smoothing: 0, pressureSize: true, pressureOpacity: false, color: '#000000', mode: 'paint', blend: 'normal' };

test('the modifiers are registered at their orders, and none reaches beyond the tip', () => {
  const byId = Object.fromEntries(dabModifiers().map((m) => [m.id, m.order]));
  assert.deepEqual([byId['brush-pose'], byId['texture-tip'], byId.texture, byId['dual-brush'], byId.noise, byId['wet-edges']], [50, 500, 510, 600, 700, 800]);
  const all = normalizeBrush({ tip: { size: 40 }, texture: { enabled: true }, dualBrush: { enabled: true, scatter: 5 }, brushPose: { enabled: true }, noise: true, wetEdges: true });
  assert.equal(strokeReach(all, {}), 40);
  // Texture Each Tip picks the coverage modifier, else the stroke's buffer
  const tip = dabModifiers().find((m) => m.id === 'texture-tip'), stroke = dabModifiers().find((m) => m.id === 'texture');
  assert.equal(tip.enabled(all), false);
  assert.equal(stroke.enabled(all), true);
  const each = normalizeBrush({ texture: { enabled: true, eachTip: true } });
  assert.deepEqual([tip.enabled(each), stroke.enabled(each)], [true, false]);
});

test('Brush Pose: stands in for a mouse\'s missing pen data, overrides a pen only where asked; traceDabs sees it', () => {
  const pose = { tiltX: 0.5, tiltY: 0, rotation: 450, pressure: 0.4, overrideTilt: false, overrideRotation: false, overridePressure: true };
  const mouse = posedSample({ x: 1, y: 2, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, pointerType: 'mouse' }, pose);
  assert.deepEqual([mouse.tiltX, mouse.twist, mouse.pressure], [45, 90, 0.4]);
  assert.ok(near(mouse.altitude, Math.PI / 4, 1e-9));
  const pen = posedSample({ x: 1, y: 2, pressure: 0.9, tiltX: 10, tiltY: 0, twist: 30, pointerType: 'pen' }, pose);
  assert.deepEqual([pen.tiltX, pen.twist, pen.pressure], [10, 30, 0.4]);
  // the pose's pressure reaches the dab size through 0.4's pressure scaling (the options bar's Pressure for Size)
  const line = Array.from({ length: 6 }, (_, i) => ({ x: 10 + i * 10, y: 20 }));
  const posed = normalizeBrush({ tip: { size: 20, spacing: 0.25 }, brushPose: { enabled: true, pressure: 0.5 } });
  const plain = normalizeBrush({ tip: { size: 20, spacing: 0.25 } });
  const a = traceDabs(line, { ...paint, preset: posed });
  const b = traceDabs(line, { ...paint, preset: plain });
  assert.ok(a.every((d) => d.size < 20 * 0.75));
  assert.ok(b.every((d) => d.size === 20));
  assert.equal(a[0].sample.pressure, 0.5);
});

test('Noise: dithers half coverage, leaves solid and empty pixels, is fixed per document pixel and honours a reduced mask', () => {
  assert.equal(noisyCoverage(0, 0.9), 0);
  assert.equal(noisyCoverage(1, 0.1), 1);
  assert.equal(noisyCoverage(0.5, 1), 1);
  assert.equal(noisyCoverage(0.5, 0), 0);
  assert.ok(near(noisyCoverage(0.1, 1), 0.3));
  // the same document pixel through two masks: one at full size, one at half size two canvas px per mask px
  const full = { data: new Float32Array(16).fill(0.5), width: 4, height: 4, x: 10, y: 20, scale: 1 };
  applyNoise(full, 100, 200);
  const k = (i, j) => j * 4 + i;
  assert.ok(near(full.data[k(1, 1)], noisyCoverage(0.5, pixelNoise(111, 221))));
  const half = { data: new Float32Array(4).fill(0.5), width: 2, height: 2, x: 10, y: 20, scale: 0.5 };
  applyNoise(half, 100, 200);
  // mask px (0, 0) covers canvas px 10..11 x 20..21: it reads its centre's document pixel (111, 221)
  assert.ok(near(half.data[0], noisyCoverage(0.5, pixelNoise(111, 221))));
  assert.ok(near(half.data[3], noisyCoverage(0.5, pixelNoise(113, 223))));
});

test('Wet Edges: on the buffer view only A changes; the inside keeps WET_INSIDE, the edges keep their alpha', () => {
  // erosion is the minimum over the window, edges clamped
  const plane = Uint8Array.from([9, 1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
  assert.deepEqual([...erode(plane, 4, 3, 1)], [1, 1, 1, 9, 1, 1, 1, 9, 9, 9, 9, 9]);
  const w = 21, h = 21;
  const data = new Uint8ClampedArray(w * h * 4);
  // an opaque red square 5..15 on transparent
  for (let y = 5; y <= 15; y++) for (let x = 5; x <= 15; x++) data.set([200, 10, 20, 255], (y * w + x) * 4);
  const before = data.slice();
  applyWetEdges({ width: w, height: h, data }, 2);
  const at = (x, y) => [...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  for (let i = 0; i < data.length; i += 4) assert.deepEqual([data[i], data[i + 1], data[i + 2]], [before[i], before[i + 1], before[i + 2]]);
  assert.equal(at(10, 10)[3], Math.round(255 * WET_INSIDE));
  assert.equal(at(5, 10)[3], 255);
  assert.equal(at(15, 15)[3], 255);
  assert.equal(at(0, 0)[3], 0);
  assert.equal(wetRadius(100), 8);
  assert.equal(wetRadius(1), 1);
});

test('Texture: heights from luma with Invert, Brightness and Contrast; every mode is the identity at depth 0', () => {
  const img = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) };
  assert.deepEqual([...patternHeights(img).data], [1, 0]);
  assert.deepEqual([...patternHeights(img, { invert: true }).data], [0, 1]);
  const grey = { width: 1, height: 1, data: Uint8ClampedArray.from([140, 140, 140, 255]) };
  assert.ok(patternHeights(grey, { brightness: 100 }).data[0] > 0.85);
  assert.ok(patternHeights(grey, { contrast: 100 }).data[0] > 0.9);
  assert.ok(near(contrastFactor(-50), 0.5));
  // a transparent pattern pixel is white (high)
  assert.equal(patternHeights({ width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 0]) }).data[0], 1);
  for (const mode of TEXTURE_MODES) {
    for (const c of [0.2, 0.7, 1]) assert.ok(near(textureBlend(mode, c, 0.3, 0), c), `${mode} at depth 0`);
    // full depth on a white (high) pixel keeps paint, on a black (low) pixel takes it for the darkening modes
    const hi = textureBlend(mode, 1, 1, 1), lo = textureBlend(mode, 1, 0, 1);
    assert.ok(hi >= lo, mode);
  }
  assert.equal(textureBlend('multiply', 0.8, 0, 1), 0);
  assert.ok(near(textureBlend('multiply', 0.8, 0.5, 0.5), 0.8 * 0.75));
  assert.ok(near(textureBlend('subtract', 0.8, 0.5, 1), 0.3));
  assert.equal(textureBlend('height', 0.6, 0.3, 1), 0);
  assert.equal(textureBlend('height', 0.6, 0.5, 1), 0.6);
});

test('Texture on a reduced coverage mask reads the pattern at each mask pixel\'s document position; the stroke buffer view too', () => {
  // a 2 x 1 pattern: white, black; scale 2: each pattern pixel covers 2 document px, so the period is 4 px
  const heights = patternHeights({ width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) });
  const full = { data: new Float32Array(8).fill(1), width: 8, height: 1, x: 0, y: 0, scale: 1 };
  applyTextureToMask(full, heights, { ox: 0, oy: 0, scale: 2, mode: 'multiply', depth: 1 });
  assert.deepEqual([...full.data], [1, 1, 0, 0, 1, 1, 0, 0]);
  // a mask at scale 0.5 (one mask px per 2 canvas px), its canvas at document x 2: mask px i covers 2 + 2i .. 3 + 2i
  const reduced = { data: new Float32Array(4).fill(1), width: 4, height: 1, x: 0, y: 0, scale: 0.5 };
  applyTextureToMask(reduced, heights, { ox: 2, oy: 0, scale: 2, mode: 'multiply', depth: 1 });
  assert.deepEqual([...reduced.data], [0, 1, 0, 1]);
  // the buffer view: straight RGBA, only A changes, the rect's document position counts
  const data = new Uint8ClampedArray(4 * 4).fill(200);
  applyTextureToBuffer({ width: 4, height: 1, data }, { x: 1, y: 0, width: 4, height: 1 }, heights, { ox: 1, oy: 0, scale: 2, mode: 'multiply', depth: 1 });
  // document px 2..5: black, black, white, white
  assert.deepEqual([...data].filter((_, i) => i % 4 === 3), [0, 0, 200, 200]);
  assert.deepEqual([...data].filter((_, i) => i % 4 !== 3), new Array(12).fill(200));
  // the depth of one tip: its control maps to [Minimum Depth, 1], jitter never below the minimum
  const tx = normalizeBrush({ texture: { enabled: true, eachTip: true, depth: 0.8, minimumDepth: 0.25, depthControl: { type: 'fade', fadeSteps: 4 } } }).texture;
  assert.ok(near(tipDepth(tx, { index: 0 }, () => 0), 0.8));
  assert.ok(near(tipDepth(tx, { index: 4 }, () => 0), 0.8 * 0.25));
  assert.ok(near(tipDepth({ ...tx, depthControl: { type: 'off' }, depthJitter: 1 }, { index: 0 }, () => 0.99), 0.8 * 0.25));
});

test('Dual Brush: the modes, the trail\'s spacing, count and scatter, and its coverage on a reduced mask', () => {
  for (const mode of DUAL_MODES) {
    assert.ok(dualCombine(mode, 0.7, 1) >= dualCombine(mode, 0.7, 0) - 1e-9, mode);
  }
  assert.equal(dualCombine('multiply', 0.5, 0.5), 0.25);
  assert.equal(dualCombine('color-burn', 0.8, 0), 0);
  assert.ok(near(dualCombine('color-burn', 0.8, 0.5), 0.6));
  assert.equal(dualCombine('hard-mix', 0.6, 0.3), 0);
  assert.equal(dualCombine('hard-mix', 0.6, 0.5), 0.6);
  const raster = computedTipRaster(10, 1);
  assert.equal(raster.side, 12);
  assert.equal(raster.data[6 * 12 + 6], 1);
  assert.equal(raster.data[0], 0);
  // spacing 50 % of 10 px: a dab every 5 px along the path
  const trail = new DualTrail({ size: 10, spacing: 0.5 });
  trail.extend(0, 0);
  trail.extend(20, 0);
  assert.equal(trail.length, 5);
  assert.deepEqual(trail.near({ x: 18, y: -1, width: 2, height: 2 }).map((d) => d.x).sort((a, b) => a - b), [15, 20]);
  const crowd = new DualTrail({ size: 10, spacing: 1, count: 3, scatter: 2, random: () => 1 });
  crowd.extend(0, 0);
  assert.equal(crowd.length, 3);
  assert.ok(crowd.near({ x: -100, y: -100, width: 200, height: 200 }).every((d) => near(d.y, 20)));
  // one dual dab at document (12, 12) over a mask of 8 x 8 mask px at scale 0.5 starting at canvas (0, 0), canvas at document (4, 4)
  const mask = { data: new Float32Array(64).fill(1), width: 8, height: 8, x: 0, y: 0, scale: 0.5 };
  const d = dualCoverage(mask, [{ x: 12, y: 12, flipX: false, flipY: false }], raster, { ox: 4, oy: 4, size: 10 });
  // mask px (4, 4) covers canvas 8..9, document 12..13: the dab's centre; mask px (0, 0) is document 4..5: outside
  assert.equal(d[4 * 8 + 4], 1);
  assert.equal(d[0], 0);
});

// ---- .abr ---------------------------------------------------------------------------------------------------------

/** A grey PNG of a coverage plane, as the `brushes` kind keeps tips (through the stub's sync writer, via brushFromAgPsd). */
function tipBlob(w, h, alpha) {
  const r = brushFromAgPsd({ name: 'x', shape: { type: 'sampled', size: Math.max(w, h), sampledData: 's' } }, new Map([['s', { width: w, height: h, alpha }]]));
  const [[name, bytes]] = Object.entries(r.blobs);
  return { name, bytes, ref: r.preset.tip.sample };
}

const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'blob' || k === 'hash' ? undefined : v)));

test('.abr: every section survives Pigment\'s writer and reader, sampled tips and the texture\'s pattern included', async () => {
  assert.equal(ABR_REAL, true);
  const alpha = Uint8Array.from({ length: 12 }, (_, i) => i * 20);
  const tip = tipBlob(4, 3, alpha);
  const dualAlpha = Uint8Array.from({ length: 4 }, (_, i) => 255 - i * 60);
  const dual = tipBlob(2, 2, dualAlpha);
  const blobs = { [tip.name]: tip.bytes, [dual.name]: dual.bytes };
  const textured = normalizeBrush({
    tip: { kind: 'sampled', sample: tip.ref, size: 48, hardness: 1, angle: -30, roundness: 0.5, spacing: 0.35, spacingOn: true, flipX: true },
    shapeDynamics: { enabled: true, sizeJitter: 0.3, sizeControl: { type: 'fade', fadeSteps: 40 }, minimumDiameter: 0.2, tiltScale: 1.5, angleJitter: 0.25, angleControl: { type: 'direction' }, roundnessJitter: 0.4, roundnessControl: { type: 'pen-tilt' }, minimumRoundness: 0.3, flipXJitter: true, brushProjection: true },
    scattering: { enabled: true, scatter: 2.5, bothAxes: true, scatterControl: { type: 'pen-pressure' }, count: 3, countJitter: 0.5, countControl: { type: 'stylus-wheel' } },
    texture: { enabled: true, pattern: { presetId: 'my-pattern', name: 'Mine' }, invert: true, scale: 0.75, brightness: 20, contrast: -10, eachTip: true, mode: 'linear-height', depth: 0.6, minimumDepth: 0.1, depthJitter: 0.2, depthControl: { type: 'pen-pressure' } },
    dualBrush: { enabled: true, mode: 'darken', flip: true, tip: { kind: 'sampled', sample: dual.ref, size: 12, hardness: 1, angle: 10, roundness: 0.8, spacing: 0.5 }, scatter: 1.5, bothAxes: true, count: 2, countJitter: 0.25 },
    colorDynamics: { enabled: true, perTip: false, fbJitter: 0.5, fbControl: { type: 'fade', fadeSteps: 10 }, hueJitter: 0.1, saturationJitter: 0.2, brightnessJitter: 0.3, purity: -0.4 },
    transfer: { enabled: true, opacityJitter: 0.6, opacityControl: { type: 'pen-pressure' }, minimumOpacity: 0.1, flowJitter: 0.3, flowControl: { type: 'fade', fadeSteps: 5 }, minimumFlow: 0.2 },
    brushPose: { enabled: true, tiltX: 0.5, tiltY: -0.25, rotation: 90, pressure: 0.7, overrideTilt: true, overrideRotation: true, overridePressure: false },
    noise: true, wetEdges: true, buildUp: true, smoothCurves: true, protectTexture: true,
    tool: { opacity: 0.5, flow: 0.25, blend: 'multiply', smoothing: 0.3 },
  });
  const round = normalizeBrush({ tip: { size: 9, hardness: 0.35, spacing: 0.1, spacingOn: false } });
  const pattern = { name: 'Mine', width: 3, height: 2, data: Uint8ClampedArray.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 255 : i * 10)) };
  const { bytes, report } = await writeAbrFile([{ name: 'Textured', data: textured }, { name: 'Round', data: round }], {
    readBlob: async (kind, name) => (kind === 'brushes' ? blobs[name] ?? null : null),
    patternPixels: async (id) => (id === 'my-pattern' ? pattern : null),
  });
  assert.deepEqual(report, []);
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 6, 0, 2]);
  const res = await readAbrFile(bytes, { name: 'C:\\brushes\\My Set.abr' });
  assert.deepEqual(res.report, []);
  assert.deepEqual(res.groups, [{ kind: 'brushes', id: 'file', name: 'My Set' }]);
  const pats = res.items.filter((it) => it.kind === 'patterns');
  const brushes = res.items.filter((it) => it.kind === 'brushes');
  assert.equal(pats.length, 1);
  assert.deepEqual(brushes.map((b) => [b.name, b.group]), [['Textured', 'file'], ['Round', 'file']]);
  // the pattern: its pixels as a PNG blob of `patterns`, named by the textured brush through a $presetRef
  const pat = pats[0];
  assert.deepEqual([pat.name, pat.data.width, pat.data.height, pat.data.mode], ['Mine', 3, 2, 'rgb']);
  const px = toRgba8(await decodePng(pat.blobs[pat.data.blob]));
  assert.deepEqual([...px.data], [...pattern.data]);
  const got = brushes[0].data;
  assert.deepEqual(got.texture.pattern, { $presetRef: { kind: 'patterns', ref: pat.ref } });
  // every other field as written
  const want = strip({ ...textured, texture: { ...textured.texture, pattern: null } });
  assert.deepEqual(strip({ ...got, texture: { ...got.texture, pattern: null } }), want);
  // the tips come back as the same content-addressed blobs
  assert.equal(got.tip.sample.blob, tip.name);
  assert.deepEqual(Object.keys(brushes[0].blobs).sort(), [tip.name, dual.name].sort());
  assert.equal(`tip-${createHash('sha1').update(brushes[0].blobs[tip.name]).digest('hex')}.png`, tip.name);
  assert.deepEqual(strip(brushes[1].data), strip(round));
  // the descriptor writes Photoshop's keys
  const desc = brushDescriptor(textured, { tip: 'a', dual: 'b', pattern: { id: 'p', name: 'Mine' } });
  for (const k of ['Brsh', 'useTipDynamics', 'szVr', 'useScatter', 'useTexture', 'Txtr', 'dualBrush', 'useColorDynamics', 'usePaintDynamics', 'useBrushPose', 'Wtdg', 'Nose', 'toolOptions']) assert.ok(k in desc.items, k);
  assert.equal(desc.items.Brsh.classId, 'sampledBrush');
});

test('.abr: missing tips and patterns are reported on write; Behind is written as Normal', async () => {
  const p = normalizeBrush({ tip: { kind: 'sampled', sample: { blob: 'tip-gone.png', hash: 'gone', width: 2, height: 2 }, size: 10 }, texture: { enabled: true, pattern: { presetId: 'gone', name: 'Gone' } }, tool: { blend: 'behind' } });
  const { bytes, report } = await writeAbrFile([{ name: 'Lost', data: p }], { readBlob: async () => null, patternPixels: async () => null });
  assert.equal(report.length, 3);
  const res = await readAbrFile(bytes, { name: 'lost.abr' });
  const b = res.items.find((it) => it.kind === 'brushes').data;
  assert.equal(b.tip.kind, 'computed');
  assert.equal(b.texture.enabled, false);
  assert.equal(b.tool.blend, 'normal');
});

/** An .abr of version 1 or 2 (Photoshop 7 and older), as GIMP reads them: one computed and one sampled brush. */
function oldAbr(version, { rle = false } = {}) {
  const out = [];
  const u8 = (v) => out.push(v & 255);
  const i16 = (v) => out.push((v >> 8) & 255, v & 255);
  const i32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  i16(version);
  i16(2);
  // computed: misc, spacing, diameter, roundness, angle, hardness
  i16(1);
  i32(14);
  i32(0);
  i16(25);
  i16(17);
  i16(60);
  i16(45);
  i16(80);
  // sampled 3 x 2
  const body = [];
  const b8 = (v) => body.push(v & 255);
  const b16 = (v) => body.push((v >> 8) & 255, v & 255);
  const b32 = (v) => body.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  b32(0);
  b16(30);
  if (version === 2) {
    const name = 'Leaf';
    b32(name.length + 1);
    for (const ch of name) b16(ch.charCodeAt(0));
    b16(0);
  }
  b8(1);
  for (let k = 0; k < 4; k++) b16(0);
  b32(0); b32(0); b32(2); b32(3);
  b16(8);
  b8(rle ? 1 : 0);
  const rows = [[0, 128, 255], [255, 255, 7]];
  if (!rle) for (const row of rows) body.push(...row);
  else {
    // row 1 literal (3 bytes), row 2 a run of two 255s then a literal 7
    const packed = [[2, 0, 128, 255], [255, 255, 0, 7]];
    for (const p of packed) b16(p.length);
    for (const p of packed) body.push(...p);
  }
  i16(2);
  i32(body.length);
  out.push(...body);
  return Uint8Array.from(out);
}

test('.abr versions 1 and 2: computed and sampled tips, raw and RLE samples', async () => {
  for (const [version, rle] of [[1, false], [2, false], [2, true]]) {
    const res = await readAbrFile(oldAbr(version, { rle }), { name: 'old.abr' });
    assert.deepEqual(res.report, [], `v${version}`);
    const [computed, sampled] = res.items;
    assert.deepEqual([computed.data.tip.kind, computed.data.tip.size, computed.data.tip.hardness, computed.data.tip.roundness, computed.data.tip.angle, computed.data.tip.spacing], ['computed', 17, 0.8, 0.6, 45, 0.25]);
    assert.equal(sampled.data.tip.kind, 'sampled');
    assert.equal(sampled.name, version === 2 ? 'Leaf' : 'Sampled Brush 2');
    assert.deepEqual([sampled.data.tip.sample.width, sampled.data.tip.sample.height, sampled.data.tip.size, sampled.data.tip.spacing], [3, 2, 3, 0.3]);
    const px = toRgba8(await decodePng(sampled.blobs[sampled.data.tip.sample.blob]));
    assert.deepEqual([...px.data].filter((_, i) => i % 4 === 0), [0, 128, 255, 255, 255, 7]);
  }
});

test('.abr: truncated, damaged and foreign files are reported, never thrown', async () => {
  const good = (await writeAbrFile([{ name: 'A', data: normalizeBrush({ tip: { size: 5 } }) }], { readBlob: async () => null })).bytes;
  for (const bytes of [new Uint8Array(0), Uint8Array.from([0, 3, 0, 1]), good.subarray(0, good.length - 9), good.subarray(0, 20), Uint8Array.from([0, 6, 0, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), oldAbr(2).subarray(0, 30)]) {
    const res = await readAbrFile(bytes, { name: 'bad.abr' });
    assert.ok(Array.isArray(res.items));
    assert.ok(res.report.length > 0, `report for ${bytes.length} bytes`);
  }
  // brushFromAgPsd on rubbish: the default round brush and a report line
  const r = brushFromAgPsd({ name: 'Odd', shape: { type: 'dynamic', size: 30 }, texture: { id: 'x', name: 'X', blendMode: 'multiply' } });
  assert.equal(r.preset.tip.kind, 'computed');
  assert.equal(r.preset.tip.size, 30);
  assert.ok(r.preset.tip.extras.abr);
  assert.ok(r.report.some((l) => /bristle/.test(l)));
  assert.ok(r.report.some((l) => /pattern/.test(l)));
});
