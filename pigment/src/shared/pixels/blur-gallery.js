// Blur Gallery kinds (builder "blur-gallery"): Field Blur, Iris Blur, Tilt-Shift, Path Blur and
// Spin Blur. Each kind is a plain filter whose params hold the pins the on-canvas session edits
// (lib/blur-gallery-ui.js registers a custom opener through app.filterEditor.register), so smart
// filters, actions and the assistant can re-run them from params alone. Coordinates in params are
// fractions of the image (0..1) so the same pins apply after a resize. Placeholders until the
// builder lands them (ids are final).

import { placeholderFilter } from './filter-def.js';

const BOKEH = { lightBokeh: 0, bokehColor: 0, lightRange: [191, 255] };
const NOISE = { amount: 0, size: 1, roughness: 0, color: 0, highlights: 0, distribution: 'gaussian' };

export const BLUR_GALLERY = Object.freeze({
  'field-blur': placeholderFilter('Field Blur', 'blur-gallery', { pins: [{ x: 0.5, y: 0.5, blur: 15 }], bokeh: BOKEH, noise: NOISE }, { ui: 'custom' }),
  'iris-blur': placeholderFilter('Iris Blur', 'blur-gallery', { pins: [{ x: 0.5, y: 0.5, blur: 15, rx: 0.3, ry: 0.3, rotation: 0, roundness: 0, feather: 0.5 }], bokeh: BOKEH, noise: NOISE }, { ui: 'custom' }),
  'tilt-shift': placeholderFilter('Tilt-Shift', 'blur-gallery', { pins: [{ x: 0.5, y: 0.5, blur: 15, rotation: 0, focus: 0.15, fade: 0.3 }], distortion: 0, symmetricDistortion: false, bokeh: BOKEH, noise: NOISE }, { ui: 'custom' }),
  'path-blur': placeholderFilter('Path Blur', 'blur-gallery', { paths: [{ points: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }], endSpeeds: [50, 50] }], speed: 50, taper: 0, centeredBlur: true, strobe: false, strobeStrength: 50, strobeFlashes: 1, noise: NOISE }, { ui: 'custom' }),
  'spin-blur': placeholderFilter('Spin Blur', 'blur-gallery', { pins: [{ x: 0.5, y: 0.5, angle: 15, rx: 0.3, ry: 0.3, rotation: 0, feather: 0.5 }], strobe: false, strobeStrength: 50, strobeFlashes: 1, noise: NOISE }, { ui: 'custom' }),
});
