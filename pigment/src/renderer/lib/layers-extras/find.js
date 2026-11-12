// Select › Find Layers (the filter bar at the top of the Layers panel) and Select › Isolate Layers.
// Both are views, not edits: nothing in the document changes and nothing is recorded in history.
//
//  - app.layerFilter(layer) -> true | false | null is the one hook lib/panels/layers.js consults for
//    every row (null: no filtering at all).
//  - Isolation also hides the other layers on the canvas. The view's compositor is left alone (exports,
//    thumbnails and saves keep seeing the whole document): the canvas view's postProcess hook (the one
//    Proof Colors uses) is handed a composite of the isolated layers to draw instead.
import { BLEND_MODES, canvasIsBlank } from '../document.js';
import { Compositor } from '../compositor.js';
import { STYLE_KEYS } from '../../../shared/pixels/styles.js';
import { icon } from '../icons.js';
import { debounce } from '../form.js';
import { LABEL_COLORS, labelOf } from './tags.js';

export const FILTER_TYPES = [['kind', 'Kind'], ['name', 'Name'], ['effect', 'Effect'], ['mode', 'Mode'], ['attribute', 'Attribute'], ['color', 'Color']];
export const KINDS = [
  ['pixel', 'Pixel layers', 'image'],
  ['adjustment', 'Adjustment and fill layers', 'adjust'],
  ['type', 'Type layers', 'text'],
  ['shape', 'Shape layers', 'shape'],
  ['smart', 'Smart objects', 'smart'],
];
export const ATTRIBUTES = [
  ['visible', 'Visible'], ['hidden', 'Not visible'], ['locked', 'Locked'], ['empty', 'Empty'], ['linked', 'Linked'], ['clipped', 'Clipped'], ['mask', 'Layer mask'], ['effects', 'Layer effects'],
];

/** The Find Layers kind of a layer (groups have none: they show when something inside them matches). */
export function kindOf(layer) {
  switch (layer.type) {
    case 'raster': return 'pixel';
    case 'adjustment':
    case 'fill': return 'adjustment';
    case 'text': return 'type';
    case 'shape': return 'shape';
    case 'smart': return 'smart';
    default: return null;
  }
}

const emptyCache = new WeakMap(); // raster layer -> { version, canvas, empty }
function isEmpty(layer) {
  if (layer.isGroup) return !layer.children.length;
  if (layer.type !== 'raster') return false;
  const c = emptyCache.get(layer);
  if (c && c.version === layer.version && c.canvas === layer.canvas) return c.empty;
  const empty = canvasIsBlank(layer.canvas);
  emptyCache.set(layer, { version: layer.version, canvas: layer.canvas, empty });
  return empty;
}

/** Does the layer itself satisfy the filter (no tree logic)? */
export function matchesFilter(layer, f) {
  switch (f.type) {
    case 'kind': return !f.kinds.length || f.kinds.includes(kindOf(layer));
    case 'name': return !f.name.trim() || layer.name.toLowerCase().includes(f.name.trim().toLowerCase());
    case 'effect': return !!layer.styles?.[f.effect]?.enabled;
    case 'mode': return layer.blend === f.mode;
    case 'color': return labelOf(layer) === f.color;
    case 'attribute':
      switch (f.attribute) {
        case 'visible': return layer.visible;
        case 'hidden': return !layer.visible;
        case 'locked': return !!(layer.locked.all || layer.locked.pixels || layer.locked.position || layer.locked.transparency);
        case 'empty': return isEmpty(layer);
        case 'linked': return !!layer.linked;
        case 'clipped': return !!layer.clip;
        case 'mask': return !!layer.mask;
        case 'effects': return !!layer.styles && Object.values(layer.styles).some((s) => s?.enabled);
        default: return true;
      }
    default: return true;
  }
}

const hasAncestor = (layer, test) => {
  for (let p = layer.parent; p; p = p.parent) if (test(p)) return true;
  return false;
};
const hasDescendant = (group, test) => group.isGroup && group.children.some((c) => test(c) || hasDescendant(c, test));

export function installFind(app) {
  const filter = { on: false, shown: false, type: 'kind', kinds: [], name: '', effect: STYLE_KEYS[0].key, mode: 'normal', attribute: 'visible', color: 'red' };
  const isolation = new WeakMap(); // Document -> { ids: Set<layer id>, known: Set<layer id> }
  app.ui.layerFilter = filter;

  const iso = (d = app.doc) => (d ? isolation.get(d) ?? null : null);
  const inIso = (state, layer) => state.ids.has(layer.id) || hasAncestor(layer, (p) => state.ids.has(p.id));
  /** Rows (and layers on the canvas) an isolation keeps: the isolated layers, what is inside them and the groups around them. */
  const isoShows = (state, layer) => inIso(state, layer) || hasDescendant(layer, (c) => state.ids.has(c.id));
  /** A row shows when its layer matches; a group also shows for what it holds (kinds only describe the layers inside). */
  function filterShows(layer) {
    if (!layer.isGroup) return matchesFilter(layer, filter);
    if (filter.type === 'kind') return !filter.kinds.length || hasDescendant(layer, (c) => !c.isGroup && matchesFilter(c, filter));
    return matchesFilter(layer, filter) || hasDescendant(layer, (c) => matchesFilter(c, filter));
  }

  app.layerFilter = (layer) => {
    const state = iso();
    if (!state && !filter.on) return null;
    if (state && !isoShows(state, layer)) return false;
    if (filter.on && !filterShows(layer)) return false;
    return true;
  };

  // ---- the bar ------------------------------------------------------------------------------------------------
  let bar = null, isoBar = null;
  const panelEl = () => app.panels?.panels.get('layers')?.panel.element ?? null;
  const rerender = () => app.panels?.panels.get('layers')?.panel.onShow?.();

  function mount() {
    const el = panelEl();
    const list = el?.querySelector('.layer-list');
    if (!el || !list || bar) return !!bar;
    bar = document.createElement('div');
    bar.className = 'layer-filter-bar';
    bar.hidden = true;
    bar.innerHTML = `
      <select class="select" data-filter-type title="Filter the Layers panel by…">${FILTER_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <span class="layer-filter-controls"></span>
      <button type="button" class="pbtn layer-filter-switch" data-filter-switch role="switch" title="Turn layer filtering on or off"><span class="layer-filter-knob"></span></button>
      <button type="button" class="pbtn" data-filter-close title="Close the filter bar">${icon('close')}</button>`;
    isoBar = document.createElement('div');
    isoBar.className = 'layer-isolation-bar';
    isoBar.hidden = true;
    isoBar.innerHTML = `<span class="layer-isolation-text"></span><button type="button" class="btn small" data-isolation-exit>Exit</button>`;
    el.insertBefore(bar, list);
    el.insertBefore(isoBar, list);
    bar.querySelector('[data-filter-type]').addEventListener('change', (e) => setFilter({ type: e.target.value, on: true }));
    bar.querySelector('[data-filter-switch]').addEventListener('click', () => setFilter({ on: !filter.on }));
    bar.querySelector('[data-filter-close]').addEventListener('click', () => setFilter({ on: false, shown: false }));
    isoBar.querySelector('[data-isolation-exit]').addEventListener('click', () => app.commands.run('select:isolate-layers', false, 'panel'));
    // the Layers panel hid its link button until Layer › Link Layers existed
    const linkBtn = el.querySelector('.panel-footer [data-cmd="layer:link"]');
    if (linkBtn) linkBtn.hidden = false;
    return true;
  }

  const select = (key, options, title) => {
    const s = document.createElement('select');
    s.className = 'select';
    s.title = title;
    s.dataset.filterValue = key;
    for (const [v, l] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      s.appendChild(o);
    }
    s.value = filter[key];
    s.addEventListener('change', () => setFilter({ [key]: s.value, on: true }));
    return s;
  };

  function buildControls() {
    const box = bar.querySelector('.layer-filter-controls');
    box.replaceChildren();
    box.dataset.type = filter.type;
    if (filter.type === 'kind') {
      for (const [kind, title, ic] of KINDS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pbtn layer-filter-kind';
        b.dataset.kind = kind;
        b.title = `Filter for ${title.toLowerCase()}`;
        b.innerHTML = icon(ic);
        b.addEventListener('click', () => setFilter({ kinds: filter.kinds.includes(kind) ? filter.kinds.filter((k) => k !== kind) : [...filter.kinds, kind], on: true }));
        box.appendChild(b);
      }
    } else if (filter.type === 'name') {
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'search';
      input.placeholder = 'Layer name';
      input.dataset.filterValue = 'name';
      input.value = filter.name;
      const apply = debounce(() => setFilter({ name: input.value, on: true }, { rebuild: false }), 80);
      input.addEventListener('input', apply);
      // typing must never reach the tool shortcuts; Escape leaves the field and turns the filter off
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          input.value = '';
          setFilter({ name: '', on: false });
        }
      });
      box.appendChild(input);
    } else if (filter.type === 'effect') box.appendChild(select('effect', STYLE_KEYS.map((s) => [s.key, s.name]), 'Layer effect'));
    else if (filter.type === 'mode') box.appendChild(select('mode', [['pass-through', 'Pass Through'], ...BLEND_MODES.filter(Boolean)], 'Blend mode'));
    else if (filter.type === 'attribute') box.appendChild(select('attribute', ATTRIBUTES, 'Attribute'));
    else if (filter.type === 'color') box.appendChild(select('color', LABEL_COLORS.map(([v, l]) => [v, l]), 'Colour label'));
  }

  function syncBar({ rebuild = true } = {}) {
    if (!mount()) return;
    bar.hidden = !filter.shown;
    bar.classList.toggle('on', filter.on);
    bar.querySelector('[data-filter-type]').value = filter.type;
    const sw = bar.querySelector('[data-filter-switch]');
    sw.setAttribute('aria-checked', String(filter.on));
    if (rebuild || bar.querySelector('.layer-filter-controls').dataset.type !== filter.type) buildControls();
    for (const b of bar.querySelectorAll('.layer-filter-kind')) b.classList.toggle('active', filter.kinds.includes(b.dataset.kind));
    const state = iso();
    isoBar.hidden = !state;
    if (state) isoBar.querySelector('.layer-isolation-text').textContent = `Isolation mode: ${state.ids.size} layer${state.ids.size === 1 ? '' : 's'} shown`;
  }

  /** Changes the filter (any subset of its fields) and refreshes the bar and the panel. */
  function setFilter(patch, opts) {
    if (patch.kinds) patch = { ...patch, kinds: patch.kinds.filter((k) => KINDS.some(([id]) => id === k)) };
    if (patch.type && !FILTER_TYPES.some(([id]) => id === patch.type)) patch = { ...patch, type: 'kind' };
    Object.assign(filter, patch);
    if (filter.on) filter.shown = true;
    syncBar(opts);
    rerender();
    app.commands.invalidate();
  }
  app.setLayerFilter = setFilter;

  function findLayers(arg) {
    app.panels?.show('layers', { reveal: true });
    if (arg === false || arg === 'off') return setFilter({ on: false, shown: false });
    if (arg && typeof arg === 'object') return setFilter({ on: true, ...arg });
    // the menu command: search by name, the cursor waiting in the field (Photoshop's Find Layers)
    setFilter({ type: 'name', on: true });
    const input = bar?.querySelector('input[data-filter-value="name"]');
    input?.focus();
    input?.select();
  }

  // ---- isolation --------------------------------------------------------------------------------------------
  const invalidateView = (d) => {
    if (d?.view) {
      d.view.isolationCache = null;
      d.view.invalidate();
    }
  };

  function setIsolated(on, d = app.doc) {
    if (!d) return;
    if (on) {
      const picked = d.selectedLayers();
      const layers = picked.length ? picked : d.active ? [d.active] : [];
      if (!layers.length) return app.dialogs.toast('Select the layers to isolate first', { kind: 'info', timeout: 2200 });
      isolation.set(d, { ids: new Set(layers.map((l) => l.id)), known: new Set(d.layers().map((l) => l.id)) });
    } else isolation.delete(d);
    refreshIsolation(d);
  }

  function refreshIsolation(d) {
    if (d === app.doc) {
      app.ui.isolated = !!iso(d);
      syncBar({ rebuild: false });
      rerender();
      app.syncUiState();
      app.commands.invalidate();
    }
    invalidateView(d);
  }

  /** Layers made while isolated join the isolation (they would vanish as they are created); deleted ones leave it. */
  function trackTree(d) {
    const state = iso(d);
    if (!state) return;
    const present = new Set();
    for (const l of d.layers()) {
      present.add(l.id);
      if (state.known.has(l.id)) continue;
      state.known.add(l.id);
      if (!inIso(state, l)) state.ids.add(l.id);
    }
    for (const id of [...state.ids]) if (!present.has(id)) state.ids.delete(id);
    if (!state.ids.size) {
      isolation.delete(d);
      refreshIsolation(d);
    } else if (d === app.doc) syncBar({ rebuild: false });
  }

  /** The composite of the isolated layers only (cached until the document or the isolation changes). */
  function isolatedComposite(view) {
    const d = view.doc;
    const state = iso(d);
    if (!state) return null;
    const key = `${d.version}:${d.root.version}:${[...state.ids].join(',')}`;
    if (view.isolationCache?.key === key) return view.isolationCache.canvas;
    const layers = d.layers();
    const skip = new Set(layers.filter((l) => !isoShows(state, l)));
    // a clipped layer shown without its base is drawn as an ordinary layer for this view (it would not draw at all)
    const baseOf = (l) => {
      const k = l.parent?.children ?? [];
      let i = k.indexOf(l) - 1;
      while (i >= 0 && k[i].clip) i--;
      return k[i] ?? null;
    };
    const orphans = layers.filter((l) => l.clip && !skip.has(l) && skip.has(baseOf(l)));
    for (const l of orphans) l.clip = false;
    let canvas;
    try {
      view.isolationCompositor ??= new Compositor();
      canvas = view.isolationCompositor.composite(d, { skip });
    } finally {
      for (const l of orphans) l.clip = true;
    }
    view.isolationCache = { key, canvas };
    return canvas;
  }

  /** Wraps the view's postProcess (Proof Colors re-installs its own on every activation, so this re-wraps after it). */
  function attachView(d) {
    const view = d?.view;
    if (!view || view.postProcess?.isolationWrapper) return;
    const inner = view.postProcess ?? null;
    const wrapper = (composite, v) => {
      const mine = isolatedComposite(v);
      const base = mine ?? composite;
      const out = inner ? inner(base, v) : null;
      return out || mine;
    };
    wrapper.isolationWrapper = true;
    view.postProcess = wrapper;
  }

  app.on('doc:opened', attachView);
  app.on('doc:activated', (d) => {
    attachView(d);
    app.ui.isolated = !!iso(d);
    syncBar({ rebuild: false });
  });
  app.on('doc:change', (e) => {
    if (e.kind === 'tree' || e.kind === 'canvas' || e.kind === 'history') trackTree(e.doc);
  });
  app.on('app:ready', () => syncBar());
  for (const d of app.docs?.docs ?? []) attachView(d);

  app.commands.registerAll({
    'select:find-layers': { enabled: () => !!app.doc, run: findLayers, checked: () => filter.on, label: 'Find Layers' },
    'select:isolate-layers': {
      enabled: () => !!app.doc && (!!iso() || !!app.doc.active || app.doc.selected.size > 0),
      checked: () => !!iso(),
      run: (arg) => setIsolated(typeof arg === 'boolean' ? arg : !iso()),
      label: 'Isolate Layers',
    },
  });

  return { filter, setFilter, isolatedComposite, isolation: iso };
}
