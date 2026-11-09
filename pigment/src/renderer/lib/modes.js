// STUB (0.3): Image > Mode (Bitmap, Grayscale, Duotone, Indexed Color, RGB, CMYK, Lab, Multichannel), Color Table, Trap, Conditional Mode Change, Save for Web, GIF/PNG-8 export.
// Replaced by its builder; the contract is in ARCHITECTURE.md "0.3 features (contracts)".
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, ['image:mode', 'image:color-table', 'image:trap', 'file:automate-conditional-mode', 'file:save-for-web']);
}
