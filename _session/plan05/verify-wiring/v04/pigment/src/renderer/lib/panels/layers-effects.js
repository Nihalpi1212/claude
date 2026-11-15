// layers-panel-depth (package 14): the effect rows under a layer in the Layers panel, and the command behind them.
//
// Rows (built by effectHeaderRow / effectRow, placed by panels/layers.js from layers-model.js panelRows):
//   - the 'Effects' header: its eye is Hide All Effects for that layer (styles.hidden); dragging it carries every
//     effect of the layer;
//   - one row per listed effect (layers-model.js listedEffects, in the Layer Style dialog's order): its eye switches
//     that effect (setEffect, the row stays listed), a double-click opens the Layer Style dialog on it, dragging it
//     onto another layer moves it there (Alt: copies it), onto the panel's Delete button deletes it.
// The rows are <li class="layer-effect-row">, not .layer-row: they are not layers (the specs that list the panel's
// layers read .layer-row).
//
// Command (registered by registerEffectCommands, from layers-menu.js install):
//   layer:effect { id, op, key?, index?, target?, visible? }
//     op 'toggle'      one effect's eye (visible: true | false, else the opposite of its state)
//     op 'toggle-all'  the layer's Hide All Effects (visible as above)
//     op 'delete'      one effect
//     op 'clear'       every effect (the 'Effects' row dropped on Delete)
//     op 'move'        one effect (key, index) or, without key, every effect, onto the layer `target`
//     op 'copy'        the same, the source keeping its effects (Alt-drag)
//   One history entry each (two layers in one entry for a move, setLayersProps).
import { icon } from '../icons.js';
import { setLayerProps, setLayersProps } from '../layer-ops.js';
import { isStyleable } from '../blending-options.js';
import { STYLE_KEYS } from '../../../shared/pixels/styles.js';
import { listedEffects, transferEffects, toggleEffect, removeEffect } from './layers-model.js';

const effectName = (key) => STYLE_KEYS.find((s) => s.key === key)?.name ?? key;

/** Runs layer:effect with its operation (the rows' gestures). */
export function runEffect(app, arg) {
  return app.commands.run('layer:effect', arg, 'panel');
}

export function registerEffectCommands(app) {
  app.commands.register('layer:effect', {
    enabled: () => !!app.doc,
    run: (arg) => effectOp(app, arg),
    label: 'Layer Effect',
  });
}

function effectOp(app, arg) {
  const d = app.doc;
  if (!d || !arg || typeof arg !== 'object') return;
  const layer = d.find(arg.id);
  if (!layer) return;
  const { op, key, index = 0 } = arg;
  const visible = typeof arg.visible === 'boolean' ? arg.visible : null;
  if (op === 'toggle') {
    const entry = listedEffects(layer.styles).find((e) => e.key === key && e.index === index);
    if (!entry) return;
    const on = visible ?? !entry.fx.enabled;
    if (on === !!entry.fx.enabled) return;
    setLayerProps(app, layer, { styles: toggleEffect(layer.styles, key, index, on) }, `${on ? 'Show' : 'Hide'} ${effectName(key)}`);
    return;
  }
  if (op === 'toggle-all') {
    if (!listedEffects(layer.styles).length) return;
    const hidden = visible === null ? layer.styles.hidden !== true : !visible;
    if (hidden === (layer.styles.hidden === true)) return;
    const styles = { ...layer.styles };
    if (hidden) styles.hidden = true;
    else delete styles.hidden;
    setLayerProps(app, layer, { styles }, hidden ? 'Hide all effects' : 'Show all effects');
    return;
  }
  // the eyes stay free (like a layer's own eye); removing or moving effects off a locked layer is refused
  if (['delete', 'clear', 'move'].includes(op) && layer.styles && !isStyleable(layer, app)) {
    app.dialogs.toast(`${layer.name} is locked: its effects cannot change`, { kind: 'error', timeout: 2400 });
    return;
  }
  if (op === 'delete') {
    if (!listedEffects(layer.styles).some((e) => e.key === key && e.index === index)) return;
    setLayerProps(app, layer, { styles: removeEffect(layer.styles, key, index) }, `Delete ${effectName(key)}`);
    return;
  }
  if (op === 'clear') {
    if (!layer.styles) return;
    setLayerProps(app, layer, { styles: null }, 'Delete effects');
    return;
  }
  if (op === 'move' || op === 'copy') {
    const target = d.find(arg.target);
    if (!target || target === layer) return;
    if (!isStyleable(target, app)) {
      app.dialogs.toast(target.type === 'adjustment' ? 'Adjustment layers take no layer effects' : `${target.name} takes no layer effects`, { kind: 'error', timeout: 2400 });
      return;
    }
    const pick = key ? { key, index } : null;
    if (pick && !listedEffects(layer.styles).some((e) => e.key === key && e.index === index)) return;
    if (!pick && !listedEffects(layer.styles).length) return;
    const copy = op === 'copy';
    const { source, target: styles } = transferEffects(layer.styles, target.styles, pick, copy);
    const what = pick ? effectName(key) : 'effects';
    // one entry for both layers; a copy leaves the source alone (the function skips it)
    setLayersProps(app, [layer, target], (l) => (l === target ? { styles } : copy ? null : { styles: source }), `${copy ? 'Copy' : 'Move'} ${what}`);
  }
}

function eyeButton(on, title, onClick) {
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'eye' + (on ? '' : ' off');
  eye.title = title;
  eye.innerHTML = icon('eye');
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return eye;
}

function indent(px) {
  const sp = document.createElement('span');
  sp.className = 'layer-indent';
  sp.style.width = `${px}px`;
  return sp;
}

/**
 * The 'Effects' header row of `layer` (shown while the layer's fx list is open). ctx: { indentPx, selected,
 * onDragStart(e, li, payload), onDragEnd() }.
 */
export function effectHeaderRow(app, layer, ctx) {
  const li = document.createElement('li');
  const hidden = layer.styles?.hidden === true;
  li.className = 'layer-effect-row layer-effects-head' + (ctx.selected ? ' selected' : '') + (hidden ? ' off' : '');
  li.dataset.id = layer.id;
  li.dataset.effects = 'all';
  li.title = 'Layer effects: drag onto another layer to move them (Alt: copy them), double-click to edit';
  li.draggable = true;
  li.append(
    eyeButton(!hidden, hidden ? 'Show all effects' : 'Hide all effects', () => runEffect(app, { id: layer.id, op: 'toggle-all' })),
    indent(ctx.indentPx),
  );
  const fx = document.createElement('span');
  fx.className = 'layer-effects-icon';
  fx.textContent = 'fx';
  li.appendChild(fx);
  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = 'Effects';
  li.appendChild(name);
  wire(app, li, layer, null, ctx);
  return li;
}

/** One effect row ({ key, index, name, fx } of listedEffects). ctx as for effectHeaderRow. */
export function effectRow(app, layer, entry, ctx) {
  const li = document.createElement('li');
  const on = !!entry.fx.enabled;
  const hiddenAll = layer.styles?.hidden === true;
  li.className = 'layer-effect-row' + (ctx.selected ? ' selected' : '') + (on && !hiddenAll ? '' : ' off');
  li.dataset.id = layer.id;
  li.dataset.effect = entry.key;
  li.dataset.index = String(entry.index);
  li.title = 'Double-click to edit the effect; drag it onto another layer to move it (Alt: copy it)';
  li.draggable = true;
  li.append(
    eyeButton(on, on ? `Hide ${entry.name}` : `Show ${entry.name}`, () => runEffect(app, { id: layer.id, op: 'toggle', key: entry.key, index: entry.index })),
    indent(ctx.indentPx + 26),
  );
  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = entry.name;
  li.appendChild(name);
  wire(app, li, layer, entry, ctx);
  return li;
}

function wire(app, li, layer, entry, ctx) {
  const d = app.doc;
  li.addEventListener('click', () => {
    if (d.active !== layer) d.setActive(layer);
  });
  li.addEventListener('dblclick', (e) => {
    if (e.target.closest('.eye')) return;
    if (d.active !== layer) d.setActive(layer);
    app.commands.run('layer:style', entry ? { key: entry.key, index: entry.index } : 'dialog', 'panel');
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (d.active !== layer) d.setActive(layer);
    app.dialogs.popover(li, effectMenu(app, layer, entry), { at: { x: e.clientX, y: e.clientY } });
  });
  li.addEventListener('dragstart', (e) => ctx.onDragStart(e, li, { kind: 'effects', layer, pick: entry ? { key: entry.key, index: entry.index } : null }));
  li.addEventListener('dragend', () => ctx.onDragEnd());
}

function effectMenu(app, layer, entry) {
  const run = (cmd, arg) => () => app.commands.run(cmd, arg, 'panel');
  const hidden = layer.styles?.hidden === true;
  const items = [];
  if (entry) {
    items.push(
      { label: `Edit ${entry.name}…`, onSelect: run('layer:style', { key: entry.key, index: entry.index }) },
      { label: entry.fx.enabled ? `Hide ${entry.name}` : `Show ${entry.name}`, onSelect: () => runEffect(app, { id: layer.id, op: 'toggle', key: entry.key, index: entry.index }) },
      { label: `Delete ${entry.name}`, onSelect: () => runEffect(app, { id: layer.id, op: 'delete', key: entry.key, index: entry.index }) },
      { type: 'separator' },
    );
  }
  items.push(
    { label: 'Blending Options…', onSelect: run('layer:style', 'dialog') },
    { label: hidden ? 'Show All Effects' : 'Hide All Effects', onSelect: () => runEffect(app, { id: layer.id, op: 'toggle-all' }) },
    { type: 'separator' },
    { label: 'Copy Layer Style', disabled: !app.commands.isEnabled('layer:copy-style'), onSelect: run('layer:copy-style') },
    { label: 'Paste Layer Style', disabled: !app.commands.isEnabled('layer:paste-style'), onSelect: run('layer:paste-style') },
    { label: 'Clear Layer Style', disabled: !app.commands.isEnabled('layer:clear-style'), onSelect: run('layer:clear-style') },
    { type: 'separator' },
    { label: 'Create Layers', disabled: !app.commands.isEnabled('layer:style-create-layers'), onSelect: run('layer:style-create-layers') },
    { label: 'Scale Effects…', disabled: !app.commands.isEnabled('layer:style-scale'), onSelect: run('layer:style-scale') },
  );
  return items;
}
