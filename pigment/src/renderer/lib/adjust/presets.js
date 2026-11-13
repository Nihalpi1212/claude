// Adjustment presets (ARCHITECTURE.md "0.4 features", C and I.1). Stub by the 0.4 skeleton; owned by adjust-tonal,
// which registers the preset kinds of its adjustments with Photoshop-like built-ins, the .alv / .acv formats, groups,
// Load / Save and Delete. adjust-color registers the kinds and formats of its own adjustments.
//
// The stub answers which preset kind an adjustment editor uses: the editor's `presetKind`, else
// `adjustment:<kind>` once that kind is registered in the preset store. No kind is registered by the skeleton, so the
// adjustment frame shows no preset menu until a package registers one: the dialogs look as in 0.3.
import { presetKind } from '../presets.js';

/** The preset kind of an adjustment editor (I.2), or null when the kind has no presets. */
export function adjustmentPresetKind(kind, editor = null) {
  if (typeof editor?.presetKind === 'string' && presetKind(editor.presetKind)) return editor.presetKind;
  const k = `adjustment:${kind}`;
  return presetKind(k) ? k : null;
}
