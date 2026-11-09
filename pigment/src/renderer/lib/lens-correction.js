// STUB (0.3): Filter > Lens Correction dialog (the filter kind lives in src/shared/pixels/lens.js; this marks its command as not ready).
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['filter:lens-correction']);
}
