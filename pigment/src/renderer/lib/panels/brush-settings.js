// The Brush Settings panel (F5; brush-settings-panel's MODULES entry, ARCHITECTURE.md "0.5 features", package 2).
//
// Photoshop's Brush Settings for the target tool's brush (the active painting tool, else the last one; each painting
// tool has its own, S1.3): the sections of BRUSH_SECTIONS down the left with their enable boxes and locks, the
// selected section's controls on the right, and a live stroke preview by the engine (renderStrokePreview) at the
// bottom. Brush Tip Shape has the tips of the loaded presets, Size (with Restore Original Size), Flip X / Y, the angle
// and roundness control, Hardness and Spacing (its box off: one dab per pointer sample). Build-up, Smoothing and
// Protect Texture are flags of the brush that the engine and setToolBrush apply; Noise and Wet Edges are flags too.
//
// Every edit writes the tool's brush through setToolBrush (respectLocks off: an edit is not a pick). Locks
// (settings.brushes.locks) keep a section when another preset is picked (setToolBrush with respectLocks). The menu has
// Clear Brush Controls, Unlock All Settings, Copy Texture to Other Tools and New Brush Preset….
//
// Loading this file registers the package's dab modifiers (Brush Pose, Texture, Dual Brush, Noise, Wet Edges:
// lib/brush/extras.js, texture.js, dual.js) and install() the .abr preset file format (lib/brush/abr.js). Registering
// the panel registers window:panel-brush-settings (panels.js), which takes the skeleton stub's place (rule 3).
import { icon } from '../icons.js';
import { createWidget, hasWidget } from '../fields.js';
import { toolBrush, setToolBrush, supportsBrush } from '../brush/tool-brush.js';
import { BRUSH_SECTIONS, TEXTURE_MODES, DUAL_MODES, clearControls, normalizeBrush } from '../brush/preset.js';
import { ENGINE } from '../brush.js';
import { registerAbrFormat } from '../brush/abr.js';
import '../brush/extras.js';
import '../brush/texture.js';
import '../brush/dual.js';
import { brushPrefs, saveBrushPrefs, paintTarget, editToolBrush, sourcePreset, isModified, angleRoundnessControl, sliderRow, tipThumb, strokeThumb, newBrushPresetDialog } from './brushes.js';

const KIND = 'brushes';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- the fields of each section -------------------------------------------------------------------------------

const CONTROL_LABELS = { off: 'Off', fade: 'Fade', 'pen-pressure': 'Pen Pressure', 'pen-tilt': 'Pen Tilt', 'stylus-wheel': 'Stylus Wheel', rotation: 'Rotation', 'initial-direction': 'Initial Direction', direction: 'Direction', 'initial-rotation': 'Initial Rotation' };
const AMOUNT_CONTROLS = ['off', 'fade', 'pen-pressure', 'pen-tilt', 'stylus-wheel', 'rotation'];
const ANGLE_CONTROLS = ['off', 'fade', 'pen-pressure', 'pen-tilt', 'stylus-wheel', 'initial-direction', 'direction', 'rotation', 'initial-rotation'];
const MODE_LABELS = { multiply: 'Multiply', subtract: 'Subtract', darken: 'Darken', overlay: 'Overlay', 'color-dodge': 'Color Dodge', 'color-burn': 'Color Burn', 'linear-burn': 'Linear Burn', 'hard-mix': 'Hard Mix', 'linear-height': 'Linear Height', height: 'Height' };

const pct = (key, label, { min = 0, max = 100, when } = {}) => ({ type: 'slider', key, label, unit: '%', min, max, show: (v) => Math.round(v * 100), parse: (n) => n / 100, when });
const num = (key, label, { min, max, unit = '', step = 1, when } = {}) => ({ type: 'slider', key, label, unit, min, max, step, when });
const check = (key, label, { when } = {}) => ({ type: 'check', key, label, when });
const control = (key, label = 'Control', { choices = AMOUNT_CONTROLS, when } = {}) => ({ type: 'control', key, label, choices, when });
const select = (key, label, choices, labels) => ({ type: 'select', key, label, choices, labels });

const eachTip = (s) => !!s.eachTip;
const FIELDS = {
  shapeDynamics: [
    pct('sizeJitter', 'Size Jitter'), control('sizeControl'), pct('minimumDiameter', 'Minimum Diameter'), pct('tiltScale', 'Tilt Scale', { max: 200, when: (s) => s.sizeControl.type === 'pen-tilt' }),
    pct('angleJitter', 'Angle Jitter'), control('angleControl', 'Control', { choices: ANGLE_CONTROLS }),
    pct('roundnessJitter', 'Roundness Jitter'), control('roundnessControl'), pct('minimumRoundness', 'Minimum Roundness', { min: 1 }),
    check('flipXJitter', 'Flip X Jitter'), check('flipYJitter', 'Flip Y Jitter'), check('brushProjection', 'Brush Projection'),
  ],
  scattering: [
    pct('scatter', 'Scatter', { max: 1000 }), check('bothAxes', 'Both Axes'), control('scatterControl'),
    num('count', 'Count', { min: 1, max: 16 }), pct('countJitter', 'Count Jitter'), control('countControl'),
  ],
  texture: [
    { type: 'pattern', key: 'pattern', label: 'Pattern' },
    check('invert', 'Invert'), pct('scale', 'Scale', { min: 1, max: 1000 }), num('brightness', 'Brightness', { min: -150, max: 150 }), num('contrast', 'Contrast', { min: -50, max: 100 }),
    check('eachTip', 'Texture Each Tip'), select('mode', 'Mode', TEXTURE_MODES, MODE_LABELS), pct('depth', 'Depth'),
    pct('minimumDepth', 'Minimum Depth', { when: eachTip }), pct('depthJitter', 'Depth Jitter', { when: eachTip }), control('depthControl', 'Control', { when: eachTip }),
  ],
  dualBrush: [
    select('mode', 'Mode', DUAL_MODES, MODE_LABELS), check('flip', 'Flip'), { type: 'tips', key: 'tip', label: 'Dual tip' },
    { type: 'slider', key: 'tip.size', label: 'Size', unit: 'px', min: 1, max: 5000, quadratic: true }, pct('tip.spacing', 'Spacing', { min: 1, max: 1000 }),
    pct('scatter', 'Scatter', { max: 1000 }), check('bothAxes', 'Both Axes'), num('count', 'Count', { min: 1, max: 16 }), pct('countJitter', 'Count Jitter'),
  ],
  colorDynamics: [
    check('perTip', 'Apply Per Tip'), pct('fbJitter', 'Foreground/Background Jitter'), control('fbControl'),
    pct('hueJitter', 'Hue Jitter'), pct('saturationJitter', 'Saturation Jitter'), pct('brightnessJitter', 'Brightness Jitter'), pct('purity', 'Purity', { min: -100 }),
  ],
  transfer: [
    pct('opacityJitter', 'Opacity Jitter'), control('opacityControl'), pct('minimumOpacity', 'Minimum'),
    pct('flowJitter', 'Flow Jitter'), control('flowControl'), pct('minimumFlow', 'Minimum'),
  ],
  brushPose: [
    pct('tiltX', 'Tilt X', { min: -100 }), pct('tiltY', 'Tilt Y', { min: -100 }), check('overrideTilt', 'Override Tilt'),
    num('rotation', 'Rotation', { min: 0, max: 360, unit: '°' }), check('overrideRotation', 'Override Rotation'),
    pct('pressure', 'Pressure', { min: 1 }), check('overridePressure', 'Override Pressure'),
  ],
};

const FLAG_NOTES = {
  noise: 'Adds grain to the soft edges of each tip. Hard tips show little or none.',
  wetEdges: 'Paint builds up along the edges of the stroke and the inside stays lighter, like watercolour.',
  buildUp: 'Paint keeps building up while the pointer rests on the canvas (the airbrush of the options bar).',
  smoothCurves: 'Smooths the curves of fast strokes.',
  protectTexture: 'Keeps the current texture pattern and scale on every brush preset that has a texture.',
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}
const isFlag = (id) => ['noise', 'wetEdges', 'buildUp', 'smoothCurves', 'protectTexture'].includes(id);
const sectionOn = (preset, id) => (id === 'tip' ? true : isFlag(id) ? !!preset[id] : !!preset[id]?.enabled);

/** The distinct tips of the loaded presets (Brush Tip Shape's list and the dual tip's), in the presets' order. */
function presetTips(app) {
  const seen = new Set();
  const out = [];
  for (const p of app.presets?.list(KIND) ?? []) {
    const t = p.data?.tip;
    if (!t) continue;
    const key = t.kind === 'sampled' ? `s:${t.sample?.hash || t.sample?.blob}` : `c:${t.size}:${t.hardness}:${t.angle}:${t.roundness}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ preset: p, tip: t });
  }
  return out;
}

/** The tip a pick from the list gives: the preset's tip shape, its sample and spacing. */
function pickedTip(tip) {
  const t = clone(tip);
  delete t.extras;
  return t;
}

// ---- the panel --------------------------------------------------------------------------------------------------

export function install(app) {
  registerAbrFormat(app);

  const root = el('div', 'brush-settings-panel');
  const top = el('div', 'bs-top');
  const brushesBtn = el('button', 'btn small', 'Brushes');
  brushesBtn.type = 'button';
  brushesBtn.title = 'Show the Brushes panel';
  brushesBtn.addEventListener('click', () => app.commands.run('window:panel-brushes', null, 'panel'));
  const toolName = el('span', 'bs-tool muted');
  top.append(brushesBtn, toolName);
  const main = el('div', 'bs-main');
  const list = el('div', 'bs-sections');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Brush settings sections');
  const pane = el('div', 'bs-pane');
  pane.setAttribute('role', 'tabpanel');
  main.append(list, pane);
  const note = el('div', 'bs-note muted');
  const previewBox = el('div', 'bs-preview');
  previewBox.setAttribute('aria-label', 'Brush stroke preview');
  const footer = el('div', 'panel-footer');
  footer.innerHTML = `
    <button class="pbtn" data-act="clear" title="Clear Brush Controls: every section off, the tip kept">${icon('refresh')}</button>
    <span style="flex:1"></span>
    <button class="pbtn" data-act="save" title="New brush preset from these settings">${icon('plus')}</button>
    <button class="pbtn" data-act="menu" title="Brush Settings panel menu">${icon('more')}</button>`;
  root.append(top, main, note, previewBox, footer);

  const target = () => paintTarget(app);
  const brush = () => toolBrush(app, target()?.id ?? 'brush').preset;
  const support = () => supportsBrush(target());
  const edit = (mutate) => {
    const t = target();
    if (t) editToolBrush(app, t.id, mutate);
  };

  // ---- the section list ---------------------------------------------------------------------------------------
  const rows = new Map();
  for (const s of BRUSH_SECTIONS) {
    const row = el('div', 'bs-section');
    row.dataset.section = s.id;
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', `Use ${s.label}`);
    box.hidden = !s.toggle;
    box.addEventListener('change', () => {
      edit((p) => {
        if (isFlag(s.id)) p[s.id] = box.checked;
        else p[s.id].enabled = box.checked;
      });
      if (!isFlag(s.id)) select(s.id);
    });
    const label = el('button', 'bs-section-label', s.label);
    label.type = 'button';
    label.setAttribute('role', 'tab');
    label.addEventListener('click', () => select(s.id));
    const lock = el('button', 'bs-lock');
    lock.type = 'button';
    lock.addEventListener('click', () => {
      const locks = { ...brushPrefs(app).locks };
      if (locks[s.id]) delete locks[s.id];
      else locks[s.id] = true;
      saveBrushPrefs(app, { locks });
      refresh();
    });
    row.append(box, label, lock);
    list.appendChild(row);
    rows.set(s.id, { row, box, label, lock, def: s });
  }

  let current = brushPrefs(app).section;
  if (!BRUSH_SECTIONS.some((s) => s.id === current)) current = 'tip';
  function select(id) {
    current = id;
    saveBrushPrefs(app, { section: id });
    build();
    refresh();
  }

  // ---- the selected section's controls --------------------------------------------------------------------------
  let syncs = [];
  let builtFor = null;

  function fieldControl(section, f) {
    const value = () => getPath(brush()[section], f.key);
    const setValue = (v) => edit((p) => setPath(p[section], f.key, v));
    switch (f.type) {
      case 'slider': {
        const s = sliderRow({ key: f.key, label: f.label, unit: f.unit, min: f.min, max: f.max, step: f.step ?? 1, quadratic: !!f.quadratic, value, set: setValue, show: f.show, parse: f.parse });
        return { el: s.row, sync: () => s.sync(true) };
      }
      case 'check': {
        const row = el('label', 'check-row');
        row.dataset.key = f.key;
        const box = el('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => setValue(box.checked));
        row.append(box, document.createTextNode(` ${f.label}`));
        return { el: row, sync: () => (box.checked = !!value()) };
      }
      case 'select': {
        const row = el('label', 'prop-row');
        row.dataset.key = f.key;
        row.appendChild(el('span', 'bs-label', f.label));
        const sel = el('select', 'select');
        for (const c of f.choices) {
          const o = el('option', '', f.labels?.[c] ?? c);
          o.value = c;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => setValue(sel.value));
        row.appendChild(sel);
        return { el: row, sync: () => (sel.value = value()) };
      }
      case 'control': {
        const row = el('div', 'prop-row bs-control');
        row.dataset.key = f.key;
        row.appendChild(el('span', 'bs-label', f.label));
        const sel = el('select', 'select');
        sel.setAttribute('aria-label', f.label);
        for (const c of f.choices) {
          const o = el('option', '', CONTROL_LABELS[c]);
          o.value = c;
          sel.appendChild(o);
        }
        const steps = el('input', 'input num');
        steps.type = 'number';
        steps.min = '1';
        steps.max = '9999';
        steps.title = 'Fade steps';
        steps.setAttribute('aria-label', 'Fade steps');
        const write = () => setValue({ type: sel.value, fadeSteps: Math.max(1, Math.min(9999, Math.round(Number(steps.value) || 25))) });
        sel.addEventListener('change', write);
        steps.addEventListener('change', write);
        row.append(sel, steps);
        return {
          el: row,
          sync: () => {
            const c = value() ?? { type: 'off', fadeSteps: 25 };
            sel.value = c.type;
            if (document.activeElement !== steps) steps.value = String(c.fadeSteps);
            steps.hidden = c.type !== 'fade';
          },
        };
      }
      case 'pattern': {
        const row = el('div', 'prop-row bs-pattern');
        row.appendChild(el('span', 'bs-label', f.label));
        if (!hasWidget('pattern')) {
          row.appendChild(el('span', 'muted', 'The pattern library is not available'));
          return { el: row, sync: () => {} };
        }
        const widget = createWidget('pattern', { emptyLabel: 'Current pattern', manage: true }, {
          app, value: value(),
          onChange: (ref) => setValue(ref ? (ref.presetId ? { presetId: ref.presetId, name: ref.name ?? '' } : { presetId: null, name: ref.name ?? '', dataUrl: ref.dataUrl }) : null),
        });
        row.appendChild(widget.element);
        return { el: row, sync: () => widget.set?.(value(), { silent: true }) };
      }
      case 'tips': {
        const grid = el('div', 'bs-tips');
        grid.setAttribute('aria-label', f.label);
        const fill = () => {
          grid.replaceChildren(...presetTips(app).map(({ preset, tip }) => {
            const b = el('button', 'bs-tip');
            b.type = 'button';
            b.title = preset.name;
            b.appendChild(tipThumb({ tip }, 28, { app, onReady: fill }));
            b.addEventListener('click', () => edit((p) => {
              const size = p.dualBrush.tip.size;
              p.dualBrush.tip = { ...pickedTip(tip), size };
            }));
            return b;
          }));
        };
        fill();
        return { el: grid, sync: () => {} };
      }
      default:
        return { el: el('span'), sync: () => {} };
    }
  }

  function buildTip() {
    const tipOnly = support() === 'tip';
    const parts = [];
    if (!tipOnly) {
      const grid = el('div', 'bs-tips');
      grid.setAttribute('aria-label', 'Brush tips');
      const fill = () => {
        grid.replaceChildren(...presetTips(app).map(({ preset, tip }) => {
          const b = el('button', 'bs-tip');
          b.type = 'button';
          b.title = preset.name;
          b.dataset.id = preset.id;
          b.appendChild(tipThumb({ tip }, 28, { app, onReady: fill }));
          b.addEventListener('click', () => edit((p) => {
            p.tip = pickedTip(tip);
          }));
          return b;
        }));
      };
      fill();
      parts.push({ el: grid, sync: () => {} });
    }
    const size = sliderRow({
      key: 'size', label: 'Size', unit: 'px', min: 1, quadratic: true, max: () => target()?.options?.find((o) => o.key === 'size')?.max ?? 5000,
      value: () => brush().tip.size, set: (v) => edit((p) => (p.tip.size = Math.round(v))),
    });
    const restore = el('button', 'btn small bs-restore', 'Restore Original Size');
    restore.type = 'button';
    restore.addEventListener('click', () => {
      const src = sourcePreset(app, target()?.id);
      if (src) edit((p) => (p.tip.size = src.data.tip.size));
    });
    parts.push({ el: size.row, sync: () => size.sync(true) }, {
      el: restore,
      sync: () => {
        const src = sourcePreset(app, target()?.id);
        restore.hidden = !src || src.data.tip.size === brush().tip.size;
      },
    });
    if (!tipOnly) {
      const flips = el('div', 'bs-flips');
      const flip = (key, label) => {
        const row = el('label', 'check-row');
        row.dataset.key = key;
        const box = el('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => edit((p) => (p.tip[key] = box.checked)));
        row.append(box, document.createTextNode(` ${label}`));
        flips.appendChild(row);
        return () => (box.checked = !!brush().tip[key]);
      };
      const fx = flip('flipX', 'Flip X'), fy = flip('flipY', 'Flip Y');
      const quick = angleRoundnessControl({ size: 76, onChange: (angle, roundness) => edit((p) => Object.assign(p.tip, { angle, roundness })) });
      const qwrap = el('div', 'bs-quick');
      qwrap.append(flips, quick.element);
      parts.push({ el: qwrap, sync: () => {
        fx();
        fy();
        quick.set(brush().tip.angle, brush().tip.roundness);
      } });
      const angle = sliderRow({ key: 'angle', label: 'Angle', unit: '°', min: -180, max: 180, value: () => brush().tip.angle, set: (v) => edit((p) => (p.tip.angle = v)) });
      const round = sliderRow({ key: 'roundness', label: 'Roundness', unit: '%', min: 1, max: 100, value: () => brush().tip.roundness, show: (v) => Math.round(v * 100), parse: (n) => n / 100, set: (v) => edit((p) => (p.tip.roundness = v)) });
      parts.push({ el: angle.row, sync: () => angle.sync(true) }, { el: round.row, sync: () => round.sync(true) });
    }
    const hard = sliderRow({ key: 'hardness', label: 'Hardness', unit: '%', min: 0, max: 100, value: () => brush().tip.hardness, show: (v) => Math.round(v * 100), parse: (n) => n / 100, set: (v) => edit((p) => (p.tip.hardness = v)) });
    parts.push({ el: hard.row, sync: () => hard.sync(brush().tip.kind !== 'sampled' && !!target()?.options?.some((o) => o.key === 'hardness')) });
    if (!tipOnly) {
      const spacingRow = el('div', 'bs-spacing');
      const on = el('label', 'check-row');
      on.dataset.key = 'spacingOn';
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => edit((p) => (p.tip.spacingOn = box.checked)));
      on.append(box, document.createTextNode(' Spacing'));
      const sp = sliderRow({ key: 'spacing', label: '', unit: '%', min: 1, max: 1000, value: () => brush().tip.spacing, show: (v) => Math.round(v * 100), parse: (n) => n / 100, set: (v) => edit((p) => (p.tip.spacing = v)) });
      spacingRow.append(on, sp.row);
      parts.push({ el: spacingRow, sync: () => {
        box.checked = brush().tip.spacingOn;
        sp.sync(brush().tip.spacingOn);
      } });
    }
    return parts;
  }

  function build() {
    const t = target();
    builtFor = `${t?.id ?? ''}|${current}|${support()}`;
    let parts = [];
    pane.replaceChildren();
    pane.dataset.section = current;
    const title = el('div', 'bs-pane-title', BRUSH_SECTIONS.find((s) => s.id === current)?.label ?? '');
    pane.appendChild(title);
    if (current === 'tip') parts = buildTip();
    else if (FIELDS[current]) parts = FIELDS[current].map((f) => ({ ...fieldControl(current, f), when: f.when }));
    else parts = [{ el: el('p', 'muted bs-flag-note', FLAG_NOTES[current] ?? ''), sync: () => {} }];
    for (const p of parts) pane.appendChild(p.el);
    syncs = parts;
  }

  // ---- refresh ------------------------------------------------------------------------------------------------
  let frame = 0;
  let previewKey = '';
  function refresh() {
    frame = 0;
    const t = target();
    const sup = support();
    if (`${t?.id ?? ''}|${current}|${sup}` !== builtFor) build();
    const preset = brush();
    toolName.textContent = t ? `${t.name}${isModified(app, t.id) ? ' (modified)' : ''}` : 'No painting tool';
    const locks = brushPrefs(app).locks;
    for (const [id, r] of rows) {
      r.box.checked = sectionOn(preset, id);
      // a DabTool (Blur, Dodge, the healing tools…) uses the tip's size and hardness only in 0.5 (S1.3)
      const usable = sup === 'full' || id === 'tip';
      r.box.disabled = !usable;
      r.label.disabled = !usable;
      r.row.classList.toggle('selected', id === current);
      r.label.setAttribute('aria-selected', String(id === current));
      r.lock.innerHTML = icon(locks[id] ? 'lock' : 'lock-open');
      r.lock.classList.toggle('on', !!locks[id]);
      r.lock.title = locks[id] ? `${r.def.label} is locked: picking a preset keeps it` : `Lock ${r.def.label}: picking a preset keeps it`;
      r.lock.setAttribute('aria-pressed', String(!!locks[id]));
    }
    if (sup === 'tip' && current !== 'tip') {
      current = 'tip';
      build();
    }
    for (const p of syncs) {
      p.sync();
      if (p.when) p.el.hidden = !p.when(preset[current]);
    }
    note.textContent = sup === 'tip' ? 'This tool uses the tip\'s size and hardness only' : current !== 'tip' && !isFlag(current) && !preset[current]?.enabled ? 'Tick the box to use this section' : '';
    drawPreview(preset, t);
  }

  function drawPreview(preset, t) {
    const paint = t ? toolBrush(app, t.id).paint : {};
    const width = Math.max(60, Math.round(previewBox.clientWidth || 240) - 2);
    const key = JSON.stringify([preset, paint.opacity, paint.flow, paint.pressureSize, paint.pressureOpacity, width]);
    if (key === previewKey) return;
    previewKey = key;
    const p = normalizeBrush(preset);
    // the preview shows the brush's character, not its full size
    const canvas = strokeThumb(app, p, { width, height: 64, maxSize: 40, paint: { opacity: paint.opacity ?? 1, flow: paint.flow ?? 1, pressureSize: !!paint.pressureSize, pressureOpacity: !!paint.pressureOpacity } });
    previewBox.replaceChildren(canvas);
  }

  const refreshSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      if (app.panels.isVisible('brush-settings')) refresh();
      else frame = 0;
    });
  };
  app.on('tool:changed', refreshSoon);
  app.on('tool:options', refreshSoon);
  app.on('theme:changed', () => {
    previewKey = '';
    builtFor = null;
    refreshSoon();
  });
  app.on('presets:changed', (d) => {
    if (d?.kind !== KIND) return;
    builtFor = null;
    refreshSoon();
  });
  app.on('patterns:changed', () => {
    previewKey = '';
    refreshSoon();
  });

  // ---- the menu -----------------------------------------------------------------------------------------------
  const clearBrushControls = () => edit((p) => Object.assign(p, clearControls(p)));
  const copyTexture = () => {
    const t = target();
    if (!t) return;
    const texture = clone(brush().texture);
    let n = 0;
    for (const tool of app.tools.tools.values()) {
      if (tool.id === t.id || supportsBrush(tool) !== 'full') continue;
      editToolBrush(app, tool.id, (p) => (p.texture = clone(texture)));
      n++;
    }
    app.dialogs.toast(`The texture was copied to ${n} painting tools`, { kind: 'success', timeout: 1800 });
  };
  function menu(anchor) {
    const locks = brushPrefs(app).locks;
    app.dialogs.popover(anchor, [
      { label: 'Clear Brush Controls', onSelect: clearBrushControls },
      { label: 'Unlock All Settings', disabled: !Object.values(locks).some(Boolean), onSelect: () => {
        saveBrushPrefs(app, { locks: {} });
        refresh();
      } },
      { label: 'Copy Texture to Other Tools', disabled: support() !== 'full', onSelect: copyTexture },
      { type: 'separator' },
      { label: 'New Brush Preset…', icon: 'plus', onSelect: () => newBrushPresetDialog(app, target()) },
      { label: 'Brushes', icon: 'brushes', onSelect: () => app.commands.run('window:panel-brushes', null, 'panel') },
    ], { align: 'right' });
  }
  footer.querySelector('[data-act="clear"]').addEventListener('click', clearBrushControls);
  footer.querySelector('[data-act="save"]').addEventListener('click', () => newBrushPresetDialog(app, target()));
  footer.querySelector('[data-act="menu"]').addEventListener('click', (e) => menu(e.currentTarget));

  app.panels.register({
    id: 'brush-settings',
    title: 'Brush Settings',
    icon: 'brush-settings',
    element: root,
    group: 'top',
    onShow: () => {
      previewKey = '';
      requestAnimationFrame(refresh);
    },
  });
  build();
  return {
    refresh,
    select,
    clearBrushControls,
    copyTexture,
    engine: ENGINE.id,
  };
}

/** For tests and other panels: whether a section of a preset is on (the enable box). */
export { sectionOn };
/** A tool's brush with Clear Brush Controls applied (as the panel's button does), without writing it. */
export function clearedBrush(app, toolId) {
  return clearControls(toolBrush(app, toolId).preset);
}
/** Writes a section of one tool's brush into another's (Copy Texture to Other Tools uses it for `texture`). */
export function copySection(app, fromTool, toTool, id) {
  const from = toolBrush(app, fromTool).preset;
  return setToolBrush(app, toTool, { ...toolBrush(app, toTool).preset, [id]: clone(from[id]) }, { respectLocks: false, includeTool: false });
}
