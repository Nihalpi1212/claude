// brush-painting-behaviours' MODULES entry (ARCHITECTURE.md "0.5 features", package 3). Until the package lands this
// is the skeleton's stub (S15): the paint-context key commands (S13.3, bound in keymap.js PAINT_KEYS) are disabled
// stubs, so shortcuts.js finds no enabled paint command and the global table answers the key as in 0.4 (S13.4). The
// package replaces this file at the same path: brush preset stepping, the opacity and flow digits (two digits within
// settings.painting.digitPairMs set an exact value) and the tool blend modes.
import { stubCommands } from '../stub.js';
import { BLEND_MODE_KEYS } from '../../../shared/keymap.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The 23 blend modes of BLEND_MODE_KEYS other than Pass Through, then Behind and Clear (painting modes). */
export const PAINT_BLEND_MODES = [...BLEND_MODE_KEYS.map(([id]) => id).filter((id) => id !== 'pass-through'), 'behind', 'clear'];
export const PAINT_KEY_COMMANDS = [
  'tool:brush-prev', 'tool:brush-next', 'tool:brush-first', 'tool:brush-last',
  ...DIGITS.map((d) => `tool:opacity-digit-${d}`),
  ...DIGITS.map((d) => `tool:flow-digit-${d}`),
  ...PAINT_BLEND_MODES.map((m) => `tool:blend-mode-${m}`),
];

export function install(app) {
  stubCommands(app, PAINT_KEY_COMMANDS);
}
