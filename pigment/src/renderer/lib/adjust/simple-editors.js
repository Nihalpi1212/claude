// Exposure, Threshold and Brightness/Contrast editors (adjust-tonal; registered with app.adjustEditors by
// lib/adjust/tonal.js, I.2). Their fields keep 0.3's data-keys (exposure, offset, gamma; level; brightness, contrast,
// legacy); the capabilities add Photoshop's extras: Exposure's black / grey / white eyedroppers, Threshold's
// histogram, Brightness/Contrast's Auto.
import { buildForm } from '../form.js';
import { tonalEyedroppers } from './eyedroppers.js';
import { sourceHistogram, drawHistogram, sliderTrack } from './tonal-ui.js';
import { weightedHistogram } from '../../../shared/pixels/adjust-tonal.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

/** A form-backed editor: fields over params, setParams refills the form. */
function formEditor(fields, params, onChange) {
  let p = clone(params) ?? {};
  const form = buildForm(fields, {
    values: Object.fromEntries(fields.filter((f) => f.key).map((f) => [f.key, p[f.key] ?? f.value ?? (f.type === 'checkbox' ? false : 0)])),
    onChange: (values) => {
      for (const f of fields) if (f.key) p[f.key] = values[f.key];
      onChange(clone(p));
    },
  });
  return {
    form,
    get: () => clone(p),
    set(next) {
      p = { ...p, ...clone(next ?? {}) };
      for (const f of fields) if (f.key) form.set(f.key, p[f.key] ?? f.value ?? (f.type === 'checkbox' ? false : 0), { silent: true });
    },
  };
}

export function exposureEditor(kind, params, onChange, { app = null } = {}) {
  const fe = formEditor([S('exposure', 'Exposure', -20, 20, 0.01), S('offset', 'Offset', -0.5, 0.5, 0.0001), S('gamma', 'Gamma correction', 0.01, 9.99, 0.01)], params, onChange);
  return {
    element: fe.form.element,
    form: fe.form,
    setParams: (next) => fe.set(next),
    eyedroppers: tonalEyedroppers(app, 'exposure', {
      getParams: fe.get,
      setParams: (next) => {
        fe.set(next);
        onChange(fe.get());
      },
    }),
  };
}

export function thresholdEditor(kind, params, onChange, { source = null } = {}) {
  const el = document.createElement('div');
  el.className = 'threshold-editor tonal-editor';
  const canvas = document.createElement('canvas');
  canvas.className = 'histogram';
  canvas.width = 256;
  canvas.height = 80;
  el.appendChild(canvas);
  drawHistogram(canvas, sourceHistogram(source), 'l');
  let level = Math.round(params?.level ?? 128);
  const fe = formEditor([S('level', 'Threshold level', 1, 255)], { level }, (p) => {
    level = p.level;
    track.set({ level });
    onChange({ level });
  });
  const track = sliderTrack([{ key: 'level', value: level, color: 'gray' }], (_k, v) => {
    level = Math.max(1, Math.min(255, Math.round(v)));
    fe.set({ level });
    track.set({ level });
    onChange({ level });
  }, { className: 'tonal-track-threshold' });
  el.append(track.element, fe.form.element);
  return {
    element: el,
    form: fe.form,
    setParams(next) {
      level = Math.round(next?.level ?? 128);
      fe.set({ level });
      track.set({ level });
    },
  };
}

/**
 * Brightness/Contrast's Auto (Photoshop CS6+): contrast from how much of the range the image uses, brightness from
 * how far its median luma is from the middle. Pure in what it reads.
 */
export function autoBrightnessContrast(src) {
  const h = weightedHistogram(src);
  if (!h.count) return { brightness: 0, contrast: 0, legacy: false };
  const at = (frac) => {
    let cum = 0;
    for (let v = 0; v < 256; v++) if ((cum += h.l[v]) >= h.count * frac) return v;
    return 255;
  };
  const lo = at(0.005), hi = at(0.995), median = at(0.5);
  const spread = Math.max(1, hi - lo);
  const contrast = Math.round(Math.max(-50, Math.min(100, (255 / spread - 1) * 40)));
  const brightness = Math.round(Math.max(-150, Math.min(150, (128 - median) / 0.6 / 2)));
  return { brightness, contrast, legacy: false };
}

export function brightnessContrastEditor(kind, params, onChange) {
  const fe = formEditor([S('brightness', 'Brightness', -150, 150), S('contrast', 'Contrast', -100, 100), { key: 'legacy', label: 'Use legacy', type: 'checkbox' }], params, onChange);
  return {
    element: fe.form.element,
    form: fe.form,
    setParams: (next) => fe.set(next),
    auto: { run: (src) => autoBrightnessContrast(src) },
  };
}
