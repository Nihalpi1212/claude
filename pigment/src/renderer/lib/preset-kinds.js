// The preset kinds of 0.4 (ARCHITECTURE.md "0.4 features", C), registered by the skeleton with the built-ins that
// exist in 0.3, so every package can read and edit presets before its owner lands. The owner of a kind re-registers
// it with its full definition (the later registration wins; the user's entries are kept):
//   gradients (gradients)     patterns (patterns)     contours (layer-style-effects)     styles (presets-panels, 0.5)
//   shapes (presets-panels, 0.5; shapes-live reads)   stroke-styles (shapes-live)   tool-presets (presets-panels, 0.5)
// The adjustment:<kind> kinds are registered by adjust-tonal and adjust-color. app.js calls registerPresetKinds04()
// in start(), before it creates app.presets. Skeleton file.
import { registerPresetKind } from './presets.js';
import { normalizeGradient } from '../../shared/pixels/gradient-model.js';
import { GRADIENT_PRESETS } from './tools/fill.js';
import { CUSTOM_SHAPES, customPath } from './tools/vector.js';
import { BUILTIN_BRUSHES } from './panels/brushes.js';
import { normalizeBrush, brushFromLegacy, blobsOf, withoutSampleData } from './brush/preset.js';
import { DEFAULT_SWATCHES } from '../../shared/defaults.js';

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const LINEAR_CONTOUR = Object.freeze({ name: 'Linear', points: [{ x: 0, y: 0, corner: false }, { x: 1, y: 1, corner: false }] });

export function registerPresetKinds04() {
  registerPresetKind('gradients', {
    title: 'Gradients',
    version: 1,
    // 0.3's eight presets of the Gradient tool; 'fgbg' / 'fgt' become { ref } stops (presets may keep references)
    builtins: () => ({ presets: GRADIENT_PRESETS.map((g) => ({ id: slug(g.name), name: g.name, data: normalizeGradient({ stops: g.stops }, { keepRefs: true }) })) }),
    normalize: (data) => (isObject(data) ? normalizeGradient(data, { keepRefs: true }) : null),
  });
  registerPresetKind('patterns', {
    title: 'Patterns',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (isObject(data) && typeof data.blob === 'string' ? data : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  registerPresetKind('contours', {
    title: 'Contours',
    version: 1,
    builtins: () => ({ presets: [{ id: 'linear', name: 'Linear', data: JSON.parse(JSON.stringify(LINEAR_CONTOUR)) }] }),
    normalize: (data) => (isObject(data) && Array.isArray(data.points) && data.points.length >= 2 ? data : null),
  });
  registerPresetKind('styles', {
    title: 'Styles',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (isObject(data) && isObject(data.styles) ? data : null),
  });
  registerPresetKind('shapes', {
    title: 'Shapes',
    version: 1,
    // 0.3's custom shapes, as paths in a 0..1 box
    builtins: () => ({ presets: Object.entries(CUSTOM_SHAPES).map(([id, s]) => ({ id, name: s.name, data: { path: customPath(id, 0, 0, 1, 1) } })) }),
    normalize: (data) => (isObject(data) && isObject(data.path) && Array.isArray(data.path.subpaths) ? data : null),
  });
  registerPresetKind('stroke-styles', {
    title: 'Stroke Styles',
    version: 1,
    // Photoshop's three; dashes in stroke widths
    builtins: () => ({
      presets: [
        { id: 'solid', name: 'Solid', data: { dash: [], cap: 'butt', join: 'miter', align: 'center' } },
        { id: 'dashed', name: 'Dashed', data: { dash: [4, 2], cap: 'butt', join: 'miter', align: 'center' } },
        { id: 'dotted', name: 'Dotted', data: { dash: [0, 2], cap: 'round', join: 'round', align: 'center' } },
      ],
    }),
    normalize: (data) => (isObject(data) && Array.isArray(data.dash) ? data : null),
  });
  registerPresetKind('tool-presets', {
    title: 'Tool Presets',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (isObject(data) && typeof data.tool === 'string' ? data : null),
  });
}

/**
 * The preset kinds of 0.5 (ARCHITECTURE.md "0.5 features", S10.5), registered with registerPresetKinds04() in
 * start(). Their owners re-register them with their full definitions. Step 4 of the skeleton registers `brushes`,
 * step 7 the three Camera Raw kinds, step 8 swatches, color-books and color-profiles; step 10 adds the others.
 */
export function registerPresetKinds05() {
  registerPresetKind('brushes', {
    title: 'Brushes',
    version: 1,
    // 0.4's Brushes panel presets under their 0.4 ids (a preset's flow is its tool flow, S1.1)
    builtins: () => ({ presets: BUILTIN_BRUSHES.map((b) => ({ id: b.id, name: b.name, data: withoutSampleData(brushFromLegacy(b)) })) }),
    normalize: (data) => (isObject(data) ? withoutSampleData(normalizeBrush(data)) : null),
    blobs: (data) => blobsOf(data),
  });
  // colour (S7.2, S10.5; color-picker-swatches and icc-engine re-register them): registered by step 8 of the skeleton.
  // 0.4's settings.swatches stay where they are until color-picker-swatches migrates them (settings.colorUI).
  registerPresetKind('swatches', {
    title: 'Swatches',
    version: 1,
    builtins: () => ({
      presets: DEFAULT_SWATCHES.map((hex, i) => ({ id: `default-${i}`, name: hex, data: { color: { space: 'rgb', values: rgbOf(hex) } } })),
    }),
    normalize: (data) => (isObject(data) && isObject(data.color) && ['rgb', 'lab', 'cmyk', 'gray'].includes(data.color.space) && Array.isArray(data.color.values) && data.color.values.every(Number.isFinite) ? data : null),
  });
  registerPresetKind('color-books', {
    title: 'Color Books',
    version: 1,
    builtins: () => ({ presets: [] }), // no licensed books are shipped
    normalize: (data) => (isObject(data) && typeof data.blob === 'string' ? data : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  registerPresetKind('color-profiles', {
    title: 'Color Profiles',
    version: 1,
    builtins: () => ({ presets: [] }), // the user's ICC profiles (the browser build too)
    normalize: (data) => (isObject(data) && typeof data.blob === 'string' ? data : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
  // Camera Raw (S8.4; camera-raw-workspace re-registers them): registered empty by step 7 of the skeleton
  registerPresetKind('camera-raw-presets', {
    title: 'Camera Raw Presets',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (isObject(data) && isObject(data.params) ? { params: data.params, groups: Array.isArray(data.groups) ? data.groups.map(String) : [] } : null),
  });
  registerPresetKind('camera-raw-snapshots', {
    title: 'Camera Raw Snapshots',
    version: 1,
    builtins: () => ({ presets: [] }),
    normalize: (data) => (isObject(data) && isObject(data.params) ? { params: data.params, document: typeof data.document === 'string' ? data.document : '' } : null),
  });
  registerPresetKind('camera-raw-profiles', {
    title: 'Camera Raw Profiles',
    version: 1,
    builtins: () => ({ presets: [] }),
    // the user's LUT library: the .cube file is the blob
    normalize: (data) => (isObject(data) && typeof data.blob === 'string' ? data : null),
    blobs: (data) => (typeof data?.blob === 'string' ? [data.blob] : []),
  });
}
