// Filter Gallery kinds, part A (builder "gallery-a"): the Artistic and Brush Strokes groups. These
// kinds have category 'gallery' (they are not in the Filter menu's top-level groups unless the
// "show all Filter Gallery groups" preference is on) and a `gallery` group name for the Filter
// Gallery dialog (lib/filter-gallery.js). Photoshop's gallery filters work on opaque 8-bit colour;
// here alpha is kept as it is and transparent pixels never bleed colour (alpha-weighted averaging).
// Placeholders until the builder lands them (ids, names and parameter names are final).

import { placeholderFilter, defineFilter } from './filter-def.js';
import { FILTERS } from './filters.js'; // used inside apply() only (call-time safe cycle)

const A = (name, defaults) => placeholderFilter(name, 'gallery', defaults, { gallery: 'Artistic' });
const B = (name, defaults) => placeholderFilter(name, 'gallery', defaults, { gallery: 'Brush Strokes' });

export const GALLERY_ARTISTIC = Object.freeze({
  // Filter > Filter Gallery…: a stack of gallery effects applied in order (the dialog edits params.effects; each
  // entry { kind, params, enabled }). Category 'special' keeps it out of the group submenus; ui 'custom' means
  // lib/filter-gallery.js opens the gallery instead of a field dialog. Works today for any implemented kind.
  'filter-gallery': defineFilter('Filter Gallery', 'special', { effects: [] }, (img, p, rect) => {
    for (const e of Array.isArray(p.effects) ? p.effects : []) {
      const def = e && typeof e.kind === 'string' ? FILTERS[e.kind] : null;
      if (def && def.category === 'gallery' && !def.placeholder && e.enabled !== false) def.apply(img, e.params ?? {}, rect);
    }
    return img;
  }, { ui: 'custom', margin: 64 }),
  'colored-pencil': A('Colored Pencil', { pencilWidth: 4, strokePressure: 8, paperBrightness: 25 }),
  cutout: A('Cutout', { levels: 4, edgeSimplicity: 4, edgeFidelity: 2 }),
  'dry-brush': A('Dry Brush', { brushSize: 2, brushDetail: 8, texture: 1 }),
  'film-grain': A('Film Grain', { grain: 4, highlightArea: 0, intensity: 10, seed: 1 }),
  fresco: A('Fresco', { brushSize: 2, brushDetail: 8, texture: 1 }),
  'neon-glow': A('Neon Glow', { glowSize: 5, glowBrightness: 15, glowColor: '#0000ff' }),
  'paint-daubs': A('Paint Daubs', { brushSize: 8, sharpness: 7, brushType: 'simple' }),
  'palette-knife': A('Palette Knife', { strokeSize: 25, strokeDetail: 3, softness: 0 }),
  'plastic-wrap': A('Plastic Wrap', { highlightStrength: 15, detail: 9, smoothness: 7 }),
  'poster-edges': A('Poster Edges', { edgeThickness: 2, edgeIntensity: 1, posterization: 2 }),
  'rough-pastels': A('Rough Pastels', { strokeLength: 6, strokeDetail: 4, texture: 'canvas', scaling: 100, relief: 20, lightDirection: 'bottom', invert: false }),
  'smudge-stick': A('Smudge Stick', { strokeLength: 2, highlightArea: 0, intensity: 10 }),
  sponge: A('Sponge', { brushSize: 2, definition: 12, smoothness: 5, seed: 1 }),
  underpainting: A('Underpainting', { brushSize: 6, textureCoverage: 16, texture: 'canvas', scaling: 100, relief: 4, lightDirection: 'top', invert: false }),
  watercolor: A('Watercolor', { brushDetail: 9, shadowIntensity: 1, texture: 1 }),
  'accented-edges': B('Accented Edges', { edgeWidth: 2, edgeBrightness: 38, smoothness: 5 }),
  'angled-strokes': B('Angled Strokes', { directionBalance: 50, strokeLength: 15, sharpness: 3 }),
  crosshatch: B('Crosshatch', { strokeLength: 9, sharpness: 6, strength: 1 }),
  'dark-strokes': B('Dark Strokes', { balance: 5, blackIntensity: 6, whiteIntensity: 2 }),
  'ink-outlines': B('Ink Outlines', { strokeLength: 4, darkIntensity: 20, lightIntensity: 10 }),
  spatter: B('Spatter', { sprayRadius: 10, smoothness: 5, seed: 1 }),
  'sprayed-strokes': B('Sprayed Strokes', { strokeLength: 12, sprayRadius: 7, strokeDirection: 'right-diagonal', seed: 1 }),
  'sumi-e': B('Sumi-e', { strokeWidth: 10, strokePressure: 2, contrast: 16 }),
});
