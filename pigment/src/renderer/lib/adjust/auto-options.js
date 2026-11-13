// Auto Color Correction Options (adjust-tonal): Photoshop's dialog behind Alt-click on Auto in Levels and Curves
// (and Brightness/Contrast). Algorithms, Snap Neutral Midtones, the target colours and clipping percentages, and
// "Save as defaults", which stores them in settings.adjust.autoOptions (J.7) for the Auto buttons and for Image >
// Auto Tone, Auto Contrast and Auto Color.
import { formDialog } from '../form.js';
import { AUTO_ALGORITHMS, AUTO_DEFAULTS, autoOptions } from '../../../shared/pixels/adjust-tonal.js';

/** The saved options (the defaults while nothing was saved). */
export function savedAutoOptions(app) {
  return autoOptions(app?.settings?.adjust?.autoOptions ?? null);
}

/** True once the user saved options as the defaults (Image > Auto … then use them instead of 0.3's fixed recipe). */
export const hasSavedAutoOptions = (app) => !!app?.settings?.adjust?.autoOptions;

/** Writes the options as the defaults (a new namespace object: J.7 objects are shared, never mutated). */
export function saveAutoOptions(app, options) {
  const adjust = { ...(app.settings.adjust ?? {}), autoOptions: options ? autoOptions(options) : null };
  return app.saveSettings({ adjust });
}

/**
 * Opens the dialog. `initial`: the options to start from (default: the saved ones); `preview(options)` runs on every
 * change (the caller shows the result), `revert()` on Cancel. Resolves with the options (OK) or null. "Save as
 * defaults" writes them to the settings.
 */
export async function openAutoOptions(app, { initial = null, preview = null, revert = null, algorithm = null } = {}) {
  const start = autoOptions({ ...(initial ?? savedAutoOptions(app)), ...(algorithm ? { algorithm } : {}) });
  const fields = [
    { type: 'section', label: 'Algorithms' },
    { key: 'algorithm', label: 'Algorithm', type: 'select', options: AUTO_ALGORITHMS.map(([v, l]) => [v, l]) },
    { key: 'snap', label: 'Snap Neutral Midtones', type: 'checkbox' },
    { type: 'section', label: 'Target Colors & Clipping' },
    { key: 'shadowColor', label: 'Shadows', type: 'color' },
    { key: 'shadowClip', label: 'Clip (shadows)', type: 'number', min: 0, max: 9.99, step: 0.01, unit: '%' },
    { key: 'midColor', label: 'Midtones', type: 'color' },
    { key: 'highlightColor', label: 'Highlights', type: 'color' },
    { key: 'highlightClip', label: 'Clip (highlights)', type: 'number', min: 0, max: 9.99, step: 0.01, unit: '%' },
    { key: 'saveDefaults', label: 'Save as defaults', type: 'checkbox' },
  ];
  const pick = (v) => autoOptions({
    algorithm: v.algorithm, snap: !!v.snap, shadowColor: v.shadowColor, midColor: v.midColor, highlightColor: v.highlightColor,
    shadowClip: Number(v.shadowClip), highlightClip: Number(v.highlightClip),
  });
  const values = await formDialog(app, {
    title: 'Auto Color Correction Options',
    fields,
    values: { ...start, saveDefaults: false },
    width: 380,
    className: 'auto-options-dialog',
    onChange: (v) => {
      try {
        preview?.(pick(v));
      } catch (err) {
        console.error(err);
      }
    },
  });
  if (!values) {
    revert?.();
    return null;
  }
  const opts = pick(values);
  if (values.saveDefaults) await saveAutoOptions(app, opts);
  return opts;
}

export { AUTO_DEFAULTS };
