// Lens Correction (builder "content-aware-lens"): Filter > Lens Correction… as one filter kind whose
// params hold the Custom tab's controls, so smart filters and actions re-run it from params (the dialog in
// lib/lens-correction.js registers a custom opener). Geometric distortion is a radial model (k1, k2) on
// normalised radius, chromatic aberration scales the red/cyan and blue/yellow channels about the centre,
// vignette multiplies by a radial falloff, and the Transform group is a perspective/rotate/scale pass.
// Placeholder until the builder lands it (id and parameter names are final).

import { placeholderFilter } from './filter-def.js';

export const LENS_FILTERS = Object.freeze({
  'lens-correction': placeholderFilter('Lens Correction', 'special', {
    distortion: 0, // -100..100 (negative = barrel correction of pincushion, Photoshop's sign)
    chromaRC: 0, // red/cyan fringe, -100..100
    chromaBY: 0, // blue/yellow fringe, -100..100
    chromaGM: 0, // green/magenta fringe, -100..100
    vignette: 0, // -100..100
    vignetteMidpoint: 50, // 0..100
    vertical: 0, // perspective, -100..100
    horizontal: 0,
    angle: 0, // degrees
    scale: 100, // 50..150 %
    edge: 'transparent', // 'transparent' | 'repeat' | 'wrap' | 'background'
    autoScale: false,
  }, { ui: 'custom' }),
});
