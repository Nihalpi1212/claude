// Edit › Content-Aware Fill: replaces the selected pixels of the active layer with texture
// synthesised from their surroundings (src/shared/pixels/inpaint.js). Also used by the Spot
// Healing Brush in content-aware mode.
import { inpaint } from '../../shared/pixels/inpaint.js';
import { beginPixelEdit, processed } from './adjust-ui.js';

/**
 * Fills the area given by a document-sized coverage mask (Uint8 0..255) on the active pixels.
 * Returns true when something was filled.
 */
export async function contentAwareFill(app, mask, { label = 'Content-Aware Fill', quiet = false } = {}) {
  const d = app.doc;
  let x1 = d.width, y1 = d.height, x2 = -1, y2 = -1;
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (mask[y * d.width + x]) {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  if (x2 < 0) return false;
  const size = Math.max(x2 - x1 + 1, y2 - y1 + 1);
  const margin = Math.max(48, size * 2);
  // the session reads a margin of context around the hole; without a selection it covers the layer
  const saved = d.selection;
  const { Selection } = await import('./selection.js');
  d.selection = Selection.fromMask(d.width, d.height, mask);
  let session;
  try {
    session = beginPixelEdit(app, { label, margin, quiet });
  } finally {
    d.selection = saved;
  }
  if (!session) return false;
  const r = session.rect;
  const hole = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) {
    const dy = r.y + y;
    if (dy < 0 || dy >= d.height) continue;
    for (let x = 0; x < r.width; x++) {
      const dx = r.x + x;
      if (dx < 0 || dx >= d.width) continue;
      hole[y * r.width + x] = mask[dy * d.width + dx] ? 255 : 0;
    }
  }
  try {
    const img = await app.busy('Filling…', async () => processed(session, (x) => inpaint(x, hole, { patch: size < 24 ? 5 : 7 })));
    session.commit(label, img);
    return true;
  } catch (err) {
    session.cancel();
    app.reportError(err, `${label} failed`);
    return false;
  }
}

export function install(app) {
  app.contentAwareFill = (mask, opts) => contentAwareFill(app, mask, opts);
  app.commands.register('edit:content-aware-fill', {
    enabled: () => !!app.doc?.selection && !app.doc.selection.isEmpty && !!app.doc.active,
    label: 'Content-Aware Fill',
    run: () => {
      const sel = app.doc.selection;
      return contentAwareFill(app, sel.mask);
    },
  });
}
