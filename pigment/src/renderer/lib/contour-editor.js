// layer-style-effects (package 6, ARCHITECTURE.md "0.4 features (contracts)", Packages): contours, the Contour
// Editor, effect instances and the new effect fields (J.6).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. layer-style-effects replaces this file at the same path.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, []); // no command of its own: the package registers engines, widgets or kinds
}
