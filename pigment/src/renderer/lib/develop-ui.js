// Filter › Camera Raw Filter… (see ARCHITECTURE.md "0.2 features: Camera Raw filter").
// A pixelEditDialog (live preview on the canvas, limited to the selection) with the controls of
// src/shared/pixels/develop.js split over four tabs: Basic, Detail, HSL and Effects. "Auto" derives
// a tone patch from the histogram (autoTone, the Auto Levels / Auto Contrast clipping logic),
// "Reset" returns every control to its neutral value. OK records one "Camera Raw" history entry; on
// a smart layer the smart-object module turns it into a smart filter through app.smartFilters.
import { develop, developDefaults, autoTone, HSL_RANGES } from '../../shared/pixels/develop.js';
import { buildForm } from './form.js';
import { pixelEditDialog, getPath, setPath } from './adjust-ui.js';

const LABEL = 'Camera Raw';
const clone = (v) => JSON.parse(JSON.stringify(v));
const S = (key, label, min = -100, max = 100, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

const RANGE_LABELS = { reds: 'Reds', oranges: 'Oranges', yellows: 'Yellows', greens: 'Greens', aquas: 'Aquas', blues: 'Blues', purples: 'Purples', magentas: 'Magentas' };

/** Field specs per tab (keys are parameter paths into the develop params). */
const TABS = [
  {
    id: 'basic',
    label: 'Basic',
    fields: [
      { type: 'section', label: 'White balance' },
      S('temperature', 'Temperature'),
      S('tint', 'Tint'),
      { type: 'section', label: 'Tone' },
      S('exposure', 'Exposure', -5, 5, 0.05, { unit: 'EV' }),
      S('contrast', 'Contrast'),
      S('highlights', 'Highlights'),
      S('shadows', 'Shadows'),
      S('whites', 'Whites'),
      S('blacks', 'Blacks'),
      { type: 'section', label: 'Presence' },
      S('texture', 'Texture'),
      S('clarity', 'Clarity'),
      S('dehaze', 'Dehaze'),
      S('vibrance', 'Vibrance'),
      S('saturation', 'Saturation'),
    ],
  },
  {
    id: 'detail',
    label: 'Detail',
    fields: [
      { type: 'section', label: 'Sharpening' },
      S('sharpen.amount', 'Amount', 0, 150),
      S('sharpen.radius', 'Radius', 0.5, 3, 0.1, { unit: 'px' }),
      S('sharpen.detail', 'Detail', 0, 100),
      { type: 'section', label: 'Noise reduction' },
      S('noise.luminance', 'Luminance', 0, 100),
      S('noise.color', 'Color', 0, 100),
    ],
  },
  {
    id: 'hsl',
    label: 'HSL',
    // one form per sub-mode (Hue / Saturation / Luminance), switched by a segment control
    modes: ['hue', 'saturation', 'luminance'],
    fields: (mode) => HSL_RANGES.map((r) => S(`hsl.${r}.${mode}`, RANGE_LABELS[r])),
  },
  {
    id: 'effects',
    label: 'Effects',
    fields: [
      { type: 'section', label: 'Post-crop vignetting' },
      S('vignette', 'Amount'),
      { type: 'section', label: 'Grain' },
      S('grain', 'Amount', 0, 100),
      { key: 'seed', label: 'Seed', type: 'number', min: 1, max: 99999 },
    ],
  },
];

/** Builds the tabbed editor: editor(onChange, session) -> { element, set(params) }. */
export function developEditor(start, onChange, { onAuto = null } = {}) {
  let current = clone(start);
  const element = document.createElement('div');
  element.className = 'camera-raw';

  // toolbar: Auto / Reset (inside the editor so they do not close the dialog)
  const bar = document.createElement('div');
  bar.className = 'camera-raw-bar';
  bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin:0 0 10px';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'btn';
  autoBtn.textContent = 'Auto';
  autoBtn.dataset.action = 'auto';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn';
  resetBtn.textContent = 'Reset';
  resetBtn.dataset.action = 'reset';
  bar.append(autoBtn, resetBtn);
  element.appendChild(bar);

  const tabBar = document.createElement('div');
  tabBar.className = 'dialog-tabs';
  tabBar.setAttribute('role', 'tablist');
  element.appendChild(tabBar);
  const pages = document.createElement('div');
  pages.className = 'camera-raw-pages';
  element.appendChild(pages);

  const forms = []; // { form, fields }
  const sync = () => {
    for (const { form, fields } of forms) for (const f of fields) if (f.key) form.set(f.key, getPath(current, f.key) ?? 0, { silent: true });
  };
  const makeForm = (fields) => {
    const values = {};
    for (const f of fields) if (f.key) values[f.key] = getPath(current, f.key) ?? 0;
    const form = buildForm(fields, {
      values,
      onChange: (v, key) => {
        setPath(current, key, v[key]);
        onChange(clone(current));
      },
    });
    forms.push({ form, fields });
    return form;
  };

  const pageEls = [];
  for (const tab of TABS) {
    const page = document.createElement('div');
    page.className = 'camera-raw-page';
    page.dataset.tab = tab.id;
    page.hidden = true;
    if (tab.modes) {
      const seg = document.createElement('div');
      seg.className = 'opt-segment';
      seg.setAttribute('role', 'radiogroup');
      seg.style.marginBottom = '10px';
      const modeEls = [];
      for (const mode of tab.modes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-button';
        b.dataset.mode = mode;
        b.textContent = mode[0].toUpperCase() + mode.slice(1);
        const form = makeForm(tab.fields(mode));
        form.element.hidden = mode !== tab.modes[0];
        b.setAttribute('aria-pressed', String(mode === tab.modes[0]));
        b.addEventListener('click', () => {
          for (const [btn, el] of modeEls) {
            btn.setAttribute('aria-pressed', String(btn === b));
            el.hidden = btn !== b;
          }
        });
        modeEls.push([b, form.element]);
        seg.appendChild(b);
        page.appendChild(form.element);
      }
      page.prepend(seg);
    } else page.appendChild(makeForm(tab.fields).element);
    pages.appendChild(page);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dialog-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = tab.id;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => show(tab.id));
    tabBar.appendChild(btn);
    pageEls.push({ id: tab.id, page, btn });
  }
  function show(id) {
    for (const t of pageEls) {
      t.page.hidden = t.id !== id;
      t.btn.setAttribute('aria-selected', String(t.id === id));
    }
  }
  show('basic');

  const set = (params) => {
    current = clone(params);
    sync();
    onChange(clone(current));
  };
  resetBtn.addEventListener('click', () => set(developDefaults()));
  autoBtn.addEventListener('click', () => {
    const patch = onAuto?.();
    if (patch) set({ ...current, ...patch });
    show('basic');
  });
  return { element, set, get: () => clone(current) };
}

export function install(app) {
  const has = () => !!app.doc?.active;

  async function cameraRaw(arg) {
    app.tools.active?.commit?.();
    const d = app.doc;
    const layer = d?.active;
    if (!layer) return;
    const start = { ...developDefaults(), ...(arg && typeof arg === 'object' ? clone(arg) : {}) };
    // smart objects: the smart-object module owns the dialog flow and appends a smart filter
    if (layer.type === 'smart' && typeof app.smartFilters?.intercept === 'function') {
      const handled = await app.smartFilters.intercept(layer, 'camera-raw', start, LABEL);
      if (handled !== false) return handled;
    }
    const used = await pixelEditDialog(app, {
      title: 'Camera Raw Filter',
      label: LABEL,
      params: start,
      width: 560,
      editor: (onChange, session) =>
        developEditor(start, onChange, {
          onAuto: () => autoTone(session.base),
        }),
      run: (img, params) => develop(img, params),
    });
    if (used) app.lastCameraRaw = clone(used);
    return used;
  }

  // shared with other modules (smart filters re-render through it)
  app.cameraRaw = { develop, defaults: developDefaults, autoTone, editor: developEditor, label: LABEL };
  app.commands.registerAll({
    'filter:camera-raw': { enabled: has, label: 'Camera Raw Filter…', run: (arg) => cameraRaw(arg) },
  });
}
