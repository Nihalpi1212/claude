// finish-layer-menu (package 15, ARCHITECTURE.md "0.4 features (contracts)", Packages): the New Layer / Group /
// Duplicate dialogs, Merge, Stamp, layer keys, Background rules (M.3, L.13).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. finish-layer-menu replaces this file at the same path.
import { stubCommands } from './stub.js';
import { BLEND_MODE_KEYS } from '../../shared/keymap.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function install(app) {
  stubCommands(app, [
    'layer:merge-group',
    'layer:new-no-dialog',
    'layer:arrange-reverse',
    'layer:lock-dialog',
    'layer:lock-group',
    'layer:lock-transparency-toggle',
    'layer:stamp-visible',
    'layer:stamp-selected',
    'layer:select-forward',
    'layer:select-backward',
    'layer:select-front',
    'layer:select-back',
    'layer:select-add-forward',
    'layer:select-add-backward',
    'layer:select-similar',
    ...DIGITS.map((d) => `layer:opacity-digit-${d}`),
    ...DIGITS.map((d) => `layer:fill-digit-${d}`),
    ...BLEND_MODE_KEYS.map(([id]) => `layer:blend-mode-${id}`),
    'layer:blend-next',
    'layer:blend-prev',
    // layer:merge (Ctrl+E) is registered working by layer-ops.js (M.6); this package re-registers it
  ]);
}
