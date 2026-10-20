// Colour modes (see ARCHITECTURE.md "Colour modes"): View › Proof Colors renders the composite as
// a CMYK press would print it and View › Gamut Warning greys the pixels that cannot be printed.
// Both are previews: the document stays 8-bit RGB. They are settings (proofColors, gamutWarning),
// mirrored to the native menu through app.syncUiState, and applied by one hook on the canvas
// view (view.postProcess) that hands back a processed copy of the composite to draw instead.
import { applyProof } from '../../shared/pixels/color.js';
import { createCanvas } from './document.js';

export function install(app) {
  // the processed composite, kept until the document or the toggles change (paint() runs every
  // frame while a selection's marching ants animate)
  let cache = null;

  const enabled = () => ({ proof: !!app.settings.proofColors, gamut: !!app.settings.gamutWarning });

  function postProcess(composite, view) {
    const { proof, gamut } = enabled();
    if (!proof && !gamut) return null;
    const doc = view?.doc ?? app.doc;
    // root.version moves with every layer.touch() (a brush stroke calls no doc.changed until it ends)
    const key = `${doc?.id}:${doc?.version}:${doc?.root?.version}:${composite.width}x${composite.height}:${proof ? 'p' : ''}${gamut ? 'g' : ''}`;
    if (cache?.key === key) return cache.canvas;
    try {
      const w = composite.width, h = composite.height;
      const img = composite.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
      applyProof(img, { proof, gamut });
      const canvas = createCanvas(w, h);
      canvas.getContext('2d').putImageData(img, 0, 0);
      cache = { key, canvas };
      return canvas;
    } catch (err) {
      console.warn('proof colours', err);
      return null;
    }
  }

  /** Every document owns a view; the hook goes on each one as it appears. */
  const attach = (doc) => {
    if (doc?.view) doc.view.postProcess = postProcess;
  };
  for (const doc of app.docs?.docs ?? []) attach(doc);
  app.on('doc:opened', attach);
  app.on('doc:activated', attach);

  function toggle(key, label) {
    const value = !app.settings[key];
    app.saveSettings({ [key]: value }); // emits settings:changed -> syncUiState mirrors the menu check marks
    cache = null;
    app.view?.invalidate();
    app.commands.invalidate();
    app.dialogs?.toast?.(`${label} ${value ? 'on' : 'off'}`, { timeout: 1200 });
  }

  app.commands.registerAll({
    'view:proof': { label: 'Proof Colors', checked: () => !!app.settings.proofColors, run: () => toggle('proofColors', 'Proof Colors') },
    'view:gamut': { label: 'Gamut Warning', checked: () => !!app.settings.gamutWarning, run: () => toggle('gamutWarning', 'Gamut Warning') },
  });

  app.on('settings:changed', (patch) => {
    if (patch && ('proofColors' in patch || 'gamutWarning' in patch)) {
      cache = null;
      app.view?.invalidate();
    }
  });
}
