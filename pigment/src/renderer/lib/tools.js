// Tool registry, toolbox (left column) and options bar (top) — see ARCHITECTURE.md "Tools".
import { icon } from './icons.js';
import { RENDERER_KEYS, describeAccelerator } from '../../shared/keymap.js';
import { isMac } from './bridge.js';

/** Base class for tools; subclasses override the pointer handlers. */
export class Tool {
  constructor(app, def) {
    this.app = app;
    Object.assign(this, def);
    this.options ??= [];
  }
  get doc() {
    return this.app.doc;
  }
  get view() {
    return this.app.view;
  }
  opt(key) {
    return this.app.tools.opt(this.id, key);
  }
  setOpt(key, value) {
    this.app.tools.setOpt(this.id, key, value);
  }
  get cursorStyle() {
    return typeof this.cursor === 'function' ? this.cursor() : this.cursor ?? 'default';
  }
  activate() {}
  deactivate() {}
  onPointerDown() {}
  onPointerMove() {}
  onPointerUp() {}
  onPointerCancel() {
    this.onPointerUp?.({ x: 0, y: 0, cancelled: true });
  }
  onDoubleClick() {}
  onKeyDown() {
    return false;
  }
  /** Called for Escape; return true when the tool consumed it. */
  cancel() {
    return false;
  }
  /** Called for Enter; return true when the tool consumed it. */
  commit() {
    return false;
  }
  drawOverlay() {}
  /** Layer the tool can paint on (raster) or null with a toast explaining why. */
  paintableLayer({ quiet = false } = {}) {
    const doc = this.doc;
    const layer = doc?.active;
    if (!layer) return null;
    if (layer.isGroup && !(this.app.ui.editingMask && layer.mask?.canvas)) {
      // a group's own mask can be painted; its pixels cannot
      if (!quiet) this.app.dialogs.toast('Select a layer, not a group', { kind: 'error', timeout: 1800 });
      return null;
    }
    if (layer.locked.all || layer.locked.pixels) {
      if (!quiet) this.app.dialogs.toast(`"${layer.name}" is locked`, { kind: 'error', timeout: 1800 });
      return null;
    }
    return layer;
  }
}

/** Toolbox order (Photoshop's), with separators between groups. */
const SLOT_ORDER = ['move', 'marquee', 'lasso', 'wand', 'crop', 'eyedropper', 'heal', 'brush', 'clone', 'history', 'eraser', 'fill', 'blur', 'retouch', 'pen', 'type', 'text', 'path-select', 'shape', 'hand', 'rotate-view', 'zoom'];
const SLOT_GROUP = { move: 0, marquee: 0, lasso: 0, wand: 0, crop: 0, eyedropper: 0, heal: 1, brush: 1, clone: 1, history: 1, eraser: 1, fill: 1, blur: 1, retouch: 1, pen: 2, type: 2, text: 2, 'path-select': 2, shape: 2, hand: 3, 'rotate-view': 3, zoom: 3 };

export class ToolManager {
  constructor(app) {
    this.app = app;
    this.tools = new Map();
    this.slots = []; // [{ id, tools: [toolId], current: toolId }]
    this.active = null;
    this.previous = null;
    this.toolbox = document.getElementById('toolbox');
    this.optionsBar = document.getElementById('options-bar');
    this.optionsControls = new Map();
    app.on('color:changed', () => this.renderColors());
    app.on('settings:changed', () => this.renderColors());
  }

  /** Registers a tool into a toolbox slot (several tools share a slot and cycle with Shift+key). */
  register(tool, slotId = tool.id) {
    this.tools.set(tool.id, tool);
    let slot = this.slots.find((s) => s.id === slotId);
    if (!slot) {
      slot = { id: slotId, tools: [], current: tool.id };
      this.slots.push(slot);
    }
    slot.tools.push(tool.id);
    this.toolboxBuilt = false;
    this.app.commands.register(`tool:${tool.id}`, {
      run: () => this.activate(tool.id),
      checked: () => this.active?.id === tool.id,
      label: tool.name,
    });
    if (slot.tools.length === 1 && slotId !== tool.id) {
      this.app.commands.register(`tool:${slotId}`, { run: () => this.activateSlot(slotId), checked: () => slot.tools.includes(this.active?.id), label: tool.name });
    }
    return tool;
  }

  get(id) {
    return this.tools.get(id) ?? null;
  }

  /** Activates the slot's current tool, or cycles to the next tool in the slot when it is already active. */
  activateSlot(slotId) {
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot) return;
    if (this.active && slot.tools.includes(this.active.id) && slot.tools.length > 1) {
      const i = slot.tools.indexOf(this.active.id);
      slot.current = slot.tools[(i + 1) % slot.tools.length];
    }
    this.activate(slot.current);
  }

  activate(id) {
    const tool = this.tools.get(id);
    if (!tool || tool === this.active) return;
    const prev = this.active;
    try {
      prev?.deactivate();
    } catch (err) {
      console.warn('deactivate failed', err);
    }
    this.previous = prev;
    this.active = tool;
    const slot = this.slots.find((s) => s.tools.includes(id));
    if (slot) slot.current = id;
    tool.activate();
    this.renderToolbox();
    this.renderOptions();
    this.app.view?.setCursor(tool.cursorStyle);
    this.app.view?.invalidate();
    this.app.commands.invalidate();
    this.app.emit('tool:changed', { tool, previous: prev });
    this.app.statusbar.set('hint', tool.hint ?? '');
  }

  updateCursor() {
    this.app.view?.setCursor(this.active?.cursorStyle);
  }

  // ---- options (persisted per tool) ----------------------------------------------------------------------------
  opt(toolId, key) {
    const tool = this.tools.get(toolId);
    const stored = this.app.settings.tools?.[toolId];
    if (stored && key in stored) return stored[key];
    return tool?.options.find((o) => o.key === key)?.default;
  }

  setOpt(toolId, key, value, { silent = false } = {}) {
    const tools = { ...(this.app.settings.tools ?? {}) };
    tools[toolId] = { ...(tools[toolId] ?? {}), [key]: value };
    this.app.settings.tools = tools;
    this.app.saveSettingsSoon({ tools });
    if (!silent) {
      this.app.emit('tool:options', { tool: toolId, key, value });
      if (this.active?.id === toolId) {
        this.active.onOptionChanged?.(key, value);
        this.updateControl(key, value);
        this.updateCursor();
        this.app.view?.invalidate();
      }
    }
  }

  // ---- toolbox ----------------------------------------------------------------------------------------------------
  renderToolbox() {
    if (!this.toolbox) return;
    if (!this.toolboxBuilt) {
      this.toolbox.replaceChildren();
      const rank = (id) => {
        const i = SLOT_ORDER.indexOf(id);
        return i < 0 ? SLOT_ORDER.length : i;
      };
      this.slots.sort((a, b) => rank(a.id) - rank(b.id));
      let lastGroup = null;
      for (const slot of this.slots) {
        const group = SLOT_GROUP[slot.id] ?? 9;
        if (lastGroup !== null && group !== lastGroup) {
          const sep = document.createElement('div');
          sep.className = 'tool-separator';
          this.toolbox.appendChild(sep);
        }
        lastGroup = group;
        const btn = document.createElement('button');
        btn.className = 'tool-button';
        btn.type = 'button';
        btn.dataset.slot = slot.id;
        btn.innerHTML = `<span class="tool-icon"></span>${slot.tools.length > 1 ? '<span class="tool-flyout-mark"></span>' : ''}`;
        let pressTimer = null;
        btn.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          pressTimer = setTimeout(() => {
            pressTimer = null;
            this.showFlyout(slot, btn);
          }, 450);
        });
        btn.addEventListener('pointerup', () => {
          if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
            this.activate(slot.current);
          }
        });
        btn.addEventListener('pointerleave', () => {
          clearTimeout(pressTimer);
          pressTimer = null;
        });
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.showFlyout(slot, btn);
        });
        this.toolbox.appendChild(btn);
        if (slot.separatorAfter) {
          const sep = document.createElement('div');
          sep.className = 'tool-separator';
          this.toolbox.appendChild(sep);
        }
      }
      const colors = document.createElement('div');
      colors.className = 'tool-colors';
      colors.innerHTML = `<button class="swatch-fg" title="Foreground colour (click to change)"></button><button class="swatch-bg" title="Background colour"></button><button class="swatch-swap" title="Swap colours (X)">${icon('swap')}</button><button class="swatch-default" title="Default colours (D)">${icon('default-colors')}</button>`;
      colors.querySelector('.swatch-fg').addEventListener('click', () => this.app.commands.run('tool:pick-fg', undefined, 'toolbar'));
      colors.querySelector('.swatch-bg').addEventListener('click', () => this.app.commands.run('tool:pick-bg', undefined, 'toolbar'));
      colors.querySelector('.swatch-swap').addEventListener('click', () => this.app.commands.run('tool:swap-colors', undefined, 'toolbar'));
      colors.querySelector('.swatch-default').addEventListener('click', () => this.app.commands.run('tool:default-colors', undefined, 'toolbar'));
      this.toolbox.appendChild(colors);
      const modes = document.createElement('div');
      modes.className = 'tool-modes';
      modes.innerHTML = `<button class="tool-button small" data-command="select:quick-mask" title="Edit in quick mask mode (Q)">${icon('quickmask')}</button>`;
      modes.querySelector('button').addEventListener('click', () => this.app.commands.run('select:quick-mask', undefined, 'toolbar'));
      this.toolbox.appendChild(modes);
      this.toolboxBuilt = true;
    }
    for (const btn of this.toolbox.querySelectorAll('.tool-button[data-slot]')) {
      const slot = this.slots.find((s) => s.id === btn.dataset.slot);
      const tool = this.tools.get(slot.current);
      btn.querySelector('.tool-icon').innerHTML = icon(tool.icon);
      const key = RENDERER_KEYS[`tool:${slot.id}`]?.[0] ?? RENDERER_KEYS[`tool:${tool.id}`]?.[0];
      btn.title = key ? `${tool.name} (${describeAccelerator(key, isMac)})` : tool.name;
      btn.setAttribute('aria-pressed', String(this.active?.id === tool.id));
      btn.classList.toggle('active', this.active?.id === tool.id);
    }
    this.renderColors();
  }

  renderColors() {
    const fg = this.toolbox?.querySelector('.swatch-fg');
    const bg = this.toolbox?.querySelector('.swatch-bg');
    if (fg) fg.style.background = this.app.settings.foreground;
    if (bg) bg.style.background = this.app.settings.background;
  }

  showFlyout(slot, anchor) {
    const items = slot.tools.map((id) => {
      const t = this.tools.get(id);
      const key = RENDERER_KEYS[`tool:${slot.id}`]?.[0];
      return { label: t.name, icon: t.icon, checked: this.active?.id === id, shortcut: key, onSelect: () => this.activate(id) };
    });
    this.app.dialogs.popover(anchor, items, { align: 'left', side: 'right' });
  }

  // ---- options bar -------------------------------------------------------------------------------------------------
  renderOptions() {
    const bar = this.optionsBar;
    if (!bar) return;
    bar.replaceChildren();
    this.optionsControls.clear();
    const tool = this.active;
    if (!tool) return;
    const title = document.createElement('span');
    title.className = 'options-title';
    title.innerHTML = `${icon(tool.icon)}<span>${tool.name}</span>`;
    bar.appendChild(title);
    for (const spec of tool.options) {
      if (spec.when && !spec.when(tool)) continue;
      const el = this.buildControl(tool, spec);
      if (el) bar.appendChild(el);
    }
    tool.renderOptions?.(bar);
  }

  buildControl(tool, spec) {
    const value = this.opt(tool.id, spec.key);
    const wrap = document.createElement('label');
    wrap.className = `opt opt-${spec.kind}`;
    wrap.dataset.key = spec.key;
    if (spec.label && spec.kind !== 'checkbox' && spec.kind !== 'button') {
      const l = document.createElement('span');
      l.className = 'opt-label';
      l.textContent = spec.label;
      wrap.appendChild(l);
    }
    const set = (v) => this.setOpt(tool.id, spec.key, v);
    let control;
    switch (spec.kind) {
      case 'slider':
      case 'number': {
        const box = document.createElement('span');
        box.className = 'opt-number';
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'input';
        input.min = spec.min ?? '';
        input.max = spec.max ?? '';
        input.step = spec.step ?? 1;
        input.value = String(value ?? spec.default ?? 0);
        input.addEventListener('change', () => set(clampNum(Number(input.value), spec)));
        box.appendChild(input);
        if (spec.unit) {
          const u = document.createElement('span');
          u.className = 'opt-unit';
          u.textContent = spec.unit;
          box.appendChild(u);
        }
        if (spec.kind === 'slider') {
          const range = document.createElement('input');
          range.type = 'range';
          range.min = spec.min ?? 0;
          range.max = spec.max ?? 100;
          range.step = spec.step ?? 1;
          range.value = String(value ?? spec.default ?? 0);
          range.addEventListener('input', () => {
            input.value = range.value;
            set(clampNum(Number(range.value), spec));
          });
          box.appendChild(range);
          control = { input, range };
        } else control = { input };
        wrap.appendChild(box);
        break;
      }
      case 'select': {
        const select = document.createElement('select');
        select.className = 'select';
        for (const [v, label] of spec.options) {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = label;
          select.appendChild(o);
        }
        select.value = String(value ?? spec.default ?? '');
        select.addEventListener('change', () => set(spec.numeric ? Number(select.value) : select.value));
        wrap.appendChild(select);
        control = { select };
        break;
      }
      case 'checkbox': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!(value ?? spec.default);
        input.addEventListener('change', () => set(input.checked));
        wrap.appendChild(input);
        wrap.appendChild(document.createTextNode(` ${spec.label}`));
        control = { input };
        break;
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = value ?? spec.default ?? '#000000';
        input.addEventListener('input', () => set(input.value));
        wrap.appendChild(input);
        control = { input };
        break;
      }
      case 'segment': {
        const seg = document.createElement('span');
        seg.className = 'opt-segment';
        for (const [v, label, ic] of spec.options) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'seg-button';
          b.title = label;
          b.innerHTML = ic ? icon(ic) : label;
          b.dataset.value = String(v);
          b.setAttribute('aria-pressed', String(String(value ?? spec.default) === String(v)));
          b.addEventListener('click', () => set(spec.numeric ? Number(v) : v));
          seg.appendChild(b);
        }
        wrap.appendChild(seg);
        control = { seg };
        break;
      }
      case 'button': {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small';
        b.innerHTML = `${spec.icon ? icon(spec.icon) : ''}${spec.label ?? ''}`;
        b.addEventListener('click', () => spec.onClick?.(tool));
        wrap.appendChild(b);
        control = { button: b };
        break;
      }
      case 'brush': {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small opt-brush';
        const render = () => {
          const size = this.opt(tool.id, 'size') ?? 24;
          const hard = this.opt(tool.id, 'hardness') ?? 0.8;
          b.innerHTML = `<span class="brush-preview" style="--d:${Math.min(22, Math.max(4, Math.sqrt(size) * 2.4))}px;--h:${Math.round(hard * 100)}%"></span><span>${Math.round(size)} px</span>`;
        };
        render();
        b.addEventListener('click', () => this.app.brushPicker?.show(b, tool));
        wrap.appendChild(b);
        control = { button: b, render };
        break;
      }
      case 'label': {
        const s = document.createElement('span');
        s.className = 'opt-text muted';
        s.textContent = spec.text ?? '';
        wrap.appendChild(s);
        control = { span: s };
        break;
      }
      default:
        return null;
    }
    this.optionsControls.set(spec.key, { spec, control, wrap });
    return wrap;
  }

  updateControl(key, value) {
    const c = this.optionsControls.get(key);
    if (!c) {
      for (const entry of this.optionsControls.values()) entry.control.render?.();
      return;
    }
    const { control, spec } = c;
    if (control.input && spec.kind !== 'checkbox') control.input.value = String(value);
    if (control.range) control.range.value = String(value);
    if (control.input && spec.kind === 'checkbox') control.input.checked = !!value;
    if (control.select) control.select.value = String(value);
    if (control.seg) for (const b of control.seg.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(value)));
    control.render?.();
    for (const entry of this.optionsControls.values()) if (entry !== c) entry.control.render?.();
  }
}

function clampNum(n, spec) {
  if (!Number.isFinite(n)) return spec.default ?? 0;
  if (spec.min !== undefined) n = Math.max(spec.min, n);
  if (spec.max !== undefined) n = Math.min(spec.max, n);
  return n;
}

/** Shared option specs. */
export const BRUSH_OPTIONS = [
  { kind: 'brush', key: 'preset', label: '' },
  { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 1000, step: 1, default: 24, unit: 'px' },
  { kind: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 0.01, default: 0.8 },
  { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
  { kind: 'slider', key: 'flow', label: 'Flow', min: 0.01, max: 1, step: 0.01, default: 1 },
  { kind: 'slider', key: 'smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.05, default: 0.2 },
  { kind: 'checkbox', key: 'pressureSize', label: 'Pen pressure → size', default: true },
  { kind: 'checkbox', key: 'pressureOpacity', label: 'Pressure → opacity', default: false },
];
