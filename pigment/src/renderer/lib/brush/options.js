// The painting tools' shared option specs (ARCHITECTURE.md "0.5 features", S12.1). brush-engine-core's file; this is
// the skeleton's stub: 0.4's BRUSH_OPTIONS (from tools.js) and the Brush tool's mode list (from tools/paint.js), with
// the size cap at 5000 px (S2.8). tools.js re-exports BRUSH_OPTIONS; tools/paint.js reads the rest from here. The
// package adds Behind / Clear (and keeps Dissolve) in PAINT_BLEND_OPTIONS when its engine paints them.
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

/** The painting modes of the Brush and Pencil (0.4: every layer blend mode but Dissolve). */
export const PAINT_BLEND_OPTIONS = BLEND_MODES.filter(Boolean).filter(([id]) => id !== 'dissolve').map(([id, label]) => [id, label]);
