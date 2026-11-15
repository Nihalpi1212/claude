// Properties sections 'document' (no active layer) and 'transform' (W/H/X/Y and the align buttons of a pixel, text,
// shape, smart or group layer) (ARCHITECTURE.md "0.4 features", L.1). Moved out of panels/properties.js by the 0.4
// skeleton, unchanged in output; X and Y read the ruler origin through app.rulers (L.10). Skeleton file;
// info-histogram-properties takes it over in 0.7.
import { h, button, section, row, layerContentBounds, offsetLayer } from './ui.js';

export const documentSection = {
  id: 'document',
  order: 0,
  region: 'main',
  test: (layer) => !layer,
  render(layer, doc, { app }) {
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
  },
};

export const transformSection = {
  id: 'transform',
  order: 10,
  region: 'main',
  test: (layer) => !!layer && layer.type !== 'fill' && layer.type !== 'adjustment',
  render(layer, doc, { app }) {
    const s = section('Transform');
    const b = layerContentBounds(layer);
    const locked = layer.locked.position || layer.locked.all;
    // ruler (lib/rulers.js): X and Y count from the ruler origin (the stub's origin is the document corner)
    const origin = app.rulers?.origin(doc) ?? { x: 0, y: 0 };
    const num = (value, axis) => {
      const shown = value - origin[axis];
      const input = h('input', 'input num');
      input.type = 'number';
      input.step = '1';
      input.value = String(Math.round(shown));
      input.disabled = locked || !b;
      input.dataset.axis = axis;
      input.title = locked ? 'The layer position is locked' : `${axis.toUpperCase()} position of the layer's left/top edge (px)`;
      let done = false; // one move per edit, however the edit ends (Enter, Tab, blur)
      const commit = () => {
        if (done) return;
        const v = Math.round(Number(input.value));
        if (input.value === '' || !Number.isFinite(v) || !b) return;
        const d = v + origin[axis] - (axis === 'x' ? b.x : b.y);
        if (!d) return;
        done = true;
        offsetLayer(app, layer, axis === 'x' ? d : 0, axis === 'y' ? d : 0, 'Move');
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          commit();
          input.blur();
        } else if (e.key === 'Escape') {
          input.value = String(Math.round(shown));
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
    return s;
  },
};
