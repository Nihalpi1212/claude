// STUB (0.3): 16 and 32 bits per channel (RasterLayer.deep), 16-bit PNG and TIFF/TGA formats.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['image:depth']);
}
