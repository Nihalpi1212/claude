// Properties section 'shape' of a shape layer (ARCHITECTURE.md "0.4 features", L.1; shapes-live, J.5): Photoshop's
// Live Shape Properties for live shapes (W / H / X / Y and the angle of the shape's box, the four corner radii of a
// rectangle, the triangle's radius, the polygon's sides, corner radius, star ratio and smoothing, the line's end points,
// weight and arrowheads, the custom shape), then the Appearance of every shape (fill and stroke paints, stroke width,
// Stroke Options, Copy / Paste Shape Attributes). For live shapes it hides the 'transform' section, whose W / H / X / Y
// it replaces. Every control runs 'layer:shape-properties' (lib/shape-props.js): one undoable entry per change.
import { isLiveShape, normalizeShapeProps, strokePaintOf } from '../path-ops.js';
import { normalizeAngle } from '../shape-geometry.js';
import { createWidget } from '../fields.js';
import { strokeOptionsPanel, strokePreviewSvg } from '../tools/shape-widgets.js';
import { customShapeChoices } from '../tools/vector.js';
import { h, button, section, row } from './ui.js';
import { icon } from '../icons.js';

const KIND_TITLES = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line', custom: 'Custom Shape' };
const round2 = (v) => Math.round(v * 100) / 100;
// whether the four radii of a rectangle change together (the link button), per session as in Photoshop
let radiiLinked = null;
let sizeLinked = false;

function numInput(key, value, { min, max, step = 1, title, disabled = false, onCommit }) {
  const input = h('input', 'input num');
  input.type = 'number';
  input.dataset.key = key;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = String(step);
  input.value = String(round2(value));
  input.disabled = disabled;
  if (title) input.title = title;
  let last = input.value;
  const commit = () => {
    if (input.value === last || input.value === '') return;
    let v = Number(input.value);
    if (!Number.isFinite(v)) {
      input.value = last;
      return;
    }
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    last = input.value;
    onCommit(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = last;
      input.blur();
    }
  });
  return input;
}

function checkbox(key, label, checked, { disabled = false, onChange }) {
  const l = h('label', 'checkbox sl-check');
  const i = h('input');
  i.type = 'checkbox';
  i.dataset.key = key;
  i.checked = !!checked;
  i.disabled = disabled;
  // focus leaves the box so the panel redraws with the new state (the host keeps a section that has a focused input)
  i.addEventListener('change', () => {
    i.blur();
    onChange(i.checked);
  });
  l.append(i, document.createTextNode(` ${label}`));
  return l;
}

const cell = (label, content) => {
  const c = h('label', 'props-cell');
  c.appendChild(h('span', 'muted', label));
  c.appendChild(content);
  return c;
};

function liveSection(app, layer, doc, run) {
  const { kind, props } = normalizeShapeProps(layer);
  const s = section(`Live Shape Properties · ${KIND_TITLES[kind] ?? 'Shape'}`);
  s.classList.add('sl-live');
  s.dataset.kind = kind;
  const locked = !!(layer.locked.all || layer.locked.position);
  const origin = app.rulers?.origin(doc) ?? { x: 0, y: 0 }; // ruler (lib/rulers.js): X / Y count from the ruler origin
  const edit = (patch) => run({ props: patch }, 'Live Shape Properties');
  if (kind === 'line') {
    const grid = h('div', 'props-xywh sl-line-xy');
    for (const [k, axis] of [['x1', 'x'], ['y1', 'y'], ['x2', 'x'], ['y2', 'y']]) {
      grid.appendChild(cell(k.toUpperCase(), numInput(`line-${k}`, props[k] - origin[axis], { step: 1, disabled: locked, title: `${k.toUpperCase()} (px)`, onCommit: (v) => edit({ [k]: v + origin[axis] }) })));
    }
    s.appendChild(grid);
    s.appendChild(row('Weight', [numInput('line-weight', props.weight, { min: 0.5, max: 1000, step: 0.5, disabled: locked, onCommit: (v) => edit({ weight: v }) }), h('span', 'opt-unit', 'px')]));
    const shape = props.arrowEnd ?? props.arrowStart ?? { width: 500, length: 1000, concavity: 0 };
    const arrows = h('div', 'sl-arrows');
    arrows.append(
      checkbox('arrow-start', 'Start', !!props.arrowStart, { disabled: locked, onChange: (on) => edit({ arrowStart: on ? { ...shape } : null }) }),
      checkbox('arrow-end', 'End', !!props.arrowEnd, { disabled: locked, onChange: (on) => edit({ arrowEnd: on ? { ...shape } : null }) }),
    );
    s.appendChild(row('Arrowheads', arrows));
    const both = (patch) => edit({ ...(props.arrowStart ? { arrowStart: { ...props.arrowStart, ...patch } } : {}), ...(props.arrowEnd ? { arrowEnd: { ...props.arrowEnd, ...patch } } : {}) });
    const noArrow = !props.arrowStart && !props.arrowEnd;
    s.appendChild(row('Width', [numInput('arrow-width', shape.width, { min: 10, max: 5000, disabled: locked || noArrow, onCommit: (v) => both({ width: v }) }), h('span', 'opt-unit', '%')]));
    s.appendChild(row('Length', [numInput('arrow-length', shape.length, { min: 10, max: 5000, disabled: locked || noArrow, onCommit: (v) => both({ length: v }) }), h('span', 'opt-unit', '%')]));
    s.appendChild(row('Concavity', [numInput('arrow-concavity', shape.concavity, { min: -50, max: 50, disabled: locked || noArrow, onCommit: (v) => both({ concavity: v }) }), h('span', 'opt-unit', '%')]));
    return s;
  }
  // the box: W / H / X / Y and the angle (Photoshop's one set of live W / H / X / Y)
  const grid = h('div', 'props-xywh sl-box');
  const size = (key, v) => {
    const patch = { [key]: Math.max(1, v) };
    if (sizeLinked) {
      const other = key === 'width' ? 'height' : 'width';
      patch[other] = Math.max(1, round2((props[other] * patch[key]) / Math.max(1e-6, props[key])));
    }
    edit(patch);
  };
  grid.append(
    cell('W', numInput('shape-w', props.width, { min: 1, max: 300000, disabled: locked, title: 'Width of the shape (px)', onCommit: (v) => size('width', v) })),
    cell('H', numInput('shape-h', props.height, { min: 1, max: 300000, disabled: locked, title: 'Height of the shape (px)', onCommit: (v) => size('height', v) })),
    cell('X', numInput('shape-x', props.x - origin.x, { disabled: locked, title: 'X position of the shape\'s box (px)', onCommit: (v) => edit({ x: v + origin.x }) })),
    cell('Y', numInput('shape-y', props.y - origin.y, { disabled: locked, title: 'Y position of the shape\'s box (px)', onCommit: (v) => edit({ y: v + origin.y }) })),
  );
  s.appendChild(grid);
  const link = button('', 'link', 'Link width and height', () => {
    sizeLinked = !sizeLinked;
    link.setAttribute('aria-pressed', String(sizeLinked));
  }, { cls: 'pbtn sl-link' });
  link.dataset.act = 'link-size';
  link.setAttribute('aria-pressed', String(sizeLinked));
  s.appendChild(row('Angle', [numInput('shape-angle', props.angle, { min: -360, max: 360, step: 0.1, disabled: locked, title: 'Rotation of the shape (degrees)', onCommit: (v) => edit({ angle: normalizeAngle(v) }) }), h('span', 'opt-unit', '°'), link]));
  if (kind === 'rect') {
    const radii = props.radii;
    if (radiiLinked === null) radiiLinked = radii.every((r) => r === radii[0]);
    const box = h('div', 'sl-radii');
    const names = [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']];
    const index = { tl: 0, tr: 1, br: 2, bl: 3 };
    for (const [k, title] of names) {
      box.appendChild(cell(`${title.split(' ').map((w) => w[0]).join('')}`, numInput(`radius-${k}`, radii[index[k]], { min: 0, max: 100000, disabled: locked, title: `${title} corner radius (px)`, onCommit: (v) => {
        const next = radiiLinked ? [v, v, v, v] : radii.map((r, i) => (i === index[k] ? v : r));
        run({ props: { radii: next } }, 'Corner Radius');
      } })));
    }
    const rl = button('', 'link', 'Link the corner radius values', () => {
      radiiLinked = !radiiLinked;
      rl.setAttribute('aria-pressed', String(radiiLinked));
    }, { cls: 'pbtn sl-link' });
    rl.dataset.act = 'link-radii';
    rl.setAttribute('aria-pressed', String(radiiLinked));
    s.appendChild(row('Corners', [box, rl]));
  } else if (kind === 'triangle') {
    s.appendChild(row('Radius', [numInput('shape-radius', props.radius, { min: 0, max: 100000, disabled: locked, onCommit: (v) => run({ props: { radius: v } }, 'Corner Radius') }), h('span', 'opt-unit', 'px')]));
  } else if (kind === 'polygon') {
    s.appendChild(row('Sides', numInput('shape-sides', props.sides, { min: 3, max: 100, disabled: locked, onCommit: (v) => edit({ sides: Math.round(v) }) })));
    s.appendChild(row('Radius', [numInput('shape-corner-radius', props.cornerRadius, { min: 0, max: 100000, disabled: locked, onCommit: (v) => run({ props: { cornerRadius: v } }, 'Corner Radius') }), h('span', 'opt-unit', 'px')]));
    s.appendChild(row('Star ratio', [numInput('shape-star-ratio', props.starRatio, { min: 1, max: 100, disabled: locked, onCommit: (v) => edit({ starRatio: v }) }), h('span', 'opt-unit', '%')]));
    const checks = h('div', 'sl-checks');
    checks.append(
      checkbox('shape-smooth-corners', 'Smooth corners', props.smoothCorners, { disabled: locked, onChange: (v) => edit({ smoothCorners: v }) }),
      checkbox('shape-smooth-indents', 'Smooth star indents', props.smoothIndents, { disabled: locked, onChange: (v) => edit({ smoothIndents: v }) }),
    );
    s.appendChild(row('', checks));
  } else if (kind === 'custom') {
    const sel = h('select', 'select');
    sel.dataset.key = 'shape-custom';
    for (const [id, name] of customShapeChoices(app)) sel.appendChild(Object.assign(h('option', '', name), { value: id }));
    sel.value = props.shape ?? '';
    sel.disabled = locked;
    sel.addEventListener('change', () => {
      sel.blur();
      edit({ shape: sel.value });
    });
    s.appendChild(row('Shape', sel));
  }
  return s;
}

function appearanceSection(app, layer, run) {
  const s = section('Appearance');
  s.classList.add('sl-appearance');
  const locked = !!layer.locked.all;
  const fill = createWidget('paint', { role: 'fill', title: 'Shape fill' }, {
    app,
    value: layer.fill ?? null,
    // solid colours picked in a row (dragging in the colour input) merge into one entry, as a slider drag
    onChange: (p) => run({ fill: p }, 'Shape Fill', { merge: p?.type === 'solid' }),
  });
  fill.setDisabled?.(locked);
  fill.element.dataset.key = 'shape-fill';
  const stroke = layer.stroke && layer.stroke.width > 0 ? layer.stroke : null;
  const sw = createWidget('paint', { role: 'stroke', title: 'Shape stroke' }, {
    app,
    value: stroke ? strokePaintOf(stroke) : null,
    onChange: (p) => run({ stroke: p ? { paint: p, ...(stroke ? {} : { width: 3 }) } : null }, 'Shape Stroke', { merge: p?.type === 'solid' }),
  });
  sw.setDisabled?.(locked);
  sw.element.dataset.key = 'shape-stroke';
  const width = numInput('stroke-width', stroke?.width ?? 0, { min: 0, max: 1000, step: 0.5, disabled: locked, title: 'Stroke width (px)', onCommit: (w) => run({ stroke: w > 0 ? { width: w } : null }, 'Stroke Width') });
  const opts = h('button', 'btn small sl-stroke-button');
  opts.type = 'button';
  opts.dataset.act = 'stroke-options';
  opts.title = 'Stroke Options';
  opts.disabled = locked || !stroke;
  opts.innerHTML = `${strokePreviewSvg({ dash: stroke?.dash ?? [], cap: stroke?.cap ?? 'butt' }, { width: 40, weight: 2 })}${icon('chevron-down')}`;
  opts.addEventListener('click', () => {
    const get = () => {
      const st = app.doc?.find(layer.id)?.stroke ?? stroke ?? {};
      return { align: st.align ?? 'center', cap: st.cap ?? 'butt', join: st.join ?? 'miter', dash: st.dash ?? [] };
    };
    const pop = app.dialogs.popover(opts, [{ type: 'custom', element: strokeOptionsPanel(app, { get, set: (patch) => run({ stroke: patch }, 'Stroke Options') }) }], { align: 'left', closeOnSelect: false });
    pop?.classList.add('sl-popover', 'sl-stroke-pop');
  });
  s.appendChild(row('Fill', fill.element));
  s.appendChild(row('Stroke', [sw.element, width, h('span', 'opt-unit', 'px'), opts]));
  const acts = h('div', 'props-actions sl-attr-actions');
  const copy = button('Copy Attributes', null, 'Copy Shape Attributes: this shape\'s fill and stroke', () => app.commands.run('layer:copy-shape-attributes', undefined, 'panel'));
  copy.dataset.act = 'copy-attributes';
  const paste = button('Paste Attributes', null, 'Paste Shape Attributes onto the selected shapes', () => app.commands.run('layer:paste-shape-attributes', undefined, 'panel'));
  paste.dataset.act = 'paste-attributes';
  paste.disabled = !app.commands.isEnabled('layer:paste-shape-attributes');
  acts.append(copy, paste);
  s.appendChild(acts);
  return s;
}

function render(layer, doc, { app }) {
  const wrap = h('div', 'sl-props');
  const run = (change, label, { merge = false } = {}) => app.commands.run('layer:shape-properties', { id: layer.id, ...change, label, merge }, 'panel');
  if (isLiveShape(layer)) wrap.appendChild(liveSection(app, layer, doc, run));
  wrap.appendChild(appearanceSection(app, layer, run));
  return wrap;
}

/**
 * The section specs. The host copies a spec when it registers it, so `hides` must be a fixed list: a second section,
 * 'shape-live', passes only for live shapes, draws nothing and hides 'transform' (live shapes show their own
 * W / H / X / Y here instead).
 */
export function makeShapeSection() {
  return { id: 'shape', order: 20, region: 'main', test: (layer) => layer?.type === 'shape', render };
}

export const shapeLiveSection = { id: 'shape-live', order: 21, region: 'main', test: (layer) => isLiveShape(layer), hides: ['transform'], render: () => null };

/** The built-in the Properties host registers (lib/shape-props.js registers the same sections first). */
export const shapeSection = makeShapeSection();
