// adjust-tonal (0.4 package 7): Levels and Curves in every channel space, drawn curves, Auto, eyedroppers, the
// clipping display, Equalize from a measured histogram, and the .alv / .acv files and preset kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENTS, applyAdjustment, autoLevels, autoContrast } from '../../src/shared/pixels/adjust.js';
import {
  levelsLut, curveLut, composeLut, tonalLuts, tonalRgbLuts, applyTonal, tonalDeepExact, remapTonalSpace, spaceForMode, isIdentityTonal,
  tableLut, drawTable, smoothTable, pointsFromTable, tableFromPoints, clippingView, weightedHistogram,
  autoLevelsParams, autoTonalParams, curvePointsFromLevels, levelsEyedropper, curvesEyedropper, exposureEyedropper, gammaFor,
} from '../../src/shared/pixels/adjust-tonal.js';
import { isExactKind } from '../../src/shared/pixels/deep.js';
import { rgbToCmyk, rgbToLab } from '../../src/shared/pixels/color.js';
import { readAcv, writeAcv, readAlv, writeAlv, TONAL_BUILTINS, normalizeTonalPreset } from '../../src/renderer/lib/adjust/tonal-formats.js';
import { registerTonalPresets, adjustmentPresetKind } from '../../src/renderer/lib/adjust/presets.js';
import { PresetStore } from '../../src/renderer/lib/presets.js';

const img = (pixels, width = pixels.length) => ({ width, height: pixels.length / width, data: new Uint8ClampedArray(pixels.flatMap((p) => (p.length === 4 ? p : [...p, 255]))) });
const px = (im, i) => Array.from(im.data.slice(i * 4, i * 4 + 4));
const ramp = () => img(Array.from({ length: 256 }, (_, v) => [v, v, v]));
function noise(n = 400, seed = 7) {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 256);
  return img(Array.from({ length: n }, () => [r(), r(), r()]), 20);
}
const copy = (im) => ({ width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) });

test('RGB Levels and Curves give exactly 0.3’s tables (channel first, then composite), with and without perChannel', () => {
  const p = { rgb: { inBlack: 20, inWhite: 230, gamma: 1.3, outBlack: 5, outWhite: 250 }, r: { inBlack: 40, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, g: null, b: { gamma: 0.8 } };
  const master = levelsLut(p.rgb);
  const a = noise();
  applyAdjustment(a, 'levels', p);
  const b = noise();
  const luts = [composeLut(master, levelsLut(p.r)), master, composeLut(master, levelsLut(p.b))];
  for (let i = 0; i < b.data.length; i += 4) for (let c = 0; c < 3; c++) b.data[i + c] = luts[c][b.data[i + c]];
  assert.deepEqual(a.data, b.data);
  const off = noise();
  applyAdjustment(off, 'levels', { ...p, perChannel: false });
  const m = noise();
  for (let i = 0; i < m.data.length; i += 4) for (let c = 0; c < 3; c++) m.data[i + c] = master[m.data[i + c]];
  assert.deepEqual(off.data, m.data);
  // the registry still exposes the tables as `lut` for RGB params
  const cv = { rgb: [[0, 0], [100, 140], [255, 255]], g: [[0, 30], [255, 255]] };
  const [lr, lg] = ADJUSTMENTS.curves.lut(cv);
  assert.deepEqual(lr, curveLut(cv.rgb));
  assert.deepEqual(lg, composeLut(curveLut(cv.rgb), curveLut(cv.g)));
});

test('drawn (pencil) curves: tables apply as drawn, drawing and Smooth keep the ends, points come back close', () => {
  const t = { table: Array.from({ length: 256 }, (_, v) => 255 - v) };
  const a = ramp();
  applyAdjustment(a, 'curves', { rgb: t });
  assert.deepEqual(px(a, 10), [245, 245, 245, 255]);
  assert.deepEqual(Array.from(tableLut({ table: [1.6, ...Array(255).fill(300)] }).slice(0, 2)), [2, 255]);
  // a stroke from (50, 200) to (100, 100) sets that run of the table along a straight line
  const drawn = drawTable([[0, 0], [255, 255]], 100, 100, 50, 200);
  assert.equal(drawn.table[50], 200);
  assert.equal(drawn.table[75], 150);
  assert.equal(drawn.table[100], 100);
  assert.equal(drawn.table[49], 49);
  // Smooth: a step becomes a slope; the end values stay
  const step = { table: Array.from({ length: 256 }, (_, v) => (v < 128 ? 0 : 255)) };
  const sm = smoothTable(step);
  assert.equal(sm.table[0], 0);
  assert.equal(sm.table[255], 255);
  assert.ok(sm.table[126] > 0 && sm.table[126] < 255 && sm.table[129] > sm.table[126]);
  for (let v = 1; v < 256; v++) assert.ok(sm.table[v] >= sm.table[v - 1], 'stays monotone');
  // points from a table (Photoshop's switch back to the point mode) follow it within a few levels
  const curve = [[0, 10], [80, 120], [200, 210], [255, 240]];
  const back = curveLut(pointsFromTable(tableFromPoints(curve)));
  const want = curveLut(curve);
  for (let v = 0; v < 256; v++) assert.ok(Math.abs(back[v] - want[v]) <= 4, `v ${v}: ${back[v]} vs ${want[v]}`);
  // deep.js keeps its float path only for RGB without drawn curves
  assert.equal(isExactKind('curves', { rgb: [[0, 0], [128, 150], [255, 255]] }), true);
  assert.equal(isExactKind('curves', { rgb: t }), false);
  assert.equal(isExactKind('levels', { space: 'cmyk', cmyk: { gamma: 1.2 } }), false);
  assert.equal(tonalDeepExact('levels', { space: 'rgb' }), true);
});

test('channel spaces: Gray, CMYK and Lab convert from and to the stored RGB; identity params change nothing', () => {
  assert.equal(spaceForMode('grayscale'), 'gray');
  assert.equal(spaceForMode('cmyk'), 'cmyk');
  assert.equal(spaceForMode('lab'), 'lab');
  assert.equal(spaceForMode('rgb'), 'rgb');
  const src = noise();
  for (const space of ['gray', 'cmyk', 'lab']) {
    const keys = { gray: ['gray'], cmyk: ['cmyk', 'c', 'm', 'y', 'k'], lab: ['l', 'a', 'b'] }[space];
    const p = { space, ...Object.fromEntries(keys.map((k) => [k, null])) };
    const a = copy(src);
    applyAdjustment(a, 'levels', p);
    assert.deepEqual(a.data, src.data, `${space} identity`);
    assert.ok(isIdentityTonal('curves', { space, ...Object.fromEntries(keys.map((k) => [k, [[0, 0], [255, 255]]])) }));
  }
  // Gray: the gray table applies to r, g and b alike
  const g = img([[100, 100, 100]]);
  applyAdjustment(g, 'levels', { space: 'gray', gray: { inBlack: 50, inWhite: 150 } });
  assert.deepEqual(px(g, 0), [128, 128, 128, 255]);
  // CMYK: darkening the Black channel's brightness adds black ink: a mid grey gets darker, white keeps no ink... unless
  // the output white of K moves
  const c = img([[128, 128, 128], [255, 255, 255], [255, 0, 0]]);
  applyAdjustment(c, 'curves', { space: 'cmyk', k: [[0, 0], [128, 64], [255, 255]] });
  assert.ok(px(c, 0)[0] < 100, `grey darkens: ${px(c, 0)}`);
  assert.deepEqual(px(c, 1), [255, 255, 255, 255]);
  assert.deepEqual(px(c, 2), [255, 0, 0, 255]);
  // CMYK: cyan ink removed from a cyan-ish colour (its Cyan channel brightened to white)
  const cy = img([[40, 200, 220]]);
  const before = rgbToCmyk(40, 200, 220);
  applyAdjustment(cy, 'levels', { space: 'cmyk', c: { outBlack: 255 } });
  const after = rgbToCmyk(...px(cy, 0).slice(0, 3));
  assert.ok(before[0] > 50 && after[0] < 2, `${before} -> ${after}`);
  // Lab: Lightness up keeps a and b (about); a channel shift turns a grey reddish
  const l = img([[90, 120, 160]]);
  const lab0 = rgbToLab(90, 120, 160);
  applyAdjustment(l, 'levels', { space: 'lab', l: { gamma: 1.5 } });
  const lab1 = rgbToLab(...px(l, 0).slice(0, 3));
  assert.ok(lab1[0] > lab0[0] + 5 && Math.abs(lab1[1] - lab0[1]) < 3 && Math.abs(lab1[2] - lab0[2]) < 3, `${lab0} -> ${lab1}`);
  const red = img([[128, 128, 128]]);
  applyAdjustment(red, 'curves', { space: 'lab', a: [[0, 20], [255, 255]] });
  assert.ok(px(red, 0)[0] > px(red, 0)[1] + 10, `reddish: ${px(red, 0)}`);
  // `lut` (deep.js) of a CMYK set is exact on the grey axis
  const luts = tonalRgbLuts('curves', { space: 'cmyk', k: [[0, 0], [128, 64], [255, 255]] });
  const gy = img([[128, 128, 128]]);
  applyTonal('curves', gy, { space: 'cmyk', k: [[0, 0], [128, 64], [255, 255]] });
  assert.equal(luts[0][128], px(gy, 0)[0]);
  // a preset made in RGB, used in CMYK: the composite goes to the composite, the channels by position
  const re = remapTonalSpace('levels', { space: 'rgb', rgb: { gamma: 2 }, r: { inBlack: 9 }, g: null, b: null }, 'cmyk');
  assert.deepEqual(re, { space: 'cmyk', cmyk: { gamma: 2 }, c: { inBlack: 9 }, m: null, y: null, k: null });
  assert.equal(tonalLuts('levels', re).keys.join(), 'c,m,y,k');
});

test('the clipping display: shadows white except where channels clip to black, highlights the reverse', () => {
  const p = { rgb: { inBlack: 100, inWhite: 200 } };
  const a = ramp();
  clippingView(a, 'levels', p, 'shadows');
  assert.deepEqual(px(a, 100), [0, 0, 0, 255]);
  assert.deepEqual(px(a, 101), [255, 255, 255, 255]);
  const b = ramp();
  clippingView(b, 'levels', p, 'highlights');
  assert.deepEqual(px(b, 199), [0, 0, 0, 255]);
  assert.deepEqual(px(b, 200), [255, 255, 255, 255]);
  // one clipped channel shows in its colour
  const c = img([[250, 120, 120]]);
  clippingView(c, 'curves', { rgb: [[0, 0], [230, 255]] }, 'highlights');
  assert.deepEqual(px(c, 0), [255, 0, 0, 255]);
  // Gray space: grey levels
  const d = img([[30, 30, 30], [200, 200, 200]]);
  clippingView(d, 'levels', { space: 'gray', gray: { inBlack: 50 } }, 'shadows');
  assert.deepEqual([px(d, 0)[0], px(d, 1)[0]], [0, 255]);
});

test('Auto: Per Channel and Monochromatic Contrast match 0.3’s Auto Tone and Auto Contrast; targets and Snap Neutral Midtones', () => {
  const src = img(Array.from({ length: 300 }, (_, i) => [30 + (i % 150), 50 + ((i * 7) % 120), 20 + ((i * 3) % 170)]), 20);
  const opts = { shadowClip: 0.1, highlightClip: 0.1 };
  const tone = copy(src);
  autoLevels(tone, { clip: 0.1 });
  const mine = copy(src);
  applyAdjustment(mine, 'levels', autoLevelsParams(src, { ...opts, algorithm: 'perChannel' }));
  assert.deepEqual(mine.data, tone.data);
  const con = copy(src);
  autoContrast(con, { clip: 0.1 });
  const mono = autoLevelsParams(src, { ...opts, algorithm: 'mono' });
  assert.equal(mono.r, null, 'a neutral stretch goes into the composite');
  const mine2 = copy(src);
  applyAdjustment(mine2, 'levels', mono);
  assert.deepEqual(mine2.data, con.data);
  // target colours: the shadows go to the shadow target
  const tgt = autoLevelsParams(src, { algorithm: 'perChannel', shadowColor: '#102030' });
  assert.deepEqual([tgt.r.outBlack, tgt.g.outBlack, tgt.b.outBlack], [16, 32, 48]);
  // Find Dark & Light Colors: the darkest and lightest pixels' own colours become black and white
  const dl = autoLevelsParams(img([[20, 30, 40], [100, 100, 100], [200, 210, 220]]), { algorithm: 'darkLight', shadowClip: 0.5, highlightClip: 0.5 });
  assert.deepEqual([dl.r.inBlack, dl.g.inBlack, dl.b.inBlack, dl.r.inWhite, dl.b.inWhite], [20, 30, 40, 200, 220]);
  // Snap Neutral Midtones: a warm cast on greys goes
  const cast = img(Array.from({ length: 100 }, (_, i) => { const v = 60 + i; return [v + 20, v, v - 15]; }), 10);
  const snapped = autoLevelsParams(cast, { algorithm: 'perChannel', snap: true, shadowClip: 0, highlightClip: 0 });
  const out = copy(cast);
  applyAdjustment(out, 'levels', snapped);
  const mid = px(out, 50);
  assert.ok(Math.max(...mid.slice(0, 3)) - Math.min(...mid.slice(0, 3)) <= 4, `neutral: ${mid}`);
  // Enhance Brightness and Contrast moves a dark image's median up
  const dark = img(Array.from({ length: 100 }, (_, i) => [i, i, i]), 10);
  const bc = autoLevelsParams(dark, { algorithm: 'brightness' });
  assert.ok(bc.rgb.gamma > 1, `gamma ${bc.rgb.gamma}`);
  // Curves from Auto: the same stretch as points; other spaces take the luma stretch on the composite / Lightness
  const cv = autoTonalParams('curves', src, { algorithm: 'mono' });
  assert.equal(cv.space, 'rgb');
  const viaCurves = copy(src);
  applyAdjustment(viaCurves, 'curves', cv);
  assert.deepEqual(viaCurves.data, con.data);
  assert.deepEqual(curvePointsFromLevels({ inBlack: 10, inWhite: 200 }), [[10, 0], [200, 255]]);
  assert.equal(autoTonalParams('levels', src, null, 'cmyk').space, 'cmyk');
  assert.ok(autoTonalParams('levels', src, null, 'lab').l.inBlack > 0);
});

test('eyedroppers: white and black points make the sample white or black; grey makes it neutral, keeping its brightness', () => {
  const sample = [200, 180, 160, 255];
  const w = levelsEyedropper({ rgb: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } }, 'white', sample);
  const a = img([[200, 180, 160]]);
  applyAdjustment(a, 'levels', w);
  assert.deepEqual(px(a, 0), [255, 255, 255, 255]);
  const bk = levelsEyedropper({}, 'black', [30, 40, 50, 255]);
  const b = img([[30, 40, 50], [100, 100, 100]]);
  applyAdjustment(b, 'levels', bk);
  assert.deepEqual(px(b, 0), [0, 0, 0, 255]);
  const gr = levelsEyedropper({}, 'gray', [140, 120, 100, 255]);
  const c = img([[140, 120, 100]]);
  applyAdjustment(c, 'levels', gr);
  const v = px(c, 0);
  assert.ok(Math.max(...v.slice(0, 3)) - Math.min(...v.slice(0, 3)) <= 2, `neutral ${v}`);
  assert.ok(Math.abs(v[1] - Math.round(0.299 * 140 + 0.587 * 120 + 0.114 * 100)) <= 2);
  // Curves: the same three
  for (const [which, want] of [['white', 255], ['black', 0]]) {
    const p = curvesEyedropper({ rgb: [[0, 0], [255, 255]] }, which, [120, 130, 140, 255]);
    const d = img([[120, 130, 140]]);
    applyAdjustment(d, 'curves', p);
    assert.deepEqual(px(d, 0), [want, want, want, 255], which);
  }
  const cg = curvesEyedropper({}, 'gray', [150, 120, 90, 255]);
  const e = img([[150, 120, 90]]);
  applyAdjustment(e, 'curves', cg);
  assert.ok(Math.max(...px(e, 0).slice(0, 3)) - Math.min(...px(e, 0).slice(0, 3)) <= 2, `${px(e, 0)}`);
  // a drawn channel becomes points first
  assert.ok(Array.isArray(curvesEyedropper({ r: { table: Array.from({ length: 256 }, (_, i) => i) } }, 'white', [200, 200, 200, 255]).r));
  // Gray documents: black / white on the gray channel, no grey eyedropper
  const gp = levelsEyedropper({ space: 'gray', gray: null }, 'white', [128, 128, 128, 255]);
  assert.equal(gp.gray.inWhite, 128);
  assert.deepEqual(levelsEyedropper({ space: 'gray' }, 'gray', [128, 60, 60, 255]), { space: 'gray' });
  // Exposure: the white eyedropper's sample reaches white, the grey one middle grey
  const ex = exposureEyedropper({}, 'white', [64, 64, 64, 255]);
  const f = img([[64, 64, 64]]);
  applyAdjustment(f, 'exposure', ex);
  assert.ok(px(f, 0)[0] >= 254, `${px(f, 0)} ${ex.exposure}`);
  const eg = exposureEyedropper({}, 'gray', [200, 200, 200, 255]);
  const h = img([[200, 200, 200]]);
  applyAdjustment(h, 'exposure', eg);
  assert.ok(Math.abs(px(h, 0)[0] - 128) <= 1, `${px(h, 0)}`);
  assert.equal(gammaFor(128, { inBlack: 0, inWhite: 255, outBlack: 0, outWhite: 255 }, 128), 1 / 1 * Math.log(128 / 255) / Math.log(128 / 255));
});

test('Equalize measures one area and maps another (Equalize entire image based on selected area)', () => {
  const a = ramp();
  // the histogram of a dark area (values 0..63 only) spreads them over the whole range
  const sel = new Uint8Array(256).map((_, i) => (i < 64 ? 255 : 0));
  const h = weightedHistogram(a, null, sel);
  assert.equal(h.count, 64);
  applyAdjustment(a, 'equalize', { hist: Array.from(h.l) });
  assert.ok(px(a, 63)[0] >= 250, `${px(a, 63)}`);
  assert.equal(px(a, 200)[0], 255);
  // without a histogram: 0.3's behaviour, its own pixels
  const b = ramp(), c = ramp();
  applyAdjustment(b, 'equalize', {});
  applyAdjustment(c, 'equalize');
  assert.deepEqual(b.data, c.data);
});

test('.acv and .alv files: round trips, Photoshop’s byte layout, damaged files refused', () => {
  const cv = { space: 'rgb', rgb: [[0, 0], [64, 48], [192, 208], [255, 255]], r: null, g: [[0, 20], [255, 240]], b: null };
  const bytes = writeAcv(cv);
  // version 1, four curves, the first with four points stored as (output, input)
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [0, 1, 0, 4, 0, 4, 0, 0]);
  assert.deepEqual(Array.from(bytes.slice(10, 14)), [0, 48, 0, 64]);
  assert.deepEqual(readAcv(bytes).params, cv);
  // a drawn curve is written as points that follow it
  const drawn = readAcv(writeAcv({ rgb: { table: Array.from({ length: 256 }, (_, v) => Math.round(255 * Math.sqrt(v / 255))) } })).params;
  assert.ok(Array.isArray(drawn.rgb) && drawn.rgb.length >= 9);
  assert.throws(() => readAcv(new Uint8Array([0, 9, 0, 1])), /Not a Curves file/);
  assert.throws(() => readAcv(new Uint8Array([0, 1, 0, 1, 0, 5, 0, 0])), /damaged/);
  // version 4 files with trailing data read the same
  const v4 = new Uint8Array([...bytes, 0x43, 0x72, 0x76, 0x20]);
  v4[1] = 4;
  assert.deepEqual(readAcv(v4).params, cv);

  const lv = { space: 'rgb', perChannel: true, rgb: { inBlack: 12, inWhite: 240, gamma: 1.37, outBlack: 3, outWhite: 251 }, r: { inBlack: 20, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, g: null, b: null };
  const lb = writeAlv(lv);
  assert.equal(lb.length, 2 + 29 * 10);
  assert.deepEqual(Array.from(lb.slice(0, 12)), [0, 2, 0, 12, 0, 240, 0, 3, 0, 251, 0, 137]);
  assert.deepEqual(readAlv(lb).params, lv);
  assert.throws(() => readAlv(new Uint8Array([0, 7, 0, 0, 0, 255, 0, 0, 0, 255, 0, 100])), /Not a Levels file/);
  const bad = writeAlv(lv);
  bad[11] = 0; // gamma 0
  bad[10] = 0;
  assert.throws(() => readAlv(bad), /damaged/);
  // a CMYK set keeps its composite and four channels through a file read in that space
  const ck = { space: 'cmyk', cmyk: { inBlack: 5, inWhite: 250, gamma: 1, outBlack: 0, outWhite: 255 }, c: null, m: { inBlack: 10, inWhite: 255, gamma: 1.2, outBlack: 0, outWhite: 255 }, y: null, k: null };
  assert.deepEqual(readAlv(writeAlv(ck), { space: 'cmyk' }).params, ck);
});

function memoryBackend() {
  const files = new Map();
  return {
    files,
    async read(kind) { return files.has(kind) ? JSON.parse(files.get(kind)) : null; },
    async write(kind, json) { if (json === null) files.delete(kind); else files.set(kind, JSON.stringify(json)); },
    async readBlob() { return null; },
    async writeBlob() {},
    async removeBlob() {},
  };
}

test('preset kinds: Photoshop-like built-ins, .alv / .acv import and export through the store', async () => {
  registerTonalPresets();
  for (const k of ['levels', 'curves', 'exposure', 'brightness-contrast', 'threshold']) assert.equal(adjustmentPresetKind(k), `adjustment:${k}`);
  assert.equal(adjustmentPresetKind('hue-saturation'), null);
  const store = new PresetStore({ backend: memoryBackend(), delay: 0 });
  assert.deepEqual(store.list('adjustment:levels').map((p) => p.name), TONAL_BUILTINS.levels.map((p) => p.name));
  assert.ok(store.list('adjustment:curves').some((p) => p.name === 'Strong Contrast (RGB)'));
  // every built-in survives its own normalize and applies
  for (const [kind, list] of Object.entries(TONAL_BUILTINS)) for (const p of list) {
    assert.ok(normalizeTonalPreset(kind, p.data), `${kind} ${p.id}`);
    applyAdjustment(noise(20), kind, p.data);
  }
  assert.equal(normalizeTonalPreset('curves', { rgb: 'x' }), null);
  const lv = { space: 'rgb', perChannel: true, rgb: { inBlack: 10, inWhite: 245, gamma: 1.2, outBlack: 0, outWhite: 255 }, r: null, g: null, b: null };
  const res = await store.importFile('adjustment:levels', writeAlv(lv), { name: 'Warm Up.alv' });
  assert.equal(res.added.length, 1);
  assert.equal(res.added[0].name, 'Warm Up');
  assert.deepEqual(res.added[0].data, lv);
  const out = await store.exportFile('adjustment:levels', [res.added[0].id], 'alv');
  assert.equal(out.ext, 'alv');
  assert.deepEqual(readAlv(out.bytes).params, lv);
  const cres = await store.importFile('adjustment:curves', writeAcv({ rgb: [[0, 0], [100, 150], [255, 255]] }), { name: 'c.acv' });
  assert.deepEqual(cres.added[0].data.rgb, [[0, 0], [100, 150], [255, 255]]);
  store.dispose();
});
