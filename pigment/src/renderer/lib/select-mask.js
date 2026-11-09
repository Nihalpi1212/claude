// STUB (0.3): Select > Subject / Sky / Focus Area, Select and Mask workspace, Object Selection tool.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['select:subject', 'select:sky', 'select:focus-area', 'select:select-mask']);
}
