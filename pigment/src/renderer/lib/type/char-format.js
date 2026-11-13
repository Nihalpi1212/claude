// type-character-panel (package 3, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Character panel on the
// range model, units, optical kerning (L.14).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. type-character-panel replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'type:reset-character',
  ]);
}
