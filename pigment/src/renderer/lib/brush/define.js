// brush-engine-core's MODULES entry (ARCHITECTURE.md "0.5 features", package 1). Until the package lands this is the
// skeleton's stub (S15): its commands (S13.3) are disabled stubs, so the menu greys Edit > Define Brush Preset… out.
// The package replaces this file at the same path: Define Brush Preset (a `brushes` preset with a sampled tip, group
// "Defined") and the options bar's airbrush button through tool:airbrush-toggle (writes preset.buildUp through
// setToolBrush, S1.3).
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['edit:define-brush', 'tool:airbrush-toggle']);
}
