// Filter > Lens Correction… (builder "content-aware-lens"): the dialog of the 'lens-correction' filter kind
// (src/shared/pixels/lens.js). It is the kind's custom opener (app.filterEditor.register), so the menu command,
// Last Filter, actions and smart filters all go through the same params.
//
// Layout, like Photoshop's: a large preview on the left (zoom, pan, a grid with size and colour, and three
// tools: Hand, Straighten, Remove Distortion), the controls on the right in two tabs.
// - Auto Correction: which corrections apply (Geometric Distortion, Chromatic Aberration, Vignette), Auto
//   Scale Image and Edge. Pigment has no lens profile database, so instead of Photoshop's search criteria the
//   tab says so and offers "Straighten horizon" (detectHorizon finds the dominant near-horizontal edge).
// - Custom: Remove Distortion, the three fringe sliders, Vignette amount and midpoint, and the Transform
//   group (vertical and horizontal perspective, angle, scale).
// The preview runs the filter on a reduced copy of the edited region (the parameters are relative to the
// image size, so the reduced run looks like the full one); OK runs it at full size under app.busy and
// commits one history entry through beginPixelEdit. The dialog opens with a neutral correction (a rotation
// or a keystone belongs to one photo), "Previous" brings back the values of the last run.
import { FILTERS, applyFilter } from '../../shared/pixels/filters.js';
import { LENS_DEFAULTS, lensCorrect, detectHorizon, straightenAngle, gridLines, isNeutral } from '../../shared/pixels/lens.js';
import { resize } from '../../shared/pixels/transform.js';
import { buildForm, frameThrottle } from './form.js';
import { beginPixelEdit, processed } from './adjust-ui.js';
import { icon } from './icons.js';

const KIND = 'lens-correction';
/** Longest side of the copy the preview runs on. */
const PREVIEW_MAX = 800;
/** Layers above this size are reduced for the preview under app.busy. */
const BUSY_PIXELS = 3e6;
const ZOOMS = [0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8];
const clone = (v) => JSON.parse(JSON.stringify(v));
const round = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
/** Folds an angle into (-180, 180]. */
const foldAngle = (a) => {
  let v = a % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
};
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

/** The Custom tab (keys are the kind's parameters). */
const CUSTOM_FIELDS = [
  { type: 'section', label: 'Geometric distortion' },
  S('distortion', 'Remove distortion', -100, 100),
  { type: 'section', label: 'Chromatic aberration' },
  S('chromaRC', 'Fix red/cyan fringe', -100, 100),
  S('chromaGM', 'Fix green/magenta fringe', -100, 100),
  S('chromaBY', 'Fix blue/yellow fringe', -100, 100),
  { type: 'section', label: 'Vignette' },
  S('vignette', 'Amount (darken – lighten)', -100, 100),
  S('vignetteMidpoint', 'Midpoint', 0, 100),
  { type: 'section', label: 'Transform' },
  S('vertical', 'Vertical perspective', -100, 100),
  S('horizontal', 'Horizontal perspective', -100, 100),
  { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, step: 0.01, unit: '°', width: 90 },
  S('scale', 'Scale', 50, 150, 1, { unit: '%' }),
];
const EDGE_OPTIONS = [['transparent', 'Transparency'], ['repeat', 'Edge extension'], ['wrap', 'Wrap around'], ['background', 'Background color']];
const TOOLS = [
  ['hand', 'Hand: drag to move the preview', 'hand'],
  ['straighten', 'Straighten: draw a line along something that should be level or upright', 'ruler'],
  ['distort', 'Remove Distortion: drag towards the centre or away from it', 'warp'],
];

/** Start values of a session: `params` over the defaults, unknown keys dropped. */
function startParams(params) {
  const p = { ...LENS_DEFAULTS };
  for (const k of Object.keys(LENS_DEFAULTS)) if (params && params[k] !== undefined) p[k] = params[k];
  return p;
}

/**
 * Opener contract (lib/filter-ui.js): open(kind, { params, def, ctx }) -> Promise<params | null>. Owns a pixel edit
 * session of the active layer (limited to the selection), commits once on OK and resolves with the params used.
 * `previous` are the params "Previous" restores (the last run's).
 */
async function openLens(app, { params, def, previous = null }) {
  const session = beginPixelEdit(app, { label: def.name });
  if (!session) return null;
  const prefs = { grid: false, gridSize: 64, gridColor: '#808080', tab: 'custom', ...(app.settings.lensCorrection ?? {}) };
  const savePrefs = () => app.saveSettingsSoon({ lensCorrection: { ...prefs } });
  let current = startParams(params);
  // the Auto Correction checkboxes: an unchecked group does not apply (its values stay in the Custom tab)
  const enable = { geo: true, chroma: true, vig: true };
  let previewOn = true, tool = 'hand', done = false, renders = 0;

  /** The params a run uses: disabled groups neutral, the background colour named when the edge needs it. */
  const effective = () => {
    const p = { ...current };
    if (!enable.geo) p.distortion = 0;
    if (!enable.chroma) p.chromaRC = p.chromaBY = p.chromaGM = 0;
    if (!enable.vig) p.vignette = 0;
    p.angle = round(foldAngle(Number(p.angle) || 0));
    p.background = p.edge === 'background' ? app.settings.background ?? LENS_DEFAULTS.background : LENS_DEFAULTS.background;
    return p;
  };

  // -- preview copy: the edited region, reduced while editing
  const base = session.base;
  const scale = Math.min(1, PREVIEW_MAX / Math.max(1, base.width, base.height));
  const reduce = () => resize(base, Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)), { method: 'area' });
  // reducing a very large layer takes a moment: it gets the busy state instead of a frozen window
  const previewBase = scale >= 1 ? base : base.width * base.height > BUSY_PIXELS ? await app.busy('Lens Correction…', async () => reduce()) : reduce();
  const pvCanvas = document.createElement('canvas');
  pvCanvas.width = previewBase.width;
  pvCanvas.height = previewBase.height;
  const pvCtx = pvCanvas.getContext('2d');

  // -- DOM
  const root = el('div', 'lc-root');
  root.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;height:min(620px,calc(100vh - 190px));min-height:320px';
  const left = el('div', 'lc-preview');
  left.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0';
  const toolBar = el('div', 'lc-tools');
  toolBar.style.cssText = 'display:flex;align-items:center;gap:10px';
  const toolSeg = el('div', 'opt-segment');
  toolSeg.setAttribute('role', 'radiogroup');
  const toolButtons = [];
  for (const [id, title, ic] of TOOLS) {
    const b = el('button', 'seg-button');
    b.type = 'button';
    b.dataset.tool = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon(ic);
    b.addEventListener('click', () => setTool(id));
    toolButtons.push(b);
    toolSeg.appendChild(b);
  }
  const status = el('span', 'lc-status muted');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  toolBar.append(toolSeg, status);
  const viewport = el('div', 'lc-viewport');
  viewport.style.cssText = 'flex:1;min-height:200px;position:relative;overflow:hidden;border:1px solid var(--border);border-radius:6px;touch-action:none;background:repeating-conic-gradient(#cccccc 0% 25%, #ffffff 0% 50%) 50% / 16px 16px';
  const canvas = el('canvas', 'lc-canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  viewport.appendChild(canvas);
  const bar = el('div', 'lc-bar');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px';
  const mkBtn = (action, title, ic) => {
    const b = el('button', 'btn quiet');
    b.type = 'button';
    b.dataset.action = action;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = 'width:28px;height:28px;padding:0;display:grid;place-items:center';
    b.innerHTML = icon(ic);
    return b;
  };
  const zoomOut = mkBtn('zoom-out', 'Zoom out', 'minus');
  const zoomIn = mkBtn('zoom-in', 'Zoom in', 'plus');
  const zoomSel = el('select', 'select lc-zoom');
  zoomSel.style.width = '84px';
  zoomSel.setAttribute('aria-label', 'Zoom');
  for (const z of ZOOMS) zoomSel.appendChild(new Option(`${Math.round(z * 100)}%`, String(z)));
  const fitOpt = new Option('Fit', 'fit');
  zoomSel.appendChild(fitOpt);
  const check = (key, label, checked) => {
    const l = el('label', 'checkbox');
    l.style.margin = '0';
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.dataset.key = key;
    l.append(input, document.createTextNode(label));
    return { label: l, input };
  };
  const pv = check('__preview', 'Preview', true);
  const grid = check('__grid', 'Show grid', !!prefs.grid);
  const gridSize = el('input', 'input');
  gridSize.type = 'number';
  gridSize.min = '8';
  gridSize.max = '512';
  gridSize.value = String(prefs.gridSize);
  gridSize.dataset.key = '__gridSize';
  gridSize.title = 'Grid size (px)';
  gridSize.setAttribute('aria-label', 'Grid size');
  gridSize.style.cssText = 'width:64px;height:26px';
  const gridColor = el('input');
  gridColor.type = 'color';
  gridColor.value = prefs.gridColor;
  gridColor.dataset.key = '__gridColor';
  gridColor.title = 'Grid colour';
  gridColor.setAttribute('aria-label', 'Grid colour');
  gridColor.style.cssText = 'width:30px;height:26px;padding:0;border:1px solid var(--border);border-radius:4px;background:none';
  const spacer = el('span');
  spacer.style.flex = '1';
  bar.append(zoomOut, zoomSel, zoomIn, spacer, pv.label, grid.label, gridSize, gridColor);
  left.append(toolBar, viewport, bar);

  const side = el('div', 'lc-side');
  side.style.cssText = 'display:flex;flex-direction:column;min-height:0;min-width:0';
  const tabBar = el('div', 'dialog-tabs');
  tabBar.setAttribute('role', 'tablist');
  tabBar.style.margin = '0 0 10px';
  const pages = el('div', 'lc-pages');
  pages.style.cssText = 'flex:1;min-height:0;overflow:auto;padding-right:4px';
  const foot = el('div', 'lc-foot');
  foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding-top:10px';
  const prevBtn = el('button', 'btn', 'Previous');
  prevBtn.type = 'button';
  prevBtn.dataset.action = 'previous';
  prevBtn.title = 'The correction of the last run';
  prevBtn.disabled = !previous || isNeutral(previous);
  const resetBtn = el('button', 'btn', 'Reset');
  resetBtn.type = 'button';
  resetBtn.dataset.action = 'reset';
  foot.append(prevBtn, resetBtn);
  side.append(tabBar, pages, foot);
  root.append(left, side);

  // -- forms
  const oneColumn = (form) => {
    form.element.style.gridTemplateColumns = 'minmax(0, 1fr)';
    form.element.style.minWidth = '0';
    return form;
  };
  const customValues = {};
  for (const f of CUSTOM_FIELDS) if (f.key) customValues[f.key] = current[f.key];
  const customForm = oneColumn(buildForm(CUSTOM_FIELDS, {
    values: customValues,
    onChange: (v, key) => {
      current[key] = v[key];
      refresh();
    },
  }));
  const autoFields = [
    { type: 'section', label: 'Correction' },
    { key: '__geo', label: 'Geometric distortion', type: 'checkbox' },
    { key: '__chroma', label: 'Chromatic aberration', type: 'checkbox' },
    { key: '__vig', label: 'Vignette', type: 'checkbox' },
    { key: 'autoScale', label: 'Auto scale image', type: 'checkbox', help: 'Enlarges the result just enough to hide the empty edges.' },
    { key: 'edge', label: 'Edge', type: 'select', options: EDGE_OPTIONS },
    { type: 'section', label: 'Lens profiles' },
    {
      type: 'custom',
      render: () => {
        const box = el('div', 'lc-profiles');
        const note = el('p', 'muted lc-note', 'Pigment has no lens profile database, so there is nothing to search by camera and lens. Set the corrections in the Custom tab; the horizon can be found automatically.');
        note.style.cssText = 'font-size:12px;line-height:1.45;margin:0 0 10px';
        const b = el('button', 'btn', 'Straighten horizon');
        b.type = 'button';
        b.dataset.action = 'straighten-horizon';
        b.addEventListener('click', autoStraighten);
        box.append(note, b);
        return box;
      },
    },
  ];
  const autoForm = oneColumn(buildForm(autoFields, {
    values: { __geo: true, __chroma: true, __vig: true, autoScale: !!current.autoScale, edge: current.edge },
    onChange: (v, key) => {
      if (key === '__geo') enable.geo = !!v.__geo;
      else if (key === '__chroma') enable.chroma = !!v.__chroma;
      else if (key === '__vig') enable.vig = !!v.__vig;
      else current[key] = v[key];
      refresh();
    },
  }));
  /** Writes `current` and the enable flags back into both forms. */
  const syncForms = () => {
    for (const f of CUSTOM_FIELDS) if (f.key) customForm.set(f.key, current[f.key], { silent: true });
    autoForm.set('autoScale', !!current.autoScale, { silent: true });
    autoForm.set('edge', current.edge, { silent: true });
    autoForm.set('__geo', enable.geo, { silent: true });
    autoForm.set('__chroma', enable.chroma, { silent: true });
    autoForm.set('__vig', enable.vig, { silent: true });
  };
  const tabs = [['auto', 'Auto Correction', autoForm.element], ['custom', 'Custom', customForm.element]].map(([id, label, page]) => {
    const btn = el('button', 'dialog-tab', label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = id;
    btn.addEventListener('click', () => showTab(id));
    tabBar.appendChild(btn);
    page.dataset.page = id;
    pages.appendChild(page);
    return { id, btn, page };
  });
  function showTab(id) {
    for (const t of tabs) {
      t.page.hidden = t.id !== id;
      t.btn.setAttribute('aria-selected', String(t.id === id));
    }
    if (prefs.tab !== id) {
      prefs.tab = id;
      savePrefs();
    }
  }
  showTab(prefs.tab === 'auto' ? 'auto' : 'custom');

  // -- preview rendering (one frame at most per change)
  const refresh = frameThrottle(() => {
    if (done) return;
    try {
      const p = effective();
      const img = previewOn && !isNeutral(p) ? lensCorrect(previewBase, p) : previewBase;
      pvCtx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      renders++;
      root.dataset.renders = String(renders);
      root.dataset.params = JSON.stringify(p);
    } catch (err) {
      console.error(err);
    }
    paint();
  });

  // -- preview view: zoom is image px -> css px; pan is the css offset of the image's top-left
  let zoom = 1, fit = true, panX = 0, panY = 0;
  const viewSize = () => ({ w: viewport.clientWidth || 1, h: viewport.clientHeight || 1 });
  function fitZoom() {
    const { w, h } = viewSize();
    zoom = Math.min((w - 16) / base.width, (h - 16) / base.height);
    if (!(zoom > 0)) zoom = 1;
    fit = true;
    panX = (w - base.width * zoom) / 2;
    panY = (h - base.height * zoom) / 2;
  }
  function syncZoom() {
    if (fit) zoomSel.value = 'fit';
    else {
      const near = ZOOMS.find((z) => Math.abs(z - zoom) < 1e-6);
      if (near !== undefined) zoomSel.value = String(near);
      else {
        let custom = zoomSel.querySelector('option[data-custom]');
        if (!custom) {
          custom = el('option');
          custom.dataset.custom = '1';
          zoomSel.insertBefore(custom, fitOpt);
        }
        custom.value = String(zoom);
        custom.textContent = `${Math.round(zoom * 100)}%`;
        zoomSel.value = custom.value;
      }
    }
    zoomOut.disabled = zoom <= ZOOMS[0] + 1e-6;
    zoomIn.disabled = zoom >= ZOOMS[ZOOMS.length - 1] - 1e-6;
  }
  /** The line being drawn with the Straighten tool, in viewport css px (or null). */
  let ruler = null;
  function paint() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewSize();
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = zoom / scale;
    ctx.imageSmoothingEnabled = k < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pvCanvas, panX, panY, pvCanvas.width * k, pvCanvas.height * k);
    if (prefs.grid) {
      // the grid stays on the frame (it is what straight lines are judged against), centred like the correction
      const g = gridLines(base.width, base.height, prefs.gridSize);
      ctx.save();
      ctx.beginPath();
      ctx.rect(panX, panY, base.width * zoom, base.height * zoom);
      ctx.clip();
      ctx.strokeStyle = prefs.gridColor;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of g.xs) {
        const sx = Math.round(panX + x * zoom) + 0.5;
        ctx.moveTo(sx, panY);
        ctx.lineTo(sx, panY + base.height * zoom);
      }
      for (const y of g.ys) {
        const sy = Math.round(panY + y * zoom) + 0.5;
        ctx.moveTo(panX, sy);
        ctx.lineTo(panX + base.width * zoom, sy);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (ruler) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.moveTo(ruler.x0, ruler.y0);
      ctx.lineTo(ruler.x1, ruler.y1);
      ctx.stroke();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    syncZoom();
  }
  /** Zooms to z keeping the image point under (cx, cy) css px fixed (defaults to the viewport centre). */
  function setZoom(z, cx = null, cy = null) {
    const { w, h } = viewSize();
    const px = cx ?? w / 2, py = cy ?? h / 2;
    const dx = (px - panX) / zoom, dy = (py - panY) / zoom;
    zoom = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
    fit = false;
    panX = px - dx * zoom;
    panY = py - dy * zoom;
    paint();
  }
  zoomIn.addEventListener('click', () => setZoom(ZOOMS.find((z) => z > zoom + 1e-6) ?? ZOOMS[ZOOMS.length - 1]));
  zoomOut.addEventListener('click', () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOMS[0]));
  zoomSel.addEventListener('change', () => {
    if (zoomSel.value === 'fit') {
      fitZoom();
      paint();
    } else setZoom(Number(zoomSel.value));
  });
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    setZoom(zoom * Math.pow(1.1, -e.deltaY / 100), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // -- tools
  const CURSORS = { hand: 'grab', straighten: 'crosshair', distort: 'crosshair' };
  function setTool(id) {
    tool = id;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    viewport.style.cursor = CURSORS[id] ?? 'default';
    root.dataset.tool = id;
  }
  setTool('hand');
  const setStatus = (text) => {
    status.textContent = text;
    status.title = text;
  };
  /** Sets a parameter from a tool (not from its field) and shows it. */
  function setParam(key, value) {
    current[key] = value;
    if (CUSTOM_FIELDS.some((f) => f.key === key)) customForm.set(key, value, { silent: true });
    refresh();
  }
  function autoStraighten() {
    // the horizon is looked for in the uncorrected picture, so the answer replaces the angle instead of adding to it
    const found = detectHorizon(previewBase);
    if (!found || found.confidence < 0.25) return setStatus('No horizon found: draw a line with the Straighten tool instead');
    const angle = round(foldAngle(-found.angle));
    setParam('angle', angle);
    setStatus(`Horizon tilted by ${round(found.angle, 1)}°: angle set to ${angle}°`);
  }
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = viewport.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    drag = { tool, x, y, panX, panY, clientX: e.clientX, clientY: e.clientY, distortion: Number(current.distortion) || 0 };
    viewport.setPointerCapture(e.pointerId);
    if (tool === 'hand') viewport.style.cursor = 'grabbing';
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = viewport.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag.tool === 'hand') {
      panX = drag.panX + (e.clientX - drag.clientX);
      panY = drag.panY + (e.clientY - drag.clientY);
      fit = false;
      paint();
    } else if (drag.tool === 'straighten') {
      ruler = { x0: drag.x, y0: drag.y, x1: x, y1: y };
      paint();
    } else if (drag.tool === 'distort') {
      // towards the centre pinches (corrects barrel distortion, positive), away from it bulges (negative): Photoshop's tool
      const cx = panX + (base.width * zoom) / 2, cy = panY + (base.height * zoom) / 2;
      const half = Math.hypot(base.width, base.height) * zoom * 0.5 || 1;
      const delta = (Math.hypot(x - cx, y - cy) - Math.hypot(drag.x - cx, drag.y - cy)) / half;
      setParam('distortion', Math.max(-100, Math.min(100, Math.round(drag.distortion - delta * 150))));
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    viewport.style.cursor = CURSORS[tool] ?? 'default';
    if (d.tool === 'straighten') {
      const line = ruler;
      ruler = null;
      if (e.type === 'pointerup' && line && Math.hypot(line.x1 - line.x0, line.y1 - line.y0) >= 6) {
        // the line is drawn on the corrected preview, so its tilt comes off the current angle
        const tilt = straightenAngle(line.x0, line.y0, line.x1, line.y1);
        const angle = round(foldAngle((Number(current.angle) || 0) - tilt));
        setParam('angle', angle);
        setStatus(`Line tilted by ${round(tilt, 1)}°: angle set to ${angle}°`);
      } else paint();
    }
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  // -- the bar below the preview
  pv.input.addEventListener('change', () => {
    previewOn = pv.input.checked;
    refresh();
  });
  grid.input.addEventListener('change', () => {
    prefs.grid = grid.input.checked;
    savePrefs();
    paint();
  });
  gridSize.addEventListener('input', () => {
    const v = Number(gridSize.value);
    if (!Number.isFinite(v) || v < 8) return;
    prefs.gridSize = Math.min(512, Math.round(v));
    savePrefs();
    paint();
  });
  gridColor.addEventListener('input', () => {
    prefs.gridColor = gridColor.value;
    savePrefs();
    paint();
  });
  resetBtn.addEventListener('click', () => {
    current = { ...LENS_DEFAULTS };
    enable.geo = enable.chroma = enable.vig = true;
    syncForms();
    setStatus('');
    refresh();
  });
  prevBtn.addEventListener('click', () => {
    if (!previous) return;
    current = startParams(previous);
    enable.geo = enable.chroma = enable.vig = true;
    syncForms();
    refresh();
  });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (done) return;
    if (fit) fitZoom();
    paint();
  }) : null;

  // -- open
  /** Hooks for tests and other modules while the dialog is open. */
  app.lensCorrection.session = { params: () => effective(), set: (patch) => {
    current = { ...current, ...patch };
    syncForms();
    refresh();
  } };
  const result = await app.dialogs.open({
    title: 'Lens Correction',
    content: root,
    className: 'lens-dialog',
    width: 1080,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: (dialog) => {
      dialog.style.maxWidth = 'calc(100vw - 32px)';
      // the viewport has its size only once the dialog is laid out
      requestAnimationFrame(() => {
        if (done) return;
        fitZoom();
        refresh();
        observer?.observe(viewport);
      });
    },
  });
  done = true;
  refresh.cancel();
  observer?.disconnect();
  app.lensCorrection.session = null;
  const used = effective();
  if (!result || isNeutral(used)) {
    // nothing to apply is not an edit: no history entry, nothing remembered
    session.cancel();
    return null;
  }
  try {
    const img = await app.busy('Lens Correction…', async () => processed(session, (x) => applyFilter(x, KIND, used)));
    session.commit(def.name, img, { filter: { kind: KIND, params: clone(used) } });
  } catch (err) {
    session.cancel();
    app.reportError(err, 'Lens Correction failed');
    return null;
  }
  return used;
}

export function install(app) {
  if (!app.filterEditor?.register || !FILTERS[KIND]) return;
  const def = FILTERS[KIND];
  /** Hooks for other modules and tests: open the dialog with explicit start params; `session` is set while it is open. */
  app.lensCorrection = {
    session: null,
    open: (params = null) => openLens(app, { params: params ?? {}, def, previous: app.settings.filterParams?.[KIND] ?? null }),
  };
  app.filterEditor.register(KIND, {
    // `params` are the last run's (lib/filter-ui.js) or, when a smart filter is re-edited, that filter's own.
    // A re-edit continues from its values; a new correction starts neutral and keeps only how edges are treated.
    open: (kind, { params, smart }) => {
      const previous = app.settings.filterParams?.[KIND] ?? null;
      const start = smart && smart.index >= 0 ? params : { edge: params?.edge, autoScale: params?.autoScale };
      return openLens(app, { params: start, def, previous });
    },
  });
}
