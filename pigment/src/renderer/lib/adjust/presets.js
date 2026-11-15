// Adjustment presets (ARCHITECTURE.md "0.4 features", C and I.1), owned by adjust-tonal. It registers the preset
// kinds of the tonal adjustments (`adjustment:levels`, `:curves`, `:exposure`, `:brightness-contrast`,
// `:threshold`) with Photoshop-like built-ins, and Photoshop's .alv (Levels) and .acv (Curves) file formats.
// adjust-color registers the kinds and formats of its own adjustments through registerAdjustmentPresets() and
// registerAdjustmentFormat() below. No DOM here: the `preset` widget (lib/adjust/preset-widget.js) is the UI.
//
// adjustmentPresetKind(kind, editor) (the skeleton's API, kept) answers which preset kind an adjustment editor uses:
// the editor's `presetKind`, else `adjustment:<kind>` once that kind is registered.
import { presetKind, registerPresetKind, registerPresetFormat } from '../presets.js';
import { TONAL_BUILTINS, normalizeTonalPreset, readAcv, writeAcv, readAlv, writeAlv } from './tonal-formats.js';

/** The preset kind of an adjustment editor (I.2), or null when the kind has no presets. */
export function adjustmentPresetKind(kind, editor = null) {
  if (typeof editor?.presetKind === 'string' && presetKind(editor.presetKind)) return editor.presetKind;
  const k = `adjustment:${kind}`;
  return presetKind(k) ? k : null;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Registers `adjustment:<kind>` in the preset store: { title, builtins: [{ id, name, data, group? }], groups?,
 * normalize?(data) -> data | null, version? }. Built-in ids stay stable across releases (the user's file refers to
 * them).
 */
export function registerAdjustmentPresets(kind, { title, builtins = [], groups = [], normalize = null, version = 1 } = {}) {
  registerPresetKind(`adjustment:${kind}`, {
    title: title ?? kind,
    version,
    builtins: () => ({ groups: clone(groups), presets: clone(builtins) }),
    normalize: (data) => (normalize ? normalize(data) : data && typeof data === 'object' ? data : null),
  });
}

/**
 * Registers a single-setting file format for `adjustment:<kind>` (Photoshop's adjustment files hold one setting):
 * { id, name, extensions, read(bytes) -> { params, report }, write(params) -> Uint8Array }. Reading names the preset
 * after the file; writing several presets writes the first and says so.
 */
export function registerAdjustmentFormat(kind, { id, name, extensions, read, write }) {
  registerPresetFormat(`adjustment:${kind}`, {
    id,
    name,
    extensions,
    async read(bytes, { name: file = '' } = {}) {
      const res = read(bytes);
      const base = String(file).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'Preset';
      return { presets: [{ name: base, data: res.params }], report: res.report ?? [] };
    },
    write: write
      ? async (presets) => {
        if (!presets.length) throw new Error('No preset to write');
        return write(presets[0].data);
      }
      : undefined,
    /** The current settings (not a stored preset) as a file: used by the widget's "Save to File…". */
    writeParams: write ? (params) => write(params) : undefined,
  });
}

let registered = false;

/** The tonal kinds and formats (idempotent; lib/adjust/tonal.js calls it at install, the unit tests directly). */
export function registerTonalPresets() {
  if (registered) return;
  registered = true;
  const titles = { levels: 'Levels', curves: 'Curves', exposure: 'Exposure', 'brightness-contrast': 'Brightness/Contrast', threshold: 'Threshold' };
  for (const [kind, title] of Object.entries(titles)) {
    registerAdjustmentPresets(kind, { title, builtins: TONAL_BUILTINS[kind], normalize: (data) => normalizeTonalPreset(kind, data) });
  }
  registerAdjustmentFormat('levels', { id: 'alv', name: 'Levels presets (.alv)', extensions: ['alv'], read: (b) => readAlv(b), write: writeAlv });
  registerAdjustmentFormat('curves', { id: 'acv', name: 'Curves presets (.acv)', extensions: ['acv'], read: (b) => readAcv(b), write: writeAcv });
}
