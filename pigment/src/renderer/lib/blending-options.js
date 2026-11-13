// Blending Options page of the Layer Style dialog and isStyleable (ARCHITECTURE.md "0.4 features", L.3; E13).
// Stub by the 0.4 skeleton; owned by layer-style-blending, which replaces this file (same exports, same MODULES
// entry): fill opacity, channels, knockout, Blend If, the five check boxes and styles on groups.
//
// The stub page is 0.3's blending form (blend mode, opacity, fill opacity, Global Light…) on the page context's
// opacity / fillOpacity / blend (0..1, L.3); `ctx.advanced` (the draft of layer.blending) is left as it is.
import { BLEND_MODES } from './document.js';
import { buildForm } from './form.js';
import { stubCommands } from './stub.js';

const BLENDS = BLEND_MODES.filter(Boolean);
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

let appRef = null;

/** True when the Layer Style dialog may open on the layer (not a group, not an adjustment layer, not style-locked). */
export function isStyleable(layer, app = appRef) {
  if (!layer || layer.isGroup || layer.type === 'adjustment') return false;
  const locked = app?.backgroundRules?.lockedProps?.(layer) ?? [];
  return !locked.includes('styles');
}

/** The page spec registered with app.layerStyle.registerPage. */
export const blendingPage = {
  id: 'blending',
  title: 'Blending Options',
  order: 0,
  render(ctx) {
    const wrap = document.createElement('div');
    const values = { blend: ctx.blend, opacity: Math.round(ctx.opacity * 100), fillOpacity: Math.round(ctx.fillOpacity * 100) };
    const form = buildForm(
      [
        { key: 'blend', label: 'Blend mode', type: 'select', options: ctx.layer.isGroup ? [['pass-through', 'Pass Through'], ...BLENDS] : BLENDS },
        S('opacity', 'Opacity', 0, 100, 1, { unit: '%' }),
        S('fillOpacity', 'Fill opacity', 0, 100, 1, { unit: '%' }),
      ],
      {
        values,
        onChange: (v) => {
          ctx.blend = v.blend;
          ctx.opacity = v.opacity / 100;
          ctx.fillOpacity = v.fillOpacity / 100;
          ctx.apply();
        },
      },
    );
    wrap.appendChild(form.element);
    const gl = document.createElement('button');
    gl.type = 'button';
    gl.className = 'btn small';
    gl.style.marginTop = '12px';
    gl.textContent = 'Global Light…';
    gl.addEventListener('click', () => ctx.globalLight?.());
    wrap.appendChild(gl);
    return wrap;
  },
};

export function install(app) {
  appRef = app;
  app.layerStyle?.registerPage(blendingPage);
  // the package's Layer > Layer Style commands (M.7): stubs until layer-style-blending lands
  stubCommands(app, ['layer:style-create-layers', 'layer:style-toggle-all', 'layer:style-scale']);
}
