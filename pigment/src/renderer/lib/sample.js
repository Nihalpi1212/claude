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

/** The adjustment layers of a document ("No Adjustments" samples without them, S7.5). */
function adjustmentLayers(doc) {
  const out = new Set();
  for (const l of doc.layers?.() ?? []) if (l.type === 'adjustment') out.add(l);
  return out;
}

/**
 * The merged image as an HTMLCanvasElement (read it, do not draw on it).
 *  - default: flattenDocument (the displayed composite, document sized);
 *  - stored: flattenStored (the image mode's stored pixels, not its inks shown);
 *  - rect: only that rectangle, composited directly (top-left at rect.x / rect.y), raw when `stored`;
 *  - until (0.5, S7.5): the layers below that one only (Photoshop's Sample: Current & Below passes the layer above
 *    the current one); skipAdjustments: without the adjustment layers (All Layers No Adjustments). Both go to
 *    compositor.composite(doc, { until, skip }) and into the cache key.
 */
export function sampleMerged(app, doc, { stored = false, rect = null, until = null, skipAdjustments = false } = {}) {
  const compositor = doc.view?.compositor;
  let skip = skipSet(app, doc);
  if (skipAdjustments) {
    const adj = adjustmentLayers(doc);
    if (adj.size) skip = new Set([...(skip ?? []), ...adj]);
  }
  const extra = { ...(skip ? { skip } : {}), ...(until ? { until } : {}) };
  if (rect) return compositor.composite(doc, { rawMode: !!stored, rect, ...extra });
  const key = `${stored ? 'stored' : 'shown'}:${doc.version}:${doc.root.version}:${doc.width}x${doc.height}:${doc.mode ?? 'rgb'}|${skipKey(skip)}|${until ? `${until.id}@${until.version}` : ''}`;
  if (stored && !skip && !until) return flattenStored(doc, compositor); // a fresh canvas, as 0.3's retouch tools read it
  const hit = cache.get(doc);
  if (hit?.key === key && hit.compositor === compositor) return hit.canvas;
  let canvas;
  if (!skip && !until) canvas = flattenDocument(doc, compositor);
  else {
    const c = compositor.composite(doc, { ...extra, rawMode: !!stored });
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
