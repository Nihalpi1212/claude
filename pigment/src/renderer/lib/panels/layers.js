// Layers panel: the layer tree with visibility, thumbnails, masks, blend mode, opacity, fill,
// locks, drag-and-drop reordering and grouping, rename, context menu and the footer buttons.
import { icon } from '../icons.js';
import { BLEND_MODES } from '../document.js';
import { Selection } from '../selection.js';

const THUMB_W = 36, THUMB_H = 30;

export function install(app) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="panel-toolbar layers-toolbar">
      <select class="select" data-blend title="Blend mode"></select>
      <label class="prop-inline" title="Opacity">Opacity <input class="input num" type="number" min="0" max="100" step="1" data-opacity> %</label>
    </div>
    <div class="panel-toolbar layers-toolbar">
      <span class="muted">Lock</span>
      <button class="pbtn" data-lock="transparency" title="Lock transparent pixels">${icon('lock-alpha')}</button>
      <button class="pbtn" data-lock="pixels" title="Lock image pixels">${icon('brush')}</button>
      <button class="pbtn" data-lock="position" title="Lock position">${icon('move')}</button>
      <button class="pbtn" data-lock="all" title="Lock all">${icon('lock')}</button>
      <span style="flex:1"></span>
      <label class="prop-inline" title="Fill opacity (excludes layer styles)">Fill <input class="input num" type="number" min="0" max="100" step="1" data-fill> %</label>
    </div>
    <ul class="layer-list" role="tree" aria-label="Layers"></ul>
    <div class="panel-footer">
      <button class="pbtn" data-cmd="layer:link" title="Link layers" hidden>${icon('link')}</button>
      <button class="pbtn" data-menu="style" title="Add a layer style">${icon('fx')}</button>
      <button class="pbtn" data-cmd="layer:mask" data-arg="auto" title="Add layer mask">${icon('mask')}</button>
      <button class="pbtn" data-menu="adjust" title="New fill or adjustment layer">${icon('adjust')}</button>
      <button class="pbtn" data-cmd="layer:new-group" title="New group">${icon('folder')}</button>
      <button class="pbtn" data-cmd="layer:new" title="New layer">${icon('plus')}</button>
      <button class="pbtn" data-cmd="layer:delete" title="Delete layer">${icon('trash')}</button>
    </div>`;
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  const list = el.querySelector('.layer-list');
  list.style.flex = '1';
  list.style.overflow = 'auto';
  const blend = el.querySelector('[data-blend]');
  for (const m of BLEND_MODES) {
    if (!m) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '──────────';
      blend.appendChild(sep);
      continue;
    }
    const o = document.createElement('option');
    o.value = m[0];
    o.textContent = m[1];
    blend.appendChild(o);
  }
  const passThrough = document.createElement('option');
  passThrough.value = 'pass-through';
  passThrough.textContent = 'Pass Through';
  blend.insertBefore(passThrough, blend.firstChild);
  const opacity = el.querySelector('[data-opacity]');
  const fill = el.querySelector('[data-fill]');

  blend.addEventListener('change', () => app.commands.run('layer:blend', blend.value, 'panel'));
  opacity.addEventListener('change', () => app.commands.run('layer:opacity', Number(opacity.value), 'panel'));
  fill.addEventListener('change', () => app.commands.run('layer:fill-opacity', Number(fill.value), 'panel'));
  for (const b of el.querySelectorAll('[data-lock]')) b.addEventListener('click', () => app.commands.run('layer:lock', b.dataset.lock, 'panel'));
  for (const b of el.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => app.commands.run(b.dataset.cmd, b.dataset.arg, 'panel'));
  el.querySelector('[data-menu="style"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, app.layerStyleMenu?.() ?? [], { align: 'right' }));
  el.querySelector('[data-menu="adjust"]').addEventListener('click', (e) => app.dialogs.popover(e.currentTarget, app.adjustmentLayerMenu?.() ?? [], { align: 'right' }));

  const thumbCache = new WeakMap(); // layer -> { version, canvas }
  let dragLayer = null;
  let renaming = null;
  let pending = 0;

  function thumb(layer, kind = 'layer') {
    const key = kind === 'mask' ? `m${layer.version}` : `l${layer.version}`;
    const cache = thumbCache.get(layer) ?? {};
    if (cache[kind]?.key === key) return cache[kind].canvas;
    const c = document.createElement('canvas');
    const doc = app.doc;
    const scale = Math.min(THUMB_W / doc.width, THUMB_H / doc.height);
    c.width = Math.max(1, Math.round(doc.width * scale));
    c.height = Math.max(1, Math.round(doc.height * scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'medium';
    ctx.scale(scale, scale);
    if (kind === 'mask') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, doc.width, doc.height);
      if (layer.mask?.canvas) ctx.drawImage(layer.mask.canvas, 0, 0);
    } else if (layer.type === 'raster') ctx.drawImage(layer.canvas, layer.x, layer.y);
    else if (layer.render) {
      const r = layer.render();
      if (r) ctx.drawImage(r.canvas, r.x, r.y);
    }
    cache[kind] = { key, canvas: c };
    thumbCache.set(layer, cache);
    return c;
  }

  function typeIcon(layer) {
    return { group: 'folder', text: 'text', shape: 'shape', fill: 'fill', adjustment: 'adjust' }[layer.type];
  }

  function render() {
    pending = 0;
    const doc = app.doc;
    list.replaceChildren();
    if (!doc) {
      list.innerHTML = '<li class="panel-empty">No document open</li>';
      updateControls();
      return;
    }
    const rows = [];
    const walk = (group, depth) => {
      for (let i = group.children.length - 1; i >= 0; i--) {
        const layer = group.children[i];
        rows.push({ layer, depth });
        if (layer.isGroup && layer.expanded) walk(layer, depth + 1);
      }
    };
    walk(doc.root, 0);
    for (const { layer, depth } of rows) list.appendChild(row(layer, depth));
    updateControls();
  }

  function row(layer, depth) {
    const doc = app.doc;
    const li = document.createElement('li');
    li.className = 'layer-row' + (doc.selected.has(layer) ? ' selected' : '') + (doc.active === layer ? ' active' : '');
    li.setAttribute('role', 'treeitem');
    li.dataset.id = layer.id;
    li.draggable = !renaming;
    const eye = document.createElement('button');
    eye.className = 'eye' + (layer.visible ? '' : ' off');
    eye.title = layer.visible ? 'Hide layer (Alt-click: show only this one)' : 'Show layer';
    eye.innerHTML = icon('eye');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
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
      tw.innerHTML = icon(layer.expanded ? 'chevron-down' : 'chevron-right');
      tw.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.expanded = !layer.expanded;
        render();
      });
      li.appendChild(tw);
    }
    const t = document.createElement('span');
    t.className = 'layer-thumb' + (!app.ui.editingMask && doc.active === layer && layer.mask ? ' selected-thumb' : '');
    if (layer.isGroup || layer.type === 'adjustment') t.innerHTML = icon(typeIcon(layer));
    else t.appendChild(thumb(layer));
    t.addEventListener('click', (e) => {
      if (doc.active === layer && app.ui.editingMask) {
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
      m.className = 'layer-thumb mask-thumb' + (app.ui.editingMask && doc.active === layer ? ' selected-thumb' : '');
      m.title = 'Layer mask: click to edit, Shift-click to disable, Alt-click to view';
      m.appendChild(thumb(layer, 'mask'));
      if (!layer.mask.enabled) m.style.opacity = '0.4';
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) return app.commands.run('layer:mask', 'toggle', 'panel');
        if (doc.active !== layer) doc.setActive(layer);
        if (e.altKey) return app.commands.run('layer:mask-toggle-view', undefined, 'panel');
        app.setEditingMask(true);
      });
      li.appendChild(m);
    }
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    if (layer.type === 'text') name.title = layer.text;
    li.appendChild(name);
    const badges = document.createElement('span');
    badges.className = 'layer-badges';
    if (layer.styles && Object.values(layer.styles).some((s) => s?.enabled)) {
      const fx = document.createElement('span');
      fx.className = 'layer-fx';
      fx.textContent = 'fx';
      fx.title = 'Edit layer style';
      fx.addEventListener('click', (e) => {
        e.stopPropagation();
        doc.setActive(layer);
        app.commands.run('layer:style', 'dialog', 'panel');
      });
      badges.appendChild(fx);
    }
    if (layer.locked.all || layer.locked.pixels || layer.locked.position || layer.locked.transparency) badges.insertAdjacentHTML('beforeend', icon(layer.locked.all ? 'lock' : 'lock-alpha'));
    if (layer.type === 'text' || layer.type === 'shape' || layer.type === 'fill' || layer.type === 'adjustment') badges.insertAdjacentHTML('beforeend', icon(typeIcon(layer)));
    li.appendChild(badges);

    li.addEventListener('click', (e) => {
      if (e.shiftKey && doc.active) {
        // range select in visual order
        const ids = [...list.querySelectorAll('.layer-row')].map((r) => r.dataset.id);
        const a = ids.indexOf(doc.active.id), b = ids.indexOf(layer.id);
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        doc.selected.clear();
        for (const id of ids.slice(lo, hi + 1)) doc.selected.add(doc.find(id));
        doc.active = layer;
        doc.changed('active', { layer });
      } else if ((e.ctrlKey || e.metaKey) && e.target.closest('.layer-thumb') && !layer.isGroup && layer.type !== 'adjustment') {
        // Ctrl-click a thumbnail: the layer's transparency (or its mask) as a selection
        const fromMask = !!e.target.closest('.mask-thumb') && layer.mask?.canvas;
        const mode = e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
        let sel = null;
        if (fromMask) {
          const a = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
          const m = new Uint8ClampedArray(doc.width * doc.height);
          for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
          sel = Selection.fromMask(doc.width, doc.height, m);
        } else sel = app.layerAlphaSelection?.(layer) ?? null;
        if (sel) app.applySelection(sel, mode, 'Load selection');
      } else if (e.ctrlKey || e.metaKey) {
        if (doc.selected.has(layer) && doc.selected.size > 1) {
          doc.selected.delete(layer);
          if (doc.active === layer) doc.active = [...doc.selected][0];
          doc.changed('active', { layer: doc.active });
        } else doc.setActive(layer, { additive: true });
      } else {
        if (doc.active !== layer) app.setEditingMask(false);
        doc.setActive(layer);
      }
    });
    li.addEventListener('dblclick', (e) => {
      if (e.target.closest('.layer-name')) startRename(layer, name);
      else if (layer.type === 'text') app.commands.run('layer:edit-text', layer.id, 'panel');
      else if (layer.type === 'adjustment' || layer.type === 'fill') app.commands.run('layer:properties', layer.id, 'panel');
      else if (!e.target.closest('.layer-thumb')) app.commands.run('layer:style', 'dialog', 'panel');
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!doc.selected.has(layer)) doc.setActive(layer);
      app.dialogs.popover(li, contextMenu(layer), { at: { x: e.clientX, y: e.clientY } });
    });
    li.addEventListener('dragstart', (e) => {
      dragLayer = layer;
      e.dataTransfer.setData('text/plain', layer.id);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragLayer = null;
      for (const r of list.querySelectorAll('.drop-above,.drop-below,.drop-into')) r.classList.remove('drop-above', 'drop-below', 'drop-into');
    });
    li.addEventListener('dragover', (e) => {
      if (!dragLayer || dragLayer === layer) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      li.classList.remove('drop-above', 'drop-below', 'drop-into');
      li.classList.add(layer.isGroup && y > 0.3 && y < 0.7 ? 'drop-into' : y < 0.5 ? 'drop-above' : 'drop-below');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-above', 'drop-below', 'drop-into'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragLayer || dragLayer === layer) return;
      const mode = li.classList.contains('drop-into') ? 'into' : li.classList.contains('drop-above') ? 'above' : 'below';
      li.classList.remove('drop-above', 'drop-below', 'drop-into');
      app.commands.run('layer:move-to', { id: dragLayer.id, target: layer.id, mode, duplicate: e.altKey }, 'panel');
    });
    return li;
  }

  function startRename(layer, nameEl) {
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
    input.addEventListener('blur', () => done(true));
  }

  function contextMenu(layer) {
    const run = (cmd, arg) => () => app.commands.run(cmd, arg, 'panel');
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
      { label: layer.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', onSelect: run('layer:clip') },
      { type: 'separator' },
      { label: layer.mask ? 'Delete Layer Mask' : 'Add Layer Mask', onSelect: run('layer:mask', layer.mask ? 'delete' : 'reveal-all') },
      ...(layer.mask ? [{ label: layer.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask', onSelect: run('layer:mask', 'toggle') }, { label: 'Apply Layer Mask', onSelect: run('layer:mask', 'apply') }, { label: 'Add Mask to Selection', onSelect: run('layer:mask', 'select') }] : []),
      { label: 'Select Layer Pixels', onSelect: run('select:from-layer', layer.id) },
      { type: 'separator' },
      ...(layer.type !== 'raster' && !layer.isGroup ? [{ label: 'Rasterize Layer', onSelect: run('layer:rasterize') }] : []),
      ...(layer.styles ? [{ label: 'Copy Layer Style', onSelect: run('layer:copy-style') }, { label: 'Clear Layer Style', onSelect: run('layer:clear-style') }] : []),
      { label: 'Paste Layer Style', onSelect: run('layer:paste-style'), disabled: !app.copiedStyle },
      { type: 'separator' },
      { label: 'Merge Down', onSelect: run('layer:merge-down') },
      { label: 'Merge Visible', onSelect: run('layer:merge-visible') },
      { label: 'Flatten Image', onSelect: run('image:flatten') },
    ];
    return items;
  }

  function updateControls() {
    const doc = app.doc;
    const layer = doc?.active;
    const disabled = !layer;
    blend.disabled = opacity.disabled = fill.disabled = disabled;
    for (const b of el.querySelectorAll('[data-lock]')) {
      b.disabled = disabled;
      b.classList.toggle('active', !!layer?.locked[b.dataset.lock]);
    }
    for (const b of el.querySelectorAll('[data-cmd],[data-menu]')) b.disabled = !doc;
    if (!layer) return;
    blend.value = layer.blend;
    passThrough.hidden = !layer.isGroup;
    if (document.activeElement !== opacity) opacity.value = String(Math.round(layer.opacity * 100));
    if (document.activeElement !== fill) fill.value = String(Math.round((layer.fillOpacity ?? 1) * 100));
    fill.disabled = layer.isGroup || layer.type === 'adjustment';
  }

  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(render);
  };
  app.on('doc:activated', schedule);
  app.on('doc:change', (e) => {
    if (renaming) return;
    if (['tree', 'active', 'props', 'history', 'canvas', 'mask-edit'].includes(e.kind)) schedule();
    else if (e.kind === 'pixels' || e.kind === 'mask') {
      clearTimeout(render.pixelTimer);
      render.pixelTimer = setTimeout(schedule, 250); // thumbnails refresh shortly after painting
    }
  });
  app.on('mask:editing', schedule);

  app.panels.register({ id: 'layers', title: 'Layers', icon: 'layers', element: el, group: 'bottom', onShow: render });
  render();
  return { render };
}
