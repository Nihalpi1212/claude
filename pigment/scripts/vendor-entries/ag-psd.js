// Entry bundled by scripts/build-vendor.mjs: re-exports the ag-psd API as named ES exports, with the Gradient Map
// interpolation method fixed in ag-psd's handler registry (ag-psd-grdm.js).
export { readPsd, writePsd, writePsdUint8Array, initializeCanvas, byteArrayToBase64 } from 'ag-psd';
export { grdmPatched } from './ag-psd-grdm.js';
