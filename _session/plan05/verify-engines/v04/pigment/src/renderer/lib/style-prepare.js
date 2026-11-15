// Style preparation hook (ARCHITECTURE.md "0.4 features", K.2; E11; owned by layer-style-effects): turns a layer's
// stored styles into what styles.js applyStyles takes. The compositor's styledCanvas calls it.
//
// - Pattern references are decoded: the Pattern Overlay's `pattern`, a Stroke's pattern fill and the Bevel &
//   Emboss Texture's pattern may each be a PatternRef ({ dataUrl, presetId?, name? }, L.6) or 0.3's data URL string;
//   applyStyles gets the pixels (ImageData). A data URL decodes once, asynchronously: until it has, that effect is off
//   and `ready` is false (the compositor must not cache the render); `onReady` (default: touch the layer and repaint)
//   runs when it has. A data URL that fails to decode counts as ready with no pattern, so it cannot loop.
// - Arrays of effect instances and `hidden` pass through.
// - When an effect anchors to the document (a pattern with Link with Layer off, a gradient with Align with Layer off)
//   the styles get `_place` ({ x, y, width, height }: the document position of the layer's pixels and the document
//   size), which applyStyles reads when the caller passes no `origin`.
import { resolvePattern } from './patterns.js';
import { effectInstances } from '../../shared/pixels/styles.js';

const failed = new Set();

/** The data URL of a stored pattern value, or null (an already decoded image is returned as it is by `decode`). */
function urlOf(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && typeof ref.dataUrl === 'string') return ref.dataUrl;
  return null;
}

const isPixels = (v) => !!v && typeof v === 'object' && v.width >= 1 && v.height >= 1 && !!v.data;

/** Where the layer's pixels lie in the document (null when unknown, e.g. a group). */
function placeOf(layer, doc) {
  if (!doc) return null;
  let x = null, y = null;
  if (layer.type === 'raster') ({ x, y } = layer);
  else if (!layer.isGroup && typeof layer.render === 'function') {
    const r = layer.render();
    if (r) ({ x, y } = r);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width: doc.width, height: doc.height };
}

/**
 * { styles, ready }: `ready` false means "do not cache this render" (a pattern still decoding). `onReady` runs when
 * a pending pattern has decoded (default: the layer is touched and the document repaints).
 */
export function prepareStyles(layer, doc, onReady = null) {
  const styles = layer.styles;
  if (!styles || typeof styles !== 'object') return { styles, ready: true };
  let ready = true;
  let out = null;
  const notify = onReady ?? (() => {
    layer.touch();
    doc?.changed('pixels', { layer });
  });
  const decode = (ref) => {
    if (isPixels(ref)) return ref;
    const url = urlOf(ref);
    if (!url) return null;
    const data = resolvePattern(url, () => {
      if (!resolvePattern(url)) failed.add(url);
      notify();
    });
    if (!data && !failed.has(url)) ready = false;
    return data;
  };
  // returns the instance list of key with fn applied (a copy only when something changed)
  const mapKey = (key, fn) => {
    const v = styles[key];
    if (!v) return;
    const list = effectInstances(styles, key);
    let changed = false;
    const next = list.map((fx) => {
      const r = fn(fx);
      if (r !== fx) changed = true;
      return r;
    });
    if (!changed) return;
    out ??= { ...styles };
    out[key] = Array.isArray(v) ? next : next[0];
  };
  let anchored = false;
  mapKey('patternOverlay', (fx) => {
    if (!fx.enabled) return fx;
    if (fx.link === false) anchored = true;
    if (isPixels(fx.pattern)) return fx;
    const data = decode(fx.pattern);
    return { ...fx, pattern: data, enabled: !!data };
  });
  mapKey('stroke', (fx) => {
    if (!fx.enabled) return fx;
    if ((fx.fill === 'pattern' && fx.link === false) || (fx.fill === 'gradient' && fx.align === false)) anchored = true;
    if (fx.fill !== 'pattern' || isPixels(fx.pattern)) return fx;
    // a pattern still decoding: the stroke waits (drawn with nothing rather than with another fill)
    const data = decode(fx.pattern);
    return { ...fx, pattern: data, enabled: !!data };
  });
  mapKey('bevel', (fx) => {
    const t = fx.texture;
    if (!fx.enabled || !t || typeof t !== 'object' || !t.enabled) return fx;
    if (t.link === false) anchored = true;
    if (isPixels(t.pattern)) return fx;
    const data = decode(t.pattern);
    return { ...fx, texture: { ...t, pattern: data, enabled: !!data } };
  });
  mapKey('gradientOverlay', (fx) => {
    if (fx.enabled && fx.align === false) anchored = true;
    return fx;
  });
  if (anchored) {
    const place = placeOf(layer, doc);
    if (place) {
      out ??= { ...styles };
      out._place = place;
    }
  }
  return { styles: out ?? styles, ready };
}
