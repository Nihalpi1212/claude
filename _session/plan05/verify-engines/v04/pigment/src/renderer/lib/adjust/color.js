// adjust-color (package 8, ARCHITECTURE.md "0.4 features (contracts)", Packages): the colour adjustment dialogs, the
// newer adjustments, adjustment presets and the Adjustment Brush. The MODULES entry of the package.
//
//  - editors (I.2) registered with app.adjustEditors, so the Image > Adjustments dialogs and the Properties panel
//    (lib/properties/adjustment.js) both build them inside the adjustment frame (I.1): Hue/Saturation
//    (hue-sat-editor.js), Black & White, Photo Filter, Channel Mixer, Gradient Map, Selective Color and the three new
//    kinds (color-editors.js), Shadows/Highlights (shadows-highlights.js); HDR Toning's editor and its `prepare`
//    hook live in lib/adjust-more-ui.js
//  - the preset kinds `adjustment:<kind>` of these kinds with Photoshop-like built-ins, and the .ahu, .cha, .asv and
//    .blw files (color-formats.js) through adjust-tonal's registerAdjustmentPresets / registerAdjustmentFormat
//  - the Adjustments panel's preset groups (lib/panels/adjustment-presets.js): command `layer:adjustment-preset`
//  - the Adjustment Brush tool (lib/tools/adjustment-brush.js)
// The new kinds Color and Vibrance, Clarity and Dehaze and Grain are real registry kinds (src/shared/pixels/
// adjust-color.js), so their Image > Adjustments and New Adjustment Layer items are enabled.
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { registerAdjustmentPresets, registerAdjustmentFormat } from './presets.js';
import { COLOR_BUILTINS, normalizeColorPreset, readAhu, writeAhu, readCha, writeCha, readAsv, writeAsv, readBlw, writeBlw } from './color-formats.js';
import { hueSatEditor } from './hue-sat-editor.js';
import { shadowsHighlightsEditor, SH_START } from './shadows-highlights.js';
import { blackWhiteEditor, photoFilterEditor, channelMixerEditor, gradientMapEditor, selectiveColorEditor, fieldsEditor } from './color-editors.js';
import { installAdjustmentBrush } from '../tools/adjustment-brush.js';
import { adjustmentPresetCommand } from '../panels/adjustment-presets.js';
import './preset-widget.js';

const TITLES = {
  'hue-saturation': 'Hue/Saturation', 'black-white': 'Black & White', 'photo-filter': 'Photo Filter', 'channel-mixer': 'Channel Mixer',
  'gradient-map': 'Gradient Map', 'selective-color': 'Selective Color', 'shadows-highlights': 'Shadows/Highlights', 'hdr-toning': 'HDR Toning',
  'color-vibrance': 'Color and Vibrance', 'clarity-dehaze': 'Clarity and Dehaze', grain: 'Grain',
};

let registered = false;

/** The preset kinds and files of the colour kinds (idempotent; install calls it, the unit tests directly). */
export function registerColorPresets() {
  if (registered) return;
  registered = true;
  for (const [kind, title] of Object.entries(TITLES)) {
    if (!ADJUSTMENTS[kind]) continue;
    registerAdjustmentPresets(kind, { title, builtins: COLOR_BUILTINS[kind] ?? [], normalize: (data) => normalizeColorPreset(kind, data) });
  }
  registerAdjustmentFormat('hue-saturation', { id: 'ahu', name: 'Hue/Saturation presets (.ahu)', extensions: ['ahu'], read: (b) => readAhu(b), write: writeAhu });
  registerAdjustmentFormat('channel-mixer', { id: 'cha', name: 'Channel Mixer presets (.cha)', extensions: ['cha'], read: (b) => readCha(b), write: writeCha });
  registerAdjustmentFormat('selective-color', { id: 'asv', name: 'Selective Color presets (.asv)', extensions: ['asv'], read: (b) => readAsv(b), write: writeAsv });
  registerAdjustmentFormat('black-white', { id: 'blw', name: 'Black & White presets (.blw)', extensions: ['blw'], read: (b) => readBlw(b), write: writeBlw });
}

export function install(app) {
  registerColorPresets();
  const reg = app.adjustEditors;
  reg.register('hue-saturation', { editor: hueSatEditor, width: 440 });
  reg.register('black-white', { editor: blackWhiteEditor, width: 420 });
  reg.register('photo-filter', { editor: photoFilterEditor, width: 400, start: () => ({ ...ADJUSTMENTS['photo-filter'].defaults, density: 25 }) });
  reg.register('channel-mixer', { editor: channelMixerEditor, width: 420 });
  reg.register('gradient-map', { editor: gradientMapEditor, width: 420 });
  reg.register('selective-color', { editor: selectiveColorEditor, width: 420 });
  reg.register('shadows-highlights', { editor: shadowsHighlightsEditor, width: 440, start: () => ({ ...SH_START }) });
  for (const k of ['color-vibrance', 'clarity-dehaze', 'grain']) reg.register(k, { editor: fieldsEditor, width: 400 });
  installAdjustmentBrush(app);
  app.commands.register('layer:adjustment-preset', adjustmentPresetCommand(app));
}
