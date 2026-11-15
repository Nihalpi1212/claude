// Unit tests for the 0.3 adjustments group (builder "adjust-more"): lut.js, adjust-more.js, hdr.js,
// matting.js and channel-math.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENTS, applyAdjustment, curveLut } from '../../src/shared/pixels/adjust.js';
import { labStatistics, replaceColorMask, colorLookupTable } from '../../src/shared/pixels/adjust-more.js';
import { parseCube, parse3dl, parseLook, parseCsp, parseLut, lutFormat, writeCube, write3dl, applyLut3d, makeLut3d, identityLut3d, sampleLut, resampleLut, compactLut, isLut, LUT_PRESETS, LUT_PRESET_NAMES, presetLut } from '../../src/shared/pixels/lut.js';
import { hdrToning, hdrToningFloat, exposureFusion, estimateExposures, guidedBase, toneCurve } from '../../src/shared/pixels/hdr.js';
import { defringe, removeMatte, decontaminate, nearestSource } from '../../src/shared/pixels/matting.js';
import { applyImage, calculations, extractChannel } from '../../src/shared/pixels/channel-math.js';
import { blendImages } from '../../src/shared/pixels/blend.js';
import { rgbToLab } from '../../src/shared/pixels/color.js';
import { createImage, cloneImage, getPixel, setPixel, randomSeeded } from '../../src/shared/pixels/core.js';

function noiseImage(w, h, seed = 7, alpha = 255) {
  const img = createImage(w, h);
  const rnd = randomSeeded(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.floor(rnd() * 256);
    img.data[i + 1] = Math.floor(rnd() * 256);
    img.data[i + 2] = Math.floor(rnd() * 256);
    img.data[i + 3] = alpha;
  }
  return img;
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// ---------------------------------------------------------------------------------------------
// lut.js

test('.cube: a 3D table round-trips through write and parse (title, size, domain, data)', () => {
  const lut = makeLut3d(5, (r, g, b) => [r * 0.9 + 0.05, g ** 2, 1 - b], 'Round "trip"');
  const text = writeCube(lut);
  assert.match(text, /^TITLE "Round 'trip'"\nLUT_3D_SIZE 5\nDOMAIN_MIN 0\.000000 0\.000000 0\.000000\nDOMAIN_MAX 1\.000000 1\.000000 1\.000000\n/);
  const back = parseCube(text);
  assert.equal(back.type, '3d');
  assert.equal(back.size, 5);
  assert.equal(back.title, "Round 'trip'");
  assert.deepEqual(back.domainMin, [0, 0, 0]);
  assert.deepEqual(back.domainMax, [1, 1, 1]);
  assert.equal(back.data.length, 5 * 5 * 5 * 3);
  assert.ok(maxDiff(back.data, lut.data) < 1e-6);
  // red changes fastest: entry 1 is r = 0.25, g = b = 0
  assert.ok(Math.abs(back.data[3] - (0.25 * 0.9 + 0.05)) < 1e-6);
  assert.ok(Math.abs(back.data[5] - 1) < 1e-6);
  // writing the parsed table again gives the same text
  assert.equal(writeCube(back), text);
});

test('.cube: 1D tables, comments, DOMAIN and Resolve input ranges, and malformed files', () => {
  const lut = parseCube('# a comment\nTITLE "ramp"\nLUT_1D_SIZE 3\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n\n0 0 0\n0.5 0.25 1\n1 1 0\n');
  assert.equal(lut.type, '1d');
  assert.equal(lut.size, 3);
  assert.deepEqual(lut.domainMax, [2, 2, 2]);
  // input 0.5 is a quarter of the 0..2 domain: halfway between entries 0 and 1
  const o = sampleLut(lut, 0.5, 0.5, 0.5);
  assert.ok(Math.abs(o[0] - 0.25) < 1e-6 && Math.abs(o[1] - 0.125) < 1e-6 && Math.abs(o[2] - 0.5) < 1e-6);
  assert.equal(parseCube(writeCube(lut)).data.length, 9);
  const res = parseCube('LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0.0 4.0\n' + '0 0 0\n'.repeat(8));
  assert.deepEqual(res.domainMax, [4, 4, 4]);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /expected 8 rows/);
  assert.throws(() => parseCube('0 0 0\n'), /LUT_3D_SIZE or LUT_1D_SIZE/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n' + '0 0 x\n'.repeat(8)), /not a number/);
});

test('applyLut3d: an identity table leaves every pixel unchanged, with and without dither', () => {
  const img = noiseImage(40, 30, 3);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = (i * 7) % 256; // alpha must survive too
  for (const size of [2, 17, 33]) {
    for (const dither of [false, true]) {
      const out = cloneImage(img);
      applyLut3d(out, identityLut3d(size), { dither });
      assert.equal(maxDiff(out.data, img.data), 0, `size ${size} dither ${dither}`);
    }
  }
  // plain number[] data (the parsed form) behaves the same
  const plain = compactLut(identityLut3d(9));
  assert.ok(Array.isArray(plain.data));
  const out = cloneImage(img);
  applyLut3d(out, plain);
  assert.equal(maxDiff(out.data, img.data), 0);
});

test('applyLut3d: a channel-swap table swaps channels; trilinear interpolation between lattice points; rect limits writes', () => {
  const swap = makeLut3d(4, (r, g, b) => [b, g, r]);
  const img = noiseImage(16, 16, 11);
  const out = cloneImage(img);
  applyLut3d(out, swap);
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(out.data[i], img.data[i + 2]);
    assert.equal(out.data[i + 1], img.data[i + 1]);
    assert.equal(out.data[i + 2], img.data[i]);
    assert.equal(out.data[i + 3], img.data[i + 3]);
  }
  // a 2-point table that maps black -> (0.2, 0.2, 0.2) and white -> (0.6, 0.6, 0.6): linear in between
  const lin = makeLut3d(2, (r, g, b) => [0.2 + 0.4 * r, 0.2 + 0.4 * g, 0.2 + 0.4 * b]);
  const grey = createImage(3, 1, [51, 102, 204, 1]);
  applyLut3d(grey, lin);
  assert.deepEqual(px(grey, 0, 0), [Math.round((0.2 + 0.4 * 0.2) * 255), Math.round((0.2 + 0.4 * 0.4) * 255), Math.round((0.2 + 0.4 * 0.8) * 255), 255]);
  // rect
  const part = cloneImage(img);
  applyLut3d(part, swap, {}, { x: 4, y: 4, width: 4, height: 4 });
  assert.deepEqual(px(part, 3, 4), px(img, 3, 4));
  assert.deepEqual(px(part, 8, 7), px(img, 8, 7));
  assert.equal(px(part, 5, 5)[0], px(img, 5, 5)[2]);
  // a 1D table: per-channel curve
  const one = { type: '1d', size: 2, data: [1, 0, 0, 0, 1, 0.5] }; // r inverted, g identity, b halved
  const c = createImage(1, 1, [255, 128, 200, 1]);
  applyLut3d(c, one);
  assert.deepEqual(px(c, 0, 0), [0, 128, 100, 255]);
  // not a table: no-op
  const same = cloneImage(img);
  applyLut3d(same, { type: '3d', size: 3, data: [1, 2, 3] });
  assert.equal(maxDiff(same.data, img.data), 0);
});

test('dither only moves values that fall between two levels, by at most one level, and is position-stable', () => {
  // a table that lowers contrast so 8-bit inputs land between levels
  const soft = makeLut3d(2, (r, g, b) => [0.25 + r * 0.1, 0.25 + g * 0.1, 0.25 + b * 0.1]);
  const img = createImage(64, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) setPixel(img, x, y, [x * 4, x * 4, x * 4, 1]);
  const plain = cloneImage(img), dith = cloneImage(img), again = cloneImage(img);
  applyLut3d(plain, soft);
  applyLut3d(dith, soft, { dither: true });
  applyLut3d(again, soft, { dither: true });
  assert.equal(maxDiff(dith.data, again.data), 0);
  assert.ok(maxDiff(dith.data, plain.data) <= 1);
  let changed = 0;
  for (let i = 0; i < plain.data.length; i += 4) if (plain.data[i] !== dith.data[i]) changed++;
  assert.ok(changed > 20, `dither changed ${changed} pixels`);
  // the row means still agree (dither does not shift the image)
  let a = 0, b = 0;
  for (let i = 0; i < plain.data.length; i += 4) {
    a += plain.data[i];
    b += dith.data[i];
  }
  assert.ok(Math.abs(a - b) / (64 * 8) < 0.2);
});

test('.3dl: round trip (blue fastest in the file), input ramp, Mesh header and bit-depth detection', () => {
  const lut = makeLut3d(3, (r, g, b) => [r, g * 0.5, b * b]);
  const text = write3dl(lut, { bits: 12 });
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '0 512 1023');
  assert.equal(lines.length, 1 + 27);
  // second data row is r = 0, g = 0, b = 0.5 -> b² = 0.25 -> 1024 of 4095
  assert.equal(lines[2], `0 0 ${Math.round(0.25 * 4095)}`);
  const back = parse3dl(text);
  assert.equal(back.size, 3);
  assert.ok(maxDiff(back.data, lut.data) < 1 / 4095);
  // 10-bit data is detected from the largest value; a Mesh line overrides
  const ten = parse3dl('0 1023\n' + ['0 0 0', '0 0 1023', '0 1023 0', '0 1023 1023', '1023 0 0', '1023 0 1023', '1023 1023 0', '1023 1023 1023'].join('\n'));
  assert.equal(ten.size, 2);
  assert.ok(maxDiff(ten.data, identityLut3d(2).data) < 1e-9);
  const mesh = parse3dl('3DMESH\nMesh 1 12\n0 1023\n' + ['0 0 0', '0 0 1023', '0 1023 0', '0 1023 1023', '1023 0 0', '1023 0 1023', '1023 1023 0', '1023 1023 1023'].join('\n'));
  assert.ok(Math.abs(mesh.data[3] - 1023 / 4095) < 1e-9);
  assert.throws(() => parse3dl('0 1023\n0 0 0\n1 1 1\n'), /do not form a cube/);
});

test('.look (SpeedGrade hex floats and wrapped .cube) and .csp (pre-LUT domain and shaper) parse to the same tables', () => {
  const lut = makeLut3d(2, (r, g, b) => [g, b, r]);
  const bytes = new Uint8Array(new Float32Array(lut.data).buffer);
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const look = parseLook(`<?xml version="1.0" ?>\n<look name="Swap">\n <shaders/>\n <LUT>\n  <size>"2"</size>\n  <data>"${hex}"</data>\n </LUT>\n</look>`);
  assert.equal(look.size, 2);
  assert.equal(look.title, 'Swap');
  assert.ok(maxDiff(look.data, lut.data) < 1e-7);
  const wrapped = parseLook(`<look><LUT><![CDATA[\n${writeCube(lut)}]]></LUT></look>`);
  assert.ok(maxDiff(wrapped.data, lut.data) < 1e-6);
  assert.throws(() => parseLook('<look></look>'), /no <LUT>/);

  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(`${lut.data[i * 3]} ${lut.data[i * 3 + 1]} ${lut.data[i * 3 + 2]}`);
  const csp = parseCsp(`CSPLUTV100\n3D\n\nBEGIN METADATA\n"Swap csp"\nEND METADATA\n\n2\n0.0 2.0\n0.0 1.0\n2\n0.0 2.0\n0.0 1.0\n2\n0.0 2.0\n0.0 1.0\n\n2 2 2\n${rows.join('\n')}\n`);
  assert.equal(csp.size, 2);
  assert.equal(csp.title, 'Swap csp');
  assert.deepEqual(csp.domainMax, [2, 2, 2]); // a linear pre-LUT is the input domain
  const o = sampleLut(csp, 1, 0, 2); // half, zero, full of the domain -> (g, b, r) = (0, 1, 0.5)
  assert.ok(Math.abs(o[0]) < 1e-6 && Math.abs(o[1] - 1) < 1e-6 && Math.abs(o[2] - 0.5) < 1e-6);
  // a non-linear shaper is baked in: input 0.25 -> shaper 0.5 -> identity table 0.5
  const idRows = [];
  const id = identityLut3d(2);
  for (let i = 0; i < 8; i++) idRows.push(`${id.data[i * 3]} ${id.data[i * 3 + 1]} ${id.data[i * 3 + 2]}`);
  const pre = '3\n0.0 0.25 1.0\n0.0 0.5 1.0\n';
  const baked = parseCsp(`CSPLUTV100\n3D\n${pre}${pre}${pre}2 2 2\n${idRows.join('\n')}\n`);
  assert.ok(baked.size >= 33);
  const s = sampleLut(baked, 0.25, 0.25, 0.25);
  assert.ok(Math.abs(s[0] - 0.5) < 0.01, `shaped ${s[0]}`);
  const one = parseCsp(`CSPLUTV100\n1D\n2\n0 1\n0 1\n2\n0 1\n0 1\n2\n0 1\n0 1\n2\n0 0 0\n1 0.5 0.25\n`);
  assert.equal(one.type, '1d');
  assert.deepEqual(one.data, [0, 0, 0, 1, 0.5, 0.25]);
  // format detection by name, then by content
  assert.equal(lutFormat('', 'x.CUBE'), 'cube');
  assert.equal(lutFormat('CSPLUTV100\n3D', 'noext'), 'csp');
  assert.equal(lutFormat('<?xml version="1.0"?><look/>', ''), 'look');
  assert.equal(lutFormat('LUT_3D_SIZE 2', ''), 'cube');
  assert.equal(lutFormat('0 1023\n0 0 0', ''), '3dl');
  assert.equal(parseLut(writeCube(lut, { title: '' }), '/luts/My Grade.cube').title, 'My Grade');
  assert.equal(parseLut(new TextEncoder().encode(write3dl(lut)), 'a.3dl').size, 2);
});

test('resampleLut and compactLut keep the mapping; isLut rejects malformed tables', () => {
  const lut = makeLut3d(9, (r, g, b) => [r * g, g, 1 - b]);
  const big = resampleLut(lut, 17);
  assert.equal(big.size, 17);
  const a = sampleLut(lut, 0.3, 0.6, 0.9), b = sampleLut(big, 0.3, 0.6, 0.9);
  assert.ok(maxDiff(a, b) < 0.01);
  const c = compactLut(lut, 4);
  assert.ok(isLut(c) && Array.isArray(c.data));
  assert.ok(maxDiff(c.data, lut.data) <= 0.5e-4 + 1e-7);
  assert.equal(JSON.parse(JSON.stringify(c)).data.length, lut.data.length);
  assert.equal(isLut(null), false);
  assert.equal(isLut({ type: '3d', size: 2, data: [0, 0, 0] }), false);
  assert.equal(isLut({ type: '2d', size: 2, data: new Array(24).fill(0) }), false);
  assert.equal(compactLut({ type: '3d', size: 2, data: [] }), null);
});

test('LUT_PRESETS: at least 20 generated presets with Photoshop names, all within 0..1, each one a real change', () => {
  assert.ok(LUT_PRESET_NAMES.length >= 20, `${LUT_PRESET_NAMES.length} presets`);
  assert.deepEqual([...LUT_PRESET_NAMES].sort(), Object.keys(LUT_PRESETS).sort());
  for (const name of ['3Strip', 'Candlelight', 'Crisp Warm', 'Crisp Winter', 'Drop Blues', 'Edgy Amber', 'Foggy Night', 'Futuristic Bleak', 'Horror Blue', 'Kodak 5205', 'Late Sunset', 'Moonlight', 'Night from Day', 'Soft Warming', 'Teal Orange', 'Bleach Bypass', 'Sepia', 'Black & White']) {
    assert.ok(LUT_PRESET_NAMES.includes(name), name);
  }
  const id = identityLut3d(33);
  for (const name of LUT_PRESET_NAMES) {
    const lut = presetLut(name);
    assert.equal(lut.type, '3d');
    assert.equal(lut.size, 33);
    let lo = Infinity, hi = -Infinity, diff = 0;
    for (let i = 0; i < lut.data.length; i++) {
      const v = lut.data[i];
      assert.ok(Number.isFinite(v), `${name} has a non-finite entry`);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      diff += Math.abs(v - id.data[i]);
    }
    assert.ok(lo >= 0 && hi <= 1, `${name} range ${lo}..${hi}`);
    assert.ok(diff / lut.data.length > 0.005, `${name} is almost the identity`);
    assert.equal(presetLut(name), lut, 'tables are cached');
  }
  assert.equal(presetLut('nope'), null);
  // characters: Black & White is grey, Sepia is warm, Moonlight is dark and blue, Crisp Warm is warmer than Crisp Winter
  const bw = sampleLut(presetLut('Black & White'), 0.9, 0.2, 0.1);
  assert.ok(Math.abs(bw[0] - bw[1]) < 1e-6 && Math.abs(bw[1] - bw[2]) < 1e-6);
  const sepia = sampleLut(presetLut('Sepia'), 0.5, 0.5, 0.5);
  assert.ok(sepia[0] > sepia[1] && sepia[1] > sepia[2]);
  const moon = sampleLut(presetLut('Moonlight'), 0.5, 0.5, 0.5);
  assert.ok(moon[2] > moon[0] && moon[0] < 0.4);
  const warm = sampleLut(presetLut('Crisp Warm'), 0.5, 0.5, 0.5), cold = sampleLut(presetLut('Crisp Winter'), 0.5, 0.5, 0.5);
  assert.ok(warm[0] - warm[2] > 0.05 && cold[2] - cold[0] > 0.05);
});

// ---------------------------------------------------------------------------------------------
// adjust-more.js

test('registry: the four kinds are real (no placeholder), keep their names, defaults and flags', () => {
  const expect = { 'color-lookup': 'Color Lookup', 'hdr-toning': 'HDR Toning', 'match-color': 'Match Color', 'replace-color': 'Replace Color' };
  for (const [k, name] of Object.entries(expect)) {
    assert.equal(ADJUSTMENTS[k].name, name);
    assert.ok(!ADJUSTMENTS[k].placeholder, `${k} still a placeholder`);
  }
  assert.equal(ADJUSTMENTS['color-lookup'].layer, true);
  assert.equal(ADJUSTMENTS['hdr-toning'].smart, false);
  assert.equal(ADJUSTMENTS['match-color'].smart, false);
  assert.deepEqual(ADJUSTMENTS['color-lookup'].defaults, { preset: 'none', lut: null, dither: false });
  assert.deepEqual(ADJUSTMENTS['replace-color'].defaults, { colors: [], fuzziness: 40, localized: false, hue: 0, saturation: 0, lightness: 0 });
  // defaults are the identity for the three kinds that have one
  const img = noiseImage(12, 12, 5);
  for (const k of ['color-lookup', 'match-color', 'replace-color']) {
    const out = cloneImage(img);
    applyAdjustment(out, k, {});
    assert.equal(maxDiff(out.data, img.data), 0, k);
  }
});

test('color-lookup: a preset changes colour, a loaded table wins over the preset, alpha and pixels outside rect stay', () => {
  const img = noiseImage(10, 10, 9, 200);
  const sepia = cloneImage(img);
  applyAdjustment(sepia, 'color-lookup', { preset: 'Sepia' });
  let changed = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(sepia.data[i + 3], 200);
    assert.ok(sepia.data[i] >= sepia.data[i + 1] && sepia.data[i + 1] >= sepia.data[i + 2], 'sepia orders r >= g >= b');
    if (sepia.data[i] !== img.data[i]) changed++;
  }
  assert.ok(changed > 80);
  const swap = compactLut(makeLut3d(2, (r, g, b) => [b, g, r]));
  const out = cloneImage(img);
  applyAdjustment(out, 'color-lookup', { preset: 'Sepia', lut: swap });
  assert.equal(out.data[0], img.data[2]);
  assert.equal(colorLookupTable({ preset: 'none', lut: null }), null);
  assert.equal(colorLookupTable({ preset: 'Sepia' }), presetLut('Sepia'));
  assert.equal(colorLookupTable({ preset: 'Sepia', lut: swap }), swap);
  assert.equal(colorLookupTable({ preset: 'No Such Preset' }), null);
  const part = cloneImage(img);
  applyAdjustment(part, 'color-lookup', { preset: 'Black & White' }, { x: 0, y: 0, width: 5, height: 10 });
  assert.equal(px(part, 2, 2)[0], px(part, 2, 2)[1]);
  assert.deepEqual(px(part, 7, 7), px(img, 7, 7));
  // the JSON round trip adjustment layers go through keeps the table usable
  const viaJson = JSON.parse(JSON.stringify({ preset: 'none', lut: swap, dither: true }));
  const j = cloneImage(img);
  applyAdjustment(j, 'color-lookup', viaJson);
  assert.equal(j.data[0], img.data[2]);
});

/** Mid-gamut colour noise: every pixel well inside sRGB so statistics transfers do not clip. */
function pastelImage(w, h, seed, base, spread) {
  const img = createImage(w, h);
  const rnd = randomSeeded(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = base[0] + (rnd() - 0.5) * spread;
    img.data[i + 1] = base[1] + (rnd() - 0.5) * spread;
    img.data[i + 2] = base[2] + (rnd() - 0.5) * spread;
    img.data[i + 3] = 255;
  }
  return img;
}

test('labStatistics agrees with color.js rgbToLab and honours alpha, rect and a mask', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, [200, 80, 40, 1]);
  setPixel(img, 1, 0, [20, 120, 220, 1]);
  const a = rgbToLab(200, 80, 40), b = rgbToLab(20, 120, 220);
  const s = labStatistics(img);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(s.mean[k] - (a[k] + b[k]) / 2) < 1e-3, `mean ${k}`);
    assert.ok(Math.abs(s.std[k] - Math.abs(a[k] - b[k]) / 2) < 1e-3, `std ${k}`);
  }
  const left = labStatistics(img, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(Math.abs(left.mean[0] - a[0]) < 1e-3 && left.std[0] < 1e-6);
  const masked = labStatistics(img, null, new Uint8ClampedArray([0, 255]));
  assert.ok(Math.abs(masked.mean[1] - b[1]) < 1e-3);
  img.data[3] = 0; // transparent pixels carry no colour
  assert.ok(Math.abs(labStatistics(img).mean[2] - b[2]) < 1e-3);
  img.data[7] = 0;
  assert.equal(labStatistics(img), null);
});

test('match-color maps the source statistics onto the target within 2 Lab units', () => {
  const source = pastelImage(48, 48, 21, [170, 120, 90], 70);
  const target = pastelImage(48, 48, 22, [90, 130, 160], 50);
  const want = labStatistics(source);
  const before = labStatistics(target);
  assert.ok(Math.abs(before.mean[2] - want.mean[2]) > 15, 'the two images differ to begin with');
  const out = cloneImage(target);
  applyAdjustment(out, 'match-color', { source: want });
  const got = labStatistics(out);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(got.mean[k] - want.mean[k]) < 2, `mean ${k}: ${got.mean[k]} vs ${want.mean[k]}`);
    assert.ok(Math.abs(got.std[k] - want.std[k]) < 2, `std ${k}: ${got.std[k]} vs ${want.std[k]}`);
  }
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

test('match-color: fade blends back, luminance and colour intensity scale L and chroma, neutralize removes the cast, target statistics can be supplied', () => {
  const source = labStatistics(pastelImage(32, 32, 31, [170, 120, 90], 60));
  const target = pastelImage(32, 32, 32, [90, 130, 160], 50);
  const full = cloneImage(target), half = cloneImage(target), none = cloneImage(target);
  applyAdjustment(full, 'match-color', { source });
  applyAdjustment(half, 'match-color', { source, fade: 50 });
  applyAdjustment(none, 'match-color', { source, fade: 100 });
  assert.equal(maxDiff(none.data, target.data), 0);
  for (let i = 0; i < 400; i += 4) assert.ok(Math.abs(half.data[i] - (full.data[i] + target.data[i]) / 2) <= 1);
  // no source: luminance 120 raises mean L by 20 %, colour intensity 50 halves chroma
  const t0 = labStatistics(target);
  const lum = cloneImage(target);
  applyAdjustment(lum, 'match-color', { luminance: 120 });
  assert.ok(Math.abs(labStatistics(lum).mean[0] - t0.mean[0] * 1.2) < 1);
  const ci = cloneImage(target);
  applyAdjustment(ci, 'match-color', { colorIntensity: 50 });
  const c1 = labStatistics(ci);
  assert.ok(Math.abs(c1.mean[1] - t0.mean[1] / 2) < 1 && Math.abs(c1.mean[2] - t0.mean[2] / 2) < 1);
  assert.ok(Math.abs(c1.mean[0] - t0.mean[0]) < 1);
  const neutral = cloneImage(target);
  applyAdjustment(neutral, 'match-color', { neutralize: true });
  const n1 = labStatistics(neutral);
  assert.ok(Math.abs(n1.mean[1]) < 1 && Math.abs(n1.mean[2]) < 1, `cast left: ${n1.mean}`);
  assert.ok(Math.abs(t0.mean[2]) > 10);
  // explicit target statistics (the dialog passes the selection's): a shifted target mean shifts the result
  const shifted = cloneImage(target);
  applyAdjustment(shifted, 'match-color', { source, target: { mean: [t0.mean[0] - 10, t0.mean[1], t0.mean[2]], std: t0.std } });
  assert.ok(Math.abs(labStatistics(shifted).mean[0] - (source.mean[0] + 10 * (source.std[0] / t0.std[0]))) < 2);
  // rect limits the writes
  const part = cloneImage(target);
  applyAdjustment(part, 'match-color', { source }, { x: 0, y: 0, width: 8, height: 8 });
  assert.deepEqual(px(part, 20, 20), px(target, 20, 20));
  assert.notDeepEqual(px(part, 2, 2), px(target, 2, 2));
});

test('replace-color changes only colours within fuzziness', () => {
  const img = createImage(6, 1);
  const colours = [[255, 0, 0], [240, 10, 10], [225, 0, 0], [200, 0, 0], [0, 0, 255], [128, 128, 128]];
  colours.forEach((c, x) => setPixel(img, x, 0, [...c, 1]));
  const out = cloneImage(img);
  applyAdjustment(out, 'replace-color', { colors: [[255, 0, 0]], fuzziness: 40, hue: 120 });
  assert.deepEqual(px(out, 0, 0), [0, 255, 0, 255]); // the sampled red turns green
  assert.deepEqual(px(out, 1, 0), [10, 240, 10, 255]); // distance 15 <= fuzziness / 2: fully replaced
  // distance 30: half-way through the falloff -> half-way between red and green
  assert.deepEqual(px(out, 2, 0), [Math.round(225 * (1 - 128 / 255)), Math.round(225 * (128 / 255)), 0, 255]);
  assert.deepEqual(px(out, 3, 0), [200, 0, 0, 255]); // distance 55 > 40: untouched
  assert.deepEqual(px(out, 4, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(out, 5, 0), [128, 128, 128, 255]);
  const mask = replaceColorMask(img, { colors: [[255, 0, 0]], fuzziness: 40 });
  assert.deepEqual(Array.from(mask), [255, 255, 128, 0, 0, 0]);
  // nothing sampled or no shift: nothing happens
  const same = cloneImage(img);
  applyAdjustment(same, 'replace-color', { colors: [], hue: 90 });
  applyAdjustment(same, 'replace-color', { colors: [[255, 0, 0]] });
  assert.equal(maxDiff(same.data, img.data), 0);
});

test('replace-color: several colours, the subtract list, lightness / saturation, localized clusters and rect', () => {
  const img = createImage(4, 1);
  [[255, 0, 0], [0, 0, 255], [250, 0, 0], [0, 255, 0]].forEach((c, x) => setPixel(img, x, 0, [...c, 1]));
  const both = replaceColorMask(img, { colors: [[255, 0, 0], [0, 0, 255]], fuzziness: 20 });
  assert.deepEqual(Array.from(both), [255, 255, 255, 0]);
  const minus = replaceColorMask(img, { colors: [[255, 0, 0], [0, 0, 255]], exclude: [[0, 0, 255]], fuzziness: 20 });
  assert.deepEqual(Array.from(minus), [255, 0, 255, 0]);
  const grey = cloneImage(img);
  applyAdjustment(grey, 'replace-color', { colors: [[255, 0, 0]], fuzziness: 20, saturation: -100 });
  assert.deepEqual(px(grey, 0, 0), [76, 76, 76, 255]); // Rec. 601 luma of red, as Desaturate gives
  assert.deepEqual(px(grey, 1, 0), [0, 0, 255, 255]);
  const light = cloneImage(img);
  applyAdjustment(light, 'replace-color', { colors: [[0, 255, 0]], fuzziness: 0, lightness: 50 });
  assert.deepEqual(px(light, 3, 0), [128, 255, 128, 255]);
  assert.deepEqual(px(light, 0, 0), [255, 0, 0, 255]);
  // localized: a 100 px wide red strip sampled at x = 0 with range 50 %: full until 25 px, gone at 50 px
  const strip = createImage(100, 1, [255, 0, 0, 1]);
  const local = replaceColorMask(strip, { colors: [[255, 0, 0]], fuzziness: 40, localized: true, positions: [[0, 0]], range: 50 });
  assert.equal(local[10], 255);
  assert.equal(local[25], 255);
  assert.ok(Math.abs(local[37] - 255 * (13 / 25)) <= 1, `falloff ${local[37]}`);
  assert.equal(local[50], 0);
  assert.equal(local[90], 0);
  // positionsSize: the same click on an image twice as large reaches twice as far
  const wide = createImage(200, 1, [255, 0, 0, 1]);
  const scaled = replaceColorMask(wide, { colors: [[255, 0, 0]], localized: true, positions: [[0, 0]], positionsSize: [100, 1], range: 50 });
  assert.equal(scaled[50], 255);
  assert.equal(scaled[100], 0);
  // without positions "localized" has nothing to measure from and selects by colour alone
  assert.equal(replaceColorMask(strip, { colors: [[255, 0, 0]], localized: true })[90], 255);
  const part = cloneImage(strip);
  applyAdjustment(part, 'replace-color', { colors: [[255, 0, 0]], hue: 120 }, { x: 10, y: 0, width: 5, height: 1 });
  assert.deepEqual(px(part, 9, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(part, 12, 0), [0, 255, 0, 255]);
  assert.deepEqual(px(part, 15, 0), [255, 0, 0, 255]);
  // transparent pixels are never selected; half-transparent ones are fully covered (their colour is replaced, not half of it)
  const clear = createImage(2, 1, [255, 0, 0, 0]);
  clear.data[7] = 128;
  assert.deepEqual(Array.from(replaceColorMask(clear, { colors: [[255, 0, 0]] })), [0, 255]);
  applyAdjustment(clear, 'replace-color', { colors: [[255, 0, 0]], hue: 120 });
  assert.deepEqual(px(clear, 0, 0), [255, 0, 0, 0]);
  assert.deepEqual(px(clear, 1, 0), [0, 255, 0, 128]);
});

test('the restated pieces of adjust.js stay identical: Replace Color through a full mask is Hue/Saturation, toneCurve is curveLut', () => {
  // every pixel within fuzziness of the one sampled colour (fuzziness 200 covers distances up to 100 fully)
  const img = createImage(64, 64);
  const rnd = randomSeeded(91);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 60 + Math.floor(rnd() * 140);
    img.data[i + 1] = 60 + Math.floor(rnd() * 140);
    img.data[i + 2] = 60 + Math.floor(rnd() * 140);
    img.data[i + 3] = 255;
  }
  for (const [hue, saturation, lightness] of [[120, 0, 0], [-75, 0, 0], [0, 60, 0], [0, -100, 0], [0, -35, 0], [0, 0, 40], [0, 0, -40], [33, 50, -20], [180, -60, 25], [-180, 100, 100]]) {
    const a = cloneImage(img), b = cloneImage(img);
    applyAdjustment(a, 'replace-color', { colors: [[130, 130, 130]], fuzziness: 200, hue, saturation, lightness });
    applyAdjustment(b, 'hue-saturation', { hue, saturation, lightness });
    assert.equal(maxDiff(a.data, b.data), 0, `hue ${hue} saturation ${saturation} lightness ${lightness}`);
  }
  for (const pts of [[[0, 0], [255, 255]], [[0, 0], [128, 160], [255, 255]], [[0, 255], [255, 0]], [[0, 0], [64, 32], [192, 224], [255, 255]], [[40, 10], [200, 250]], [[0, 30], [100, 30], [101, 200], [255, 190]], [[255, 255], [0, 0], [128, 90]], [[10, 10]], []]) {
    assert.deepEqual(Array.from(toneCurve(pts)), Array.from(curveLut(pts)), JSON.stringify(pts));
  }
});

// ---------------------------------------------------------------------------------------------
// channel-math.js

test("apply-image 'multiply' at opacity 100 equals blendImages", () => {
  const target = noiseImage(20, 14, 41), source = noiseImage(20, 14, 42);
  for (let i = 3; i < source.data.length; i += 16) source.data[i] = 90; // some transparency in the source
  for (let i = 7; i < target.data.length; i += 24) target.data[i] = 0; // and in the target
  for (const mode of ['multiply', 'screen', 'difference', 'color', 'normal']) {
    const a = cloneImage(target), b = cloneImage(target);
    applyImage(a, source, { blend: mode, opacity: 100 });
    blendImages(mode, source, b, 1);
    assert.equal(maxDiff(a.data, b.data), 0, mode);
  }
  // multiply numbers: 200 * 100 / 255
  const t = createImage(1, 1, [200, 255, 0, 1]), s = createImage(1, 1, [100, 128, 77, 1]);
  applyImage(t, s, { blend: 'multiply' });
  assert.deepEqual(px(t, 0, 0), [Math.round((200 * 100) / 255), 128, 0, 255]);
  assert.throws(() => applyImage(createImage(2, 2), createImage(3, 2)), /same size/);
  assert.throws(() => applyImage(createImage(2, 2), createImage(2, 2), { blend: 'nope' }), /Unknown blend mode/);
});

test('apply-image: channel, invert, opacity, add / subtract with scale and offset, mask, preserve transparency, rect', () => {
  const target = createImage(2, 1, [100, 150, 200, 1]);
  const source = createImage(2, 1, [50, 80, 255, 1]);
  const run = (opts, rect) => px(applyImage(cloneImage(target), source, opts, rect), 0, 0);
  // red channel of the source (50) as grey, normal blend
  assert.deepEqual(run({ channel: 'r', blend: 'normal' }), [50, 50, 50, 255]);
  assert.deepEqual(run({ channel: 'b', blend: 'normal', invert: true }), [0, 0, 0, 255]);
  assert.deepEqual(run({ channel: 'gray', blend: 'normal' }), Array(3).fill(Math.round(0.299 * 50 + 0.587 * 80 + 0.114 * 255)).concat(255));
  assert.deepEqual(run({ channel: 'rgb', blend: 'normal', opacity: 50 }), [75, 115, 228, 255]);
  // add: (target + source) / scale + offset
  assert.deepEqual(run({ blend: 'add' }), [150, 230, 255, 255]);
  assert.deepEqual(run({ blend: 'add', scale: 2, offset: 10 }), [85, 125, 238, 255]);
  // subtract: (target - source) / scale + offset; without scale/offset it is the blend mode
  assert.deepEqual(run({ blend: 'subtract' }), [50, 70, 0, 255]);
  assert.deepEqual(run({ blend: 'subtract', scale: 2, offset: 128 }), [153, 163, 101, 255]);
  // mask: half strength on pixel 0, none on pixel 1
  const masked = applyImage(cloneImage(target), source, { blend: 'normal', mask: { data: new Uint8ClampedArray([128, 0]) } });
  assert.deepEqual(px(masked, 0, 0), [75, 115, 228, 255]);
  assert.deepEqual(px(masked, 1, 0), [100, 150, 200, 255]);
  const inverted = applyImage(cloneImage(target), source, { blend: 'normal', mask: { data: new Uint8ClampedArray([255, 0]), invert: true } });
  assert.deepEqual(px(inverted, 0, 0), [100, 150, 200, 255]);
  assert.deepEqual(px(inverted, 1, 0), [50, 80, 255, 255]);
  // the alpha channel of the source as an image
  const soft = createImage(1, 1, [9, 9, 9, 0.5]);
  assert.deepEqual(px(applyImage(createImage(1, 1, [0, 0, 0, 1]), soft, { channel: 'a', blend: 'normal' }), 0, 0), [128, 128, 128, 255]);
  // preserve transparency: a transparent target pixel stays transparent, a soft one keeps its alpha
  const holes = createImage(2, 1);
  setPixel(holes, 1, 0, [100, 100, 100, 0.5]);
  const kept = applyImage(cloneImage(holes), source, { blend: 'normal', preserveTransparency: true });
  assert.deepEqual(px(kept, 0, 0), [0, 0, 0, 0]);
  assert.equal(px(kept, 1, 0)[3], 128);
  const filled = applyImage(cloneImage(holes), source, { blend: 'normal' });
  assert.deepEqual(px(filled, 0, 0), [50, 80, 255, 255]);
  // rect
  const r = applyImage(cloneImage(target), source, { blend: 'normal' }, { x: 1, y: 0, width: 1, height: 1 });
  assert.deepEqual(px(r, 0, 0), [100, 150, 200, 255]);
  assert.deepEqual(px(r, 1, 0), [50, 80, 255, 255]);
  // opacity 0 is a no-op
  assert.deepEqual(run({ blend: 'normal', opacity: 0 }), [100, 150, 200, 255]);
});

test("calculations: 'difference' of a channel with itself is black; other modes, opacity, inverts and the mask give the expected greys", () => {
  const img = noiseImage(16, 16, 51);
  const red = { width: 16, height: 16, data: extractChannel(img, 'r') };
  const diff = calculations(red, red, { blend: 'difference' });
  assert.equal(diff.length, 256);
  assert.ok(diff.every((v) => v === 0));
  const a = { width: 2, height: 1, data: new Uint8ClampedArray([100, 200]) }, b = { width: 2, height: 1, data: new Uint8ClampedArray([50, 255]) };
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'multiply' })), [Math.round((100 * 50) / 255), 200]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'normal' })), [100, 200]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'normal', opacity: 50 })), [75, 228]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'add' })), [150, 255]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'add', scale: 2, offset: -20 })), [55, 208]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'subtract' })), [0, 55]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'normal', invertA: true })), [155, 55]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'multiply', invertB: true })), [Math.round((100 * 205) / 255), 0]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'normal', mask: { data: new Uint8ClampedArray([0, 255]) } })), [50, 200]);
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'normal', mask: { data: new Uint8ClampedArray([0, 255]), invert: true } })), [100, 255]);
  // a non-separable mode works on greys too (luminosity of a over b = a)
  assert.deepEqual(Array.from(calculations(a, b, { blend: 'luminosity' })), [100, 200]);
  // RGBA planes are read as luma
  const rgba = { width: 16, height: 16, data: img.data };
  assert.deepEqual(Array.from(calculations(rgba, rgba, { blend: 'normal' })), Array.from(extractChannel(img, 'gray')));
  assert.throws(() => calculations(a, { width: 1, height: 1, data: new Uint8ClampedArray(1) }), /same size/);
  // extractChannel
  const p = createImage(1, 1, [10, 20, 30, 0.4]);
  assert.deepEqual([extractChannel(p, 'r')[0], extractChannel(p, 'g')[0], extractChannel(p, 'b')[0], extractChannel(p, 'a')[0]], [10, 20, 30, 102]);
  assert.equal(extractChannel(p, 'rgb')[0], Math.round(0.299 * 10 + 0.587 * 20 + 0.114 * 30));
});

// ---------------------------------------------------------------------------------------------
// matting.js

/** A red square (x, y in 6..17) with a 1 px green rim around it on a transparent 24x24 canvas. */
function haloImage() {
  const img = createImage(24, 24);
  for (let y = 5; y <= 18; y++) for (let x = 5; x <= 18; x++) {
    const rim = x === 5 || x === 18 || y === 5 || y === 18;
    setPixel(img, x, y, rim ? [0, 255, 0, 1] : [255, 0, 0, 1]);
  }
  return img;
}

test('nearestSource is the exact Euclidean nearest source (checked against brute force)', () => {
  const w = 23, h = 17;
  const rnd = randomSeeded(77);
  const src = new Uint8Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = rnd() < 0.04 ? 1 : 0;
  src[5 * w + 11] = 1;
  const { index, dist2 } = nearestSource(src, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity;
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) if (src[sy * w + sx]) best = Math.min(best, (sx - x) ** 2 + (sy - y) ** 2);
    const p = y * w + x;
    assert.equal(dist2[p], best, `distance at ${x},${y}`);
    const s = index[p];
    assert.ok(src[s], 'index points at a source');
    assert.equal(((s % w) - x) ** 2 + (Math.floor(s / w) - y) ** 2, best);
  }
  const none = nearestSource(new Uint8Array(12), 4, 3);
  assert.ok(none.index.every((v) => v === -1));
});

test('defringe removes a 1 px coloured halo and keeps alpha', () => {
  const img = haloImage();
  const out = defringe(cloneImage(img), 1);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const inside = x >= 5 && x <= 18 && y >= 5 && y <= 18;
    assert.deepEqual(px(out, x, y), inside ? [255, 0, 0, 255] : [0, 0, 0, 0], `pixel ${x},${y}`);
  }
  // nothing transparent: nothing to defringe; nothing farther inside than the width: untouched
  const full = createImage(8, 8, [0, 255, 0, 1]);
  assert.equal(maxDiff(defringe(cloneImage(full), 2).data, full.data), 0);
  const thin = createImage(8, 8);
  for (let x = 0; x < 8; x++) setPixel(thin, x, 4, [0, 255, 0, 1]);
  assert.equal(maxDiff(defringe(cloneImage(thin), 1).data, thin.data), 0);
});

test('defringe: the width decides how deep the fringe reaches, soft edge pixels are recoloured too, rect limits writes', () => {
  // 2 px rim: width 1 fixes only the outer ring (from the nearest non-fringe pixel, which is still green)
  const img = createImage(24, 24);
  for (let y = 4; y <= 19; y++) for (let x = 4; x <= 19; x++) {
    const d = Math.min(x - 4, 19 - x, y - 4, 19 - y);
    setPixel(img, x, y, d < 2 ? [0, 0, 255, d === 0 ? 0.5 : 1] : [255, 0, 0, 1]);
  }
  const one = defringe(cloneImage(img), 1);
  assert.deepEqual(px(one, 4, 10), [0, 0, 255, 128]);
  assert.deepEqual(px(one, 5, 10), [0, 0, 255, 255]);
  const two = defringe(cloneImage(img), 2);
  assert.deepEqual(px(two, 4, 10), [255, 0, 0, 128]); // colour replaced, coverage kept
  assert.deepEqual(px(two, 5, 10), [255, 0, 0, 255]);
  assert.deepEqual(px(two, 12, 12), [255, 0, 0, 255]);
  const part = defringe(cloneImage(img), 2, { x: 0, y: 0, width: 24, height: 8 });
  assert.deepEqual(px(part, 10, 5), [255, 0, 0, 255]);
  assert.deepEqual(px(part, 5, 10), [0, 0, 255, 255]);
});

test('removeMatte un-mixes black and white from semi-transparent pixels', () => {
  // colour (200, 100, 50) at 50 % coverage anti-aliased against black and against white
  const a = 128 / 255;
  const img = createImage(3, 1);
  setPixel(img, 0, 0, [200 * a, 100 * a, 50 * a, a]);
  setPixel(img, 1, 0, [200 * a + 255 * (1 - a), 100 * a + 255 * (1 - a), 50 * a + 255 * (1 - a), a]);
  setPixel(img, 2, 0, [10, 20, 30, 1]);
  const black = removeMatte(cloneImage(img), 'black');
  const b = px(black, 0, 0);
  assert.ok(Math.abs(b[0] - 200) <= 2 && Math.abs(b[1] - 100) <= 2 && Math.abs(b[2] - 50) <= 2, `black matte ${b}`);
  assert.equal(b[3], 128);
  assert.deepEqual(px(black, 2, 0), [10, 20, 30, 255]);
  const white = removeMatte(cloneImage(img), 'white');
  const wv = px(white, 1, 0);
  assert.ok(Math.abs(wv[0] - 200) <= 2 && Math.abs(wv[1] - 100) <= 2 && Math.abs(wv[2] - 50) <= 2, `white matte ${wv}`);
  const part = removeMatte(cloneImage(img), 'black', { x: 1, y: 0, width: 2, height: 1 });
  assert.deepEqual(px(part, 0, 0), px(img, 0, 0));
});

test('decontaminate pulls soft edge colours towards the interior colour, more for more transparent pixels', () => {
  // a red block whose soft edge columns are tinted green
  const img = createImage(12, 6);
  for (let y = 0; y < 6; y++) {
    setPixel(img, 2, y, [0, 255, 0, 0.25]);
    setPixel(img, 3, y, [0, 255, 0, 0.75]);
    for (let x = 4; x < 12; x++) setPixel(img, x, y, [255, 0, 0, 1]);
  }
  const full = decontaminate(cloneImage(img), 100);
  assert.deepEqual(px(full, 2, 2), [255, 0, 0, 64]); // at most half opaque: fully replaced
  const partial = px(full, 3, 2);
  assert.equal(partial[3], 191);
  assert.ok(Math.abs(partial[0] - 255 * 2 * (1 - 191 / 255)) <= 1 && Math.abs(partial[1] - (255 - 255 * 2 * (1 - 191 / 255))) <= 1, `partial ${partial}`);
  assert.deepEqual(px(full, 6, 2), [255, 0, 0, 255]);
  const half = decontaminate(cloneImage(img), 50);
  assert.deepEqual(px(half, 2, 2), [128, 128, 0, 64]);
  assert.equal(maxDiff(decontaminate(cloneImage(img), 0).data, img.data), 0);
  const hard = haloImage(); // no soft pixels: nothing to do
  assert.equal(maxDiff(decontaminate(cloneImage(hard), 100).data, hard.data), 0);
});

// ---------------------------------------------------------------------------------------------
// hdr.js

/** 256x48 grey ramp (0..255 left to right) with a fine ±amp checker texture on top. */
function texturedRamp(amp = 6) {
  const w = 256, h = 48;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, x + ((x + y) & 1 ? amp : -amp)));
    setPixel(img, x, y, [v, v, v, 1]);
  }
  return img;
}
const lumaAt = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
};
/** Mean luma of a column band (averages the texture away). */
const bandMean = (img, x0, x1) => {
  let s = 0, n = 0;
  for (let y = 8; y < img.height - 8; y++) for (let x = x0; x < x1; x++) {
    s += lumaAt(img, x, y);
    n++;
  }
  return s / n;
};
/** Mean absolute difference between horizontal neighbours in a column band (the texture's contrast). */
const bandContrast = (img, x0, x1) => {
  let s = 0, n = 0;
  for (let y = 8; y < img.height - 8; y++) for (let x = x0; x < x1 - 1; x++) {
    s += Math.abs(lumaAt(img, x, y) - lumaAt(img, x + 1, y));
    n++;
  }
  return s / n;
};

test("HDR toning: local adaptation compresses a 0..255 gradient's dynamic range while keeping local contrast", () => {
  const img = texturedRamp(6);
  const out = cloneImage(img);
  hdrToning(out, { method: 'local-adaptation', radius: 12, strength: 50, detail: 30, saturation: 0 });
  const inDark = bandMean(img, 8, 24), inBright = bandMean(img, 232, 248);
  const outDark = bandMean(out, 8, 24), outBright = bandMean(out, 232, 248);
  // dynamic range: the dark end is lifted towards the bright end, which stays where it was
  assert.ok(outDark > inDark + 8, `shadows ${inDark} -> ${outDark}`);
  assert.ok(Math.abs(outBright - inBright) < 12, `highlights ${inBright} -> ${outBright}`);
  assert.ok(outBright - outDark < (inBright - inDark) * 0.95, `range ${inBright - inDark} -> ${outBright - outDark}`);
  // the ramp stays monotonic band by band
  let prev = -1;
  for (let x = 8; x < 248; x += 16) {
    const m = bandMean(out, x, x + 16);
    assert.ok(m > prev, `band at ${x}: ${m} after ${prev}`);
    prev = m;
  }
  // local contrast: the fine texture is at least as strong as before in the shadows, mid-tones and highlights
  for (const [x0, x1] of [[40, 72], [112, 144], [184, 216]]) {
    const a = bandContrast(img, x0, x1), b = bandContrast(out, x0, x1);
    assert.ok(b >= a, `texture contrast in ${x0}..${x1}: ${a} -> ${b}`);
  }
  // alpha untouched, greys stay grey
  for (let i = 0; i < out.data.length; i += 4) {
    assert.equal(out.data[i + 3], 255);
    assert.ok(Math.abs(out.data[i] - out.data[i + 1]) <= 1 && Math.abs(out.data[i + 1] - out.data[i + 2]) <= 1);
  }
  // more strength compresses more; detail -100 removes the texture; detail 150 boosts it further
  const strong = cloneImage(img);
  hdrToning(strong, { radius: 12, strength: 100, detail: 30, saturation: 0 });
  assert.ok(bandMean(strong, 8, 24) > outDark + 2);
  const smooth = cloneImage(img), crisp = cloneImage(img);
  hdrToning(smooth, { radius: 12, strength: 50, detail: -100, saturation: 0 });
  hdrToning(crisp, { radius: 12, strength: 50, detail: 150, saturation: 0 });
  assert.ok(bandContrast(smooth, 112, 144) < bandContrast(img, 112, 144) * 0.35, `smoothed ${bandContrast(smooth, 112, 144)}`);
  assert.ok(bandContrast(crisp, 112, 144) > bandContrast(out, 112, 144) * 1.3);
});

test('guidedBase smooths texture but keeps a strong edge', () => {
  const w = 64, h = 16;
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = (x < 32 ? -4 : 0) + ((x + y) & 1 ? 0.05 : -0.05);
  const base = guidedBase(L, null, w, h, 6, 0.25);
  const at = (x) => base[8 * w + x];
  assert.ok(Math.abs(at(10) - at(11)) < 0.03, 'texture flattened');
  assert.ok(Math.abs(at(10) + 4) < 0.1 && Math.abs(at(50)) < 0.1, `plateaus ${at(10)} ${at(50)}`);
  assert.ok(at(33) - at(30) > 3.5, `edge kept: ${at(30)} -> ${at(33)}`);
});

test('HDR toning: exposure / gamma, highlight compression, histogram equalisation, tone controls, curve, rect and alpha', () => {
  // exposure +1 doubles linear light: sRGB 100 -> linear 0.1274 -> 0.2548 -> sRGB 137
  const flat = createImage(8, 8, [100, 100, 100, 1]);
  const lin = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
  const up = hdrToning(cloneImage(flat), { method: 'exposure-gamma', exposure: 1, gamma: 1 });
  assert.equal(px(up, 0, 0)[0], Math.round(enc(lin(100) * 2)));
  const same = hdrToning(cloneImage(flat), { method: 'exposure-gamma', exposure: 0, gamma: 1 });
  assert.deepEqual(px(same, 3, 3), [100, 100, 100, 255]);
  const g2 = hdrToning(cloneImage(flat), { method: 'exposure-gamma', exposure: 0, gamma: 2 });
  assert.equal(px(g2, 0, 0)[0], Math.round(enc(Math.sqrt(lin(100)))));
  // highlight compression: an image that already reaches white is unchanged; a dark one is scaled so its brightest value is white
  const ramp = createImage(256, 1);
  for (let x = 0; x < 256; x++) setPixel(ramp, x, 0, [x, x, x, 1]);
  const hc = hdrToning(cloneImage(ramp), { method: 'highlight-compression' });
  assert.ok(maxDiff(hc.data, ramp.data) <= 1);
  const dim = createImage(128, 1);
  for (let x = 0; x < 128; x++) setPixel(dim, x, 0, [x, x, x, 1]);
  const hd = hdrToning(cloneImage(dim), { method: 'highlight-compression' });
  assert.equal(px(hd, 127, 0)[0], 255);
  assert.equal(px(hd, 0, 0)[0], 0);
  assert.ok(px(hd, 64, 0)[0] > 64);
  // equalize: a ramp squeezed into 64..127 spreads over 0..255
  const narrow = createImage(64, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 64; x++) setPixel(narrow, x, y, [64 + x, 64 + x, 64 + x, 1]);
  const eq = hdrToning(cloneImage(narrow), { method: 'equalize-histogram' });
  assert.equal(px(eq, 0, 0)[0], 0);
  assert.equal(px(eq, 63, 0)[0], 255);
  assert.ok(Math.abs(px(eq, 32, 0)[0] - 255 * (32 / 63)) <= 3);
  // shadow / highlight / saturation / curve act after local adaptation
  const colour = createImage(32, 32, [150, 100, 60, 1]);
  const base = hdrToning(cloneImage(colour), { saturation: 0 });
  const sat = hdrToning(cloneImage(colour), { saturation: 60 });
  const spread = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  assert.ok(spread(px(sat, 16, 16)) > spread(px(base, 16, 16)) * 1.4);
  const grey = hdrToning(cloneImage(colour), { saturation: -100 });
  assert.ok(spread(px(grey, 16, 16)) <= 1);
  const vib = hdrToning(cloneImage(colour), { saturation: 0, vibrance: 80 });
  assert.ok(spread(px(vib, 16, 16)) > spread(px(base, 16, 16)));
  const dark = createImage(32, 32, [60, 60, 60, 1]);
  const d0 = hdrToning(cloneImage(dark), { saturation: 0 }), d1 = hdrToning(cloneImage(dark), { saturation: 0, shadow: 100 }), d2 = hdrToning(cloneImage(dark), { saturation: 0, shadow: -100 });
  assert.ok(px(d1, 5, 5)[0] > px(d0, 5, 5)[0] + 5 && px(d2, 5, 5)[0] < px(d0, 5, 5)[0] - 5);
  const bright = createImage(32, 32, [200, 200, 200, 1]);
  const b0 = hdrToning(cloneImage(bright), { saturation: 0 }), b1 = hdrToning(cloneImage(bright), { saturation: 0, highlight: -100 });
  assert.ok(px(b1, 5, 5)[0] < px(b0, 5, 5)[0] - 5);
  const inv = hdrToning(cloneImage(bright), { saturation: 0, curve: [[0, 255], [255, 0]] });
  assert.equal(px(inv, 5, 5)[0], 255 - px(b0, 5, 5)[0]);
  // a flat image has no local structure: local adaptation with exposure moves it like exposure-gamma does
  const e1 = hdrToning(cloneImage(flat), { saturation: 0, exposure: 1 });
  assert.ok(Math.abs(px(e1, 4, 4)[0] - Math.round(enc(lin(100) * 2))) <= 1);
  // rect limits writes, alpha survives, transparent pixels do not disturb their neighbours
  const part = hdrToning(cloneImage(dark), { saturation: 0, exposure: 2 }, { x: 0, y: 0, width: 16, height: 32 });
  assert.deepEqual(px(part, 20, 5), [60, 60, 60, 255]);
  assert.ok(px(part, 5, 5)[0] > 100);
  const holes = cloneImage(dark);
  for (let y = 0; y < 32; y++) for (let x = 16; x < 32; x++) setPixel(holes, x, y, [255, 255, 255, 0]);
  const h1 = hdrToning(cloneImage(holes), { saturation: 0, radius: 8 });
  assert.equal(px(h1, 20, 5)[3], 0);
  assert.equal(px(h1, 5, 5)[3], 255);
  assert.ok(Math.abs(px(h1, 14, 5)[0] - px(d0, 5, 5)[0]) <= 1, 'the white hidden under transparency does not darken the visible grey');
  // unknown method falls back to local adaptation instead of throwing
  assert.deepEqual(px(hdrToning(cloneImage(dark), { method: 'nope', saturation: 0 }), 5, 5), px(d0, 5, 5));
  // the registry entry is the same function
  const viaRegistry = applyAdjustment(cloneImage(colour), 'hdr-toning', { saturation: 60 });
  assert.equal(maxDiff(viaRegistry.data, sat.data), 0);
});

test('hdrToningFloat tone-maps linear float pixels above display white', () => {
  const w = 32, h = 8;
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = (x / (w - 1)) * 8; // 0..8: three stops above white
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 1;
  }
  const out = hdrToningFloat({ width: w, height: h, data }, { method: 'highlight-compression' });
  assert.equal(out.width, w);
  assert.equal(px(out, w - 1, 0)[0], 255);
  assert.ok(px(out, 4, 0)[0] > px(out, 2, 0)[0]);
  assert.ok(px(out, 16, 0)[0] < 250, 'values above 1.0 are not clipped to white');
  assert.equal(px(out, 0, 0)[3], 255);
  const down = hdrToningFloat({ width: w, height: h, data }, { method: 'exposure-gamma', exposure: -3 });
  assert.equal(px(down, w - 1, 0)[0], 255);
  assert.ok(px(down, 16, 0)[0] < 200);
});

/** A bracketed pair of a synthetic scene: linear radiance ramp 0.02..4 rendered at two exposures. */
function bracket(gains) {
  const w = 96, h = 32;
  const enc = (c) => Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  return gains.map((g) => {
    const img = createImage(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const scene = 0.02 * 200 ** (x / (w - 1)) * (1 + 0.15 * (((x >> 2) + (y >> 2)) & 1)); // texture so contrast weights have something to see
      const v = enc(Math.min(1, scene * g));
      setPixel(img, x, y, [v, v, v, 1]);
    }
    return img;
  });
}

test('estimateExposures finds the exposure ratio of a bracketed pair from the pixels alone', () => {
  const [dark, bright] = bracket([0.25, 2]);
  const { gains, ev, order } = estimateExposures([bright, dark]);
  assert.deepEqual(order, [1, 0]);
  assert.equal(gains[1], 1);
  assert.ok(Math.abs(gains[0] / 8 - 1) < 0.15, `ratio ${gains[0]}`);
  assert.ok(Math.abs(ev[0] - 3) < 0.25);
  assert.deepEqual(estimateExposures([dark]).gains, [1]);
});

test('exposureFusion keeps the well exposed parts of each frame', () => {
  const [dark, bright] = bracket([0.25, 4]);
  const fused = exposureFusion([dark, bright]);
  assert.equal(fused.width, 96);
  // left (scene shadows): the dark frame is nearly black, the bright one shows detail -> fused follows the bright frame
  const l = (img, x) => lumaAt(img, x, 16);
  assert.ok(l(dark, 6) < 30 && l(bright, 6) > 60);
  assert.ok(l(fused, 6) > l(dark, 6) + 25, `shadows ${l(dark, 6)} / ${l(bright, 6)} -> ${l(fused, 6)}`);
  // right (scene highlights): the bright frame is clipped to white, the dark one holds detail -> fused stays below white
  assert.ok(l(bright, 90) === 255 && l(dark, 90) < 250);
  assert.ok(l(fused, 90) < 252, `highlights -> ${l(fused, 90)}`);
  // the clipped region keeps the texture only the dark frame has
  const tex = (img) => Math.abs(l(img, 86) - l(img, 90));
  assert.ok(tex(bright) === 0 && tex(fused) > 2, `texture ${tex(fused)}`);
  for (let i = 3; i < fused.data.length; i += 4) assert.equal(fused.data[i], 255);
  // one image fuses to itself
  const single = exposureFusion([dark]);
  assert.ok(maxDiff(single.data, dark.data) <= 1);
  assert.throws(() => exposureFusion([dark, createImage(4, 4)]), /same size/);
  // 16-bit output: the same picture with the fractions 8 bits round away (sRGB-encoded, 0..65535)
  const deep = exposureFusion([dark, bright], { depth: 16 });
  assert.ok(deep.data instanceof Uint16Array && deep.data.length === fused.data.length);
  let fractional = 0;
  for (let i = 0; i < deep.data.length; i += 4) {
    assert.ok(Math.abs(deep.data[i] / 257 - fused.data[i]) <= 0.5 + 1e-6);
    assert.equal(deep.data[i + 3], 65535);
    if (deep.data[i] % 257 !== 0) fractional++;
  }
  assert.ok(fractional > deep.data.length / 16, 'the 16-bit result holds in-between values');
  // float output is linear
  const f = exposureFusion([dark], { float: true });
  assert.ok(f.data instanceof Float32Array);
  const i = (16 * 96 + 50) * 4;
  const v = dark.data[i] / 255;
  assert.ok(Math.abs(f.data[i] - (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) < 0.01);
});

test('exposureFusion removeGhosts drops an object that is present in one frame only', () => {
  const frames = bracket([0.5, 1, 2]);
  // a bright, textured "ghost" in the middle frame only, over a dark part of the scene: well exposed and
  // full of contrast, so plain fusion prefers it
  for (let y = 8; y < 24; y++) for (let x = 12; x < 28; x++) {
    const v = 150 + ((x + y) & 1 ? 25 : -25);
    setPixel(frames[1], x, y, [v, v, v, 1]);
  }
  const clean = exposureFusion(bracket([0.5, 1, 2]));
  const plain = exposureFusion(frames);
  const deghost = exposureFusion(frames, { removeGhosts: true });
  const err = (img) => {
    let s = 0, n = 0;
    for (let y = 11; y < 21; y++) for (let x = 15; x < 25; x++) {
      s += Math.abs(lumaAt(img, x, y) - lumaAt(clean, x, y));
      n++;
    }
    return s / n;
  };
  assert.ok(err(plain) > 20, `the ghost shows without the option (${err(plain)})`);
  assert.ok(err(deghost) < err(plain) * 0.4, `ghost ${err(plain)} -> ${err(deghost)}`);
});
