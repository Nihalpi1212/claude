// Warp (Free Transform › Warp), Perspective Warp and Puppet Warp — see ARCHITECTURE.md "Warp".
// All three run as sessions of the Free Transform tool: `TransformTool.warp` holds a controller
// ({ active, kind, label, changed, render(canvas, x, y, { final }), drawOverlay(ctx, view) }) that the
// tool's update() / commit() / drawOverlay() hook sites read, so Enter commits through
// history.replaceCanvas and Escape restores the originals exactly like a plain transform. The
// pointer, keyboard and options-bar handling a warp needs is wrapped around the tool instance here,
// which keeps image-ops.js down to those three hooks.
import { createCanvas, unionRect } from './document.js';
import { canvasData, dataCanvas } from './image-ops.js';
import { icon } from './icons.js';
import * as W from '../../shared/pixels/warp.js';

const PREVIEW_MAX = 700; // longest edge of the source while dragging (the final render uses every pixel)
const HIT = 8; // screen px around a control point

// ---- presets ------------------------------------------------------------------------------------------------------

export const WARP_PRESETS = [
  ['none', 'None'], ['custom', 'Custom'], ['arc', 'Arc'], ['arc-lower', 'Arc Lower'], ['arc-upper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'],
  ['shell-lower', 'Shell Lower'], ['shell-upper', 'Shell Upper'], ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'],
  ['fisheye', 'Fisheye'], ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'],
];

/**
 * The 16 control points of a preset over rect. bend, hDist and vDist are −100..100 like Photoshop's
 * Warp options: bend is the preset's amplitude, the distortions add a perspective-like taper.
 */
export function presetControls(rect, preset, bend = 50, hDist = 0, vDist = 0) {
  const pts = W.identityControls(rect);
  const b = bend / 100, hd = hDist / 100, vd = vDist / 100;
  const Wd = rect.width, Hd = rect.height;
  const A = b * Hd * 0.75, Aw = b * Wd * 0.75;
  const cx = rect.x + Wd / 2, cy = rect.y + Hd / 2;
  // profiles along a row/column of control points: S bulge, E edge direction, F s-wave, R rise
  const S = [0, 1, 1, 0], E = [-1, -1 / 3, 1 / 3, 1], F = [0, 1, -1, 0], R = [0, 0, 1, 1];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const p = pts[i * 4 + j];
      const u = j / 3, v = i / 3;
      let dx = 0, dy = 0;
      switch (preset) {
        case 'arc': // the whole box bends like a rainbow: the outer edge grows, the inner one shrinks
          dy = -A * S[j];
          dx = A * (0.5 - v) * E[j] * 0.5;
          break;
        case 'arc-lower':
          dy = -A * S[j] * v;
          break;
        case 'arc-upper':
          dy = -A * S[j] * (1 - v);
          break;
        case 'arch':
          dy = -A * S[j];
          break;
        case 'bulge':
          dy = -A * S[j] * (1 - 2 * v);
          break;
        case 'shell-lower':
          dy = A * S[j] * v;
          dx = Aw * E[j] * v * 0.35;
          break;
        case 'shell-upper':
          dy = -A * S[j] * (1 - v);
          dx = Aw * E[j] * (1 - v) * 0.35;
          break;
        case 'flag':
          dy = -A * F[j];
          break;
        case 'wave': // top and bottom edges wave with different amplitudes, so the thickness varies
          dy = -A * F[j] * (1 - 1.5 * v);
          break;
        case 'fish':
          dy = -A * F[j] * (1 - 2 * v);
          break;
        case 'rise':
          dy = -A * R[j];
          break;
        case 'fisheye':
          dx = Aw * E[j] * S[i] * 0.5;
          dy = A * E[i] * S[j] * 0.5;
          break;
        case 'inflate':
          dx = Aw * E[j] * (0.35 + 0.35 * S[i]);
          dy = A * E[i] * (0.35 + 0.35 * S[j]);
          break;
        case 'squeeze':
          dx = -Aw * E[j] * S[i] * 0.5;
          dy = -A * E[i] * S[j] * 0.5;
          break;
        case 'twist': {
          // rotate about the centre, most at the centre and not at all at the corners
          const r = Math.min(1, Math.hypot((u - 0.5) * 2, (v - 0.5) * 2) / Math.SQRT2);
          const ang = b * (Math.PI / 2) * (1 - r);
          const rx = p[0] - cx, ry = p[1] - cy;
          dx = rx * Math.cos(ang) - ry * Math.sin(ang) - rx;
          dy = rx * Math.sin(ang) + ry * Math.cos(ang) - ry;
          break;
        }
        default:
          break;
      }
      // distortion: one side grows while the other shrinks (a perspective taper)
      dy += hd * Hd * (v - 0.5) * (u - 0.5);
      dx += vd * Wd * (u - 0.5) * (v - 0.5);
      p[0] += dx;
      p[1] += dy;
    }
  }
  return pts;
}

// ---- shared session behaviour ---------------------------------------------------------------------------------

class WarpSession {
  constructor(tt, kind, label, hint) {
    this.tt = tt;
    this.app = tt.app;
    this.kind = kind;
    this.label = label;
    this.hint = hint;
    this.active = true;
    this.changed = false;
    const s = tt.session;
    this.doc = s.doc;
    this.box = { ...s.box };
    this.drag = null;
  }
  get session() {
    return this.tt.session;
  }
  get view() {
    return this.app.view;
  }
  /** Document point -> screen [x, y]. */
  screen(x, y) {
    const p = this.view.toScreen(x, y);
    return [p.x, p.y];
  }
  /** Source canvases of the session (a floating selection piece or the content-cropped layers). */
  sources() {
    const s = this.session;
    if (!s) return [];
    if (s.floating) return [{ canvas: s.floating.piece, x: s.floating.pieceX, y: s.floating.pieceY }];
    return [...(s.sources?.values() ?? [])];
  }
  /** Grids { src, dst } in the coordinate space of `map(x, y)` (canvas-local, possibly scaled), or null. */
  mesh() {
    return null;
  }
  /**
   * Warps a canvas placed at (x, y) in document space through the session's mesh. Previews work on
   * a reduced copy so dragging stays responsive; the final render samples every pixel with the
   * transform's interpolation.
   */
  render(canvas, x, y, { final = false } = {}) {
    if (!this.changed) return { canvas, x, y };
    let source = canvas, scale = 1;
    const longest = Math.max(canvas.width, canvas.height);
    if (!final && longest > PREVIEW_MAX) {
      scale = PREVIEW_MAX / longest;
      source = createCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
      const sctx = source.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(canvas, 0, 0, source.width, source.height);
    }
    const map = (px, py) => [(px - x) * scale, (py - y) * scale];
    let grids = null;
    try {
      grids = this.mesh(map, { final });
    } catch (err) {
      console.warn('warp mesh failed', err);
    }
    if (!grids) return { canvas, x, y };
    // never let a handle dragged far away allocate a giant canvas: clip to twice the document around it
    const d = this.doc;
    const pad = Math.max(d.width, d.height) * 2;
    const [cx0, cy0] = map(-pad, -pad), [cx1, cy1] = map(d.width + pad, d.height + pad);
    const clip = { x: Math.floor(cx0), y: Math.floor(cy0), width: Math.ceil(cx1 - cx0), height: Math.ceil(cy1 - cy0) };
    const quality = this.session?.interp ?? 'bicubic';
    const interp = final ? (quality === 'nearest' ? 'nearest' : quality === 'bilinear' ? 'bilinear' : 'bicubic') : 'bilinear';
    const out = W.meshWarp(canvasData(source), grids.src, grids.dst, { interp, clip });
    if (out.empty) return { canvas: createCanvas(1, 1), x, y };
    let result = dataCanvas(out.image);
    if (scale !== 1) {
      const full = createCanvas(Math.max(1, Math.round(out.image.width / scale)), Math.max(1, Math.round(out.image.height / scale)));
      const fctx = full.getContext('2d');
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(result, 0, 0, full.width, full.height);
      result = full;
    }
    return { canvas: result, x: Math.round(x + out.x / scale), y: Math.round(y + out.y / scale) };
  }
  preview() {
    this.tt.scheduleUpdate();
  }
  finish() {
    this.tt.update({ final: true });
  }
  invalidate() {
    this.view?.invalidate();
  }
  onPointerDown() {}
  onPointerMove() {}
  onPointerUp() {}
  onDoubleClick() {
    this.tt.commit();
  }
  onKeyDown() {
    return false;
  }
  drawOverlay() {}
  renderBar() {}
  syncBar() {}
  dispose() {}

  // -- options bar helpers ---------------------------------------------------------------------------------------
  group(bar) {
    const g = document.createElement('span');
    g.className = 'warp-group';
    bar.appendChild(g);
    return g;
  }
  select(parent, key, label, options, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'opt opt-select';
    wrap.dataset.key = key;
    if (label) wrap.innerHTML = `<span class="opt-label">${label}</span>`;
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.dataset.key = key;
    for (const [v, l] of options) sel.add(new Option(l, v));
    sel.value = value;
    sel.addEventListener('change', () => {
      onChange(sel.value);
      sel.blur(); // keyboard focus returns to the canvas so Enter applies the warp
    });
    wrap.appendChild(sel);
    parent.appendChild(wrap);
    return sel;
  }
  number(parent, key, label, { min, max, step = 1, unit = '', slider = false }, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'opt opt-number';
    wrap.dataset.key = key;
    wrap.innerHTML = `<span class="opt-label">${label}</span>`;
    const box = document.createElement('span');
    box.className = 'opt-number';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.dataset.key = key;
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = String(value);
    const clamp = (v) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : 0));
    input.addEventListener('change', () => {
      const v = clamp(Number(input.value));
      input.value = String(v);
      if (range) range.value = String(v);
      onChange(v);
      input.blur();
    });
    box.appendChild(input);
    if (unit) {
      const u = document.createElement('span');
      u.className = 'opt-unit';
      u.textContent = unit;
      box.appendChild(u);
    }
    let range = null;
    if (slider) {
      range = document.createElement('input');
      range.type = 'range';
      range.min = min;
      range.max = max;
      range.step = step;
      range.value = String(value);
      range.addEventListener('input', () => {
        input.value = range.value;
        onChange(clamp(Number(range.value)));
      });
      box.appendChild(range);
    }
    wrap.appendChild(box);
    parent.appendChild(wrap);
    return { input, range };
  }
  checkbox(parent, key, label, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'opt opt-checkbox';
    wrap.dataset.key = key;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.key = key;
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(` ${label}`));
    parent.appendChild(wrap);
    return input;
  }
  button(parent, label, iconName, fn, { primary = false, key = null } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small${primary ? ' primary' : ''}`;
    if (key) b.dataset.key = key;
    b.innerHTML = `${iconName ? icon(iconName) : ''}<span>${label}</span>`;
    b.addEventListener('click', () => {
      b.blur();
      fn();
    });
    parent.appendChild(b);
    return b;
  }
  segment(parent, key, options, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'opt opt-segment-wrap';
    wrap.dataset.key = key;
    const seg = document.createElement('span');
    seg.className = 'opt-segment';
    seg.dataset.key = key;
    for (const [v, label] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-button';
      b.dataset.value = v;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(v === value));
      b.addEventListener('click', () => {
        b.blur();
        onChange(v);
      });
      seg.appendChild(b);
    }
    wrap.appendChild(seg);
    parent.appendChild(wrap);
    return seg;
  }
  applyButtons(parent) {
    this.button(parent, 'Cancel', 'close', () => this.tt.cancel());
    this.button(parent, 'Apply', 'check', () => this.tt.commit(), { primary: true });
  }
  hintLabel(parent, text) {
    const s = document.createElement('span');
    s.className = 'warp-hint';
    s.textContent = text;
    parent.appendChild(s);
    return s;
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function drawHandle(ctx, x, y, { shape = 'square', size = 8, selected = false } = {}) {
  ctx.fillStyle = selected ? '#ffcc33' : '#ffffff';
  ctx.strokeStyle = '#2f80ff';
  ctx.lineWidth = 1;
  const h = size / 2;
  if (shape === 'square') {
    ctx.fillRect(Math.round(x) - h, Math.round(y) - h, size, size);
    ctx.strokeRect(Math.round(x) - h + 0.5, Math.round(y) - h + 0.5, size - 1, size - 1);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, h, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ---- Free Transform › Warp (Bézier control net) -----------------------------------------------------------------

const CORNERS = [0, 3, 12, 15];
const INNER = [5, 6, 9, 10];
const CORNER_HANDLES = { 0: [1, 4], 3: [2, 7], 12: [13, 8], 15: [14, 11] };

export class BezierWarp extends WarpSession {
  constructor(tt) {
    super(tt, 'bezier', 'Warp', 'Drag the corners, handles and inner points of the net to warp, or pick a preset. Enter applies, Esc cancels.');
    this.preset = 'none';
    this.bend = 50;
    this.h = 0;
    this.v = 0;
    this.controls = W.identityControls(this.box);
    this.selected = -1;
    this.fields = {};
  }
  setPreset(preset, { bend = this.bend, h = this.h, v = this.v } = {}) {
    this.preset = preset;
    this.bend = bend;
    // None means no warp at all, whatever the distortion fields said before
    this.h = preset === 'none' ? 0 : h;
    this.v = preset === 'none' ? 0 : v;
    if (preset !== 'custom') this.controls = presetControls(this.box, preset, bend, this.h, this.v);
    this.updateChanged();
    this.syncBar();
    this.finish();
  }
  updateChanged() {
    const id = W.identityControls(this.box);
    this.changed = this.controls.some((p, i) => Math.abs(p[0] - id[i][0]) > 1e-6 || Math.abs(p[1] - id[i][1]) > 1e-6);
  }
  mesh(map, { final }) {
    const [x0, y0] = map(this.box.x, this.box.y);
    const [x1, y1] = map(this.box.x + this.box.width, this.box.y + this.box.height);
    return W.bezierGrids({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, this.controls.map(([x, y]) => map(x, y)), final ? 32 : 16);
  }
  hit(p) {
    // corners and handles win over inner points when they overlap
    const order = [...CORNERS, 1, 2, 4, 7, 8, 11, 13, 14, ...INNER];
    for (const i of order) if (dist(this.screen(...this.controls[i]), [p.screenX, p.screenY]) <= HIT) return i;
    return -1;
  }
  insideNet(p) {
    const xs = this.controls.map((c) => c[0]), ys = this.controls.map((c) => c[1]);
    return p.x >= Math.min(...xs) && p.x <= Math.max(...xs) && p.y >= Math.min(...ys) && p.y <= Math.max(...ys);
  }
  onPointerDown(p) {
    let i = this.hit(p);
    if (i < 0 && this.insideNet(p)) {
      // dragging the mesh surface pulls its nearest control point, like Photoshop's warp mesh
      let best = Infinity;
      this.controls.forEach((c, k) => {
        const d = dist(c, [p.x, p.y]);
        if (d < best) {
          best = d;
          i = k;
        }
      });
    }
    if (i < 0) return;
    this.selected = i;
    this.drag = { index: i, start: [p.x, p.y], controls: this.controls.map((c) => c.slice()) };
    this.invalidate();
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) {
      this.view.setCursor(this.hit(p) >= 0 ? 'pointer' : this.insideNet(p) ? 'move' : 'default');
      return;
    }
    const { index, start, controls } = this.drag;
    let dx = p.x - start[0], dy = p.y - start[1];
    if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    const moved = new Set([index, ...(CORNER_HANDLES[index] ?? [])]); // a corner carries its handles
    this.controls = controls.map((c, k) => (moved.has(k) ? [c[0] + dx, c[1] + dy] : c.slice()));
    this.preset = 'custom';
    this.updateChanged();
    this.syncBar();
    this.preview();
  }
  onPointerUp() {
    if (!this.drag) return;
    this.drag = null;
    this.finish();
  }
  onKeyDown(e) {
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && this.selected >= 0) {
      const [dx, dy] = moves[e.key];
      const c = this.controls[this.selected];
      c[0] += dx;
      c[1] += dy;
      this.preset = 'custom';
      this.updateChanged();
      this.syncBar();
      this.finish();
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    const c = this.controls;
    const S = (x, y) => {
      const p = view.toScreen(x, y);
      return [p.x, p.y];
    };
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(47,128,255,0.9)';
    const pt = [0, 0];
    // iso-curves of the patch: the 3 × 3 grid of the warped box
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      for (const along of ['u', 'v']) {
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          along === 'u' ? W.bezierPoint(c, i / 24, t, pt) : W.bezierPoint(c, t, i / 24, pt);
          const [x, y] = S(pt[0], pt[1]);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }
    // handle lines from each corner anchor
    ctx.strokeStyle = 'rgba(47,128,255,0.6)';
    for (const corner of CORNERS) {
      const [cx, cy] = S(...c[corner]);
      for (const h of CORNER_HANDLES[corner]) {
        const [hx, hy] = S(...c[h]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }
    }
    for (let i = 0; i < 16; i++) {
      const [x, y] = S(...c[i]);
      const corner = CORNERS.includes(i), inner = INNER.includes(i);
      drawHandle(ctx, x, y, { shape: corner ? 'square' : 'circle', size: corner ? 8 : inner ? 6 : 8, selected: i === this.selected });
    }
    ctx.restore();
  }
  renderBar(bar) {
    const toggle = this.button(bar, 'Warp', 'warp', () => this.app.commands.run('edit:transform-warp', undefined, 'toolbar'), { key: 'warp-toggle' });
    toggle.classList.add('warp-toggle');
    toggle.setAttribute('aria-pressed', 'true');
    toggle.title = 'Back to Free Transform';
    const g = this.group(bar);
    this.fields = {};
    this.fields.preset = this.select(g, 'warp-preset', 'Warp', WARP_PRESETS, this.preset, (v) => this.setPreset(v === 'custom' ? 'custom' : v));
    this.fields.bend = this.number(g, 'warp-bend', 'Bend', { min: -100, max: 100, step: 1, unit: '%', slider: true }, this.bend, (v) => this.setPreset(this.preset, { bend: v }));
    // like Bend, H and V only shape a geometric preset (disabled for None and Custom, see syncBar)
    this.fields.h = this.number(g, 'warp-h', 'H', { min: -100, max: 100, step: 1, unit: '%' }, this.h, (v) => this.geometric() && this.setPreset(this.preset, { h: v }));
    this.fields.v = this.number(g, 'warp-v', 'V', { min: -100, max: 100, step: 1, unit: '%' }, this.v, (v) => this.geometric() && this.setPreset(this.preset, { v }));
    const actions = this.group(bar);
    this.applyButtons(actions);
    this.syncBar();
  }
  syncBar() {
    const f = this.fields;
    if (!f?.preset) return;
    f.preset.value = this.preset;
    const set = (field, v) => {
      if (document.activeElement !== field.input) field.input.value = String(v);
      if (field.range) field.range.value = String(v);
    };
    set(f.bend, this.bend);
    set(f.h, this.h);
    set(f.v, this.v);
    // Bend, H and V only shape a geometric preset: idle for None (nothing to bend) and Custom (a hand-edited net)
    const geometric = this.geometric();
    for (const k of ['bend', 'h', 'v']) {
      if (!f[k]) continue;
      f[k].input.disabled = !geometric;
      if (f[k].range) f[k].range.disabled = !geometric;
    }
  }
  geometric() {
    return this.preset !== 'custom' && this.preset !== 'none';
  }
}

// ---- Perspective Warp -------------------------------------------------------------------------------------------

export class PerspectiveWarp extends WarpSession {
  constructor(tt) {
    super(tt, 'perspective', 'Perspective Warp', 'Layout: drag to draw quads on the planes of the image (edges snap together). Warp: drag the corners; Shift-click an edge to make it vertical or horizontal. Enter applies, Esc cancels.');
    this.points = []; // live corner positions (document coords), shared between adjoining quads
    this.quads = []; // { pts: [i0, i1, i2, i3] (tl, tr, br, bl), src: [[x, y] × 4] layout positions }
    this.mode = 'layout';
    this.creating = null;
    this.selected = -1;
    this.snapTarget = -1;
  }
  snapDist() {
    // well above the 8 px corner hit radius, so a new quad drawn from next to a corner shares it
    return 20 / Math.max(0.01, this.view?.zoom ?? 1);
  }
  /** A quad the perspective mesh can use (no coincident corners, no three corners in a line). */
  validQuad(q) {
    if (new Set(q.pts).size < 4) return false;
    try {
      W.perspectiveMesh([{ src: q.src, dst: q.pts.map((i) => this.points[i]) }], { subdivisions: 1 });
      return true;
    } catch {
      return false;
    }
  }
  nearestPoint(x, y, exclude = -1, limit = Infinity) {
    let best = -1, bd = this.snapDist();
    this.points.forEach((pt, i) => {
      if (i === exclude || i >= limit) return;
      const d = dist(pt, [x, y]);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
  /** Adds a quad (corners tl, tr, br, bl in document coords); corners near existing ones are shared. */
  addQuad(corners) {
    const existing = this.points.length;
    const idx = corners.map(([x, y]) => {
      const n = this.nearestPoint(x, y, -1, existing);
      if (n >= 0) return n;
      this.points.push([x, y]);
      return this.points.length - 1;
    });
    if (new Set(idx).size < 4) {
      this.pruneUnused();
      this.app.dialogs.toast('That quad would share two corners with another one; draw it a little farther away', { kind: 'error', timeout: 2600 });
      return false;
    }
    this.quads.push({ pts: idx, src: idx.map((i) => this.points[i].slice()) });
    this.invalidate();
    return true;
  }
  pruneUnused() {
    const used = new Set(this.quads.flatMap((q) => q.pts));
    const remap = new Map();
    const kept = [];
    this.points.forEach((pt, i) => {
      if (!used.has(i)) return;
      remap.set(i, kept.length);
      kept.push(pt);
    });
    this.points = kept;
    for (const q of this.quads) q.pts = q.pts.map((i) => remap.get(i));
    if (this.selected >= 0) this.selected = remap.get(this.selected) ?? -1;
  }
  /** Layout edits become the new source positions. */
  refreshSources() {
    for (const q of this.quads) q.src = q.pts.map((i) => this.points[i].slice());
    this.changed = false;
  }
  updateChanged() {
    // a quad dragged into a degenerate shape cannot warp: it does not count (so Enter records no empty step)
    this.changed = this.quads.some((q) => this.validQuad(q) && q.pts.some((i, k) => dist(this.points[i], q.src[k]) > 1e-6));
  }
  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'warp' && !this.quads.length) {
      this.app.dialogs.toast('Draw at least one quad in Layout mode first', { kind: 'error', timeout: 2200 });
      return;
    }
    if (mode === 'layout') {
      // back to layout: the warp is dropped and the quads become editable again
      for (const q of this.quads) q.pts.forEach((i, k) => (this.points[i] = q.src[k].slice()));
      this.changed = false;
    }
    this.mode = mode;
    this.syncBar();
    this.finish();
  }
  clear() {
    this.points = [];
    this.quads = [];
    this.selected = -1;
    this.changed = false;
    this.mode = 'layout';
    this.syncBar();
    this.finish();
  }
  mesh(map, { final }) {
    // degenerate quads are skipped (the others still warp) instead of failing the whole mesh
    const good = this.quads.filter((q) => this.validQuad(q));
    if (good.length < this.quads.length && !this.warnedDegenerate) {
      this.warnedDegenerate = true;
      this.app.dialogs.toast('A quad has collapsed corners and is left out of the warp; move its corners apart', { kind: 'error', timeout: 3200 });
    } else if (good.length === this.quads.length) this.warnedDegenerate = false;
    if (!good.length) return null;
    const quads = good.map((q) => ({ src: q.src.map(([x, y]) => map(x, y)), dst: q.pts.map((i) => map(...this.points[i])) }));
    return W.perspectiveMesh(quads, { subdivisions: final ? 16 : 10 });
  }
  /** Pixels outside the quads stay where they are; the warped quads are drawn over them. */
  render(canvas, x, y, opts) {
    if (!this.changed || !this.quads.length) return { canvas, x, y };
    // the same quads mesh() warps: a collapsed quad is left as it is, never erased
    const good = this.quads.filter((q) => this.validQuad(q));
    if (!good.length) return { canvas, x, y };
    const warped = super.render(canvas, x, y, opts);
    const b = unionRect({ x, y, width: canvas.width, height: canvas.height }, { x: warped.x, y: warped.y, width: warped.canvas.width, height: warped.canvas.height });
    const c = createCanvas(b.width, b.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, x - b.x, y - b.y);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (const q of good) {
      ctx.beginPath();
      q.src.forEach(([px, py], i) => (i ? ctx.lineTo(px - b.x, py - b.y) : ctx.moveTo(px - b.x, py - b.y)));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(warped.canvas, warped.x - b.x, warped.y - b.y);
    return { canvas: c, x: b.x, y: b.y };
  }
  hitPoint(p) {
    for (let i = this.points.length - 1; i >= 0; i--) if (dist(this.screen(...this.points[i]), [p.screenX, p.screenY]) <= HIT) return i;
    return -1;
  }
  /** Quad edge within 6 screen px of the pointer: { quad, a, b } (point indices) or null. */
  hitEdge(p) {
    const P = [p.screenX, p.screenY];
    let best = null, bd = 6;
    for (const q of this.quads) {
      for (let k = 0; k < 4; k++) {
        const a = q.pts[k], b = q.pts[(k + 1) % 4];
        const A = this.screen(...this.points[a]), B = this.screen(...this.points[b]);
        const d = pointSegmentDistance(P, A, B);
        if (d < bd) {
          bd = d;
          best = { quad: q, a, b };
        }
      }
    }
    return best;
  }
  quadAt(p) {
    for (let i = this.quads.length - 1; i >= 0; i--) {
      const q = this.quads[i];
      if (pointInPolygon([p.x, p.y], q.pts.map((k) => this.points[k]))) return q;
    }
    return null;
  }
  onPointerDown(p) {
    const i = this.hitPoint(p);
    if (i >= 0) {
      this.selected = i;
      this.drag = { point: i, start: [p.x, p.y], from: this.points[i].slice() };
      this.invalidate();
      return;
    }
    if (this.mode === 'layout') {
      this.creating = { start: [p.x, p.y], end: [p.x, p.y] };
      this.invalidate();
      return;
    }
    if (p.shift) {
      const e = this.hitEdge(p);
      if (e) {
        // Shift-click: snap the edge to the nearest axis about its midpoint
        const A = this.points[e.a], B = this.points[e.b];
        if (Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1])) A[1] = B[1] = (A[1] + B[1]) / 2;
        else A[0] = B[0] = (A[0] + B[0]) / 2;
        this.updateChanged();
        this.finish();
        return;
      }
    }
    const q = this.quadAt(p);
    if (q) this.drag = { quad: q, start: [p.x, p.y], from: q.pts.map((k) => this.points[k].slice()) };
  }
  onPointerMove(p, dragging) {
    if (!dragging || (!this.drag && !this.creating)) {
      this.view.setCursor(this.hitPoint(p) >= 0 ? 'pointer' : this.mode === 'layout' ? 'crosshair' : this.quadAt(p) ? 'move' : 'default');
      return;
    }
    if (this.creating) {
      this.creating.end = [p.x, p.y];
      this.invalidate();
      return;
    }
    const d = this.drag;
    const dx = p.x - d.start[0], dy = p.y - d.start[1];
    if (d.point !== undefined) {
      this.points[d.point] = [d.from[0] + dx, d.from[1] + dy];
      if (this.mode === 'layout') {
        // layout corners snap onto other corners (they merge on release)
        this.snapTarget = this.nearestPoint(this.points[d.point][0], this.points[d.point][1], d.point);
        if (this.snapTarget >= 0) this.points[d.point] = this.points[this.snapTarget].slice();
        this.refreshSources();
        this.invalidate();
        return;
      }
    } else if (d.quad) {
      d.quad.pts.forEach((k, j) => (this.points[k] = [d.from[j][0] + dx, d.from[j][1] + dy]));
    }
    this.updateChanged();
    this.preview();
  }
  onPointerUp(p) {
    if (this.creating) {
      const { start, end } = this.creating;
      this.creating = null;
      const x0 = Math.min(start[0], end[0]), y0 = Math.min(start[1], end[1]);
      const x1 = Math.max(start[0], end[0]), y1 = Math.max(start[1], end[1]);
      if (x1 - x0 >= 4 && y1 - y0 >= 4) this.addQuad([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      this.invalidate();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.point !== undefined && this.mode === 'layout') {
      if (this.snapTarget >= 0 && this.snapTarget !== d.point) {
        const from = d.point, to = this.snapTarget;
        // a merge that would give one quad two identical corners is refused: the corner goes back
        const collapses = this.quads.some((q) => new Set(q.pts.map((i) => (i === from ? to : i))).size < 4);
        if (collapses) this.points[from] = d.from.slice();
        else {
          for (const q of this.quads) q.pts = q.pts.map((i) => (i === from ? to : i));
          this.pruneUnused();
        }
      }
      this.snapTarget = -1;
      this.refreshSources();
      this.invalidate();
      return;
    }
    void p;
    this.finish();
  }
  onKeyDown(e) {
    if (e.key === 'Enter' && this.mode === 'layout' && this.quads.length) {
      this.setMode('warp');
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === 'layout' && this.quads.length) {
      // the quad holding the selected corner (the last one drawn when nothing is selected)
      const qi = this.selected >= 0 ? this.quads.findIndex((q) => q.pts.includes(this.selected)) : -1;
      this.quads.splice(qi >= 0 ? qi : this.quads.length - 1, 1);
      this.selected = -1;
      this.pruneUnused();
      this.refreshSources();
      this.invalidate();
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && this.selected >= 0 && this.mode === 'warp') {
      const [dx, dy] = moves[e.key];
      const pt = this.points[this.selected];
      pt[0] += dx;
      pt[1] += dy;
      this.updateChanged();
      this.finish();
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    const S = (x, y) => {
      const p = view.toScreen(x, y);
      return [p.x, p.y];
    };
    ctx.save();
    ctx.lineWidth = 1;
    for (const q of this.quads) {
      ctx.beginPath();
      q.pts.forEach((k, i) => {
        const [x, y] = S(...this.points[k]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      if (this.mode === 'layout') {
        ctx.fillStyle = 'rgba(47,128,255,0.12)';
        ctx.fill();
      }
      ctx.strokeStyle = '#2f80ff';
      ctx.stroke();
      if (this.mode === 'warp') {
        // the thirds of each quad hint at the perspective inside it
        ctx.strokeStyle = 'rgba(47,128,255,0.35)';
        const [a, b, c, d] = q.pts.map((k) => this.points[k]);
        for (const t of [1 / 3, 2 / 3]) {
          const top = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bot = [d[0] + (c[0] - d[0]) * t, d[1] + (c[1] - d[1]) * t];
          const left = [a[0] + (d[0] - a[0]) * t, a[1] + (d[1] - a[1]) * t], right = [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t];
          for (const [p1, p2] of [[top, bot], [left, right]]) {
            ctx.beginPath();
            ctx.moveTo(...S(...p1));
            ctx.lineTo(...S(...p2));
            ctx.stroke();
          }
        }
      }
    }
    if (this.creating) {
      const { start, end } = this.creating;
      const [x0, y0] = S(...start), [x1, y1] = S(...end);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#2f80ff';
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
    this.points.forEach((pt, i) => {
      const [x, y] = S(...pt);
      if (i === this.snapTarget) {
        ctx.strokeStyle = '#ffcc33';
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawHandle(ctx, x, y, { shape: this.mode === 'layout' ? 'square' : 'circle', size: 9, selected: i === this.selected });
    });
    ctx.restore();
  }
  renderBar(bar) {
    const g = this.group(bar);
    this.modeSeg = this.segment(g, 'pw-mode', [['layout', 'Layout'], ['warp', 'Warp']], this.mode, (v) => this.setMode(v));
    this.button(g, 'Clear', 'close', () => this.clear(), { key: 'pw-clear' });
    this.hintEl = this.hintLabel(g, '');
    const actions = this.group(bar);
    this.applyButtons(actions);
    this.syncBar();
  }
  syncBar() {
    if (this.modeSeg) for (const b of this.modeSeg.children) b.setAttribute('aria-pressed', String(b.dataset.value === this.mode));
    if (this.hintEl) this.hintEl.textContent = this.mode === 'layout' ? (this.quads.length ? `${this.quads.length} quad${this.quads.length > 1 ? 's' : ''} — Enter switches to Warp` : 'Drag to draw a quad on each plane') : 'Drag corners · Shift-click an edge to straighten it';
  }
}

function pointSegmentDistance(P, A, B) {
  const vx = B[0] - A[0], vy = B[1] - A[1];
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / len2));
  return Math.hypot(P[0] - (A[0] + t * vx), P[1] - (A[1] + t * vy));
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- Puppet Warp --------------------------------------------------------------------------------------------------

const PUPPET_KIND = { rigid: 'rigid', normal: 'similarity', distort: 'affine' };
const DENSITY_CELLS = { fewer: 8, normal: 16, more: 32 }; // cells along the longer edge of the content

export class PuppetWarp extends WarpSession {
  constructor(tt) {
    super(tt, 'puppet', 'Puppet Warp', 'Click to add pins, drag a pin to move the image around it, Alt-drag to rotate, Delete removes the selected pin. Enter applies, Esc cancels.');
    this.pins = []; // { x, y (original position), tx, ty (target), angle }
    this.selected = -1;
    this.mode = 'normal';
    this.density = 'normal';
    this.showMesh = true;
    this.buildMesh();
  }
  get kind_() {
    return PUPPET_KIND[this.mode] ?? 'similarity';
  }
  /** Triangle mesh over the opaque pixels (for display): grid cells of the content box that contain any alpha. */
  buildMesh() {
    const b = this.box;
    const sp = Math.min(400, Math.max(4, Math.max(b.width, b.height) / DENSITY_CELLS[this.density]));
    const cols = Math.max(1, Math.ceil(b.width / sp)), rows = Math.max(1, Math.ceil(b.height / sp));
    const cells = new Uint8Array(cols * rows);
    for (const src of this.sources()) {
      const img = canvasData(src.canvas);
      const d = img.data;
      for (let y = 0; y < img.height; y++) {
        const cy = Math.min(rows - 1, Math.floor((src.y + y - b.y) / sp));
        if (cy < 0) continue;
        for (let x = 0; x < img.width; x++) {
          if (!d[(y * img.width + x) * 4 + 3]) continue;
          const cx = Math.min(cols - 1, Math.floor((src.x + x - b.x) / sp));
          if (cx >= 0) cells[cy * cols + cx] = 1;
        }
      }
    }
    this.meshInfo = { sp, cols, rows, cells };
    this.invalidate();
  }
  /**
   * Pins as the MLS engine sees them. A rotated pin adds four satellites turned about it; their
   * radius is a share of the distance to the nearest other pin (a quarter of the box for a lone
   * pin), because satellites hugging the pin would be outweighed by the anchors everywhere else
   * and the turn would never show.
   */
  mlsPins() {
    const out = [];
    for (const p of this.pins) {
      out.push({ from: [p.x, p.y], to: [p.tx, p.ty] });
      if (!p.angle) continue;
      let nearest = Infinity;
      for (const o of this.pins) if (o !== p) nearest = Math.min(nearest, Math.hypot(o.x - p.x, o.y - p.y));
      const r = Math.max(8, Number.isFinite(nearest) ? nearest * 0.4 : Math.max(this.box.width, this.box.height) * 0.25);
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r]]) out.push({ from: [p.x + dx, p.y + dy], to: [p.tx + dx * c - dy * s, p.ty + dx * s + dy * c] });
    }
    return out;
  }
  updateChanged() {
    this.changed = this.pins.some((p) => Math.abs(p.tx - p.x) > 1e-6 || Math.abs(p.ty - p.y) > 1e-6 || p.angle !== 0);
  }
  mesh(map) {
    const [x0, y0] = map(this.box.x, this.box.y);
    const [x1, y1] = map(this.box.x + this.box.width, this.box.y + this.box.height);
    const pins = this.mlsPins().map((p) => ({ from: map(...p.from), to: map(...p.to) }));
    return W.mlsGrids({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, pins, { kind: this.kind_, alpha: 1, step: 4 });
  }
  /**
   * Position a document point currently shows pixels from (inverse of the live warp): Newton steps with a
   * numeric Jacobian, which converge under rotation too (a plain fixed-point iteration diverges there).
   */
  inverse(x, y) {
    if (!this.changed) return [x, y];
    const pins = this.mlsPins();
    const opts = { kind: this.kind_, alpha: 1 };
    const f = (px, py) => {
      const out = [0, 0];
      W.mlsPoint(pins, [px, py], opts, out);
      return out;
    };
    const h = 0.5;
    const maxStep = Math.max(8, Math.max(this.box.width, this.box.height) * 0.25);
    let v = [x, y];
    for (let i = 0; i < 40; i++) {
      const fv = f(v[0], v[1]);
      const ex = fv[0] - x, ey = fv[1] - y;
      if (Math.hypot(ex, ey) < 0.01) break;
      const fx = f(v[0] + h, v[1]), fy = f(v[0], v[1] + h);
      const a = (fx[0] - fv[0]) / h, b = (fy[0] - fv[0]) / h, c = (fx[1] - fv[1]) / h, dd = (fy[1] - fv[1]) / h;
      const det = a * dd - b * c;
      let sx, sy;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
        sx = ex;
        sy = ey;
      } else {
        sx = (dd * ex - b * ey) / det;
        sy = (-c * ex + a * ey) / det;
      }
      const len = Math.hypot(sx, sy);
      if (len > maxStep) {
        sx *= maxStep / len;
        sy *= maxStep / len;
      }
      v = [v[0] - sx, v[1] - sy];
    }
    return v;
  }
  addPin(x, y) {
    const [fx, fy] = this.inverse(x, y);
    this.pins.push({ x: fx, y: fy, tx: x, ty: y, angle: 0 });
    this.selected = this.pins.length - 1;
    this.updateChanged();
    this.invalidate();
    this.app.commands.invalidate();
  }
  removePin(i) {
    if (i < 0 || i >= this.pins.length) return;
    this.pins.splice(i, 1);
    this.selected = Math.min(this.selected, this.pins.length - 1);
    this.updateChanged();
    this.finish();
  }
  hitPin(p) {
    for (let i = this.pins.length - 1; i >= 0; i--) if (dist(this.screen(this.pins[i].tx, this.pins[i].ty), [p.screenX, p.screenY]) <= HIT) return i;
    return -1;
  }
  onPointerDown(p) {
    const i = this.hitPin(p);
    if (i >= 0) {
      this.selected = i;
      const pin = this.pins[i];
      this.drag = { index: i, start: [p.x, p.y], tx: pin.tx, ty: pin.ty, angle: pin.angle, rotate: !!p.alt };
      this.invalidate();
      return;
    }
    this.drag = { add: true, start: [p.x, p.y], moved: false };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) {
      this.view.setCursor(this.hitPin(p) >= 0 ? (p.alt ? 'alias' : 'move') : 'crosshair');
      return;
    }
    const d = this.drag;
    if (d.add) {
      if (dist(d.start, [p.x, p.y]) * (this.view?.zoom ?? 1) > 3) d.moved = true;
      return;
    }
    const pin = this.pins[d.index];
    if (!pin) return;
    if (d.rotate || p.alt) {
      // Alt-drag: rotate the surroundings about the pin, which stays put. The drag starts on the pin
      // itself, so there is no start angle to measure from: the angle accumulates from the pointer's
      // sweep around the pin instead, ignoring moves while it is still within a few screen px of it.
      const prev = d.prev ?? d.start;
      const near = 3 / Math.max(0.01, this.view?.zoom ?? 1);
      if (dist(prev, [d.tx, d.ty]) > near && dist([p.x, p.y], [d.tx, d.ty]) > near) {
        let delta = Math.atan2(p.y - d.ty, p.x - d.tx) - Math.atan2(prev[1] - d.ty, prev[0] - d.tx);
        if (delta > Math.PI) delta -= 2 * Math.PI;
        else if (delta < -Math.PI) delta += 2 * Math.PI;
        pin.angle += delta;
      }
      d.prev = [p.x, p.y];
      pin.tx = d.tx;
      pin.ty = d.ty;
    } else {
      pin.tx = d.tx + (p.x - d.start[0]);
      pin.ty = d.ty + (p.y - d.start[1]);
    }
    this.updateChanged();
    this.preview();
  }
  onPointerUp(p) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.add) {
      if (!d.moved) this.addPin(p.x, p.y);
      return;
    }
    this.finish();
  }
  onKeyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0) {
      this.removePin(this.selected);
      return true;
    }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && this.selected >= 0) {
      const pin = this.pins[this.selected];
      pin.tx += moves[e.key][0];
      pin.ty += moves[e.key][1];
      this.updateChanged();
      this.finish();
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    const S = (x, y) => {
      const p = view.toScreen(x, y);
      return [p.x, p.y];
    };
    ctx.save();
    ctx.lineWidth = 1;
    if (this.showMesh && this.meshInfo) {
      const { sp, cols, rows, cells } = this.meshInfo;
      const pins = this.mlsPins();
      const opts = { kind: this.kind_, alpha: 1 };
      const b = this.box;
      // vertices of the marked cells, deformed through the live warp, computed once per draw
      const verts = new Map();
      const vertex = (c, r) => {
        const key = r * (cols + 1) + c;
        let v = verts.get(key);
        if (!v) {
          const x = b.x + Math.min(c * sp, b.width), y = b.y + Math.min(r * sp, b.height);
          const w = this.changed ? W.mlsPoint(pins, [x, y], opts, [0, 0]) : [x, y];
          v = S(w[0], w[1]);
          verts.set(key, v);
        }
        return v;
      };
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!cells[r * cols + c]) continue;
          const p00 = vertex(c, r), p10 = vertex(c + 1, r), p01 = vertex(c, r + 1), p11 = vertex(c + 1, r + 1);
          ctx.moveTo(p00[0], p00[1]);
          ctx.lineTo(p10[0], p10[1]);
          ctx.lineTo(p11[0], p11[1]);
          ctx.lineTo(p01[0], p01[1]);
          ctx.closePath();
          ctx.moveTo(p00[0], p00[1]);
          ctx.lineTo(p11[0], p11[1]);
        }
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(47,128,255,0.5)';
      ctx.stroke();
    }
    this.pins.forEach((pin, i) => {
      const [x, y] = S(pin.tx, pin.ty);
      drawHandle(ctx, x, y, { shape: 'circle', size: 11, selected: i === this.selected });
      ctx.fillStyle = '#2f80ff';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      if (pin.angle || (i === this.selected && this.drag?.rotate)) {
        // rotation indicator: a ring with a tick at the current angle
        ctx.strokeStyle = '#ffcc33';
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 14 * Math.cos(pin.angle - Math.PI / 2), y + 14 * Math.sin(pin.angle - Math.PI / 2));
        ctx.stroke();
      }
    });
    ctx.restore();
  }
  renderBar(bar) {
    const g = this.group(bar);
    this.select(g, 'puppet-mode', 'Mode', [['rigid', 'Rigid'], ['normal', 'Normal'], ['distort', 'Distort']], this.mode, (v) => {
      this.mode = v;
      this.finish();
    });
    this.select(g, 'puppet-density', 'Density', [['fewer', 'Fewer points'], ['normal', 'Normal'], ['more', 'More points']], this.density, (v) => {
      this.density = v;
      this.buildMesh();
    });
    this.checkbox(g, 'puppet-mesh', 'Show mesh', this.showMesh, (v) => {
      this.showMesh = v;
      this.invalidate();
    });
    this.button(g, 'Remove all pins', 'close', () => {
      this.pins = [];
      this.selected = -1;
      this.updateChanged();
      this.finish();
    }, { key: 'puppet-clear' });
    const actions = this.group(bar);
    this.applyButtons(actions);
  }
}

// ---- installation -------------------------------------------------------------------------------------------------

const KINDS = { bezier: BezierWarp, perspective: PerspectiveWarp, puppet: PuppetWarp };

export function install(app) {
  const tt = app.transformTool;
  const isIdentity = (m) => m && Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
  const rasterOnly = (s) => !!s && !s.selectionOnly && s.targets.every((l) => l.type === 'raster');

  // While a warp session is active the controller handles the pointer, keys and the options bar;
  // everything else (start, update, commit, cancel, end) stays the transform tool's.
  const wrap = (name, fn) => {
    const orig = tt[name].bind(tt);
    tt[name] = (...args) => fn(orig, ...args);
  };
  wrap('onPointerDown', (orig, p) => (tt.warp?.active ? tt.warp.onPointerDown(p) : orig(p)));
  wrap('onPointerMove', (orig, p, dragging) => (tt.warp?.active ? tt.warp.onPointerMove(p, dragging) : orig(p, dragging)));
  wrap('onPointerUp', (orig, p) => (tt.warp?.active ? tt.warp.onPointerUp(p) : orig(p)));
  wrap('onDoubleClick', (orig, p) => (tt.warp?.active ? tt.warp.onDoubleClick(p) : orig(p)));
  wrap('onKeyDown', (orig, e) => {
    if (tt.warp?.active) {
      if (tt.warp.onKeyDown(e)) return true;
      // Delete with no pin/quad selected, and arrows with nothing to nudge, do nothing inside a warp session:
      // they must not reach the keymap (Delete would apply the warp and then delete the layer)
      if (e.key === 'Delete' || e.key === 'Backspace' || /^Arrow/.test(e.key)) return true;
    }
    return orig(e);
  });
  wrap('syncBar', (orig) => (tt.warp?.active ? tt.warp.syncBar() : orig()));
  wrap('renderOptions', (orig, bar) => {
    if (tt.warp?.active) return tt.warp.renderBar(bar);
    orig(bar);
    addWarpToggle(bar);
  });
  wrap('end', (orig) => {
    const w = tt.warp;
    tt.warp = null;
    w?.dispose();
    orig();
  });

  /** The Warp toggle of the Free Transform options bar (before its Cancel / Apply buttons). */
  function addWarpToggle(bar) {
    if (!tt.session) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small warp-toggle';
    b.dataset.key = 'warp-toggle';
    b.title = 'Warp mode';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${icon('warp')}<span>Warp</span>`;
    b.addEventListener('click', () => {
      b.blur();
      app.commands.run('edit:transform-warp', undefined, 'toolbar');
    });
    const cancel = [...bar.querySelectorAll('button.btn')].find((x) => x.textContent.trim() === 'Cancel');
    if (cancel) bar.insertBefore(b, cancel);
    else bar.appendChild(b);
  }

  function attach(kind) {
    tt.warp = new KINDS[kind](tt);
    app.tools.renderOptions();
    app.statusbar?.set('hint', tt.warp.hint);
    app.view?.setCursor('default');
    tt.update({ final: true });
    app.view?.invalidate();
    app.commands.invalidate();
    return tt.warp;
  }

  /** Starts (or converts the running transform into) a warp session of the given kind. */
  function startSession(kind) {
    const d = app.doc;
    if (!d) return null;
    if (tt.session) {
      if (tt.warp?.active && tt.warp.kind === kind) return tt.warp;
      const s = tt.session;
      // a Free Transform of text, shapes or smart objects stays live: warping them needs pixels first
      const nonRaster = !s.selectionOnly ? s.targets.filter((l) => l.type !== 'raster') : [];
      if (nonRaster.length) return askRasterize(d, nonRaster, kind, s.targets);
      // an untouched Free Transform of raster layers becomes the warp session in place; a scaled or rotated one
      // is applied first (its own step, kept for Transform Again), then the warp starts on the result
      if (!tt.warp && rasterOnly(s) && isIdentity(tt.matrix)) return attach(kind);
      tt.commit(); // apply what is pending first (end() clears any warp)
    }
    const layers = tt.collectTargets(d, { quiet: true });
    if (!layers.length) {
      app.dialogs.toast(d.selection && !d.selection.isEmpty ? 'Select a layer to warp (the selection alone cannot be warped)' : 'Select a layer to warp', { kind: 'error' });
      return null;
    }
    const others = layers.filter((l) => l.type !== 'raster');
    if (others.length) return askRasterize(d, others, kind, layers);
    tt.start({ mode: kind });
    if (!tt.session) return null;
    return attach(kind);
  }

  /** Warps need pixels: asks to rasterize one text / shape / smart object layer, then starts the session. */
  async function askRasterize(d, layers, kind, targets = layers) {
    const what = (l) => (l.type === 'text' ? 'text' : l.type === 'shape' ? 'shape' : l.type === 'smart' ? 'smart object' : l.type);
    // the prompt only when that layer is the only one to warp: rasterizing resets the selection to it, and
    // the other selected layers would silently drop out of the warp
    if (layers.length !== 1 || targets.length !== 1 || d.active !== layers[0]) {
      app.dialogs.toast(`Rasterize the ${what(layers[0])} layer first (Layer › Rasterize), then warp it`, { kind: 'error', timeout: 3000 });
      return null;
    }
    const l = layers[0];
    const detail = l.type === 'smart' ? 'The smart object becomes an ordinary pixel layer; its contents and smart filters are no longer editable.' : l.type === 'text' ? 'The text keeps its look but can no longer be edited as text.' : 'The shape keeps its look but is no longer an editable vector shape.';
    const ok = await app.dialogs.confirm(`Rasterize the ${what(l)} layer "${l.name}" to warp it?`, { title: 'Warp', detail, okLabel: 'Rasterize' });
    if (!ok || app.doc !== d) return null;
    app.commands.run('layer:rasterize', undefined, 'api');
    if (d.active?.type !== 'raster') return null;
    return startSession(kind);
  }

  /** Edit › Transform › Warp and the options-bar toggle: into warp mode, or back to Free Transform. */
  function toggleWarp() {
    if (tt.session && tt.warp?.active && tt.warp.kind === 'bezier') {
      if (tt.warp.changed) {
        tt.commit();
        tt.start({ mode: 'free' });
      } else {
        const w = tt.warp;
        tt.warp = null;
        w.dispose();
        app.tools.renderOptions();
        app.statusbar?.set('hint', tt.hint ?? '');
        tt.update({ final: true });
        app.view?.invalidate();
      }
      return;
    }
    startSession('bezier');
  }

  const available = () => !!app.doc && (tt.canStart() || !!tt.session);
  app.commands.registerAll({
    'edit:transform-warp': { label: 'Warp', enabled: available, checked: () => !!tt.warp?.active && tt.warp.kind === 'bezier', run: () => toggleWarp() },
    'edit:perspective-warp': { label: 'Perspective Warp', enabled: available, run: () => startSession('perspective') },
    'edit:puppet-warp': { label: 'Puppet Warp', enabled: available, run: () => startSession('puppet') },
  });
  app.warp = { start: startSession, presets: WARP_PRESETS };
}
