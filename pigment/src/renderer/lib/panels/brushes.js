// The Brushes panel (top group) and app.brushPicker, the popover behind the options bar's brush button
// (brush-settings-panel; ARCHITECTURE.md "0.5 features", package 2, S1.2, S1.3, S10).
//
// The panel shows the `brushes` preset kind (lib/presets.js, C): the built-ins in their groups, the user's presets and
// groups, a row of recently used brushes, a search field and a Size slider. A click picks a preset for the target
// tool (the active painting tool, else the last one) through tool:brush-preset, so the pick is recorded with the
// preset's data and replays where the preset is gone; Ctrl/Cmd-click selects without picking. Presets drag onto
// another preset or a group heading to reorder or regroup them. A right-click renames, duplicates, exports or deletes;
// deleting a preset never removes its tip's blob (a tool or tool preset may still name it, S1.2). The menu has New
// Brush Preset… (with "Include tool settings" and "Include color", Photoshop's tool and colour capture), groups, the
// views (Thumbnails, List, Strokes), Import / Export through the preset files of S10 (.abr among them) and Reset.
//
// app.brushPicker = { show(anchor, tool), renderButton(el, tool), applyPreset(preset, tool), presets() }: renderButton
// draws the options bar's brush button (the tip and "<size> px"); show opens the popover: Size, Hardness, the angle
// and roundness control, search, the recent row and the presets.
//
// Also exported for the Brush Settings panel (lib/panels/brush-settings.js): the settings of the `brushes` namespace,
// the target tool, editToolBrush, the angle and roundness control, presetBrowser and the New Brush Preset dialog.
//
// The skeleton landed first: the tool's brush is lib/brush/tool-brush.js (S1.3), the stroke views are the engine's
// renderStrokePreview (S2.6), and the tip thumbnails draw at dabDrawSide (S2.8). BUILTIN_BRUSHES (0.4's presets, the
// `brushes` kind's built-ins under their 0.4 ids) stays exported: preset-kinds.js registers the kind with them.
import { icon, registerIcons } from '../icons.js';
import { renderTip, renderStrokePreview } from '../brush.js';
import { toolBrush, setToolBrush, supportsBrush, clampBrushToTool, prepareBrush, brushReady } from '../brush/tool-brush.js';
import { brushFromLegacy, normalizeBrush, withoutSampleData, sectionDiff } from '../brush/preset.js';
import { registerPresetKind } from '../presets.js';
import { importPresetFiles, exportPresetsDialog } from '../preset-formats.js';

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

/** The built-in groups of the `brushes` kind and the group of each 0.4 built-in. */
export const BUILTIN_BRUSH_GROUPS = [
  { id: 'general', name: 'General Brushes' },
  { id: 'airbrushes', name: 'Airbrushes' },
  { id: 'special', name: 'Special Effects Brushes' },
  { id: 'media', name: 'Pigment Media Brushes' },
];
const GROUP_OF = (id) => (id.startsWith('hard-') || id.startsWith('soft-') && id !== 'soft-flat' ? 'general' : id.startsWith('airbrush') ? 'airbrushes' : 'special');
const ctl = (type, fadeSteps = 25) => ({ type, fadeSteps });

/**
 * Pigment's own brushes beside 0.4's, made with the sections of this release (they stand in for Adobe's sets). The
 * textured ones name built-in patterns; a pattern the user removed turns the texture off for a stroke, with a toast.
 */
export const MEDIA_BRUSHES = [
  { id: 'media-pencil', name: 'Grainy Pencil 10', data: { tip: { size: 10, hardness: 0.7, spacing: 0.1 }, texture: { enabled: true, pattern: { presetId: 'noise', name: 'Noise' }, scale: 0.5, mode: 'multiply', depth: 0.75 }, noise: true, transfer: { enabled: true, flowControl: ctl('pen-pressure') } } },
  { id: 'media-canvas', name: 'Canvas Texture 45', data: { tip: { size: 45, hardness: 0.5, spacing: 0.15 }, texture: { enabled: true, pattern: { presetId: 'burlap', name: 'Burlap' }, eachTip: true, mode: 'height', depth: 0.8, minimumDepth: 0.3, depthControl: ctl('pen-pressure') } } },
  { id: 'media-watercolour', name: 'Watercolour Wash 60', data: { tip: { size: 60, hardness: 0.2, spacing: 0.1 }, wetEdges: true, transfer: { enabled: true, opacityJitter: 0.15, flowControl: ctl('pen-pressure') } } },
  { id: 'media-charcoal', name: 'Dual Charcoal 36', data: { tip: { size: 36, hardness: 0.7, spacing: 0.12 }, dualBrush: { enabled: true, mode: 'color-burn', tip: { size: 9, hardness: 0.6, spacing: 0.25 }, scatter: 2.5, bothAxes: true, count: 3, countJitter: 0.4 }, shapeDynamics: { enabled: true, angleJitter: 0.15 } } },
  { id: 'media-spatter', name: 'Spatter 30', data: { tip: { size: 30, hardness: 0.9, spacing: 0.45 }, scattering: { enabled: true, scatter: 1.5, bothAxes: true, count: 3, countJitter: 0.5 }, shapeDynamics: { enabled: true, sizeJitter: 0.7, minimumDiameter: 0.15, angleJitter: 1 } } },
  { id: 'media-dry', name: 'Dry Brush 24', data: { tip: { size: 24, hardness: 0.8, roundness: 0.6, spacing: 0.08 }, dualBrush: { enabled: true, mode: 'multiply', tip: { size: 30, hardness: 0.9, roundness: 0.15, angle: 90, spacing: 0.05 }, scatter: 0.4, count: 2 }, shapeDynamics: { enabled: true, angleControl: ctl('direction') }, noise: true } },
];

registerIcons({
  'brush-settings': '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  'lock-open': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
});

const KIND = 'brushes';
export const BRUSH_PRESET_MIME = 'application/x-pigment-brush-preset';

/** Re-registers the `brushes` kind (S1.2) with its groups, Pigment's media brushes and thumbnails. */
export function registerBrushKind() {
  registerPresetKind(KIND, {
    title: 'Brushes',
    version: 1,
    builtins: () => ({
      groups: BUILTIN_BRUSH_GROUPS.map((g) => ({ ...g })),
      presets: [
        // 0.4's Brushes panel presets under their 0.4 ids (a preset's flow is its tool flow, S1.1)
        ...BUILTIN_BRUSHES.map((b) => ({ id: b.id, name: b.name, group: GROUP_OF(b.id), data: withoutSampleData(brushFromLegacy(b)) })),
        ...MEDIA_BRUSHES.map((b) => ({ id: b.id, name: b.name, group: 'media', data: withoutSampleData(normalizeBrush(b.data)) })),
      ],
    }),
    normalize: (data) => (data && typeof data === 'object' && !Array.isArray(data) ? withoutSampleData(normalizeBrush(data)) : null),
    blobs: (data) => [data?.tip?.sample?.blob, data?.dualBrush?.tip?.sample?.blob].filter((b, i, a) => typeof b === 'string' && a.indexOf(b) === i),
    thumbnail: (preset, size = 32) => tipThumb(preset?.data, size),
  });
}

// ---- settings of the `brushes` namespace (rule 5) -----------------------------------------------------------------

export function brushPrefs(app) {
  const s = app?.settings?.brushes ?? {};
  return { locks: s.locks ?? {}, recent: Array.isArray(s.recent) ? s.recent : [], view: s.view ?? 'thumbs', collapsed: s.collapsed ?? {}, section: s.section ?? 'tip', ...s };
}
export function saveBrushPrefs(app, patch) {
  app.saveSettingsSoon({ brushes: { ...(app.settings?.brushes ?? {}), ...patch } });
}

// ---- the target tool and its brush ----------------------------------------------------------------------------

let lastPaintTool = 'brush';

/** The tool the panels edit: the active painting tool, else the last one used, else the Brush. */
export function paintTarget(app) {
  const a = app.tools?.active;
  if (a && supportsBrush(a)) return a;
  return app.tools?.get(lastPaintTool) ?? app.tools?.get('brush') ?? null;
}

/** Changes the tool's brush: mutate(preset) edits a copy, which becomes the brush (locks and tool settings left alone). */
export function editToolBrush(app, toolId, mutate) {
  if (!toolId) return null;
  const next = JSON.parse(JSON.stringify(toolBrush(app, toolId).preset));
  mutate(next);
  return setToolBrush(app, toolId, next, { respectLocks: false, includeTool: false });
}

/** The stored preset the tool's brush came from (brushPresetId), or null. */
export function sourcePreset(app, toolId) {
  const id = app.settings?.tools?.[toolId]?.brushPresetId;
  return id ? app.presets?.get(KIND, id) ?? null : null;
}

/** "Modified" (S1.3): the tool's brush differs from the preset it came from, as a pick gives that preset to the tool. */
export function isModified(app, toolId, preset = sourcePreset(app, toolId)) {
  if (!preset) return false;
  return sectionDiff(toolBrush(app, toolId).preset, clampBrushToTool(app, toolId, preset.data)).length > 0;
}

/** Picks a preset for a tool through tool:brush-preset (recorded with its data, S1.3). */
export function pickPreset(app, preset, tool = paintTarget(app)) {
  if (!preset || !tool) return null;
  // the active tool is the command's own default: a recorded pick then applies to whatever tool plays it back
  const arg = app.tools?.active?.id === tool.id ? { id: preset.id } : { id: preset.id, tool: tool.id };
  const done = app.commands.run('tool:brush-preset', arg, 'panel');
  app.emit('brush:preset', { tool: tool.id, preset });
  return done;
}

// ---- drawing ------------------------------------------------------------------------------------------------------

export function themeInk() {
  return getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#202020';
}

const pendingTips = new Set();

/** A thumbnail of a preset's tip (tips larger than the box are drawn smaller, turned and squashed as they paint). */
export function tipThumb(data, px = 40, { app = null, onReady = null } = {}) {
  const preset = normalizeBrush(data);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const c = document.createElement('canvas');
  c.width = c.height = Math.round(px * dpr);
  c.style.width = c.style.height = `${px}px`;
  const ctx = c.getContext('2d');
  const box = Math.max(2, (px - 6) * dpr);
  const tip = preset.tip;
  // the tip's longer side fills at most the box
  const shown = Math.max(1, Math.min(box, tip.size * dpr));
  if (tip.kind === 'sampled' && !brushReady(preset) && app) {
    const key = tip.sample?.hash || tip.sample?.blob;
    if (key && !pendingTips.has(key)) {
      pendingTips.add(key);
      prepareBrush(app, preset).then(() => onReady?.()).finally(() => pendingTips.delete(key));
    }
  }
  const img = renderTip(tip, shown, themeInk());
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((tip.angle * Math.PI) / 180);
  ctx.scale(tip.flipX ? -1 : 1, Math.max(0.05, tip.roundness) * (tip.flipY ? -1 : 1));
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
  return c;
}

/** A small stroke of the preset (the Strokes view and the Brush Settings preview), painted by the engine. */
export function strokeThumb(app, data, { width = 120, height = 28, paint = {}, maxSize = 22 } = {}) {
  const p = normalizeBrush(data);
  const k = Math.min(1, maxSize / Math.max(1, p.tip.size));
  p.tip.size = Math.max(1, p.tip.size * k);
  p.dualBrush.tip.size = Math.max(1, p.dualBrush.tip.size * k);
  const dpr = window.devicePixelRatio || 1;
  const canvas = renderStrokePreview(p, { opacity: 1, flow: 1, ...paint, app }, { width, height, scale: dpr, color: themeInk() });
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return canvas;
}

// ---- the angle and roundness control ------------------------------------------------------------------------------

/**
 * Photoshop's angle and roundness control: an ellipse in a circle; drag the arrow (or anywhere) to turn it, the two
 * dots on its short axis to squash it. → { element, set(angle, roundness) }; onChange(angle, roundness) while dragging.
 */
export function angleRoundnessControl({ size = 84, onChange = () => {} } = {}) {
  const c = document.createElement('canvas');
  c.className = 'bs-angle-control';
  c.setAttribute('role', 'slider');
  c.setAttribute('aria-label', 'Angle and roundness');
  c.tabIndex = 0;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  let angle = 0, roundness = 1;
  const R = size / 2 - 6;
  const draw = () => {
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const fg = themeInk();
    g.strokeStyle = fg;
    g.globalAlpha = 0.35;
    g.beginPath();
    g.arc(size / 2, size / 2, R, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.save();
    g.translate(size / 2, size / 2);
    // screen y grows down: Photoshop's angle turns counter-clockwise
    g.rotate((-angle * Math.PI) / 180);
    g.beginPath();
    g.ellipse(0, 0, R, Math.max(1, R * roundness), 0, 0, Math.PI * 2);
    g.globalAlpha = 0.18;
    g.fillStyle = fg;
    g.fill();
    g.globalAlpha = 1;
    g.stroke();
    // the arrow along the angle
    g.beginPath();
    g.moveTo(-R, 0);
    g.lineTo(R + 4, 0);
    g.moveTo(R + 4, 0);
    g.lineTo(R - 2, -4);
    g.moveTo(R + 4, 0);
    g.lineTo(R - 2, 4);
    g.stroke();
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2b7fff';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(0, s * R * roundness, 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  let mode = null;
  const local = (e) => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left - size / 2, y: e.clientY - r.top - size / 2 };
  };
  const apply = (e) => {
    const p = local(e);
    if (mode === 'round') {
      // the distance along the short axis
      const a = (-angle * Math.PI) / 180;
      const v = -p.x * Math.sin(a) + p.y * Math.cos(a);
      roundness = Math.max(0.01, Math.min(1, Math.abs(v) / R));
    } else {
      let deg = Math.round((Math.atan2(-p.y, p.x) * 180) / Math.PI);
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      angle = deg > 180 ? deg - 360 : deg;
    }
    draw();
    onChange(angle, Math.round(roundness * 100) / 100);
  };
  c.addEventListener('pointerdown', (e) => {
    const p = local(e);
    const a = (-angle * Math.PI) / 180;
    const dots = [-1, 1].map((s) => ({ x: -Math.sin(a) * s * R * roundness, y: Math.cos(a) * s * R * roundness }));
    mode = dots.some((d) => Math.hypot(d.x - p.x, d.y - p.y) < 7) ? 'round' : 'angle';
    c.setPointerCapture?.(e.pointerId);
    apply(e);
    e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (mode) apply(e);
  });
  const up = () => {
    mode = null;
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') angle = Math.max(-180, Math.min(180, angle + (e.key === 'ArrowLeft' ? step : -step)));
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') roundness = Math.max(0.01, Math.min(1, roundness + (e.key === 'ArrowUp' ? 0.01 : -0.01) * step));
    else return;
    e.preventDefault();
    draw();
    onChange(angle, Math.round(roundness * 100) / 100);
  });
  return {
    element: c,
    set(a, r) {
      if (mode) return;
      angle = Number(a) || 0;
      roundness = Math.max(0.01, Math.min(1, Number(r) || 1));
      c.setAttribute('aria-valuetext', `${Math.round(angle)}°, ${Math.round(roundness * 100)}%`);
      draw();
    },
  };
}

// ---- sliders ----------------------------------------------------------------------------------------------------

const SIZE_MAX = 5000;
// quadratic, so small sizes get most of the travel
const sizeToRange = (s, max) => Math.round(Math.sqrt(Math.max(0, (s - 1) / (max - 1))) * 1000);
const rangeToSize = (r, max) => Math.max(1, Math.round(1 + (max - 1) * (r / 1000) ** 2));

/**
 * A labelled slider with a number field: { label, unit, min, max, step, value: () => n, set(n), quadratic?, show?, parse? }.
 * → { row, sync(enabled) }. `show` turns the value into what the field shows (percent), `parse` back.
 */
export function sliderRow({ label, unit = '', min = 0, max = 100, step = 1, quadratic = false, value, set, show = (v) => v, parse = (n) => n, key = '' }) {
  const row = document.createElement('label');
  row.className = 'prop-row bs-slider';
  if (key) row.dataset.key = key;
  row.innerHTML = `<span class="bs-label"></span><input type="range" step="1"><input class="input num" type="number"><span class="opt-unit"></span>`;
  row.querySelector('.bs-label').textContent = label;
  row.querySelector('.opt-unit').textContent = unit;
  const range = row.querySelector('input[type="range"]');
  const num = row.querySelector('input[type="number"]');
  range.setAttribute('aria-label', label);
  num.setAttribute('aria-label', label);
  const limits = () => ({ lo: typeof min === 'function' ? min() : min, hi: typeof max === 'function' ? max() : max });
  const toRange = (n) => {
    const { lo, hi } = limits();
    return quadratic ? sizeToRange(n, hi) : n;
  };
  const fromRange = (r) => {
    const { hi } = limits();
    return quadratic ? rangeToSize(r, hi) : r;
  };
  const clampN = (n) => {
    const { lo, hi } = limits();
    return Math.min(hi, Math.max(lo, n));
  };
  const round = (n) => Math.round(n / step) * step;
  range.addEventListener('input', () => {
    const shown = clampN(fromRange(Number(range.value)));
    num.value = String(round(shown));
    set(parse(shown));
  });
  const commit = () => {
    const n = Number(num.value);
    if (!Number.isFinite(n)) return;
    const shown = clampN(n);
    num.value = String(round(shown));
    range.value = String(toRange(shown));
    set(parse(shown));
  };
  num.addEventListener('change', commit);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
  });
  return {
    row,
    sync(enabled = true) {
      const { lo, hi } = limits();
      range.min = String(quadratic ? 0 : lo);
      range.max = String(quadratic ? 1000 : hi);
      range.step = quadratic ? '1' : String(step);
      num.min = String(lo);
      num.max = String(hi);
      num.step = String(step);
      const shown = clampN(show(value()));
      if (document.activeElement !== num) num.value = String(round(shown));
      if (document.activeElement !== range) range.value = String(toRange(shown));
      range.disabled = num.disabled = !enabled;
      row.classList.toggle('disabled', !enabled);
    },
  };
}

// ---- the preset browser (panel and popover) -----------------------------------------------------------------------

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * The `brushes` presets in collapsible groups with an optional search field and recent row:
 * presetBrowser(app, { compact, search, recent, view: () => view, onPick(preset, e), onContext(preset, e) })
 * → { element, refresh(), mark(), selection(), select(ids), destroy() }.
 */
export function presetBrowser(app, opts = {}) {
  const compact = !!opts.compact;
  const root = el('div', `brush-browser${compact ? ' compact' : ''}`);
  let query = '';
  let selected = new Set();
  if (opts.search !== false) {
    const search = el('input', 'input brush-search');
    search.type = 'search';
    search.placeholder = 'Search brushes';
    search.setAttribute('aria-label', 'Search brushes');
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      render();
    });
    root.appendChild(search);
  }
  const recentRow = el('div', 'brush-recent');
  recentRow.setAttribute('aria-label', 'Recent brushes');
  if (opts.recent !== false) root.appendChild(recentRow);
  const list = el('div', `brush-list${compact ? ' compact' : ''}`);
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Brush presets');
  root.appendChild(list);

  const view = () => (compact ? 'thumbs' : opts.view?.() ?? 'thumbs');
  const target = () => opts.target?.() ?? paintTarget(app);

  const item = (preset, { recent = false } = {}) => {
    const b = el('button', 'brush-item');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.title = preset.name;
    b.dataset.id = preset.id;
    const v = recent ? 'thumbs' : view();
    b.dataset.view = v;
    const px = compact || recent ? 32 : 40;
    b.appendChild(tipThumb(preset.data, px, { app, onReady: () => render() }));
    b.appendChild(el('span', 'brush-size', String(Math.round(preset.data?.tip?.size ?? 0))));
    if (v !== 'thumbs') b.appendChild(el('span', 'brush-name', preset.name));
    if (v === 'strokes') b.appendChild(strokeThumb(app, preset.data, { width: 110, height: 28 }));
    b.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (selected.has(preset.id)) selected.delete(preset.id);
        else selected.add(preset.id);
        mark();
        return;
      }
      selected = new Set([preset.id]);
      if (opts.onPick) opts.onPick(preset, e);
      else pickPreset(app, preset, target());
      mark();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selected.has(preset.id)) selected = new Set([preset.id]);
      mark();
      opts.onContext?.(preset, e);
    });
    if (!recent && !compact) {
      b.draggable = true;
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(BRUSH_PRESET_MIME, preset.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      b.addEventListener('dragover', (e) => {
        if (!query && e.dataTransfer.types.includes(BRUSH_PRESET_MIME)) e.preventDefault();
      });
      b.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData(BRUSH_PRESET_MIME);
        if (!id || id === preset.id || query) return;
        e.preventDefault();
        movePreset(app, id, preset.group ?? null, preset.id);
      });
    }
    return b;
  };

  const groupBlock = (g, members) => {
    const box = el('div', 'brush-group');
    box.dataset.group = g.id;
    const collapsed = !query && !!brushPrefs(app).collapsed[g.id];
    const head = el('button', 'brush-group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.innerHTML = `${icon(collapsed ? 'chevron-right' : 'chevron-down')}<span></span><span class="muted">${members.length}</span>`;
    head.children[1].textContent = g.name;
    head.addEventListener('click', () => {
      const c = { ...brushPrefs(app).collapsed };
      if (c[g.id]) delete c[g.id];
      else c[g.id] = true;
      saveBrushPrefs(app, { collapsed: c });
      render();
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.onGroupContext?.(g, e);
    });
    head.addEventListener('dragover', (e) => {
      if (!query && e.dataTransfer.types.includes(BRUSH_PRESET_MIME)) e.preventDefault();
    });
    head.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData(BRUSH_PRESET_MIME);
      if (!id || query) return;
      e.preventDefault();
      movePreset(app, id, g.id, null);
    });
    box.appendChild(head);
    if (!collapsed) {
      const grid = el('div', `brush-group-items${view() === 'thumbs' ? '' : ' rows'}`);
      grid.append(...members.map((p) => item(p)));
      box.appendChild(grid);
    }
    return box;
  };

  function render() {
    const all = app.presets?.list(KIND) ?? [];
    const match = (p) => !query || p.name.toLowerCase().includes(query);
    const groups = app.presets?.groups(KIND) ?? [];
    const known = new Set(groups.map((g) => g.id));
    const loose = all.filter((p) => (!p.group || !known.has(p.group)) && match(p));
    const parts = [];
    if (loose.length) {
      const grid = el('div', `brush-group-items${view() === 'thumbs' ? '' : ' rows'}`);
      grid.append(...loose.map((p) => item(p)));
      parts.push(grid);
    }
    // groups in their tree order, children after their parent (one level of nesting is shown flat)
    for (const g of groups) {
      const members = all.filter((p) => p.group === g.id && match(p));
      if (query && !members.length) continue;
      parts.push(groupBlock(g, members));
    }
    if (!parts.length) parts.push(el('div', 'muted brush-empty', query ? 'No brush matches' : 'No brushes'));
    list.replaceChildren(...parts);
    if (opts.recent !== false) {
      const recent = brushPrefs(app).recent.map((id) => app.presets?.get(KIND, id)).filter(Boolean).slice(0, compact ? 7 : 9);
      recentRow.replaceChildren(...recent.map((p) => item(p, { recent: true })));
      recentRow.hidden = !recent.length;
    }
    mark();
  }

  function mark() {
    const tool = target();
    const id = tool ? app.settings?.tools?.[tool.id]?.brushPresetId ?? null : null;
    const modified = id && tool ? isModified(app, tool.id) : false;
    for (const b of root.querySelectorAll('.brush-item')) {
      const on = b.dataset.id === id;
      b.classList.toggle('active', on);
      b.classList.toggle('modified', on && modified);
      b.classList.toggle('selected', selected.has(b.dataset.id));
      b.setAttribute('aria-selected', String(on));
    }
  }

  // a browser in a popover (transient) lets go of its listeners once the popover has closed
  const live = () => {
    if (!opts.transient || root.isConnected || !wasConnected) {
      wasConnected ||= root.isConnected;
      return true;
    }
    destroy();
    return false;
  };
  let wasConnected = false;
  const onPresets = (d) => {
    if (d?.kind === KIND && live()) render();
  };
  // the Strokes view paints textures: draw again once a pattern's pixels have arrived
  let patternFrame = 0;
  const onPatterns = (d) => {
    if (view() !== 'strokes' || d?.reason !== 'load' || patternFrame || !live()) return;
    patternFrame = requestAnimationFrame(() => {
      patternFrame = 0;
      render();
    });
  };
  const offs = [app.on('presets:changed', onPresets), app.on('patterns:changed', onPatterns), app.on('tool:options', () => live() && mark()), app.on('tool:changed', () => live() && mark())];
  function destroy() {
    for (const off of offs.splice(0)) off?.();
  }
  render();
  return {
    element: root,
    refresh: render,
    mark,
    selection: () => [...selected].filter((id) => app.presets?.get(KIND, id)),
    select(ids) {
      selected = new Set(ids ?? []);
      mark();
    },
    destroy,
  };
}

async function movePreset(app, id, group, beforeId) {
  await app.presets.ready(KIND);
  const members = app.presets.list(KIND, { group }).filter((p) => p.id !== id);
  const index = beforeId ? Math.max(0, members.findIndex((p) => p.id === beforeId)) : members.length;
  app.presets.move(KIND, id, { group, index });
}

// ---- New Brush Preset and the other library actions ---------------------------------------------------------------

/**
 * New Brush Preset… : the tool's brush becomes a preset of `brushes`, with the tool's opacity, flow, mode and smoothing
 * ("Include tool settings") and the foreground colour ("Include color") when asked; the tool then names it as its
 * preset. Returns the new preset, or null.
 */
export async function newBrushPresetDialog(app, tool = paintTarget(app)) {
  if (!tool) return null;
  await app.presets.ready(KIND);
  const cur = toolBrush(app, tool.id);
  const box = el('div', 'bs-new-preset');
  box.innerHTML = `
    <label class="prop-row"><span>Name</span><input class="input" data-k="name"></label>
    <label class="prop-row"><span>Group</span><select class="select" data-k="group"><option value="">None</option></select></label>
    <label class="check-row"><input type="checkbox" data-k="tool"> Include tool settings (opacity, flow, mode, smoothing)</label>
    <label class="check-row"><input type="checkbox" data-k="color"> Include color</label>`;
  const name = box.querySelector('[data-k="name"]');
  name.value = `Brush ${Math.round(cur.preset.tip.size)}`;
  const sel = box.querySelector('[data-k="group"]');
  for (const g of app.presets.groups(KIND)) {
    const o = el('option', '', g.name);
    o.value = g.id;
    sel.appendChild(o);
  }
  const ok = await app.dialogs.open({ title: 'New Brush Preset', content: box, width: 380, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }], onOpen: () => name.select() });
  if (!ok) return null;
  const data = JSON.parse(JSON.stringify(cur.preset));
  const tool2 = {};
  if (box.querySelector('[data-k="tool"]').checked) {
    for (const k of ['opacity', 'flow', 'blend', 'smoothing']) if (tool.options?.some((o) => o.key === k) && cur.paint[k] !== undefined) tool2[k] = cur.paint[k];
  }
  if (box.querySelector('[data-k="color"]').checked && /^#[0-9a-f]{6}$/i.test(app.settings?.foreground ?? '')) tool2.color = app.settings.foreground.toLowerCase();
  data.tool = Object.keys(tool2).length ? tool2 : null;
  let preset;
  try {
    preset = app.presets.add(KIND, { name: name.value.trim() || 'Brush', data: withoutSampleData(data), group: sel.value || null });
  } catch (err) {
    app.reportError?.(err, 'Could not add the brush preset');
    return null;
  }
  // the tool's brush now comes from it (Photoshop selects the new preset)
  setToolBrush(app, tool.id, preset.data, { respectLocks: false, includeTool: false, presetId: preset.id });
  return preset;
}

async function renamePreset(app, preset) {
  const name = await app.dialogs.prompt('Brush name', { title: 'Rename Brush', value: preset.name });
  if (!name?.trim()) return;
  await app.presets.ready(KIND);
  app.presets.update(KIND, preset.id, { name: name.trim() });
}

async function duplicatePreset(app, preset) {
  await app.presets.ready(KIND);
  return app.presets.add(KIND, { name: `${preset.name} copy`, data: preset.data, group: preset.group ?? null });
}

/** Deletes presets (a built-in is hidden until Reset). Their tips' blobs stay: tools and tool presets may name them. */
async function deletePresets(app, ids) {
  if (!ids?.length) return;
  await app.presets.ready(KIND);
  const ok = await app.dialogs.confirm(ids.length === 1 ? `Delete the brush "${app.presets.get(KIND, ids[0])?.name ?? ''}"?` : `Delete ${ids.length} brushes?`, { title: 'Delete Brushes', okLabel: 'Delete', danger: true });
  if (!ok) return;
  app.presets.remove(KIND, ids);
  saveBrushPrefs(app, { recent: brushPrefs(app).recent.filter((id) => !ids.includes(id)) });
}

async function newGroup(app) {
  const name = await app.dialogs.prompt('Group name', { title: 'New Brush Group', value: 'Group' });
  if (!name?.trim()) return null;
  await app.presets.ready(KIND);
  return app.presets.addGroup(KIND, { name: name.trim() });
}

async function renameGroup(app, g) {
  const name = await app.dialogs.prompt('Group name', { title: 'Rename Group', value: g.name });
  if (!name?.trim()) return;
  await app.presets.ready(KIND);
  app.presets.renameGroup(KIND, g.id, name.trim());
}

async function deleteGroup(app, g) {
  await app.presets.ready(KIND);
  const n = app.presets.list(KIND, { group: g.id }).length;
  const keep = n ? await app.dialogs.open({ title: 'Delete Group', content: `<p>Delete the group "${g.name.replace(/[<&]/g, '')}"?</p>`, buttons: [{ label: 'Cancel', value: null }, { label: `Delete group and ${n} brush${n === 1 ? '' : 'es'}`, value: 'all', danger: true }, { label: 'Keep the brushes', value: 'keep', primary: true }] }) : 'keep';
  if (!keep) return;
  app.presets.removeGroup(KIND, g.id, { keepPresets: keep === 'keep' });
}

async function resetBrushes(app) {
  const ok = await app.dialogs.confirm('Replace the brushes with the default set? Your own brushes and groups are removed (export them first to keep them).', { title: 'Reset Brushes', okLabel: 'Reset', danger: true });
  if (!ok) return;
  await app.presets.ready(KIND);
  app.presets.reset(KIND);
}

/** The items of a preset's right-click menu. */
function presetMenuItems(app, preset, browser) {
  const ids = browser.selection();
  const many = ids.length > 1;
  return [
    { label: 'Rename Brush…', icon: 'edit', disabled: many, onSelect: () => renamePreset(app, preset) },
    { label: 'Duplicate Brush', icon: 'copy', disabled: many, onSelect: () => duplicatePreset(app, preset) },
    { label: many ? `Export ${ids.length} Brushes…` : 'Export Brush…', onSelect: () => exportPresetsDialog(app, KIND, many ? ids : [preset.id], { defaultName: many ? 'Brushes' : preset.name }) },
    { type: 'separator' },
    { label: many ? `Delete ${ids.length} Brushes` : 'Delete Brush', icon: 'trash', onSelect: () => deletePresets(app, many ? ids : [preset.id]) },
  ];
}

/**
 * Pigment's media brushes are built-ins this release adds by re-registering the kind (S1.2). The store appends a new
 * built-in after the last entry of its group, so on a profile whose file was read first (or that 0.4's presets were
 * migrated into) they would land after the user's own presets. Once per profile they move up to follow the other
 * built-ins, through the store's order as tool-brush.js's migration does (presets.js is not edited in 0.5); a user's
 * later reordering is kept.
 */
function placeMediaBrushes(app) {
  if (brushPrefs(app).mediaPlaced) return;
  const s = app.presets.state(KIND);
  const ids = new Set(MEDIA_BRUSHES.map((b) => b.id));
  const firstUser = s.order.findIndex((e) => e.preset && !e.preset.builtin);
  if (firstUser >= 0) {
    const late = s.order.filter((e, i) => i > firstUser && e.ref && ids.has(e.ref));
    if (late.length) {
      s.order = s.order.filter((e) => !late.includes(e));
      s.order.splice(firstUser, 0, ...late);
      app.presets.changedState(s, 'move', late.map((e) => e.ref));
    }
  }
  saveBrushPrefs(app, { mediaPlaced: true });
}

// ---- install --------------------------------------------------------------------------------------------------

export function install(app) {
  registerBrushKind();
  {
    const a = app.tools?.active;
    if (a && supportsBrush(a)) lastPaintTool = a.id;
  }
  app.on('tool:changed', ({ tool }) => {
    if (tool && supportsBrush(tool)) lastPaintTool = tool.id;
  });
  // the recent row: every pick of a stored preset, whoever ran it (the panels, keys, actions)
  app.on('command:done', (ev) => {
    if (ev?.id !== 'tool:brush-preset') return;
    const id = typeof ev.arg === 'string' ? ev.arg : ev.arg?.id;
    if (typeof id !== 'string' || !app.presets?.get(KIND, id)) return;
    saveBrushPrefs(app, { recent: [id, ...brushPrefs(app).recent.filter((x) => x !== id)].slice(0, 12) });
    for (const b of browsers) b.refresh();
  });
  const browsers = new Set();

  // ---- the panel ----------------------------------------------------------------------------------------------
  const root = el('div', 'brush-panel');
  const head = el('div', 'brush-target');
  head.innerHTML = '<span class="muted">Applies to</span> <strong data-tool></strong>';
  const toolName = head.querySelector('[data-tool]');
  const sizeRow = sliderRow({
    key: 'size', label: 'Size', unit: 'px', min: 1, quadratic: true,
    max: () => paintTarget(app)?.options?.find((o) => o.key === 'size')?.max ?? SIZE_MAX,
    value: () => toolBrush(app, paintTarget(app)?.id ?? 'brush').preset.tip.size,
    set: (v) => {
      const t = paintTarget(app);
      if (t) app.tools.setOpt(t.id, 'size', Math.round(v));
    },
  });
  sizeRow.row.classList.add('brush-size-row');
  const browser = presetBrowser(app, {
    view: () => brushPrefs(app).view,
    onContext: (preset, e) => app.dialogs.popover(e.currentTarget, presetMenuItems(app, preset, browser), { at: { x: e.clientX, y: e.clientY } }),
    onGroupContext: (g, e) => app.dialogs.popover(e.currentTarget, [
      { label: 'Rename Group…', icon: 'edit', onSelect: () => renameGroup(app, g) },
      { label: 'Delete Group…', icon: 'trash', onSelect: () => deleteGroup(app, g) },
      { type: 'separator' },
      { label: 'New Group…', icon: 'folder', onSelect: () => newGroup(app) },
    ], { at: { x: e.clientX, y: e.clientY } }),
  });
  browsers.add(browser);
  const footer = el('div', 'panel-footer');
  footer.innerHTML = `
    <button class="pbtn" data-act="settings" title="Brush Settings (F5)">${icon('brush-settings')}</button>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="group" title="New group">${icon('folder')}</button>
    <button class="pbtn" data-act="save" title="New brush preset from the current brush">${icon('plus')}</button>
    <button class="pbtn" data-act="delete" title="Delete the selected brushes">${icon('trash')}</button>
    <button class="pbtn" data-act="menu" title="Brushes panel menu">${icon('more')}</button>`;
  root.append(head, sizeRow.row, browser.element, footer);

  const VIEWS = [['thumbs', 'Thumbnails'], ['list', 'List'], ['strokes', 'Strokes']];
  function menu(anchor) {
    const ids = browser.selection();
    const view = brushPrefs(app).view;
    app.dialogs.popover(anchor, [
      { label: 'New Brush Preset…', icon: 'plus', onSelect: () => newBrushPresetDialog(app) },
      { label: 'New Brush Group…', icon: 'folder', onSelect: () => newGroup(app) },
      { label: 'Delete Brushes', icon: 'trash', disabled: !ids.length, onSelect: () => deletePresets(app, ids) },
      { type: 'separator' },
      ...VIEWS.map(([id, label]) => ({ label, checked: view === id, onSelect: () => {
        saveBrushPrefs(app, { view: id });
        browser.refresh();
      } })),
      { type: 'separator' },
      { label: 'Import Brushes…', onSelect: () => importPresetFiles(app, { kinds: [KIND] }) },
      { label: 'Export Selected Brushes…', disabled: !ids.length, onSelect: () => exportPresetsDialog(app, KIND, ids) },
      { label: 'Export All Brushes…', onSelect: () => exportPresetsDialog(app, KIND, null) },
      { type: 'separator' },
      { label: 'Brush Settings', icon: 'brush-settings', onSelect: () => app.commands.run('window:panel-brush-settings', null, 'panel') },
      { label: 'Reset Brushes…', icon: 'refresh', onSelect: () => resetBrushes(app) },
    ], { align: 'right' });
  }
  footer.querySelector('[data-act="settings"]').addEventListener('click', () => app.commands.run('window:panel-brush-settings', null, 'panel'));
  footer.querySelector('[data-act="group"]').addEventListener('click', () => newGroup(app));
  footer.querySelector('[data-act="save"]').addEventListener('click', () => newBrushPresetDialog(app));
  footer.querySelector('[data-act="delete"]').addEventListener('click', () => deletePresets(app, browser.selection()));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  let frame = 0;
  function refresh() {
    frame = 0;
    const t = paintTarget(app);
    toolName.textContent = t?.name ?? 'No painting tool';
    sizeRow.sync(!!t);
    browser.mark();
  }
  const refreshSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      if (app.panels.isVisible('brushes')) refresh();
      else frame = 0;
    });
  };
  app.on('tool:changed', refreshSoon);
  app.on('tool:options', refreshSoon);
  app.on('theme:changed', () => browser.refresh());

  app.panels.register({
    id: 'brushes', title: 'Brushes', icon: 'brushes', element: root, group: 'top',
    onShow: () => {
      browser.refresh();
      requestAnimationFrame(refresh);
    },
  });
  app.presets?.ready(KIND).then(() => {
    placeMediaBrushes(app);
    browser.refresh();
  }).catch(() => {});

  // ---- the options bar's popover and button -------------------------------------------------------------------
  function buildPicker(tool) {
    const box = el('div', 'popover-brush');
    box.appendChild(el('div', 'muted', tool.name));
    const rows = [];
    const has = (k) => !!tool.options?.some((o) => o.key === k);
    rows.push(sliderRow({
      key: 'size', label: 'Size', unit: 'px', min: 1, quadratic: true, max: () => tool.options?.find((o) => o.key === 'size')?.max ?? SIZE_MAX,
      value: () => toolBrush(app, tool.id).preset.tip.size,
      set: (v) => app.tools.setOpt(tool.id, 'size', Math.round(v)),
    }));
    if (has('hardness')) {
      rows.push(sliderRow({
        key: 'hardness', label: 'Hardness', unit: '%', min: 0, max: 100,
        value: () => toolBrush(app, tool.id).preset.tip.hardness, show: (v) => Math.round(v * 100), parse: (n) => n / 100,
        set: (v) => app.tools.setOpt(tool.id, 'hardness', v),
      }));
    }
    for (const r of rows) box.appendChild(r.row);
    let quick = null;
    if (supportsBrush(tool) === 'full') {
      quick = angleRoundnessControl({ size: 64, onChange: (angle, roundness) => editToolBrush(app, tool.id, (p) => Object.assign(p.tip, { angle, roundness })) });
      const wrap = el('div', 'bs-quick');
      wrap.append(quick.element, el('span', 'muted', 'Drag the arrow to turn the tip, the dots to squash it'));
      box.appendChild(wrap);
    }
    const sync = () => {
      for (const r of rows) r.sync(true);
      const tip = toolBrush(app, tool.id).preset.tip;
      quick?.set(tip.angle, tip.roundness);
    };
    const pickerBrowser = presetBrowser(app, {
      compact: true,
      transient: true,
      target: () => tool,
      onPick: (preset) => {
        Promise.resolve(pickPreset(app, preset, tool)).then(() => {
          sync();
          pickerBrowser.mark();
        });
      },
    });
    box.appendChild(pickerBrowser.element);
    const buttons = el('div', 'bs-popover-buttons');
    const more = el('button', 'btn small');
    more.type = 'button';
    more.innerHTML = `${icon('brush-settings')} Brush Settings…`;
    more.addEventListener('click', () => {
      app.dialogs.closePopover();
      app.commands.run('window:panel-brush-settings', null, 'panel');
    });
    const save = el('button', 'btn small');
    save.type = 'button';
    save.innerHTML = `${icon('plus')} New Preset…`;
    save.addEventListener('click', () => {
      app.dialogs.closePopover();
      newBrushPresetDialog(app, tool);
    });
    buttons.append(more, save);
    box.appendChild(buttons);
    sync();
    const off = app.on('tool:options', ({ tool: id } = {}) => {
      if (id !== tool.id) return;
      if (!box.isConnected) {
        off?.();
        pickerBrowser.destroy();
        return;
      }
      sync();
    });
    return box;
  }

  app.brushPicker = {
    show(anchor, tool) {
      const t = tool && supportsBrush(tool) ? tool : paintTarget(app);
      if (!t || !anchor) return null;
      return app.dialogs.popover(anchor, [{ type: 'custom', element: buildPicker(t) }], { closeOnSelect: false });
    },
    /** The options bar's brush button: the tip as it paints and its size. */
    renderButton(b, tool) {
      const t = tool ?? paintTarget(app);
      if (!b || !t) return;
      const preset = toolBrush(app, t.id).preset;
      const thumb = tipThumb(preset, 22, { app, onReady: () => this.renderButton(b, t) });
      thumb.classList.add('brush-button-tip');
      const label = el('span', '', `${Math.round(preset.tip.size)} px`);
      b.replaceChildren(thumb, label);
      b.title = 'Brush preset picker';
      b.classList.toggle('modified', isModified(app, t.id));
    },
    /** A stored preset (or its id) through tool:brush-preset; any other preset (0.4's flat ones too) straight to the tool. */
    applyPreset(preset, tool) {
      const t = tool ?? paintTarget(app);
      const stored = app.presets.get(KIND, typeof preset === 'string' ? preset : preset?.id);
      if (stored) return pickPreset(app, stored, t);
      if (!t || !preset) return null;
      return setToolBrush(app, t.id, preset.data ?? brushFromLegacy(preset), { presetId: null });
    },
    presets: () => app.presets.list(KIND),
  };
  return { refresh, browser };
}
