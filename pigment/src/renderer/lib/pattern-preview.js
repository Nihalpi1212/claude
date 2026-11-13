// View > Pattern Preview (patterns package; ARCHITECTURE.md "0.4 features", package 10, L.5): the document repeated
// around itself in the window, as Photoshop shows it, so a tile can be painted seamlessly: a stroke that crosses an
// edge shows up on the far side at once. It only changes the view (a view underlay, L.5): the document, its pixels
// and its size stay as they are. app.ui.patternPreview holds the state (off at every start, a ui state, not a
// setting); the menu's checkmark reads it through app.uiState.patternPreview.
//
// Cost on the repaint path: one pattern fill of the visible area around the document from the cached composite (the
// CanvasPattern is made once per composite), whatever the zoom, so a zoomed-out view with thousands of tiles costs
// the same as one with eight.

let cached = null; // { canvas, pattern, ctx }

function underlay(ctx, view) {
  const doc = view.doc;
  if (!doc) return;
  const w = doc.width, h = doc.height;
  const comp = view.compositor.composite(doc);
  if (!cached || cached.canvas !== comp || cached.ctx !== ctx || cached.w !== comp.width || cached.version !== doc.version || cached.rootVersion !== doc.root.version) {
    cached = { canvas: comp, ctx, w: comp.width, version: doc.version, rootVersion: doc.root.version, pattern: ctx.createPattern(comp, 'repeat') };
  }
  if (!cached.pattern) return;
  // the visible part of document space, unclipped (corners of the view mapped back; rotation included)
  const corners = [view.toDoc(0, 0), view.toDoc(view.cssWidth, 0), view.toDoc(0, view.cssHeight), view.toDoc(view.cssWidth, view.cssHeight)];
  const x0 = Math.floor(Math.min(...corners.map((c) => c.x))) - 1, y0 = Math.floor(Math.min(...corners.map((c) => c.y))) - 1;
  const x1 = Math.ceil(Math.max(...corners.map((c) => c.x))) + 1, y1 = Math.ceil(Math.max(...corners.map((c) => c.y))) + 1;
  ctx.imageSmoothingEnabled = view.zoom < 4;
  ctx.fillStyle = cached.pattern;
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.rect(0, 0, w, h);
  ctx.fill('evenodd'); // around the document, not over it (the composite is drawn there already)
}

/** Turns Pattern Preview on or off (every open document's view repaints). */
export function setPatternPreview(app, on) {
  const want = !!on;
  if (!!app.ui.patternPreview === want) return;
  app.ui.patternPreview = want;
  if (want) app.viewUnderlays.add(underlay);
  else {
    app.viewUnderlays.delete(underlay);
    cached = null;
  }
  for (const d of app.docs?.docs ?? []) d.view?.invalidate?.();
  app.commands.invalidate?.();
}

export function installPatternPreview(app) {
  app.commands.register('view:pattern-preview', {
    label: 'Pattern Preview',
    enabled: () => !!app.doc,
    checked: () => !!app.ui.patternPreview,
    run: (arg) => setPatternPreview(app, typeof arg === 'boolean' ? arg : !app.ui.patternPreview),
  });
}
