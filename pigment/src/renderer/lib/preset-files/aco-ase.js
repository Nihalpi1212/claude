// Swatch files (ARCHITECTURE.md "0.5 features", S7.2): Adobe Swatch Exchange (.ase) and Photoshop Color Swatches
// (.aco), pure readers and writers. Owned by preset-files-manager, which registers .ase / .aco for the `swatches` kind
// (registerPresetFormat('swatches', …)); color-picker-swatches' Color Libraries dialog calls parseAse itself to build a
// `color-books` preset.
//
// Skeleton stub (S15, ACO_ASE_REAL false): the readers return no colours and a report line, the writers no bytes.
// Colours are S7.2's { space: 'rgb' | 'lab' | 'cmyk' | 'gray', values } with type 'global' | 'spot' | 'process'.

export const ACO_ASE_REAL = false;

const NOT_YET = 'Swatch files are read once the Preset Manager is part of Pigment';

/** parseAse(bytes) → { groups: { name, colors }[], colors: { name, color, type }[], report: string[] }. Never throws. */
export function parseAse(bytes) {
  void bytes;
  return { groups: [], colors: [], report: [NOT_YET] };
}

/** parseAco(bytes) → the same shape as parseAse (an .aco file has no groups). Never throws. */
export function parseAco(bytes) {
  void bytes;
  return { groups: [], colors: [], report: [NOT_YET] };
}

/** writeAse({ groups, colors }) → { bytes: Uint8Array, report: string[] }. */
export function writeAse({ groups = [], colors = [] } = {}) {
  void groups;
  void colors;
  return { bytes: new Uint8Array(0), report: ['Swatch files are written once the Preset Manager is part of Pigment'] };
}

/** writeAco({ colors }) → { bytes: Uint8Array, report: string[] }. */
export function writeAco({ colors = [] } = {}) {
  void colors;
  return { bytes: new Uint8Array(0), report: ['Swatch files are written once the Preset Manager is part of Pigment'] };
}
