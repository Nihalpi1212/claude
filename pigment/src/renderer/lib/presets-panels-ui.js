// presets-panels' shared UI (ARCHITECTURE.md "0.5 features", package 9): the preset grid the Styles, Shapes and Tool
// Presets panels, the Layer Style dialog's Styles page and the Custom Shape picker show; the thumbnails of the three
// kinds; the library actions they share (rename, new group, delete); the `custom-shape` field widget of the Custom
// Shape tool's options bar (registered when this module loads, E7).
//
//   presetGrid(app, kind, { view, thumb, filter, mime, onPick, onActivate, onContext, className, label })
//     -> { element, refresh(), selection(), select(ids), destroy() }
//
// Class names start with `pset-` (the patterns package's picker owns `pp-`). Nothing here touches the DOM at import
// time: lib/tools/vector.js imports this module.
import { icon } from './icons.js';
import { registerWidget } from './fields.js';
import { applyStyles, scaleEffects, hasEnabledStyles } from '../../shared/pixels/styles.js';
import { isPatternRef, enabledEffects } from './presets-panels-model.js';

export const VIEWS = Object.freeze([
  ['small', 'Small Thumbnail', 28],
  ['large', 'Large Thumbnail', 48],
  ['list', 'Small List', 24],
  ['text', 'Text Only', 0],
]);
const viewOf = (id) => VIEWS.find((v) => v[0] === id) ?? VIEWS[0];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const canvasOf = (w, h = w) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
};

/** settings.presetPanels (rule 5): read with its defaults, written as a new object. */
export function panelPrefs(app) {
  return { currentToolOnly: true, ...(app?.settings?.presetPanels ?? {}) };
}
export function savePanelPrefs(app, patch) {
  app?.saveSettingsSoon?.({ presetPanels: { ...panelPrefs(app), ...patch } });
}

// ---- thumbnails ---------------------------------------------------------------------------------------------------

// rendered thumbnails by preset data object (presets are frozen and replaced on every edit): data -> Map(size -> canvas)
const cache = new WeakMap();
const cached = (data, key, make) => {
  if (!isObject(data)) return make();
  let m = cache.get(data);
  if (!m) cache.set(data, (m = new Map()));
  if (m.has(key)) return m.get(key);
  const c = make();
  if (c) m.set(key, c);
  return c;
};
/** A canvas copy of a cached one (an element can be in one place only). */
const copyOf = (src) => {
  const c = canvasOf(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
};

/** The style's effects with every pattern reference replaced by its pixels (ImageData) or null when not loaded. */
function withPatternPixels(app, v, pending) {
  if (Array.isArray(v)) return v.map((x) => withPatternPixels(app, x, pending));
  if (!isObject(v)) return v;
  if (isPatternRef(v)) {
    let px = null;
    try {
      px = app?.patterns?.resolve?.(v) ?? null;
    } catch {
      px = null;
    }
    if (!px) pending.push(v);
    return px;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = withPatternPixels(app, x, pending);
  return out;
}

/**
 * A style preset drawn on a grey square (as Photoshop's Styles panel shows them), its effects scaled to the
 * thumbnail. A pattern still loading leaves its effect off this time: `onReady` runs once it has loaded.
 */
export function styleThumbnail(app, data, size, { onReady = null } = {}) {
  const make = () => {
    const pending = [];
    const styles = withPatternPixels(app, scaleEffects(data?.styles ?? {}, Math.min(1, size / 56)), pending);
    const c = canvasOf(size);
    const ctx = c.getContext('2d');
    const m = Math.round(size * 0.2);
    const base = canvasOf(size);
    const bctx = base.getContext('2d');
    bctx.fillStyle = '#b4b4b4';
    const r = Math.max(2, size * 0.08);
    bctx.beginPath();
    if (bctx.roundRect) bctx.roundRect(m, m, size - 2 * m, size - 2 * m, r);
    else bctx.rect(m, m, size - 2 * m, size - 2 * m);
    bctx.fill();
    if (!hasEnabledStyles(styles)) {
      ctx.drawImage(base, 0, 0);
    } else {
      try {
        const img = bctx.getImageData(0, 0, size, size);
        const out = applyStyles(img, styles, { fillOpacity: data?.fillOpacity ?? 1, globalAngle: 120, globalAltitude: 30 });
        const t = canvasOf(out.image.width, out.image.height);
        t.getContext('2d').putImageData(new ImageData(out.image.data, out.image.width, out.image.height), 0, 0);
        ctx.drawImage(t, out.offsetX, out.offsetY);
      } catch (err) {
        console.warn('A style thumbnail could not be drawn', err);
        ctx.drawImage(base, 0, 0);
      }
    }
    if (pending.length) {
      // not cached: drawn again once the patterns have loaded
      const ids = [...new Set(pending.map((p) => p.presetId).filter(Boolean))];
      Promise.all(ids.map((id) => app?.patterns?.get?.(id))).then(() => onReady?.()).catch(() => {});
      return { canvas: c, keep: false };
    }
    return { canvas: c, keep: true };
  };
  if (!isObject(data)) return make().canvas;
  let m = cache.get(data);
  if (!m) cache.set(data, (m = new Map()));
  const key = `style:${size}`;
  if (m.has(key)) return copyOf(m.get(key));
  const { canvas, keep } = make();
  if (keep) m.set(key, canvas);
  return keep ? copyOf(canvas) : canvas;
}

/** A custom shape's 0..1 outline filled in the thumbnail's colour (its proportions kept). */
export function shapeThumbnail(data, size, { color = null } = {}) {
  const fill = color ?? (getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#222');
  const src = cached(data, `shape:${size}:${fill}`, () => {
    const c = canvasOf(size);
    const ctx = c.getContext('2d');
    const path = data?.path;
    if (!path?.subpaths) return c;
    const pad = Math.max(2, Math.round(size * 0.1));
    const s = size - pad * 2;
    // Defined Proportions: a .csh or defined shape keeps its own width / height
    const ratio = data.width > 0 && data.height > 0 ? data.width / data.height : 1;
    const w = ratio >= 1 ? s : s * ratio, h = ratio >= 1 ? s / ratio : s;
    const ox = pad + (s - w) / 2, oy = pad + (s - h) / 2;
    const X = (x) => ox + x * w, Y = (y) => oy + y * h;
    ctx.beginPath();
    for (const sp of path.subpaths) {
      const pts = sp.points ?? [];
      if (!pts.length) continue;
      ctx.moveTo(X(pts[0].x), Y(pts[0].y));
      const seg = (a, b) => ctx.bezierCurveTo(X(a.outX ?? a.x), Y(a.outY ?? a.y), X(b.inX ?? b.x), Y(b.inY ?? b.y), X(b.x), Y(b.y));
      for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
      if (sp.closed !== false) {
        seg(pts[pts.length - 1], pts[0]);
        ctx.closePath();
      }
    }
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
    return c;
  });
  return copyOf(src);
}

/** A tool preset's thumbnail: its tool's icon (and its colour when it carries one). */
export function toolPresetThumbnail(app, data, size) {
  const tool = app?.tools?.get?.(data?.tool);
  const span = el('span', 'pset-tool-icon');
  span.innerHTML = icon(tool?.icon ?? 'brush');
  span.style.setProperty('--pset-size', `${size}px`);
  if (data?.color) {
    const dot = el('span', 'pset-tool-color');
    dot.style.background = data.color;
    span.appendChild(dot);
  }
  return span;
}

/** The tooltip of a style: its name, or that it has no effects on. */
export function styleTitle(preset) {
  return enabledEffects(preset?.data?.styles).length ? preset.name : `${preset.name} (no effects)`;
}

// ---- the grid -----------------------------------------------------------------------------------------------------

/**
 * The presets of a kind in their groups (collapsible headings; collapsed state in settings.presetPanels.collapsed),
 * in the store's order. Click picks (Ctrl/Cmd adds to the selection, Shift selects a range, both without picking),
 * double-click activates (renames), a right-click opens `onContext`. Dragging a preset onto another one or onto a group
 * heading reorders or regroups it; with `mime` the drag also carries `{ id }` (JSON) for the canvas and the layer rows.
 */
export function presetGrid(app, kind, opts = {}) {
  const root = el('div', `pset-grid${opts.className ? ` ${opts.className}` : ''}`);
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-multiselectable', 'true');
  root.setAttribute('aria-label', opts.label ?? kind);
  root.dataset.kind = kind;
  const ORDER_MIME = `application/x-pigment-preset-order-${kind}`;
  let selected = new Set(opts.selected ?? []);
  let anchor = null;
  let shown = []; // the presets in display order (Shift ranges)
  let frame = 0;

  const view = () => viewOf(typeof opts.view === 'function' ? opts.view() : opts.view ?? 'small');
  const collapsedOf = () => panelPrefs(app).collapsed ?? {};
  const toggleGroup = (gid) => {
    const c = { ...collapsedOf() };
    const key = `${kind}:${gid}`;
    if (c[key]) delete c[key];
    else c[key] = true;
    savePanelPrefs(app, { collapsed: c });
    render();
  };

  const mark = () => {
    for (const b of root.querySelectorAll('.pset-item')) b.setAttribute('aria-selected', String(selected.has(b.dataset.id)));
  };

  const thumbOf = (preset, size) => {
    try {
      return opts.thumb ? opts.thumb(preset, size, { onReady: schedule }) : null;
    } catch (err) {
      console.warn('A preset thumbnail could not be drawn', err);
      return null;
    }
  };

  const item = (preset) => {
    const [v, , size] = view();
    const b = el('button', 'pset-item');
    b.type = 'button';
    b.dataset.id = preset.id;
    b.dataset.view = v;
    b.title = opts.title ? opts.title(preset) : preset.name;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(selected.has(preset.id)));
    b.setAttribute('aria-label', preset.name);
    if (v !== 'text') {
      const t = thumbOf(preset, size || 24);
      if (t) {
        t.classList?.add('pset-thumb');
        b.appendChild(t);
      }
    }
    if (v === 'list' || v === 'text') b.appendChild(el('span', 'pset-name', preset.name));
    b.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (selected.has(preset.id)) selected.delete(preset.id);
        else selected.add(preset.id);
        anchor = preset.id;
        mark();
        opts.onSelect?.([...selected]);
        return;
      }
      if (e.shiftKey && anchor && opts.shiftSelects !== false) {
        const a = shown.findIndex((p) => p.id === anchor), z = shown.findIndex((p) => p.id === preset.id);
        if (a >= 0 && z >= 0) {
          selected = new Set(shown.slice(Math.min(a, z), Math.max(a, z) + 1).map((p) => p.id));
          mark();
          opts.onSelect?.([...selected]);
          return;
        }
      }
      selected = new Set([preset.id]);
      anchor = preset.id;
      mark();
      opts.onSelect?.([...selected]);
      opts.onPick?.(preset, e);
    });
    b.addEventListener('dblclick', (e) => opts.onActivate?.(preset, e));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selected.has(preset.id)) {
        selected = new Set([preset.id]);
        anchor = preset.id;
        mark();
      }
      opts.onContext?.(preset, e);
    });
    if (opts.draggable !== false) {
      b.draggable = true;
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(ORDER_MIME, preset.id);
        if (opts.mime) e.dataTransfer.setData(opts.mime, JSON.stringify({ id: preset.id, name: preset.name }));
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      b.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes(ORDER_MIME)) e.preventDefault();
      });
      b.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData(ORDER_MIME);
        if (!id || id === preset.id) return;
        e.preventDefault();
        e.stopPropagation();
        moveBefore(id, preset);
      });
    }
    return b;
  };

  const moveBefore = async (id, target) => {
    await app.presets.ready(kind);
    const group = target.group ?? null;
    const members = app.presets.list(kind, { group }).filter((p) => p.id !== id);
    const index = members.findIndex((p) => p.id === target.id);
    app.presets.move(kind, id, { group, index: index < 0 ? members.length : index });
  };

  const block = (g, presets, children, depth) => {
    const box = el('div', 'pset-group');
    box.dataset.group = g.id;
    const key = `${kind}:${g.id}`;
    const collapsed = !!collapsedOf()[key];
    const head = el('button', 'pset-group-head');
    head.type = 'button';
    head.style.paddingLeft = `${4 + depth * 12}px`;
    head.setAttribute('aria-expanded', String(!collapsed));
    head.innerHTML = `${icon(collapsed ? 'chevron-right' : 'chevron-down')}${icon('folder')}`;
    head.appendChild(el('span', 'pset-group-name', g.name));
    head.addEventListener('click', () => toggleGroup(g.id));
    head.addEventListener('dblclick', (e) => {
      e.preventDefault();
      opts.onGroupActivate?.(g);
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.onGroupContext?.(g, e);
    });
    head.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes(ORDER_MIME)) e.preventDefault();
    });
    head.addEventListener('drop', async (e) => {
      const id = e.dataTransfer.getData(ORDER_MIME);
      if (!id) return;
      e.preventDefault();
      await app.presets.ready(kind);
      app.presets.move(kind, id, { group: g.id });
    });
    box.appendChild(head);
    if (!collapsed) {
      const items = el('div', 'pset-items');
      for (const p of presets) {
        items.appendChild(item(p));
        shown.push(p);
      }
      box.appendChild(items);
      for (const c of children) box.appendChild(c());
    }
    return box;
  };

  function render() {
    cancelAnimationFrame(frame);
    frame = 0;
    root.replaceChildren();
    shown = [];
    const [v] = view();
    root.dataset.view = v;
    const filter = opts.filter ?? (() => true);
    const all = app.presets.list(kind).filter(filter);
    const groups = app.presets.groups(kind);
    const ids = new Set(groups.map((g) => g.id));
    const loose = all.filter((p) => !p.group || !ids.has(p.group));
    if (loose.length) {
      const items = el('div', 'pset-items pset-loose');
      for (const p of loose) {
        items.appendChild(item(p));
        shown.push(p);
      }
      root.appendChild(items);
    }
    const build = (g, depth) => () => {
      const presets = all.filter((p) => p.group === g.id);
      const kids = groups.filter((c) => c.parent === g.id).map((c) => build(c, depth + 1));
      return block(g, presets, kids, depth);
    };
    for (const g of groups.filter((x) => !x.parent || !ids.has(x.parent))) {
      // a group the filter emptied (Current Tool Only) is not shown; an empty group of the library is
      const hasAny = (gg) => all.some((p) => p.group === gg.id) || groups.some((c) => c.parent === gg.id && hasAny(c));
      if (opts.filter && !hasAny(g)) continue;
      root.appendChild(build(g, 0)());
    }
    if (!shown.length && !root.querySelector('.pset-group')) root.appendChild(el('p', 'pset-empty muted', opts.empty ?? 'No presets'));
    // the selection keeps only what is still there
    const present = new Set(all.map((p) => p.id));
    selected = new Set([...selected].filter((id) => present.has(id)));
    mark();
  }
  // a pattern a thumbnail waited for has loaded: drawn again on the next frame (once for several)
  function schedule() {
    if (frame || !root.isConnected) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  const onChange = (e) => {
    if (e.detail?.kind === kind) render();
  };
  app.presets.addEventListener('change', onChange);
  app.presets.ready(kind).then(() => render()).catch(() => {});
  render();
  return {
    element: root,
    refresh: render,
    selection: () => [...selected],
    select(ids) {
      selected = new Set(Array.isArray(ids) ? ids : ids ? [ids] : []);
      anchor = [...selected][0] ?? null;
      mark();
    },
    destroy() {
      cancelAnimationFrame(frame);
      app.presets.removeEventListener('change', onChange);
      root.remove();
    },
  };
}

// ---- library actions ----------------------------------------------------------------------------------------------

const kindNoun = { styles: 'Style', shapes: 'Shape', 'tool-presets': 'Tool Preset' };

/** Rename… (a double-click on a preset): Photoshop's "<Kind> Name" dialog. */
export async function renamePresetDialog(app, kind, preset) {
  if (!preset) return null;
  const name = await app.dialogs.prompt('Name', { title: `${kindNoun[kind] ?? 'Preset'} Name`, value: preset.name });
  if (name === null || !name.trim() || name.trim() === preset.name) return null;
  await app.presets.ready(kind);
  return app.presets.update(kind, preset.id, { name: name.trim() });
}

/** New Group…: a group named by the user, at the top level. */
export async function newGroupDialog(app, kind) {
  const n = app.presets.groups(kind).length + 1;
  const name = await app.dialogs.prompt('Name', { title: 'Group Name', value: `Group ${n}` });
  if (name === null || !name.trim()) return null;
  await app.presets.ready(kind);
  return app.presets.addGroup(kind, { name: name.trim() });
}

/** Rename a group (double-click on its heading). */
export async function renameGroupDialog(app, kind, group) {
  const name = await app.dialogs.prompt('Name', { title: 'Group Name', value: group.name });
  if (name === null || !name.trim()) return;
  await app.presets.ready(kind);
  app.presets.renameGroup(kind, group.id, name.trim());
}

/** Delete: the selected presets (a confirmation for more than one, as Photoshop asks). */
export async function deletePresetsAction(app, kind, ids) {
  const list = (ids ?? []).filter(Boolean);
  if (!list.length) {
    app.dialogs.toast(`Select a ${(kindNoun[kind] ?? 'preset').toLowerCase()} first`, { kind: 'info', timeout: 1800 });
    return false;
  }
  if (list.length > 1 && !(await app.dialogs.confirm(`Delete the ${list.length} selected ${kindNoun[kind] ? `${kindNoun[kind].toLowerCase()}s` : 'presets'}?`, { title: 'Delete', okLabel: 'Delete', danger: true }))) return false;
  await app.presets.ready(kind);
  app.presets.remove(kind, list);
  return true;
}

/** Delete Group: its presets go with it unless the user keeps them (moved up a level). */
export async function deleteGroupAction(app, kind, group) {
  const n = app.presets.list(kind, { group: group.id }).length;
  let keepPresets = true;
  if (n) {
    const choice = await app.dialogs.open({
      title: 'Delete Group',
      content: `<p>Delete the group "${group.name.replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`)}" and its ${n} ${n === 1 ? 'preset' : 'presets'}, or keep the presets?</p>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Keep Presets', value: 'keep' }, { label: 'Delete All', value: 'all', danger: true, primary: true }],
    });
    if (!choice) return false;
    keepPresets = choice === 'keep';
  }
  await app.presets.ready(kind);
  app.presets.removeGroup(kind, group.id, { keepPresets });
  return true;
}

/** The Pigment-made libraries of a kind as popover items (preset-files-manager's pigmentLibraries / loadPigmentLibrary). */
export async function libraryMenuItems(app, kind) {
  try {
    const m = await import('./preset-manager.js');
    if (typeof m.pigmentLibraries !== 'function') return [];
    const libs = await m.pigmentLibraries(kind);
    return libs.map((l) => ({ label: `Load ${l.name}`, onSelect: () => m.loadPigmentLibrary(app, l.id) }));
  } catch {
    return [];
  }
}

// ---- the Custom Shape picker (the `custom-shape` widget of the options bar) -------------------------------------

function customShapeWidget(spec, { value, onChange, app }) {
  let current = value ?? spec.default ?? null;
  const wrap = el('span', 'pset-shape-widget');
  const btn = el('button', 'btn small pset-shape-button');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'true');
  wrap.appendChild(btn);
  const presetOf = (id) => app?.presets?.get?.('shapes', id) ?? null;
  const paint = () => {
    const p = presetOf(current);
    btn.replaceChildren();
    if (p) btn.appendChild(shapeThumbnail(p.data, 20));
    else btn.appendChild(el('span', 'pset-shape-missing', '?'));
    const caret = el('span', 'pset-caret');
    caret.innerHTML = icon('chevron-down');
    btn.appendChild(caret);
    const title = p ? `Shape: ${p.name}` : 'Shape (missing: pick another)';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  };
  let grid = null;
  btn.addEventListener('click', () => {
    if (!app?.presets) return;
    grid?.destroy();
    grid = presetGrid(app, 'shapes', {
      view: 'large',
      className: 'pset-shape-picker',
      label: 'Custom shapes',
      selected: current ? [current] : [],
      draggable: false,
      shiftSelects: false,
      thumb: (p, size) => shapeThumbnail(p.data, size),
      onPick: (p) => {
        current = p.id;
        paint();
        onChange(p.id);
        app.dialogs.closePopover();
      },
    });
    const pop = app.dialogs.popover(btn, [{ type: 'custom', element: grid.element }], { align: 'left' });
    pop.classList.add('pset-popover');
    const g = grid;
    const obs = new MutationObserver(() => {
      if (!pop.isConnected) {
        g.destroy();
        if (grid === g) grid = null;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  });
  // the shapes load after the bar is drawn (the store reads its file once): the button follows them
  // the options bar drops its controls without destroying them: the listener goes once the button has left the page
  let seen = false;
  const onStore = (e) => {
    if (!wrap.isConnected) {
      if (seen) app.presets.removeEventListener('change', onStore);
      return;
    }
    seen = true;
    if (e.detail?.kind === 'shapes') paint();
  };
  app?.presets?.addEventListener?.('change', onStore);
  // a widget that never reached the page (a bar rebuilt at once) lets go as well
  requestAnimationFrame(() => {
    if (wrap.isConnected) seen = true;
    else app?.presets?.removeEventListener?.('change', onStore);
  });
  paint();
  return {
    element: wrap,
    get: () => current,
    set(v) {
      current = v ?? null;
      paint();
    },
    setDisabled(b) {
      btn.disabled = !!b;
    },
    destroy() {
      app?.presets?.removeEventListener?.('change', onStore);
      grid?.destroy();
      wrap.remove();
    },
  };
}

registerWidget('custom-shape', customShapeWidget);
