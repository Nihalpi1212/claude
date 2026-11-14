// layer-style-effects (package 6, ARCHITECTURE.md "0.4 features (contracts)", Packages): contours. This MODULES entry
// registers the `contours` preset kind (Photoshop's built-in contours), the `contour` field widget (H) and holds the
// Contour Editor. The effect pages that use them live in lib/style-ui.js; the pixels in src/shared/pixels/contour.js.
//
//   contour widget value: Contour = { name?, points: { x, y, corner }[] } (J.6); null reads as Linear
//   spec: { compact?: boolean }
//   DOM: .field-contour.cw; the curve button .cw-preview (opens the Contour Editor), the arrow .cw-more (the picker:
//        inline .cw-picker inside a dialog, a popover elsewhere), items .cw-item[data-preset-id]
//
//   openContourEditor(app, { value, title?, onPreview?(contour) }) -> Promise<Contour | null>
import { stubCommands } from './stub.js';
import { registerWidget } from './fields.js';
import { registerPresetKind } from './presets.js';
import { LINEAR_CONTOUR, CONTOUR_PRESETS, normalizeContour, contourLut, isLinearContour } from '../../shared/pixels/contour.js';

export const CONTOUR_KIND = 'contours';

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const samePoints = (a, b) => JSON.stringify((normalizeContour(a) ?? LINEAR_CONTOUR).points) === JSON.stringify((normalizeContour(b) ?? LINEAR_CONTOUR).points);

/** Draws a contour's curve, filled below, into a square canvas (thumbnails, the widget's button). */
export function drawContourThumb(canvas, contour, { fg = '#2b2b2b', bg = '#ffffff', fill = 'rgba(43,43,43,0.18)' } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const lut = contourLut(contour, { size: Math.max(16, w) });
  const pad = Math.max(1, Math.round(w / 16));
  const X = (i) => pad + (i / (lut.length - 1)) * (w - 2 * pad);
  const Y = (v) => h - pad - v * (h - 2 * pad);
  ctx.beginPath();
  ctx.moveTo(X(0), Y(0));
  for (let i = 0; i < lut.length; i++) ctx.lineTo(X(i), Y(lut[i]));
  ctx.lineTo(X(lut.length - 1), Y(0));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < lut.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(lut[i]));
  ctx.strokeStyle = fg;
  ctx.lineWidth = Math.max(1, w / 32);
  ctx.stroke();
}

export function contourThumbnail(contour, size = 32) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawContourThumb(c, contour);
  return c;
}

/** The `contours` preset kind with Photoshop's built-in contours (re-registered over the skeleton's Linear-only kind). */
export function registerContourKind() {
  registerPresetKind(CONTOUR_KIND, {
    title: 'Contours',
    version: 1,
    builtins: () => ({ presets: CONTOUR_PRESETS.map((c) => ({ id: c.id, name: c.name, data: { name: c.name, points: c.points.map((p) => ({ ...p })) } })) }),
    normalize: (data) => normalizeContour(data),
    thumbnail: (preset, size) => contourThumbnail(preset?.data, size),
  });
}

function contourPresets(app) {
  const list = app?.presets?.list?.(CONTOUR_KIND) ?? [];
  return list.length ? list : CONTOUR_PRESETS.map((c) => ({ id: c.id, name: c.name, data: c }));
}

/** The preset whose curve the contour is, or null (a custom curve). */
function presetOf(app, contour) {
  return contourPresets(app).find((p) => samePoints(p.data, contour)) ?? null;
}

/** A grid of the contour presets; onPick(preset). */
function contourPicker(app, { selected, onPick }) {
  const grid = el('div', 'cw-grid');
  for (const p of contourPresets(app)) {
    const b = el('button', 'cw-item');
    b.type = 'button';
    b.dataset.presetId = p.id;
    b.title = p.name;
    b.setAttribute('aria-label', p.name);
    b.appendChild(contourThumbnail(p.data, 28));
    if (p.id === selected) b.classList.add('selected');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onPick(p);
    });
    grid.appendChild(b);
  }
  return grid;
}

export function contourWidget(spec = {}, { value, onInput = () => {}, onChange = () => {}, app } = {}) {
  let current = clone(value ?? spec.value ?? null);
  const size = spec.compact ? 22 : 32;
  const wrap = el('span', 'field-contour cw');
  const preview = el('button', 'cw-preview');
  preview.type = 'button';
  const canvas = el('canvas');
  canvas.width = canvas.height = size;
  preview.appendChild(canvas);
  const more = el('button', 'cw-more', '▾');
  more.type = 'button';
  more.title = 'Contour presets';
  more.setAttribute('aria-haspopup', 'listbox');
  const name = el('span', 'cw-name');
  if (spec.compact) name.hidden = true;
  wrap.append(preview, more, name);
  let picker = null;

  const paint = () => {
    drawContourThumb(canvas, current ?? LINEAR_CONTOUR);
    const p = presetOf(app, current);
    name.textContent = p ? p.name : current?.name ?? 'Custom';
    preview.title = `${name.textContent}: click to edit the contour`;
  };
  const report = (v) => {
    current = clone(v);
    paint();
    onInput(clone(current));
    onChange(clone(current));
  };
  const closePicker = () => {
    picker?.remove();
    picker = null;
    if (!wrap.closest('.dialog')) app?.dialogs?.closePopover?.();
  };
  more.addEventListener('click', (e) => {
    e.preventDefault();
    if (picker) return closePicker();
    const grid = contourPicker(app, {
      selected: presetOf(app, current)?.id ?? null,
      onPick: (p) => {
        closePicker();
        report({ name: p.name, points: clone(p.data.points) });
      },
    });
    // a popover would sit under a dialog's backdrop: inside a dialog the picker opens inline
    if (wrap.closest('.dialog') || !app?.dialogs?.popover) {
      picker = el('div', 'cw-picker');
      picker.appendChild(grid);
      wrap.appendChild(picker);
    } else {
      app.dialogs.popover(more, [{ type: 'custom', element: grid }], { closeOnSelect: false });
    }
  });
  preview.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!app?.dialogs) return;
    const before = clone(current);
    const res = await openContourEditor(app, { value: current, onPreview: (c) => onInput(clone(c)) });
    if (res) report(res);
    else onInput(before); // Cancel: the live preview goes back
  });
  paint();
  return {
    element: wrap,
    get: () => clone(current),
    set(v, { silent = true } = {}) {
      current = clone(v);
      paint();
      if (!silent) {
        onInput(clone(current));
        onChange(clone(current));
      }
    },
    setDisabled(b) {
      preview.disabled = more.disabled = !!b;
    },
    destroy: () => wrap.remove(),
  };
}

registerWidget('contour', (spec, opts) => contourWidget(spec, opts));

// ---- Contour Editor ------------------------------------------------------------------------------------------------

const EDIT_SIZE = 240;

/**
 * Photoshop's Contour Editor: a curve with points. Click the curve to add a point, drag a point to move it (out of the
 * box removes it; the end points stay), Corner turns the selected point into a sharp bend, Input / Output place it
 * exactly, Preset loads a contour, "Save as Preset…" adds the curve to the contours presets.
 */
export function openContourEditor(app, { value = null, title = 'Contour Editor', onPreview = null } = {}) {
  let c = normalizeContour(value) ?? clone(LINEAR_CONTOUR);
  let sel = c.points.length > 2 ? 1 : 0;
  const root = el('div', 'contour-editor');
  const left = el('div', 'ce-left');
  const canvas = el('canvas', 'ce-canvas');
  canvas.width = canvas.height = EDIT_SIZE;
  canvas.tabIndex = 0;
  left.appendChild(canvas);
  const right = el('div', 'ce-right');
  root.append(left, right);

  const presetRow = el('label', 'ce-row');
  presetRow.append(el('span', '', 'Preset'));
  const presetSel = el('select', 'select ce-preset');
  presetSel.dataset.key = 'preset';
  presetRow.appendChild(presetSel);
  const nameRow = el('label', 'ce-row');
  nameRow.append(el('span', '', 'Name'));
  const nameInput = el('input', 'input ce-name');
  nameInput.dataset.key = 'name';
  nameInput.value = c.name ?? 'Custom';
  nameRow.appendChild(nameInput);
  const numRow = (label, key) => {
    const row = el('label', 'ce-row');
    row.append(el('span', '', label));
    const input = el('input', 'input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.dataset.key = key;
    input.dataset.numeric = '';
    row.append(input, el('span', 'opt-unit', '%'));
    return { row, input };
  };
  const inp = numRow('Input', 'input'), out = numRow('Output', 'output');
  const cornerRow = el('label', 'checkbox ce-corner');
  const corner = el('input');
  corner.type = 'checkbox';
  corner.dataset.key = 'corner';
  cornerRow.append(corner, document.createTextNode('Corner'));
  const save = el('button', 'btn small', 'Save as Preset…');
  save.type = 'button';
  save.dataset.act = 'save-preset';
  const hint = el('p', 'muted ce-hint', 'Click the curve to add a point; drag a point out of the box to remove it.');
  right.append(presetRow, nameRow, inp.row, out.row, cornerRow, save, hint);

  const fillPresets = () => {
    presetSel.replaceChildren(new Option('Custom', ''));
    for (const p of contourPresets(app)) presetSel.add(new Option(p.name, p.id));
    presetSel.value = presetOf(app, c)?.id ?? '';
  };

  const P = 12; // the box's margin, so end points can be grabbed
  const toCanvas = (p) => [P + p.x * (EDIT_SIZE - 2 * P), EDIT_SIZE - P - p.y * (EDIT_SIZE - 2 * P)];
  const fromCanvas = (x, y) => ({ x: (x - P) / (EDIT_SIZE - 2 * P), y: (EDIT_SIZE - P - y) / (EDIT_SIZE - 2 * P) });
  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, EDIT_SIZE, EDIT_SIZE);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(P, P, EDIT_SIZE - 2 * P, EDIT_SIZE - 2 * P);
    ctx.strokeStyle = '#d4d4d4';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const v = P + (i / 4) * (EDIT_SIZE - 2 * P);
      ctx.beginPath();
      ctx.moveTo(v + 0.5, P);
      ctx.lineTo(v + 0.5, EDIT_SIZE - P);
      ctx.moveTo(P, v + 0.5);
      ctx.lineTo(EDIT_SIZE - P, v + 0.5);
      ctx.stroke();
    }
    const lut = contourLut(c, { size: 256 });
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const [x, y] = toCanvas({ x: i / 255, y: lut[i] });
      (i ? ctx.lineTo : ctx.moveTo).call(ctx, x, y);
    }
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    c.points.forEach((p, i) => {
      const [x, y] = toCanvas(p);
      ctx.beginPath();
      if (p.corner) ctx.rect(x - 4, y - 4, 8, 8);
      else ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = i === sel ? '#222' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    const p = c.points[sel];
    inp.input.value = String(Math.round(p.x * 100));
    out.input.value = String(Math.round(p.y * 100));
    corner.checked = !!p.corner;
    inp.input.disabled = sel === 0 || sel === c.points.length - 1;
    canvas.dataset.points = JSON.stringify(c.points);
  };
  const changed = ({ keepName = false } = {}) => {
    c = normalizeContour(c) ?? clone(LINEAR_CONTOUR);
    sel = Math.min(sel, c.points.length - 1);
    if (!keepName) {
      const p = presetOf(app, c);
      nameInput.value = p ? p.name : nameInput.value === presetSel.selectedOptions[0]?.text ? 'Custom' : nameInput.value || 'Custom';
    }
    presetSel.value = presetOf(app, c)?.id ?? '';
    draw();
    onPreview?.(result());
  };
  const result = () => {
    const r = { name: nameInput.value.trim() || 'Custom', points: c.points.map((p) => ({ ...p })) };
    return isLinearContour(r) && r.points.length === 2 ? { ...r, name: r.name === 'Custom' ? 'Linear' : r.name } : r;
  };

  // pointer editing
  let drag = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * EDIT_SIZE, ((e.clientY - r.top) / r.height) * EDIT_SIZE];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    const [mx, my] = local(e);
    let hit = -1, best = 8 * 8;
    c.points.forEach((p, i) => {
      const [x, y] = toCanvas(p);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d <= best) {
        best = d;
        hit = i;
      }
    });
    if (hit < 0) {
      const q = fromCanvas(mx, my);
      if (q.x <= 0 || q.x >= 1) return;
      // a new point on the curve's x, at the pointer's height
      const pts = [...c.points, { x: q.x, y: Math.min(1, Math.max(0, q.y)), corner: false }].sort((a, b) => a.x - b.x);
      c = { ...c, points: pts };
      hit = pts.findIndex((p) => p.x === q.x);
    }
    sel = hit;
    drag = { index: hit };
    canvas.setPointerCapture(e.pointerId);
    changed();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [mx, my] = local(e);
    const q = fromCanvas(mx, my);
    const i = drag.index, pts = c.points.map((p) => ({ ...p }));
    const end = i === 0 || i === pts.length - 1;
    const outside = q.x < -0.08 || q.x > 1.08 || q.y < -0.08 || q.y > 1.08;
    if (outside && !end) {
      drag.removed = true;
      canvas.style.cursor = 'not-allowed';
      return;
    }
    drag.removed = false;
    canvas.style.cursor = '';
    const lo = i > 0 ? pts[i - 1].x + 0.005 : 0, hi = i < pts.length - 1 ? pts[i + 1].x - 0.005 : 1;
    if (!end) pts[i].x = Math.min(hi, Math.max(lo, q.x));
    pts[i].y = Math.min(1, Math.max(0, q.y));
    c = { ...c, points: pts };
    draw();
    onPreview?.(result());
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.removed) {
      c = { ...c, points: c.points.filter((_, i) => i !== drag.index) };
      sel = Math.max(0, drag.index - 1);
      canvas.style.cursor = '';
    }
    drag = null;
    changed();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < c.points.length - 1) {
      c = { ...c, points: c.points.filter((_, i) => i !== sel) };
      sel -= 1;
      changed();
      e.preventDefault();
      e.stopPropagation();
    }
  });

  const setSel = (patch) => {
    c = { ...c, points: c.points.map((p, i) => (i === sel ? { ...p, ...patch } : p)) };
    changed();
  };
  inp.input.addEventListener('change', () => {
    const v = Number(inp.input.value);
    if (!Number.isFinite(v) || sel === 0 || sel === c.points.length - 1) return draw();
    const lo = c.points[sel - 1].x + 0.005, hi = c.points[sel + 1].x - 0.005;
    setSel({ x: Math.min(hi, Math.max(lo, v / 100)) });
  });
  out.input.addEventListener('change', () => {
    const v = Number(out.input.value);
    if (!Number.isFinite(v)) return draw();
    setSel({ y: Math.min(1, Math.max(0, v / 100)) });
  });
  corner.addEventListener('change', () => setSel({ corner: corner.checked }));
  presetSel.addEventListener('change', () => {
    const p = contourPresets(app).find((x) => x.id === presetSel.value);
    if (!p) return;
    c = normalizeContour(p.data) ?? clone(LINEAR_CONTOUR);
    nameInput.value = p.name;
    sel = c.points.length > 2 ? 1 : 0;
    changed({ keepName: true });
  });
  save.addEventListener('click', async () => {
    const name = await app.dialogs.prompt('Name', { title: 'Contour Name', value: nameInput.value.trim() || 'Custom', okLabel: 'Save' });
    if (!name) return;
    await app.presets.ready(CONTOUR_KIND);
    app.presets.add(CONTOUR_KIND, { name, data: { name, points: c.points.map((p) => ({ ...p })) } });
    nameInput.value = name;
    fillPresets();
    presetSel.value = presetOf(app, c)?.id ?? '';
  });

  fillPresets();
  draw();
  return app.dialogs.open({
    title,
    content: root,
    width: 460,
    className: 'contour-editor-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
  }).then((v) => (v === 'ok' ? result() : null));
}

export function install(app) {
  stubCommands(app, []); // no command of its own: the package registers engines, widgets or kinds
  registerContourKind();
  // the preset list changes the widget's names; nothing to redraw until a widget is next built
  void app;
}
