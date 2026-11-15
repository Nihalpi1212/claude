// Pigment's fixes to ag-psd's handler registries (ARCHITECTURE.md "0.5 features", S4.5), skeleton file. Each fix wraps
// a handler of ag-psd's `infoHandlersMap` / `resourceHandlersMap` the way ag-psd-grdm.js does, is idempotent and
// exports `patched: boolean`. The bundle entry (ag-psd.js) imports this file first, so the browser bundle and Node
// (through package.json's "#ag-psd") always read and write with every fix applied.
import { grdmPatched } from './ag-psd-grdm.js';
import { patched as layersPatched } from './ag-psd-layers.js';
import { patched as textPatched } from './ag-psd-text.js';

/** Which fixes are applied: 0.4's Gradient Map method, psd-layers' and psd-text's (false while they are stubs). */
export const fixesPatched = Object.freeze({ grdm: grdmPatched, layers: layersPatched, text: textPatched });
