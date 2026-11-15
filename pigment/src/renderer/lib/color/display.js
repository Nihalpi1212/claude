// The display stage of icc-engine (ARCHITECTURE.md "0.5 features", package 4, S6.4): document profile → the view
// canvas's colour space, at order 900. The view's 2D context is in the space engine.displaySpace(view) answers:
// 'srgb' for untagged, sRGB and Gray documents (and whenever the display shows no more than sRGB), 'display-p3' for a
// wide-gamut document on a P3 display. A view the stage is not active for costs nothing: untagged and sRGB documents
// on an sRGB canvas draw the composite itself, as 0.4.
//
// The stage keeps one converted copy of the composite per view, keyed on (profile id, display space, size), and
// converts only the damage the pipeline hands it (compositor.takeDamage: every rect any full composite changed since
// the view last took it). Preview frames and postProcess outputs are converted whole into a scratch canvas.
// A P3 view needs the copy even for a Display P3 document (no arithmetic, the copy only): drawing an sRGB canvas
// into a P3 context would convert its numbers as sRGB, so the copy is a canvas in the view's own space.
import { registerDisplayStage, profileOf, SRGB } from './pipeline.js';
import { makeTransform, sameSpace } from './transforms.js';

const kept = new WeakMap(); // view -> { canvas, key }
const scratch = new WeakMap(); // view -> canvas
const stats = { full: 0, region: 0, scratch: 0, pixels: 0, ms: 0, last: null }; // the tests' and measurements' window

/** The profile of a view canvas space: sRGB, or the generated Display P3. */
let spaceProfile = (space) => (space === 'display-p3' ? null : SRGB);

const ctx2d = (canvas, space) => canvas.getContext('2d', space === 'srgb' ? { willReadFrequently: true } : { willReadFrequently: true, colorSpace: space });

function canvasIn(space, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  ctx2d(c, space);
  return c;
}

/**
 * Converts `rect` of `src` (a canvas holding the document's numbers) into the same rect of `dst` (a canvas in
 * `space`). ImageData carries the space of the context it is put into, so a P3 copy keeps the P3 numbers.
 */
function convertRect(src, dst, rect, transform, space) {
  const t0 = performance.now();
  const { x, y, width: w, height: h } = rect;
  const img = src.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h);
  if (!transform.identity) transform.apply(img.data, img.data, w * h);
  const out = space === 'srgb' ? img : new ImageData(img.data, w, h, { colorSpace: space });
  ctx2d(dst, space).putImageData(out, x, y);
  stats.pixels += w * h;
  stats.ms += performance.now() - t0;
  stats.last = { w, h, ms: performance.now() - t0 };
}

const clip = (r, w, h) => {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.width)), y2 = Math.min(h, Math.ceil(r.y + r.height));
  return x2 > x && y2 > y ? { x, y, width: x2 - x, height: y2 - y } : null;
};

/** Whether the stage converts for this view: an engine live, and a document not already in the canvas's space. */
export function stageActive(view, isLive) {
  if (!isLive() || !view?.doc) return false;
  const space = view.space ?? 'srgb';
  return space !== 'srgb' || !sameSpace(profileOf(view.doc), SRGB);
}

/** The transform the view's copy is made with. */
const transformFor = (view) => makeTransform(profileOf(view.doc), spaceProfile(view.space ?? 'srgb'), { intent: 'perceptual', bpc: true });

/** Registers the stage (cmm.js install). `p3` is the generated Display P3 record; `isLive()` the engine's state. */
export function installDisplayStage({ p3, isLive }) {
  spaceProfile = (space) => (space === 'display-p3' ? p3 : SRGB);
  return registerDisplayStage({
    id: 'icc',
    order: 900,
    active: (view) => stageActive(view, isLive),
    apply(canvas, view, { damage, scratch: isScratch }) {
      const space = view.space ?? 'srgb';
      const t = transformFor(view);
      if (t.identity && space === 'srgb') return canvas;
      const w = canvas.width, h = canvas.height;
      if (isScratch) {
        let s = scratch.get(view);
        if (!s || s.width !== w || s.height !== h || s.space !== space) {
          s = canvasIn(space, w, h);
          s.space = space;
          scratch.set(view, s);
        }
        convertRect(canvas, s, { x: 0, y: 0, width: w, height: h }, t, space);
        stats.scratch++;
        return s;
      }
      const key = `${profileOf(view.doc).id}|${space}|${w}x${h}`;
      let k = kept.get(view);
      if (!k || k.key !== key || damage === 'full') {
        if (!k || k.canvas.width !== w || k.canvas.height !== h || k.space !== space) k = { canvas: canvasIn(space, w, h), space };
        k.key = key;
        kept.set(view, k);
        convertRect(canvas, k.canvas, { x: 0, y: 0, width: w, height: h }, t, space);
        stats.full++;
      } else if (damage) {
        const r = clip(damage, w, h);
        if (r) {
          convertRect(canvas, k.canvas, r, t, space);
          stats.region++;
        }
      }
      return k.canvas;
    },
  });
}

/** What the stage did (tests, the 60 ms measurement of S6.4). */
export const displayStats = () => ({ ...stats });
export function resetDisplayStats() {
  Object.assign(stats, { full: 0, region: 0, scratch: 0, pixels: 0, ms: 0, last: null });
}
/** The kept copy of a view (tests compare it with the composite). */
export const keptCanvas = (view) => kept.get(view)?.canvas ?? null;
