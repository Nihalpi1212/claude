// Layer effects and advanced blending ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: aspects `advanced-blending` 210
// and `effects` 400; S4.6). psd-layers' file; until it lands this is the skeleton's stub: it registers nothing, so
// PSD files keep 0.4's behaviour (effects and Blending Options other than Blend If are dropped on save, with the
// built-in 'styled' notice). psd-layers replaces it at the same path and keeps these exports (preset-files-manager's
// .asl reader and writer call them, gating their content assertions on psdFeatures().effects).

import { registerPsdFeatures } from './registry.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ effects: false, advancedBlending: false });
registerPsdFeatures(PSD_FEATURES);

/**
 * Pigment layer styles from ag-psd's `effects` (a layer's `effects`, or one style of an .asl file):
 * `{ styles, report }`; `patterns` maps a PSD pattern id to its PatternInfo. Stub: nothing is mapped.
 */
export function stylesFromPsd(effectsInfo, { patterns = new Map() } = {}) {
  void effectsInfo;
  void patterns;
  return { styles: null, report: ['effects'] };
}

/** ag-psd `effects` for Pigment layer styles: `{ effects, patterns, report }`. Stub: nothing is written. */
export function stylesToPsd(styles, ctx = {}) {
  void styles;
  void ctx;
  return { effects: null, patterns: [], report: ['effects'] };
}
