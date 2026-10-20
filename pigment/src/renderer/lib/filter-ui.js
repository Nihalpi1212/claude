// Filter menu: one dialog per filter (live preview on the canvas, limited to the selection),
// Filter › Last Filter (Ctrl+F) and the filter:<kind> command ids.
import { FILTERS, FILTER_KINDS, FILTER_CATEGORIES, applyFilter } from '../../shared/pixels/filters.js';
import { buildForm } from './form.js';
import { beginPixelEdit, processed, pixelEditDialog, getPath, setPath } from './adjust-ui.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const EDGE = { key: 'edge', label: 'Undefined areas', type: 'select', options: [['transparent', 'Transparent'], ['repeat', 'Repeat edge pixels'], ['wrap', 'Wrap around']] };
const SEED = { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999 };
const CENTER = [S('center.x', 'Center X', 0, 1, 0.01), S('center.y', 'Center Y', 0, 1, 0.01)];

/** Field specs per filter kind (keys are parameter paths). Kinds without an entry apply directly. */
const FIELDS = {
  'gaussian-blur': [S('radius', 'Radius', 0.1, 250, 0.1, { unit: 'px' })],
  'box-blur': [S('radius', 'Radius', 1, 500, 1, { unit: 'px' })],
  'motion-blur': [S('angle', 'Angle', -180, 180, 1, { unit: '°' }), S('distance', 'Distance', 1, 2000, 1, { unit: 'px' })],
  'radial-blur': [S('amount', 'Amount', 1, 100), { key: 'method', label: 'Blur method', type: 'segment', options: [['spin', 'Spin'], ['zoom', 'Zoom']] }, ...CENTER],
  'surface-blur': [S('radius', 'Radius', 1, 100, 1, { unit: 'px' }), S('threshold', 'Threshold', 2, 255, 1, { unit: 'levels' })],
  sharpen: [S('amount', 'Amount', 1, 500, 1, { unit: '%' })],
  'unsharp-mask': [S('amount', 'Amount', 1, 500, 1, { unit: '%' }), S('radius', 'Radius', 0.1, 250, 0.1, { unit: 'px' }), S('threshold', 'Threshold', 0, 255, 1, { unit: 'levels' })],
  'smart-sharpen': [S('amount', 'Amount', 1, 500, 1, { unit: '%' }), S('radius', 'Radius', 0.1, 64, 0.1, { unit: 'px' }), S('reduceNoise', 'Reduce noise', 0, 100, 1, { unit: '%' })],
  'high-pass': [S('radius', 'Radius', 0.1, 250, 0.1, { unit: 'px' })],
  'add-noise': [S('amount', 'Amount', 0.1, 400, 0.1, { unit: '%' }), { key: 'distribution', label: 'Distribution', type: 'segment', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] }, { key: 'monochromatic', label: 'Monochromatic', type: 'checkbox' }, SEED],
  median: [S('radius', 'Radius', 1, 100, 1, { unit: 'px' })],
  'dust-scratches': [S('radius', 'Radius', 1, 100, 1, { unit: 'px' }), S('threshold', 'Threshold', 0, 255, 1, { unit: 'levels' })],
  'reduce-noise': [S('strength', 'Strength', 0, 10, 1)],
  mosaic: [S('size', 'Cell size', 2, 200, 1, { unit: 'px' })],
  crystallize: [S('size', 'Cell size', 3, 300, 1), SEED],
  pointillize: [S('size', 'Cell size', 3, 300, 1), SEED],
  twirl: [S('angle', 'Angle', -999, 999, 1, { unit: '°' }), EDGE],
  pinch: [S('amount', 'Amount', -100, 100, 1, { unit: '%' }), EDGE],
  spherize: [S('amount', 'Amount', -100, 100, 1, { unit: '%' }), EDGE],
  ripple: [S('amount', 'Amount', -999, 999, 1, { unit: '%' }), { key: 'size', label: 'Size', type: 'segment', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }, EDGE],
  wave: [S('amplitude', 'Amplitude', 1, 999, 1, { unit: 'px' }), S('wavelength', 'Wavelength', 2, 999, 1, { unit: 'px' }), { key: 'type', label: 'Type', type: 'segment', options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']] }, EDGE],
  zigzag: [S('amount', 'Amount', -100, 100, 1), S('ridges', 'Ridges', 1, 20, 1), EDGE],
  polar: [{ key: 'toPolar', label: 'Conversion', type: 'segment', options: [[true, 'Rectangular to polar'], [false, 'Polar to rectangular']], span: true }, EDGE],
  shear: [S('__bend', 'Bend', -100, 100, 1, { unit: '%' }), EDGE],
  offset: [S('dx', 'Horizontal', -4000, 4000, 1, { unit: 'px right' }), S('dy', 'Vertical', -4000, 4000, 1, { unit: 'px down' }), { key: 'wrap', label: 'Wrap around', type: 'checkbox' }],
  emboss: [S('angle', 'Angle', -180, 180, 1, { unit: '°' }), S('height', 'Height', 1, 100, 1, { unit: 'px' }), S('amount', 'Amount', 1, 500, 1, { unit: '%' })],
  diffuse: [{ key: 'mode', label: 'Mode', type: 'select', options: [['normal', 'Normal'], ['darken', 'Darken only'], ['lighten', 'Lighten only'], ['anisotropic', 'Anisotropic']] }, SEED],
  'oil-paint': [S('radius', 'Stylization (radius)', 1, 20, 1), S('levels', 'Detail (levels)', 2, 256, 1)],
  'glowing-edges': [S('width', 'Edge width', 1, 14, 1), S('brightness', 'Edge brightness', 0, 20, 1)],
  clouds: [S('scale', 'Scale', 8, 2000, 1, { unit: 'px' }), { key: 'colors.0', label: 'Color 1', type: 'color' }, { key: 'colors.1', label: 'Color 2', type: 'color' }, SEED],
  'difference-clouds': [S('scale', 'Scale', 8, 2000, 1, { unit: 'px' }), { key: 'colors.0', label: 'Color 1', type: 'color' }, { key: 'colors.1', label: 'Color 2', type: 'color' }, SEED],
  'lens-flare': [S('brightness', 'Brightness', 10, 300, 1, { unit: '%' }), ...CENTER],
  vignette: [S('amount', 'Amount', -100, 100, 1), S('size', 'Midpoint', 0, 1, 0.01), S('roundness', 'Roundness', -100, 100, 1)],
  maximum: [S('radius', 'Radius', 1, 100, 1, { unit: 'px' })],
  minimum: [S('radius', 'Radius', 1, 100, 1, { unit: 'px' })],
  custom: [
    ...Array.from({ length: 9 }, (_, i) => ({ key: `kernel.${i}`, label: i === 4 ? 'Center' : ' ', type: 'number', min: -999, max: 999, width: 64 })),
    { key: 'scale', label: 'Scale', type: 'number', min: 1, max: 9999 },
    { key: 'offset', label: 'Offset', type: 'number', min: -9999, max: 9999 },
  ],
};

/** Neighbourhood size a filter reads around each pixel (so the selection edge blends). */
function marginFor(kind, p) {
  const r = Number(p.radius ?? p.distance ?? p.size ?? 0) || 0;
  if (['twirl', 'pinch', 'spherize', 'polar', 'shear', 'lens-flare', 'vignette', 'clouds', 'difference-clouds', 'offset', 'radial-blur'].includes(kind)) return 0;
  if (kind === 'gaussian-blur' || kind === 'unsharp-mask' || kind === 'high-pass' || kind === 'smart-sharpen') return Math.ceil(r * 3);
  return Math.ceil(Math.min(400, r * 2 + 2));
}

function paramsFor(app, kind, saved) {
  const def = clone(FILTERS[kind].defaults);
  const p = { ...def, ...(saved ?? {}) };
  if ((kind === 'clouds' || kind === 'difference-clouds') && !saved) p.colors = [app.settings.foreground, app.settings.background];
  return p;
}

function toRun(kind, params) {
  const p = clone(params);
  if (kind === 'shear') {
    const bend = (p.__bend ?? 0) / 100;
    p.points = [[0, 0], [0.5, bend], [1, 0]];
    delete p.__bend;
  }
  return p;
}

function filterEditor(kind, params, onChange) {
  const fields = FIELDS[kind] ?? [];
  const values = {};
  for (const f of fields) {
    if (!f.key) continue;
    if (f.key === '__bend') values[f.key] = params.__bend ?? Math.round((params.points?.[1]?.[1] ?? 0) * 100);
    else values[f.key] = getPath(params, f.key) ?? (f.type === 'checkbox' ? false : f.type === 'color' ? '#000000' : 0);
  }
  let current = clone(params);
  const form = buildForm(fields, {
    values,
    onChange: (v) => {
      for (const f of fields) if (f.key) {
        if (f.key === '__bend') current.__bend = v.__bend;
        else setPath(current, f.key, v[f.key]);
      }
      onChange(clone(current));
    },
  });
  if (kind === 'custom') {
    form.element.style.gridTemplateColumns = 'repeat(3, minmax(70px, 1fr))';
    for (const el of form.element.children) el.classList.remove('span-all');
  }
  return { element: form.element };
}

export function install(app) {
  const has = () => !!app.doc?.active;
  const saved = () => (app.settings.filterParams ??= {});

  async function run(kind, arg, { dialog = true } = {}) {
    const def = FILTERS[kind];
    if (!def) return;
    app.tools.active?.commit?.();
    const d = app.doc;
    if (!d) return;
    const direct = arg && typeof arg === 'object' ? arg : null;
    // smart objects (lib/smart-object.js): a filter on a smart layer becomes a smart filter, not a pixel edit
    if (app.smartFilters?.intercept(d.active, kind, direct, def.name)) return;
    const hasFields = !!FIELDS[kind]?.length;
    if (direct || !hasFields || !dialog) {
      const params = direct ?? paramsFor(app, kind, saved()[kind]);
      const session = beginPixelEdit(app, { label: def.name, margin: marginFor(kind, params) });
      if (!session) return;
      try {
        const img = await app.busy(`${def.name}…`, async () => processed(session, (x) => applyFilter(x, kind, toRun(kind, params))));
        session.commit(def.name, img);
      } catch (err) {
        session.cancel();
        return app.reportError(err, `${def.name} failed`);
      }
      remember(kind, params);
      return;
    }
    const start = paramsFor(app, kind, saved()[kind]);
    const used = await pixelEditDialog(app, {
      title: def.name,
      params: start,
      margin: marginFor(kind, { ...start, radius: Math.max(Number(start.radius ?? 0), 50) }),
      editor: (onChange) => filterEditor(kind, start, onChange),
      run: (img, params) => applyFilter(img, kind, toRun(kind, params)),
      width: kind === 'custom' ? 360 : 440,
    });
    if (used) {
      saved()[kind] = used;
      remember(kind, used);
    }
  }

  function remember(kind, params) {
    app.settings.lastFilter = { kind, name: FILTERS[kind].name, params: clone(params) };
    app.saveSettingsSoon();
    app.syncUiState();
    app.commands.invalidate();
    app.menuRefresh?.();
  }

  const cmds = {
    'filter:apply': { enabled: has, run: (arg) => (typeof arg === 'string' ? run(arg) : arg?.kind ? run(arg.kind, arg.params ?? null) : null) },
    'filter:last': {
      enabled: () => has() && !!app.settings.lastFilter?.kind,
      label: () => (app.settings.lastFilter?.name ? `Last Filter: ${app.settings.lastFilter.name}` : 'Last Filter'),
      run: () => {
        const l = app.settings.lastFilter;
        if (l?.kind) run(l.kind, l.params ?? {}, { dialog: false });
      },
    },
    'filter:last-dialog': {
      enabled: () => has() && !!app.settings.lastFilter?.kind,
      run: () => {
        const l = app.settings.lastFilter;
        if (l?.kind) run(l.kind);
      },
    },
  };
  for (const k of FILTER_KINDS) cmds[`filter:${k}`] = { enabled: has, run: (arg) => run(k, arg && typeof arg === 'object' ? arg : null), label: `${FILTERS[k].name}${FIELDS[k]?.length ? '…' : ''}` };
  app.commands.registerAll(cmds);
  app.filterCategories = FILTER_CATEGORIES;
  // smart objects (lib/smart-object.js) re-use the filter dialogs' editors for smart filters
  /** [min, max] per numeric field of a kind (what the dialog's sliders allow), for callers that clamp model-supplied params. */
  const ranges = (kind) => Object.fromEntries((FIELDS[kind] ?? []).filter((f) => typeof f.min === 'number' && typeof f.max === 'number').map((f) => [f.key, [f.min, f.max]]));
  app.filterEditor = { editor: (kind, params, onChange) => filterEditor(kind, params, onChange), defaults: (kind) => paramsFor(app, kind, saved()[kind]), hasFields: (kind) => !!FIELDS[kind]?.length, toRun, ranges };
}
