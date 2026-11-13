// Merged sampling (ARCHITECTURE.md "0.4 features", L.11; E28): what "Sample: All Layers" reads. Every tool and panel
// that samples the merged image (Paint Bucket, Magic Wand, Quick Selection, Object Selection, the retouch tools'
// Sample All Layers, Eyedropper, Color Sampler, Info) goes through sampleMerged, each call marked
// `// sample (lib/sample.js)`. Skeleton file; no package edits it.
//
// app.sampleSkip?(doc) -> Set<Layer> | null names the layers sampling must not see: layers-panel-depth sets it from
// the isolation state (find.js), so samplers see what the canvas shows. Without it (or with an empty set) this is
// exactly what each call site did in 0.3.
import { flattenDocument, flattenStored } from './compositor.js';
import { createCanvas } from './document.js';

// one merged image per document, reused while the document is unchanged (the Info panel samples on every pointer
// move): the returned canvas is shared and read-only
const cache = new WeakMap(); // doc -> { key, canvas }

function skipSet(app, doc) {
  let skip = null;
  try {
    skip = app.sampleSkip?.(doc) ?? null;
  } catch (err) {
    console.warn('sampleSkip failed', err);
  }
  return skip && skip.size ? skip : null;
}

function skipKey(skip) {
  return skip ? [...skip].map((l) => `${l.id}@${l.version}`).sort().join(',') : '';
}

/**
 * The merged image as an HTMLCanvasElement (read it, do not draw on it).
 *  - default: flattenDocument (the displayed composite, document sized);
 *  - stored: flattenStored (the image mode's stored pixels, not its inks shown);
 *  - rect: only that rectangle, composited directly (top-left at rect.x / rect.y), raw when `stored`.
 */
export function sampleMerged(app, doc, { stored = false, rect = null } = {}) {
  const compositor = doc.view?.compositor;
  const skip = skipSet(app, doc);
  if (rect) return compositor.composite(doc, { rawMode: !!stored, rect, ...(skip ? { skip } : {}) });
  const key = `${stored ? 'stored' : 'shown'}:${doc.version}:${doc.root.version}:${doc.width}x${doc.height}:${doc.mode ?? 'rgb'}|${skipKey(skip)}`;
  if (stored && !skip) return flattenStored(doc, compositor); // a fresh canvas, as 0.3's retouch tools read it
  const hit = cache.get(doc);
  if (hit?.key === key && hit.compositor === compositor) return hit.canvas;
  let canvas;
  if (!skip) canvas = flattenDocument(doc, compositor);
  else {
    const c = compositor.composite(doc, { skip, rawMode: !!stored });
    canvas = createCanvas(doc.width, doc.height);
    canvas.getContext('2d').drawImage(c, 0, 0);
  }
  cache.set(doc, { key, compositor, canvas });
  return canvas;
}

/** Sets app.sampleMerged (app.js start() calls it before MODULES); find.js sets app.sampleSkip itself. */
export function installSample(app) {
  app.sampleMerged = (doc, opts) => sampleMerged(app, doc, opts);
  app.sampleSkip ??= null;
  return app.sampleMerged;
}
