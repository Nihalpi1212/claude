// Properties section 'fill' of a fill layer (ARCHITECTURE.md "0.4 features", L.1). Its body comes from the paint
// editor's `section` (lib/paint-editors.js, G.5) when the editor of the paint's type has one, so a package's
// gradient or pattern section shows here; otherwise 0.3's summary and the Edit Fill… button. Moved out of
// panels/properties.js by the 0.4 skeleton; owned by gradients afterwards.
import { createCanvas } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { setLayerProps } from '../layer-ops.js';
import { paintEditor, resolvePaint } from '../paint-editors.js';
import { h, button, section, row, colorChip, gradientCss } from './ui.js';

export const fillSection = {
  id: 'fill',
  order: 10,
  region: 'main',
  test: (layer) => layer?.type === 'fill',
  render(layer, doc, { app }) {
    const s = section('Fill');
    const p = layer.paint ?? {};
    const custom = paintEditor(p.type)?.section;
    if (custom) {
      const body = custom(app, layer, p, (next) => setLayerProps(app, layer, { paint: resolvePaint(app, next) }, 'Edit fill', { merge: true }));
      if (body) {
        s.appendChild(body);
        return s;
      }
    }
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
  },
};
