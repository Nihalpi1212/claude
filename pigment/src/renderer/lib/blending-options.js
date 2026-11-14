// Layer Style > Blending Options (Pigment 0.4, layer-style-blending; ARCHITECTURE.md "0.4 features", L.3, K.3, E13):
// the page of the Layer Style dialog (General Blending, Advanced Blending: fill opacity, channels, knockout and the
// five check boxes, Blend If with split sliders), isStyleable (groups take styles, the Background does not), and the
// Layer > Layer Style commands Create Layers, Hide All Effects / Show All Effects and Scale Effects.
//
// The page edits the dialog's draft (ctx.opacity, ctx.fillOpacity, ctx.blend 0..1, ctx.advanced: the draft of
// layer.blending) and calls ctx.apply(); style-ui.js previews it live, restores it on Cancel and commits it on OK
// with the effects in one history entry. The compositor renders it (compositor.js finishAdvanced, K.3).
import { BLEND_MODES, DEFAULT_BLENDING, RasterLayer, createCanvas, effectiveBlending } from './document.js';
import { buildForm, formDialog } from './form.js';
import { setLayerProps, setLayersProps, structural } from './layer-ops.js';
import { Compositor } from './compositor.js';
import { maskCanvasFor, applyLayerMask, hasEffectiveMask } from './mask-render.js';
import { prepareStyles } from './style-prepare.js';
import { hasEnabledStyles, splitEffects, scaleEffects } from '../../shared/pixels/styles.js';
import { normalizeRange, maskPartsAround, restrictsChannels, BLEND_IF_CHANNELS } from '../../shared/pixels/blend-if.js';

const BLENDS = BLEND_MODES.filter(Boolean);
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const check = (key, label) => ({ key, label, type: 'checkbox' });
const section = (label) => ({ type: 'section', label });
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

let appRef = null;

/**
 * True when the Layer Style dialog may open on the layer: raster, text, shape, fill, smart object and group layers,
 * and not a layer whose Background rules lock its styles (L.13). Adjustment layers take Blending Options but no
 * effects, as in Photoshop: they count only with `{ page: 'blending' }` (the dialog, which then shows that page
 * alone, Blending Options… and Copy, Paste and Clear Layer Style).
 * @param {object} layer
 * @param {object} [app]
 * @param {{ page?: 'effects' | 'blending' }} [opts]
 */
export function isStyleable(layer, app = appRef, { page = 'effects' } = {}) {
  if (!layer || !layer.parent) return false;
  if (layer.type === 'adjustment' && page !== 'blending') return false;
  const locked = app?.backgroundRules?.lockedProps?.(layer) ?? [];
  return !locked.includes('styles');
}

/** True when the layer takes Blending Options (the Layer Style dialog): what isStyleable allows, adjustment layers too. */
export const takesBlendingOptions = (layer, app = appRef) => isStyleable(layer, app, { page: 'blending' });

/** True when some effect of the styles is switched on, whether Hide All Effects is on or not. */
export function hasEffects(styles) {
  return !!styles && typeof styles === 'object' && hasEnabledStyles({ ...styles, hidden: false });
}

/** The draft made complete: every field of DEFAULT_BLENDING present (partial stored options read as defaults). */
function completeDraft(adv) {
  const d = DEFAULT_BLENDING;
  for (const k of Object.keys(d)) if (adv[k] === undefined) adv[k] = clone(d[k]);
  adv.channels = { ...d.channels, ...(adv.channels ?? {}) };
  const bi = adv.blendIf && typeof adv.blendIf === 'object' ? adv.blendIf : {};
  for (const c of BLEND_IF_CHANNELS) {
    const s = bi[c] ?? {};
    bi[c] = { this: normalizeRange(s.this), under: normalizeRange(s.under) };
  }
  adv.blendIf = bi;
  return adv;
}

const CHANNEL_LABELS = { gray: 'Gray', r: 'Red', g: 'Green', b: 'Blue' };
const BAR_COLORS = { gray: ['#000', '#fff'], r: ['#000', '#f00'], g: ['#000', '#0f0'], b: ['#000', '#00f'] };

/**
 * The Blend If control: a channel menu and two split sliders (This Layer, Underlying Layer). Each slider has a black
 * and a white pair of halves; dragging a pair moves both halves, Alt-dragging (or dragging a pair already split)
 * moves one half, so the layer fades between them. Arrow keys move the focused half (Shift: 10 levels; Alt splits).
 * The number boxes show and set the four values of each slider.
 */
function blendIfControl(adv, apply) {
  const root = document.createElement('div');
  root.className = 'bif';
  let channel = 'gray';
  const head = document.createElement('div');
  head.className = 'bif-head';
  const label = document.createElement('label');
  label.textContent = 'Blend If';
  const select = document.createElement('select');
  select.className = 'select';
  select.dataset.key = 'blendIfChannel';
  for (const c of BLEND_IF_CHANNELS) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = CHANNEL_LABELS[c];
    select.appendChild(o);
  }
  label.htmlFor = select.id = `bif-ch-${Math.random().toString(36).slice(2, 8)}`;
  head.append(label, select);
  root.appendChild(head);
  const rows = [];
  for (const which of ['this', 'under']) {
    const row = document.createElement('div');
    row.className = 'bif-row';
    row.dataset.which = which;
    const title = document.createElement('div');
    title.className = 'bif-title';
    title.textContent = which === 'this' ? 'This Layer' : 'Underlying Layer';
    const nums = document.createElement('div');
    nums.className = 'bif-nums';
    const inputs = [0, 1, 2, 3].map((i) => {
      const n = document.createElement('input');
      n.type = 'number';
      n.className = 'input bif-num';
      n.min = '0';
      n.max = '255';
      n.step = '1';
      n.dataset.key = `${which}-${i}`;
      n.dataset.numeric = '';
      n.setAttribute('aria-label', `${title.textContent} ${['black left', 'black right', 'white left', 'white right'][i]} value`);
      n.addEventListener('change', () => {
        const v = Number(n.value);
        if (!Number.isFinite(v)) return sync();
        const r = range(which).slice();
        r[i] = v;
        // typing one half of an unsplit pair moves the other with it unless that would reorder them
        setRange(which, normalizeRange(r));
      });
      nums.appendChild(n);
      return n;
    });
    const bar = document.createElement('div');
    bar.className = 'bif-bar';
    const track = document.createElement('div');
    track.className = 'bif-track';
    bar.appendChild(track);
    const handles = [0, 1, 2, 3].map((i) => {
      const h = document.createElement('div');
      h.className = `bif-handle ${i < 2 ? 'black' : 'white'} ${i % 2 ? 'right' : 'left'}`;
      h.dataset.i = String(i);
      h.tabIndex = 0;
      h.setAttribute('role', 'slider');
      h.setAttribute('aria-valuemin', '0');
      h.setAttribute('aria-valuemax', '255');
      h.setAttribute('aria-label', `${title.textContent} ${i < 2 ? 'black' : 'white'} slider${i % 2 ? ' (right half)' : ' (left half)'}`);
      bar.appendChild(h);
      return h;
    });
    row.append(title, nums, bar);
    root.appendChild(row);
    rows.push({ which, inputs, bar, track, handles });

    // dragging: the pair moves together until split; Alt splits it (the half on the side the pointer moves to)
    bar.addEventListener('pointerdown', (e) => {
      const hit = e.target.closest('.bif-handle');
      if (!hit) return;
      e.preventDefault();
      const i = Number(hit.dataset.i);
      const pair = i < 2 ? [0, 1] : [2, 3];
      const start = range(which).slice();
      const split = start[pair[0]] !== start[pair[1]];
      const box = bar.getBoundingClientRect();
      const x0 = e.clientX;
      let half = split || e.altKey ? i : null;
      bar.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const delta = Math.round(((ev.clientX - x0) / Math.max(1, box.width)) * 255);
        const r = start.slice();
        if (half === null && (ev.altKey || e.altKey) && delta !== 0) half = delta > 0 ? pair[1] : pair[0];
        if (half === null) {
          r[pair[0]] = start[pair[0]] + delta;
          r[pair[1]] = start[pair[1]] + delta;
          // a pair moved as one keeps its width at the ends
          const lo = Math.min(r[pair[0]], r[pair[1]]), hi = Math.max(r[pair[0]], r[pair[1]]);
          const shift = lo < 0 ? -lo : hi > 255 ? 255 - hi : 0;
          r[pair[0]] += shift;
          r[pair[1]] += shift;
        } else {
          r[half] = start[half] + delta;
          // a half cannot pass its partner: it pushes nothing, it stops
          if (half === pair[0]) r[half] = Math.min(r[half], r[pair[1]]);
          else r[half] = Math.max(r[half], r[pair[0]]);
        }
        setRange(which, normalizeRange(r));
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('keydown', (e) => {
      const hit = e.target.closest('.bif-handle');
      if (!hit || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(hit.dataset.i);
      const pair = i < 2 ? [0, 1] : [2, 3];
      const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1);
      const r = range(which).slice();
      const split = r[pair[0]] !== r[pair[1]];
      if (split || e.altKey) r[i] += d;
      else {
        r[pair[0]] += d;
        r[pair[1]] += d;
      }
      setRange(which, normalizeRange(r));
    });
  }
  select.addEventListener('change', () => {
    channel = select.value;
    sync();
  });

  const range = (which) => adv.blendIf[channel][which];
  const setRange = (which, r) => {
    adv.blendIf[channel] = { ...adv.blendIf[channel], [which]: r };
    sync();
    apply();
  };
  function sync() {
    const [c0, c1] = BAR_COLORS[channel];
    for (const { which, inputs, track, handles } of rows) {
      const r = range(which);
      track.style.background = `linear-gradient(to right, ${c0}, ${c1})`;
      inputs.forEach((n, i) => {
        if (document.activeElement !== n) n.value = String(r[i]);
      });
      handles.forEach((h, i) => {
        h.style.left = `${(r[i] / 255) * 100}%`;
        h.setAttribute('aria-valuenow', String(r[i]));
        // an unsplit pair shows as one handle
        const pair = i < 2 ? [0, 1] : [2, 3];
        h.classList.toggle('joined', r[pair[0]] === r[pair[1]]);
      });
    }
  }
  sync();
  return root;
}

/** The page spec registered with app.layerStyle.registerPage. */
export const blendingPage = {
  id: 'blending',
  title: 'Blending Options',
  order: 0,
  render(ctx) {
    const adv = completeDraft(ctx.advanced);
    const wrap = document.createElement('div');
    wrap.className = 'blending-page';
    const isGroup = !!ctx.layer.isGroup;
    // an adjustment layer has no pixels or effects of its own: knockout and the five check boxes act on those, so
    // its page is the blend mode, Opacity, Fill, the channels and Blend If (Photoshop's page for it)
    const adjustment = ctx.layer.type === 'adjustment';
    const values = {
      blend: ctx.blend,
      opacity: Math.round(ctx.opacity * 100),
      fillOpacity: Math.round(ctx.fillOpacity * 100),
      knockout: adv.knockout,
      interiorAsGroup: !!adv.interiorAsGroup,
      clippedAsGroup: adv.clippedAsGroup !== false,
      transparencyShapes: adv.transparencyShapes !== false,
      maskHidesEffects: !!adv.maskHidesEffects,
      vectorMaskHidesEffects: !!adv.vectorMaskHidesEffects,
    };
    const form = buildForm(
      [
        section('General Blending'),
        { key: 'blend', label: 'Blend mode', type: 'select', options: isGroup ? [['pass-through', 'Pass Through'], ...BLENDS] : BLENDS },
        S('opacity', 'Opacity', 0, 100, 1, { unit: '%' }),
        section('Advanced Blending'),
        S('fillOpacity', 'Fill opacity', 0, 100, 1, { unit: '%' }),
        { type: 'custom', label: 'Channels', render: () => channelBoxes(adv, () => ctx.apply()) },
        ...(adjustment ? [] : [
          { key: 'knockout', label: 'Knockout', type: 'select', options: [['none', 'None'], ['shallow', 'Shallow'], ['deep', 'Deep']] },
          check('interiorAsGroup', 'Blend Interior Effects as Group'),
          check('clippedAsGroup', 'Blend Clipped Layers as Group'),
          check('transparencyShapes', 'Transparency Shapes Layer'),
          check('maskHidesEffects', 'Layer Mask Hides Effects'),
          check('vectorMaskHidesEffects', 'Vector Mask Hides Effects'),
        ]),
      ],
      {
        app: appRef,
        values,
        onChange: (v) => {
          ctx.blend = v.blend;
          ctx.opacity = v.opacity / 100;
          ctx.fillOpacity = v.fillOpacity / 100;
          if (!adjustment) {
            adv.knockout = v.knockout;
            for (const k of ['interiorAsGroup', 'clippedAsGroup', 'transparencyShapes', 'maskHidesEffects', 'vectorMaskHidesEffects']) adv[k] = !!v[k];
          }
          ctx.apply();
        },
      },
    );
    wrap.appendChild(form.element);
    wrap.appendChild(blendIfControl(adv, () => ctx.apply()));
    // the Global Light is for effects
    if (adjustment) return wrap;
    const gl = document.createElement('button');
    gl.type = 'button';
    gl.className = 'btn small';
    gl.dataset.act = 'global-light';
    gl.style.marginTop = '12px';
    gl.textContent = 'Global Light…';
    gl.addEventListener('click', () => ctx.globalLight?.());
    wrap.appendChild(gl);
    return wrap;
  },
};

/** The three channel check boxes on one row (the form's own check boxes take a row each); they edit the draft. */
function channelBoxes(adv, apply) {
  const row = document.createElement('div');
  row.className = 'blend-channels';
  for (const [c, name] of [['r', 'R'], ['g', 'G'], ['b', 'B']]) {
    const label = document.createElement('label');
    label.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.key = `channel-${c}`;
    input.checked = adv.channels[c] !== false;
    input.addEventListener('change', () => {
      adv.channels = { ...adv.channels, [c]: input.checked };
      apply();
    });
    label.append(input, document.createTextNode(name));
    row.appendChild(label);
  }
  return row;
}

// ---- Layer > Layer Style commands --------------------------------------------------------------------------------

/** The styles with Hide All Effects on or off (the key is dropped when off, as 0.3 files have none). */
function withHidden(styles, hidden) {
  const out = { ...styles };
  if (hidden) out.hidden = true;
  else delete out.hidden;
  return out;
}

/**
 * The pixels the layer's effects are computed from, as the compositor uses them (the layer alone, a group's
 * children over their whole content, the mask parts that apply before the effects): { canvas, x, y } or null.
 */
function effectSource(layer, doc) {
  const comp = new Compositor();
  const src = layer.isGroup ? comp.styledGroupSource(layer, doc, {}) : comp.layerSource(layer);
  if (!src) return null;
  let canvas = src.canvas;
  const parts = maskPartsAround(effectiveBlending(layer));
  if (parts.before && hasEffectiveMask(layer, parts.before)) canvas = applyLayerMask(canvas, src.x, src.y, layer, doc, { parts: parts.before }); // mask (K.1)
  return { canvas, x: src.x, y: src.y, after: parts.after };
}

/** One RasterLayer per effect part in stacking order, bottom first: { layer, interior } (interior parts clip to the base). */
function effectLayers(layer, doc) {
  const src = effectSource(layer, doc);
  if (!src) return [];
  const bl = effectiveBlending(layer);
  const img = src.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.canvas.width, src.canvas.height);
  const { styles } = prepareStyles(layer, doc);
  const gl = doc.globalLight ?? { angle: 120, altitude: 30 };
  const parts = splitEffects(img, styles, {
    fillOpacity: layer.fillOpacity ?? 1, globalAngle: gl.angle, globalAltitude: gl.altitude,
    interiorAsGroup: !!bl.interiorAsGroup, transparencyShapes: bl.transparencyShapes !== false,
    origin: [src.x, src.y], docWidth: doc.width, docHeight: doc.height,
  });
  // the mask parts whose "hides effects" box is on also hid the exterior effects: baked into them
  const afterMask = src.after ? maskCanvasFor(layer, doc, { purpose: 'bake', parts: src.after }) : null; // mask (K.1)
  return parts.map((p) => {
    const canvas = createCanvas(Math.max(1, p.image.width), Math.max(1, p.image.height));
    const g = canvas.getContext('2d');
    g.putImageData(new ImageData(new Uint8ClampedArray(p.image.data), p.image.width, p.image.height), 0, 0);
    const x = src.x + p.x, y = src.y + p.y;
    if (afterMask && !p.clip) {
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(afterMask, -x, -y);
    }
    // exterior parts are drawn at the layer's opacity in the merged render; clipped parts get it through their base
    const opacity = Math.max(0, Math.min(1, (p.opacity ?? 1) * (p.clip ? 1 : layer.opacity ?? 1)));
    // the channel restriction also applied to the exterior effects (clipped parts get it through their base)
    const blending = !p.clip && restrictsChannels(bl.channels) ? { channels: { ...bl.channels } } : null;
    const made = new RasterLayer({ name: `${layer.name}'s ${p.name ?? p.key}`, canvas, x, y, blend: p.blend ?? 'normal', opacity, clip: p.clip || !!layer.clip, blending });
    return { layer: made, interior: !!p.clip };
  });
}

/**
 * True when the created layers cannot draw what the effects drew: Photoshop then warns "Some aspects of the Effects
 * cannot be reproduced with layers". Knockout reaches through the new layers; the layer's opacity faded the layer and
 * its exterior effects as one (each new layer is faded on its own, and a shadow knocked out by the layer shows through
 * it); fill opacity faded the layer under its interior effects. The modes are no reason: each exterior effect blends
 * with the layers below in its own mode and the layer's content in the layer's, which the new layers do as well.
 */
function inexactLayers(layer, made) {
  const bl = effectiveBlending(layer);
  const exterior = made.some((m) => !m.interior), interior = made.some((m) => m.interior);
  if (bl.knockout === 'shallow' || bl.knockout === 'deep') return true;
  if (exterior && (layer.opacity ?? 1) < 1) return true;
  return interior && (layer.fillOpacity ?? 1) < 1;
}

export function install(app) {
  appRef = app;
  app.layerStyle?.registerPage(blendingPage);
  const doc = () => app.doc;
  const active = () => doc()?.active ?? null;
  const styledActive = () => {
    const l = active();
    return !!l && isStyleable(l, app) && hasEffects(l.styles);
  };

  app.commands.registerAll({
    // Layer > Layer Style > Create Layers: each effect becomes a layer (exterior below, interior clipped above)
    'layer:style-create-layers': {
      enabled: () => {
        const l = active();
        return !!l && isStyleable(l, app) && hasEnabledStyles(l.styles);
      },
      run: () => {
        const d = doc();
        const layer = d.active;
        return app.busy('Creating layers…', () => {
          const made = effectLayers(layer, d);
          if (!made.length) {
            app.dialogs?.toast?.('The effects draw nothing to make layers from', { timeout: 1600 });
            return;
          }
          d.history.group('Create layers', () => {
            setLayerProps(app, layer, { styles: null });
            structural(app, 'Create layers', () => {
              const parent = layer.parent;
              let i = parent.children.indexOf(layer);
              // exterior parts go under the base in order; interior parts right above it, under its other clipped layers
              for (const m of made) if (!m.interior) d.add(m.layer, parent, i++);
              let j = i + 1;
              for (const m of made) if (m.interior) d.add(m.layer, parent, j++);
              d.setActive(layer);
            });
          });
          if (inexactLayers(layer, made)) app.dialogs?.toast?.('Some aspects of the effects cannot be reproduced with layers, so the image may change', { timeout: 4000 });
          return made.length;
        });
      },
    },
    // Layer > Layer Style > Hide All Effects / Show All Effects (the label follows uiState.effectsHidden)
    'layer:style-toggle-all': {
      enabled: styledActive,
      run: (arg, ctx) => {
        const d = doc();
        const lead = d.active;
        const hide = typeof arg?.hidden === 'boolean' ? arg.hidden : typeof arg === 'boolean' ? arg : !lead.styles?.hidden;
        const layers = (d.selectedLayers?.() ?? [lead]).filter((l) => hasEffects(l.styles) && isStyleable(l, app));
        if (!layers.includes(lead)) layers.push(lead);
        ctx?.setReplayArg?.({ hidden: hide }); // actions (lib/actions.js)
        setLayersProps(app, layers, (l) => ({ styles: withHidden(l.styles, hide) }), hide ? 'Hide all effects' : 'Show all effects');
      },
    },
    // Layer > Layer Style > Scale Effects…: sizes, distances, spreads and pattern scales times the factor
    'layer:style-scale': {
      enabled: styledActive,
      dialog: true, // actions (lib/actions.js)
      run: async (arg, ctx) => {
        const d = doc();
        const layer = d.active;
        const before = clone(layer.styles);
        const given = Number.isFinite(arg) ? arg : Number.isFinite(arg?.scale) ? arg.scale : null;
        const set = (styles) => {
          layer.styles = styles;
          layer.touch();
          d.changed('props', { layer });
        };
        const o = given !== null ? { scale: given } : await formDialog(app, {
          title: 'Scale Layer Effects',
          fields: [S('scale', 'Scale', 1, 1000, 1, { unit: '%', value: 100 })],
          live: { apply: (v) => set(scaleEffects(clone(before), v.scale / 100)), revert: () => set(clone(before)) },
        });
        if (!o || !Number.isFinite(o.scale)) return ctx?.cancel?.(); // actions (lib/actions.js)
        const k = Math.max(1, Math.min(1000, o.scale)) / 100;
        set(clone(before));
        ctx?.setReplayArg?.({ scale: k * 100 }); // actions (lib/actions.js)
        setLayerProps(app, layer, { styles: scaleEffects(clone(before), k) }, 'Scale effects');
      },
    },
  });
}
