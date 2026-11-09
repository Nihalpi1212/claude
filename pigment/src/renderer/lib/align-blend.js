// STUB (0.3): Auto-Align Layers, Auto-Blend Layers, Photomerge, Load Files into Stack, Statistics, Stack Mode.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['edit:auto-align', 'edit:auto-blend', 'file:automate-photomerge', 'file:script-load-stack', 'file:script-statistics', 'layer:stack-mode']);
}
