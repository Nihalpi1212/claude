// type-fonts' MODULES entry (ARCHITECTURE.md "0.5 features", package 12, S11.1–S11.2). Skeleton stub: its Type menu
// commands (S13.3) are disabled stubs. Step 9 of the skeleton adds the stub font catalog (0.4's family list,
// registerFontCatalog) and the font-family / font-style widgets as 0.4's selects. The package replaces this file at the
// same path.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['type:add-fonts', 'type:font-preview-size', 'type:manage-missing-fonts', 'type:replace-missing-fonts']);
}
