// Shape fill and stroke paints (shapes-live, ARCHITECTURE.md "0.4 features", H and G.2): Photoshop's Fill and Stroke
// popups (None, Solid Color with recently used colours and the swatches, Gradient with the gradient presets and the
// placement fields, Pattern with the pattern presets, Scale and Angle), as
//   - the `paint` field widget (H; value: a Paint, `spec.allow` limits the types; registered here, replacing the
//     skeleton's stub) for dialog forms and panels,
//   - the option kinds `shape-fill` and `shape-stroke` of the shape and pen tools' options bar (they read and write the
//     tool options fillOn / fillPaint and strokeOn / strokeColor / strokePaint of the active tool).
// Inside a dialog the popup opens inline (a popover sits under a dialog's backdrop, as the gradient widget does).
//
// Every paint this file reports is ready for layer data: gradient colour references resolved (G.1), pattern paints
// with their runtime canvas and a `dataUrl` of the pixels, so a .pigment file or an action that stores the paint as
// JSON keeps the pattern (path-ops.js drawablePaint decodes it again).
import { registerWidget, createWidget, gradientCss } from './fields.js';
import { icon } from './icons.js';
import { normalizeGradient } from '../../shared/pixels/gradient-model.js';
import { DEFAULT_SWATCHES } from '../../shared/defaults.js';
import { gradientPicker, resolvedPresetData } from './gradient-picker.js';
import { patternPicker } from './pattern-picker.js';
import { makePatternPaint, paintRef } from './pattern-paint.js';
import { placementOf } from './gradient-widget.js';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const PAINT_TYPES = ['none', 'solid', 'gradient', 'pattern'];
const TYPE_LABELS = { none: 'No Color', solid: 'Solid Color', gradient: 'Gradient', pattern: 'Pattern' };
const TYPE_ICONS = { none: 'close', solid: 'color', gradient: 'gradient', pattern: 'pattern-stamp' };
const RECENT_MAX = 12;
const hex6 = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : '#000000');
const colors = (app) => ({ fg: app?.settings?.foreground ?? '#000000', bg: app?.settings?.background ?? '#ffffff' });

/** A pattern paint with its pixels as `dataUrl` (the canvas stays; JSON keeps the URL). */
export function withPatternData(paint) {
  if (paint?.type !== 'pattern' || !paint.pattern?.canvas || typeof paint.pattern.dataUrl === 'string') return paint;
  const ref = paintRef(paint);
  return ref ? { ...paint, pattern: { ...paint.pattern, dataUrl: ref.dataUrl } } : paint;
}

/** A copy of a paint for layer data (G.2): gradients resolved and deep-copied, pattern canvases kept by reference. */
export function readyPaint(app, paint) {
  if (!paint) return null;
  if (paint.type === 'solid') return { type: 'solid', color: hex6(paint.color) };
  if (paint.type === 'gradient') return { type: 'gradient', gradient: normalizeGradient(paint.gradient ?? {}, colors(app)) };
  if (paint.type === 'pattern') return withPatternData({ ...paint, pattern: { ...(paint.pattern ?? {}) } });
  return null;
}

/** CSS background of a paint's swatch. */
export function paintSwatchCss(app, paint) {
  if (!paint) return '';
  if (paint.type === 'solid') return hex6(paint.color);
  if (paint.type === 'gradient') {
    try {
      return gradientCss(normalizeGradient(paint.gradient ?? {}, colors(app)), colors(app));
    } catch {
      return '#808080';
    }
  }
  if (paint.type === 'pattern') {
    const url = paint.pattern?.dataUrl ?? (paint.pattern?.canvas ? paintRef(paint)?.dataUrl : null);
    return url ? `url("${url}") 0 0 / 16px repeat` : '#808080';
  }
  return '';
}

/** The recently used colours of the shape popups (settings.shapes.recentColors), newest first. */
export function recentColors(app) {
  const list = app?.settings?.shapes?.recentColors;
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string').slice(0, RECENT_MAX) : [];
}

export function rememberColor(app, color) {
  if (!app?.saveSettingsSoon) return;
  const c = hex6(color);
  const list = [c, ...recentColors(app).filter((x) => x !== c)].slice(0, RECENT_MAX);
  app.saveSettingsSoon({ shapes: { ...(app.settings.shapes ?? {}), recentColors: list } });
}

/**
 * The body of a fill or stroke popup: a row of type buttons and the chosen type's choices. `onChange(paint)` reports
 * every choice (null = None). Returns { element, set(paint), destroy() }.
 */
export function paintPanel(app, { value = null, allow = PAINT_TYPES, role = 'fill', onChange = () => {} } = {}) {
  let current = value;
  let typeShown = current ? current.type : 'none';
  let sub = [];
  const root = el('div', 'sl-paint-panel');
  root.dataset.role = role;
  const types = el('div', 'sl-paint-types');
  const body = el('div', 'sl-paint-body');
  root.append(types, body);
  const report = (p) => {
    current = p;
    if (p?.type === 'solid') rememberColor(app, p.color);
    onChange(p);
  };
  const cleanup = () => {
    for (const s of sub) s.destroy?.();
    sub = [];
  };
  const swatch = (c, title) => {
    const b = el('button', 'sl-color');
    b.type = 'button';
    b.dataset.color = hex6(c);
    b.title = title ?? hex6(c);
    b.style.background = hex6(c);
    b.addEventListener('click', () => {
      report({ type: 'solid', color: hex6(c) });
      render();
    });
    return b;
  };
  function render() {
    cleanup();
    body.replaceChildren();
    for (const b of types.children) b.setAttribute('aria-pressed', String(b.dataset.paintType === typeShown));
    if (typeShown === 'none') {
      body.appendChild(el('div', 'muted sl-paint-note', role === 'stroke' ? 'No stroke' : 'No fill'));
      return;
    }
    if (typeShown === 'solid') {
      const color = current?.type === 'solid' ? hex6(current.color) : hex6(colors(app).fg);
      const top = el('div', 'sl-solid-top');
      const input = el('input', 'sl-color-input');
      input.type = 'color';
      input.dataset.key = 'paint-color';
      input.value = color;
      input.title = 'Color';
      input.addEventListener('input', () => report({ type: 'solid', color: input.value }));
      input.addEventListener('change', () => render());
      const picker = el('button', 'btn small', 'Color Picker…');
      picker.type = 'button';
      picker.addEventListener('click', async () => {
        const c = await app.pickColor?.(color, { title: role === 'stroke' ? 'Pick a solid color for the stroke' : 'Pick a solid color for the fill' });
        if (c) {
          report({ type: 'solid', color: hex6(c) });
          render();
        }
      });
      top.append(input, picker);
      body.appendChild(top);
      const recent = recentColors(app);
      if (recent.length) {
        body.appendChild(el('div', 'sl-paint-title muted', 'Recently used colors'));
        const r = el('div', 'sl-colors sl-recent');
        for (const c of recent) r.appendChild(swatch(c));
        body.appendChild(r);
      }
      const palette = Array.isArray(app.settings?.swatches) && (app.settings.swatchesEdited || app.settings.swatches.length) ? app.settings.swatches : DEFAULT_SWATCHES;
      body.appendChild(el('div', 'sl-paint-title muted', 'Swatches'));
      const g = el('div', 'sl-colors sl-swatches');
      for (const c of palette.slice(0, 60)) g.appendChild(swatch(typeof c === 'string' ? c : c?.color ?? '#000000', typeof c === 'object' ? c?.name : undefined));
      body.appendChild(g);
      for (const b of body.querySelectorAll('.sl-color')) b.classList.toggle('current', b.dataset.color === color);
      return;
    }
    if (typeShown === 'gradient') {
      const g = current?.type === 'gradient' ? current.gradient : null;
      const picker = gradientPicker(app, {
        size: 28,
        className: 'sl-gradient-picker',
        onPick: (preset) => {
          const def = resolvedPresetData(app, preset);
          // a picked preset keeps the placement chosen so far (style, angle, scale)
          report({ type: 'gradient', gradient: { ...def, ...placementOf(current?.type === 'gradient' ? current.gradient : { kind: 'linear', angle: 90 }) } });
          widget.set(current.gradient, { silent: true });
        },
      });
      // the bar opens the Gradient Editor; Style, Angle, Scale, Reverse, Dither and Align with Layer under it
      const widget = createWidget('gradient', { compact: true, placement: true }, {
        app,
        value: g ?? normalizeGradient({ kind: 'linear', angle: 90, stops: [{ pos: 0, color: colors(app).fg }, { pos: 1, color: colors(app).bg }] }, colors(app)),
        onChange: (v) => report({ type: 'gradient', gradient: v }),
      });
      sub.push(picker, widget);
      body.append(picker.element, widget.element);
      if (!g) report({ type: 'gradient', gradient: widget.get() });
      return;
    }
    if (typeShown === 'pattern') {
      const p = current?.type === 'pattern' ? current.pattern : null;
      const make = (canvas, extra = {}) => withPatternData(makePatternPaint(canvas, { scale: p?.scale ?? 1, angle: p?.angle ?? 0, link: p?.link ?? true, origin: p?.origin ?? [0, 0], presetId: extra.presetId ?? p?.presetId, name: extra.name ?? p?.name }));
      const picker = patternPicker(app, {
        size: 28,
        selected: p?.presetId ?? null,
        className: 'sl-pattern-picker',
        onPick: (entry) => {
          if (!entry?.canvas) return;
          report(make(entry.canvas, { presetId: entry.id, name: entry.name }));
          syncFields();
        },
      });
      sub.push(picker);
      body.appendChild(picker.element);
      const fields = el('div', 'sl-pattern-fields');
      const numberField = (key, label, unit, value, min, max) => {
        const l = el('label', 'sl-num');
        l.appendChild(el('span', 'muted', label));
        const i = el('input', 'input num');
        i.type = 'number';
        i.dataset.key = key;
        i.min = String(min);
        i.max = String(max);
        i.value = String(value);
        l.append(i, el('span', 'opt-unit', unit));
        return { l, i };
      };
      const scale = numberField('pattern-scale', 'Scale', '%', Math.round((p?.scale ?? 1) * 1000) / 10, 1, 1000);
      const angle = numberField('pattern-angle', 'Angle', '°', p?.angle ?? 0, -180, 180);
      const apply = () => {
        if (current?.type !== 'pattern') return;
        const s = Math.max(1, Math.min(1000, Number(scale.i.value) || 100)) / 100;
        const a = Math.max(-180, Math.min(180, Number(angle.i.value) || 0));
        report({ ...current, pattern: { ...current.pattern, scale: s, angle: a } });
      };
      scale.i.addEventListener('change', apply);
      angle.i.addEventListener('change', apply);
      fields.append(scale.l, angle.l);
      body.appendChild(fields);
      const syncFields = () => {
        scale.i.value = String(Math.round((current?.pattern?.scale ?? 1) * 1000) / 10);
        angle.i.value = String(current?.pattern?.angle ?? 0);
      };
      if (!p) {
        // switching to Pattern starts from the current pattern of the library
        const entry = app.patterns?.current?.();
        if (entry?.canvas) report(make(entry.canvas, { presetId: entry.id, name: entry.name }));
      }
    }
  }
  for (const t of allow) {
    const b = el('button', 'pbtn sl-paint-type');
    b.type = 'button';
    b.dataset.paintType = t;
    b.title = TYPE_LABELS[t];
    b.innerHTML = icon(TYPE_ICONS[t]);
    b.addEventListener('click', () => {
      if (typeShown === t) return;
      typeShown = t;
      if (t === 'none') report(null);
      else if (t === 'solid') report({ type: 'solid', color: hex6(current?.type === 'solid' ? current.color : colors(app).fg) });
      render();
    });
    types.appendChild(b);
  }
  render();
  return {
    element: root,
    set(p) {
      current = p;
      typeShown = p ? p.type : 'none';
      render();
    },
    destroy() {
      cleanup();
      root.remove();
    },
  };
}

/** Opens a paint panel: a popover under `anchor`, or inline under it inside a dialog. */
function openPanel(app, anchor, host, opts) {
  const dialog = anchor.closest('.dialog');
  if (dialog) {
    const open = host.querySelector(':scope > .sl-paint-panel');
    if (open) {
      open.remove();
      return null;
    }
    const panel = paintPanel(app, opts);
    host.appendChild(panel.element);
    return panel;
  }
  const panel = paintPanel(app, opts);
  const pop = app.dialogs.popover(anchor, [{ type: 'custom', element: panel.element }], { align: 'left', closeOnSelect: false });
  pop?.classList.add('sl-popover', 'sl-paint-pop');
  const obs = new MutationObserver(() => {
    if (!pop?.isConnected) {
      panel.destroy();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
  return panel;
}

/** The swatch button of a paint (Photoshop's fill / stroke swatch: a red slash for None). */
function paintButton(app, { role, title }) {
  const b = el('button', `sl-swatch sl-swatch-${role}`);
  b.type = 'button';
  b.title = title;
  b.dataset.role = role;
  const show = (paint) => {
    b.classList.toggle('none', !paint);
    b.style.background = paint ? paintSwatchCss(app, paint) : '';
    b.dataset.paintType = paint ? paint.type : 'none';
  };
  return { b, show };
}

// ---- the `paint` widget (H) ------------------------------------------------------------------------------------------

registerWidget('paint', (spec, { value, onInput, onChange, app }) => {
  const allow = Array.isArray(spec.allow) && spec.allow.length ? spec.allow.filter((t) => PAINT_TYPES.includes(t)) : PAINT_TYPES;
  let current = value ?? spec.value ?? null;
  const wrap = el('span', 'field-paint sl-paint');
  const role = spec.role === 'stroke' ? 'stroke' : 'fill';
  const { b, show } = paintButton(app, { role, title: spec.title ?? (role === 'stroke' ? 'Stroke' : 'Fill') });
  wrap.appendChild(b);
  show(current);
  b.addEventListener('click', () => {
    openPanel(app, b, wrap, {
      value: current,
      allow,
      role,
      onChange: (p) => {
        current = readyPaint(app, p);
        show(current);
        onInput(current);
        onChange(current);
      },
    });
  });
  return {
    element: wrap,
    get: () => current,
    set(v, { silent = true } = {}) {
      current = v ?? null;
      show(current);
      if (!silent) {
        onInput(current);
        onChange(current);
      }
    },
    setDisabled: (d) => (b.disabled = !!d),
    destroy: () => wrap.remove(),
  };
});

// ---- options-bar kinds of the shape and pen tools ----------------------------------------------------------------

/** The paint a tool's options draw a new shape's fill with (null = None). */
export function toolFill(tool) {
  if (tool.opt('fillOn') === false) return null;
  return tool.opt('fillPaint') ?? { type: 'solid', color: tool.app.settings.foreground };
}

/** The paint a tool's options draw a new shape's stroke with (null = None). */
export function toolStroke(tool) {
  if (!tool.opt('strokeOn')) return null;
  return tool.opt('strokePaint') ?? { type: 'solid', color: tool.opt('strokeColor') ?? '#000000' };
}

/** Writes a fill choice into the tool options (the active shape layer follows, VectorTool.applyStyleToLayer). */
export function setToolFill(tool, paint) {
  if (!paint) {
    tool.setOpt('fillOn', false);
    return;
  }
  if (tool.opt('fillOn') === false) tool.setOpt('fillOn', true);
  tool.setOpt('fillPaint', paint);
}

/** Writes a stroke choice into the tool options: a solid colour is `strokeColor` (0.3's key), others `strokePaint`. */
export function setToolStroke(tool, paint) {
  if (!paint) {
    tool.setOpt('strokeOn', false);
    return;
  }
  if (!tool.opt('strokeOn')) tool.setOpt('strokeOn', true);
  if (paint.type === 'solid') {
    if (tool.opt('strokePaint')) tool.app.tools.setOpt(tool.id, 'strokePaint', null, { silent: true });
    tool.setOpt('strokeColor', paint.color);
  } else tool.setOpt('strokePaint', paint);
}

for (const role of ['fill', 'stroke']) {
  registerWidget(`shape-${role}`, (spec, { app }) => {
    const wrap = el('span', `sl-tool-paint sl-tool-${role}`);
    const { b, show } = paintButton(app, { role, title: role === 'fill' ? 'Set shape fill type' : 'Set shape stroke type' });
    wrap.appendChild(b);
    const tool = () => app.tools.active;
    const read = () => (tool() ? (role === 'fill' ? toolFill(tool()) : toolStroke(tool())) : null);
    show(read());
    b.addEventListener('click', () => {
      const t = tool();
      if (!t) return;
      openPanel(app, b, wrap, {
        value: read(),
        role,
        onChange: (p) => {
          const paint = readyPaint(app, p);
          if (role === 'fill') setToolFill(t, paint);
          else setToolStroke(t, paint);
          show(read());
        },
      });
    });
    return { element: wrap, get: () => read(), set: () => show(read()), setDisabled: (d) => (b.disabled = !!d), destroy: () => wrap.remove() };
  });
}
