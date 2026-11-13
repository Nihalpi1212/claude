// type-editing (package 2, ARCHITECTURE.md "0.4 features (contracts)", Packages): the Type tool editor, its session
// and the TYPE_KEYS commands (B.7, B.8).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. type-editing replaces this file at the same path.
import { stubCommands } from '../stub.js';
import { TYPE_KEYS } from '../../../shared/keymap.js';

const TYPE_IDS = Object.keys(TYPE_KEYS);

export function install(app) {
  stubCommands(app, [
    'edit:paste-without-formatting',
    // the 36 commands of TYPE_KEYS (src/shared/keymap.js), dispatched by the editor's own input
    ...TYPE_IDS,
  ]);
}
