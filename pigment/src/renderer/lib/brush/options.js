// The painting tools' shared option specs (ARCHITECTURE.md "0.5 features", S12.1; brush-engine-core). tools.js
// re-exports BRUSH_OPTIONS; tools/paint.js reads the rest from here.
//   - BRUSH_SIZE: 1..5000 px (S2.8), for every StrokeTool with a brush (Brush, Eraser, the stamps, the History Brush);
//     the DabTool family keeps its own 1000 px option until 0.7 (S2.7).
//   - PAINT_BLEND_OPTIONS: the Brush and Pencil's Mode menu as in Photoshop: Normal, Dissolve, Behind, Clear, then every
//     other layer blend mode (0.4 had neither Dissolve nor Behind and Clear: the engine paints them now).
import { BLEND_MODES } from '../document.js';

/** The brush diameter option of every StrokeTool with a brush (Brush, Eraser, the stamps, the History Brush). */
export const BRUSH_SIZE = Object.freeze({ kind: 'slider', key: 'size', label: 'Size', min: 1, max: 5000, step: 1, default: 24, unit: 'px' });
/** The Pencil's size: the brush's range, its own 0.4 default. */
export const PENCIL_SIZE = Object.freeze({ ...BRUSH_SIZE, default: 3 });

export const BRUSH_OPTIONS = [
  { kind: 'brush', key: 'preset', label: '' },
  { ...BRUSH_SIZE },
  { kind: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 0.01, default: 0.8 },
  { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
  { kind: 'slider', key: 'flow', label: 'Flow', min: 0.01, max: 1, step: 0.01, default: 1 },
  { kind: 'slider', key: 'smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.05, default: 0.2 },
  { kind: 'checkbox', key: 'pressureSize', label: 'Pen pressure → size', default: true },
  { kind: 'checkbox', key: 'pressureOpacity', label: 'Pressure → opacity', default: false },
];

/** The painting modes the engine adds after Normal and Dissolve (Photoshop's order). */
const PAINT_ONLY = [['behind', 'Behind'], ['clear', 'Clear']];

/** The painting modes of the Brush and Pencil: Normal, Dissolve, Behind, Clear, then the other layer blend modes. */
export const PAINT_BLEND_OPTIONS = (() => {
  const modes = BLEND_MODES.filter(Boolean).map(([id, label]) => [id, label]);
  const i = modes.findIndex(([id]) => id === 'dissolve');
  return [...modes.slice(0, i + 1), ...PAINT_ONLY, ...modes.slice(i + 1)];
})();
