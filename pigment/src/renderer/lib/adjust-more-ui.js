// STUB (0.3): Color Lookup, HDR Toning, Match Color and Replace Color editors; Apply Image, Calculations, Matting, Export Color Lookup Tables, Merge to HDR.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['image:apply-image', 'image:calculations', 'layer:matting', 'file:export-luts', 'file:automate-merge-hdr']);
}
