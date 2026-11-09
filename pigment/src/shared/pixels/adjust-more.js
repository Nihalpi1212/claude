// Adjustments added in 0.3 (builder "adjust-more"): Color Lookup (also an adjustment layer), HDR
// Toning, Match Color and Replace Color. Built with lutKind()/pixelKind() from adjust-def.js and
// merged into ADJUSTMENTS by adjust.js; same conventions (in place, rect limits writes, alpha kept).
// Placeholders until the builder lands them; ids, names and the `layer` flag are final.
//
// Import ADJUSTMENTS from './adjust.js' only for use inside apply() (never at module top level):
// adjust.js imports this table, so the modules form a cycle that is safe at call time only.

import { placeholderAdjustment } from './adjust-def.js';

export const ADJUSTMENTS_MORE = Object.freeze({
  // lut: a parsed table { type: '3d', size, data: number[] (r fastest, 0..1 RGB triples) } or { type: '1d', size, data }; preset names map to tables built in code
  'color-lookup': placeholderAdjustment('Color Lookup', { preset: 'none', lut: null, dither: false }, { layer: true }),
  'hdr-toning': placeholderAdjustment('HDR Toning', { method: 'local-adaptation', radius: 100, strength: 50, gamma: 1, exposure: 0, detail: 30, shadow: 0, highlight: 0, vibrance: 0, saturation: 20, curve: null }, { smart: false }),
  // source: Lab statistics of the source pixels { mean: [L, a, b], std: [L, a, b] } computed by the dialog from a layer, document or selection
  'match-color': placeholderAdjustment('Match Color', { luminance: 100, colorIntensity: 100, fade: 0, neutralize: false, source: null }, { smart: false }),
  'replace-color': placeholderAdjustment('Replace Color', { colors: [], fuzziness: 40, localized: false, hue: 0, saturation: 0, lightness: 0 }),
});
