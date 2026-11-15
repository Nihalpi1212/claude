// Brushes panel (top group): brush tip presets (built-in + settings.brushPresets), sliders for
// size / hardness / spacing / angle / roundness / flow and a live stroke preview. Everything applies
// to the active painting tool (or the last one used). Also provides app.brushPicker.show(anchor, tool),
// the popover behind the options bar's brush button.
//
// Where the values live: size, hardness, flow, opacity are tool options (app.tools.setOpt); spacing is
// settings.brush.spacing (what StrokeTool.baseSettings reads); angle and roundness are stored as tool
// options too and fed to the brush engine by the small hook below (paint.js does not pass them yet).
import { icon } from '../icons.js';
import { dabCanvas } from '../brush.js';
import { StrokeTool } from '../tools/paint.js';

export const BUILTIN_BRUSHES = [
  { id: 'hard-3', name: 'Hard Round 3', size: 3, hardness: 1 },
  { id: 'hard-9', name: 'Hard Round 9', size: 9, hardness: 1 },
  { id: 'hard-19', name: 'Hard Round 19', size: 19, hardness: 1 },
  { id: 'hard-45', name: 'Hard Round 45', size: 45, hardness: 1 },
  { id: 'hard-100', name: 'Hard Round 100', size: 100, hardness: 1 },
  { id: 'soft-9', name: 'Soft Round 9', size: 9, hardness: 0 },
  { id: 'soft-21', name: 'Soft Round 21', size: 21, hardness: 0 },
  { id: 'soft-45', name: 'Soft Round 45', size: 45, hardness: 0 },
  { id: 'soft-100', name: 'Soft Round 100', size: 100, hardness: 0 },
  { id: 'soft-200', name: 'Soft Round 200', size: 200, hardness: 0 },
  { id: 'airbrush', name: 'Airbrush Soft 65 (low flow)', size: 65, hardness: 0, flow: 0.12, spacing: 0.08 },
  { id: 'airbrush-hard', name: 'Airbrush Hard 30 (low flow)', size: 30, hardness: 0.75, flow: 0.15, spacing: 0.08 },
  { id: 'ink', name: 'Ink 6', size: 6, hardness: 0.95, spacing: 0.05 },
  { id: 'calligraphy', name: 'Calligraphic 30', size: 30, hardness: 1, angle: 45, roundness: 0.2, spacing: 0.05 },
  { id: 'soft-flat', name: 'Soft Flat 50', size: 50, hardness: 0.3, angle: -30, roundness: 0.45 },
  { id: 'chalk', name: 'Chalk 36 (sparse dabs)', size: 36, hardness: 0.55, spacing: 0.45, flow: 0.55, angle: 20, roundness: 0.8 },
];

const TIP_KEYS = ['size', 'hardness', 'spacing', 'angle', 'roundness', 'flow'];
const DEFAULTS = { hardness: 0.8, spacing: 0.12, angle: 0, roundness: 1, flow: 1, opacity: 1 };

// ---- engine hook: pass angle/roundness tool options to BrushStroke (only when paint.js does not) -----------
function installTipHook() {
  const proto = StrokeTool.prototype;
  if (proto.__pigmentTipHook) return;
  const base = proto.baseSettings;
  proto.baseSettings = function baseSettingsWithTip(...args) {
    const s = base.apply(this, args);
    if (s && typeof s === 'object') {
      if (s.angle === undefined) s.angle = Number(this.opt('angle')) || 0;
      if (s.roundness === undefined) {
        const r = Number(this.opt('roundness'));
        s.roundness = Number.isFinite(r) && r > 0 ? Math.min(1, r) : 1;
      }
    }
    return s;
  };
  proto.__pigmentTipHook = true;
}

// ---- drawing helpers ----------------------------------------------------------------------------------------
function themeInk() {
  return getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#202020';
}

function drawTip(ctx, cx, cy, { size, hardness, angle = 0, roundness = 1 }, color) {
  const dab = dabCanvas(Math.max(1, size), hardness, color);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.scale(1, Math.max(0.05, Math.min(1, roundness)));
  ctx.drawImage(dab, -dab.width / 2, -dab.height / 2);
  ctx.restore();
}

/** Thumbnail of a preset tip (tips larger than the box are scaled down). */
function tipThumb(preset, px = 40) {
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(px * dpr);
  c.style.width = c.style.height = `${px - 12}px`;
  const ctx = c.getContext('2d');
  const box = (px - 14) * dpr;
  const shown = Math.min(box, preset.size * dpr);
  drawTip(ctx, c.width / 2, c.height / 2, { ...preset, size: shown }, themeInk());
  return c;
}

/** Sample stroke (an S curve) painted like the engine: dabs into a buffer at flow, shown at opacity. */
function drawStroke(canvas, s) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round((canvas.clientWidth || 260) * dpr));
  const h = Math.round(64 * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const size = Math.max(1, Math.min(s.size, 44) * dpr);
  const buf = document.createElement('canvas');
  buf.width = w;
  buf.height = h;
  const b = buf.getContext('2d');
  const ink = themeInk();
  const pad = size / 2 + 4 * dpr;
  const amp = Math.max(0, h / 2 - pad);
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    pts.push([pad + t * (w - pad * 2), h / 2 - Math.sin(t * Math.PI * 2) * amp * 0.8]);
  }
  const step = Math.max(0.5 * dpr, size * (s.spacing ?? 0.12));
  let carry = 0;
  b.globalAlpha = Math.max(0.01, s.flow ?? 1);
  drawTip(b, pts[0][0], pts[0][1], { ...s, size }, ink);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const d = Math.hypot(x1 - x0, y1 - y0);
    let t = step - carry;
    while (t <= d) {
      drawTip(b, x0 + ((x1 - x0) * t) / d, y0 + ((y1 - y0) * t) / d, { ...s, size }, ink);
      t += step;
    }
    carry = d - (t - step);
  }
  ctx.globalAlpha = Math.max(0.01, s.opacity ?? 1);
  ctx.drawImage(buf, 0, 0);
  ctx.globalAlpha = 1;
}

// ---- values -------------------------------------------------------------------------------------------------
function makeModel(app) {
  let lastPaintTool = 'brush';
  const has = (tool, key) => !!tool?.options?.some((o) => o.key === key);
  const isStroke = (tool) => tool instanceof StrokeTool;
  const target = () => {
    const a = app.tools.active;
    if (a && has(a, 'size')) return a;
    return app.tools.get(lastPaintTool) ?? app.tools.get('brush');
  };
  app.on('tool:changed', ({ tool }) => {
    if (tool && has(tool, 'size')) lastPaintTool = tool.id;
  });
  const supports = (tool, key) => {
    if (!tool) return false;
    if (key === 'angle' || key === 'roundness' || key === 'spacing') return isStroke(tool);
    return has(tool, key);
  };
  const get = (tool, key) => {
    if (!tool) return DEFAULTS[key];
    if (key === 'spacing') return app.settings.brush?.spacing ?? DEFAULTS.spacing;
    const v = tool.opt(key);
    return v === undefined || v === null ? DEFAULTS[key] ?? 0 : Number(v);
  };
  const set = (tool, key, value) => {
    if (!tool || !supports(tool, key)) return;
    if (key === 'spacing') {
      app.saveSettingsSoon({ brush: { ...(app.settings.brush ?? {}), spacing: value } });
      app.emit('tool:options', { tool: tool.id, key, value });
      return;
    }
    const spec = tool.options.find((o) => o.key === key);
    let v = value;
    if (spec) {
      if (spec.min !== undefined) v = Math.max(spec.min, v);
      if (spec.max !== undefined) v = Math.min(spec.max, v);
    }
    app.tools.setOpt(tool.id, key, v);
  };
  const current = (tool = target()) => Object.fromEntries([...TIP_KEYS, 'opacity'].map((k) => [k, get(tool, k)]));
  const applyPreset = (preset, tool = target()) => {
    if (!tool) return;
    set(tool, 'size', preset.size);
    set(tool, 'hardness', preset.hardness ?? DEFAULTS.hardness);
    set(tool, 'flow', preset.flow ?? 1);
    set(tool, 'spacing', preset.spacing ?? DEFAULTS.spacing);
    set(tool, 'angle', preset.angle ?? 0);
    set(tool, 'roundness', preset.roundness ?? 1);
    app.emit('brush:preset', { tool: tool.id, preset });
  };
  const matches = (preset, tool = target()) => {
    const c = current(tool);
    const near = (a, b, eps) => Math.abs((a ?? 0) - (b ?? 0)) <= eps;
    return near(c.size, preset.size, 0.5) && (!supports(tool, 'hardness') || near(c.hardness, preset.hardness ?? DEFAULTS.hardness, 0.005)) &&
      (!supports(tool, 'angle') || (near(c.angle, preset.angle ?? 0, 0.5) && near(c.roundness, preset.roundness ?? 1, 0.005)));
  };
  return { target, supports, get, set, current, applyPreset, matches };
}

// size slider: quadratic so small sizes get most of the travel
const SIZE_MAX = 1000;
const sizeToRange = (s) => Math.round(Math.sqrt(Math.max(0, (s - 1) / (SIZE_MAX - 1))) * 1000);
const rangeToSize = (r) => Math.max(1, Math.round(1 + (SIZE_MAX - 1) * (r / 1000) ** 2));

const SLIDERS = [
  { key: 'size', label: 'Size', unit: 'px', min: 1, max: SIZE_MAX, toRange: sizeToRange, fromRange: rangeToSize, rangeMax: 1000, show: (v) => Math.round(v), parse: (n) => Math.round(n) },
  { key: 'hardness', label: 'Hardness', unit: '%', min: 0, max: 100, show: (v) => Math.round(v * 100), parse: (n) => n / 100 },
  { key: 'spacing', label: 'Spacing', unit: '%', min: 1, max: 200, show: (v) => Math.round(v * 100), parse: (n) => n / 100 },
  { key: 'angle', label: 'Angle', unit: '°', min: -180, max: 180, show: (v) => Math.round(v), parse: (n) => Math.round(n) },
  { key: 'roundness', label: 'Roundness', unit: '%', min: 5, max: 100, show: (v) => Math.round(v * 100), parse: (n) => n / 100 },
  { key: 'flow', label: 'Flow', unit: '%', min: 1, max: 100, show: (v) => Math.round(v * 100), parse: (n) => n / 100 },
  { key: 'opacity', label: 'Opacity', unit: '%', min: 1, max: 100, show: (v) => Math.round(v * 100), parse: (n) => n / 100 },
];

function sliderRow(spec, onValue) {
  const row = document.createElement('label');
  row.className = 'prop-row';
  row.dataset.key = spec.key;
  row.innerHTML = `<span>${spec.label}</span><input type="range" min="${spec.toRange ? 0 : spec.min}" max="${spec.rangeMax ?? spec.max}" step="1" aria-label="${spec.label}"><input class="input num" type="number" min="${spec.min}" max="${spec.max}" step="1"><span class="opt-unit">${spec.unit}</span>`;
  const range = row.querySelector('input[type="range"]');
  const num = row.querySelector('input[type="number"]');
  const clampN = (n) => Math.min(spec.max, Math.max(spec.min, n));
  range.addEventListener('input', () => {
    const shown = spec.fromRange ? spec.fromRange(Number(range.value)) : Number(range.value);
    num.value = String(shown);
    onValue(spec.parse(clampN(shown)));
  });
  num.addEventListener('change', () => {
    const n = Number(num.value);
    if (!Number.isFinite(n)) return;
    const shown = clampN(n);
    num.value = String(shown);
    range.value = String(spec.toRange ? spec.toRange(shown) : shown);
    onValue(spec.parse(shown));
  });
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.dispatchEvent(new Event('change'));
  });
  return {
    row,
    sync(value, enabled) {
      row.hidden = !enabled;
      const shown = spec.show(value);
      if (document.activeElement !== num) num.value = String(shown);
      if (document.activeElement !== range) range.value = String(spec.toRange ? spec.toRange(shown) : shown);
    },
  };
}

export function install(app) {
  installTipHook();
  const model = makeModel(app);
  const userPresets = () => (Array.isArray(app.settings.brushPresets) ? app.settings.brushPresets.filter((p) => p && Number.isFinite(p.size)) : []);
  const allPresets = () => [...BUILTIN_BRUSHES, ...userPresets().map((p) => ({ ...p, user: true }))];

  // ---- panel ----------------------------------------------------------------------------------------------
  const el = document.createElement('div');
  el.className = 'brush-panel';
  el.innerHTML = `
    <div class="brush-target"><span class="muted">Applies to</span> <strong data-tool></strong></div>
    <canvas class="brush-stroke-preview" aria-label="Brush stroke preview"></canvas>
    <div class="brush-list" role="listbox" aria-label="Brush presets"></div>
    <div class="panel-section brush-sliders"></div>
    <div class="panel-footer">
      <span class="muted brush-note"></span>
      <span style="flex:1"></span>
      <button class="pbtn" data-act="delete" title="Delete the selected custom preset">${icon('trash')}</button>
      <button class="pbtn" data-act="save" title="Save the current tip as a new preset">${icon('plus')}</button>
    </div>`;
  const toolName = el.querySelector('[data-tool]');
  const preview = el.querySelector('.brush-stroke-preview');
  const list = el.querySelector('.brush-list');
  const slidersBox = el.querySelector('.brush-sliders');
  const note = el.querySelector('.brush-note');
  const delBtn = el.querySelector('[data-act="delete"]');
  const rows = SLIDERS.map((spec) => {
    const r = sliderRow(spec, (v) => {
      model.set(model.target(), spec.key, v);
      refreshSoon();
    });
    slidersBox.appendChild(r.row);
    return { spec, ...r };
  });

  function presetButton(preset, { compact = false, onPick } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'brush-item';
    b.setAttribute('role', 'option');
    b.title = preset.name;
    b.dataset.id = preset.id;
    b.appendChild(tipThumb(preset, compact ? 36 : 44));
    const n = document.createElement('span');
    n.className = 'brush-size';
    n.textContent = String(Math.round(preset.size));
    b.appendChild(n);
    b.addEventListener('click', () => (onPick ? onPick(preset) : model.applyPreset(preset)));
    if (preset.user) {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        app.dialogs.popover(b, [
          { label: 'Rename Preset…', icon: 'edit', onSelect: () => renamePreset(preset.id) },
          { label: 'Delete Preset', icon: 'trash', onSelect: () => deletePreset(preset.id) },
        ], { at: { x: e.clientX, y: e.clientY } });
      });
    }
    return b;
  }

  let selectedUser = null;
  function renderList() {
    list.replaceChildren(...allPresets().map((p) => presetButton(p, {
      onPick: (preset) => {
        selectedUser = preset.user ? preset.id : null;
        model.applyPreset(preset);
      },
    })));
    markActive();
  }

  function markActive(root = list) {
    const tool = model.target();
    for (const b of root.querySelectorAll('.brush-item')) {
      const p = allPresets().find((x) => x.id === b.dataset.id);
      const on = !!p && model.matches(p, tool);
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    delBtn.disabled = !selectedUser || !userPresets().some((p) => p.id === selectedUser);
  }

  function refresh() {
    pending = 0;
    const tool = model.target();
    toolName.textContent = tool?.name ?? 'No painting tool';
    const values = model.current(tool);
    for (const r of rows) r.sync(values[r.spec.key], model.supports(tool, r.spec.key));
    const tipOnly = tool && !(tool instanceof StrokeTool);
    note.textContent = tipOnly ? 'This tool uses size and hardness only' : '';
    drawStroke(preview, {
      size: values.size,
      hardness: model.supports(tool, 'hardness') ? values.hardness : 1,
      spacing: model.supports(tool, 'spacing') ? values.spacing : 0.12,
      angle: model.supports(tool, 'angle') ? values.angle : 0,
      roundness: model.supports(tool, 'roundness') ? values.roundness : 1,
      flow: model.supports(tool, 'flow') ? values.flow : 1,
      opacity: model.supports(tool, 'opacity') ? values.opacity : 1,
    });
    markActive();
  }
  let pending = 0;
  const refreshSoon = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      if (app.panels.isVisible('brushes')) refresh();
      else pending = 0;
    });
  };

  async function savePreset() {
    const tool = model.target();
    if (!tool) return;
    const c = model.current(tool);
    const name = await app.dialogs.prompt('Preset name', { title: 'New Brush Preset', value: `Brush ${Math.round(c.size)}` });
    if (!name) return;
    const preset = { id: `u${Date.now().toString(36)}`, name: name.trim() || 'Brush', size: c.size, hardness: c.hardness, spacing: c.spacing, angle: c.angle, roundness: c.roundness, flow: c.flow };
    app.saveSettingsSoon({ brushPresets: [...userPresets(), preset] });
    selectedUser = preset.id;
    renderList();
  }
  async function renamePreset(id) {
    const p = userPresets().find((x) => x.id === id);
    if (!p) return;
    const name = await app.dialogs.prompt('Preset name', { title: 'Rename Brush Preset', value: p.name });
    if (!name) return;
    app.saveSettingsSoon({ brushPresets: userPresets().map((x) => (x.id === id ? { ...x, name: name.trim() || x.name } : x)) });
    renderList();
  }
  function deletePreset(id) {
    app.saveSettingsSoon({ brushPresets: userPresets().filter((x) => x.id !== id) });
    if (selectedUser === id) selectedUser = null;
    renderList();
  }
  el.querySelector('[data-act="save"]').addEventListener('click', savePreset);
  delBtn.addEventListener('click', () => selectedUser && deletePreset(selectedUser));

  app.on('tool:changed', refreshSoon);
  app.on('tool:options', refreshSoon);
  app.on('settings:changed', (patch) => {
    if (patch && ('brush' in patch || 'tools' in patch)) refreshSoon();
  });
  app.on('theme:changed', () => {
    renderList();
    refreshSoon();
  });

  app.panels.register({
    id: 'brushes',
    title: 'Brushes',
    icon: 'brushes',
    element: el,
    group: 'top',
    onShow: () => {
      renderList();
      requestAnimationFrame(refresh);
    },
  });
  renderList();

  // ---- options bar popover --------------------------------------------------------------------------------
  function buildPicker(tool) {
    const box = document.createElement('div');
    box.className = 'popover-brush';
    const head = document.createElement('div');
    head.className = 'muted';
    head.textContent = tool.name;
    box.appendChild(head);
    const mk = (spec) => {
      if (!model.supports(tool, spec.key)) return null;
      const lab = document.createElement('label');
      lab.innerHTML = `<span style="width:62px">${spec.label}</span><input type="range" min="${spec.toRange ? 0 : spec.min}" max="${spec.rangeMax ?? spec.max}" step="1" aria-label="${spec.label}"><span class="val"></span>`;
      const range = lab.querySelector('input');
      const val = lab.querySelector('.val');
      const sync = () => {
        const shown = spec.show(model.get(tool, spec.key));
        range.value = String(spec.toRange ? spec.toRange(shown) : shown);
        val.textContent = `${shown}${spec.unit === 'px' ? ' px' : spec.unit}`;
      };
      range.addEventListener('input', () => {
        const shown = spec.fromRange ? spec.fromRange(Number(range.value)) : Number(range.value);
        model.set(tool, spec.key, spec.parse(shown));
        val.textContent = `${shown}${spec.unit === 'px' ? ' px' : spec.unit}`;
      });
      box.appendChild(lab);
      return sync;
    };
    const syncs = [mk(SLIDERS[0]), mk(SLIDERS[1])].filter(Boolean);
    const grid = document.createElement('div');
    grid.className = 'brush-list compact';
    grid.append(...allPresets().map((p) => presetButton(p, {
      compact: true,
      onPick: (preset) => {
        model.applyPreset(preset, tool);
        for (const s of syncs) s();
        markActive(grid);
      },
    })));
    box.appendChild(grid);
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn small';
    more.innerHTML = `${icon('brushes')} Brush settings…`;
    more.addEventListener('click', () => {
      app.dialogs.closePopover();
      app.panels.show('brushes', { reveal: true });
    });
    box.appendChild(more);
    for (const s of syncs) s();
    markActive(grid);
    return box;
  }

  app.brushPicker = {
    show(anchor, tool) {
      const t = tool && tool.options?.some((o) => o.key === 'size') ? tool : model.target();
      if (!t || !anchor) return null;
      return app.dialogs.popover(anchor, [{ type: 'custom', element: buildPicker(t) }], { closeOnSelect: false });
    },
    applyPreset: (preset, tool) => model.applyPreset(preset, tool),
    presets: allPresets,
  };
  return { refresh, model };
}
