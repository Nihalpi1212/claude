// Layer › Layer Style: the pages (Blending Options, from lib/blending-options.js) plus the ten effects (Drop Shadow
// ... Stroke), edited live on the layer and recorded as one undo entry; also the fx menu of the Layers panel and the
// document's global light.
//
// Pages (ARCHITECTURE.md "0.4 features", L.3; E13): app.layerStyle.registerPage({ id, title, order, render(ctx) })
// adds an entry above the effects. ctx: { layer, styles, opacity, fillOpacity, blend (opacity and fill opacity
// 0..1), advanced (the draft of layer.blending, never null here), apply(), select(id), globalLight() }. The dialog
// snapshots, live-applies, restores on Cancel and commits on OK `blending` together with the styles, opacity, fill
// opacity and blend mode, in one setLayerProps entry; it stores null when the draft is the default.
//
// 0.4 effects (layer-style-effects, J.6): every Photoshop field of each effect (contours, noise, glow technique and
// gradient fill, the Bevel & Emboss Contour and Texture sub-pages, gradient and pattern fills through the shared
// `gradient`, `pattern` and `contour` widgets), several instances of Drop Shadow, Inner Shadow, Color Overlay,
// Gradient Overlay and Stroke (the + button on a row duplicates it; the buttons under the list move the selected
// instance up or down or delete it), and dragging in the document to place a shadow, satin, gradient or pattern while
// its page is shown (lib/style-canvas-drag.js).
import {
  STYLE_KEYS, INSTANCE_KEYS, MAX_INSTANCES, mergeStyles, hasEnabledStyles, effectInstances, effectDefaults,
} from '../../shared/pixels/styles.js';
import { normalizeGradient, PLACEMENT_KEYS } from '../../shared/pixels/gradient-model.js';
import { isLinearContour } from '../../shared/pixels/contour.js';
import { BLEND_MODES, DEFAULT_BLENDING, isDefaultBlending } from './document.js';
import { isStyleable, takesBlendingOptions } from './blending-options.js';
import { buildForm, formDialog } from './form.js';
import { setLayerProps } from './layer-ops.js';
import { patternFromCanvas } from './patterns.js';
import './contour-editor.js'; // the contour widget (registered when that module loads)
import { armStyleDrag, DRAGGABLE } from './style-canvas-drag.js';

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const BLENDS = BLEND_MODES.filter(Boolean);
// fields shown in percent, stored as fractions
const PCT_KEYS = new Set(['opacity', 'highlightOpacity', 'shadowOpacity', 'noise', 'range', 'jitter', 'scale', 'patternScale', '__cs_range', '__tx_scale', '__tx_depth']);
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const blend = (key = 'blend', label = 'Blend mode') => ({ key, label, type: 'select', options: BLENDS });
const color = (key = 'color', label = 'Color', extra = {}) => ({ key, label, type: 'color', ...extra });
const opacity = (key = 'opacity', label = 'Opacity') => S(key, label, 0, 100, 1, { unit: '%' });
const pct = (key, label, min = 0, max = 100, extra = {}) => S(key, label, min, max, 1, { unit: '%', ...extra });
const px = (key, label, min = 0, max = 250, extra = {}) => S(key, label, min, max, 1, { unit: 'px', ...extra });
const angle = (key = 'angle', label = 'Angle', extra = {}) => S(key, label, -180, 180, 1, { unit: '°', ...extra });
const check = (key, label, extra = {}) => ({ key, label, type: 'checkbox', ...extra });
const section = (label) => ({ type: 'section', label });
const contour = (key = 'contour', label = 'Contour') => ({ key, label, type: 'contour' });
const globalLight = check('useGlobalLight', 'Use global light');
// the pages whose Angle (and Altitude) are the document's Global Light while Use Global Light is ticked
const LIGHT_PAGES = new Set(['dropShadow', 'innerShadow', 'bevel']);
const antiAlias = (key = 'antiAlias') => check(key, 'Anti-aliased');
const isFill = (kind) => (v) => (v.fill ?? 'color') === kind;
const fillChoice = (kinds) => ({ key: 'fill', label: 'Fill type', type: 'segment', options: kinds });
const button = (label, act, onClick) => ({
  type: 'custom',
  label: '',
  render: (values, set) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.dataset.act = act;
    b.textContent = label;
    b.addEventListener('click', () => onClick(set, values));
    return b;
  },
});

/** The form of each page, by page id (an effect key, or a Bevel & Emboss sub-page). */
const EFFECT_FIELDS = {
  dropShadow: [
    section('Structure'), blend(), color(), opacity(), angle(), globalLight, px('distance', 'Distance', 0, 500), px('spread', 'Spread'), px('size', 'Size'),
    section('Quality'), contour(), antiAlias(), pct('noise', 'Noise'), check('knocksOut', 'Layer knocks out drop shadow'),
  ],
  innerShadow: [
    section('Structure'), blend(), color(), opacity(), angle(), globalLight, px('distance', 'Distance', 0, 500), px('spread', 'Choke'), px('size', 'Size'),
    section('Quality'), contour(), antiAlias(), pct('noise', 'Noise'),
  ],
  outerGlow: [
    section('Structure'), blend(), opacity(), pct('noise', 'Noise'), fillChoice([['color', 'Color'], ['gradient', 'Gradient']]),
    color('color', 'Color', { when: isFill('color') }), { key: '__glowGrad', label: 'Gradient', type: 'gradient', placement: false, flags: ['reverse'], when: isFill('gradient') },
    section('Elements'), { key: 'technique', label: 'Technique', type: 'select', options: [['softer', 'Softer'], ['precise', 'Precise']] }, px('spread', 'Spread'), px('size', 'Size'),
    section('Quality'), contour(), antiAlias(), pct('range', 'Range', 1, 100), pct('jitter', 'Jitter', 0, 100, { when: isFill('gradient') }),
  ],
  innerGlow: [
    section('Structure'), blend(), opacity(), pct('noise', 'Noise'), fillChoice([['color', 'Color'], ['gradient', 'Gradient']]),
    color('color', 'Color', { when: isFill('color') }), { key: '__glowGrad', label: 'Gradient', type: 'gradient', placement: false, flags: ['reverse'], when: isFill('gradient') },
    section('Elements'), { key: 'technique', label: 'Technique', type: 'select', options: [['softer', 'Softer'], ['precise', 'Precise']] },
    { key: 'source', label: 'Source', type: 'segment', options: [['center', 'Center'], ['edge', 'Edge']] }, px('choke', 'Choke'), px('size', 'Size'),
    section('Quality'), contour(), antiAlias(), pct('range', 'Range', 1, 100), pct('jitter', 'Jitter', 0, 100, { when: isFill('gradient') }),
  ],
  bevel: [
    section('Structure'),
    { key: 'style', label: 'Style', type: 'select', options: [['inner-bevel', 'Inner Bevel'], ['outer-bevel', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow-emboss', 'Pillow Emboss']] },
    { key: 'technique', label: 'Technique', type: 'select', options: [['smooth', 'Smooth'], ['chisel-hard', 'Chisel Hard'], ['chisel-soft', 'Chisel Soft']] },
    S('depth', 'Depth', 1, 1000, 1, { unit: '%' }),
    { key: 'direction', label: 'Direction', type: 'segment', options: [['up', 'Up'], ['down', 'Down']] },
    px('size', 'Size'), S('soften', 'Soften', 0, 16, 1, { unit: 'px' }),
    section('Shading'), angle(), S('altitude', 'Altitude', 0, 90, 1, { unit: '°' }), globalLight,
    contour('glossContour', 'Gloss contour'), antiAlias(),
    blend('highlightBlend', 'Highlight mode'), color('highlightColor', 'Highlight color'), opacity('highlightOpacity', 'Highlight opacity'),
    blend('shadowBlend', 'Shadow mode'), color('shadowColor', 'Shadow color'), opacity('shadowOpacity', 'Shadow opacity'),
  ],
  'bevel-contour': [section('Elements'), contour('__cs_contour', 'Contour'), antiAlias('__cs_aa'), pct('__cs_range', 'Range', 1, 100)],
  'bevel-texture': [
    section('Elements'), { key: '__tx_pattern', label: 'Pattern', type: 'pattern' },
    button('Snap to Origin', 'texture-snap', (set) => set('__tx_origin', [0, 0])),
    pct('__tx_scale', 'Scale', 1, 1000), pct('__tx_depth', 'Depth', -1000, 1000), check('__tx_invert', 'Invert'), check('__tx_link', 'Link with layer'),
  ],
  satin: [section('Structure'), blend(), color(), opacity(), angle(), px('distance', 'Distance', 1, 250), px('size', 'Size'), contour(), antiAlias(), check('invert', 'Invert')],
  colorOverlay: [blend(), color(), opacity()],
  gradientOverlay: [
    blend(), opacity(),
    { key: '__grad', label: 'Gradient', type: 'gradient' },
    button('Reset Alignment', 'reset-alignment', (set) => set('offset', [0, 0])),
  ],
  patternOverlay: [
    blend(), opacity(), { key: 'pattern', label: 'Pattern', type: 'pattern' },
    button('Snap to Origin', 'snap-origin', (set) => set('origin', [0, 0])),
    angle('angle', 'Angle'), pct('scale', 'Scale', 1, 1000), check('link', 'Link with layer'),
  ],
  stroke: [
    section('Structure'), px('size', 'Size', 1, 250),
    { key: 'position', label: 'Position', type: 'segment', options: [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']] },
    blend(), opacity(),
    fillChoice([['color', 'Color'], ['gradient', 'Gradient'], ['pattern', 'Pattern']]),
    color('color', 'Color', { when: isFill('color') }),
    { key: '__grad', label: 'Gradient', type: 'gradient', kinds: ['shape-burst'], when: isFill('gradient') },
    { key: 'pattern', label: 'Pattern', type: 'pattern', when: isFill('pattern') },
    pct('patternScale', 'Scale', 1, 1000, { when: isFill('pattern') }), angle('patternAngle', 'Angle', { when: isFill('pattern') }),
    check('link', 'Link with layer', { when: isFill('pattern') }),
  ],
};
// fields the form shows that are not effect fields (the gradient widgets, the bevel sub-pages)
const PSEUDO = new Set(['__grad', '__glowGrad', '__cs_contour', '__cs_aa', '__cs_range', '__tx_pattern', '__tx_scale', '__tx_depth', '__tx_invert', '__tx_link', '__tx_origin']);

/** The effect's gradient def (0.3's stops upgraded) without placement. */
function defOf(fx, fallbackColor = null) {
  if (fx.gradient && typeof fx.gradient === 'object') return stripPlacement(normalizeGradient(fx.gradient));
  if (Array.isArray(fx.stops)) return stripPlacement(normalizeGradient({ stops: fx.stops }));
  // a glow's default: its colour to transparent; a stroke's: black to white
  if (!fallbackColor) return stripPlacement(normalizeGradient({ stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }));
  return stripPlacement(normalizeGradient({ stops: [{ pos: 0, color: fallbackColor, opacity: 1 }, { pos: 1, color: fallbackColor, opacity: 0 }] }));
}
function stripPlacement(g) {
  const out = { ...g };
  for (const k of PLACEMENT_KEYS) delete out[k];
  return out;
}
const PLACEMENT_DEFAULTS = { kind: 'linear', angle: 90, scale: 1, offset: [0, 0], align: true, reverse: false, dither: false };

/** Form values of a page from its effect (the bevel's sub-pages read the bevel). */
function toForm(page, fx) {
  const v = {};
  const t = fx.texture && typeof fx.texture === 'object' ? fx.texture : {};
  const cs = fx.contourSub && typeof fx.contourSub === 'object' ? fx.contourSub : {};
  for (const f of EFFECT_FIELDS[page]) {
    if (!f.key) continue;
    const k = f.key;
    let val;
    if (k === '__grad') {
      val = { ...defOf(fx) };
      for (const [pk, d] of Object.entries(PLACEMENT_DEFAULTS)) val[pk] = clone(fx[pk] ?? d);
    } else if (k === '__glowGrad') val = { ...defOf(fx, fx.color), reverse: !!fx.reverse };
    else if (k === '__cs_contour') val = cs.contour ?? null;
    else if (k === '__cs_aa') val = !!cs.antiAlias;
    else if (k === '__cs_range') val = cs.range ?? 0.5;
    else if (k === '__tx_pattern') val = t.pattern ?? null;
    else if (k === '__tx_scale') val = t.scale ?? 1;
    else if (k === '__tx_depth') val = t.depth ?? 1;
    else if (k === '__tx_invert') val = !!t.invert;
    else if (k === '__tx_link') val = t.link !== false;
    else if (k === 'link') val = fx.link !== false;
    else if (k === 'knocksOut') val = fx.knocksOut !== false;
    else if (k === 'fill') val = fx.fill ?? 'color';
    else if (k === 'technique' && page !== 'bevel') val = fx.technique ?? 'softer';
    else if (k === 'contour' || k === 'glossContour') val = fx[k] ?? null;
    else if (k === 'noise' || k === 'jitter') val = fx[k] ?? 0;
    else if (k === 'range') val = fx.range ?? 0.5;
    else if (k === 'patternScale') val = fx.patternScale ?? 1;
    else if (k === 'patternAngle') val = fx.patternAngle ?? 0;
    else if (k === 'angle' && page === 'patternOverlay') val = fx.angle ?? 0;
    else val = fx[k] ?? (f.type === 'checkbox' ? false : f.value);
    if (PCT_KEYS.has(k) && typeof val === 'number') val = Math.round(val * 100);
    v[k] = val;
  }
  return v;
}

const contourValue = (c) => (!c || isLinearContour(c) ? null : clone(c));

/** The effect with a page's form values written into it. */
function fromForm(page, fx, values) {
  const out = { ...fx };
  const num = (k) => (PCT_KEYS.has(k) ? values[k] / 100 : values[k]);
  if (page === 'bevel-contour') {
    out.contourSub = { ...(fx.contourSub ?? {}), contour: contourValue(values.__cs_contour), antiAlias: !!values.__cs_aa, range: num('__cs_range') };
    return out;
  }
  if (page === 'bevel-texture') {
    const t = { ...(fx.texture ?? {}) };
    t.pattern = values.__tx_pattern ?? t.pattern ?? null;
    t.scale = num('__tx_scale');
    t.depth = num('__tx_depth');
    t.invert = !!values.__tx_invert;
    t.link = !!values.__tx_link;
    if (values.__tx_origin) t.origin = clone(values.__tx_origin);
    out.texture = t;
    return out;
  }
  for (const f of EFFECT_FIELDS[page]) {
    if (!f.key || PSEUDO.has(f.key)) continue;
    const k = f.key;
    if (k === 'contour' || k === 'glossContour') out[k] = contourValue(values[k]);
    else if (k === 'pattern') out.pattern = values.pattern ? clone(values.pattern) : fx.pattern ?? null;
    else out[k] = num(k);
  }
  if (values.offset !== undefined && (page === 'gradientOverlay')) out.offset = clone(values.offset);
  if (values.origin !== undefined && (page === 'patternOverlay' || page === 'stroke')) out.origin = clone(values.origin);
  const grad = values.__grad;
  if (grad && (page === 'gradientOverlay' || (page === 'stroke' && out.fill === 'gradient'))) {
    out.gradient = stripPlacement(grad);
    for (const pk of Object.keys(PLACEMENT_DEFAULTS)) if (grad[pk] !== undefined && pk !== 'offset') out[pk] = clone(grad[pk]);
    // 0.3's stops stay in step with the v2 colour stops, so Pigment 0.3 still shows the colours (G.1)
    if (page === 'gradientOverlay' && Array.isArray(out.gradient.stops)) out.stops = out.gradient.stops.filter((st) => typeof st.color === 'string').map((st) => ({ pos: st.pos, color: st.color }));
  }
  const glow = values.__glowGrad;
  if (glow && out.fill === 'gradient' && (page === 'outerGlow' || page === 'innerGlow')) {
    out.gradient = stripPlacement(glow);
    delete out.gradient.reverse;
    delete out.gradient.dither;
    out.reverse = !!glow.reverse;
  }
  return out;
}

/** True when some effect is on, Hide All Effects aside (the dialog keeps a hidden style). */
const anyEffectOn = (styles) => !!styles && hasEnabledStyles({ ...styles, hidden: false });
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const effectName = (key) => STYLE_KEYS.find((s) => s.key === key)?.name ?? key;

export { EFFECT_FIELDS };

export function install(app) {
  // lib/blending-options.js (layer-style-blending) decides which layers take styles
  const hasStyleable = () => isStyleable(app.doc?.active, app);
  // Blending Options also open on adjustment layers (their page alone: they take no effects, as in Photoshop)
  const takesBlending = () => takesBlendingOptions(app.doc?.active, app);
  const pages = new Map();
  app.layerStyle = {
    registerPage(page) {
      if (!page || typeof page.id !== 'string' || typeof page.render !== 'function') throw new Error('registerPage: a page needs an id and render()');
      pages.set(page.id, page);
    },
    pages: () => [...pages.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    globalLight: () => globalLightDialog(),
  };

  /** A PatternRef of the current pattern (L.6), or null. */
  const currentPatternRef = () => {
    const cur = app.patterns?.current?.();
    if (!cur?.canvas) return null;
    return app.patterns.ref?.(cur) ?? { dataUrl: patternFromCanvas(cur.canvas), name: cur.name };
  };

  async function styleDialog(initialKey = null, ctx = null) {
    const d = app.doc;
    const layer = d?.active;
    if (!layer || (layer.type === 'adjustment' && !takesBlendingOptions(layer, app))) return ctx?.cancel();
    // an adjustment layer: the Blending Options page only, and no effects are stored on it
    const adjustment = layer.type === 'adjustment';
    // actions (lib/actions.js): a recorded step is the dialog's result ({ styles, opacity?, fillOpacity?, blend? }) and applies without it
    // { key, index } opens the page of that effect instance (an effect row of the Layers panel)
    const opening = initialKey && typeof initialKey === 'object' && !('styles' in initialKey) && typeof initialKey.key === 'string' ? initialKey : null;
    if (initialKey && typeof initialKey === 'object' && !opening) {
      const { globalLight: gl, ...props } = clone(initialKey);
      if (adjustment) delete props.styles;
      if (!gl) return setLayerProps(app, layer, props, 'Layer style');
      const glWas = d.globalLight ?? null;
      return d.history.group('Layer style', () => {
        setLayerProps(app, layer, props, 'Layer style');
        recordGlobalLight(glWas, gl);
      });
    }
    const before = { styles: clone(layer.styles), opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend, blending: clone(layer.blending ?? null) };
    // the document's Global Light as the dialog opened: an Angle or Altitude typed while Use Global Light is on edits
    // it live (as Photoshop does), Cancel puts it back and OK records it with the style
    let glBefore = d.globalLight ?? null;
    const globalNow = () => d.globalLight ?? { angle: 120, altitude: 30 };
    const usesGlobal = (key, fx) => LIGHT_PAGES.has(key) && !!fx?.useGlobalLight;
    const merged = mergeStyles(layer.styles);
    // the draft: every key as a list of instances (top first), each merged with the key's defaults
    const draft = {};
    for (const { key } of STYLE_KEYS) draft[key] = effectInstances(merged, key);
    const hidden = typeof merged.hidden === 'boolean' ? merged.hidden : undefined;
    // pattern overlays default to the current pattern
    const po = draft.patternOverlay[0];
    if (!po.pattern) po.pattern = currentPatternRef();
    const stored = () => {
      const out = {};
      for (const { key } of STYLE_KEYS) out[key] = draft[key].length === 1 ? draft[key][0] : draft[key].slice(0, MAX_INSTANCES);
      if (hidden !== undefined) out.hidden = hidden;
      return out;
    };
    const pageList = app.layerStyle.pages().filter((pg) => !adjustment || pg.id === 'blending');
    const firstPage = pageList.some((pg) => pg.id === 'blending') ? 'blending' : pageList[0]?.id ?? null;
    // the selection: a page id, or an effect key with the instance index (the bevel's sub-pages too)
    const startKey = opening ? opening.key : initialKey;
    const startIndex = opening && Number.isInteger(opening.index) ? Math.max(0, opening.index) : 0;
    let current = startKey && draft[startKey] && !adjustment ? { key: startKey, index: Math.min(startIndex, draft[startKey].length - 1) } : firstPage ? { key: firstPage, index: 0 } : { key: STYLE_KEYS[0].key, index: 0 };

    // the page context (L.3): the pages edit opacity, fill opacity, blend and the advanced draft, then call apply()
    const ctx2 = {
      layer,
      styles: stored(),
      opacity: layer.opacity,
      fillOpacity: layer.fillOpacity,
      blend: layer.blend,
      advanced: clone(layer.blending ?? DEFAULT_BLENDING),
      apply: () => apply(),
      select: (id) => select({ key: id, index: 0 }),
      // the Global Light… button records its own step: what OK or Cancel compares with starts from there
      globalLight: () => globalLightDialog().then(() => {
        glBefore = d.globalLight ?? null;
        apply();
      }),
    };
    const apply = () => {
      const st = stored();
      ctx2.styles = st;
      layer.styles = adjustment ? before.styles : anyEffectOn(st) ? clone(st) : null;
      layer.opacity = ctx2.opacity;
      layer.fillOpacity = ctx2.fillOpacity;
      layer.blend = ctx2.blend;
      layer.blending = isDefaultBlending(ctx2.advanced) ? null : clone(ctx2.advanced);
      layer.touch();
      d.changed('props', { layer });
    };

    const root = document.createElement('div');
    root.className = 'style-root';
    root.style.display = 'flex';
    root.style.minHeight = '360px';
    const side = document.createElement('div');
    side.className = 'style-side';
    const list = document.createElement('div');
    list.className = 'style-list';
    const tools = document.createElement('div');
    tools.className = 'style-list-tools';
    side.append(list, tools);
    const pane = document.createElement('div');
    pane.className = 'style-pane';
    root.append(side, pane);

    const toolButton = (act, label, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small icon-btn';
      b.dataset.act = act;
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', () => instanceAction(act));
      tools.appendChild(b);
      return b;
    };
    const upBtn = toolButton('up', '▲', 'Move the effect up');
    const downBtn = toolButton('down', '▼', 'Move the effect down');
    const delBtn = toolButton('delete', '✕', 'Delete the effect');
    if (adjustment) tools.hidden = true;

    const isEffect = (key) => !!draft[key];
    const effectOf = (sel) => {
      if (sel.key === 'bevel-contour' || sel.key === 'bevel-texture') return draft.bevel[0];
      return draft[sel.key]?.[sel.index] ?? null;
    };

    const rows = [];
    const addRow = (sel, name, toggle = null, { sub = false, add = false } = {}) => {
      const label = document.createElement('label');
      label.dataset.style = sel.key;
      if (isEffect(sel.key)) label.dataset.index = String(sel.index);
      if (sub) label.classList.add('style-sub');
      if (toggle) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = toggle.get();
        cb.dataset.key = sel.index ? `enable-${sel.key}-${sel.index}` : `enable-${sel.key}`;
        cb.addEventListener('change', () => {
          toggle.set(cb.checked);
          apply();
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
        label.appendChild(cb);
      }
      const span = document.createElement('span');
      span.className = 'style-name';
      span.textContent = name;
      label.appendChild(span);
      if (add) {
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'style-add';
        plus.dataset.add = sel.key;
        plus.dataset.index = String(sel.index);
        plus.textContent = '+';
        plus.title = `Add another ${name}`;
        plus.setAttribute('aria-label', `Add another ${name}`);
        plus.disabled = draft[sel.key].length >= MAX_INSTANCES;
        plus.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          addInstance(sel.key, sel.index);
        });
        label.appendChild(plus);
      }
      label.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        select(sel);
      });
      list.appendChild(label);
      rows.push({ sel, label });
    };
    const buildList = () => {
      list.replaceChildren();
      rows.length = 0;
      for (const pg of pageList) addRow({ key: pg.id, index: 0 }, pg.title);
      if (adjustment) return markCurrent();
      for (const { key, name } of STYLE_KEYS) {
        draft[key].forEach((fx, index) => {
          addRow({ key, index }, name, { get: () => !!draft[key][index].enabled, set: (on) => (draft[key][index].enabled = on) }, { add: INSTANCE_KEYS.includes(key) });
        });
        if (key === 'bevel') {
          const bv = () => draft.bevel[0];
          addRow({ key: 'bevel-contour', index: 0 }, 'Contour', {
            get: () => !!bv().contourSub?.enabled,
            set: (on) => {
              bv().contourSub = { ...(bv().contourSub ?? {}), enabled: on };
              if (on) bv().enabled = true;
            },
          }, { sub: true });
          addRow({ key: 'bevel-texture', index: 0 }, 'Texture', {
            get: () => !!bv().texture?.enabled,
            set: (on) => {
              const t = { ...(bv().texture ?? {}), enabled: on };
              if (on && !t.pattern) t.pattern = currentPatternRef();
              bv().texture = t;
              if (on) bv().enabled = true;
            },
          }, { sub: true });
        }
      }
      markCurrent();
    };
    const markCurrent = () => {
      for (const r of rows) r.label.classList.toggle('current', r.sel.key === current.key && r.sel.index === current.index);
      const inst = INSTANCE_KEYS.includes(current.key);
      const n = inst ? draft[current.key].length : 0;
      upBtn.disabled = !inst || current.index === 0;
      downBtn.disabled = !inst || current.index >= n - 1;
      delBtn.disabled = !isEffect(current.key) || (!inst && !draft[current.key][0].enabled);
    };
    const syncChecks = () => {
      for (const r of rows) {
        const cb = r.label.querySelector('input[type=checkbox]');
        if (!cb) continue;
        if (r.sel.key === 'bevel-contour') cb.checked = !!draft.bevel[0].contourSub?.enabled;
        else if (r.sel.key === 'bevel-texture') cb.checked = !!draft.bevel[0].texture?.enabled;
        else if (draft[r.sel.key]?.[r.sel.index]) cb.checked = !!draft[r.sel.key][r.sel.index].enabled;
      }
    };

    // +: a copy of the instance, inserted above it (Photoshop's order), and selected
    const addInstance = (key, index) => {
      if (draft[key].length >= MAX_INSTANCES) return;
      const copy = clone(draft[key][index]);
      copy.enabled = true;
      draft[key].splice(index, 0, copy);
      apply();
      buildList();
      select({ key, index });
    };
    const instanceAction = (act) => {
      const { key, index } = current;
      if (!isEffect(key)) return;
      const list2 = draft[key];
      if (act === 'up' && index > 0) {
        [list2[index - 1], list2[index]] = [list2[index], list2[index - 1]];
        current = { key, index: index - 1 };
      } else if (act === 'down' && index < list2.length - 1) {
        [list2[index + 1], list2[index]] = [list2[index], list2[index + 1]];
        current = { key, index: index + 1 };
      } else if (act === 'delete') {
        if (list2.length > 1) {
          list2.splice(index, 1);
          current = { key, index: Math.min(index, list2.length - 1) };
        } else {
          // the last instance: the effect goes back to its defaults, switched off (its row stays)
          const pattern = key === 'patternOverlay' ? list2[0].pattern : undefined;
          list2[0] = { ...effectDefaults(key), enabled: false };
          if (pattern !== undefined) list2[0].pattern = pattern;
        }
      } else return;
      apply();
      buildList();
      select(current);
    };

    let drag = null;
    const select = (sel) => {
      if (!pages.has(sel.key) && !isEffect(sel.key) && sel.key !== 'bevel-contour' && sel.key !== 'bevel-texture') return;
      current = { key: sel.key, index: isEffect(sel.key) ? Math.min(sel.index ?? 0, draft[sel.key].length - 1) : 0 };
      markCurrent();
      pane.replaceChildren();
      const h = document.createElement('h3');
      h.style.margin = '0 0 10px';
      h.style.fontSize = '13px';
      const page = pages.get(current.key);
      const sub = { 'bevel-contour': 'Contour', 'bevel-texture': 'Texture' }[current.key];
      h.textContent = page ? page.title : sub ? `Bevel & Emboss: ${sub}` : effectName(current.key) + (draft[current.key].length > 1 ? ` (${current.index + 1} of ${draft[current.key].length})` : '');
      pane.appendChild(h);
      drag?.refresh();
      if (page) {
        try {
          const body = page.render(ctx2);
          if (body) pane.appendChild(body);
        } catch (err) {
          console.error(`Layer Style page ${current.key} failed`, err);
        }
        return;
      }
      const pageId = current.key;
      const fxKey = sub ? 'bevel' : current.key;
      const index = current.index;
      const values = toForm(pageId, effectOf(current));
      if (usesGlobal(pageId, effectOf(current))) {
        values.angle = globalNow().angle;
        if ('altitude' in values) values.altitude = globalNow().altitude;
      }
      const form = buildForm(EFFECT_FIELDS[pageId], {
        app,
        values,
        onChange: (v, changedKey) => {
          let fx = fromForm(pageId, draft[fxKey][index], v);
          if (usesGlobal(pageId, fx)) {
            // the fields show the global light, not the effect's own angle, which it keeps for when the box is unticked
            fx.angle = draft[fxKey][index].angle;
            if ('altitude' in v) fx.altitude = draft[fxKey][index].altitude;
            if (changedKey === 'angle' || changedKey === 'altitude') {
              // the global light moves, and every effect using it with it
              d.globalLight = { ...globalNow(), [changedKey]: v[changedKey] };
              d.changed('props'); // other layers' effects follow the light too
            } else if (changedKey === 'useGlobalLight') {
              form.set('angle', globalNow().angle, { silent: true });
              if ('altitude' in v) form.set('altitude', globalNow().altitude, { silent: true });
            }
          }
          // a pattern fill without a pattern takes the current one
          if (changedKey === 'fill' && fx.fill === 'pattern' && !fx.pattern) fx = { ...fx, pattern: currentPatternRef() };
          if (sub === 'Contour') fx.contourSub = { ...fx.contourSub, enabled: true };
          if (sub === 'Texture') fx.texture = { ...fx.texture, enabled: true, pattern: fx.texture.pattern ?? currentPatternRef() };
          fx.enabled = true;
          draft[fxKey][index] = fx;
          syncChecks();
          markCurrent();
          apply();
          // a button that sets a value the form does not show (Snap to Origin, Reset Alignment) consumes it
          if (changedKey === 'origin' || changedKey === 'offset' || changedKey === '__tx_origin') delete v[changedKey];
        },
      });
      pane.appendChild(form.element);
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn small';
      reset.dataset.act = 'reset';
      reset.style.marginTop = '12px';
      reset.textContent = 'Reset to default';
      reset.addEventListener('click', () => {
        const old = draft[fxKey][index];
        let fresh = effectDefaults(fxKey);
        if (sub === 'Contour') fresh = { ...old, contourSub: { ...effectDefaults('bevel').contourSub, enabled: !!old.contourSub?.enabled } };
        else if (sub === 'Texture') fresh = { ...old, texture: { ...effectDefaults('bevel').texture, enabled: !!old.texture?.enabled, pattern: old.texture?.pattern ?? null } };
        else {
          fresh.enabled = old.enabled;
          if (fxKey === 'patternOverlay') fresh.pattern = old.pattern;
          if (fxKey === 'bevel') {
            fresh.contourSub = old.contourSub;
            fresh.texture = old.texture;
          }
        }
        draft[fxKey][index] = fresh;
        apply();
        select(current);
      });
      pane.appendChild(reset);
    };
    buildList();

    const opened = app.dialogs.open({
      title: 'Layer Style',
      content: root,
      width: 700,
      className: 'style-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
      onOpen: (dialogEl) => {
        // dragging in the document places the shown effect (lib/style-canvas-drag.js)
        drag = armStyleDrag(app, dialogEl, {
          layer,
          page: () => {
            const fx = DRAGGABLE.has(current.key) ? effectOf(current) : null;
            if (!fx) return null;
            // a drag starts from the shadow as drawn: with Use Global Light, at the global angle
            return { key: current.key, fx: usesGlobal(current.key, fx) ? { ...fx, angle: globalNow().angle } : fx };
          },
          update: (key, patch, { done = false } = {}) => {
            const fxKey = key === 'bevel-texture' ? 'bevel' : key;
            const index = key === 'bevel-texture' ? 0 : current.index;
            draft[fxKey][index] = { ...draft[fxKey][index], ...patch, enabled: true };
            if (key === 'bevel-texture') draft.bevel[0].texture = { ...draft.bevel[0].texture, enabled: true };
            apply();
            if (done) {
              syncChecks();
              select(current);
            }
          },
        });
      },
    });
    select(current);
    const ok = await opened;
    drag?.release();
    const after = { styles: layer.styles ? clone(layer.styles) : null, opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend, blending: clone(layer.blending ?? null) };
    Object.assign(layer, { styles: before.styles, opacity: before.opacity, fillOpacity: before.fillOpacity, blend: before.blend, blending: before.blending });
    layer.touch();
    const glAfter = d.globalLight ?? null;
    const glChanged = !sameJson(glAfter, glBefore);
    d.globalLight = glBefore;
    if (glChanged && !ok) d.changed('props');
    if (ok && glChanged) {
      d.history.group('Layer style', () => {
        setLayerProps(app, layer, after, 'Layer style');
        recordGlobalLight(glBefore, glAfter);
      });
    } else if (ok) setLayerProps(app, layer, after, 'Layer style');
    else d.changed('props', { layer });
    // actions (lib/actions.js): the styles always replay; opacity, blend mode and the blending options only when the
    // dialog changed them
    if (ok) ctx?.setReplayArg({ ...Object.fromEntries(Object.entries(after).filter(([k, v]) => k === 'styles' || (k === 'blending' ? !sameJson(v, before.blending) : v !== before[k]))), ...(glChanged ? { globalLight: clone(glAfter) } : {}) });
    else ctx?.cancel();
  }

  async function globalLightDialog(arg = null, ctx = null) {
    const d = app.doc;
    if (!d) return;
    const gl = d.globalLight ?? { angle: 120, altitude: 30 };
    // actions (lib/actions.js): a recorded { angle, altitude } skips the dialog
    const o = Number.isFinite(arg?.angle) && Number.isFinite(arg?.altitude) ? arg : await formDialog(app, {
      title: 'Global Light',
      fields: [S('angle', 'Angle', -180, 180, 1, { unit: '°', value: gl.angle }), S('altitude', 'Altitude', 0, 90, 1, { unit: '°', value: gl.altitude })],
      live: {
        apply: (v) => {
          d.globalLight = { angle: v.angle, altitude: v.altitude };
          d.changed('props');
        },
        revert: () => {
          d.globalLight = gl;
          d.changed('props');
        },
      },
    });
    if (!o) return ctx?.cancel?.(); // actions (lib/actions.js)
    const after = { angle: o.angle, altitude: o.altitude };
    ctx?.setReplayArg?.(after); // actions (lib/actions.js)
    recordGlobalLight(gl, after);
  }

  /** Sets the document's Global Light to `after` as one undoable step back to `before`. */
  function recordGlobalLight(before, after) {
    const d = app.doc;
    const set = (v) => {
      d.globalLight = v;
      d.changed('props');
    };
    set(after);
    d.history.push({ label: 'Global light', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
  }

  function toggleEffect(key) {
    const layer = app.doc?.active;
    if (!layer || !STYLE_KEYS.some((s) => s.key === key)) return;
    const styles = mergeStyles(layer.styles);
    const list = effectInstances(styles, key);
    // any instance on: all off; none on: the first one on
    const on = !list.some((fx) => fx.enabled);
    if (on) list[0].enabled = true;
    else for (const fx of list) fx.enabled = false;
    setLayerProps(app, layer, { styles: anyEffectOn(styles) ? styles : null }, `${on ? 'Add' : 'Hide'} ${effectName(key)}`);
  }

  app.layerStyleMenu = () => {
    const layer = app.doc?.active;
    const on = (k) => effectInstances(layer?.styles, k).some((fx) => fx.enabled);
    const styleCommands = [
      { label: 'Copy Layer Style', disabled: !app.commands.isEnabled('layer:copy-style'), onSelect: () => app.commands.run('layer:copy-style', undefined, 'panel') },
      { label: 'Paste Layer Style', disabled: !app.commands.isEnabled('layer:paste-style'), onSelect: () => app.commands.run('layer:paste-style', undefined, 'panel') },
      { label: 'Clear Layer Style', disabled: !app.commands.isEnabled('layer:clear-style'), onSelect: () => app.commands.run('layer:clear-style', undefined, 'panel') },
    ];
    // an adjustment layer takes Blending Options but no effects (Photoshop shows no effects for it either)
    if (layer?.type === 'adjustment') {
      return [{ label: 'Blending Options…', disabled: !takesBlending(), onSelect: () => app.commands.run('layer:style', 'dialog', 'panel') }, { type: 'separator' }, ...styleCommands];
    }
    return [
      { label: 'Blending Options…', onSelect: () => app.commands.run('layer:style', 'dialog', 'panel') },
      { type: 'separator' },
      ...STYLE_KEYS.map(({ key, name }) => ({ label: `${name}…`, checked: on(key), onSelect: () => styleDialog(key) })),
      { type: 'separator' },
      ...styleCommands,
      { label: 'Rasterize Layer Style', disabled: !layer?.styles, onSelect: () => app.commands.run('layer:rasterize-style', undefined, 'panel') },
      { label: 'Global Light…', onSelect: globalLightDialog },
    ];
  };

  app.commands.registerAll({
    'layer:style': {
      enabled: takesBlending,
      dialog: true, // actions (lib/actions.js)
      run: (kind, ctx) => {
        if (!kind || kind === 'dialog') return styleDialog(null, ctx);
        if (typeof kind === 'object' || (typeof kind === 'string' && STYLE_KEYS.some((s) => s.key === kind))) return styleDialog(kind, ctx);
      },
    },
    'layer:style-toggle': { enabled: hasStyleable, run: (key) => toggleEffect(key) },
    'layer:global-light': { enabled: () => !!app.doc, dialog: true, run: globalLightDialog }, // actions (lib/actions.js)
  });
  for (const { key, name } of STYLE_KEYS) app.commands.register(`layer:style-${key}`, { enabled: hasStyleable, dialog: true, run: (arg, ctx) => styleDialog(arg && typeof arg === 'object' ? arg : key, ctx), label: `${name}…` }); // actions (lib/actions.js)
}
