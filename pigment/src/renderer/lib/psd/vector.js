// Vector masks, shape layers and paths ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: kind `shape` 350, aspect
// `vector-mask` 290; S4.6). psd-layers' file; until it lands this is the skeleton's stub: it registers nothing, so a
// vector mask is baked into the PSD's raster mask (J.8, the built-in raster-mask aspect) and shapes are written as
// pixels, as in 0.4. psd-layers replaces it at the same path and keeps these exports (preset-files-manager's .csh
// reader calls them, gating its content assertions on psdFeatures().vectorMasks).

import { registerPsdFeatures } from './registry.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ vectorMasks: false, shapes: false });
registerPsdFeatures(PSD_FEATURES);

/** A Pigment Path (document px) from ag-psd's path records of a `w` × `h` document, or null. Stub: null. */
export function pathFromPsd(paths, w, h) {
  void paths;
  void w;
  void h;
  return null;
}

/** ag-psd's path records for a Pigment Path in a `w` × `h` document, or null. Stub: null. */
export function pathToPsd(path, w, h) {
  void path;
  void w;
  void h;
  return null;
}
