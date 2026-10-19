// Declarative forms for dialogs (Fill, Stroke, filters, adjustments, image size...).
//
// formDialog(app, { title, fields, okLabel, preview, live, width, className, buttons }) resolves with
// the form values, or null when cancelled.
//
// Field: { key, label, type, value, options, min, max, step, unit, when(values), span, help }
//   type: 'select' | 'color' | 'slider' | 'number' | 'checkbox' | 'segment' | 'text' | 'textarea'
//         | 'section' (heading, no key) | 'custom' ({ render(values, set, form) -> HTMLElement })
//   options: ['a', 'b'] or [['value', 'Label'], ...] or [{ value, label }]
// preview(values) -> HTMLCanvasElement | null   shown in a thumbnail box next to the form
// live: { apply(values), revert() }             previews on the canvas while the dialog is open
//   (a "Preview" checkbox is added; revert() is called on cancel, and before the final result).

let fieldCounter = 0;

function normOptions(options = []) {
  return options.map((o) => {
    if (Array.isArray(o)) return { value: o[0], label: o[1] ?? String(o[0]) };
    if (o && typeof o === 'object') return { value: o.value, label: o.label ?? String(o.value) };
    return { value: o, label: labelize(String(o)) };
  });
}

function labelize(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function clamp(v, min, max) {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

/**
 * Builds a form element. Returns { element, values, set(key, value), refresh() }.
 * onChange(values, key) fires on every edit (input events, so sliders update live).
 */
export function buildForm(fields, { onChange, values: initial } = {}) {
  const values = {};
  for (const f of fields) if (f.key) values[f.key] = initial?.[f.key] ?? (typeof f.value === 'function' ? f.value() : f.value);
  const element = document.createElement('div');
  element.className = 'dialog-form';
  const rows = [];
  const form = { element, values, set, refresh, fields };

  function set(key, value, { silent = false } = {}) {
    values[key] = value;
    for (const r of rows) if (r.field.key === key) r.sync?.();
    refresh();
    if (!silent) onChange?.(values, key);
  }

  function refresh() {
    for (const r of rows) {
      const visible = !r.field.when || r.field.when(values);
      r.el.hidden = !visible;
      if (r.field.disabled) {
        const off = typeof r.field.disabled === 'function' ? r.field.disabled(values) : !!r.field.disabled;
        for (const input of r.el.querySelectorAll('input, select, button, textarea')) input.disabled = off;
      }
    }
  }

  const changed = (key) => {
    refresh();
    onChange?.(values, key);
  };

  for (const f of fields) {
    const row = buildField(f, values, changed, form);
    if (!row) continue;
    rows.push(row);
    element.appendChild(row.el);
  }
  refresh();
  return form;
}

function buildField(f, values, changed, form) {
  const id = `ff-${++fieldCounter}`;
  const el = document.createElement('div');
  el.className = 'field';
  if (f.span || ['section', 'custom', 'textarea'].includes(f.type)) el.classList.add('span-all');
  if (f.className) el.classList.add(...f.className.split(/\s+/));
  let sync = null;
  const addLabel = () => {
    if (!f.label) return;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = f.label;
    el.appendChild(label);
  };
  const help = () => {
    if (!f.help) return;
    const p = document.createElement('span');
    p.className = 'muted';
    p.textContent = f.help;
    el.appendChild(p);
  };

  switch (f.type) {
    case 'section': {
      el.className = 'section';
      el.textContent = f.label ?? '';
      return { el, field: f };
    }
    case 'custom': {
      addLabel();
      const node = f.render(values, (key, value) => form.set(key, value), form);
      if (node) el.appendChild(node);
      sync = () => f.sync?.(values, node);
      break;
    }
    case 'checkbox': {
      const label = document.createElement('label');
      label.className = 'checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.dataset.key = f.key;
      input.checked = !!values[f.key];
      input.addEventListener('change', () => {
        values[f.key] = input.checked;
        changed(f.key);
      });
      label.append(input, document.createTextNode(f.label ?? ''));
      el.appendChild(label);
      sync = () => (input.checked = !!values[f.key]);
      break;
    }
    case 'select': {
      addLabel();
      const select = document.createElement('select');
      select.className = 'select';
      select.id = id;
      select.dataset.key = f.key;
      const opts = normOptions(typeof f.options === 'function' ? f.options(values) : f.options);
      for (const o of opts) {
        if (o.value === null && o.label === '-') continue;
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label;
        select.appendChild(opt);
      }
      const lookup = new Map(opts.map((o) => [String(o.value), o.value]));
      select.value = String(values[f.key]);
      select.addEventListener('change', () => {
        values[f.key] = lookup.has(select.value) ? lookup.get(select.value) : select.value;
        changed(f.key);
      });
      el.appendChild(select);
      sync = () => (select.value = String(values[f.key]));
      break;
    }
    case 'segment': {
      addLabel();
      const wrap = document.createElement('div');
      wrap.className = 'opt-segment';
      wrap.setAttribute('role', 'radiogroup');
      const buttons = [];
      for (const o of normOptions(f.options)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-button';
        b.textContent = o.label;
        b.dataset.value = String(o.value);
        b.addEventListener('click', () => {
          values[f.key] = o.value;
          syncSeg();
          changed(f.key);
        });
        buttons.push([b, o.value]);
        wrap.appendChild(b);
      }
      const syncSeg = () => {
        for (const [b, v] of buttons) b.setAttribute('aria-pressed', String(v === values[f.key]));
      };
      syncSeg();
      el.appendChild(wrap);
      sync = syncSeg;
      break;
    }
    case 'color': {
      addLabel();
      const wrap = document.createElement('div');
      wrap.className = 'slider-field';
      const input = document.createElement('input');
      input.type = 'color';
      input.id = id;
      input.dataset.key = f.key;
      input.value = toHex6(values[f.key]);
      const text = document.createElement('input');
      text.className = 'input';
      text.value = toHex6(values[f.key]);
      text.spellcheck = false;
      input.addEventListener('input', () => {
        values[f.key] = input.value;
        text.value = input.value;
        changed(f.key);
      });
      text.addEventListener('change', () => {
        const v = text.value.trim();
        if (/^#?[0-9a-f]{6}$/i.test(v) || /^#?[0-9a-f]{3}$/i.test(v)) {
          values[f.key] = toHex6(v.startsWith('#') ? v : '#' + v);
          input.value = values[f.key];
          text.value = values[f.key];
          changed(f.key);
        } else text.value = values[f.key];
      });
      wrap.append(input, text);
      el.appendChild(wrap);
      sync = () => {
        input.value = toHex6(values[f.key]);
        text.value = input.value;
      };
      break;
    }
    case 'slider':
    case 'number': {
      addLabel();
      const wrap = document.createElement('div');
      wrap.className = 'slider-field';
      const step = f.step ?? (f.type === 'slider' && f.max - f.min <= 2 ? 0.01 : 1);
      let range = null;
      if (f.type === 'slider') {
        range = document.createElement('input');
        range.type = 'range';
        range.min = String(f.min ?? 0);
        range.max = String(f.max ?? 100);
        range.step = String(step);
        range.value = String(values[f.key]);
        range.setAttribute('aria-label', f.label ?? f.key);
        wrap.appendChild(range);
      }
      const num = document.createElement('input');
      num.className = 'input';
      num.type = 'number';
      num.id = id;
      num.dataset.key = f.key;
      if (f.min !== undefined) num.min = String(f.min);
      if (f.max !== undefined) num.max = String(f.max);
      num.step = String(step);
      num.value = fmt(values[f.key], step);
      if (f.type === 'number') num.style.width = f.width ? `${f.width}px` : '90px';
      wrap.appendChild(num);
      if (f.unit) {
        const u = document.createElement('span');
        u.className = 'opt-unit';
        u.textContent = f.unit;
        wrap.appendChild(u);
      }
      const commit = (raw, from) => {
        let v = Number(raw);
        if (!Number.isFinite(v)) return false;
        v = clamp(v, f.min, f.max);
        values[f.key] = v;
        if (from !== range && range) range.value = String(v);
        if (from !== num) num.value = fmt(v, step);
        changed(f.key);
        return true;
      };
      range?.addEventListener('input', () => commit(range.value, range));
      num.addEventListener('input', () => {
        if (num.value !== '' && Number(num.value) >= (f.min ?? -Infinity) && Number(num.value) <= (f.max ?? Infinity)) commit(num.value, num);
      });
      num.addEventListener('change', () => {
        if (!commit(num.value, null)) num.value = fmt(values[f.key], step);
      });
      el.appendChild(wrap);
      sync = () => {
        if (range) range.value = String(values[f.key]);
        num.value = fmt(values[f.key], step);
      };
      break;
    }
    case 'textarea': {
      addLabel();
      const ta = document.createElement('textarea');
      ta.className = 'textarea';
      ta.id = id;
      ta.dataset.key = f.key;
      ta.rows = f.rows ?? 4;
      ta.value = values[f.key] ?? '';
      ta.style.height = 'auto';
      ta.addEventListener('input', () => {
        values[f.key] = ta.value;
        changed(f.key);
      });
      el.appendChild(ta);
      sync = () => (ta.value = values[f.key] ?? '');
      break;
    }
    default: {
      // text
      addLabel();
      const input = document.createElement('input');
      input.className = 'input';
      input.id = id;
      input.dataset.key = f.key;
      input.value = values[f.key] ?? '';
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.autofocus) input.autofocus = true;
      input.addEventListener('input', () => {
        values[f.key] = input.value;
        changed(f.key);
      });
      el.appendChild(input);
      sync = () => (input.value = values[f.key] ?? '');
    }
  }
  help();
  return { el, field: f, sync };
}

function fmt(v, step) {
  if (!Number.isFinite(v)) return '';
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return decimals ? String(Number(v.toFixed(decimals))) : String(Math.round(v));
}

export function toHex6(c) {
  if (typeof c !== 'string') return '#000000';
  let s = c.trim();
  if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s.slice(1).split('').map((x) => x + x).join('');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
  const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  return '#000000';
}

/** Throttles fn to one call per animation frame (latest arguments win). */
export function frameThrottle(fn) {
  let pending = null;
  let scheduled = false;
  let raf = 0;
  const throttled = (...args) => {
    pending = args;
    if (scheduled) return;
    scheduled = true;
    raf = requestAnimationFrame(() => {
      scheduled = false;
      const a = pending;
      pending = null;
      fn(...a);
    });
  };
  /** Drops a pending call (a preview must not run after its dialog was cancelled). */
  throttled.cancel = () => {
    if (scheduled) cancelAnimationFrame(raf);
    scheduled = false;
    pending = null;
  };
  return throttled;
}

/** Debounces fn by ms. */
export function debounce(fn, ms = 120) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

/**
 * Shows a modal form. Resolves with a copy of the values or null.
 */
export async function formDialog(app, opts) {
  const { title, fields, okLabel = 'OK', cancelLabel = 'Cancel', preview, live, width, className, validate, intro } = opts;
  let previewBox = null;
  let livePreview = live ? (opts.livePreviewDefault ?? app.settings?.dialogPreview ?? true) : false;
  let liveApplied = false;

  const runLive = frameThrottle(() => {
    if (!live) return;
    try {
      if (livePreview) {
        live.apply({ ...form.values });
        liveApplied = true;
      } else if (liveApplied) {
        live.revert();
        liveApplied = false;
      }
    } catch (err) {
      console.error(err);
    }
  });
  const runPreview = preview
    ? debounce(() => {
        try {
          const c = preview({ ...form.values });
          previewBox.replaceChildren();
          if (c) previewBox.appendChild(c);
        } catch (err) {
          console.error(err);
        }
      }, opts.previewDelay ?? 60)
    : null;

  const form = buildForm(fields, {
    values: opts.values,
    onChange: (values, key) => {
      opts.onChange?.(values, key, form);
      runPreview?.();
      runLive();
    },
  });

  const content = document.createElement('div');
  if (intro) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.margin = '0 0 10px';
    p.textContent = intro;
    content.appendChild(p);
  }
  if (preview) {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-preview';
    previewBox = document.createElement('div');
    previewBox.className = 'preview-box';
    wrap.append(previewBox, form.element);
    content.appendChild(wrap);
  } else content.appendChild(form.element);
  if (opts.extra) content.appendChild(opts.extra(form));

  if (live) {
    const label = document.createElement('label');
    label.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = livePreview;
    input.dataset.key = '__preview';
    input.addEventListener('change', () => {
      livePreview = input.checked;
      if (app.settings) {
        app.settings.dialogPreview = livePreview;
        app.saveSettingsSoon?.();
      }
      runLive();
    });
    label.append(input, document.createTextNode('Preview'));
    content.appendChild(label);
  }

  const buttons = opts.buttons ?? [
    ...(opts.resetButton ? [{ label: 'Reset', value: 'reset' }] : []),
    { label: cancelLabel, value: null },
    { label: okLabel, value: true, primary: true },
  ];

  const result = await app.dialogs.open({
    title,
    content,
    width: width ?? (preview ? 660 : 440),
    className,
    buttons,
    onOpen: (dialog, close) => {
      opts.onOpen?.(dialog, form, close);
      runPreview?.flush();
      if (live && livePreview) runLive();
      // a Reset button resets fields without closing
      const reset = dialog.querySelector('.dialog-buttons button[data-value="reset"]');
      if (reset) {
        reset.replaceWith(reset.cloneNode(true));
        dialog.querySelector('.dialog-buttons button[data-value="reset"]').addEventListener('click', (e) => {
          e.stopPropagation();
          for (const f of fields) if (f.key) form.set(f.key, typeof f.value === 'function' ? f.value() : f.value, { silent: true });
          runPreview?.();
          runLive();
        });
      }
    },
    validate: validate ? () => validate({ ...form.values }) : undefined,
  });
  // live preview: always revert so the caller applies the final result through history
  runLive.cancel();
  if (live && liveApplied) {
    try {
      live.revert();
    } catch (err) {
      console.error(err);
    }
  }
  if (result === null || result === undefined || result === false) return null;
  const values = { ...form.values };
  if (typeof result === 'string' && result !== 'true') values.__button = result;
  return values;
}
