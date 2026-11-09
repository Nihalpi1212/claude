// Filter Gallery kinds, part B (builder "gallery-b"): the Sketch, Texture and Distort groups of the
// gallery (Diffuse Glow, Glass and Ocean Ripple live only in the gallery in Photoshop). Sketch kinds
// paint with the foreground and background colours: params.colors = ['#rrggbb' fg, '#rrggbb' bg]
// is filled in by the dialog from the current colours (defaults black on white). Same conventions
// as gallery-artistic.js; placeholders until the builder lands them (ids are final).

import { placeholderFilter } from './filter-def.js';

const COLORS = ['#000000', '#ffffff'];
const S = (name, defaults) => placeholderFilter(name, 'gallery', { ...defaults, colors: COLORS }, { gallery: 'Sketch' });
const T = (name, defaults) => placeholderFilter(name, 'gallery', defaults, { gallery: 'Texture' });
const D = (name, defaults) => placeholderFilter(name, 'gallery', defaults, { gallery: 'Distort' });

export const GALLERY_SKETCH = Object.freeze({
  'bas-relief': S('Bas Relief', { detail: 13, smoothness: 3, lightDirection: 'bottom' }),
  'chalk-charcoal': S('Chalk & Charcoal', { charcoalArea: 6, chalkArea: 6, strokePressure: 1, seed: 1 }),
  charcoal: S('Charcoal', { charcoalThickness: 1, detail: 5, lightDarkBalance: 50 }),
  chrome: S('Chrome', { detail: 4, smoothness: 7 }),
  'conte-crayon': S('Conté Crayon', { foregroundLevel: 11, backgroundLevel: 7, texture: 'sandstone', scaling: 100, relief: 4, lightDirection: 'top', invert: false }),
  'graphic-pen': S('Graphic Pen', { strokeLength: 15, lightDarkBalance: 50, strokeDirection: 'right-diagonal', seed: 1 }),
  'halftone-pattern': S('Halftone Pattern', { size: 1, contrast: 5, patternType: 'dot' }),
  'note-paper': S('Note Paper', { imageBalance: 25, graininess: 10, relief: 11, seed: 1 }),
  photocopy: S('Photocopy', { detail: 7, darkness: 8 }),
  plaster: S('Plaster', { imageBalance: 20, smoothness: 2, lightDirection: 'top' }),
  reticulation: S('Reticulation', { density: 12, foregroundLevel: 40, backgroundLevel: 5, seed: 1 }),
  stamp: S('Stamp', { lightDarkBalance: 25, smoothness: 5 }),
  'torn-edges': S('Torn Edges', { imageBalance: 25, smoothness: 11, contrast: 17, seed: 1 }),
  'water-paper': S('Water Paper', { fiberLength: 15, brightness: 60, contrast: 80 }),
  craquelure: T('Craquelure', { crackSpacing: 15, crackDepth: 6, crackBrightness: 9, seed: 1 }),
  grain: T('Grain', { intensity: 40, contrast: 50, grainType: 'regular', seed: 1 }),
  'mosaic-tiles': T('Mosaic Tiles', { tileSize: 12, groutWidth: 3, lightenGrout: 9, seed: 1 }),
  patchwork: T('Patchwork', { squareSize: 4, relief: 8 }),
  'stained-glass': T('Stained Glass', { cellSize: 10, borderThickness: 4, lightIntensity: 3, seed: 1, borderColor: '#000000' }),
  texturizer: T('Texturizer', { texture: 'canvas', scaling: 100, relief: 4, lightDirection: 'top', invert: false, textureImage: null }),
  'diffuse-glow': D('Diffuse Glow', { graininess: 6, glowAmount: 10, clearAmount: 15, glowColor: '#ffffff', seed: 1 }),
  glass: D('Glass', { distortion: 5, smoothness: 3, texture: 'frosted', scaling: 100, invert: false, seed: 1 }),
  'ocean-ripple': D('Ocean Ripple', { rippleSize: 9, rippleMagnitude: 9, seed: 1 }),
});
