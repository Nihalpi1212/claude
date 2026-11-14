// Properties section 'mask' (region 'mask'): the masks of the active layer (ARCHITECTURE.md "0.4 features", L.1),
// owned by masks-vector-masks. Two blocks, as Photoshop's Masks properties:
//   Layer Mask   thumbnail, Density, Feather, Select and Mask…, Color Range…, Invert, and 0.3's actions
//   Vector Mask  thumbnail, Density, Feather, Edit Path, Select, Enable/Disable, Link, Rasterize, Delete; or Add
//   Overlay      the rubylith toggle (layer:mask-overlay, \) and its options
// Every change runs a command (layer:mask, layer:vector-mask, layer:mask-properties): sliders merge one drag into
// one history entry. Controls of what app.backgroundRules locks are disabled.
import { createCanvas } from '../document.js';
import { h, button, section } from './ui.js';
import { vectorMaskThumb } from '../mask-view.js';
import { maskLocked } from '../vector-mask.js';
import { maskDensity, maskFeather, MAX_FEATHER } from '../../../shared/pixels/mask-math.js';

const run = (app, id, arg) => app.commands.run(id, arg, 'panel');

/** A labelled slider with a number box; onInput(value, done) runs on every move (done = false) and on change. */
function slider(label, key, { value, min, max, step, unit, scale = 1, disabled, onValue }) {
  const r = h('div', 'prop-row mvm-slider');
  r.appendChild(h('span', '', label));
  const range = h('input', 'mvm-range');
  range.type = 'range';
  Object.assign(range, { min: String(min), max: String(max), step: String(step) });
  range.value = String(value * scale);
  range.dataset.key = `${key}Range`;
  const num = h('input', 'input mvm-num');
  num.type = 'number';
  Object.assign(num, { min: String(min), max: String(max), step: String(step) });
  num.value = String(Math.round(value * scale * 10) / 10);
  num.dataset.key = key;
  const u = h('span', 'muted mvm-unit', unit);
  range.disabled = num.disabled = !!disabled;
  range.addEventListener('input', () => {
    num.value = range.value;
    onValue(Number(range.value) / scale, true);
  });
  range.addEventListener('change', () => onValue(Number(range.value) / scale, true));
  num.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(num.value)));
    if (!Number.isFinite(v)) return;
    range.value = String(v);
    onValue(v / scale, false);
  });
  r.append(range, num, u);
  return r;
}

function rasterBlock(layer, doc, app) {
  const s = section('Layer Mask');
  s.classList.add('mvm-raster');
  const locked = maskLocked(app, layer, 'mask');
  if (!layer.mask) {
    const acts = h('div', 'props-actions');
    acts.append(
      button('Add Mask', 'mask', 'Add a layer mask (from the selection, if any)', () => run(app, 'layer:mask', 'auto')),
      button('From Transparency', null, 'Mask from the layer transparency', () => run(app, 'layer:mask', 'from-transparency'))
    );
    acts.lastChild.disabled = layer.type !== 'raster' || locked;
    acts.firstChild.disabled = locked;
    s.appendChild(acts);
    return s;
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
  const set = (patch) => (v, merge) => run(app, 'layer:mask-properties', { part: 'raster', [patch]: v, merge });
  s.appendChild(slider('Density', 'maskDensity', { value: maskDensity(m), min: 0, max: 100, step: 1, unit: '%', scale: 100, disabled: locked, onValue: set('density') }));
  s.appendChild(slider('Feather', 'maskFeather', { value: maskFeather(m), min: 0, max: MAX_FEATHER, step: 0.1, unit: 'px', disabled: locked, onValue: set('feather') }));
  const refine = h('div', 'props-actions mvm-refine');
  refine.append(
    button('Select and Mask…', null, 'Refine the mask edge in Select and Mask', () => selectAndMask(app, layer, doc)),
    button('Color Range…', null, 'Replace the mask with a Color Range selection', () => colorRange(app, layer, doc)),
    button('Invert', 'swap', 'Invert the mask', () => run(app, 'layer:mask-properties', { part: 'raster', invert: true }))
  );
  for (const b of refine.children) b.disabled = locked;
  refine.children[0].dataset.act = 'select-and-mask';
  refine.children[1].dataset.act = 'color-range';
  refine.children[2].dataset.act = 'invert';
  s.appendChild(refine);
  const acts = h('div', 'props-actions');
  acts.append(
    button(app.ui.editingMask ? 'Edit Layer' : 'Edit Mask', 'brush', 'Choose whether painting changes the mask or the layer', () => app.setEditingMask(!app.ui.editingMask)),
    button('Select', 'marquee-rect', 'Load the mask as a selection', () => run(app, 'layer:mask', 'select')),
    button(m.enabled ? 'Disable' : 'Enable', m.enabled ? 'eye-off' : 'eye', m.enabled ? 'Disable the mask (Shift-click the mask thumbnail)' : 'Enable the mask', () => run(app, 'layer:mask', 'toggle')),
    button(m.linked !== false ? 'Unlink' : 'Link', 'link', 'Link or unlink the mask from the layer position', () => run(app, 'layer:mask', 'link')),
    button('Apply', 'check', 'Apply the mask (with its density and feather) to the layer pixels and delete it', () => run(app, 'layer:mask', 'apply')),
    button('Delete', 'trash', 'Delete the mask', () => run(app, 'layer:mask', 'delete'))
  );
  acts.children[4].disabled = layer.type !== 'raster' || locked;
  acts.children[2].disabled = acts.children[5].disabled = locked;
  s.appendChild(acts);
  return s;
}

function vectorBlock(layer, doc, app) {
  const s = section('Vector Mask');
  s.classList.add('mvm-vector');
  const locked = maskLocked(app, layer, 'vectorMask');
  const vm = layer.vectorMask;
  if (!vm) {
    const acts = h('div', 'props-actions');
    acts.append(
      button('Add Vector Mask', 'vector-mask', 'Add a vector mask that reveals the whole layer (Layer > Vector Mask > Reveal All)', () => run(app, 'layer:vector-mask', 'reveal-all')),
      button('From Path', 'pen', 'Add a vector mask from the current path (Layer > Vector Mask > Current Path)', () => run(app, 'layer:vector-mask', 'current-path'))
    );
    acts.firstChild.dataset.act = 'add-vector';
    acts.lastChild.dataset.act = 'vector-from-path';
    acts.firstChild.disabled = locked;
    acts.lastChild.disabled = locked || !app.commands.isEnabled('path:make-mask');
    s.appendChild(acts);
    return s;
  }
  const targeted = app.ui.activePath?.kind === 'vector-mask' && app.ui.activePath.layerId === layer.id;
  const top = h('div', 'props-mask-row');
  const thumb = h('button', 'layer-thumb mask-thumb props-mask-thumb mvm-vector-thumb' + (targeted ? ' selected-thumb' : ''));
  thumb.type = 'button';
  thumb.title = 'Click to edit the vector mask with the path tools';
  thumb.appendChild(vectorMaskThumb(layer, 64, 48, doc));
  if (vm.enabled === false) thumb.classList.add('disabled');
  thumb.addEventListener('click', () => run(app, 'layer:vector-mask', 'target'));
  const info = h('div', 'props-mask-info');
  info.appendChild(h('span', '', vm.enabled === false ? 'Disabled' : 'Enabled'));
  info.appendChild(h('span', 'muted', `${vm.linked !== false ? 'Linked to' : 'Unlinked from'} the layer`));
  info.appendChild(h('span', 'muted', vm.initialFill === 'reveal' ? 'Starts revealed' : 'Starts hidden'));
  top.append(thumb, info);
  s.appendChild(top);
  const set = (patch) => (v, merge) => run(app, 'layer:mask-properties', { part: 'vector', [patch]: v, merge });
  s.appendChild(slider('Density', 'vectorDensity', { value: maskDensity(vm), min: 0, max: 100, step: 1, unit: '%', scale: 100, disabled: locked, onValue: set('density') }));
  s.appendChild(slider('Feather', 'vectorFeather', { value: maskFeather(vm), min: 0, max: MAX_FEATHER, step: 0.1, unit: 'px', disabled: locked, onValue: set('feather') }));
  const acts = h('div', 'props-actions');
  const op = (o) => () => run(app, 'layer:vector-mask', o);
  acts.append(
    button('Edit Path', 'path-select', 'Edit the vector mask with the path tools', () => {
      run(app, 'layer:vector-mask', 'target');
      if (!app.tools.active?.isVector) app.tools.activate('direct-selection');
    }),
    button('Select', 'marquee-rect', 'Load the vector mask as a selection', op('select')),
    button(vm.enabled === false ? 'Enable' : 'Disable', vm.enabled === false ? 'eye' : 'eye-off', 'Disable or enable the vector mask (Shift-click its thumbnail in Layers)', op('toggle')),
    button(vm.linked !== false ? 'Unlink' : 'Link', 'link', 'Link or unlink the vector mask from the layer position', op('link')),
    button('Rasterize', 'mask', 'Turn the vector mask into pixels of the layer mask', op('rasterize')),
    button('Delete', 'trash', 'Delete the vector mask', op('delete'))
  );
  ['edit', 'select', 'toggle', 'link', 'rasterize', 'delete'].forEach((a, i) => (acts.children[i].dataset.act = `vector-${a}`));
  for (const i of [2, 4, 5]) acts.children[i].disabled = locked;
  s.appendChild(acts);
  return s;
}

function overlayBlock(layer, app) {
  const r = h('div', 'props-actions mvm-overlay');
  const on = !!app.ui.showMaskOverlay;
  const t = button(on ? 'Hide Overlay' : 'Show Overlay', 'mask-overlay', 'Show what the mask hides as a coloured overlay (\\)', () => run(app, 'layer:mask-overlay'));
  t.dataset.act = 'overlay';
  t.setAttribute('aria-pressed', String(on));
  const o = button('Overlay Options…', null, 'Colour and opacity of the mask overlay', () => run(app, 'layer:mask-overlay-options'));
  o.dataset.act = 'overlay-options';
  r.append(t, o);
  return r;
}

/** Select and Mask on the layer mask: the workspace starts from the mask and writes the result back to it. */
function selectAndMask(app, layer, doc) {
  const img = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
  const mask = new Uint8ClampedArray(doc.width * doc.height);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4 + 3];
  run(app, 'select:select-mask', { interactive: true, mask, output: 'mask' });
}

/** Color Range, then the selection it makes replaces the mask (two steps in History: the selection, the mask). */
async function colorRange(app, layer, doc) {
  const before = doc.selection;
  await run(app, 'select:color-range');
  if (app.doc !== doc || doc.active !== layer || doc.selection === before || !doc.selection || doc.selection.isEmpty) return;
  run(app, 'layer:mask-properties', { part: 'raster', fromSelection: true });
}

function render(layer, doc, { app }) {
  const wrap = h('div', 'mvm-masks');
  wrap.appendChild(rasterBlock(layer, doc, app));
  wrap.appendChild(vectorBlock(layer, doc, app));
  if (layer.mask || layer.vectorMask) wrap.appendChild(overlayBlock(layer, app));
  return wrap;
}

export const maskSection = { id: 'mask', order: 100, region: 'mask', test: (layer) => !!layer, render };
