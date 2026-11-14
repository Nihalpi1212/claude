// type-menu-commands' MODULES entry (ARCHITECTURE.md "0.5 features", package 13). Until the package lands this is
// the skeleton's stub (S15): its Type menu, options bar and toolbox commands (S13.3) are disabled stubs (the Type Mask
// tools' tool:* ids are replaced by app.tools.register when the tools register in the `text` slot). The package
// replaces this file at the same path: Warp Text, anti-aliasing, Create Work Path, Convert to Shape, the text kind
// conversion, Update All Text Layers, Paste Lorem Ipsum, the orientation button and the two Type Mask tools.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, [
    'type:anti-alias', 'type:warp-text', 'type:create-work-path', 'type:convert-to-shape', 'type:convert-text-kind',
    'type:update-all', 'type:paste-lorem-ipsum', 'type:toggle-orientation',
    'tool:type-mask-horizontal', 'tool:type-mask-vertical',
  ]);
}
