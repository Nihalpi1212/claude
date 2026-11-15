// presets-panels' MODULES entry (ARCHITECTURE.md "0.5 features", package 9). Until the package lands this is the
// skeleton's stub (S15): its commands (S13.3) are disabled stubs; the three panel modules (lib/panels/styles.js,
// shapes.js, tool-presets.js) stub the Window items. The package replaces these files at the same paths: Tool
// Presets (tool:preset, tool:reset, tool:reset-all, the options bar's title slot), Styles (layer:style-preset) and
// Define Custom Shape.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['edit:define-custom-shape', 'tool:preset', 'tool:reset', 'tool:reset-all', 'layer:style-preset']);
}
