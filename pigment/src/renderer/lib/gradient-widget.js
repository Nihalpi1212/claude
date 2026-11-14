// The `gradient` field widget (gradients package; ARCHITECTURE.md "0.4 features", H, E7), replacing the skeleton's
// stub in lib/fields.js by registration (the later wins). Used by dialog forms (`type: 'gradient'`), the options bar
// (`kind: 'gradient'`), panels (createWidget) and the `paint` widget.
//
//   value: GradientDef & GradientPlacement, or GradientDef (plus reverse / dither) with spec.placement === false
//   spec: { placement?: boolean = true          style, angle, scale, reverse, dither, align and method fields
//           kinds?: string[]                     extra styles ('shape-burst' for the Stroke effect)
//           align?: boolean = true               show Align with Layer (with placement)
//           flags?: ('reverse' | 'dither')[]     those check boxes without placement (Gradient Map)
//           method?: boolean                     the Method menu without placement
//           keepRefs?: boolean                   keep { ref } stops (tool options and presets only, G.1)
//           presetId?: string                    the preset the value came from (selected in the picker)
//           onPick?(preset)                      a preset was picked
//           compact?: boolean                    a narrow bar (the options bar) }
//
// The bar opens the Gradient Editor (a dialog on top of any dialog); the arrow opens the preset picker, inline under
// the bar inside a dialog (a popover would sit under the dialog's backdrop) and as a popover elsewhere. Every value it
// reports has its colour references resolved unless `keepRefs` (G.1). While the editor is open, its changes are
// reported through onInput, so a dialog's live preview follows; Cancel reports the old value again.
import { registerWidget } from './fields.js';
import { normalizeGradient, PLACEMENT_KEYS } from '../../shared/pixels/gradient-model.js';
import { openGradientEditor, drawRamp, METHOD_LABELS, defOnly } from './gradient-editor.js';
import { gradientPicker, appColors } from './gradient-picker.js';
import { numericField } from './numeric-field.js';
import { INTERPOLATIONS } from '../../shared/pixels/gradient-model.js';

export const STYLE_LABELS = { linear: 'Linear', radial: 'Radial', angle: 'Angle', reflected: 'Reflected', diamond: 'Diamond', 'shape-burst': 'Shape Burst' };
const BASE_KINDS = ['linear', 'radial', 'angle', 'reflected', 'diamond'];
// placement fields a def-only value drops (reverse and dither stay: Gradient Map keeps them, G.1)
const PLACEMENT_ONLY = ['kind', 'angle', 'scale', 'offset', 'align', 'from', 'to'];

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/** The placement fields of a value (G.1 GradientPlacement). */
export function placementOf(g) {
  const out = {};
  for (const k of PLACEMENT_KEYS) if (g?.[k] !== undefined) out[k] = clone(g[k]);
  return out;
}

/** A def-only copy: placement fields removed except reverse and dither (what `placement: false` reports). */
export function stripPlacement(g) {
  const out = clone(g);
  for (const k of PLACEMENT_ONLY) delete out[k];
  return out;
}

export function gradientWidget(spec = {}, { value, onInput = () => {}, onChange = () => {}, app } = {}) {
  const keepRefs = !!spec.keepRefs;
  const placement = spec.placement !== false;
  const colors = () => appColors(app);
  const resolve = (v) => (keepRefs ? normalizeGradient(v, { keepRefs: true }) : normalizeGradient(v, colors()));
  let current = resolve(value ?? spec.value ?? null);
  let presetId = spec.presetId ?? null;

  const wrap = el('span', `field-gradient gw${spec.compact ? ' gw-compact' : ''}`);
  const main = el('span', 'gw-main');
  const bar = el('button', 'gw-bar');
  bar.type = 'button';
  bar.title = 'Click to edit the gradient';
  const ramp = el('canvas', 'gw-ramp');
  ramp.width = spec.compact ? 96 : 160;
  ramp.height = 16;
  bar.appendChild(ramp);
  const more = el('button', 'gw-more');
  more.type = 'button';
  more.title = 'Choose a gradient preset';
  more.setAttribute('aria-haspopup', 'listbox');
  more.textContent = '▾';
  main.append(bar, more);
  wrap.appendChild(main);

  const out = () => (placement ? clone(current) : stripPlacement(current));
  const emit = (final = true) => {
    const v = out();
    onInput(v);
    if (final) onChange(v);
  };
  const paintBar = () => drawRamp(ramp, { ...current, reverse: false }, colors());

  // ---- placement and flag fields ----------------------------------------------------------------------------------------
  const controls = [];
  const fields = el('span', 'gw-fields');
  const addRow = (label, input) => {
    const r = el('label', 'gw-row');
    r.append(el('span', 'gw-label', label), input);
    fields.appendChild(r);
  };
  const checkbox = (key, label) => {
    const r = el('label', 'gw-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.key = key;
    cb.addEventListener('change', () => {
      current = { ...current, [key]: cb.checked };
      emit();
    });
    r.append(cb, document.createTextNode(` ${label}`));
    fields.appendChild(r);
    controls.push({ sync: () => (cb.checked = key === 'align' ? current.align !== false : !!current[key]), disable: (b) => (cb.disabled = b) });
  };
  if (placement) {
    const style = el('select', 'select');
    style.dataset.key = 'kind';
    for (const k of [...BASE_KINDS, ...(spec.kinds ?? []).filter((k) => !BASE_KINDS.includes(k))]) style.add(new Option(STYLE_LABELS[k] ?? k, k));
    style.addEventListener('change', () => {
      current = { ...current, kind: style.value };
      emit();
    });
    addRow('Style', style);
    controls.push({ sync: () => (style.value = current.kind ?? 'linear'), disable: (b) => (style.disabled = b) });
    const angle = numericField({ key: 'angle', min: -180, max: 180, step: 1, unit: '°', width: 56, onChange: (v) => {
      current = { ...current, angle: v };
      emit();
    } });
    addRow('Angle', angle.element);
    controls.push({ sync: () => angle.set(Math.round((current.angle ?? 90) * 10) / 10), disable: angle.setDisabled });
    const scale = numericField({ key: 'scale', min: 10, max: 1000, step: 1, unit: '%', width: 56, onChange: (v) => {
      current = { ...current, scale: v / 100 };
      emit();
    } });
    addRow('Scale', scale.element);
    controls.push({ sync: () => scale.set(Math.round((current.scale ?? 1) * 100)), disable: scale.setDisabled });
  }
  if (placement || spec.method) {
    const method = el('select', 'select');
    method.dataset.key = 'interpolation';
    for (const m of INTERPOLATIONS) method.add(new Option(METHOD_LABELS[m], m));
    method.addEventListener('change', () => {
      current = { ...current, interpolation: method.value };
      paintBar();
      emit();
    });
    addRow('Method', method);
    controls.push({ sync: () => {
      method.value = current.interpolation;
      method.disabled = current.type === 'noise';
    }, disable: (b) => (method.disabled = b) });
  }
  const flags = placement ? ['reverse', 'dither', ...(spec.align === false ? [] : ['align'])] : (spec.flags ?? []);
  for (const f of flags) checkbox(f, f === 'align' ? 'Align with Layer' : f === 'reverse' ? 'Reverse' : 'Dither');
  if (fields.children.length) wrap.appendChild(fields);
  const syncControls = () => {
    for (const c of controls) c.sync();
  };

  // ---- the editor ----------------------------------------------------------------------------------------------------------
  let editing = false;
  bar.addEventListener('click', async (e) => {
    e.preventDefault();
    if (editing || !app) return;
    editing = true;
    const before = clone(current);
    const keep = placementOf(current);
    try {
      const result = await openGradientEditor(app, {
        value: defOnly(current),
        keepRefs,
        presetId,
        onPreview: spec.preview === false ? null : (def) => {
          current = { ...resolve(def), ...keep };
          paintBar();
          emit(false);
        },
      });
      current = result ? { ...resolve(result), ...keep } : before;
      if (result) presetId = null;
      paintBar();
      syncControls();
      // Cancel only takes the preview back (onInput): nothing changed, so nothing is committed
      emit(!!result);
    } finally {
      editing = false;
    }
  });

  // ---- the preset picker ---------------------------------------------------------------------------------------------------
  let inline = null;
  const pick = (p) => {
    current = { ...resolve(p.data), ...placementOf(current) };
    presetId = p.id;
    paintBar();
    syncControls();
    spec.onPick?.(p);
    emit();
  };
  more.addEventListener('click', (e) => {
    e.preventDefault();
    if (!app) return;
    if (inline) {
      inline.destroy();
      inline = null;
      more.setAttribute('aria-expanded', 'false');
      return;
    }
    if (wrap.closest('.dialog')) {
      inline = gradientPicker(app, { selected: presetId, size: 28, className: 'gw-inline-picker', onPick: (p) => pick(p) });
      wrap.appendChild(inline.element);
      more.setAttribute('aria-expanded', 'true');
      return;
    }
    const picker = gradientPicker(app, { selected: presetId, size: 32, className: 'gw-pop-picker', onPick: (p) => {
      pick(p);
      app.dialogs.closePopover();
    } });
    const pop = app.dialogs.popover(more, [{ type: 'custom', element: picker.element }], { align: 'left' });
    pop.classList.add('gw-popover');
    // the popover removes its element when it closes; the picker's listeners go with it
    const obs = new MutationObserver(() => {
      if (!pop.isConnected) {
        picker.destroy();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  });

  // colour references follow the foreground and background colours
  const off = keepRefs ? app?.on?.('color:changed', () => paintBar()) : null;

  paintBar();
  syncControls();
  return {
    element: wrap,
    get: () => out(),
    set(v, { silent = true } = {}) {
      current = resolve(v ?? null);
      paintBar();
      syncControls();
      if (!silent) emit();
    },
    setDisabled(b) {
      bar.disabled = more.disabled = !!b;
      for (const c of controls) c.disable(!!b);
    },
    /** The preset the value came from, if it was picked and not edited since. */
    presetId: () => presetId,
    destroy() {
      off?.();
      inline?.destroy();
      wrap.remove();
    },
  };
}

registerWidget('gradient', gradientWidget);
