// The `pattern` field widget (patterns package; ARCHITECTURE.md "0.4 features", H, E7), replacing the skeleton's stub
// in lib/fields.js by registration (the later wins). Used by dialog forms (`type: 'pattern'`), the options bar
// (`kind: 'pattern'`), panels (createWidget) and the `paint` widget.
//
//   value: PatternRef { dataUrl, presetId?, name? } or null (a 0.3 data URL string is read too)
//   spec: { emptyLabel?: string    what null shows (default: "Current pattern", drawn from app.patterns.current())
//           manage?: boolean       the drop-down's New from Selection and Import buttons (default true)
//           compact?: boolean      a smaller swatch (the options bar, Properties) }
//
// The swatch and the arrow open the picker: inline under the widget inside a dialog (a popover would sit under the
// dialog's backdrop) and as a popover elsewhere. Picking a pattern reports its ref through onInput and onChange; the
// ref always carries the pixels (dataUrl, L.6), so what a form stores survives the preset being deleted.
import { registerWidget } from './fields.js';
import { patternThumbnail, canvasFromPixels } from './patterns.js';
import { patternPicker, importPatterns } from './pattern-picker.js';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clone = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? { dataUrl: v } : JSON.parse(JSON.stringify(v)));

export function patternWidget(spec = {}, { value, onInput = () => {}, onChange = () => {}, app } = {}) {
  let current = clone(value ?? spec.value ?? null);
  const swatchSize = spec.compact ? 22 : 32;
  const wrap = el('span', `field-pattern pw${spec.compact ? ' pw-compact' : ''}`);
  const main = el('span', 'pw-main');
  const sw = el('button', 'pw-swatch');
  sw.type = 'button';
  const more = el('button', 'pw-more', '▾');
  more.type = 'button';
  more.title = 'Choose a pattern';
  more.setAttribute('aria-haspopup', 'listbox');
  const label = el('span', 'pw-name');
  main.append(sw, more);
  wrap.append(main, label);
  if (spec.compact) label.hidden = true;

  // the pixels of the value: decoded once; the swatch is redrawn when they arrive
  let shown = null;
  const paint = () => {
    sw.replaceChildren();
    let canvas = null;
    let name = '';
    if (current) {
      const data = app?.patterns?.resolve?.(current, () => paint()) ?? null;
      canvas = data ? (shown?.data === data ? shown.canvas : canvasFromPixels(data)) : null;
      if (data) shown = { data, canvas };
      name = current.name ?? 'Pattern';
    } else {
      const cur = app?.patterns?.current?.();
      canvas = cur?.canvas ?? null;
      name = spec.emptyLabel ?? (cur ? `Current pattern (${cur.name})` : 'No pattern');
    }
    const thumb = patternThumbnail(canvas, swatchSize, swatchSize);
    if (!current) thumb.classList.add('pw-current');
    sw.appendChild(thumb);
    sw.title = canvas ? `${name} (${canvas.width} × ${canvas.height} px): click to choose another` : name;
    label.textContent = name;
  };

  const report = () => {
    const v = clone(current);
    onInput(v);
    onChange(v);
  };
  const pick = async (entry) => {
    const ref = app.patterns.ref(entry) ?? (await app.patterns.refFor(entry.id));
    if (!ref) return;
    current = ref;
    paint();
    picker?.select(entry.id);
    report();
  };

  // ---- the drop-down ------------------------------------------------------------------------------------------------
  let inline = null;
  let picker = null;
  const tools = () => {
    if (spec.manage === false) return null;
    const bar = el('div', 'pw-tools');
    const add = el('button', 'btn small', 'New from Selection');
    add.type = 'button';
    add.title = 'Define a pattern from the selection (Edit › Define Pattern)';
    add.dataset.act = 'define';
    add.disabled = !app?.doc;
    add.addEventListener('click', async () => {
      const entry = await app.commands.run('edit:define-pattern', { dialog: true }, 'api');
      if (entry?.id) pick(entry);
    });
    const imp = el('button', 'btn small', 'Import…');
    imp.type = 'button';
    imp.dataset.act = 'import';
    imp.addEventListener('click', () => importPatterns(app));
    bar.append(add, imp);
    return bar;
  };
  const toggle = (e) => {
    e.preventDefault();
    if (!app?.patterns) return;
    if (inline) {
      close();
      return;
    }
    const selectedId = current?.presetId ?? (current ? null : app.patterns.currentId?.());
    if (wrap.closest('.dialog')) {
      inline = el('div', 'pw-inline');
      picker = patternPicker(app, { selected: selectedId, size: 28, className: 'pw-inline-picker', onPick: (p) => pick(p) });
      inline.appendChild(picker.element);
      const bar = tools();
      if (bar) inline.appendChild(bar);
      wrap.appendChild(inline);
      more.setAttribute('aria-expanded', 'true');
      return;
    }
    picker = patternPicker(app, { selected: selectedId, size: 32, className: 'pw-pop-picker', onPick: (p) => {
      pick(p);
      app.dialogs.closePopover();
    } });
    const items = [{ type: 'custom', element: picker.element }];
    const bar = tools();
    if (bar) items.push({ type: 'custom', element: bar });
    const pop = app.dialogs.popover(more, items, { align: 'left' });
    pop.classList.add('pw-popover');
    // the popover removes its element when it closes; the picker's listeners go with it
    const p = picker;
    const obs = new MutationObserver(() => {
      if (!pop.isConnected) {
        p.destroy();
        if (picker === p) picker = null;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  };
  const close = () => {
    picker?.destroy();
    picker = null;
    inline?.remove();
    inline = null;
    more.setAttribute('aria-expanded', 'false');
  };
  sw.addEventListener('click', toggle);
  more.addEventListener('click', toggle);

  // an empty value shows the current pattern: follow it
  const off = app?.on?.('patterns:changed', () => {
    if (!current) paint();
  });
  paint();
  return {
    element: wrap,
    get: () => clone(current),
    set(v, { silent = true } = {}) {
      current = clone(v ?? null);
      paint();
      if (!silent) report();
    },
    setDisabled(b) {
      sw.disabled = more.disabled = !!b;
    },
    destroy() {
      off?.();
      close();
      wrap.remove();
    },
  };
}

registerWidget('pattern', patternWidget);
