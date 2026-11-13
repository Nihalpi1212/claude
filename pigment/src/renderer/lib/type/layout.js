// The HarfBuzz type engine (type-engine-core, ARCHITECTURE.md "0.4 features", package 1; B.2, B.3). MODULES entry.
//
// layoutContent() is the engine's line layout: pure, no DOM, Node-tested with given advances. It takes the rich-text
// content (lib/type/model.js) and a measurer that shapes pieces of text in one style (shaper.js shapePiece in the app),
// asks the registered breaker and composers for the lines of each paragraph (B.3), and places them: alignment,
// indents, space before / after, tabs, lists, hyphens, justification and hanging punctuation from the composer,
// tracking in 1/1000 em added after each cluster (never after a line's last; a ligature stays one cluster, so tracking
// keeps it), manual kerning, the optical kerner, a box width (wrapping) and height (`overflow`, hidden lines).
//
// Vertical rule (A, "First baseline"): the first baseline sits at y + 0.8 × the largest size on the first line; each
// following baseline is the previous one plus that line's leading (Photoshop: leading is measured from the baseline
// above), plus space after / before at a paragraph start. A line's box is its leading tall and the boxes tile, so for
// one size and one leading every line is exactly where 0.3 put it.
//
// install(app) registers the engine 'harfbuzz' (tried before the stub 'canvas'; supports(layer) is false while the wasm
// or a run's face data is missing, so the stub draws), the font provider of fonts.js, and the test hook
// window.__pigmentTest.addFont in the browser build.
import { runsIn, paragraphs, charStyleAt, tidyNumber } from './model.js';
import { shapePiece, drawnSize, baselineOffset, graphemeStarts, loadHarfBuzz, harfBuzz, clearShapeCache } from './shaper.js';

// ---- pure line layout ---------------------------------------------------------------------------------------------

const isHangingSpace = (ch) => ch === ' ' || ch === '\u3000';
const trackPx = (st) => ((Number(st.tracking) || 0) * st.size) / 1000;
const kernPx = (st) => ((Number(st.kern) || 0) * st.size) / 1000;
const leadingOf = (st, para, maxSize) => (st.leading === 'auto' ? maxSize * tidyNumber(para.justification.autoLeading / 100) : st.leading);
const nextTab = (w, stop) => (Math.floor(w / Math.max(1, stop) + 1e-9) + 1) * Math.max(1, stop);

/** Text pieces of one paragraph: runs split at tabs and forced line breaks (U+2028). */
function piecesOf(runs, text, from, to) {
  const out = [];
  for (const r of runs) {
    const a = Math.max(from, r.from), b = Math.min(to, r.to);
    if (b <= a) continue;
    let s = a;
    for (let i = a; i < b; i++) {
      const ch = text[i];
      if (ch !== '\t' && ch !== '\u2028') continue;
      if (i > s) out.push({ kind: 'text', from: s, to: i, style: r.style });
      out.push({ kind: ch === '\t' ? 'tab' : 'br', from: i, to: i + 1, style: r.style });
      s = i + 1;
    }
    if (b > s) out.push({ kind: 'text', from: s, to: b, style: r.style });
  }
  return out;
}

/**
 * Lays out rich-text content.
 *
 * opts: { x, y, width (null: point text), height (null: grows), engine,
 *   measurer: { piece(text, from, to, style, { ctxFrom, ctxTo, kern }) -> Piece (shaper.js), hyphen(style) -> px,
 *               marker(style, text) -> px },
 *   composerFor(id), breaker(text, lang, { rules }), hyphenate(from, to) -> number[] | null,
 *   listMarker(paras, index) -> string | null, kerner(mode) -> fn | null, outline(piece, unit) -> PathData | null }
 * Returns a TextLayout (B.3). Runs carry engine fields: `units` (positioned shaping units), `face`, `size`.
 */
export function layoutContent(content, opts) {
  const { x: X = 0, y: Y = 0, measurer } = opts;
  const W = opts.width ?? null;
  const H = opts.height ?? null;
  const text = content.text;
  const runs = runsIn(content, 0, text.length);
  const paras = paragraphs(content);

  // ---- phase 1: shape each paragraph's pieces for measurement (context: the paragraph) ----
  const breakCache = new Map();
  const breaksFor = (lang, rules) => {
    const key = `${lang}\u0000${rules}`;
    if (!breakCache.has(key)) breakCache.set(key, (opts.breaker ? opts.breaker(text, lang, { rules }) : null) ?? []);
    return breakCache.get(key);
  };
  const N = text.length;
  const adv = new Float64Array(N); // advance of the unit starting at i
  const trk = new Float64Array(N); // tracking, kerning and optical kerning after the unit starting at i
  const isStart = new Uint8Array(N);
  const pieceAt = new Map(); // `${from}:${to}` -> shaped piece (phase 1)
  const shapedPieces = (p) => {
    const out = [];
    for (const pc of piecesOf(runs, text, p.from, p.to)) {
      if (pc.kind !== 'text') {
        isStart[pc.from] = 1;
        out.push(pc);
        continue;
      }
      const shaped = shapeWithKerning(text, pc, { ctxFrom: p.from, ctxTo: p.to });
      pieceAt.set(`${pc.from}:${pc.to}`, shaped);
      for (const u of shaped.piece.units) {
        adv[u.index] = u.advance;
        trk[u.index] = shaped.extra.get(u.index) ?? 0;
        isStart[u.index] = 1;
      }
      out.push(pc);
    }
    return out;
  };
  function shapeWithKerning(txt, pc, ctx) {
    const st = pc.style;
    const kernFn = st.autoKern !== 'metrics' && st.autoKern !== 'none' ? opts.kerner?.(st.autoKern) : null;
    let piece = measurer.piece(txt, pc.from, pc.to, st, { ...ctx, kern: !kernFn });
    const extra = new Map();
    const base = trackPx(st) + kernPx(st);
    let extraEm = null;
    if (kernFn) {
      try {
        extraEm = kernFn(st, txt.slice(pc.from, pc.to), piece.units.map((u) => opts.outline?.(piece, u) ?? null));
      } catch {
        extraEm = null;
      }
      // the kerner declined: metrics kerning, as the stub does without a kerner (B.3)
      if (!Array.isArray(extraEm)) piece = measurer.piece(txt, pc.from, pc.to, st, { ...ctx, kern: true });
    }
    piece.units.forEach((u, k) => extra.set(u.index, base + (Array.isArray(extraEm) ? ((Number(extraEm[k]) || 0) * st.size) / 1000 : 0)));
    return { piece, extra };
  }

  const paraPieces = paras.map((p) => shapedPieces(p));
  const tabStopOf = (p) => p.style.tabStop;

  /** Natural advance of [a, b) set on one line from its start (tabs to the next stop; no tracking after the last unit). */
  const measure = (a, b, stop) => {
    let w = 0;
    let lastTrk = 0;
    for (let i = a; i < b; i++) {
      if (!isStart[i] && text[i] !== '\t') continue;
      if (text[i] === '\t') {
        w = nextTab(w, stop);
        lastTrk = 0;
        continue;
      }
      if (text[i] === '\u2028' || text[i] === '\n') continue;
      w += adv[i] + trk[i];
      lastTrk = trk[i];
    }
    return w - lastTrk;
  };

  // ---- phase 2: compose lines per paragraph segment ----
  const raw = [];
  paras.forEach((p) => {
    const ps = p.style;
    const segs = [];
    let s = p.from;
    for (let i = p.from; i < p.to; i++) if (text[i] === '\u2028') {
      segs.push([s, i, i + 1]);
      s = i + 1;
    }
    segs.push([s, p.to, p.to]);
    const wrap = W !== null && p.from !== p.to;
    let breaks = wrap ? breaksFor(charStyleAt(content, p.from).language ?? 'en-US', ps.breakRules ?? 'standard') : [];
    // a run marked noBreak has no break opportunity inside it
    if (wrap && runs.some((r) => r.style.noBreak)) breaks = breaks.filter((b) => !(b.at > 0 && b.at < N && charStyleAt(content, b.at - 1).noBreak && charStyleAt(content, b.at).noBreak));
    let firstOfPara = true;
    for (const [sf, st, next] of segs) {
      const indentFirst = firstOfPara ? ps.indentFirst : 0;
      if (!wrap) {
        raw.push({ para: p, from: sf, to: next, drawFrom: sf, end: st, first: firstOfPara, hyphen: false });
      } else {
        const comp = opts.composerFor(ps.composer);
        const lineWidth = (n) => W - ps.indentLeft - ps.indentRight - (n === 0 ? indentFirst : 0);
        const out = comp.compose({
          from: sf,
          to: st,
          text,
          lineWidth,
          measure: (a, b) => measure(a, b, tabStopOf(p)),
          spaceWidth: (at) => (isStart[at] ? adv[at] : 0),
          hyphenWidth: (at) => measurer.hyphen(charStyleAt(content, Math.max(0, at - 1))),
          breaks: breaks.filter((b) => b.at > sf && b.at < st),
          hyphenate: ps.hyphenate && opts.hyphenate ? (a, b) => opts.hyphenate(a, b) ?? [] : null,
          style: ps,
        });
        out.forEach((l, k) => {
          const last = k === out.length - 1;
          const lineTo = last ? st : Math.min(st, l.to);
          raw.push({ para: p, from: l.from, to: last ? next : l.to, drawFrom: Math.max(l.from, Math.min(lineTo, l.textFrom ?? l.from)), end: lineTo, first: firstOfPara && k === 0, hyphen: !!l.hyphen, justify: l.justify, hang: l.hang });
        });
      }
      firstOfPara = false;
    }
  });

  // ---- phase 3: place every line ----
  const lines = raw.map((r) => buildLine(r));
  function buildLine(r) {
    const ps = r.para.style;
    let trimmed = r.end;
    while (trimmed > r.drawFrom && isHangingSpace(text[trimmed - 1])) trimmed--;
    const stop = tabStopOf(r.para);
    // pieces of the line: phase-1 pieces when the line holds them whole, else reshaped with the line as context
    const pcs = [];
    for (const pc of paraPieces[r.para.index]) {
      const a = Math.max(pc.from, r.drawFrom), b = Math.min(pc.to, r.end);
      if (b <= a) continue;
      if (pc.kind !== 'text') {
        pcs.push({ ...pc, from: a, to: b });
        continue;
      }
      const whole = a === pc.from && b === pc.to ? pieceAt.get(`${a}:${b}`) : null;
      const shaped = whole ?? shapeWithKerning(text, { ...pc, from: a, to: b }, { ctxFrom: r.drawFrom, ctxTo: r.end });
      pcs.push({ ...pc, from: a, to: b, shaped });
    }
    const styles = pcs.map((p) => p.style);
    const at = charStyleAt(content, r.drawFrom < N ? r.drawFrom : Math.max(0, r.from - 1));
    const sizes = (styles.length ? styles : [at]);
    const maxSize = Math.max(...sizes.map((s) => s.size));
    const leading = Math.max(...sizes.map((s) => leadingOf(s, ps, maxSize)));
    // the last unit of the line takes no tracking
    let lastUnit = null;
    for (const p of pcs) if (p.shaped) for (const u of p.shaped.piece.units) lastUnit = u;
    const unitTrk = (p, u) => (u === lastUnit ? 0 : p.shaped.extra.get(u.index) ?? 0);
    const width = measureLine(pcs, r.drawFrom, trimmed, stop, unitTrk);
    const hyphenStyle = r.hyphen ? charStyleAt(content, Math.max(0, trimmed - 1)) : null;
    const hyphenW = hyphenStyle ? measurer.hyphen(hyphenStyle) : 0;
    return { r, ps, pcs, maxSize, leading, natural: width + hyphenW, hyphenW, hyphenStyle, trimmed, unitTrk, stop, lastOfPara: false };
  }
  lines.forEach((l, i) => {
    l.lastOfPara = !lines[i + 1] || lines[i + 1].r.para !== l.r.para;
  });

  const lw = W ?? Math.ceil(Math.max(1, ...lines.map((l) => l.natural)));
  const ascent0 = (lines[0]?.maxSize ?? charStyleAt(content, 0).size) * 0.8;
  const d = (lines[0]?.leading ?? 0) - ascent0;
  let baseline = Y + ascent0;
  const out = lines.map((l, i) => {
    const { r, ps } = l;
    if (i > 0) {
      baseline += l.leading;
      if (r.first) baseline += lines[i - 1].ps.spaceAfter + ps.spaceBefore;
    }
    const top = baseline - l.leading + d;
    const indentFirst = r.first ? ps.indentFirst : 0;
    const hangStart = Number(r.hang?.start) || 0, hangEnd = Number(r.hang?.end) || 0;
    const start = ps.indentLeft + indentFirst - hangStart;
    const avail = lw - ps.indentLeft - ps.indentRight - indentFirst + hangStart + hangEnd;
    const justify = ps.align.startsWith('justify') && (!l.lastOfPara || ps.align === 'justify-all') && W !== null;
    const align = ps.align === 'center' ? 'center' : ps.align === 'right' ? 'right' : ps.align.startsWith('justify') && !justify ? ({ 'justify-center': 'center', 'justify-right': 'right' })[ps.align] ?? 'left' : 'left';
    const spaces = countSpaces(text, l.r.drawFrom, l.trimmed);
    const gaps = Math.max(0, countUnits(l.pcs, l.trimmed) - 1);
    const wordSpace = r.justify ? Math.max(0, Number(r.justify.wordSpace) || 0) : justify && spaces ? Math.max(0, avail - l.natural) / spaces : 0;
    const letterSpace = r.justify ? Number(r.justify.letterSpace) || 0 : 0;
    const glyphScale = r.justify && Number(r.justify.glyphScale) > 0 ? Number(r.justify.glyphScale) : 1;
    const drawnWidth = (l.natural - l.hyphenW + wordSpace * spaces + letterSpace * gaps) * glyphScale + l.hyphenW;
    const offX = align === 'center' ? start + (avail - drawnWidth) / 2 : align === 'right' ? start + avail - drawnWidth : start;
    const x = X + offX;
    const visible = H === null || i === 0 || top - Y + l.leading <= H + 1e-6;
    const line = {
      index: i,
      para: r.para.index,
      from: r.from,
      to: r.to,
      x,
      top,
      baseline,
      width: drawnWidth,
      height: l.leading,
      ascent: l.maxSize * 0.8,
      descent: l.maxSize * 0.2,
      visible,
      hyphen: r.hyphen,
      last: l.lastOfPara,
      text: text.slice(r.drawFrom, l.trimmed),
      runs: [],
      _glyphScale: glyphScale,
      _marker: null,
      _hyphen: null,
    };
    placeRuns(line, l, { x, baseline, wordSpace, letterSpace, glyphScale });
    if (l.hyphenStyle) {
      const p = measurer.piece('-', 0, 1, l.hyphenStyle, { kern: true });
      line._hyphen = makeRun(p, '-', 0, 1, l.hyphenStyle, x + drawnWidth - l.hyphenW, baseline, 1);
    }
    if (r.first && ps.list && opts.listMarker) {
      const marker = opts.listMarker(content.paras, r.para.index);
      if (marker) {
        const st = charStyleAt(content, r.para.from);
        const mw = measurer.marker(st, marker);
        const p = measurer.piece(marker, 0, marker.length, st, { kern: true });
        line._marker = makeRun(p, marker, 0, marker.length, st, x - mw - st.size * 0.25, baseline, 1);
      }
    }
    return line;
  });
  const contentHeight = out.length ? out[out.length - 1].baseline + d - Y : 0;
  return {
    engine: opts.engine ?? 'harfbuzz',
    frame: { width: W, height: H },
    width: lw,
    height: H === null ? Math.ceil(contentHeight) : H,
    contentHeight,
    overflow: H !== null && contentHeight > H + 1e-6,
    ascent: ascent0,
    lineHeight: lines[0]?.leading ?? 0,
    lines: out,
  };

  function measureLine(pcs, a, b, stop, unitTrk) {
    let w = 0, lastT = 0;
    for (const p of pcs) {
      if (p.from >= b) break;
      if (p.kind === 'tab') {
        w = nextTab(w, stop);
        lastT = 0;
        continue;
      }
      if (p.kind !== 'text') continue;
      for (const u of p.shaped.piece.units) {
        if (u.index >= b || u.index < a) continue;
        const t = unitTrk(p, u);
        w += u.advance + t;
        lastT = t;
      }
    }
    return w - lastT;
  }

  function placeRuns(line, l, { x, baseline: bl, wordSpace, letterSpace, glyphScale }) {
    let pen = 0; // from the line start, before the glyph scale
    const trimmed = l.trimmed;
    let unitCount = 0;
    const totalUnits = countUnits(l.pcs, trimmed);
    for (const p of l.pcs) {
      const st = p.style;
      if (p.kind === 'tab') {
        const w = nextTab(pen, l.stop) - pen;
        line.runs.push(simpleRun(p.from, p.to, st, x + pen * glyphScale, bl, w * glyphScale));
        pen += w;
        continue;
      }
      if (p.kind === 'br') {
        line.runs.push(simpleRun(p.from, p.to, st, x + pen * glyphScale, bl, 0));
        continue;
      }
      const piece = p.shaped.piece;
      // logical advances, then visual positions: a block of right-to-left units is laid out from its right end
      const units = piece.units.map((u) => {
        let a = u.advance + l.unitTrk(p, u);
        if (u.index < trimmed) {
          if (text[u.index] === ' ') a += wordSpace;
          unitCount++;
          if (unitCount < totalUnits) a += letterSpace;
        }
        return { u, a };
      });
      const runStart = pen;
      const positioned = [];
      for (let k = 0; k < units.length;) {
        if (!units[k].u.rtl) {
          positioned.push({ ...units[k], at: pen });
          pen += units[k].a;
          k++;
          continue;
        }
        let e = k;
        let blockW = 0;
        while (e < units.length && units[e].u.rtl) blockW += units[e++].a;
        let right = pen + blockW;
        for (let q = k; q < e; q++) {
          right -= units[q].a;
          positioned.push({ ...units[q], at: right });
        }
        pen += blockW;
        k = e;
      }
      const run = makeRun(piece, text, p.from, p.to, st, x + runStart * glyphScale, bl, glyphScale, positioned.map((q) => ({ ...q, at: x + q.at * glyphScale })));
      run.advance = (pen - runStart) * glyphScale;
      line.runs.push(run);
    }
  }
}

function countSpaces(text, a, b) {
  let n = 0;
  for (let i = a; i < b; i++) if (text[i] === ' ') n++;
  return n;
}
function countUnits(pcs, trimmed) {
  let n = 0;
  for (const p of pcs) if (p.shaped) for (const u of p.shaped.piece.units) if (u.index < trimmed) n++;
  return n;
}

function simpleRun(from, to, st, x, baseline, advance) {
  return { from, to, x, baseline: baseline - baselineOffset(st), advance, style: st, css: cssOf(st), scaleX: st.scaleX / 100, scaleY: st.scaleY / 100, clusters: from < to ? [{ index: from, x, advance }] : [], units: [], face: null, size: drawnSize(st) };
}

/**
 * A LayoutRun from a shaped piece. `positioned` gives each unit its x (base space) and advance; without it the units
 * follow one another from x. Clusters (B.3) are grapheme starts: a unit holding several graphemes (a ligature) shares
 * its advance among them.
 */
function makeRun(piece, text, from, to, st, x, baseline, glyphScale, positioned) {
  let pos = positioned;
  if (!pos) {
    let pen = x;
    pos = piece.units.map((u) => {
      const q = { u, a: u.advance, at: pen };
      pen += u.advance;
      return q;
    });
  }
  const units = pos.map(({ u, a, at }) => ({ ...u, x: at, advance: a * glyphScale, trk: (a - u.advance) * glyphScale }));
  const clusters = [];
  for (const u of units) {
    // a one-unit cluster is one grapheme: the segmenter is only asked about longer ones (ligatures, sequences)
    const starts = u.end - u.index === 1 ? [u.index] : graphemeStarts(text, u.index, u.end);
    const g = Math.max(1, starts.length);
    const share = (u.advance - u.trk) / g;
    starts.forEach((s, j) => clusters.push({ index: s, x: u.x + share * j, advance: share + (j === g - 1 ? u.trk : 0), _trk: j === g - 1 ? u.trk : 0 }));
  }
  clusters.sort((p, q) => p.index - q.index);
  const advance = units.reduce((s, u) => s + u.advance, 0);
  return { from, to, x, baseline: baseline - baselineOffset(st), advance, style: st, css: cssOf(st), scaleX: st.scaleX / 100, scaleY: st.scaleY / 100, clusters, units, face: piece.face ?? null, size: piece.size ?? drawnSize(st) };
}

const quoteFamily = (f) => (/[\s'"]/.test(f) && !/^["']/.test(f) ? `"${f}"` : f);
/** The CSS font of a resolved style (document.js cssFont's form, at the drawn size). */
export const cssOf = (st, size = drawnSize(st)) => `${st.fontItalic ? 'italic ' : ''}${st.fontWeight ?? 400} ${size}px ${quoteFamily(st.fontFamily)}`;

// ---- the engine -----------------------------------------------------------------------------------------------------

let facesEpoch = 0;
const supportCache = new WeakMap(); // content -> { key, value }

/** Builds the engine from its parts; layout.js install() registers it (separate so Node tests can make one). */
export function createEngine({ faceFor, requestFamily, measureText, kerner, listMarker, render, bounds, outline }) {
  const piece = (text, from, to, st, o = {}) => shapePiece(text, from, to, st, { faceFor, measure: measureText, ctxFrom: o.ctxFrom, ctxTo: o.ctxTo, opticalFallback: o.kern });
  const measurer = {
    piece: (text, from, to, st, o) => piece(text, from, to, st, o),
    hyphen: (st) => piece('-', 0, 1, st).units.reduce((s, u) => s + u.advance, 0),
    marker: (st, s) => piece(s, 0, s.length, st).units.reduce((w, u) => w + u.advance, 0),
  };
  return {
    id: 'harfbuzz',
    /** False while the wasm or the face of some run is missing (that family is then loaded in the background). */
    supports(layer) {
      if (!harfBuzz()) return false;
      const content = layer.content;
      const key = `${facesEpoch}`;
      const hit = supportCache.get(content);
      if (hit && hit.key === key) return hit.value;
      let ok = true;
      const styles = content.text.length ? runsIn(content, 0, content.text.length).map((r) => r.style) : [charStyleAt(content, 0)];
      for (const st of styles) {
        if (faceFor(st)) continue;
        ok = false;
        requestFamily?.(st.fontFamily);
      }
      supportCache.set(content, { key, value: ok });
      return ok;
    },
    layout(layer, env) {
      return layoutContent(layer.content, {
        x: layer.x,
        y: layer.y,
        width: env.width,
        height: env.height,
        engine: 'harfbuzz',
        measurer,
        composerFor: env.composerFor,
        breaker: env.breaker,
        hyphenate: env.hyphenate,
        listMarker,
        kerner,
        outline,
      });
    },
    render,
    bounds,
  };
}

/** Faces arrived or went: the engine's caches are stale. */
export function bumpFacesEpoch() {
  facesEpoch++;
  clearShapeCache();
}

// ---- install (MODULES entry) ------------------------------------------------------------------------------------------

export async function install(app) {
  const api = await import('./api.js');
  const fonts = await import('./fonts.js');
  const render = await import('./render.js');
  const { measureContext } = await import('../document.js');

  const measureCache = new Map();
  const measureText = (s, st, size) => {
    const css = cssOf(st, size);
    const key = `${css}\u0000${s}`;
    let w = measureCache.get(key);
    if (w === undefined) {
      const ctx = measureContext();
      ctx.font = css;
      w = ctx.measureText(s).width;
      if (measureCache.size > 5000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  };
  fonts.setCanvasFallback({
    measure: measureText,
    metrics: (st) => {
      const ctx = measureContext();
      ctx.font = cssOf(st);
      const m = ctx.measureText('Hg');
      return { ascent: m.fontBoundingBoxAscent ?? st.size * 0.8, descent: m.fontBoundingBoxDescent ?? st.size * 0.2, capHeight: st.size * 0.7, xHeight: st.size * 0.5, underlinePosition: st.size * 0.12, underlineThickness: Math.max(1, st.size / 16), strikePosition: -st.size * 0.3, strikeThickness: Math.max(1, st.size / 16) };
    },
  });
  fonts.onFacesChanged(() => {
    bumpFacesEpoch();
    api.fontsChanged();
  });
  const engine = createEngine({
    faceFor: fonts.faceFor,
    requestFamily: fonts.requestFamily,
    measureText,
    kerner: (mode) => api.kerner?.(mode) ?? null,
    listMarker: (paras, index) => api.listMarkerText?.(paras, index) ?? null,
    outline: (piece, unit) => fonts.unitOutline(piece.face, unit),
    render: render.renderLayout,
    bounds: render.layoutBounds,
  });
  api.registerEngine(engine);
  api.registerFontProvider(fonts.harfBuzzFontProvider);

  // the installed-font list arrives (or a permission was granted from a gesture): families asked before are retried
  try {
    const { onFontsChanged } = await import('../tools/text.js');
    onFontsChanged?.(() => {
      fonts.resetLocalFonts();
      bumpFacesEpoch();
      api.fontsChanged();
    });
  } catch {
    // no Type tool module: nothing to follow
  }

  if (typeof window !== 'undefined' && !window.pigment) {
    // the browser build's test hook (Electron reads installed fonts itself)
    const test = (window.__pigmentTest ||= {});
    test.addFont = (bytes, meta = {}) => fonts.addFontData(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), meta);
  }
  // the wasm loads in the background: until it is there every layer is the stub's. Then the families new text starts
  // with are read from the installed fonts (where allowed), so the first text typed is the engine's, not the stub's
  loadHarfBuzz().then(() => {
    const families = new Set(['Arial']);
    for (const id of ['type-horizontal', 'type-vertical']) {
      try {
        const f = app.tools?.opt?.(id, 'family');
        if (f) families.add(f);
      } catch {
        // a tool that is not registered
      }
    }
    for (const f of families) fonts.requestFamily(f);
  }).catch((err) => console.warn('[type] HarfBuzz is not available; the Canvas type engine draws all text:', err?.message ?? err));
}
