// Properties panel (middle group): context-sensitive settings of the active layer.
//   adjustment layer -> its parameter editor (live, undoable, consecutive edits merge into one entry)
//   fill layer       -> colour / gradient / pattern summary and Edit…
//   pixel/text/shape/group -> W/H/X/Y of the content (X/Y editable, undoable), align buttons,
//                       shape fill/stroke, text summary
//   any layer        -> layer mask section (edit, select, invert, enable/disable, apply, delete)
//   no layer         -> document size / resolution
import { icon } from '../icons.js';
import { buildAdjustmentEditor, adjustmentSource, ADJUSTMENT_ICONS } from '../adjust-ui.js';
import { setLayerProps } from '../layer-ops.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { createCanvas, copyCanvas, unionRect, BLEND_LABELS } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const TYPE_LABEL = { raster: 'Pixel layer', group: 'Group', text: 'Type layer', shape: 'Shape layer', fill: 'Fill layer', adjustment: 'Adjustment layer' };
const TYPE_ICON = { raster: 'image', group: 'folder', text: 'text', shape: 'shape', fill: 'fill', adjustment: 'adjust' };
const MAX_SCAN = 25e6; // pixels: larger canvases report their canvas box instead of a scanned content box

// ---- content bounds (cached per layer version) ----------------------------------------------------------------
const boundsCache = new WeakMap();

function alphaBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w * h > MAX_SCAN) return { x: 0, y: 0, width: w, height: h };
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let top = -1, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (data[row + x * 4 + 3]) {
      first = x;
      break;
    }
    if (first < 0) continue;
    for (let x = w - 1; x >= first; x--) if (data[row + x * 4 + 3]) {
      last = x;
      break;
    }
    if (top < 0) top = y;
    bottom = y;
    if (first < left) left = first;
    if (last > right) right = last;
  }
  if (top < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Bounds of what the layer draws (non-transparent pixels), in document coordinates; null when empty. */
export function layerContentBounds(layer) {
  if (!layer || layer.type === 'adjustment') return null;
  if (layer.isGroup) {
    let b = null;
    for (const c of layer.children) {
      const cb = layerContentBounds(c);
      if (cb) b = b ? unionRect(b, cb) : { ...cb };
    }
    return b;
  }
  const cached = boundsCache.get(layer);
  if (cached && cached.version === layer.version) return cached.rect;
  let rect = null;
  try {
    let src = null;
    if (layer.type === 'raster') src = { canvas: layer.canvas, x: layer.x, y: layer.y };
    else if (typeof layer.render === 'function') src = layer.render();
    if (src?.canvas) {
      const r = alphaBounds(src.canvas);
      rect = r ? { x: r.x + src.x, y: r.y + src.y, width: r.width, height: r.height } : null;
    }
  } catch {
    rect = layer.bounds?.() ?? null;
  }
  boundsCache.set(layer, { version: layer.version, rect });
  return rect;
}

// ---- undoable offset of a layer (and its children / linked mask) ------------------------------------------------
function shiftPath(path, dx, dy) {
  const p = clone(path);
  for (const sp of p.subpaths ?? []) for (const pt of sp.points ?? []) {
    pt.x += dx;
    pt.y += dy;
    if (pt.inX !== undefined) pt.inX += dx;
    if (pt.inY !== undefined) pt.inY += dy;
    if (pt.outX !== undefined) pt.outX += dx;
    if (pt.outY !== undefined) pt.outY += dy;
  }
  return p;
}

function shiftedCanvas(src, dx, dy) {
  const c = createCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, dx, dy);
  return c;
}

function captureState(l) {
  const s = { l };
  if (l.type !== 'group' && typeof l.x === 'number') {
    s.x = l.x;
    s.y = l.y;
  }
  if (l.type === 'text') s.transform = l.transform ? l.transform.slice() : null;
  if (l.type === 'shape') s.path = clone(l.path);
  if (l.mask?.canvas) s.maskCanvas = l.mask.canvas;
  return s;
}

function shiftedState(s, dx, dy) {
  const n = { ...s };
  const l = s.l;
  if (l.type === 'text' && s.transform) {
    n.transform = s.transform.slice();
    n.transform[4] += dx;
    n.transform[5] += dy;
  } else if (s.x !== undefined) {
    n.x = s.x + dx;
    n.y = s.y + dy;
  }
  if (l.type === 'shape' && s.path) {
    n.path = shiftPath(s.path, dx, dy);
    if (s.x !== undefined) {
      n.x = s.x + dx;
      n.y = s.y + dy;
    }
  }
  if (s.maskCanvas && l.mask?.linked !== false) n.maskCanvas = shiftedCanvas(s.maskCanvas, dx, dy);
  return n;
}

function applyState(s) {
  const l = s.l;
  if (s.x !== undefined) {
    l.x = s.x;
    l.y = s.y;
  }
  if ('transform' in s) l.transform = s.transform ? s.transform.slice() : null;
  if (s.path) l.path = clone(s.path);
  if (s.maskCanvas && l.mask) l.mask = { ...l.mask, canvas: s.maskCanvas };
  l.touch();
}

export function offsetLayer(app, layer, dx, dy, label = 'Move') {
  const doc = app.doc;
  if (!doc || !layer || (!dx && !dy)) return;
  const all = [];
  const walk = (l) => {
    all.push(l);
    if (l.isGroup) for (const c of l.children) walk(c);
  };
  walk(layer);
  // fill and adjustment layers have no position of their own; only their (linked) masks move
  const movable = all.filter((l) => !(l.type === 'fill' || l.type === 'adjustment' || l.isGroup) || l.mask?.canvas);
  const before = movable.map(captureState);
  const after = before.map((s) => shiftedState(s, dx, dy));
  const apply = (states) => {
    for (const s of states) applyState(s);
    doc.changed('props', { layer });
  };
  apply(after);
  let bytes = 0;
  after.forEach((s, i) => {
    if (s.maskCanvas && s.maskCanvas !== before[i].maskCanvas) bytes += s.maskCanvas.width * s.maskCanvas.height * 4;
  });
  doc.history.push({ label, undo: () => apply(before), redo: () => apply(after), bytes, at: Date.now() });
  doc.changed('history');
}

// ---- small DOM helpers ------------------------------------------------------------------------------------------
function h(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, iconName, title, onClick, { cls = 'btn small' } = {}) {
  const b = h('button', cls);
  b.type = 'button';
  b.innerHTML = `${iconName ? icon(iconName) : ''}${label ? `<span>${label}</span>` : ''}`;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function section(title) {
  const s = h('div', 'panel-section');
  if (title) s.appendChild(h('h4', '', title));
  return s;
}

function row(label, content) {
  const r = h('div', 'prop-row');
  r.appendChild(h('span', '', label));
  for (const c of [].concat(content)) if (c) r.appendChild(c);
  return r;
}

function cssPaint(color) {
  return rgbaToHex(parseColor(color), true);
}

function gradientCss(g) {
  const stops = (g?.stops?.length ? g.stops : [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }]).slice().sort((a, b) => a.pos - b.pos);
  const list = g?.reverse ? stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).reverse() : stops;
  return `linear-gradient(to right, ${list.map((s) => `${cssPaint(s.color)} ${Math.round(s.pos * 100)}%`).join(', ')})`;
}

// ---- panel ------------------------------------------------------------------------------------------------------
export function install(app) {
  const el = h('div', 'props-panel');
  const header = h('div', 'props-header');
  const main = h('div', 'props-main');
  const maskBox = h('div', 'props-mask');
  el.append(header, main, maskBox);

  let built = null; // adjustment editor state: { layerId, kind, params, docId }
  let pending = 0;
  let dirty = true;

  const visible = () => app.panels.isVisible('properties');
  const schedule = () => {
    dirty = true;
    if (pending || !visible()) return;
    pending = requestAnimationFrame(render);
  };

  function empty(text) {
    built = null;
    header.replaceChildren();
    maskBox.replaceChildren();
    main.replaceChildren(h('div', 'panel-empty', text));
  }

  function render() {
    pending = 0;
    dirty = false;
    const doc = app.doc;
    if (!doc) return empty('No document open');
    const layer = doc.active;
    if (!layer) {
      built = null;
      renderHeader(null, doc);
      maskBox.replaceChildren();
      main.replaceChildren(documentSection(doc));
      return;
    }
    renderHeader(layer, doc);
    if (layer.type === 'adjustment') renderAdjustment(layer, doc);
    else {
      built = null;
      // do not rebuild a form the user is typing in
      if (!(main.contains(document.activeElement) && main.dataset.layer === layer.id && document.activeElement.tagName === 'INPUT')) renderLayer(layer, doc);
    }
    main.dataset.layer = layer.id;
    renderMask(layer, doc);
  }

  function renderHeader(layer, doc) {
    header.replaceChildren();
    const ic = h('span', 'props-icon');
    ic.innerHTML = icon(layer ? (layer.type === 'adjustment' ? ADJUSTMENT_ICONS[layer.kind] ?? 'adjust' : TYPE_ICON[layer.type] ?? 'layers') : 'image');
    const text = h('div', 'props-title');
    text.appendChild(h('strong', '', layer ? layer.name : doc.name));
    const sub = layer ? (layer.type === 'adjustment' ? `${ADJUSTMENTS[layer.kind]?.name ?? layer.kind} adjustment` : TYPE_LABEL[layer.type] ?? layer.type) : 'Document';
    text.appendChild(h('span', 'muted', sub + (layer && layer.blend !== 'normal' && layer.blend !== 'pass-through' ? ` · ${BLEND_LABELS[layer.blend] ?? layer.blend}` : '') + (layer && layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : '')));
    header.append(ic, text);
  }

  function documentSection(doc) {
    const s = section('Canvas');
    s.appendChild(row('Width', h('span', 'props-value', `${doc.width} px`)));
    s.appendChild(row('Height', h('span', 'props-value', `${doc.height} px`)));
    s.appendChild(row('Resolution', h('span', 'props-value', `${doc.dpi} ppi`)));
    s.appendChild(row('Mode', h('span', 'props-value', 'RGB colour, 8 bits/channel')));
    const acts = h('div', 'props-actions');
    acts.append(
      button('Image Size…', null, 'Image › Image Size', () => app.commands.run('image:size', undefined, 'panel')),
      button('Canvas Size…', null, 'Image › Canvas Size', () => app.commands.run('image:canvas-size', undefined, 'panel'))
    );
    s.appendChild(acts);
    const wrap = h('div');
    wrap.append(s, h('div', 'panel-empty', 'Select a layer to see its properties'));
    return wrap;
  }

  // ---- adjustment layers ----------------------------------------------------------------------------------
  function renderAdjustment(layer, doc) {
    const same = built && built.docId === doc.id && built.layerId === layer.id && built.kind === layer.kind && built.params === layer.params && main.dataset.layer === layer.id;
    if (same) {
      built.toolbar.querySelector('[data-act="clip"]')?.classList.toggle('active', !!layer.clip);
      const eye = built.toolbar.querySelector('[data-act="eye"]');
      if (eye) eye.innerHTML = icon(layer.visible ? 'eye' : 'eye-off');
      return;
    }
    main.replaceChildren();
    const toolbar = h('div', 'panel-toolbar props-adjust-bar');
    const tb = (act, ic, title, fn) => {
      const b = button('', ic, title, fn, { cls: 'pbtn' });
      b.dataset.act = act;
      toolbar.appendChild(b);
      return b;
    };
    tb('clip', 'link', 'Clip to the layer below (only it is affected)', () => app.commands.run('layer:clip', undefined, 'panel')).classList.toggle('active', !!layer.clip);
    tb('reset', 'refresh', 'Reset to adjustment defaults', () => {
      setLayerProps(app, layer, { params: clone(ADJUSTMENTS[layer.kind]?.defaults ?? {}) }, `Reset ${layer.name}`);
    });
    tb('eye', layer.visible ? 'eye' : 'eye-off', 'Toggle layer visibility', () => app.commands.run('layer:visibility', layer.id, 'panel'));
    toolbar.appendChild(h('span', 'props-spacer'));
    tb('delete', 'trash', 'Delete this adjustment layer', () => app.commands.run('layer:delete', undefined, 'panel'));
    main.appendChild(toolbar);
    let source = null;
    try {
      if (layer.kind === 'levels' || layer.kind === 'curves') source = adjustmentSource(app, layer);
    } catch (err) {
      console.warn('adjustment histogram unavailable', err);
    }
    const state = { docId: doc.id, layerId: layer.id, kind: layer.kind, params: layer.params, toolbar };
    const editor = buildAdjustmentEditor(layer.kind, layer.params, (params) => {
      if (app.doc !== doc || doc.active !== layer) return;
      setLayerProps(app, layer, { params: clone(params) }, `Edit ${layer.name}`, { merge: true });
      state.params = layer.params; // our own edit: keep the editor (and the user's drag) alive
    }, { source });
    const body = h('div', 'props-adjust');
    body.appendChild(editor.element);
    main.appendChild(body);
    built = state;
  }

  // ---- pixel / text / shape / group / fill layers -------------------------------------------------------------
  function renderLayer(layer, doc) {
    main.replaceChildren();
    if (layer.type === 'fill') {
      main.appendChild(fillSection(layer));
      return;
    }
    main.appendChild(transformSection(layer, doc));
    if (layer.type === 'shape') main.appendChild(shapeSection(layer, doc));
    if (layer.type === 'text') main.appendChild(textSection(layer));
  }

  function transformSection(layer, doc) {
    const s = section('Transform');
    const b = layerContentBounds(layer);
    const locked = layer.locked.position || layer.locked.all;
    const num = (value, axis) => {
      const input = h('input', 'input num');
      input.type = 'number';
      input.step = '1';
      input.value = String(Math.round(value));
      input.disabled = locked || !b;
      input.dataset.axis = axis;
      input.title = locked ? 'The layer position is locked' : `${axis.toUpperCase()} position of the layer's left/top edge (px)`;
      const commit = () => {
        const v = Math.round(Number(input.value));
        if (!Number.isFinite(v) || !b) return;
        const d = v - (axis === 'x' ? b.x : b.y);
        if (d) offsetLayer(app, layer, axis === 'x' ? d : 0, axis === 'y' ? d : 0, 'Move');
        input.blur();
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          input.value = String(Math.round(value));
          input.blur();
        }
      });
      return input;
    };
    const grid = h('div', 'props-xywh');
    const cell = (label, content) => {
      const c = h('label', 'props-cell');
      c.appendChild(h('span', 'muted', label));
      c.appendChild(content);
      return c;
    };
    const ro = (v) => {
      const i = h('input', 'input num');
      i.value = b ? String(v) : '–';
      i.readOnly = true;
      i.tabIndex = -1;
      return i;
    };
    grid.append(
      cell('W', ro(b?.width ?? 0)),
      cell('H', ro(b?.height ?? 0)),
      cell('X', num(b?.x ?? 0, 'x')),
      cell('Y', num(b?.y ?? 0, 'y'))
    );
    s.appendChild(grid);
    if (!b) s.appendChild(h('div', 'muted props-note', layer.isGroup ? 'This group is empty' : 'This layer is empty'));
    const align = h('div', 'props-align');
    align.appendChild(h('span', 'muted', 'Align'));
    for (const [edge, title] of [['left', 'Align left edges'], ['hcenter', 'Align horizontal centres'], ['right', 'Align right edges'], ['top', 'Align top edges'], ['vcenter', 'Align vertical centres'], ['bottom', 'Align bottom edges']]) {
      const btn = button('', `align-${edge}`, `${title} (to the selection, or the canvas)`, () => app.commands.run('layer:align', edge, 'panel'), { cls: 'pbtn' });
      btn.disabled = locked || !b;
      align.appendChild(btn);
    }
    s.appendChild(align);
    void doc;
    return s;
  }

  function colorChip(color, title, onPick) {
    const chip = h('button', 'props-chip');
    chip.type = 'button';
    chip.title = title;
    chip.style.background = cssPaint(color);
    chip.addEventListener('click', onPick);
    return chip;
  }

  function fillSection(layer) {
    const s = section('Fill');
    const p = layer.paint ?? {};
    const edit = () => app.commands.run('layer:edit-fill', layer.id, 'panel');
    if (p.type === 'solid') {
      s.appendChild(row('Color', [colorChip(p.color, 'Edit the fill colour', edit), h('span', 'props-value mono', rgbaToHex(parseColor(p.color)))]));
    } else if (p.type === 'gradient') {
      const bar = h('div', 'gradient-bar props-gradient');
      bar.style.background = gradientCss(p.gradient);
      bar.title = 'Edit the gradient';
      bar.addEventListener('click', edit);
      s.appendChild(row('Gradient', bar));
      const kind = p.gradient?.kind ?? 'linear';
      s.appendChild(row('Style', h('span', 'props-value', kind[0].toUpperCase() + kind.slice(1) + (p.gradient?.reverse ? ' (reversed)' : ''))));
      s.appendChild(row('Stops', h('span', 'props-value', String(p.gradient?.stops?.length ?? 2))));
    } else if (p.type === 'pattern') {
      const sw = h('div', 'props-pattern');
      if (p.pattern?.canvas) {
        const c = createCanvas(48, 24);
        const ctx = c.getContext('2d');
        const pat = ctx.createPattern(p.pattern.canvas, 'repeat');
        if (pat) {
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, 48, 24);
        }
        sw.appendChild(c);
      }
      s.appendChild(row('Pattern', sw));
      s.appendChild(row('Scale', h('span', 'props-value', `${Math.round((p.pattern?.scale ?? 1) * 100)}%`)));
    }
    const acts = h('div', 'props-actions');
    acts.appendChild(button('Edit Fill…', 'edit', 'Change the fill (Layer › Layer Content Options)', edit));
    s.appendChild(acts);
    return s;
  }

  function shapeSection(layer, doc) {
    const s = section('Appearance');
    const fill = layer.fill;
    const stroke = layer.stroke;
    const pick = async (current, title, live, commit) => {
      const c = await app.pickColor?.(current, { title, live });
      live(null);
      if (c) commit(c);
    };
    if (!fill || fill.type === 'solid') {
      const chip = colorChip(fill?.color ?? 'transparent', 'Shape fill colour', () => {
        const original = layer.fill;
        pick(fill?.color ?? app.settings.foreground, 'Shape Fill', (c) => {
          layer.fill = c ? { type: 'solid', color: c } : original;
          layer.touch();
          doc.changed('props', { layer });
        }, (c) => setLayerProps(app, layer, { fill: { type: 'solid', color: c } }, 'Shape fill'));
      });
      if (!fill) chip.classList.add('none');
      const off = button('', 'close', fill ? 'No fill' : 'Shape has no fill', () => setLayerProps(app, layer, { fill: null }, 'Shape fill'), { cls: 'pbtn' });
      off.disabled = !fill;
      s.appendChild(row('Fill', [chip, h('span', 'props-value mono', fill ? rgbaToHex(parseColor(fill.color)) : 'None'), off]));
    } else s.appendChild(row('Fill', h('span', 'props-value', fill.type === 'gradient' ? 'Gradient' : 'Pattern')));
    const strokeColor = stroke?.color ?? (stroke?.paint?.type === 'solid' ? stroke.paint.color : null) ?? '#000000';
    const sChip = colorChip(stroke && stroke.width > 0 ? strokeColor : 'transparent', 'Stroke colour', () => {
      const original = layer.stroke;
      const base = stroke ?? { width: 2, align: 'center' };
      pick(strokeColor, 'Shape Stroke', (c) => {
        layer.stroke = c ? { ...base, color: c, paint: undefined, width: base.width || 2 } : original;
        layer.touch();
        doc.changed('props', { layer });
      }, (c) => setLayerProps(app, layer, { stroke: { ...base, color: c, paint: undefined, width: base.width || 2 } }, 'Shape stroke'));
    });
    if (!stroke || !(stroke.width > 0)) sChip.classList.add('none');
    const width = h('input', 'input num');
    width.type = 'number';
    width.min = '0';
    width.max = '500';
    width.step = '0.5';
    width.value = String(stroke?.width ?? 0);
    width.title = 'Stroke width (px)';
    width.addEventListener('change', () => {
      const w = Math.max(0, Math.min(500, Number(width.value)));
      if (!Number.isFinite(w)) return;
      setLayerProps(app, layer, { stroke: w > 0 ? { align: 'center', color: strokeColor, ...(stroke ?? {}), width: w } : null }, 'Stroke width');
    });
    s.appendChild(row('Stroke', [sChip, width, h('span', 'opt-unit', 'px')]));
    return s;
  }

  function textSection(layer) {
    const s = section('Text');
    const f = layer.font ?? {};
    const preview = h('div', 'props-text-preview', (layer.text ?? '').slice(0, 200) || '(empty)');
    s.appendChild(preview);
    s.appendChild(row('Font', h('span', 'props-value', `${f.family ?? ''} ${f.weight && f.weight !== 400 ? f.weight : ''}${f.italic ? ' italic' : ''}`.trim())));
    s.appendChild(row('Size', h('span', 'props-value', `${Math.round((f.size ?? 0) * 10) / 10} px`)));
    const sw = h('span', 'props-chip static');
    sw.style.background = cssPaint(f.color ?? '#000');
    s.appendChild(row('Color', [sw, h('span', 'props-value mono', rgbaToHex(parseColor(f.color ?? '#000')))]));
    const acts = h('div', 'props-actions');
    if (app.commands.has('layer:edit-text')) acts.appendChild(button('Edit Text', 'text', 'Edit the text on the canvas', () => app.commands.run('layer:edit-text', layer.id, 'panel')));
    if (app.panels.panels?.has?.('character')) acts.appendChild(button('Character…', 'character', 'Show the Character panel', () => app.panels.show('character', { reveal: true })));
    if (acts.childNodes.length) s.appendChild(acts);
    return s;
  }

  // ---- layer mask ---------------------------------------------------------------------------------------------
  function renderMask(layer, doc) {
    maskBox.replaceChildren();
    const s = section('Layer Mask');
    const run = (op) => () => app.commands.run('layer:mask', op, 'panel');
    if (!layer.mask) {
      const acts = h('div', 'props-actions');
      acts.append(
        button('Add Mask', 'mask', 'Add a layer mask (from the selection, if any)', run('auto')),
        button('From Transparency', null, 'Mask from the layer transparency', run('from-transparency'))
      );
      acts.lastChild.disabled = layer.type !== 'raster';
      s.appendChild(acts);
      maskBox.appendChild(s);
      return;
    }
    const m = layer.mask;
    const top = h('div', 'props-mask-row');
    const thumb = h('button', 'layer-thumb mask-thumb props-mask-thumb' + (app.ui.editingMask ? ' selected-thumb' : ''));
    thumb.type = 'button';
    thumb.title = app.ui.editingMask ? 'Editing the mask: click to edit the layer instead' : 'Click to paint on the mask';
    const scale = Math.min(64 / doc.width, 48 / doc.height);
    const c = createCanvas(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    if (m.canvas) ctx.drawImage(m.canvas, 0, 0, c.width, c.height);
    thumb.appendChild(c);
    if (!m.enabled) thumb.classList.add('disabled');
    thumb.addEventListener('click', () => app.setEditingMask(!app.ui.editingMask));
    const info = h('div', 'props-mask-info');
    info.appendChild(h('span', '', m.enabled ? 'Enabled' : 'Disabled'));
    info.appendChild(h('span', 'muted', `${m.linked !== false ? 'Linked to' : 'Unlinked from'} the layer`));
    info.appendChild(h('span', app.ui.editingMask ? 'props-editing' : 'muted', app.ui.editingMask ? 'Painting on the mask' : 'Painting on the layer'));
    top.append(thumb, info);
    s.appendChild(top);
    const acts = h('div', 'props-actions');
    acts.append(
      button(app.ui.editingMask ? 'Edit Layer' : 'Edit Mask', 'brush', 'Choose whether painting changes the mask or the layer', () => app.setEditingMask(!app.ui.editingMask)),
      button('Select', 'marquee-rect', 'Load the mask as a selection', run('select')),
      button('Invert', 'swap', 'Invert the mask', () => invertMask(layer, doc)),
      button(m.enabled ? 'Disable' : 'Enable', m.enabled ? 'eye-off' : 'eye', m.enabled ? 'Disable the mask (Shift-click the mask thumbnail)' : 'Enable the mask', run('toggle')),
      button(m.linked !== false ? 'Unlink' : 'Link', 'link', 'Link or unlink the mask from the layer position', run('link')),
      button('Apply', 'check', 'Apply the mask to the layer pixels and delete it', run('apply')),
      button('Delete', 'trash', 'Delete the mask', run('delete'))
    );
    acts.children[5].disabled = layer.type !== 'raster';
    s.appendChild(acts);
    maskBox.appendChild(s);
  }

  function invertMask(layer, doc) {
    const canvas = layer.mask?.canvas;
    if (!canvas) return;
    doc.history.pixels('Invert mask', canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, (ctx) => {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = 255 - d[i + 3];
      }
      ctx.putImageData(img, 0, 0);
    }, { layer, kind: 'mask' });
    doc.changed('props', { layer });
  }

  // ---- events -------------------------------------------------------------------------------------------------
  app.on('doc:activated', schedule);
  app.on('layer:activated', schedule);
  app.on('history:changed', schedule);
  app.on('mask:editing', schedule);
  app.on('doc:change', (e) => {
    if (['props', 'tree', 'active', 'canvas', 'mask-edit', 'history'].includes(e.kind)) schedule();
    else if (e.kind === 'pixels' || e.kind === 'mask') {
      clearTimeout(schedule.timer);
      schedule.timer = setTimeout(schedule, 300); // content bounds and mask thumbnail after painting
    }
  });

  app.panels.register({
    id: 'properties',
    title: 'Properties',
    icon: 'properties',
    element: el,
    group: 'middle',
    onShow: () => {
      cancelAnimationFrame(pending);
      render();
    },
  });
  render();
  // helpers for other modules and tests
  app.offsetLayer = (layer, dx, dy, label) => offsetLayer(app, layer, dx, dy, label);
  app.layerContentBounds = layerContentBounds;
  void copyCanvas;
  return { render };
}
