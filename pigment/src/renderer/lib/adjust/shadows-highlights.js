// The Shadows/Highlights editor (adjust-color): Photoshop's short dialog (the two amounts) and, with Show More Options,
// Shadows and Highlights each with Amount, Tone and Radius, then Color, Midtone, Black Clip and White Clip. The check
// box is remembered in settings.adjust.shMoreOptions (the `adjust` namespace is adjust-tonal's; adjust-color writes only
// this sub-key). The first use starts from Photoshop's defaults (Shadows 35 %, Tone 50 %, Radius 30 px, Color +20,
// clips 0.01 %); later uses from the last settings, as Photoshop does (adjust-ui.js REMEMBERS_LAST).
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { pathFormEditor } from './color-editors.js';

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

/** Photoshop's starting values for the dialog (the registry defaults are the identity). */
export const SH_START = Object.freeze({ shadows: 35, highlights: 0, radius: 30, shadowTone: 50, highlightTone: 50, shadowRadius: 30, highlightRadius: 30, color: 20, midtone: 0, blackClip: 0.01, whiteClip: 0.01 });

const moreOf = (app) => !!app?.settings?.adjust?.shMoreOptions;

export function shadowsHighlightsEditor(kind, params, onChange, { app = null } = {}) {
  const more = (v) => !!v.__more;
  const fields = [
    { type: 'section', label: 'Shadows' },
    S('shadows', 'Amount', 0, 100, 1, { unit: '%' }),
    S('shadowTone', 'Tone', 0, 100, 1, { unit: '%', when: more }),
    S('shadowRadius', 'Radius', 0, 2500, 1, { unit: 'px', when: more }),
    { type: 'section', label: 'Highlights' },
    S('highlights', 'Amount', 0, 100, 1, { unit: '%' }),
    S('highlightTone', 'Tone', 0, 100, 1, { unit: '%', when: more }),
    S('highlightRadius', 'Radius', 0, 2500, 1, { unit: 'px', when: more }),
    { type: 'section', label: 'Adjustments', when: more },
    S('color', 'Color', -100, 100, 1, { when: more }),
    S('midtone', 'Midtone', -100, 100, 1, { when: more }),
    S('blackClip', 'Black Clip', 0, 50, 0.01, { unit: '%', when: more }),
    S('whiteClip', 'White Clip', 0, 50, 0.01, { unit: '%', when: more }),
    { key: '__more', label: 'Show More Options', type: 'checkbox' },
  ];
  const withRadii = (p) => ({ ...p, shadowRadius: p.shadowRadius ?? p.radius ?? 30, highlightRadius: p.highlightRadius ?? p.radius ?? 30 });
  const ed = pathFormEditor(fields, withRadii(params ?? {}), onChange, {
    app,
    defaults: ADJUSTMENTS['shadows-highlights'].defaults,
    read: () => ({ __more: moreOf(app) }),
    write: Object.assign((p, v, key) => {
      if (key === '__more' && app) {
        // a UI preference, not a parameter (the settings object is shared: write a new one, J.7)
        app.settings.adjust = { ...(app.settings.adjust ?? {}), shMoreOptions: !!v.__more };
        app.saveSettingsSoon?.();
      }
      return p;
    }, { uiKeys: ['__more'] }),
  });
  ed.element.classList.add('shadows-highlights-editor');
  return { element: ed.element, form: ed.form, setParams: (next) => ed.set(withRadii(next ?? {})) };
}
