// shapes-live (package 13, ARCHITECTURE.md "0.4 features (contracts)", Packages): live shape properties, the
// Triangle tool, strokes and paints of shapes (J.5).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. shapes-live replaces this file at the same path.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    'layer:copy-shape-attributes',
    'layer:paste-shape-attributes',
  ]);
}
