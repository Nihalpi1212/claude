// adjust-tonal (package 7, ARCHITECTURE.md "0.4 features (contracts)", Packages): Levels, Curves and the other tonal
// dialogs, presets, eyedroppers, Auto (I.1, I.2).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. adjust-tonal replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'image:adjust-levels-last',
    'image:adjust-curves-last',
    'image:adjust-hue-saturation-last',
    'image:adjust-color-balance-last',
  ]);
}
