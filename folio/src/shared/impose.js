// Imposition engine: the "Quite Imposing"-style toolbox built on pdf-lib. Every function takes PDF
// bytes and returns new bytes (or data) and never mutates its input. Page indices are 0-based;
// lengths are PDF points unless stated otherwise. See docs/IMPOSITION.md for the user-facing view.
import { PDFDocument, PDFName, StandardFonts, degrees, rgb, cmyk } from 'pdf-lib';
import { _internal, EngineError } from './engine.js';
import { parseColor } from './appearance.js';

const { load, save } = _internal;

export const UNITS = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 };

/** Common sheet sizes in points (portrait). */
export const SHEET_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  B4: [708.66, 1000.63],
  B5: [498.9, 708.66],
  SRA3: [907.09, 1275.59],
  SRA4: [637.8, 907.09],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
  Ledger: [1224, 792],
  '12x18in': [864, 1296],
  '13x19in': [936, 1368],
};

export const FONTS = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  Times: StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
};

// ---- helpers ----------------------------------------------------------------------------------------------

function toPt(value, unit = 'pt') {
  return Number(value) * (UNITS[unit] ?? 1);
}

export function resolveSheet(sheet, fallback = [612, 792]) {
  if (Array.isArray(sheet) && sheet.length === 2 && sheet.every((n) => Number.isFinite(n) && n > 0)) return [sheet[0], sheet[1]];
  if (typeof sheet === 'string') {
    const landscape = /-landscape$/i.test(sheet);
    const key = sheet.replace(/-(landscape|portrait)$/i, '');
    const size = SHEET_SIZES[key];
    if (size) return landscape ? [size[1], size[0]] : [size[0], size[1]];
  }
  if (sheet && typeof sheet === 'object' && Number.isFinite(sheet.width) && Number.isFinite(sheet.height)) return [sheet.width, sheet.height];
  return fallback;
}

function allIndices(doc) {
  return doc.getPageIndices();
}

function normalizeIndices(doc, pageIndices) {
  const count = doc.getPageCount();
  if (!pageIndices || pageIndices === 'all') return allIndices(doc);
  const out = [...new Set(pageIndices.map((i) => Math.floor(Number(i))))].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b);
  if (!out.length) throw new EngineError('range', 'No pages selected');
  return out;
}

/** Visual (as displayed) size of a page: its crop box (clipped to the media box), swapped for 90/270 rotation. */
export function visualSize(page) {
  const norm = (b) => ({ x: Math.min(b.x, b.x + b.width), y: Math.min(b.y, b.y + b.height), width: Math.abs(b.width), height: Math.abs(b.height) });
  const media = norm(page.getMediaBox());
  const crop = norm(page.getCropBox());
  const x1 = Math.max(media.x, crop.x), y1 = Math.max(media.y, crop.y);
  const x2 = Math.min(media.x + media.width, crop.x + crop.width), y2 = Math.min(media.y + media.height, crop.y + crop.height);
  const box = x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : media;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return rot % 180 ? { width: box.height, height: box.width, rotation: rot, box } : { width: box.width, height: box.height, rotation: rot, box };
}

/**
 * Draws an embedded source page so it appears exactly as a viewer shows it (honouring /Rotate),
 * with its visual bottom-left corner at (tx, ty), scaled by sx/sy (negative values mirror) and
 * optionally rotated further by `extra` degrees (counter-clockwise) around that corner.
 */
export function drawVisual(target, embedded, { tx, ty, sx = 1, sy = sx, rotation = 0, extra = 0, visualWidth, visualHeight }) {
  const W = embedded.width; // unrotated content width (bounding box)
  const H = embedded.height;
  const rot = ((rotation % 360) + 360) % 360;
  // position of the unrotated form origin so that the rotated result lands at (tx, ty)
  let x = tx, y = ty, angle = 0;
  if (rot === 90) {
    x = tx;
    y = ty + W * Math.abs(sy);
    angle = -90;
  } else if (rot === 180) {
    x = tx + W * Math.abs(sx);
    y = ty + H * Math.abs(sy);
    angle = 180;
  } else if (rot === 270) {
    x = tx + H * Math.abs(sx);
    y = ty;
    angle = 90;
  }
  // mirroring: flip around the visual box
  const vw = visualWidth ?? (rot % 180 ? H : W) * Math.abs(sx);
  const vh = visualHeight ?? (rot % 180 ? W : H) * Math.abs(sy);
  let xScale = Math.abs(sx), yScale = Math.abs(sy);
  if (sx < 0 || sy < 0) {
    // draw into a flipped coordinate system by moving the anchor to the far edge
    if (sx < 0) x = 2 * tx + vw - x;
    if (sy < 0) y = 2 * ty + vh - y;
    xScale = sx < 0 ? -xScale : xScale;
    yScale = sy < 0 ? -yScale : yScale;
    if (rot === 90 || rot === 270) {
      // swap which scale flips because the form is rotated a quarter turn
      [xScale, yScale] = [sy < 0 ? -Math.abs(xScale) : Math.abs(xScale), sx < 0 ? -Math.abs(yScale) : Math.abs(yScale)];
    }
  }
  if (extra) {
    // rotate the whole visual box around (tx, ty): shift so the box's corner stays put
    const rad = (extra * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const relX = x - tx, relY = y - ty;
    x = tx + relX * cos - relY * sin;
    y = ty + relX * sin + relY * cos;
    angle += extra;
  }
  target.drawPage(embedded, { x, y, xScale, yScale, rotate: degrees(angle) });
}

/** Embeds a source page using its crop box (what viewers show). */
async function embedVisual(out, page) {
  if (!page.node.Contents()) {
    // pdf-lib refuses to embed a page without a content stream (blank pages are allowed to have none)
    const ctx = page.doc.context;
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(new Uint8Array(0))));
  }
  const { box } = visualSize(page);
  const embedded = await out.embedPage(page, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
  return embedded;
}

/** Scale so a w×h box fits (mode 'fit') or fills (mode 'fill') a W×H cell; 'none' keeps 100 %. */
function fitScale(w, h, W, H, mode) {
  if (mode === 'none') return 1;
  const sw = W / w, sh = H / h;
  return mode === 'fill' ? Math.max(sw, sh) : Math.min(sw, sh);
}

async function newOutput(src) {
  const out = await PDFDocument.create();
  out.setProducer('Folio PDF (imposition)');
  out.setCreator('Folio PDF');
  try {
    const t = src?.getTitle();
    if (t) out.setTitle(t);
  } catch {
    /* ignore */
  }
  return out;
}

// ---- booklets, n-up, step and repeat, manual --------------------------------------------------------------

/**
 * Saddle-stitched booklet: pages are paired onto 2-up sheets so that folding the printed (duplex)
 * stack yields the document in order. With `signatureSize` > 0 the document is split into
 * signatures of that many pages, each imposed as its own booklet (perfect binding).
 */
export async function createBooklet(bytes, opts = {}) {
  const { sheet = 'auto', binding = 'left', creep = 0, signatureSize = 0, scale = 'fit', gap = 0, margin = 0, pageIndices } = opts;
  const src = await load(bytes);
  const pages = normalizeIndices(src, pageIndices).map((i) => src.getPage(i));
  const out = await newOutput(src);
  const first = visualSize(pages[0]);
  const [sheetW, sheetH] = sheet === 'auto' ? [first.width * 2 + gap + margin * 2, first.height + margin * 2] : resolveSheet(sheet);
  const cellW = (sheetW - margin * 2 - gap) / 2;
  const cellH = sheetH - margin * 2;
  const sig = signatureSize > 0 ? Math.max(4, Math.ceil(signatureSize / 4) * 4) : Math.ceil(pages.length / 4) * 4;
  const embedded = new Map();
  const emb = async (p) => {
    if (!p) return null;
    if (!embedded.has(p)) embedded.set(p, await embedVisual(out, p));
    return embedded.get(p);
  };
  let sheetCount = 0;
  for (let start = 0; start < pages.length; start += sig) {
    const group = pages.slice(start, start + sig);
    while (group.length % 4) group.push(null); // blanks to fill the signature
    const n = group.length;
    const sheets = n / 4;
    for (let s = 0; s < sheets; s++) {
      // front: [n-2s, 1+2s]   back: [2+2s, n-1-2s]  (1-based within the group)
      const front = [group[n - 1 - 2 * s], group[2 * s]];
      const back = [group[2 * s + 1], group[n - 2 - 2 * s]];
      const shift = creep * s; // the outermost sheet is not shifted; inner sheets move toward the spine
      for (const [side, pair] of [['front', front], ['back', back]]) {
        const page = out.addPage([sheetW, sheetH]);
        const order = binding === 'right' ? [pair[1], pair[0]] : pair;
        for (let k = 0; k < 2; k++) {
          const p = order[k];
          if (!p) continue;
          const e = await emb(p);
          const v = visualSize(p);
          const sc = fitScale(v.width, v.height, cellW, cellH, scale);
          const w = v.width * sc, h = v.height * sc;
          const cellX = margin + k * (cellW + gap);
          const towardSpine = k === 0 ? +1 : -1; // the spine is between the two cells
          const tx = cellX + (cellW - w) / 2 + towardSpine * shift;
          const ty = margin + (cellH - h) / 2;
          drawVisual(page, e, { tx, ty, sx: sc, rotation: v.rotation });
        }
        sheetCount++;
      }
    }
  }
  return { bytes: await save(out), sheets: sheetCount };
}

/** Places pages in a rows×cols grid on each sheet, in reading order; `rotate` is degrees counter-clockwise. */
export async function nUp(bytes, opts = {}) {
  const { sheet = 'A4-landscape', rows = 1, cols = 2, order = 'across', gap = 0, margin = 0, scale = 'fit', pageIndices, rotate = 0, duplicate = false } = opts;
  const src = await load(bytes);
  const pages = normalizeIndices(src, pageIndices).map((i) => src.getPage(i));
  const out = await newOutput(src);
  const [sheetW, sheetH] = resolveSheet(sheet);
  const R = Math.max(1, Math.floor(rows)), C = Math.max(1, Math.floor(cols));
  const cellW = (sheetW - margin * 2 - gap * (C - 1)) / C;
  const cellH = (sheetH - margin * 2 - gap * (R - 1)) / R;
  if (cellW <= 0 || cellH <= 0) throw new EngineError('range', 'The gap and margin leave no room for pages');
  const perSheet = R * C;
  const cache = new Map();
  const list = duplicate ? pages.flatMap((p) => Array(perSheet).fill(p)) : pages;
  for (let i = 0; i < list.length; i += perSheet) {
    const page = out.addPage([sheetW, sheetH]);
    for (let k = 0; k < perSheet && i + k < list.length; k++) {
      const p = list[i + k];
      const r = order === 'down' ? k % R : Math.floor(k / C);
      const c = order === 'down' ? Math.floor(k / R) : k % C;
      if (!cache.has(p)) cache.set(p, await embedVisual(out, p));
      const e = cache.get(p);
      const v = visualSize(p);
      const swap = rotate % 180 !== 0;
      const vw = swap ? v.height : v.width, vh = swap ? v.width : v.height;
      const sc = fitScale(vw, vh, cellW, cellH, scale);
      const w = vw * sc, h = vh * sc;
      const cx = margin + c * (cellW + gap) + (cellW - w) / 2;
      const cy = margin + (R - 1 - r) * (cellH + gap) + (cellH - h) / 2;
      // /Rotate-style angles are clockwise, so a counter-clockwise user rotation is 360 - rotate
      drawVisual(page, e, { tx: cx, ty: cy, sx: sc, rotation: (v.rotation + ((360 - (rotate % 360)) % 360)) % 360 });
    }
  }
  return { bytes: await save(out), sheets: out.getPageCount() };
}

/** Repeats one page (or each page) rows×cols times on a sheet. */
export async function stepAndRepeat(bytes, opts = {}) {
  const { pageIndices, each = true } = opts;
  const src = await load(bytes);
  const indices = each ? normalizeIndices(src, pageIndices) : [normalizeIndices(src, pageIndices)[0]];
  return nUp(bytes, { ...opts, pageIndices: indices, duplicate: true, order: 'across' });
}

/**
 * Manual imposition: builds sheets from explicit placements.
 * sheets: [{ size: [w,h] | name, placements: [{ page, x, y, scale, rotation }] }] — page is 0-based,
 * x/y the bottom-left corner of the placed (scaled and rotated) page on the sheet, in points;
 * rotation is a multiple of 90 degrees counter-clockwise.
 */
export async function manualImpose(bytes, { sheets = [] } = {}) {
  if (!sheets.length) throw new EngineError('range', 'No sheets defined');
  const src = await load(bytes);
  const out = await newOutput(src);
  const cache = new Map();
  for (const s of sheets) {
    const [w, h] = resolveSheet(s.size);
    const page = out.addPage([w, h]);
    for (const pl of s.placements ?? []) {
      const idx = Math.floor(Number(pl.page));
      if (!Number.isInteger(idx) || idx < 0 || idx >= src.getPageCount()) throw new EngineError('range', `Page ${idx + 1} does not exist`);
      const p = src.getPage(idx);
      if (!cache.has(p)) cache.set(p, await embedVisual(out, p));
      const v = visualSize(p);
      const sc = Number(pl.scale) || 1;
      const r = ((Math.round((Number(pl.rotation) || 0) / 90) * 90) % 360 + 360) % 360;
      // (x, y) is the bottom-left corner of the placed page *after* rotation; drawVisual rotates
      // around the unrotated corner, so move the anchor accordingly
      const vw = v.width * sc, vh = v.height * sc;
      let tx = Number(pl.x) || 0, ty = Number(pl.y) || 0;
      if (r === 90) tx += vh;
      else if (r === 180) { tx += vw; ty += vh; }
      else if (r === 270) ty += vw;
      drawVisual(page, cache.get(p), { tx, ty, sx: sc, rotation: v.rotation, extra: r });
    }
  }
  return { bytes: await save(out), sheets: out.getPageCount() };
}

// ---- page order ---------------------------------------------------------------------------------------------

/** Reorders by a rule applied to consecutive groups: rule = 1-based positions within each group of `groupSize`. */
export function shuffleOrder(count, rule, groupSize = rule.length) {
  const g = Math.max(1, Math.floor(groupSize));
  const positions = rule.map((n) => Math.floor(Number(n)));
  if (!positions.length || positions.some((n) => !Number.isInteger(n) || n < 1 || n > g)) throw new EngineError('range', `Each rule entry must be between 1 and ${g}`);
  const order = [];
  for (let start = 0; start < count; start += g) {
    for (const pos of positions) {
      const idx = start + pos - 1;
      if (idx < count) order.push(idx);
    }
  }
  // pages the rule never mentions are dropped on purpose (that is how Quite Imposing's rules work);
  // a rule shorter than its group therefore selects pages
  return order;
}

export function bookletOrder(count) {
  const n = Math.ceil(count / 4) * 4;
  const order = [];
  for (let s = 0; s < n / 4; s++) order.push(n - 1 - 2 * s, 2 * s, 2 * s + 1, n - 2 - 2 * s);
  return order.map((i) => (i < count ? i : null));
}

export function cutAndStackOrder(count, stacks) {
  const k = Math.max(1, Math.floor(stacks));
  const per = Math.ceil(count / k);
  const order = [];
  for (let i = 0; i < per; i++) for (let s = 0; s < k; s++) order.push(s * per + i < count ? s * per + i : null);
  return order;
}

export function evenOddOrder(count, mode) {
  const odds = [], evens = [];
  for (let i = 0; i < count; i++) (i % 2 === 0 ? odds : evens).push(i);
  if (mode === 'separate') return [...odds, ...evens]; // all fronts then all backs
  if (mode === 'separate-reverse-evens') return [...odds, ...evens.reverse()]; // duplex scans: backs come out reversed
  // interleave: first half are fronts, second half backs
  const half = Math.ceil(count / 2);
  const out = [];
  for (let i = 0; i < half; i++) {
    out.push(i);
    if (half + i < count) out.push(half + i);
  }
  return out;
}

/** Builds a document whose pages follow `order` (indices into the source; null = blank page). */
export async function applyOrder(bytes, order, { blankSize } = {}) {
  const src = await load(bytes);
  const out = await newOutput(src);
  const count = src.getPageCount();
  const real = order.filter((i) => i !== null && i !== undefined);
  if (real.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new EngineError('range', 'The order refers to pages that do not exist');
  const copied = await out.copyPages(src, real);
  let k = 0;
  const first = count ? visualSize(src.getPage(0)) : null;
  const size = blankSize ?? (first ? [first.width, first.height] : [612, 792]);
  for (const i of order) {
    if (i === null || i === undefined) out.addPage(size);
    else out.addPage(copied[k++]);
  }
  return save(out);
}

export async function shufflePages(bytes, { rule, groupSize } = {}) {
  const src = await load(bytes);
  return applyOrder(bytes, shuffleOrder(src.getPageCount(), rule ?? [], groupSize ?? rule?.length));
}

export async function shufflePreset(bytes, preset, { stacks = 2 } = {}) {
  const src = await load(bytes);
  const n = src.getPageCount();
  const orders = {
    reverse: () => Array.from({ length: n }, (_, i) => n - 1 - i),
    booklet: () => bookletOrder(n),
    'cut-and-stack': () => cutAndStackOrder(n, stacks),
    'even-odd-separate': () => evenOddOrder(n, 'separate'),
    'even-odd-separate-reverse': () => evenOddOrder(n, 'separate-reverse-evens'),
    'even-odd-interleave': () => evenOddOrder(n, 'interleave'),
  };
  if (!orders[preset]) throw new EngineError('unsupported', `Unknown shuffle "${preset}"`);
  return applyOrder(bytes, orders[preset]());
}

export async function reversePages(bytes) {
  return shufflePreset(bytes, 'reverse');
}

export async function insertBlankPages(bytes, { at = 'end', pageIndex = 0, count = 1, size = 'same', afterEvery = 0 } = {}) {
  const src = await load(bytes);
  const n = src.getPageCount();
  const blank = size === 'same' ? null : resolveSheet(size);
  const order = [];
  const blanks = Math.max(1, Math.floor(count));
  if (afterEvery > 0) {
    for (let i = 0; i < n; i++) {
      order.push(i);
      if ((i + 1) % afterEvery === 0) for (let b = 0; b < blanks; b++) order.push(null);
    }
  } else {
    const pos = at === 'start' ? 0 : at === 'end' ? n : at === 'before' ? pageIndex : pageIndex + 1;
    for (let i = 0; i < n; i++) {
      if (i === pos) for (let b = 0; b < blanks; b++) order.push(null);
      order.push(i);
    }
    if (pos >= n) for (let b = 0; b < blanks; b++) order.push(null);
  }
  return applyOrder(bytes, order, { blankSize: blank ?? undefined });
}

/** Adds blank pages at the end until the count is a multiple of `multiple` (e.g. 4 for booklets). */
export async function fillToMultiple(bytes, multiple = 4) {
  const src = await load(bytes);
  const n = src.getPageCount();
  const m = Math.max(1, Math.floor(multiple));
  const missing = (m - (n % m)) % m;
  if (!missing) return bytes;
  return insertBlankPages(bytes, { at: 'end', count: missing });
}

export async function duplicatePages(bytes, { pageIndices, copies = 1, together = true } = {}) {
  const src = await load(bytes);
  const chosen = new Set(normalizeIndices(src, pageIndices));
  const n = src.getPageCount();
  const c = Math.max(1, Math.floor(copies));
  const order = [];
  if (together) {
    for (let i = 0; i < n; i++) {
      order.push(i);
      if (chosen.has(i)) for (let k = 0; k < c; k++) order.push(i);
    }
  } else {
    for (let i = 0; i < n; i++) order.push(i);
    for (let k = 0; k < c; k++) for (const i of chosen) order.push(i);
  }
  return applyOrder(bytes, order);
}

// ---- page geometry ------------------------------------------------------------------------------------------

/**
 * Re-pages the selected pages: each selected page is replaced by the pages returned by `plan`,
 * which receives (page, visual) and returns [{ size:[w,h], draws:[{ tx, ty, sx, sy, extra }] }].
 * Unselected pages are copied unchanged. Annotations on re-paged pages are not carried over
 * (flatten first to keep them visible).
 */
async function repage(bytes, pageIndices, plan) {
  const src = await load(bytes);
  const selected = new Set(normalizeIndices(src, pageIndices));
  const out = await newOutput(src);
  const n = src.getPageCount();
  for (let i = 0; i < n; i++) {
    const page = src.getPage(i);
    if (!selected.has(i)) {
      const [copy] = await out.copyPages(src, [i]);
      out.addPage(copy);
      continue;
    }
    const v = visualSize(page);
    const specs = await plan(page, v, i);
    if (!specs.length) continue;
    const embedded = await embedVisual(out, page);
    for (const spec of specs) {
      const target = out.addPage([Math.max(1, spec.size[0]), Math.max(1, spec.size[1])]);
      for (const d of spec.draws) drawVisual(target, embedded, { rotation: v.rotation, ...d });
    }
  }
  return save(out);
}

/** Trims margins and/or shifts the content; `resize:false` keeps the page size and only moves content. */
export async function trimAndShift(bytes, { pageIndices, trim = {}, shift = {}, oddShift, evenShift, resize = true } = {}) {
  const t = { top: 0, right: 0, bottom: 0, left: 0, ...trim };
  return repage(bytes, pageIndices, (page, v, i) => {
    const s = (i % 2 === 0 ? oddShift : evenShift) ?? shift;
    const dx = Number(s.x) || 0, dy = Number(s.y) || 0;
    const w = resize ? Math.max(1, v.width - t.left - t.right) : v.width;
    const h = resize ? Math.max(1, v.height - t.top - t.bottom) : v.height;
    return [{ size: [w, h], draws: [{ tx: -t.left + dx, ty: -t.bottom + dy, sx: 1 }] }];
  });
}

/** Scales pages onto a new size: mode fit | fill | center (no scaling) | stretch. */
export async function adjustPageSizes(bytes, { pageIndices, size = 'A4', mode = 'fit', orientation = 'auto', align = 'center' } = {}) {
  return repage(bytes, pageIndices, (page, v) => {
    let [W, H] = resolveSheet(size);
    if (orientation === 'auto' && (v.width > v.height) !== (W > H)) [W, H] = [H, W];
    let sx, sy;
    if (mode === 'stretch') {
      sx = W / v.width;
      sy = H / v.height;
    } else {
      sx = sy = mode === 'center' ? 1 : fitScale(v.width, v.height, W, H, mode);
    }
    const w = v.width * sx, h = v.height * sy;
    const tx = align === 'left' ? 0 : align === 'right' ? W - w : (W - w) / 2;
    const ty = align === 'bottom' ? 0 : align === 'top' ? H - h : (H - h) / 2;
    return [{ size: [W, H], draws: [{ tx, ty, sx, sy }] }];
  });
}

export async function mirrorPages(bytes, { pageIndices, axis = 'horizontal' } = {}) {
  return repage(bytes, pageIndices, (page, v) => [{ size: [v.width, v.height], draws: [{ tx: 0, ty: 0, sx: axis === 'horizontal' || axis === 'both' ? -1 : 1, sy: axis === 'vertical' || axis === 'both' ? -1 : 1 }] }]);
}

export async function rotatePagesContent(bytes, { pageIndices, angle = 90 } = {}) {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return repage(bytes, pageIndices, (page, v) => {
    const swap = a % 180 !== 0;
    const W = swap ? v.height : v.width, H = swap ? v.width : v.height;
    // rotate counter-clockwise by a around the corner, then move back into the page
    const tx = a === 90 ? v.height : a === 180 ? v.width : 0;
    const ty = a === 180 ? v.height : a === 270 ? v.width : 0;
    return [{ size: [W, H], draws: [{ tx, ty, sx: 1, extra: a }] }];
  });
}

/** Splits each page into 2 (vertical: left|right, horizontal: top|bottom) or 4 pages. */
export async function splitPages(bytes, { pageIndices, mode = 'vertical', order = 'ltr', gutter = 0 } = {}) {
  return repage(bytes, pageIndices, (page, v) => {
    const halfW = (v.width - gutter) / 2, halfH = (v.height - gutter) / 2;
    const left = { size: [halfW, v.height], draws: [{ tx: 0, ty: 0, sx: 1 }] };
    const right = { size: [halfW, v.height], draws: [{ tx: -(halfW + gutter), ty: 0, sx: 1 }] };
    const top = { size: [v.width, halfH], draws: [{ tx: 0, ty: -(halfH + gutter), sx: 1 }] };
    const bottom = { size: [v.width, halfH], draws: [{ tx: 0, ty: 0, sx: 1 }] };
    if (mode === 'horizontal') return [top, bottom];
    if (mode === 'quad') {
      const q = (tx, ty) => ({ size: [halfW, halfH], draws: [{ tx, ty, sx: 1 }] });
      return [q(0, -(halfH + gutter)), q(-(halfW + gutter), -(halfH + gutter)), q(0, 0), q(-(halfW + gutter), 0)];
    }
    return order === 'rtl' ? [right, left] : [left, right];
  });
}

/** Cuts each page into tiles of the given size with an overlap, row by row from the top. */
export async function tilePages(bytes, { pageIndices, tile = 'A4', overlap = 0, scale = 1 } = {}) {
  const [tw, th] = resolveSheet(tile);
  return repage(bytes, pageIndices, (page, v) => {
    const sc = Number(scale) || 1;
    const W = v.width * sc, H = v.height * sc;
    const stepX = Math.max(1, tw - overlap), stepY = Math.max(1, th - overlap);
    const cols = Math.max(1, Math.ceil((W - overlap) / stepX));
    const rows = Math.max(1, Math.ceil((H - overlap) / stepY));
    const specs = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ox = c * stepX;
        const oy = H - th - r * stepY; // from the top
        specs.push({ size: [tw, th], draws: [{ tx: -ox, ty: -oy, sx: sc }] });
      }
    }
    return specs;
  });
}

const BOX_KEYS = { media: 'MediaBox', crop: 'CropBox', bleed: 'BleedBox', trim: 'TrimBox', art: 'ArtBox' };

/** Maps insets given for the displayed (rotated) page onto the unrotated user-space edges. */
function visualInsetsToUserSpace(v, rotation) {
  // /Rotate 90 shows the page turned clockwise: the visual top edge is the user-space left edge, and so on
  if (rotation === 90) return { left: v.top, bottom: v.left, right: v.bottom, top: v.right };
  if (rotation === 180) return { left: v.right, right: v.left, top: v.bottom, bottom: v.top };
  if (rotation === 270) return { right: v.top, bottom: v.right, left: v.bottom, top: v.left };
  return v;
}

/** Sets a page box, either to absolute [x, y, w, h] values or by insets from the media box. */
export async function setPageBoxes(bytes, { pageIndices, box = 'crop', values, insets, remove = false } = {}) {
  const doc = await load(bytes);
  const key = BOX_KEYS[box];
  if (!key) throw new EngineError('range', `Unknown box "${box}"`);
  for (const i of normalizeIndices(doc, pageIndices)) {
    const page = doc.getPage(i);
    if (remove) {
      if (key !== 'MediaBox') page.node.delete(PDFName.of(key));
      continue;
    }
    let [x, y, w, h] = [0, 0, 0, 0];
    if (Array.isArray(values) && values.length === 4) [x, y, w, h] = values.map(Number);
    else {
      const m = page.getMediaBox();
      const ins = visualInsetsToUserSpace({ top: 0, right: 0, bottom: 0, left: 0, ...(insets ?? {}) }, visualSize(page).rotation);
      x = m.x + ins.left;
      y = m.y + ins.bottom;
      w = m.width - ins.left - ins.right;
      h = m.height - ins.top - ins.bottom;
    }
    if (!(w > 0 && h > 0)) throw new EngineError('range', 'The box must have a positive width and height');
    const setter = { MediaBox: 'setMediaBox', CropBox: 'setCropBox', BleedBox: 'setBleedBox', TrimBox: 'setTrimBox', ArtBox: 'setArtBox' }[key];
    page[setter](x, y, w, h);
  }
  return save(doc);
}

export async function pageInfo(bytes) {
  const doc = await load(bytes, { ignoreEncryption: true });
  const read = (page, name) => {
    try {
      const b = page[`get${name}`]();
      return [b.x, b.y, b.width, b.height];
    } catch {
      return null;
    }
  };
  return doc.getPages().map((page, index) => {
    const v = visualSize(page);
    return {
      index,
      width: v.width,
      height: v.height,
      rotation: v.rotation,
      orientation: v.width > v.height ? 'landscape' : v.width < v.height ? 'portrait' : 'square',
      mediaBox: read(page, 'MediaBox'),
      cropBox: read(page, 'CropBox'),
      bleedBox: page.node.has(PDFName.of('BleedBox')) ? read(page, 'BleedBox') : null,
      trimBox: page.node.has(PDFName.of('TrimBox')) ? read(page, 'TrimBox') : null,
      artBox: page.node.has(PDFName.of('ArtBox')) ? read(page, 'ArtBox') : null,
    };
  });
}

// ---- stick-on text, numbers, tape, marks -----------------------------------------------------------------------

export function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  let v = Math.max(0, Math.floor(n));
  for (const [val, sym] of map) while (v >= val) {
    out += sym;
    v -= val;
  }
  return out || '0';
}

export function toAlpha(n) {
  let v = Math.max(1, Math.floor(n));
  let out = '';
  while (v > 0) {
    v--;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

export function formatNumber(n, style = 'arabic', digits = 0) {
  let s;
  if (style === 'roman') s = toRoman(n);
  else if (style === 'ROMAN') s = toRoman(n).toUpperCase();
  else if (style === 'alpha') s = toAlpha(n);
  else if (style === 'ALPHA') s = toAlpha(n).toUpperCase();
  else s = String(n);
  return digits > 0 && style === 'arabic' ? s.padStart(digits, '0') : s;
}

/**
 * Expands tokens: {page} {pages} {n} (sequence number from startNumber) {bates} {date} {time}
 * {file} {sheet} {total} ; {page:roman} {n:ROMAN} {bates:6} etc.
 */
export function expandTemplate(template, ctx) {
  return String(template ?? '').replace(/\{(page|pages|n|bates|date|time|file|total|sheet)(?::([A-Za-z]+|\d+))?\}/g, (_, key, arg) => {
    const style = arg && /^[A-Za-z]+$/.test(arg) ? arg : 'arabic';
    const digits = arg && /^\d+$/.test(arg) ? Number(arg) : 0;
    switch (key) {
      case 'page': return formatNumber(ctx.page, style, digits);
      case 'pages':
      case 'total': return formatNumber(ctx.pages, style, digits);
      case 'n': return formatNumber(ctx.n, style, digits);
      case 'sheet': return formatNumber(ctx.sheet ?? ctx.n, style, digits);
      case 'bates': return (ctx.batesPrefix ?? '') + formatNumber(ctx.bates, 'arabic', digits || ctx.batesDigits || 6);
      case 'date': return ctx.date;
      case 'time': return ctx.time;
      case 'file': return ctx.file ?? '';
      default: return '';
    }
  });
}

function anchorPosition(position, v, w, h, offsetX, offsetY, margin) {
  const [vert, horiz] = String(position).split('-');
  let x = margin, y = margin;
  if (horiz === 'center') x = (v.width - w) / 2;
  else if (horiz === 'right') x = v.width - w - margin;
  if (vert === 'top') y = v.height - h - margin;
  else if (vert === 'middle') y = (v.height - h) / 2;
  return { x: x + offsetX, y: y + offsetY };
}

const sanitizeForFont = (font, text) => {
  try {
    font.encodeText(text);
    return text;
  } catch {
    return [...text].filter((ch) => ch.charCodeAt(0) < 256).join('');
  }
};

/** Draws text (page numbers, Bates numbers, headers...) on pages; drawing is relative to the visual page. */
export async function stickOnText(bytes, opts = {}) {
  const { pageIndices, text = '{page}', position = 'bottom-center', offsetX = 0, offsetY = 0, margin = 18, font = 'Helvetica', size = 11, color = '#000000', rotation = 0, startNumber = 1, batesStart = 1, batesDigits = 6, batesPrefix = '', background = null, file = '', oddEven = 'all' } = opts;
  const doc = await load(bytes);
  const f = await doc.embedFont(FONTS[font] ?? StandardFonts.Helvetica);
  const indices = normalizeIndices(doc, pageIndices).filter((i) => oddEven === 'all' || (oddEven === 'odd' ? i % 2 === 0 : i % 2 === 1));
  const now = new Date();
  const ctxBase = { pages: doc.getPageCount(), date: now.toLocaleDateString(), time: now.toLocaleTimeString(), file, batesPrefix, batesDigits };
  const c = parseColor(color) ?? [0, 0, 0];
  const bg = parseColor(background);
  indices.forEach((i, k) => {
    const page = doc.getPage(i);
    const v = visualSize(page);
    const label = sanitizeForFont(f, expandTemplate(text, { ...ctxBase, page: i + 1, n: startNumber + k, bates: batesStart + k, sheet: k + 1 }));
    if (!label) return;
    const w = f.widthOfTextAtSize(label, size);
    const h = f.heightAtSize(size);
    const { x, y } = anchorPosition(position, v, w, h, offsetX, offsetY, margin);
    drawOnVisual(page, v, (draw) => {
      if (bg) draw.rectangle({ x: x - 2, y: y - 2, width: w + 4, height: h + 4, color: rgb(bg[0], bg[1], bg[2]) });
      draw.text(label, { x, y: y + (h - size) / 2, size, font: f, color: rgb(c[0], c[1], c[2]), rotate: degrees(rotation) });
    });
  });
  return save(doc);
}

/**
 * Lets callers draw in *visual* coordinates on a page that may be rotated or have an offset crop
 * box: wraps the draw calls in a transform that maps visual space to the page's user space.
 */
function drawOnVisual(page, v, fn) {
  const box = v.box;
  const rot = v.rotation;
  page.pushOperators();
  // visual -> user space transform
  let matrix;
  // /Rotate 90 displays the page turned clockwise: the visual bottom-left corner is the user-space
  // bottom-right corner, vx runs up the user-space right edge and vy runs left along the bottom edge.
  if (rot === 90) matrix = { a: 0, b: 1, c: -1, d: 0, e: box.x + box.width, f: box.y }; // (vx,vy) -> (box.x + width - vy, box.y + vx)
  else if (rot === 180) matrix = { a: -1, b: 0, c: 0, d: -1, e: box.x + box.width, f: box.y + box.height };
  else if (rot === 270) matrix = { a: 0, b: -1, c: 1, d: 0, e: box.x, f: box.y + box.height }; // (vx,vy) -> (box.x + vy, box.y + height - vx)
  else matrix = { a: 1, b: 0, c: 0, d: 1, e: box.x, f: box.y };
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix } = pdfLibOperators();
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f));
  fn({
    text: (t, o) => page.drawText(t, o),
    rectangle: (o) => page.drawRectangle(o),
    line: (o) => page.drawLine(o),
    circle: (o) => page.drawCircle(o),
    ellipse: (o) => page.drawEllipse(o),
  });
  page.pushOperators(popGraphicsState());
}

import * as pdfLib from 'pdf-lib';
function pdfLibOperators() {
  return { pushGraphicsState: pdfLib.pushGraphicsState, popGraphicsState: pdfLib.popGraphicsState, concatTransformationMatrix: pdfLib.concatTransformationMatrix };
}

/** Covers a rectangle (visual coordinates, bottom-left origin) with opaque colour. */
export async function maskingTape(bytes, { pageIndices, rect, color = '#ffffff', fromEdges = null } = {}) {
  const doc = await load(bytes);
  const c = parseColor(color) ?? [1, 1, 1];
  for (const i of normalizeIndices(doc, pageIndices)) {
    const page = doc.getPage(i);
    const v = visualSize(page);
    let [x, y, w, h] = rect ?? [0, 0, 0, 0];
    if (fromEdges) {
      // tape across an edge: { edge: 'top'|'bottom'|'left'|'right', depth }
      const d = Number(fromEdges.depth) || 0;
      if (fromEdges.edge === 'top') [x, y, w, h] = [0, v.height - d, v.width, d];
      else if (fromEdges.edge === 'bottom') [x, y, w, h] = [0, 0, v.width, d];
      else if (fromEdges.edge === 'left') [x, y, w, h] = [0, 0, d, v.height];
      else if (fromEdges.edge === 'right') [x, y, w, h] = [v.width - d, 0, d, v.height];
    }
    if (!(w > 0 && h > 0)) throw new EngineError('range', 'The tape needs a positive width and height');
    drawOnVisual(page, v, (draw) => draw.rectangle({ x, y, width: w, height: h, color: rgb(c[0], c[1], c[2]) }));
  }
  return save(doc);
}

/**
 * Printer's marks. The page grows by `margin` on every side and crop marks, registration marks,
 * fold marks, colour bars and a label are drawn in the new margin around the original page area.
 * With grow=false the page keeps its size and the marks are drawn inside it, in a `margin`-wide
 * band around a smaller trim area.
 */
export async function placeMarks(bytes, opts = {}) {
  const { pageIndices, margin = 36, grow = true, cropMarks = true, registration = true, foldMarks = false, colorBars = true, label = '', lineWidth = 0.5, length = 18, offset = 6, font = 'Helvetica' } = opts;
  // grow pages first
  let working = bytes;
  if (grow && margin > 0) {
    working = await repage(bytes, pageIndices, (page, v) => [{ size: [v.width + margin * 2, v.height + margin * 2], draws: [{ tx: margin, ty: margin, sx: 1 }] }]);
  }
  const doc = await load(working);
  const f = await doc.embedFont(FONTS[font] ?? StandardFonts.Helvetica);
  const black = cmyk(0, 0, 0, 1);
  const registrationColor = cmyk(1, 1, 1, 1);
  for (const i of normalizeIndices(doc, pageIndices)) {
    const page = doc.getPage(i);
    const v = visualSize(page);
    const m = margin;
    const x1 = m, y1 = m, x2 = v.width - m, y2 = v.height - m; // trim area
    drawOnVisual(page, v, (draw) => {
      const line = (sx, sy, ex, ey) => draw.line({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: lineWidth, color: black });
      if (cropMarks) {
        for (const [cx, cy, dx, dy] of [[x1, y1, -1, -1], [x2, y1, 1, -1], [x1, y2, -1, 1], [x2, y2, 1, 1]]) {
          line(cx + dx * offset, cy, cx + dx * (offset + length), cy);
          line(cx, cy + dy * offset, cx, cy + dy * (offset + length));
        }
      }
      if (foldMarks) {
        const mx = (x1 + x2) / 2;
        for (const [sy, ey] of [[y1 - offset, y1 - offset - length], [y2 + offset, y2 + offset + length]]) {
          const steps = 4;
          for (let s = 0; s < steps; s++) {
            const a = sy + ((ey - sy) * s) / steps, b = sy + ((ey - sy) * (s + 0.5)) / steps;
            line(mx, a, mx, b);
          }
        }
      }
      if (registration && m >= 14) {
        const r = Math.min(5, m / 3);
        for (const [cx, cy] of [[(x1 + x2) / 2, y1 - m / 2], [(x1 + x2) / 2, y2 + m / 2], [x1 - m / 2, (y1 + y2) / 2], [x2 + m / 2, (y1 + y2) / 2]]) {
          draw.circle({ x: cx, y: cy, size: r, borderColor: registrationColor, borderWidth: lineWidth, color: undefined });
          draw.line({ start: { x: cx - r * 1.6, y: cy }, end: { x: cx + r * 1.6, y: cy }, thickness: lineWidth, color: registrationColor });
          draw.line({ start: { x: cx, y: cy - r * 1.6 }, end: { x: cx, y: cy + r * 1.6 }, thickness: lineWidth, color: registrationColor });
        }
      }
      if (colorBars && m >= 14) {
        const sw = Math.min(14, m - 4);
        const patches = [cmyk(1, 0, 0, 0), cmyk(0, 1, 0, 0), cmyk(0, 0, 1, 0), cmyk(0, 0, 0, 1), cmyk(1, 1, 0, 0), cmyk(0, 1, 1, 0), cmyk(1, 0, 1, 0), cmyk(0, 0, 0, 0.75), cmyk(0, 0, 0, 0.5), cmyk(0, 0, 0, 0.25)];
        const startX = x2 - patches.length * sw - length - offset;
        patches.forEach((col, k) => draw.rectangle({ x: startX + k * sw, y: y2 + m / 2 - sw / 2, width: sw, height: sw, color: col, borderColor: black, borderWidth: 0.25 }));
      }
      if (label && m >= 10) {
        const size = Math.min(8, m / 2);
        const txt = sanitizeForFont(f, expandTemplate(label, { page: i + 1, pages: doc.getPageCount(), n: i + 1, bates: i + 1, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString(), file: opts.file ?? '' }));
        draw.text(txt, { x: x1 + offset + length, y: y1 - m / 2 - size / 2, size, font: f, color: black });
      }
    });
  }
  return save(doc);
}

// ---- documents -------------------------------------------------------------------------------------------------

/** A numbered sample document (big page numbers, corner labels) for testing impositions. */
export async function createSampleDocument({ pages = 8, size = 'A4', label = 'Page {page} of {pages}', colored = true } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('Folio imposition sample');
  doc.setProducer('Folio PDF');
  const f = await doc.embedFont(StandardFonts.HelveticaBold);
  const small = await doc.embedFont(StandardFonts.Helvetica);
  const [w, h] = resolveSheet(size);
  const n = Math.max(1, Math.min(2000, Math.floor(pages)));
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([w, h]);
    if (colored) {
      const hue = ((i - 1) * 137.5) % 360;
      const [r, g, b] = hslToRgb(hue / 360, 0.55, 0.85);
      page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(r, g, b) });
    }
    page.drawRectangle({ x: 18, y: 18, width: w - 36, height: h - 36, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
    const big = String(i);
    const sz = Math.min(w, h) * 0.5;
    page.drawText(big, { x: (w - f.widthOfTextAtSize(big, sz)) / 2, y: (h - sz * 0.72) / 2, size: sz, font: f, color: rgb(0.15, 0.15, 0.2) });
    const text = expandTemplate(label, { page: i, pages: n, n: i, bates: i, date: '', time: '', file: '' });
    page.drawText(text, { x: 28, y: h - 44, size: 14, font: small, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(text, { x: w - 28 - small.widthOfTextAtSize(text, 10), y: 28, size: 10, font: small, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('TOP', { x: (w - small.widthOfTextAtSize('TOP', 10)) / 2, y: h - 30, size: 10, font: small, color: rgb(0.4, 0.4, 0.4) });
  }
  return save(doc);
}

function hslToRgb(hh, s, l) {
  const k = (n) => (n + hh * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

// ---- automation sequences ------------------------------------------------------------------------------------------

/** Operations that can be recorded in a sequence and replayed: name -> fn(bytes, params). */
export const OPS = {
  booklet: async (b, p) => (await createBooklet(b, p)).bytes,
  nup: async (b, p) => (await nUp(b, p)).bytes,
  'step-repeat': async (b, p) => (await stepAndRepeat(b, p)).bytes,
  manual: async (b, p) => (await manualImpose(b, p)).bytes,
  shuffle: (b, p) => shufflePages(b, p),
  'shuffle-preset': (b, p) => shufflePreset(b, p.preset, p),
  reverse: (b) => reversePages(b),
  'insert-blank': (b, p) => insertBlankPages(b, p),
  'fill-multiple': (b, p) => fillToMultiple(b, p.multiple),
  duplicate: (b, p) => duplicatePages(b, p),
  'trim-shift': (b, p) => trimAndShift(b, p),
  'adjust-size': (b, p) => adjustPageSizes(b, p),
  mirror: (b, p) => mirrorPages(b, p),
  'rotate-content': (b, p) => rotatePagesContent(b, p),
  split: (b, p) => splitPages(b, p),
  tile: (b, p) => tilePages(b, p),
  'page-boxes': (b, p) => setPageBoxes(b, p),
  'stick-text': (b, p) => stickOnText(b, p),
  tape: (b, p) => maskingTape(b, p),
  marks: (b, p) => placeMarks(b, p),
};

/** Applies recorded steps [{ op, params }] in order. */
export async function runSequence(bytes, steps = []) {
  let out = bytes;
  for (const step of steps) {
    const fn = OPS[step.op];
    if (!fn) throw new EngineError('unsupported', `Unknown step "${step.op}"`);
    out = await fn(out, step.params ?? {});
  }
  return out;
}
