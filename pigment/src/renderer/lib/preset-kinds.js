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
