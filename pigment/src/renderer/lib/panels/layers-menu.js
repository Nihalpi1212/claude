// layers-panel-depth (package 14, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Layers panel menu,
// Panel Options, effect rows, drags, filters.
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. layers-panel-depth replaces this file at the same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    { id: 'layer:collapse-all-groups', record: false },
    { id: 'layer:panel-options', record: false },
  ]);
}
