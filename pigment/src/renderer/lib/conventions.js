// conventions-shortcuts-fields (package 16, ARCHITECTURE.md "0.4 features (contracts)", Packages): Search, Toggle
// Last State, temporary and spring-loaded tools, numeric fields, movable dialogs.
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. conventions-shortcuts-fields replaces this file at the same path.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    { id: 'edit:toggle-last-state', undoLike: true },
    { id: 'edit:search', record: false },
  ]);
}
