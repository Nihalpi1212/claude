// Layer colour labels, link groups and the global light ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: aspect `tags`
// 500, resource `global-light` 250). psd-layers' file; until it lands this is the skeleton's stub: it registers
// nothing (0.4 writes neither). psd-layers replaces it at the same path.

import { registerPsdFeatures } from './registry.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ tags: false, globalLight: false });
registerPsdFeatures(PSD_FEATURES);
