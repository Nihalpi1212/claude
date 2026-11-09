// STUB (0.3): File > Automate (Batch, Crop and Straighten, Contact Sheet, Fit Image) and Scripts (Image Processor, Delete Empty Layers, Flatten Effects/Masks).
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['file:automate-batch', 'file:automate-crop-straighten', 'file:automate-contact-sheet', 'file:automate-fit-image', 'file:script-image-processor', 'file:script-delete-empty-layers', 'file:script-flatten-effects', 'file:script-flatten-masks']);
}
