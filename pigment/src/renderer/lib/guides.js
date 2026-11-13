// guides-snapping (package 11, ARCHITECTURE.md "0.4 features (contracts)", Packages): guides as store objects, Snap
// To, Smart Guides, rulers (F, L.10).
// MODULES entry stub by the 0.4 skeleton: it only stubs the package's new command ids (M.6, M.7), so the menu items
// and keys exist, disabled, before the package lands. guides-snapping replaces this file at the same path.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    'view:smart-guides',
    'view:snap-to',
    'view:lock-guides',
    // guide commands that change the document carry changesDocument (E31) already as stubs
    { id: 'view:clear-selected-guides', changesDocument: true },
    { id: 'view:clear-artboard-guides', changesDocument: true },
    { id: 'view:new-guide-layout', changesDocument: true },
    { id: 'view:guides-from-shape', changesDocument: true },
    { id: 'view:edit-selected-guides', changesDocument: true },
    'view:ruler-unit',
    { id: 'view:ruler-origin-reset', changesDocument: true },
  ]);
}
