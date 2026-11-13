// patterns (package 10, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Patterns panel, the pattern
// library behind app.patterns, Pattern Preview (L.6).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. patterns replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'window:panel-patterns',
    'view:pattern-preview',
  ]);
}
