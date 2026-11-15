// camera-raw-workspace's MODULES entry (ARCHITECTURE.md "0.5 features", package 7). Until the package lands this is
// the skeleton's stub (S15): Edit > Camera Raw Preferences… is a disabled stub and Filter > Camera Raw Filter… opens
// the 0.4 dialog (lib/develop-ui.js). The package replaces this file at the same path with the full-window workspace
// (DevelopWorkspace, S8.2) and calls setDevelopFeature('workspace').
import { stubCommands } from '../stub.js';

export function install(app) {
  stubCommands(app, ['edit:camera-raw-preferences']);
}
