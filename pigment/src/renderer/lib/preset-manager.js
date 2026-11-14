// preset-files-manager's MODULES entry (ARCHITECTURE.md "0.5 features", package 10). Until the package lands this is
// the skeleton's stub (S15): Edit > Presets ▸ has disabled stubs. The package replaces this file at the same path with
// the Preset Manager, Export/Import Presets (a .pigment-bundle, S10.7) and Migrate Presets.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['edit:preset-manager', 'edit:export-import-presets', 'edit:migrate-presets']);
}
