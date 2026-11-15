// presets-panels' Shapes panel (ARCHITECTURE.md "0.5 features", package 9). Until the package lands this is the
// skeleton's stub (S15): Window > Shapes is a disabled stub. The package replaces this file at the same path;
// registering its panel registers window:panel-shapes (panels.js), which replaces the stub.
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['window:panel-shapes']);
}
