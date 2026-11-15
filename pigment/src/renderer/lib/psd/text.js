// Text layers ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: kind `text`, order 400). psd-text's file; until it lands
// this is the skeleton's stub with 0.4's text mapping moved verbatim from lib/io.js (one style per layer, fonts matched
// by family name; lib/io.js re-exports psdExpressible, PSD_TEXT_KEYS and cssFamilyFromPsFont). psd-text replaces it at
// the same path, keeps those exports and the Node-safe imports of S4.1 (fonts through fontCatalog() at call time),
// and sets PSD_FEATURES.textRuns.
import { registerPsdLayerKind, registerPsdFeatures } from './registry.js';
import { rgbFromPsd, psdColor } from './convert.js';
import { TextLayer, textExtensionFor } from '../document.js';
import { isUniform, nonDefaultKeys, charStyleAt, paragraphs, applyChar, applyPara, contentLength } from '../type/model.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ textRuns: false });
registerPsdFeatures(PSD_FEATURES);

/** Turns a PostScript font name (ArialMT, Arial-BoldMT, TimesNewRomanPS-ItalicMT) into a CSS family. */
export function cssFamilyFromPsFont(name) {
  if (!name) return 'Arial';
  if (/\s/.test(name)) return name; // already a family name (Pigment writes those)
  let n = name.replace(/(PS)?MT$/, '').replace(/-[A-Za-z]+$/, '').replace(/PS$/, '');
  n = n.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return n.trim() || name;
}

const JUSTIFY_TO_ALIGN = { left: 'left', right: 'right', center: 'center', 'justify-left': 'left', 'justify-right': 'right', 'justify-center': 'center', 'justify-all': 'left' };

/** Builds an editable TextLayer from ag-psd text data (fonts are matched by family name; one style per layer). */
export function textLayerFromPsd(pl, common, left, top) {
  const t = pl.text;
  const st = t.style ?? t.styleRuns?.[0]?.style ?? {};
  const m = Array.isArray(t.transform) && t.transform.length === 6 ? t.transform : [1, 0, 0, 1, left, top];
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const size = Math.max(1, (st.fontSize ?? 24) * scale);
  const psName = st.font?.name ?? '';
  const font = {
    family: cssFamilyFromPsFont(psName),
    size,
    weight: st.fauxBold || /bold|black|heavy|semibold/i.test(psName.replace(/^[^-]*/, '')) ? 700 : 400,
    italic: !!st.fauxItalic || /italic|oblique/i.test(psName.replace(/^[^-]*/, '')),
    underline: !!st.underline,
    color: rgbFromPsd(st.fillColor),
    align: JUSTIFY_TO_ALIGN[t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style?.justification] ?? 'left',
    lineHeight: st.leading && st.autoLeading === false && st.fontSize ? Math.max(0.5, st.leading / st.fontSize) : 1.2,
    letterSpacing: st.tracking ? (st.tracking / 1000) * size : 0,
    ...(t.orientation === 'vertical' ? { orientation: 'vertical' } : {}),
  };
  const ascent = size * 0.8;
  // linear part with the scale divided out: identity means plain, unrotated text
  const lin = [m[0] / scale, m[1] / scale, m[2] / scale, m[3] / scale];
  const plain = Math.abs(lin[0] - 1) < 1e-3 && Math.abs(lin[3] - 1) < 1e-3 && Math.abs(lin[1]) < 1e-3 && Math.abs(lin[2]) < 1e-3;
  const box = t.shapeType === 'box' && Array.isArray(t.boxBounds) && t.boxBounds.length === 4 ? t.boxBounds : null;
  const width = box ? Math.max(size, (box[2] - box[0]) * scale) : null;
  // text space has its origin on the first baseline; Pigment's box starts one ascent above it
  const ox = box ? box[0] * scale : 0, oy = box ? box[1] * scale + ascent : 0;
  const props = { ...common, text: t.text.replace(/\r/g, '\n'), font, width };
  if (plain) {
    props.x = m[4] + ox;
    props.y = m[5] - ascent + oy;
  } else {
    props.x = ox;
    props.y = oy - ascent;
    props.transform = [lin[0], lin[1], lin[2], lin[3], m[4], m[5]];
  }
  const layer = new TextLayer(props);
  // the 0.4 attributes textToPsd writes (PSD_TEXT_KEYS) have no field in 0.3's flat font: put them on the rich text
  // so a file Pigment saved as editable text reopens looking the same
  const patch = {};
  if (st.strikethrough) patch.strike = true;
  if (st.fontCaps === 1 || st.fontCaps === 2) patch.caps = st.fontCaps === 1 ? 'small' : 'all';
  if (st.baselineShift) patch.baselineShift = st.baselineShift * scale;
  if (typeof st.horizontalScale === 'number' && st.horizontalScale > 0) patch.scaleX = Math.round(st.horizontalScale * 10000) / 100;
  if (typeof st.verticalScale === 'number' && st.verticalScale > 0) patch.scaleY = Math.round(st.verticalScale * 10000) / 100;
  if (st.autoKerning === false) patch.autoKern = 'none';
  if (Object.keys(patch).length) layer.content = applyChar(layer.content, 0, contentLength(layer.content), patch);
  // 0.3's font.align has no justified values; the paragraph model does
  const just = t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style?.justification;
  if (typeof just === 'string' && just.startsWith('justify-')) layer.content = applyPara(layer.content, 0, contentLength(layer.content), { align: just });
  return layer;
}

/**
 * The rich-text attributes textToPsd writes (J.8), by model key, with the ag-psd field each becomes (checked against
 * the vendored ag-psd typings: TextStyle and ParagraphStyle). A uniform text layer whose other non-default attributes
 * do not change its look stays editable text in a PSD; anything else is written as pixels.
 */
export const PSD_TEXT_KEYS = Object.freeze({
  char: Object.freeze({
    fontFamily: 'font.name', fontWeight: 'fauxBold', fontItalic: 'fauxItalic', size: 'fontSize', color: 'fillColor',
    underline: 'underline', strike: 'strikethrough', leading: 'leading / autoLeading', tracking: 'tracking',
    caps: 'fontCaps', baselineShift: 'baselineShift', scaleX: 'horizontalScale', scaleY: 'verticalScale',
    autoKern: 'autoKerning', fauxBold: 'fauxBold', fauxItalic: 'fauxItalic',
  }),
  para: Object.freeze({ align: 'justification' }),
});
// attributes that do not change what a paragraph looks like (language: hyphenation and spelling; the composer and
// breaker rules of 0.3 paragraphs)
const LOOK_NEUTRAL_CHAR = new Set(['language', 'noBreak', 'fractionalWidths']);
const LOOK_NEUTRAL_PARA = new Set(['composer', 'breakRules']);

/** True when PSD text (as textToPsd writes it) can hold the layer's formatting (J.8). */
export function psdExpressible(layer) {
  const c = layer.content;
  if (!c || !isUniform(c)) return false;
  const ch = charStyleAt(c, 0);
  const para = paragraphs(c)[0].style;
  const { char, para: paraKeys } = nonDefaultKeys(c);
  for (const k of char) {
    if (LOOK_NEUTRAL_CHAR.has(k)) continue;
    if (!(k in PSD_TEXT_KEYS.char)) return false;
    if (k === 'autoKern' && ch.autoKern === 'optical') return false;
  }
  const justifies = para.align.startsWith('justify');
  for (const k of paraKeys) {
    if (LOOK_NEUTRAL_PARA.has(k) || k in PSD_TEXT_KEYS.para) continue;
    if (k === 'hyphenation' && !para.hyphenate) continue;
    // auto leading is written as the leading; word, letter and glyph spacing matter only to justified lines
    if (k === 'justification' && !justifies) continue;
    return false;
  }
  return true;
}

/** PSD text data for a Pigment text layer (placed on the first baseline like Photoshop). */
export function textToPsd(layer) {
  const f = layer.font, ch = charStyleAt(layer.content, 0);
  const para = paragraphs(layer.content)[0].style;
  const lay = layer.layout();
  // the first baseline from the layout (every engine puts it at y + 0.8 x the first line's largest size)
  const baseline = lay.lines[0]?.baseline ?? layer.y + f.size * 0.8;
  const ascent = baseline - layer.y;
  const base = [1, 0, 0, 1, layer.x, baseline];
  let transform = base;
  if (layer.transform) {
    const [a, b, c, d, e, g] = layer.transform;
    transform = [a, b, c, d, a * base[4] + c * base[5] + e, b * base[4] + d * base[5] + g];
  }
  const style = {
    font: { name: f.family },
    fontSize: f.size,
    fillColor: psdColor(f.color),
    fauxBold: !!ch.fauxBold || (f.weight ?? 400) >= 600,
    fauxItalic: !!ch.fauxItalic || !!f.italic,
    underline: !!f.underline,
    autoLeading: Math.abs((f.lineHeight ?? 1.2) - 1.2) < 1e-6,
    leading: f.size * (f.lineHeight ?? 1.2),
    tracking: f.size ? Math.round(((f.letterSpacing ?? 0) / f.size) * 1000) : 0,
  };
  // 0.4 attributes, written only when set so a 0.3 layer's text data stays what 0.3 wrote
  if (ch.strike) style.strikethrough = true;
  if (ch.caps !== 'normal') style.fontCaps = ch.caps === 'small' ? 1 : 2;
  if (ch.baselineShift) style.baselineShift = ch.baselineShift;
  if (ch.scaleX !== 100) style.horizontalScale = ch.scaleX / 100;
  if (ch.scaleY !== 100) style.verticalScale = ch.scaleY / 100;
  if (ch.autoKern === 'none') style.autoKerning = false;
  const out = {
    text: layer.text,
    orientation: f.orientation === 'vertical' ? 'vertical' : 'horizontal',
    transform,
    shapeType: layer.width === null ? 'point' : 'box',
    style,
    paragraphStyle: { justification: ['left', 'right', 'center', 'justify-left', 'justify-right', 'justify-center', 'justify-all'].includes(para.align) ? para.align : 'left' },
  };
  if (layer.width !== null) {
    const h = typeof layer.height === 'number' ? layer.height : Math.max(lay.height, lay.lineHeight);
    out.boxBounds = [0, -ascent, layer.width, h - ascent];
  }
  return out;
}

// A text layer is written as PSD text (with its pixels, as Photoshop's preview) when PSD text can hold it: not text on
// a path or stacked text (no PSD equivalent), its colour what the image mode shows (S4.2: a mode document's text
// declines otherwise) and its formatting expressible (J.8). Any other text layer falls through to the raster kind,
// and the built-in 'pixel-text' notice counts it.
registerPsdLayerKind({
  id: 'text',
  order: 400,
  test: (pl) => !!pl.text?.text,
  read(pl, ctx) {
    const layer = textLayerFromPsd(pl, {}, pl.left ?? 0, pl.top ?? 0);
    ctx.claim(layer, 'text');
    return layer;
  },
  match: (layer, ctx) => layer.type === 'text' && !textExtensionFor(layer) && ctx.asShown(layer.font?.color ?? '#000000') && psdExpressible(layer),
  write(layer, ctx) {
    const r = layer.render();
    ctx.claim(layer, 'text');
    return { left: r.x, top: r.y, canvas: ctx.shown(r.canvas, r.x, r.y), text: textToPsd(layer) };
  },
}, { builtin: true });
