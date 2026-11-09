// Filter menu kinds added in 0.3, part A (builder "filters-a"): the rest of Photoshop's Blur,
// Sharpen, Pixelate and Video groups plus HSB/HSL. Every entry is built with defineFilter() from
// filter-def.js and follows the conventions at the top of filters.js (rect limits writes only,
// straight alpha in and out, alpha-weighted averaging, deterministic noise per seed). The kinds
// below are placeholders (identity) until the builder lands them; ids, names and categories are
// final because menus, smart filters and the AI assistant refer to them.
//
// Import FILTERS from './filters.js' only for use inside apply() (never at module top level):
// filters.js imports this table, so the modules form a cycle that is safe at call time only.

import { placeholderFilter } from './filter-def.js';

export const FILTERS_MORE_A = Object.freeze({
  // blur
  average: placeholderFilter('Average', 'blur', {}, { direct: true }),
  blur: placeholderFilter('Blur', 'blur', {}, { direct: true }),
  'blur-more': placeholderFilter('Blur More', 'blur', {}, { direct: true }),
  'lens-blur': placeholderFilter('Lens Blur', 'blur', { radius: 15, shape: 'hexagon', bladeCurvature: 0, rotation: 0, brightness: 0, threshold: 255, noise: 0, distribution: 'uniform', monochromatic: false, source: 'none', focalDistance: 0, invert: false }),
  'shape-blur': placeholderFilter('Shape Blur', 'blur', { radius: 5, shape: 'circle' }),
  'smart-blur': placeholderFilter('Smart Blur', 'blur', { radius: 3, threshold: 25, quality: 'medium', mode: 'normal' }),
  // sharpen
  'sharpen-edges': placeholderFilter('Sharpen Edges', 'sharpen', {}, { direct: true }),
  'sharpen-more': placeholderFilter('Sharpen More', 'sharpen', {}, { direct: true }),
  'shake-reduction': placeholderFilter('Shake Reduction', 'sharpen', { traceBounds: 41, sourceNoise: 'auto', smoothing: 30, artifactSuppression: 30 }),
  // pixelate
  'color-halftone': placeholderFilter('Color Halftone', 'pixelate', { radius: 8, angles: [108, 162, 90, 45] }),
  facet: placeholderFilter('Facet', 'pixelate', {}, { direct: true }),
  mezzotint: placeholderFilter('Mezzotint', 'pixelate', { type: 'medium-dots', seed: 1 }),
  // video
  'de-interlace': placeholderFilter('De-Interlace', 'video', { eliminate: 'odd', method: 'interpolation' }),
  'ntsc-colors': placeholderFilter('NTSC Colors', 'video', {}, { direct: true }),
  // other
  'hsb-hsl': placeholderFilter('HSB/HSL', 'other', { from: 'rgb', to: 'hsb' }),
});
