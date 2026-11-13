// gradients (package 9, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Gradients panel, Gradient Editor,
// gradient widget and live gradients (G).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. gradients replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'window:panel-gradients',
  ]);
}
