// Entry bundled by scripts/build-vendor.mjs: re-exports the ag-psd API as named ES exports, with Pigment's fixes to
// ag-psd's handler registries applied first (ag-psd-fixes.js: the Gradient Map method of 0.4, psd-layers' and
// psd-text's fixes of 0.5) and the internals that preset files and mappers need (ag-psd-internals.js, S4.5).
//
// Renderer modules import it as '#ag-psd': package.json's "imports" sends Node to this file (so Node tests load the
// real entry with every fix) and the browser to the bundle, src/renderer/vendor/ag-psd.js (the import map's key).
import './ag-psd-fixes.js';
export { readPsd, writePsd, writePsdUint8Array, initializeCanvas, byteArrayToBase64 } from 'ag-psd';
export { grdmPatched } from './ag-psd-grdm.js';
export { fixesPatched } from './ag-psd-fixes.js';
export * from './ag-psd-internals.js';
