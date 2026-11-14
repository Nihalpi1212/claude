// Layers panel: the layer tree with visibility, thumbnails, masks, blend mode, opacity, fill, locks, drag-and-drop,
// rename, context menu and the footer buttons. 0.4 (layers-panel-depth, package 14) adds Photoshop's depth:
//   - scrubby Opacity and Fill (numericField with `scrubby`), applied to every selected layer ({ ids, value }, M.3;
//     a drag over the label is one history entry), and the blend-mode menu with live preview while hovering and
//     arrow-key stepping (lib/blend-preview.js);
//   - lock buttons on every selected layer; controls of the properties the Background rules lock (L.13) disabled;
//   - footer modifiers: New Layer Alt-click { dialog: true }, Ctrl/Cmd-click { below: true }; New Group Alt-click
//     { dialog: true }; Add Mask Alt-click hides, and adds a vector mask once the layer has a layer mask; rows and
//     effect rows dropped on New Layer duplicate, on Delete delete;
//   - drags: every selected row moves together, Alt-drag copies, drops into groups, effect rows between layers;
//     indicators refuse what app.backgroundRules.canPlace refuses;
//   - the eye column: drag down the eyes to show or hide each layer passed over (one history entry), Alt-click solo;
//   - Alt-click on the line between two layers clips the upper one (layer:clip { id });
//   - nested groups: Alt-click a group's triangle opens or closes every group inside it, Ctrl/Cmd-click every group;
//   - effect rows under a layer (lib/panels/layers-effects.js) with the fx twisty;
//   - the panel menu (lib/panels/layers-menu.js) and the Panel Options' thumbnail size and contents.
// The row order and the gestures' rules are pure functions in lib/panels/layers-model.js (unit tested).
import { icon } from '../icons.js';
import { hasEnabledStyles } from '../../../shared/pixels/styles.js';
import { Selection } from '../selection.js';
import { vectorMaskThumb } from '../mask-view.js';
import { numericField } from '../numeric-field.js';
import { blendControl, endBlendPreview } from '../blend-preview.js';
import { createCanvas } from '../document.js';
import {
  panelRows, thumbSpec, dropPlacement, PLACE_MODE, clipEdge, clipCandidate, dragSubjects, dropRefused, sweepTargets,
  groupsIn, alphaBounds, fitBox, listedEffects,
} from './layers-model.js';
import { effectHeaderRow, effectRow, runEffect } from './layers-effects.js';
import { panelMenuItems, panelSettings } from './layers-menu.js';

export function install(app) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="panel-toolbar layers-toolbar layers-toolbar-blend">
      <span class="layers-blend-slot"></span>
      <span class="layers-opacity-slot"></span>
      <button class="pbtn layers-menu-button" data-panel-menu title="Layers panel menu">${icon('menu')}</button>
    </div>
    <div class="panel-toolbar layers-toolbar">
      <span class="muted">Lock</span>
      <button class="pbtn" data-lock="transparency" title="Lock transparent pixels">${icon('lock-alpha')}</button>
      <button class="pbtn" data-lock="pixels" title="Lock image pixels">${icon('brush')}</button>
      <button class="pbtn" data-lock="position" title="Lock position">${icon('move')}</button>
      <button class="pbtn" data-lock="all" title="Lock all">${icon('lock')}</button>
      <span style="flex:1"></span>
      <span class="layers-fill-slot"></span>
    </div>
    <ul class="layer-list" role="tree" aria-label="Layers"></ul>
    <div class="panel-footer">
      <button class="pbtn" data-cmd="layer:link" title="Link layers" hidden>${icon('link')}</button>
      <button class="pbtn" data-menu="style" title="Add a layer style">${icon('fx')}</button>
      <button class="pbtn" data-cmd="layer:mask" data-arg="auto" title="Add layer mask (Alt: hide all; with a layer mask: add a vector mask)">${icon('mask')}</button>
      <button class="pbtn" data-menu="adjust" title="New fill or adjustment layer">${icon('adjust')}</button>
      <button class="pbtn" data-cmd="layer:new-group" title="New group (Alt: with options)">${icon('folder')}</button>
      <button class="pbtn" data-cmd="layer:new" title="New layer (Alt: with options; Ctrl/Cmd: below the current layer). Drop layers here to duplicate them">${icon('plus')}</button>
      <button class="pbtn" data-cmd="layer:delete" title="Delete layer. Drop layers or effects here to delete them">${icon('trash')}</button>
    </div>`;
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  const list = el.querySelector('.layer-list');
  list.style.flex = '1';
  list.style.overflow = 'auto';

  // ---- the controls ------------------------------------------------------------------------------------------
  const doc = () => app.doc;
  /** The layers the controls act on: the selected ones (the active one when none is selected). */
  const targets = () => {
    const d = doc();
    if (!d) return [];
    const sel = d.selectedLayers();
    return sel.length ? sel : d.active ? [d.active] : [];
  };
  const ids = () => targets().map((l) => l.id);
  const locked = (layer, prop) => (app.backgroundRules?.lockedProps?.(layer) ?? []).includes(prop);
  /** The selected layers whose `prop` the Background rules leave free. */
  const free = (prop) => targets().filter((l) => !locked(l, prop));

  const blend = blendControl(app, {
    targets: () => free('blend'),
    commit: (mode) => app.commands.run('layer:blend', { ids: free('blend').map((l) => l.id), value: mode }, 'panel'),
  });
  el.querySelector('.layers-blend-slot').replaceWith(blend.element);

  // a scrub of the label, the arrow keys and the popup slider apply live (merged into one history entry by
  // setLayersProps); typed digits wait for Enter, Tab or leaving the field (the field's change event)
  const percentField = (labelText, attr, commandId, prop, title) => {
    const field = numericField({
      label: labelText,
      scrubby: true,
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      popup: true,
      width: 46,
      className: 'input num',
      onChange: (v) => setPercent(commandId, prop, v),
    });
    field.input.dataset[attr] = '';
    field.input.title = title;
    field.element.title = title;
    field.element.classList.add('layers-percent');
    field.input.addEventListener('input', (e) => {
      if (e.isTrusted && typeof InputEvent !== 'undefined' && e instanceof InputEvent) return; // typing
      const v = field.get();
      if (v !== null) setPercent(commandId, prop, v);
    });
    return field;
  };
  const setPercent = (commandId, prop, v) => {
    const layers = free(prop);
    if (!layers.length || !Number.isFinite(v)) return;
    const value = Math.max(0, Math.min(100, Math.round(v)));
    if (layers.every((l) => Math.round((l[prop] ?? 1) * 100) === value)) return;
    app.commands.run(commandId, { ids: layers.map((l) => l.id), value }, 'panel');
  };
  const opacity = percentField('Opacity', 'opacity', 'layer:opacity', 'opacity', 'Opacity: drag the label to scrub, Shift ten times faster');
  const fill = percentField('Fill', 'fill', 'layer:fill-opacity', 'fillOpacity', 'Fill opacity (excludes layer styles): drag the label to scrub');
  el.querySelector('.layers-opacity-slot').replaceWith(opacity.element);
  el.querySelector('.layers-fill-slot').replaceWith(fill.element);

  for (const b of el.querySelectorAll('[data-lock]')) b.addEventListener('click', () => app.commands.run('layer:lock', { ids: ids(), value: b.dataset.lock }, 'panel'));
  el.querySelector('[data-panel-menu]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, panelMenuItems(app), { align: 'right' }));

  // footer: modifiers (M.3), and drops of rows (duplicate, delete)
  for (const b of el.querySelectorAll('.panel-footer [data-cmd]')) {
    b.addEventListener('click', (e) => footerClick(b.dataset.cmd, b.dataset.arg, e));
    b.addEventListener('dragover', (e) => {
      if (!drag || !['layer:new', 'layer:delete'].includes(b.dataset.cmd)) return;
      if (drag.kind === 'effects' && b.dataset.cmd !== 'layer:delete') return;
      e.preventDefault();
      b.classList.add('drop-target');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', (e) => {
      b.classList.remove('drop-target');
      if (!drag) return;
      e.preventDefault();
      dropOnFooter(b.dataset.cmd);
    });
  }
  el.querySelector('[data-menu="style"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, app.layerStyleMenu?.() ?? [], { align: 'right' }));
  el.querySelector('[data-menu="adjust"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, app.adjustmentLayerMenu?.() ?? [], { align: 'right' }));

  function footerClick(cmd, arg, e) {
    const mod = e.ctrlKey || e.metaKey;
    if (cmd === 'layer:new') {
      const o = {};
      if (e.altKey) o.dialog = true;
      if (mod) o.below = true;
      return app.commands.run('layer:new', Object.keys(o).length ? o : undefined, 'panel');
    }
    if (cmd === 'layer:new-group') return app.commands.run('layer:new-group', e.altKey ? { dialog: true } : undefined, 'panel');
    if (cmd === 'layer:mask') {
      const layer = doc()?.active;
      // Photoshop: the button adds a layer mask, then a vector mask; Alt makes them hide instead of reveal
      if (layer?.mask && !layer.vectorMask && app.commands.has('layer:vector-mask')) return app.commands.run('layer:vector-mask', e.altKey ? 'hide-all' : 'reveal-all', 'panel');
      if (e.altKey && !layer?.mask) return app.commands.run('layer:mask', doc()?.selection && !doc().selection.isEmpty ? 'hide-selection' : 'hide-all', 'panel');
      return app.commands.run('layer:mask', arg, 'panel');
    }
    return app.commands.run(cmd, arg, 'panel');
  }

  function dropOnFooter(cmd) {
    const d = doc();
    const payload = drag;
    endDrag();
    if (!d || !payload) return;
    if (payload.kind === 'effects') {
      if (cmd !== 'layer:delete') return;
      const { layer, pick } = payload;
      if (pick) runEffect(app, { id: layer.id, op: 'delete', key: pick.key, index: pick.index });
      else runEffect(app, { id: layer.id, op: 'clear' });
      return;
    }
    // the dragged layers become the selection, then Duplicate or Delete acts on them
    const layers = payload.layers.filter((l) => d.find(l.id));
    if (!layers.length) return;
    d.selected.clear();
    for (const l of layers) d.selected.add(l);
    d.active = layers[layers.length - 1];
    d.changed('active', { layer: d.active });
    app.commands.run(cmd === 'layer:new' ? 'layer:duplicate' : 'layer:delete', undefined, 'panel');
  }

  // ---- thumbnails ----------------------------------------------------------------------------------------------
  const thumbCache = new WeakMap(); // layer -> { [kind]: { key, canvas } }
  const boundsCache = new WeakMap(); // layer -> { key, box } (content bounds for Thumbnail Contents: Layer Bounds)
  const effectsOpen = new WeakMap(); // layer -> boolean (the fx twisty; default settings.layersPanel.expandEffects)
  let scratch = null;

  /** What the layer draws: { canvas, x, y } in document space, or null. */
  function source(layer) {
    if (layer.type === 'raster') return { canvas: layer.canvas, x: layer.x, y: layer.y };
    if (layer.render) return layer.render() ?? null;
    return null;
  }

  /** The box of the layer's visible pixels (document space), measured on a copy at most 256 px wide (cached). */
  function contentBox(layer, src) {
    const key = `${layer.version}:${src.canvas.width}x${src.canvas.height}@${src.x},${src.y}`;
    const hit = boundsCache.get(layer);
    if (hit?.key === key) return hit.box;
    const sw = src.canvas.width, sh = src.canvas.height;
    let box = null;
    if (sw > 0 && sh > 0) {
      const k = Math.min(1, 256 / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      scratch ??= createCanvas(1, 1);
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src.canvas, 0, 0, w, h);
      const b = alphaBounds(ctx.getImageData(0, 0, w, h).data, w, h);
      if (b) {
        const x0 = Math.max(0, Math.floor(b.x / k)), y0 = Math.max(0, Math.floor(b.y / k));
        const x1 = Math.min(sw, Math.ceil((b.x + b.w) / k)), y1 = Math.min(sh, Math.ceil((b.y + b.h) / k));
        box = { x: src.x + x0, y: src.y + y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      }
    }
    boundsCache.set(layer, { key, box });
    return box;
  }

  function thumb(layer, kind = 'layer') {
    const opts = panelSettings(app);
    const spec = thumbSpec(opts.thumbSize);
    const d = doc();
    const key = `${kind === 'mask' ? 'm' : 'l'}${layer.version}:${spec.w}x${spec.h}:${opts.thumbBounds}:${d.width}x${d.height}`;
    const cache = thumbCache.get(layer) ?? {};
    if (cache[kind]?.key === key) return cache[kind].canvas;
    const W = Math.max(8, spec.w || thumbSpec('small').w), H = Math.max(8, spec.h || thumbSpec('small').h);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    if (kind === 'mask') {
      const f = fitBox(d.width, d.height, W, H);
      c.width = f.w;
      c.height = f.h;
      ctx.scale(f.scale, f.scale);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, d.width, d.height);
      if (layer.mask?.canvas) ctx.drawImage(layer.mask.canvas, 0, 0);
    } else {
      const src = source(layer);
      // Thumbnail Contents: the layer's own pixels (Layer Bounds) or the whole canvas (Entire Document, 0.3)
      const box = src && opts.thumbBounds === 'layer' ? contentBox(layer, src) : null;
      const r = box ?? { x: 0, y: 0, w: d.width, h: d.height };
      const f = fitBox(r.w, r.h, W, H);
      c.width = f.w;
      c.height = f.h;
      if (src) {
        ctx.scale(f.scale, f.scale);
        ctx.drawImage(src.canvas, src.x - r.x, src.y - r.y);
      }
    }
    cache[kind] = { key, canvas: c };
    thumbCache.set(layer, cache);
    return c;
  }

  function typeIcon(layer) {
    return { group: 'folder', text: 'text', shape: 'shape', fill: 'fill', adjustment: 'adjust', smart: 'smart' }[layer.type];
  }

  // ---- rows ----------------------------------------------------------------------------------------------------
  let drag = null; // { kind: 'layers', layers } | { kind: 'effects', layer, pick }
  let sweep = null; // the eye-column drag
  let renaming = null;
  let pending = 0;
  let rows = [];

  const isOpen = (layer) => (effectsOpen.has(layer) ? effectsOpen.get(layer) : panelSettings(app).expandEffects !== false);

  function render() {
    pending = 0;
    if (renaming) return; // the rename input lives in the current rows
    const d = doc();
    list.replaceChildren();
    const opts = panelSettings(app);
    const spec = thumbSpec(opts.thumbSize);
    list.dataset.thumb = opts.thumbSize;
    list.style.setProperty('--layer-row-h', `${spec.row}px`);
    list.style.setProperty('--layer-thumb-w', `${Math.max(spec.w, 14)}px`);
    list.style.setProperty('--layer-thumb-h', `${Math.max(spec.h, 14)}px`);
    if (!d) {
      rows = [];
      list.innerHTML = '<li class="panel-empty">No document open</li>';
      updateControls();
      return;
    }
    // layers-extras (lib/layers-extras.js): Find Layers / Isolate Layers hide the rows that do not match
    const filter = (layer) => app.layerFilter?.(layer);
    rows = panelRows(d.root, { filter, showEffects: opts.showEffects !== false, effectsOpen: isOpen });
    rows.forEach((r, i) => {
      if (r.kind === 'layer') list.appendChild(row(r.layer, r.depth, i));
      // smart objects (lib/smart-object.js): their smart filters are listed under the layer
      else if (r.kind === 'filters') list.appendChild(filterRows(r.layer, r.depth));
      else if (r.kind === 'effects') list.appendChild(effectHeaderRow(app, r.layer, effectCtx(r)));
      else if (r.kind === 'effect') list.appendChild(effectRow(app, r.layer, r.entry, effectCtx(r)));
    });
    updateControls();
  }

  const effectCtx = (r) => ({
    indentPx: r.depth * 14 + 22,
    selected: doc().selected.has(r.layer),
    onDragStart: (e, li, payload) => startDrag(e, li, payload),
    onDragEnd: () => endDrag(),
  });

  function row(layer, depth, index) {
    const d = doc();
    const opts = panelSettings(app);
    const li = document.createElement('li');
    li.className = 'layer-row' + (d.selected.has(layer) ? ' selected' : '') + (d.active === layer ? ' active' : '');
    li.setAttribute('role', 'treeitem');
    li.dataset.id = layer.id;
    li.dataset.row = String(index); // its index in panelRows (the Alt-click clip line)
    li.draggable = !renaming;
    const eye = document.createElement('button');
    eye.className = 'eye' + (layer.visible ? '' : ' off');
    eye.title = layer.visible ? 'Hide layer (drag down the eyes for several; Alt-click: show only this one)' : 'Show layer';
    eye.innerHTML = icon('eye');
    eye.addEventListener('pointerdown', (e) => startSweep(e, layer));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      if (eye.dataset.swept) return; // the sweep already applied it
      if (e.altKey) app.commands.run('layer:solo', layer.id, 'panel');
      else app.commands.run('layer:visibility', layer.id, 'panel');
    });
    li.appendChild(eye);
    const indent = document.createElement('span');
    indent.className = 'layer-indent';
    indent.style.width = `${depth * 14 + (layer.clip ? 12 : 0)}px`;
    li.appendChild(indent);
    if (layer.clip) {
      const mark = document.createElement('span');
      mark.className = 'layer-clip-mark';
      mark.textContent = '↳';
      mark.style.left = `${28 + depth * 14}px`;
      li.appendChild(mark);
    }
    if (layer.isGroup) {
      const tw = document.createElement('button');
      tw.className = 'layer-twisty';
      tw.title = 'Open or close the group (Alt: with the groups inside it; Ctrl/Cmd: every group)';
      tw.innerHTML = icon(layer.expanded ? 'chevron-down' : 'chevron-right');
      tw.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !layer.expanded;
        const groups = e.ctrlKey || e.metaKey ? groupsIn(d.root) : e.altKey ? [layer, ...groupsIn(layer)] : [layer];
        for (const g of groups) g.expanded = open;
        render();
      });
      li.appendChild(tw);
    }
    const noThumb = opts.thumbSize === 'none';
    const t = document.createElement('span');
    t.className = 'layer-thumb' + (!app.ui.editingMask && d.active === layer && layer.mask ? ' selected-thumb' : '');
    if (layer.isGroup || layer.type === 'adjustment' || noThumb) {
      t.innerHTML = icon(typeIcon(layer) ?? 'image');
      t.classList.add('icon-thumb');
    } else t.appendChild(thumb(layer));
    t.addEventListener('click', (e) => {
      if (d.active === layer && app.ui.editingMask) {
        e.stopPropagation();
        app.setEditingMask(false);
      }
    });
    li.appendChild(t);
    if (layer.mask) {
      const link = document.createElement('span');
      link.className = 'layer-link';
      link.textContent = layer.mask.linked !== false ? '⛓' : '';
      link.title = 'Link layer and mask';
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        app.commands.run('layer:mask', 'link', 'panel');
      });
      li.appendChild(link);
      const m = document.createElement('span');
      m.className = 'layer-thumb mask-thumb' + (app.ui.editingMask && d.active === layer ? ' selected-thumb' : '');
      m.title = 'Layer mask: click to edit, Shift-click to disable, Alt-click to view';
      m.appendChild(thumb(layer, 'mask'));
      if (!layer.mask.enabled) m.style.opacity = '0.4';
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) return app.commands.run('layer:mask', 'toggle', 'panel');
        if (d.active !== layer) d.setActive(layer);
        if (e.altKey) return app.commands.run('layer:mask-toggle-view', undefined, 'panel');
        app.setEditingMask(true);
      });
      li.appendChild(m);
    }
    if (layer.vectorMask) {
      // L.15: the vector mask after the raster mask: a link icon and its thumbnail (lib/mask-view.js vectorMaskThumb);
      // clicks run masks-vector-masks' layer:vector-mask
      const vm = layer.vectorMask;
      const vlink = document.createElement('span');
      vlink.className = 'layer-link layer-vector-link';
      vlink.textContent = vm.linked !== false ? '⛓' : '';
      vlink.title = 'Link layer and vector mask';
      vlink.addEventListener('click', (e) => {
        e.stopPropagation();
        if (d.active !== layer) d.setActive(layer);
        app.commands.run('layer:vector-mask', 'link', 'panel');
      });
      li.appendChild(vlink);
      const v = document.createElement('span');
      v.className = 'layer-thumb vector-mask-thumb';
      v.title = 'Vector mask: click to edit its path, Shift-click to disable, Ctrl/Cmd-click to load as a selection';
      const spec = thumbSpec(noThumb ? 'small' : opts.thumbSize);
      v.appendChild(vectorMaskThumb(layer, Math.max(16, spec.w - 4), Math.max(12, spec.h - 6), d));
      if (vm.enabled === false) v.style.opacity = '0.4';
      v.addEventListener('click', (e) => {
        e.stopPropagation();
        if (d.active !== layer) d.setActive(layer);
        const op = e.shiftKey ? 'toggle' : e.ctrlKey || e.metaKey ? 'select' : 'target';
        app.commands.run('layer:vector-mask', op, 'panel');
      });
      li.appendChild(v);
    }
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    if (layer.type === 'text') name.title = layer.text;
    li.appendChild(name);
    const badges = document.createElement('span');
    badges.className = 'layer-badges';
    const listed = listedEffects(layer.styles);
    if (hasEnabledStyles(layer.styles) || listed.length) {
      const fx = document.createElement('span');
      fx.className = 'layer-fx' + (hasEnabledStyles(layer.styles) ? '' : ' off');
      fx.textContent = 'fx';
      fx.title = 'Edit layer style';
      fx.addEventListener('click', (e) => {
        e.stopPropagation();
        d.setActive(layer);
        app.commands.run('layer:style', 'dialog', 'panel');
      });
      badges.appendChild(fx);
      if (listed.length && opts.showEffects !== false) {
        const open = isOpen(layer);
        const tw = document.createElement('button');
        tw.type = 'button';
        tw.className = 'layer-twisty layer-fx-twisty';
        tw.title = open ? 'Hide the effects' : 'Show the effects';
        tw.innerHTML = icon(open ? 'chevron-down' : 'chevron-right');
        tw.addEventListener('click', (e) => {
          e.stopPropagation();
          effectsOpen.set(layer, !open);
          render();
        });
        badges.appendChild(tw);
      }
    }
    if (layer.locked.all || layer.locked.pixels || layer.locked.position || layer.locked.transparency) badges.insertAdjacentHTML('beforeend', icon(layer.locked.all ? 'lock' : 'lock-alpha'));
    if (layer.type === 'text' || layer.type === 'shape' || layer.type === 'fill' || layer.type === 'adjustment') badges.insertAdjacentHTML('beforeend', icon(typeIcon(layer)));
    if (layer.type === 'smart') {
      const b = document.createElement('span');
      b.className = 'layer-smart-badge';
      b.title = 'Smart object: double-click the thumbnail to edit its contents';
      b.innerHTML = icon('smart');
      badges.appendChild(b);
    }
    li.appendChild(badges);

    li.addEventListener('click', (e) => {
      if (e.altKey && !e.target.closest('.layer-thumb, .eye, .layer-twisty, .layer-fx')) {
        // Alt-click on the line between two layers: clip the upper one onto the lower (or release it)
        const r = li.getBoundingClientRect();
        const target = clipCandidate(rows, index, clipEdge(e.clientY - r.top, r.height));
        if (target) {
          app.commands.run('layer:clip', { id: target.id }, 'panel');
          return;
        }
      }
      if (e.shiftKey && d.active) {
        // range select in visual order
        const order = [...list.querySelectorAll('.layer-row:not(.smart-filter-head):not(.smart-filter-row)')].map((r) => r.dataset.id);
        const a = order.indexOf(d.active.id), b = order.indexOf(layer.id);
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        d.selected.clear();
        for (const id of order.slice(lo, hi + 1)) d.selected.add(d.find(id));
        d.active = layer;
        d.changed('active', { layer });
      } else if ((e.ctrlKey || e.metaKey) && e.target.closest('.layer-thumb') && !layer.isGroup && layer.type !== 'adjustment') {
        // Ctrl-click a thumbnail: the layer's transparency (or its mask) as a selection
        const fromMask = !!e.target.closest('.mask-thumb') && layer.mask?.canvas;
        const mode = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        let sel = null;
        if (fromMask) {
          const a = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data;
          const m = new Uint8ClampedArray(d.width * d.height);
          for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
          sel = Selection.fromMask(d.width, d.height, m);
        } else sel = app.layerAlphaSelection?.(layer) ?? null;
        if (sel) app.applySelection(sel, mode, 'Load selection');
      } else if (e.ctrlKey || e.metaKey) {
        if (d.selected.has(layer) && d.selected.size > 1) {
          d.selected.delete(layer);
          if (d.active === layer) d.active = [...d.selected][0];
          d.changed('active', { layer: d.active });
        } else d.setActive(layer, { additive: true });
      } else {
        if (d.active !== layer) app.setEditingMask(false);
        d.setActive(layer);
      }
    });
    li.addEventListener('dblclick', (e) => {
      if (e.target.closest('.eye, .layer-twisty')) return;
      if (e.target.closest('.layer-name')) startRename(layer, name);
      else if (layer.type === 'smart' && e.target.closest('.layer-thumb:not(.mask-thumb)')) app.commands.run('layer:smart-edit', layer.id, 'panel');
      else if (layer.type === 'text') app.commands.run('layer:edit-text', layer.id, 'panel');
      else if (layer.type === 'adjustment' || layer.type === 'fill') app.commands.run('layer:properties', layer.id, 'panel');
      else if (!e.target.closest('.layer-thumb')) app.commands.run('layer:style', 'dialog', 'panel');
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!d.selected.has(layer)) d.setActive(layer);
      app.dialogs.popover(li, contextMenu(layer), { at: { x: e.clientX, y: e.clientY } });
    });
    li.addEventListener('dragstart', (e) => {
      if (sweep) return e.preventDefault(); // a drag down the eye column is not a row drag
      startDrag(e, li, { kind: 'layers', layers: dragSubjects(layer, d.selected, d.layers()) });
    });
    li.addEventListener('dragend', () => endDrag());
    li.addEventListener('dragover', (e) => {
      if (!drag && app.dropHandlerFor?.(e.dataTransfer, 'layer')) return e.preventDefault(); // drop (E25)
      if (!drag) return;
      clearIndicator(li);
      if (drag.kind === 'effects') {
        // effects go onto a layer that takes styles
        if (drag.layer === layer || !effectsTarget(layer)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        li.classList.add('drop-into');
        return;
      }
      const r = li.getBoundingClientRect();
      const mode = dropPlacement((e.clientY - r.top) / r.height, { isGroup: layer.isGroup, expanded: layer.expanded });
      if (!dropAllowed(drag.layers, layer, mode, e.altKey)) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      li.classList.add(mode === 'into' ? 'drop-into' : mode === 'above' ? 'drop-above' : 'drop-below');
    });
    li.addEventListener('dragleave', () => clearIndicator(li));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!drag) {
        // drop (E25): a gradient or a pattern dragged from a panel onto this row
        const found = app.dropHandlerFor?.(e.dataTransfer, 'layer');
        if (found) found.handler.layer(e.dataTransfer.getData(found.mime), layer, e);
        return;
      }
      const payload = drag;
      const mode = li.classList.contains('drop-into') ? 'into' : li.classList.contains('drop-above') ? 'above' : li.classList.contains('drop-below') ? 'below' : null;
      clearIndicator(li);
      endDrag();
      if (!mode) return;
      if (payload.kind === 'effects') {
        const { layer: from, pick } = payload;
        runEffect(app, { id: from.id, op: e.altKey ? 'copy' : 'move', target: layer.id, ...(pick ? { key: pick.key, index: pick.index } : {}) });
        return;
      }
      const moving = payload.layers.filter((l) => l !== layer);
      if (!moving.length) return;
      const arg = { target: layer.id, mode, duplicate: e.altKey };
      if (moving.length === 1) arg.id = moving[0].id;
      else arg.ids = moving.map((l) => l.id);
      app.commands.run('layer:move-to', arg, 'panel');
    });
    app.decorateLayerRow?.(li, layer); // layers-extras (lib/layers-extras.js): colour label tint (data-color) and the linked-layers badge
    return li;
  }

  const clearIndicator = (li) => li.classList.remove('drop-above', 'drop-below', 'drop-into');
  const effectsTarget = (layer) => layer.type !== 'adjustment' && !locked(layer, 'styles');

  /** A drop of `layers` at `mode` of `target` is allowed: not into themselves, and what the Background rules allow. */
  function dropAllowed(layers, target, mode, copy) {
    if (dropRefused(layers, target)) return false;
    // a copy of the Background may go anywhere; the Background itself stays at the bottom (L.13)
    return app.backgroundRules?.canPlace?.(doc(), copy ? [] : layers, target, PLACE_MODE[mode]) !== false;
  }

  function startDrag(e, li, payload) {
    drag = payload;
    if (e.dataTransfer) {
      const text = payload.kind === 'layers' ? payload.layers.map((l) => l.id).join(',') : `${payload.layer.id}:${payload.pick?.key ?? 'effects'}`;
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.effectAllowed = 'copyMove';
    }
    if (payload.kind === 'layers') {
      const set = new Set(payload.layers.map((l) => l.id));
      for (const r of list.querySelectorAll('.layer-row')) if (set.has(r.dataset.id)) r.classList.add('dragging');
    } else li.classList.add('dragging');
    list.classList.add('dragging-' + payload.kind);
  }

  function endDrag() {
    drag = null;
    list.classList.remove('dragging-layers', 'dragging-effects');
    for (const r of list.querySelectorAll('.dragging')) r.classList.remove('dragging');
    for (const r of list.querySelectorAll('.drop-above,.drop-below,.drop-into')) clearIndicator(r);
    for (const b of el.querySelectorAll('.drop-target')) b.classList.remove('drop-target');
  }

  // ---- the eye column: drag down the eyes -----------------------------------------------------------------------
  // The layers passed over show the state the first eye was switched to at once (a preview that only sets
  // `visible`, without history); the button's release puts them back and runs layer:visibility once for all of them,
  // so the whole sweep is one history entry. A click without moving to another eye is the 0.3 toggle (click handler).
  function startSweep(e, layer) {
    if (e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const d = doc();
    sweep = { doc: d, first: layer, visible: !layer.visible, passed: [layer], saved: new Map(), moved: false, off: null };
    const over = (ev) => {
      if (!sweep || !(ev.buttons & 1)) return;
      const eyeEl = ev.target.closest?.('.layer-row > .eye');
      const id = eyeEl?.closest('.layer-row')?.dataset.id;
      const l = id ? d.find(id) : null;
      if (!l || sweep.passed.includes(l)) return;
      if (!sweep.moved) {
        sweep.moved = true;
        // a command run during the sweep (a key) must not see the previewed visibility: the sweep ends first
        sweep.off = app.commands.observe({ before: () => endSweepPreview() });
        showSwept(sweep.first);
      }
      sweep.passed.push(l);
      showSwept(l);
    };
    const up = () => {
      window.removeEventListener('pointerover', over, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      const s = sweep;
      sweep = null;
      if (!s?.moved) return;
      // the preview ends; then one command for every layer passed over
      s.off?.();
      restoreSwept(s);
      // the release over the first eye would also click it: that click is already part of the sweep
      for (const b of list.querySelectorAll('.layer-row > .eye')) b.dataset.swept = '1';
      setTimeout(() => {
        for (const b of list.querySelectorAll('.layer-row > .eye')) delete b.dataset.swept;
      }, 0);
      const change = sweepTargets(s.passed.filter((l) => s.doc.find(l.id)), s.visible);
      if (change.length) app.commands.run('layer:visibility', { ids: change.map((l) => l.id), visible: s.visible }, 'panel');
    };
    window.addEventListener('pointerover', over, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  function restoreSwept(s) {
    let changed = false;
    for (const [l, v] of s.saved) {
      if (l.visible !== v) {
        l.visible = v;
        l.touch();
        changed = true;
      }
    }
    s.saved.clear();
    if (changed) s.doc.view?.invalidate();
  }

  /** Ends the sweep without applying it (a command arrived while the button was held). */
  function endSweepPreview() {
    const s = sweep;
    if (!s) return;
    s.off?.();
    s.off = null;
    restoreSwept(s);
    s.moved = false;
    s.passed = [];
    sweep = null;
  }

  function showSwept(layer) {
    const s = sweep;
    if (!s.saved.has(layer)) s.saved.set(layer, layer.visible);
    if (layer.visible !== s.visible) {
      layer.visible = s.visible;
      layer.touch();
      s.doc.view?.invalidate();
    }
    list.querySelector(`.layer-row[data-id="${CSS.escape(layer.id)}"] > .eye`)?.classList.toggle('off', !s.visible);
  }

  // Alt over the line between two layers shows the clipping cursor
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest?.('.layer-row');
    let on = false;
    if (e.altKey && li && !drag && !e.target.closest('.layer-thumb, .eye, .layer-twisty')) {
      const r = li.getBoundingClientRect();
      on = !!clipCandidate(rows, Number(li.dataset.row), clipEdge(e.clientY - r.top, r.height));
    }
    list.classList.toggle('clip-cursor', on);
  });
  list.addEventListener('mouseleave', () => list.classList.remove('clip-cursor'));

  /** The "Smart Filters" header and one row per filter below a smart object (lib/smart-object.js). */
  function filterRows(layer, depth) {
    const d = doc();
    const frag = document.createDocumentFragment();
    const indentPx = depth * 14 + 22;
    const base = (cls, title) => {
      const li = document.createElement('li');
      li.className = `layer-row ${cls}` + (d.selected.has(layer) ? ' selected' : '');
      li.dataset.id = layer.id;
      li.title = title;
      li.addEventListener('click', () => {
        if (d.active !== layer) d.setActive(layer);
      });
      return li;
    };
    const eyeButton = (on, title, onClick) => {
      const eye = document.createElement('button');
      eye.className = 'eye' + (on ? '' : ' off');
      eye.title = title;
      eye.innerHTML = icon('eye');
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return eye;
    };
    const indent = () => {
      const sp = document.createElement('span');
      sp.className = 'layer-indent';
      sp.style.width = `${indentPx}px`;
      return sp;
    };
    const head = base('smart-filter-head' + (layer.filtersEnabled === false ? ' off' : ''), 'Smart filters apply to the smart object non-destructively');
    head.append(eyeButton(layer.filtersEnabled !== false, layer.filtersEnabled === false ? 'Enable the smart filters' : 'Disable the smart filters', () => app.commands.run('layer:smart-filters-toggle', layer.id, 'panel')), indent());
    const headName = document.createElement('span');
    headName.className = 'layer-name';
    headName.textContent = 'Smart Filters';
    head.appendChild(headName);
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      app.dialogs.popover(head, [
        { label: layer.filtersEnabled === false ? 'Enable Smart Filters' : 'Disable Smart Filters', onSelect: () => app.commands.run('layer:smart-filters-toggle', layer.id, 'panel') },
        { label: 'Clear Smart Filters', onSelect: () => app.commands.run('layer:smart-filters-clear', layer.id, 'panel') },
      ], { at: { x: e.clientX, y: e.clientY } });
    });
    frag.appendChild(head);
    // listed like Photoshop: the filter applied last on top (so "Move Up" = applied later)
    [...layer.filters.keys()].reverse().forEach((index) => {
      const f = layer.filters[index];
      const on = f.enabled !== false && layer.filtersEnabled !== false;
      const li = base('smart-filter-row' + (on ? '' : ' off'), 'Double-click to edit the smart filter, right-click for more');
      li.dataset.index = String(index);
      const run = (op) => app.commands.run('layer:smart-filter', { id: layer.id, index, op }, 'panel');
      li.append(eyeButton(f.enabled !== false, f.enabled === false ? 'Show this smart filter' : 'Hide this smart filter', () => run('toggle')), indent());
      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = app.smartFilters?.kindName(f.kind) ?? f.kind;
      li.appendChild(name);
      li.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        run('edit');
      });
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (d.active !== layer) d.setActive(layer);
        app.dialogs.popover(li, [
          { label: 'Edit Smart Filter…', onSelect: () => run('edit') },
          { label: f.enabled === false ? 'Show Smart Filter' : 'Hide Smart Filter', onSelect: () => run('toggle') },
          { type: 'separator' },
          { label: 'Move Up', disabled: index >= layer.filters.length - 1, onSelect: () => run('up') },
          { label: 'Move Down', disabled: index <= 0, onSelect: () => run('down') },
          { type: 'separator' },
          { label: 'Delete Smart Filter', onSelect: () => run('delete') },
        ], { at: { x: e.clientX, y: e.clientY } });
      });
      frag.appendChild(li);
    });
    return frag;
  }

  function startRename(layer, nameEl) {
    if (!nameEl) return;
    if (pending) {
      cancelAnimationFrame(pending); // the double-click's own clicks scheduled a re-render that would drop the input
      pending = 0;
    }
    renaming = layer;
    const input = document.createElement('input');
    input.className = 'input';
    input.value = layer.name;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = (commit) => {
      if (renaming !== layer) return;
      renaming = null;
      if (commit && input.value.trim() && input.value !== layer.name) app.commands.run('layer:rename', { id: layer.id, name: input.value.trim() }, 'panel');
      else render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    // committed asynchronously: a DOM removal inside the blur handler must not re-enter render()
    input.addEventListener('blur', () => setTimeout(() => done(true), 0));
  }

  function contextMenu(layer) {
    const run = (cmd, arg) => () => app.commands.run(cmd, arg, 'panel');
    const d = doc();
    const several = d.selected.size > 1;
    const mergeLabel = several ? 'Merge Layers' : layer.isGroup ? 'Merge Group' : 'Merge Down';
    const items = [
      { label: 'Layer Properties…', onSelect: run('layer:properties', layer.id) },
      { label: 'Blending Options / Layer Style…', onSelect: run('layer:style', 'dialog') },
      { type: 'separator' },
      { label: 'Duplicate Layer', onSelect: run('layer:duplicate') },
      { label: 'Delete Layer', onSelect: run('layer:delete') },
      { label: 'Rename Layer', onSelect: () => startRename(layer, list.querySelector(`[data-id="${layer.id}"] .layer-name`)) },
      { type: 'separator' },
      { label: 'Group Layers', onSelect: run('layer:group') },
      ...(layer.isGroup ? [{ label: 'Ungroup Layers', onSelect: run('layer:ungroup') }] : []),
      { label: layer.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', onSelect: run('layer:clip', { id: layer.id }) },
      { type: 'separator' },
      { label: layer.mask ? 'Delete Layer Mask' : 'Add Layer Mask', onSelect: run('layer:mask', layer.mask ? 'delete' : 'reveal-all') },
      ...(layer.mask ? [{ label: layer.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', onSelect: run('layer:mask', 'toggle') }, { label: 'Apply Layer Mask', onSelect: run('layer:mask', 'apply') }, { label: 'Add Mask to Selection', onSelect: run('layer:mask', 'select') }] : []),
      { label: 'Select Layer Pixels', onSelect: run('select:from-layer', layer.id) },
      { type: 'separator' },
      ...(layer.type !== 'raster' && !layer.isGroup ? [{ label: 'Rasterize Layer', onSelect: run('layer:rasterize') }] : []),
      // shapes-live (M.7): the shape attributes of a shape layer
      ...(layer.type === 'shape'
        ? [
            { label: 'Copy Shape Attributes', disabled: !app.commands.isEnabled('layer:copy-shape-attributes'), onSelect: run('layer:copy-shape-attributes') },
            { label: 'Paste Shape Attributes', disabled: !app.commands.isEnabled('layer:paste-shape-attributes'), onSelect: run('layer:paste-shape-attributes') },
          ]
        : []),
      // smart objects (lib/smart-object.js)
      ...(layer.type === 'smart'
        ? [
            { label: 'Edit Contents', onSelect: run('layer:smart-edit', layer.id) },
            { label: 'New Smart Object via Copy', onSelect: run('layer:smart-via-copy') },
            { label: 'Replace Contents…', onSelect: run('layer:smart-replace') },
            { label: 'Export Contents…', onSelect: run('layer:smart-export') },
            { label: 'Reset Transform', disabled: !layer.transform, onSelect: run('layer:smart-reset', layer.id) },
            ...(layer.filters?.length ? [{ label: 'Clear Smart Filters', onSelect: run('layer:smart-filters-clear', layer.id) }] : []),
          ]
        : [{ label: 'Convert to Smart Object', onSelect: run('layer:smart-convert') }]),
      { type: 'separator' },
      ...(layer.styles ? [{ label: 'Copy Layer Style', onSelect: run('layer:copy-style') }, { label: 'Clear Layer Style', onSelect: run('layer:clear-style') }] : []),
      { label: 'Paste Layer Style', onSelect: run('layer:paste-style'), disabled: !app.copiedStyle },
      { type: 'separator' },
      { label: mergeLabel, disabled: !app.commands.isEnabled('layer:merge'), onSelect: run('layer:merge') },
      { label: 'Merge Visible', onSelect: run('layer:merge-visible') },
      { label: 'Flatten Image', onSelect: run('image:flatten') },
    ];
    return items;
  }

  function updateControls() {
    const d = doc();
    const layer = d?.active;
    const sel = targets();
    const off = (prop) => !layer || !sel.some((l) => !locked(l, prop));
    blend.update({
      mode: layer?.blend ?? 'normal',
      isGroup: !!layer?.isGroup && sel.every((l) => l.isGroup),
      disabled: off('blend'),
      mixed: sel.length > 1 && sel.some((l) => l.blend !== layer?.blend),
    });
    opacity.setDisabled(off('opacity'));
    fill.setDisabled(off('fillOpacity') || !!layer?.isGroup || layer?.type === 'adjustment');
    for (const b of el.querySelectorAll('[data-lock]')) {
      b.disabled = !layer;
      const k = b.dataset.lock;
      const on = sel.filter((l) => !!l.locked[k]).length;
      b.classList.toggle('active', !!layer?.locked[k]);
      b.classList.toggle('mixed', on > 0 && on < sel.length);
    }
    for (const b of el.querySelectorAll('[data-cmd],[data-menu]')) b.disabled = !d;
    if (!layer) return;
    if (document.activeElement !== opacity.input) opacity.set(Math.round(layer.opacity * 100));
    if (document.activeElement !== fill.input) fill.set(Math.round((layer.fillOpacity ?? 1) * 100));
  }

  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(render);
  };
  app.on('doc:activated', () => {
    endBlendPreview(app);
    schedule();
  });
  app.on('doc:change', (e) => {
    if (renaming) return;
    if (['tree', 'active', 'props', 'history', 'canvas', 'mask-edit'].includes(e.kind)) schedule();
    else if (e.kind === 'pixels' || e.kind === 'mask') {
      clearTimeout(render.pixelTimer);
      render.pixelTimer = setTimeout(schedule, 250); // thumbnails refresh shortly after painting
    }
  });
  app.on('mask:editing', schedule);
  app.on('layers-panel:view', schedule); // layers-menu.js: Collapse All Groups, Panel Options
  app.on('settings:changed', (patch) => {
    if (patch && 'layersPanel' in patch) schedule();
  });

  app.panels.register({ id: 'layers', title: 'Layers', icon: 'layers', element: el, group: 'bottom', onShow: render });
  render();
  return { render };
}
