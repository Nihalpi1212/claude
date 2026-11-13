// masks-vector-masks (package 12, ARCHITECTURE.md "0.4 features (contracts)", Packages): vector masks, mask density
// and feather, the mask overlay (K.1, L.4, L.15).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. masks-vector-masks replaces this file at the same path.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    'layer:vector-mask',
    'layer:mask-overlay',
    'layer:mask-overlay-options',
    'path:make-mask',
    'path:make-shape',
  ]);
}
