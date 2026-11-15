// Maximize Compatibility (ARCHITECTURE.md "0.5 features", S4.4, S12.3, S14.1): the PSD save option and the Preferences
// section `file-handling` (order 45). psd-layers' file.
//
// The preference `settings.psd.maximizeCompatibility` is Photoshop's "Maximize PSD and PSB File Compatibility":
// 'always' (the default: the file carries the flattened picture, so other applications and older Photoshops can show
// it), 'never' (a blank composite: a smaller file only a layered reader can show) or 'ask' (Photoshop Format Options
// on every save to PSD). writePsdDocument resolves the preference itself (lib/psd/write.js), so Batch, the Image
// Processor and every save that cannot ask follow it ('ask' then means on); this file only asks.
//
// Node-safe at import (lib/psd/*.js are imported by Node tests): the dialog module is loaded when a save asks.

export const MAXIMIZE_CHOICES = Object.freeze([
  ['always', 'Always'],
  ['ask', 'Ask'],
  ['never', 'Never'],
]);
const VALID = new Set(MAXIMIZE_CHOICES.map(([v]) => v));

/** The preference, read defensively ('always' when missing or unknown). */
export const maximizePreference = (settings) => (VALID.has(settings?.psd?.maximizeCompatibility) ? settings.psd.maximizeCompatibility : 'always');

/**
 * The save option of S12.3 for .psd: `{}` (the preference decides in writePsdDocument) unless the preference is 'ask',
 * then Photoshop Format Options; null cancels the save. "Don't show again" makes the answer the preference.
 */
export async function askMaximizeCompatibility(app, doc, path, { ask = true } = {}) {
  void doc;
  void path;
  if (maximizePreference(app.settings) !== 'ask') return {};
  if (!ask) return { maximizeCompatibility: true };
  const { formDialog } = await import('../form.js');
  const v = await formDialog(app, {
    title: 'Photoshop Format Options',
    className: 'psd-format-options',
    okLabel: 'OK',
    fields: [
      { key: 'maximize', label: 'Maximize compatibility', type: 'checkbox', value: true, help: 'The file also holds the flattened picture, so other applications and older versions of Photoshop can show it. The file is larger.' },
      { key: 'remember', label: "Don't show again", type: 'checkbox', value: false },
    ],
  });
  if (!v) return null;
  if (v.remember) {
    app.settings.psd = { ...(app.settings.psd ?? {}), maximizeCompatibility: v.maximize ? 'always' : 'never' };
    app.saveSettingsSoon?.();
  }
  return { maximizeCompatibility: !!v.maximize };
}

/** The Preferences section `file-handling` (E20). */
export function fileHandlingSection() {
  return {
    id: 'file-handling',
    title: 'File Handling',
    order: 45,
    fields: [
      {
        key: 'psdMaximize',
        label: 'Maximize PSD and PSB File Compatibility',
        type: 'select',
        options: MAXIMIZE_CHOICES.map(([v, l]) => [v, l]),
        help: 'Always: PSD files also hold the flattened picture, which other applications show. Never: smaller files that only layered readers can show. Ask: choose on every save.',
      },
    ],
    read: (s) => ({ psdMaximize: maximizePreference(s) }),
    write(v, s) {
      const next = VALID.has(v.psdMaximize) ? v.psdMaximize : 'always';
      if (next === maximizePreference(s)) return {};
      return { psd: { ...(s.psd ?? {}), maximizeCompatibility: next } };
    },
  };
}

/** Registers the save option and the Preferences section (renderer only: documents.js is loaded here, not at import). */
export function installFileHandling(app) {
  app.preferences?.registerSection?.(fileHandlingSection());
  // documents.js is a DOM module: a Node test that imports lib/psd/*.js must not load it
  import('../documents.js')
    .then(({ registerSaveOptions }) => registerSaveOptions('psd', { ask: (a, doc, path, opts) => askMaximizeCompatibility(a, doc, path, opts) }))
    .catch((err) => console.error('PSD save options could not be registered', err));
}
