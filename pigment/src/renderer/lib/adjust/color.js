// adjust-color (package 8, ARCHITECTURE.md "0.4 features (contracts)", Packages): Hue/Saturation ranges, the colour
// dialogs, Color and Vibrance, Clarity and Dehaze, Grain (placeholder kinds in src/shared/pixels/adjust-color.js
// until then).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. adjust-color replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, []); // no command of its own: the package registers engines, widgets or kinds
}
