// The segmentation and matting steps of Select Subject / Sky / Focus Area, Object Selection and the
// Select and Mask workspace, as one table of named operations over images kept by key. The same
// table runs inside the worker (worker.js) and, when a worker cannot be started, on the main thread
// (engine.js), so both paths give identical pixels.
import { selectSubject, selectSky, focusArea, focusMeasure, objectSelect, grabCut } from '../../../shared/pixels/segment.js';
import { refineEdge, edgeBand, decontaminate } from '../../../shared/pixels/matte.js';

/**
 * @param {Map<string, { width: number, height: number, data: Uint8ClampedArray, focus?: Map<string, object> }>} images
 * @param {string} op
 * @param {string} key  image the operation reads
 * @param {object} args
 * @returns {{ result: object, transfer: ArrayBuffer[] }} typed arrays of the result are listed for transfer
 */
export function runOp(images, op, key, args = {}) {
  const img = images.get(key);
  if (!img) throw new Error(`No image "${key}" for ${op}`);
  const stats = {};
  switch (op) {
    case 'subject': {
      const mask = selectSubject(img, { hardEdge: !!args.hardEdge, stats });
      return { result: { mask, stats }, transfer: [mask.buffer] };
    }
    case 'sky': {
      const mask = selectSky(img, { hardEdge: !!args.hardEdge, stats });
      return { result: { mask, stats }, transfer: [mask.buffer] };
    }
    case 'focus': {
      // the sharpness measure depends on the noise level only: the In-Focus Range slider reuses it
      const noise = args.noise ?? 'auto';
      img.focus ??= new Map();
      let measure = img.focus.get(noise);
      if (!measure) {
        measure = focusMeasure(img, { noise });
        img.focus.set(noise, measure);
      }
      const mask = focusArea(img, { range: args.range, autoRange: !!args.autoRange, measure, hardEdge: !!args.hardEdge, stats });
      return { result: { mask, range: stats.range ?? measure.auto, auto: measure.auto, stats }, transfer: [mask.buffer] };
    }
    case 'object': {
      const mask = objectSelect(img, args.region, { hardEdge: !!args.hardEdge, stats });
      return { result: { mask, stats }, transfer: [mask.buffer] };
    }
    case 'grabcut': {
      const mask = grabCut(img, args.init, { ...(args.options ?? {}), stats });
      return { result: { mask, stats }, transfer: [mask.buffer] };
    }
    case 'refine': {
      const mask = refineEdge(img, args.mask, args.options ?? {});
      return { result: { mask }, transfer: [mask.buffer] };
    }
    case 'band': {
      const { band, count } = edgeBand(img, args.mask, args.options ?? {});
      return { result: { band, count }, transfer: [band.buffer] };
    }
    case 'decontaminate': {
      const out = decontaminate(img, args.alpha, args.amount ?? 1);
      return { result: { data: out.data }, transfer: [out.data.buffer] };
    }
    default:
      throw new Error(`Unknown operation: ${op}`);
  }
}
