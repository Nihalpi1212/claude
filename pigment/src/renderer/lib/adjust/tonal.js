// adjust-tonal (package 7, ARCHITECTURE.md "0.4 features (contracts)", Packages): Levels, Curves, Exposure,
// Threshold and Brightness/Contrast editors with eyedroppers, the on-image tool, Auto and Auto Color Correction
// Options (I.1, I.2); their adjustment presets and the .alv / .acv files (C); the real `preset` widget (H); and the
// four "last settings" commands, Alt+Ctrl+L / M / U / B (M.7). The MODULES entry of the package.
//
// The editors are registered with app.adjustEditors (adjust-ui.js), so the Image > Adjustments dialogs and the
// Properties panel (lib/properties/adjustment.js) both build them, inside the adjustment frame (lib/adjust/frame.js).
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { levelsEditor } from './levels-editor.js';
import { curvesEditor } from './curves-editor.js';
import { exposureEditor, thresholdEditor, brightnessContrastEditor } from './simple-editors.js';
import { registerTonalPresets } from './presets.js';
import './preset-widget.js';

/** The four commands that open a dialog with the last-used values (Photoshop's Alt+Ctrl variants). */
export const LAST_COMMANDS = Object.freeze({
  'image:adjust-levels-last': 'levels',
  'image:adjust-curves-last': 'curves',
  'image:adjust-hue-saturation-last': 'hue-saturation',
  'image:adjust-color-balance-last': 'color-balance',
});

export function install(app) {
  registerTonalPresets();
  const reg = app.adjustEditors;
  reg.register('levels', { editor: levelsEditor, width: 380 });
  reg.register('curves', { editor: curvesEditor, width: 360 });
  reg.register('exposure', { editor: exposureEditor, width: 420 });
  reg.register('threshold', { editor: thresholdEditor, width: 380 });
  reg.register('brightness-contrast', { editor: brightnessContrastEditor, width: 420 });

  const has = () => !!app.doc?.active;
  const cmds = {};
  for (const [id, kind] of Object.entries(LAST_COMMANDS)) {
    cmds[id] = {
      enabled: () => has() && !!ADJUSTMENTS[kind] && !ADJUSTMENTS[kind].placeholder,
      run: (arg, ctx) => app.adjustDialog(kind, arg, ctx, { last: true }),
      label: `${ADJUSTMENTS[kind]?.name ?? kind} (last settings)…`,
      dialog: true,
    };
  }
  app.commands.registerAll(cmds);
}
