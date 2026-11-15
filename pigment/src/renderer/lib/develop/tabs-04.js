// 0.4's four Camera Raw tabs as builtin registrations (ARCHITECTURE.md "0.5 features", S8.2): Basic (white balance,
// tone, presence), Detail (sharpening, noise reduction), HSL (hue / saturation / luminance) and Effects (vignette,
// grain), with 0.4's fields, labels and parameter paths (extras.spec.mjs drives data-key="exposure", "hsl.<range>.
// <mode>" and "vignette"). Builtins never replace an earlier registration: camera-raw-workspace replaces basic's
// white-balance section and adds `profile`; camera-raw-panels replaces presence, detail's sections, hsl (Color Mixer,
// same tab id) and effects, and adds the tabs curve, color-grading, optics, geometry and calibration. Tab orders leave
// room for them in Camera Raw's order: basic 100, (curve 200), detail 300, hsl 400, (color grading 500, optics 600,
// geometry 700), effects 800, (calibration 900). Skeleton file.
import { HSL_RANGES } from '../../../shared/pixels/develop.js';
import { registerDevelopTab, registerDevelopSection } from './registry.js';

const S = (key, label, min = -100, max = 100, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const RANGE_LABELS = { reds: 'Reds', oranges: 'Oranges', yellows: 'Yellows', greens: 'Greens', aquas: 'Aquas', blues: 'Blues', purples: 'Purples', magentas: 'Magentas' };
const B = { builtin: true };

registerDevelopTab({ id: 'basic', label: 'Basic', order: 100 }, B);
registerDevelopTab({ id: 'detail', label: 'Detail', order: 300 }, B);
// one form per sub-mode (Hue / Saturation / Luminance), switched by a segment control
registerDevelopTab({ id: 'hsl', label: 'HSL', order: 400, modes: ['hue', 'saturation', 'luminance'] }, B);
registerDevelopTab({ id: 'effects', label: 'Effects', order: 800 }, B);

registerDevelopSection({ tab: 'basic', id: 'white-balance', label: 'White balance', order: 100, fields: [S('temperature', 'Temperature'), S('tint', 'Tint')] }, B);
registerDevelopSection({
  tab: 'basic', id: 'tone', label: 'Tone', order: 300,
  fields: [S('exposure', 'Exposure', -5, 5, 0.05, { unit: 'EV' }), S('contrast', 'Contrast'), S('highlights', 'Highlights'), S('shadows', 'Shadows'), S('whites', 'Whites'), S('blacks', 'Blacks')],
}, B);
registerDevelopSection({
  tab: 'basic', id: 'presence', label: 'Presence', order: 400,
  fields: [S('texture', 'Texture'), S('clarity', 'Clarity'), S('dehaze', 'Dehaze'), S('vibrance', 'Vibrance'), S('saturation', 'Saturation')],
}, B);

registerDevelopSection({
  tab: 'detail', id: 'sharpening', label: 'Sharpening', order: 100,
  fields: [S('sharpen.amount', 'Amount', 0, 150), S('sharpen.radius', 'Radius', 0.5, 3, 0.1, { unit: 'px' }), S('sharpen.detail', 'Detail', 0, 100)],
}, B);
registerDevelopSection({ tab: 'detail', id: 'noise', label: 'Noise reduction', order: 200, fields: [S('noise.luminance', 'Luminance', 0, 100), S('noise.color', 'Color', 0, 100)] }, B);

// no heading: 0.4's HSL forms held the eight ranges only
registerDevelopSection({ tab: 'hsl', id: 'hsl', label: '', order: 100, fields: (mode) => HSL_RANGES.map((r) => S(`hsl.${r}.${mode}`, RANGE_LABELS[r])) }, B);

registerDevelopSection({ tab: 'effects', id: 'vignette', label: 'Post-crop vignetting', order: 100, fields: [S('vignette', 'Amount')] }, B);
registerDevelopSection({ tab: 'effects', id: 'grain', label: 'Grain', order: 200, fields: [S('grain', 'Amount', 0, 100), { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 99999 }] }, B);
