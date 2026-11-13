// Style preparation hook (ARCHITECTURE.md "0.4 features", K.2; E11): turns a layer's stored styles into what
// styles.js applyStyles takes. The compositor's styledCanvas calls it.
//
// Stub by the skeleton: 0.3's pattern-overlay resolution, moved out of compositor.js styledCanvas (a data URL
// decodes once, asynchronously; until it has, the overlay is off and the result must not be cached). Arrays of
// effect instances pass through. layer-style-effects replaces this file (same export): pattern references, the
// Bevel texture, stroke and glow gradients and patterns.
import { resolvePattern } from './patterns.js';

/**
 * { styles, ready }: `ready` false means "do not cache this render" (a pattern still decoding). `onReady` runs when
 * a pending pattern has decoded (default: the layer is touched and the document repaints).
 */
export function prepareStyles(layer, doc, onReady = null) {
  const styles = layer.styles;
  const po = styles?.patternOverlay;
  if (po?.enabled && typeof po.pattern === 'string') {
    const ready = onReady ?? (() => {
      layer.touch();
      doc?.changed('pixels', { layer });
    });
    const data = resolvePattern(po.pattern, ready);
    return { styles: { ...styles, patternOverlay: { ...po, pattern: data, enabled: !!data } }, ready: !!data };
  }
  return { styles, ready: true };
}
