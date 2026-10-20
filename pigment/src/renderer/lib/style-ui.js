// Layer › Layer Style: Blending Options plus the ten effects (Drop Shadow ... Stroke), edited live
// on the layer and recorded as one undo entry; also the fx menu of the Layers panel and the
// document's global light.
import { STYLE_KEYS, mergeStyles } from '../../shared/pixels/styles.js';
import { BLEND_MODES } from './document.js';
import { buildForm, formDialog } from './form.js';
import { setLayerProps } from './layer-ops.js';
import { patternFromCanvas, patternCanvas } from './patterns.js';

const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const BLENDS = BLEND_MODES.filter(Boolean);
const PCT_KEYS = new Set(['opacity', 'highlightOpacity', 'shadowOpacity']);
const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const blend = (key = 'blend', label = 'Blend mode') => ({ key, label, type: 'select', options: BLENDS });
const color = (key = 'color', label = 'Color') => ({ key, label, type: 'color' });
const opacity = (key = 'opacity', label = 'Opacity') => S(key, label, 0, 100, 1, { unit: '%' });
const angle = (key = 'angle') => S(key, 'Angle', -180, 180, 1, { unit: '°' });
const globalLight = { key: 'useGlobalLight', label: 'Use global light', type: 'checkbox' };

const EFFECT_FIELDS = {
  dropShadow: [blend(), color(), opacity(), angle(), globalLight, S('distance', 'Distance', 0, 500, 1, { unit: 'px' }), S('spread', 'Spread', 0, 250, 1, { unit: 'px' }), S('size', 'Size', 0, 250, 1, { unit: 'px' })],
  innerShadow: [blend(), color(), opacity(), angle(), globalLight, S('distance', 'Distance', 0, 500, 1, { unit: 'px' }), S('spread', 'Choke', 0, 250, 1, { unit: 'px' }), S('size', 'Size', 0, 250, 1, { unit: 'px' })],
  outerGlow: [blend(), color(), opacity(), S('spread', 'Spread', 0, 250, 1, { unit: 'px' }), S('size', 'Size', 0, 250, 1, { unit: 'px' })],
  innerGlow: [blend(), color(), opacity(), { key: 'source', label: 'Source', type: 'segment', options: [['center', 'Center'], ['edge', 'Edge']] }, S('choke', 'Choke', 0, 250, 1, { unit: 'px' }), S('size', 'Size', 0, 250, 1, { unit: 'px' })],
  bevel: [
    { key: 'style', label: 'Style', type: 'select', options: [['inner-bevel', 'Inner Bevel'], ['outer-bevel', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow-emboss', 'Pillow Emboss']] },
    { key: 'technique', label: 'Technique', type: 'select', options: [['smooth', 'Smooth'], ['chisel-hard', 'Chisel Hard']] },
    S('depth', 'Depth', 1, 1000, 1, { unit: '%' }),
    { key: 'direction', label: 'Direction', type: 'segment', options: [['up', 'Up'], ['down', 'Down']] },
    S('size', 'Size', 0, 250, 1, { unit: 'px' }),
    S('soften', 'Soften', 0, 16, 1, { unit: 'px' }),
    { type: 'section', label: 'Shading' },
    angle(),
    S('altitude', 'Altitude', 0, 90, 1, { unit: '°' }),
    globalLight,
    blend('highlightBlend', 'Highlight mode'), color('highlightColor', 'Highlight color'), opacity('highlightOpacity', 'Highlight opacity'),
    blend('shadowBlend', 'Shadow mode'), color('shadowColor', 'Shadow color'), opacity('shadowOpacity', 'Shadow opacity'),
  ],
  satin: [blend(), color(), opacity(), angle(), S('distance', 'Distance', 1, 250, 1, { unit: 'px' }), S('size', 'Size', 0, 250, 1, { unit: 'px' }), { key: 'invert', label: 'Invert', type: 'checkbox' }],
  colorOverlay: [blend(), color(), opacity()],
  gradientOverlay: [
    blend(), opacity(),
    color('__c0', 'Start color'), color('__c1', 'End color'),
    { key: 'kind', label: 'Style', type: 'select', options: [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']] },
    angle(),
    S('scale', 'Scale', 10, 150, 1, { unit: '%' }),
    { key: 'reverse', label: 'Reverse', type: 'checkbox' },
  ],
  patternOverlay: [blend(), opacity(), S('scale', 'Scale', 1, 1000, 1, { unit: '%' })],
  stroke: [S('size', 'Size', 1, 250, 1, { unit: 'px' }), { key: 'position', label: 'Position', type: 'segment', options: [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']] }, blend(), opacity(), color()],
};

function toForm(key, fx) {
  const v = {};
  for (const f of EFFECT_FIELDS[key]) {
    if (!f.key) continue;
    if (f.key === '__c0') v.__c0 = fx.stops?.[0]?.color ?? '#000000';
    else if (f.key === '__c1') v.__c1 = fx.stops?.[fx.stops.length - 1]?.color ?? '#ffffff';
    else if (PCT_KEYS.has(f.key)) v[f.key] = Math.round((fx[f.key] ?? 1) * 100);
    else if (f.key === 'scale') v[f.key] = Math.round((fx.scale ?? 1) * 100);
    else v[f.key] = fx[f.key] ?? (f.type === 'checkbox' ? false : f.value);
  }
  return v;
}

function fromForm(key, fx, values) {
  const out = { ...fx };
  for (const f of EFFECT_FIELDS[key]) {
    if (!f.key) continue;
    const val = values[f.key];
    if (f.key === '__c0' || f.key === '__c1') continue;
    if (PCT_KEYS.has(f.key)) out[f.key] = val / 100;
    else if (f.key === 'scale') out[f.key] = val / 100;
    else out[f.key] = val;
  }
  if (key === 'gradientOverlay') {
    const stops = (fx.stops ?? []).map((s) => ({ ...s }));
    if (stops.length < 2) stops.splice(0, stops.length, { pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' });
    stops[0].color = values.__c0;
    stops[stops.length - 1].color = values.__c1;
    out.stops = stops;
  }
  return out;
}

export function install(app) {
  const hasStyleable = () => {
    const l = app.doc?.active;
    return !!l && !l.isGroup && l.type !== 'adjustment';
  };

  async function styleDialog(initialKey = null) {
    const d = app.doc;
    const layer = d?.active;
    if (!layer || layer.type === 'adjustment') return;
    const before = { styles: clone(layer.styles), opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend };
    const styles = mergeStyles(layer.styles);
    // pattern overlays default to the current pattern
    if (!styles.patternOverlay.pattern && app.currentPattern) styles.patternOverlay.pattern = patternFromCanvas(app.currentPattern);
    let current = initialKey && styles[initialKey] ? initialKey : 'blending';
    const blending = { opacity: Math.round(layer.opacity * 100), fillOpacity: Math.round(layer.fillOpacity * 100), blend: layer.blend };

    const apply = () => {
      layer.styles = Object.values(styles).some((s) => s?.enabled) ? clone(styles) : null;
      layer.opacity = blending.opacity / 100;
      layer.fillOpacity = blending.fillOpacity / 100;
      layer.blend = blending.blend;
      layer.touch();
      d.changed('props', { layer });
    };

    const root = document.createElement('div');
    root.style.display = 'flex';
    root.style.minHeight = '360px';
    const list = document.createElement('div');
    list.className = 'style-list';
    const pane = document.createElement('div');
    pane.className = 'style-pane';
    root.append(list, pane);

    const rows = new Map();
    const addRow = (key, name, hasToggle) => {
      const label = document.createElement('label');
      label.dataset.style = key;
      if (hasToggle) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!styles[key].enabled;
        cb.dataset.key = `enable-${key}`;
        cb.addEventListener('change', () => {
          styles[key].enabled = cb.checked;
          apply();
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
        label.appendChild(cb);
        rows.set(key, { label, cb });
      } else rows.set(key, { label });
      const span = document.createElement('span');
      span.textContent = name;
      label.appendChild(span);
      label.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        e.preventDefault();
        select(key);
      });
      list.appendChild(label);
    };
    addRow('blending', 'Blending Options', false);
    for (const { key, name } of STYLE_KEYS) addRow(key, name, true);

    const select = (key) => {
      current = key;
      for (const [k, r] of rows) r.label.classList.toggle('current', k === key);
      pane.replaceChildren();
      const h = document.createElement('h3');
      h.style.margin = '0 0 10px';
      h.style.fontSize = '13px';
      h.textContent = key === 'blending' ? 'Blending Options' : STYLE_KEYS.find((s) => s.key === key).name;
      pane.appendChild(h);
      if (key === 'blending') {
        const form = buildForm(
          [
            { key: 'blend', label: 'Blend mode', type: 'select', options: layer.isGroup ? [['pass-through', 'Pass Through'], ...BLENDS] : BLENDS },
            S('opacity', 'Opacity', 0, 100, 1, { unit: '%' }),
            S('fillOpacity', 'Fill opacity', 0, 100, 1, { unit: '%' }),
          ],
          {
            values: blending,
            onChange: (v) => {
              Object.assign(blending, v);
              apply();
            },
          },
        );
        pane.appendChild(form.element);
        const gl = document.createElement('button');
        gl.type = 'button';
        gl.className = 'btn small';
        gl.style.marginTop = '12px';
        gl.textContent = 'Global Light…';
        gl.addEventListener('click', () => globalLightDialog().then(apply));
        pane.appendChild(gl);
        return;
      }
      const fx = styles[key];
      const form = buildForm(EFFECT_FIELDS[key], {
        values: toForm(key, fx),
        onChange: (v) => {
          styles[key] = fromForm(key, styles[key], v);
          styles[key].enabled = true;
          rows.get(key).cb.checked = true;
          apply();
        },
      });
      pane.appendChild(form.element);
      if (key === 'patternOverlay') {
        const row = document.createElement('div');
        row.className = 'prop-row';
        row.style.marginTop = '10px';
        const sw = styles.patternOverlay.pattern ? patternCanvas(styles.patternOverlay.pattern, 40) : null;
        if (sw) {
          sw.style.border = '1px solid var(--border)';
          row.appendChild(sw);
        }
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'btn small';
        pick.textContent = 'Use current pattern';
        pick.disabled = !app.currentPattern;
        pick.title = app.currentPattern ? '' : 'Define a pattern first (Edit › Define Pattern)';
        pick.addEventListener('click', () => {
          styles.patternOverlay.pattern = patternFromCanvas(app.currentPattern);
          styles.patternOverlay.enabled = true;
          rows.get('patternOverlay').cb.checked = true;
          apply();
          select('patternOverlay');
        });
        row.appendChild(pick);
        pane.appendChild(row);
      }
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn small';
      reset.style.marginTop = '12px';
      reset.textContent = 'Reset to default';
      reset.addEventListener('click', () => {
        const fresh = mergeStyles(null)[key];
        styles[key] = { ...fresh, enabled: styles[key].enabled, pattern: key === 'patternOverlay' ? styles[key].pattern : fresh.pattern };
        apply();
        select(key);
      });
      pane.appendChild(reset);
    };
    select(current);

    const ok = await app.dialogs.open({
      title: 'Layer Style',
      content: root,
      width: 640,
      className: 'style-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    });
    const after = { styles: layer.styles ? clone(layer.styles) : null, opacity: layer.opacity, fillOpacity: layer.fillOpacity, blend: layer.blend };
    Object.assign(layer, { styles: before.styles, opacity: before.opacity, fillOpacity: before.fillOpacity, blend: before.blend });
    layer.touch();
    if (ok) setLayerProps(app, layer, after, 'Layer style');
    else d.changed('props', { layer });
  }

  async function globalLightDialog() {
    const d = app.doc;
    if (!d) return;
    const gl = d.globalLight ?? { angle: 120, altitude: 30 };
    const o = await formDialog(app, {
      title: 'Global Light',
      fields: [S('angle', 'Angle', -180, 180, 1, { unit: '°', value: gl.angle }), S('altitude', 'Altitude', 0, 90, 1, { unit: '°', value: gl.altitude })],
      live: {
        apply: (v) => {
          d.globalLight = { angle: v.angle, altitude: v.altitude };
          d.changed('props');
        },
        revert: () => {
          d.globalLight = gl;
          d.changed('props');
        },
      },
    });
    if (!o) return;
    const before = gl, after = { angle: o.angle, altitude: o.altitude };
    const set = (v) => {
      d.globalLight = v;
      d.changed('props');
    };
    set(after);
    d.history.push({ label: 'Global light', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
  }

  function toggleEffect(key) {
    const layer = app.doc?.active;
    if (!layer) return;
    const styles = mergeStyles(layer.styles);
    styles[key].enabled = !styles[key].enabled;
    setLayerProps(app, layer, { styles: Object.values(styles).some((s) => s.enabled) ? styles : null }, `${styles[key].enabled ? 'Add' : 'Hide'} ${STYLE_KEYS.find((s) => s.key === key).name}`);
  }

  app.layerStyleMenu = () => {
    const layer = app.doc?.active;
    const on = (k) => !!layer?.styles?.[k]?.enabled;
    return [
      { label: 'Blending Options…', onSelect: () => app.commands.run('layer:style', 'dialog', 'panel') },
      { type: 'separator' },
      ...STYLE_KEYS.map(({ key, name }) => ({ label: `${name}…`, checked: on(key), onSelect: () => styleDialog(key) })),
      { type: 'separator' },
      { label: 'Copy Layer Style', disabled: !layer?.styles, onSelect: () => app.commands.run('layer:copy-style', undefined, 'panel') },
      { label: 'Paste Layer Style', disabled: !app.copiedStyle, onSelect: () => app.commands.run('layer:paste-style', undefined, 'panel') },
      { label: 'Clear Layer Style', disabled: !layer?.styles, onSelect: () => app.commands.run('layer:clear-style', undefined, 'panel') },
      { label: 'Rasterize Layer Style', disabled: !layer?.styles, onSelect: () => app.commands.run('layer:rasterize-style', undefined, 'panel') },
      { label: 'Global Light…', onSelect: globalLightDialog },
    ];
  };

  app.commands.registerAll({
    'layer:style': {
      enabled: hasStyleable,
      run: (kind) => {
        if (!kind || kind === 'dialog') return styleDialog(null);
        if (typeof kind === 'string' && STYLE_KEYS.some((s) => s.key === kind)) return styleDialog(kind);
      },
    },
    'layer:style-toggle': { enabled: hasStyleable, run: (key) => toggleEffect(key) },
    'layer:global-light': { enabled: () => !!app.doc, run: globalLightDialog },
  });
  for (const { key, name } of STYLE_KEYS) app.commands.register(`layer:style-${key}`, { enabled: hasStyleable, run: () => styleDialog(key), label: `${name}…` });
}
