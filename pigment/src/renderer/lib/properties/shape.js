// Properties section 'shape' of a shape layer: fill and stroke (ARCHITECTURE.md "0.4 features", L.1). Moved out of
// panels/properties.js by the 0.4 skeleton, unchanged in output; owned by shapes-live afterwards, which shows the live
// shape parameters here and declares `hides: ['transform']` for live shapes.
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { setLayerProps } from '../layer-ops.js';
import { h, button, section, row, colorChip } from './ui.js';

function render(layer, doc, { app }) {
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

export const shapeSection = { id: 'shape', order: 20, region: 'main', test: (layer) => layer?.type === 'shape', render };
