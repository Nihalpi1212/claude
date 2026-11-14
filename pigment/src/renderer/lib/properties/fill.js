// Properties section 'fill' of a fill layer (ARCHITECTURE.md "0.4 features", L.1). Its body comes from the paint
// editor's `section` (lib/paint-editors.js, G.5) when the editor of the paint's type has one, so a package's
// gradient or pattern section shows here; otherwise 0.3's summary and the Edit Fill… button. Moved out of
// panels/properties.js by the 0.4 skeleton; owned by gradients afterwards.
//
// A section built from an editor's `section` is kept mounted while the layer's paint is the one it last showed (the
// host's `keep`, L.1): its own edits re-render the panel through setLayerProps, and rebuilding it then would drop the
// focus and an open picker. An undo, or an edit from elsewhere, changes the paint and rebuilds it.
import { createCanvas } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { setLayerProps } from '../layer-ops.js';
import { paintEditor, resolvePaint } from '../paint-editors.js';
import { h, button, section, row, colorChip, gradientCss } from './ui.js';

const mounted = new WeakMap(); // layer -> the element its editor section returned last

/** A key that changes whenever the paint does (a pattern's canvas is compared by identity through its size). */
function paintKey(p) {
  return JSON.stringify(p, (k, v) => (v instanceof HTMLCanvasElement ? `canvas:${v.width}x${v.height}` : v));
}

export const fillSection = {
  id: 'fill',
  order: 10,
  region: 'main',
  test: (layer) => layer?.type === 'fill',
  render(layer, doc, { app, keep }) {
    const p = layer.paint ?? {};
    const custom = paintEditor(p.type)?.section;
    if (custom) {
      const key = `${layer.id}:${paintKey(p)}`;
      const kept = mounted.get(layer);
      if (kept && keep(key)) return kept;
      const s = section('Fill');
      // onChange(paint, { merge }): one history entry per change; `merge` joins a run of changes (a slider drag)
      const body = custom(app, layer, p, (next, { merge = false } = {}) => setLayerProps(app, layer, { paint: resolvePaint(app, next) }, p.type === 'gradient' ? 'Edit gradient fill' : 'Edit fill', { merge }));
      if (body) {
        s.appendChild(body);
        mounted.set(layer, s);
        return s;
      }
    }
    const s = section('Fill');
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
