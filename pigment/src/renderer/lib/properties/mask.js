// Properties section 'mask' (region 'mask'): the layer mask of the active layer (ARCHITECTURE.md "0.4 features",
// L.1). Moved out of panels/properties.js by the 0.4 skeleton, unchanged in output; owned by masks-vector-masks
// afterwards (density, feather, the vector mask row).
import { createCanvas } from '../document.js';
import { h, button, section } from './ui.js';

function render(layer, doc, { app }) {
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
  return s;
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

export const maskSection = { id: 'mask', order: 100, region: 'mask', test: (layer) => !!layer, render };
