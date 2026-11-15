// brush-settings-panel's MODULES entry (ARCHITECTURE.md "0.5 features", package 2): the Brush Settings panel (F5).
// Until the package lands this is the skeleton's stub (S15): Window > Brush Settings is a disabled stub. The package
// replaces this file at the same path; registering its panel registers window:panel-brush-settings (panels.js), which
// replaces the stub.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['window:panel-brush-settings']);
}
