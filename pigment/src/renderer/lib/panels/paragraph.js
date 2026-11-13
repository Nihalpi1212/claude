// type-paragraph-panel (package 4, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Paragraph panel,
// composers, breakers, hyphenation, lists.
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. type-paragraph-panel replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'window:panel-paragraph',
    'type:reset-paragraph',
    'type:hyphenation-settings',
    'type:justification-settings',
  ]);
}
