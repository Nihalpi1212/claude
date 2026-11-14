import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as color from '../../src/shared/pixels/color.js';
import { createImage, getPixel, setPixel } from '../../src/shared/pixels/core.js';

const near = (a, b, eps = 0.6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const nearArr = (a, b, eps) => a.forEach((v, i) => near(v, b[i], eps));

test('Lab: sRGB white is L 100, a 0, b 0 and the conversion round-trips', () => {
  nearArr(color.rgbToLab(255, 255, 255), [100, 0, 0], 0.05);
  nearArr(color.rgbToLab(0, 0, 0), [0, 0, 0], 0.05);
  const [L] = color.rgbToLab(128, 128, 128);
  near(L, 53.6, 0.5); // mid grey sits near L 54 (sRGB gamma)
  const red = color.rgbToLab(255, 0, 0);
  near(red[0], 53.2, 0.5);
  near(red[1], 80.1, 0.5);
  near(red[2], 67.2, 0.5);
  for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [12, 200, 90], [240, 240, 10], [77, 77, 77]]) {
    nearArr(color.labToRgb(...color.rgbToLab(...rgb)), rgb, 0.6);
  }
});

test('CMYK: naive GCR known values and lossless round trips', () => {
  nearArr(color.rgbToCmyk(255, 0, 0), [0, 100, 100, 0], 1e-9);
  nearArr(color.rgbToCmyk(255, 255, 255), [0, 0, 0, 0], 1e-9);
  nearArr(color.rgbToCmyk(0, 0, 0), [0, 0, 0, 100], 1e-9);
  nearArr(color.rgbToCmyk(0, 255, 255), [100, 0, 0, 0], 1e-9);
  nearArr(color.rgbToCmyk(128, 128, 128), [0, 0, 0, 49.8], 0.1);
  nearArr(color.cmykToRgb(0, 100, 100, 0), [255, 0, 0], 1e-9);
  nearArr(color.cmykToRgb(0, 0, 0, 100), [0, 0, 0], 1e-9);
  for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [12, 200, 90], [240, 240, 10], [77, 77, 77], [200, 10, 150]]) {
    nearArr(color.cmykToRgb(...color.rgbToCmyk(...rgb)), rgb, 1e-6);
  }
  // out-of-range input is clamped
  nearArr(color.cmykToRgb(150, -20, 0, 0), [0, 255, 255], 1e-9);
});

test('gamut: printable colours survive the proof, saturated primaries do not', () => {
  assert.equal(color.isOutOfCmykGamut([255, 255, 255]), false);
  assert.equal(color.isOutOfCmykGamut([0, 0, 0]), false);
  assert.equal(color.isOutOfCmykGamut([128, 128, 128]), false);
  assert.equal(color.isOutOfCmykGamut([255, 255, 0]), false); // yellow prints fine
  assert.equal(color.isOutOfCmykGamut([0, 255, 0]), true); // RGB green, cyan and blue are famously unprintable
  assert.equal(color.isOutOfCmykGamut([0, 255, 255]), true);
  assert.equal(color.isOutOfCmykGamut([0, 0, 255]), true);
  assert.equal(color.isOutOfCmykGamut(0, 0, 255), true); // separate arguments also work
  // the proof of white paper with no ink is white; a full ink is that ink's colour
  nearArr(color.cmykToProofRgb(0, 0, 0, 0), [255, 255, 255], 1e-9);
  nearArr(color.cmykToProofRgb(100, 0, 0, 0), color.PROCESS_INKS.c, 1e-9);
  const g = color.proofRgb(0, 255, 0);
  assert.ok(g[1] < 200 && g[0] < 10 && g[2] < 10, `proofed green is a duller green: ${g}`);
});

test('applyProof: proof replaces colours, gamut warning greys the unprintable ones, alpha untouched', () => {
  const img = createImage(3, 1);
  setPixel(img, 0, 0, [0, 255, 0, 1]);
  setPixel(img, 1, 0, [255, 255, 255, 0.5]);
  setPixel(img, 2, 0, [0, 255, 0, 0]);
  const proofed = color.applyProof({ width: 3, height: 1, data: img.data.slice() }, { proof: true });
  const p0 = getPixel(proofed, 0, 0);
  assert.ok(p0[1] < 200 && p0[1] > 100, `green dulled: ${p0}`);
  assert.deepEqual(getPixel(proofed, 1, 0).slice(0, 3), [255, 255, 255]);
  near(getPixel(proofed, 1, 0)[3], 0.5, 0.01);
  assert.deepEqual(Array.from(proofed.data.slice(8, 12)), [0, 255, 0, 0]); // transparent pixels are skipped
  const warned = color.applyProof({ width: 3, height: 1, data: img.data.slice() }, { proof: false, gamut: true });
  assert.deepEqual(getPixel(warned, 0, 0).slice(0, 3), [128, 128, 128]);
  assert.deepEqual(getPixel(warned, 1, 0).slice(0, 3), [255, 255, 255]);
  // rect limits the work
  const part = color.applyProof({ width: 3, height: 1, data: img.data.slice() }, { proof: true, rect: { x: 1, y: 0, width: 2, height: 1 } });
  assert.deepEqual(getPixel(part, 0, 0).slice(0, 3), [0, 255, 0]);
});
