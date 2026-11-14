// Shared helpers for unit tests: deterministic test images and pixel assertions.
import assert from 'node:assert/strict';
import { createImage, setPixel, getPixel } from '../../src/shared/pixels/core.js';

export { createImage, setPixel, getPixel };

/** Horizontal gradient from black (left) to white (right), fully opaque. */
export function gradientImage(width = 16, height = 8) {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round((x / (width - 1)) * 255);
    setPixel(img, x, y, [v, v, v, 1]);
  }
  return img;
}

/** Four coloured quadrants (red, green, blue, white) with a transparent 1px border. */
export function quadrantImage(size = 16) {
  const img = createImage(size, size);
  const half = size / 2;
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const c = x < half ? (y < half ? [255, 0, 0, 1] : [0, 0, 255, 1]) : y < half ? [0, 255, 0, 1] : [255, 255, 255, 1];
    setPixel(img, x, y, c);
  }
  return img;
}

/** A solid colour image. */
export function solidImage(width, height, rgba) {
  return createImage(width, height, rgba);
}

/** Asserts two RGBA arrays are within tol per channel (alpha compared in 0..255). */
export function assertPixel(actual, expected, tol = 1, message = '') {
  const a = [actual[0], actual[1], actual[2], Math.round(actual[3] * 255)];
  const e = [expected[0], expected[1], expected[2], Math.round((expected[3] ?? 1) * 255)];
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(a[i] - e[i]) <= tol, `${message} channel ${i}: ${a[i]} vs ${e[i]} (tol ${tol}) full ${a} vs ${e}`);
}

export function assertNear(actual, expected, tol = 1e-6, message = '') {
  assert.ok(Math.abs(actual - expected) <= tol, `${message} ${actual} vs ${expected} (tol ${tol})`);
}
