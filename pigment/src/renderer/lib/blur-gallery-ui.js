// Blur Gallery (Filter › Blur Gallery): one on-canvas session for Field Blur, Iris Blur, Tilt-Shift,
// Path Blur and Spin Blur — see ARCHITECTURE.md "Blur Gallery". The engines are pure filters in
// src/shared/pixels/blur-gallery.js whose params hold the pins; this module edits those params.
//
// The session is a hidden tool (like Free Transform): while it runs it is the active tool, so the
// canvas view routes the pointer to it, draws its overlay (pins, the blur ring, ellipse handles,
// tilt-shift lines, path points and speed arrows) and gives it the keys (Delete removes a pin,
// Enter applies, Escape cancels). A panel takes the place of the panel dock with the selected
// pin's sliders, the Effects and Noise tabs and OK / Cancel. The pixels are previewed through a
// pixel edit session (lib/adjust-ui.js beginPixelEdit): on a reduced copy of the layer while
// something is dragged, at full size shortly after and on OK, and committed as one history entry
// with meta { filter: { kind, params } }. The opener resolves with the committed params, which
// re-run through FILTERS[kind].apply (Last Filter, actions, smart filters) to the same pixels.
//
// Like a modal dialog the session owns the document until it ends: other commands are refused
// (app.commands.run is wrapped while a session is open) and the toolbox and tabs are inert.
import { FILTERS, applyFilter } from '../../shared/pixels/filters.js'; // first: the filter tables form an import cycle
import { BLUR_GALLERY_KINDS, scaleBlurParams, pathPolyline, irisExponent } from '../../shared/pixels/blur-gallery.js';
import { Tool } from './tools.js';
import { buildForm } from './form.js';
import { icon } from './icons.js';
import { createCanvas } from './document.js';
import { processed, getPath, setPath } from './adjust-ui.js';
import { bridge } from './bridge.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

const TOOL_ID = 'blur-gallery';
const PREVIEW_PIXELS = 170_000; // size of the copy the blur runs on while something is dragged (about 60-90 ms a frame)
const SYNC_PIXELS = 400_000; // a full-quality render above this size runs under app.busy
const SETTLE_MS = 300; // pause after the last change before the full-quality render of a large layer
const HIT = 9; // screen px around a handle
const RING = 30; // screen radius of the blur ring
const RING_TURN = { blur: 100, angle: 360 }; // what one full turn of the ring is worth
const ARROW_BASE = 18, ARROW_SCALE = 0.5; // screen length of a speed arrow: base + speed * scale

/** Commands that may run while a session is open (they do not touch the document). */
const SAFE_COMMANDS = /^(view:(?!next-tab|prev-tab)|help:|app:escape$|app:enter$)/;

const LENS_KINDS = new Set(['field-blur', 'iris-blur', 'tilt-shift']);
const ELLIPSE_KINDS = new Set(['iris-blur', 'spin-blur']);
/** The parameter the ring around the selected pin edits. */
const ringParam = (kind) => (kind === 'spin-blur' ? 'angle' : 'blur');

/** Allowed range per pin parameter (also what the panel's sliders offer, in parameter units). */
const PIN_RANGES = { x: [0, 1], y: [0, 1], blur: [0, 500], rx: [0.01, 2], ry: [0.01, 2], rotation: [-180, 180], roundness: [-100, 100], feather: [0, 1], angle: [0, 360], focus: [0, 1], fade: [0, 1] };

const HINTS = {
  'field-blur': 'Click to add a pin, drag a pin to move it, drag its ring to set the blur. Delete removes the pin, Enter applies, Esc cancels.',
  'iris-blur': 'Drag the pin, its ring (blur), the handles on the ellipse (size, rotation), the inner dots (sharp area) or the square (roundness). Click adds a pin, Enter applies, Esc cancels.',
  'tilt-shift': 'Drag the pin, its ring (blur), the solid lines (focus), the dashed lines (transition) or the dots on the lines (rotation). Click adds a pin, Enter applies, Esc cancels.',
  'path-blur': 'Drag a point or an arrow (end speed), click the path to add a point, drag on the image for a new path. Delete removes the point, Enter applies, Esc cancels.',
  'spin-blur': 'Drag the pin, its ring (blur angle), the handles on the ellipse (size, rotation) or the inner dots (full-strength area). Click adds a pin, Enter applies, Esc cancels.',
};

// ---- params ---------------------------------------------------------------------------------------------------

const finite = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

/** A complete, valid copy of params for a kind (remembered or recorded params may be partial or stale). */
function normalise(kind, params) {
  const def = FILTERS[kind].defaults;
  const p = { ...clone(def), ...clone(params ?? {}) };
  if (kind === 'path-blur') {
    p.paths = (Array.isArray(p.paths) ? p.paths : [])
      .map((path) => ({
        points: (Array.isArray(path?.points) ? path.points : []).filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y)).map((q) => ({ x: clamp(q.x, 0, 1), y: clamp(q.y, 0, 1) })),
        endSpeeds: [finite(path?.endSpeeds?.[0], 0, 500, 50), finite(path?.endSpeeds?.[1], 0, 500, 50)],
      }))
      .filter((path) => path.points.length >= 2);
    p.speed = finite(p.speed, 0, 100, def.speed);
    p.taper = finite(p.taper, 0, 100, def.taper);
    p.centeredBlur = p.centeredBlur !== false;
  } else {
    const d0 = def.pins[0];
    p.pins = (Array.isArray(p.pins) ? p.pins : []).filter((pin) => pin && typeof pin === 'object').map((pin) => {
      const out = {};
      for (const k of Object.keys(d0)) out[k] = finite(pin[k], ...PIN_RANGES[k], d0[k]);
      return out;
    });
  }
  if (kind === 'tilt-shift') {
    p.distortion = finite(p.distortion, -100, 100, 0);
    p.symmetricDistortion = !!p.symmetricDistortion;
  }
  if ('bokeh' in def) {
    const b = p.bokeh && typeof p.bokeh === 'object' ? p.bokeh : {};
    p.bokeh = { lightBokeh: finite(b.lightBokeh, 0, 100, 0), bokehColor: finite(b.bokehColor, 0, 100, 0), lightRange: [finite(b.lightRange?.[0], 0, 255, 191), finite(b.lightRange?.[1], 0, 255, 255)] };
  }
  if ('strobe' in def) {
    p.strobe = !!p.strobe;
    p.strobeStrength = finite(p.strobeStrength, 0, 100, 50);
    p.strobeFlashes = Math.round(finite(p.strobeFlashes, 1, 100, 1));
  }
  const n = p.noise && typeof p.noise === 'object' ? p.noise : {};
  p.noise = {
    amount: finite(n.amount, 0, 100, 0), size: finite(n.size, 1, 100, 1), roughness: finite(n.roughness, 0, 100, 0), color: finite(n.color, 0, 100, 0),
    highlights: finite(n.highlights, 0, 100, 0), distribution: n.distribution === 'uniform' ? 'uniform' : 'gaussian',
  };
  return p;
}

// ---- panel field tables (form value = parameter * scale) ---------------------------------------------------------

const F = (key, label, min, max, step = 1, unit = '', scale = 1) => ({ key, label, type: 'slider', min, max, step, unit, scale });
const BLUR = F('blur', 'Blur', 0, 500, 1, 'px');
const ROTATION = F('rotation', 'Rotation', -180, 180, 1, '°');
const PIN_FIELDS = {
  'field-blur': [BLUR],
  'iris-blur': [BLUR, F('rx', 'Width', 1, 200, 1, '%', 100), F('ry', 'Height', 1, 200, 1, '%', 100), ROTATION, F('roundness', 'Roundness', -100, 100, 1), F('feather', 'Sharp area', 0, 100, 1, '%', 100)],
  'tilt-shift': [BLUR, ROTATION, F('focus', 'Focus', 0, 100, 1, '%', 100), F('fade', 'Transition', 0, 100, 1, '%', 100)],
  'spin-blur': [F('angle', 'Blur angle', 0, 360, 1, '°'), F('rx', 'Width', 1, 200, 1, '%', 100), F('ry', 'Height', 1, 200, 1, '%', 100), ROTATION, F('feather', 'Full strength', 0, 100, 1, '%', 100)],
  'path-blur': [F('endSpeeds.0', 'Start speed', 0, 500, 1, 'px'), F('endSpeeds.1', 'End speed', 0, 500, 1, 'px')],
};
const GLOBAL_FIELDS = {
  'tilt-shift': [F('distortion', 'Distortion', -100, 100, 1, '%'), { key: 'symmetricDistortion', label: 'Symmetric distortion', type: 'checkbox' }],
  'path-blur': [F('speed', 'Speed', 0, 100, 1, '%'), F('taper', 'Taper', 0, 100, 1, '%'), { key: 'centeredBlur', label: 'Centered blur', type: 'checkbox' }],
};
const BOKEH_FIELDS = [F('bokeh.lightBokeh', 'Light bokeh', 0, 100, 1, '%'), F('bokeh.bokehColor', 'Bokeh color', 0, 100, 1, '%'), F('bokeh.lightRange.0', 'Light range from', 0, 255, 1), F('bokeh.lightRange.1', 'Light range to', 0, 255, 1)];
const STROBE_FIELDS = [{ key: 'strobe', label: 'Strobe flashes', type: 'checkbox' }, F('strobeStrength', 'Strobe strength', 0, 100, 1, '%'), F('strobeFlashes', 'Flashes', 1, 100, 1)];
const NOISE_FIELDS = [
  F('noise.amount', 'Amount', 0, 100, 1, '%'), F('noise.size', 'Size', 1, 100, 1), F('noise.roughness', 'Roughness', 0, 100, 1, '%'), F('noise.color', 'Color', 0, 100, 1, '%'),
  F('noise.highlights', 'Highlights', 0, 100, 1, '%'), { key: 'noise.distribution', label: 'Distribution', type: 'segment', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] },
];

// ---- drawing helpers (screen space) ---------------------------------------------------------------------------------

/** Strokes the current path twice (dark under light) so it reads on any image. */
function outline(ctx, { dash = null, width = 1.25, color = '#ffffff' } = {}) {
  ctx.save();
  ctx.setLineDash(dash ?? []);
  ctx.lineJoin = 'round';
  ctx.lineWidth = width + 2;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, p, r, fill, stroke = 'rgba(0, 0, 0, 0.7)') {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function square(ctx, p, r, fill) {
  ctx.beginPath();
  ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.stroke();
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment a-b and the parameter of the nearest point. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return { d: Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y), t };
}

// ---- the tool ---------------------------------------------------------------------------------------------------------

class BlurGalleryTool extends Tool {
  constructor(app) {
    super(app, { id: TOOL_ID, name: 'Blur Gallery', icon: 'filter', cursor: 'default', hint: '', options: [] });
    this.session = null;
    this.ending = false;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------

  /** The custom opener of the five kinds: resolves with the committed params, or null when cancelled. */
  open(kind, { params } = {}) {
    const app = this.app;
    const def = FILTERS[kind];
    if (!def || !app.doc) return Promise.resolve(null);
    if (this.session) {
      app.dialogs.toast('Finish the blur that is open first', { kind: 'error' });
      return Promise.resolve(null);
    }
    const start = normalise(kind, params);
    // the same margin a direct run of the kind uses, so the pins (fractions of the edited region) mean the same there
    const edit = app.beginPixelEdit({ label: def.name, margin: app.filterEditor?.marginFor?.(kind, start) ?? 0 });
    if (!edit) return Promise.resolve(null);
    const base = edit.base;
    const s = {
      kind, def, doc: app.doc, edit, params: start,
      sel: kind === 'path-blur' ? { path: start.paths.length ? 0 : -1, point: -1 } : { pin: start.pins.length ? 0 : -1 },
      drag: null, hover: null, previewOn: true, hidden: false, tab: 'blur',
      shown: { key: null, full: false }, busy: false, timer: 0, raf: 0, reduced: null, resolve: null, panel: null,
    };
    // layers clearly larger than the preview size are blurred on a reduced copy while something is dragged
    if (base.width * base.height > PREVIEW_PIXELS * 1.3) {
      const scale = Math.sqrt(PREVIEW_PIXELS / (base.width * base.height));
      const full = createCanvas(base.width, base.height);
      full.getContext('2d').putImageData(new ImageData(base.data, base.width, base.height), 0, 0);
      const small = createCanvas(Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)));
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(full, 0, 0, small.width, small.height);
      s.reduced = { scale: small.width / base.width, image: sctx.getImageData(0, 0, small.width, small.height), small: createCanvas(small.width, small.height), up: full };
    }
    // made before anything can end the session, so every way out resolves it
    const done = new Promise((resolve) => {
      s.resolve = resolve;
    });
    this.session = s;
    this.name = def.name;
    this.hint = HINTS[kind];
    this.returnTo = app.tools.active && app.tools.active !== this ? app.tools.active.id : 'move';
    s.hideAnts = s.doc.view.hideAnts;
    s.doc.view.hideAnts = true; // the marching ants would run through the pins
    const appEl = document.getElementById('app');
    s.panelsWereHidden = !!appEl?.classList.contains('panels-hidden');
    appEl?.classList.remove('panels-hidden'); // the session's panel must be reachable
    this.buildPanel();
    document.body.classList.add('blur-gallery-active');
    app.tools.tools.set(TOOL_ID, this); // registered only while a session runs: it is not a toolbox tool
    app.tools.activate(TOOL_ID);
    s.offDoc = app.on('doc:activated', (d) => {
      if (this.session === s && d !== s.doc) this.cancel();
    });
    this.update();
    return done;
  }

  activate() {
    this.app.view?.setCursor('default');
  }

  deactivate() {
    // another tool was activated behind the session's back: nothing may stay half applied
    if (this.session && !this.ending) this.finish(null);
  }

  /** Escape. */
  cancel() {
    if (!this.session) return false;
    this.finish(null);
    return true;
  }

  /** Enter and the OK button: full-quality render when the shown one is not, then one history entry. */
  commit() {
    const s = this.session;
    if (!s) return false;
    if (s.applying) return true;
    s.applying = true;
    this.apply().catch((err) => {
      this.app.reportError(err, `${s.def.name} failed`);
      if (this.session === s) this.finish(null);
    });
    return true;
  }

  async apply() {
    const s = this.session, app = this.app;
    clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    while (s.busy) await s.busy; // a full-quality render is on its way: let it land first
    if (this.session !== s) return;
    const params = clone(s.params), key = JSON.stringify(params);
    let img = null;
    if (!(s.previewOn && s.shown.full && s.shown.key === key)) {
      const work = () => processed(s.edit, (x) => applyFilter(x, s.kind, params));
      img = s.edit.base.width * s.edit.base.height > SYNC_PIXELS ? await app.busy(`${s.def.name}…`, async () => work()) : work();
      if (this.session !== s) return;
    }
    s.edit.commit(s.def.name, img, { filter: { kind: s.kind, params: clone(params) } });
    s.committed = true;
    this.finish(params);
  }

  /** Ends the session: result is the committed params or null (cancel: the pixels are restored). */
  finish(result) {
    const s = this.session;
    if (!s) return;
    const app = this.app;
    this.session = null;
    clearTimeout(s.timer);
    cancelAnimationFrame(s.raf);
    if (!s.committed) s.edit.cancel();
    s.offDoc?.();
    s.panel?.remove();
    document.body.classList.remove('blur-gallery-active');
    if (s.panelsWereHidden) document.getElementById('app')?.classList.add('panels-hidden');
    if (s.doc.view) s.doc.view.hideAnts = s.hideAnts;
    this.ending = true;
    try {
      if (app.tools.active === this) app.tools.activate(app.tools.get(this.returnTo) ? this.returnTo : 'move');
    } finally {
      this.ending = false;
      app.tools.tools.delete(TOOL_ID);
    }
    app.commands.invalidate();
    app.view?.invalidate();
    s.resolve?.(result);
  }

  // ---- preview ------------------------------------------------------------------------------------------------------

  /** Something changed: redraw the overlay, sync the panel and refresh the preview on the next frame. */
  update({ form = true } = {}) {
    const s = this.session;
    if (!s) return;
    if (form) this.syncForms();
    this.app.view?.invalidate();
    if (!s.raf) s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (this.session === s) this.render();
    });
  }

  render() {
    const s = this.session;
    if (s.busy || s.applying) return;
    clearTimeout(s.timer);
    if (!s.previewOn) {
      s.edit.restore();
      s.shown = { key: null, full: false };
      return;
    }
    const key = JSON.stringify(s.params);
    try {
      if (!s.reduced) {
        if (s.shown.key !== key) {
          s.edit.show(processed(s.edit, (x) => applyFilter(x, s.kind, s.params)));
          s.shown = { key, full: true };
        }
        return;
      }
      if (s.shown.key !== key) {
        // quick look: the blur on the reduced copy, scaled back up
        const r = s.reduced;
        const img = { width: r.image.width, height: r.image.height, data: new Uint8ClampedArray(r.image.data) };
        applyFilter(img, s.kind, scaleBlurParams(s.kind, s.params, r.scale));
        r.small.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
        const uctx = r.up.getContext('2d', { willReadFrequently: true });
        uctx.globalCompositeOperation = 'copy';
        uctx.imageSmoothingQuality = 'medium';
        uctx.drawImage(r.small, 0, 0, r.up.width, r.up.height);
        s.edit.show(uctx.getImageData(0, 0, r.up.width, r.up.height));
        s.shown = { key, full: false };
      }
    } catch (err) {
      console.error(err);
      return;
    }
    // full quality once nothing is being dragged any more
    if (!s.shown.full && !s.drag) s.timer = setTimeout(() => this.settle(), SETTLE_MS);
  }

  /** Full-quality render after a reduced preview (under app.busy when the layer is large); a change made meanwhile starts over. */
  settle() {
    const s = this.session;
    if (!s || s.busy || s.applying || s.drag || !s.previewOn) return;
    const params = clone(s.params), key = JSON.stringify(params);
    if (s.shown.full && s.shown.key === key) return;
    const work = async () => processed(s.edit, (x) => applyFilter(x, s.kind, params));
    s.busy = (s.edit.base.width * s.edit.base.height > SYNC_PIXELS ? this.app.busy(`${s.def.name}…`, work) : work())
      .then((img) => {
        if (this.session !== s) return;
        if (JSON.stringify(s.params) === key && s.previewOn) {
          s.edit.show(img);
          s.shown = { key, full: true };
        }
      })
      .catch((err) => console.error(err))
      .finally(() => {
        s.busy = false;
        if (this.session === s && !s.applying) this.update({ form: false });
      });
  }

  // ---- geometry -----------------------------------------------------------------------------------------------------

  /** Document point of a fraction of the edited region. */
  toDoc(fx, fy) {
    const r = this.session.edit.rect;
    return { x: r.x + fx * r.width, y: r.y + fy * r.height };
  }
  toFrac(x, y) {
    const r = this.session.edit.rect;
    return { x: (x - r.x) / r.width, y: (y - r.y) / r.height };
  }
  screen(pt) {
    return this.view.toScreen(pt.x, pt.y);
  }
  pinScreen(pin) {
    return this.screen(this.toDoc(pin.x, pin.y));
  }
  get selectedPin() {
    const s = this.session;
    return s && s.kind !== 'path-blur' ? s.params.pins[s.sel.pin] ?? null : null;
  }
  get selectedPath() {
    const s = this.session;
    return s && s.kind === 'path-blur' ? s.params.paths[s.sel.path] ?? null : null;
  }

  /** Ellipse frame of an iris / spin pin in document px: centre, half axes and their unit vectors. */
  ellipse(pin) {
    const r = this.session.edit.rect, a = pin.rotation * DEG;
    const c = this.toDoc(pin.x, pin.y), cos = Math.cos(a), sin = Math.sin(a);
    const rx = pin.rx * r.width, ry = pin.ry * r.height;
    return { c, rx, ry, ux: cos, uy: sin, vx: -sin, vy: cos, at: (p, q) => ({ x: c.x + cos * rx * p - sin * ry * q, y: c.y + sin * rx * p + cos * ry * q }) };
  }

  /** Band frame of a tilt-shift pin in document px: centre, direction along the band, normal, distances. */
  band(pin) {
    const r = this.session.edit.rect, a = pin.rotation * DEG;
    return { c: this.toDoc(pin.x, pin.y), tx: Math.cos(a), ty: Math.sin(a), nx: -Math.sin(a), ny: Math.cos(a), focus: pin.focus * r.height, fade: pin.fade * r.height };
  }

  /** Screen polyline of a path and its control points. */
  pathScreen(path) {
    const pts = path.points.map((q) => this.toDoc(q.x, q.y));
    return { points: pts.map((q) => this.screen(q)), line: pathPolyline(pts).map((q) => this.screen(q)) };
  }

  /** Base, tip and unit direction (screen) of the speed arrow at end e (0 = start, 1 = end) of a path. */
  arrow(path, e, ps = this.pathScreen(path)) {
    const line = ps.line;
    if (line.length < 2) return null;
    const a = e ? line[line.length - 2] : line[0], b = e ? line[line.length - 1] : line[1];
    const len = dist(a, b) || 1;
    // the arrows point along the motion; the start arrow sits before the first point, the end arrow after the last
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, base = e ? b : a, sign = e ? 1 : -1;
    const reach = ARROW_BASE + path.endSpeeds[e] * ARROW_SCALE;
    return { base, tip: { x: base.x + ux * reach * sign, y: base.y + uy * reach * sign }, ux, uy, sign };
  }

  /**
   * Handles of the selected pin (screen positions): what a press at p grabs, nearest first in
   * priority order: handles of the selected pin, its ring, any pin, lines / path segments.
   */
  hit(p) {
    const s = this.session, at = { x: p.screenX, y: p.screenY };
    if (s.hidden) return null;
    if (s.kind === 'path-blur') return this.hitPath(at);
    const pins = s.params.pins, pin = this.selectedPin;
    if (pin) {
      const c = this.pinScreen(pin);
      if (ELLIPSE_KINDS.has(s.kind)) {
        const e = this.ellipse(pin);
        const handles = [];
        [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(([a, b], k) => {
          handles.push({ type: 'axis', k, at: this.screen(e.at(a, b)) });
          handles.push({ type: 'feather', k, at: this.screen(e.at(a * pin.feather, b * pin.feather)) });
        });
        if (s.kind === 'iris-blur') {
          const t = 2 ** (-1 / irisExponent(pin.roundness));
          handles.push({ type: 'round', at: this.screen(e.at(t, t)) });
        }
        let best = null;
        for (const h of handles) {
          const d = dist(h.at, at);
          if (d <= HIT && (!best || d < best.d)) best = { ...h, d };
        }
        // the pin itself wins over handles of a tiny ellipse that crowd it
        if (best && !(dist(c, at) <= HIT && best.type === 'feather')) return best;
      }
      if (s.kind === 'tilt-shift') {
        const b = this.band(pin);
        for (const sign of [1, -1]) {
          const h = this.screen({ x: b.c.x + b.nx * b.focus * sign, y: b.c.y + b.ny * b.focus * sign });
          if (dist(h, at) <= HIT && dist(c, at) > HIT) return { type: 'rotate', sign };
        }
      }
      if (Math.abs(dist(c, at) - RING) <= 7) return { type: 'ring' };
    }
    for (let i = pins.length - 1; i >= 0; i--) if (dist(this.pinScreen(pins[i]), at) <= HIT + 1) return { type: 'pin', i };
    if (pin && s.kind === 'tilt-shift') {
      // the lines: distance across the band, in screen px
      const b = this.band(pin), zoom = this.view.zoom;
      const across = Math.abs((p.x - b.c.x) * b.nx + (p.y - b.c.y) * b.ny);
      if (Math.abs(across - b.focus) * zoom <= 6) return { type: 'focus' };
      if (Math.abs(across - b.focus - b.fade) * zoom <= 6) return { type: 'fade' };
    }
    return null;
  }

  hitPath(at) {
    const s = this.session, paths = s.params.paths;
    const sel = this.selectedPath;
    if (sel) {
      const ps = this.pathScreen(sel);
      for (const e of [0, 1]) {
        const a = this.arrow(sel, e, ps);
        if (a && dist(a.tip, at) <= HIT) return { type: 'speed', path: s.sel.path, e };
      }
    }
    const screens = paths.map((path) => this.pathScreen(path));
    for (let i = paths.length - 1; i >= 0; i--) {
      for (let j = 0; j < screens[i].points.length; j++) if (dist(screens[i].points[j], at) <= HIT) return { type: 'point', path: i, j };
    }
    for (let i = paths.length - 1; i >= 0; i--) {
      const line = screens[i].line;
      for (let k = 0; k + 1 < line.length; k++) {
        if (segmentDistance(at, line[k], line[k + 1]).d <= 6) {
          // the control-point span this piece of the polyline belongs to (a spline has 16 pieces per span)
          const span = paths[i].points.length < 3 ? 0 : Math.min(paths[i].points.length - 2, Math.floor(k / ((line.length - 1) / (paths[i].points.length - 1))));
          return { type: 'segment', path: i, span };
        }
      }
    }
    return null;
  }

  // ---- pointer ------------------------------------------------------------------------------------------------------

  onPointerDown(p) {
    const s = this.session;
    if (!s || s.applying) return;
    const h = this.hit(p);
    const start = { x: p.x, y: p.y, sx: p.screenX, sy: p.screenY };
    if (s.kind === 'path-blur') return this.pathDown(p, h, start);
    const pins = s.params.pins;
    if (!h) {
      if (s.hidden) return;
      // a click on the image adds a pin with the selected pin's settings (or the kind's defaults) and drags it
      const f = this.toFrac(p.x, p.y);
      if (f.x < 0 || f.x > 1 || f.y < 0 || f.y > 1) return;
      const pin = { ...clone(this.selectedPin ?? FILTERS[s.kind].defaults.pins[0]), x: f.x, y: f.y };
      pins.push(pin);
      s.sel.pin = pins.length - 1;
      s.drag = { type: 'pin', start, pin, x0: pin.x, y0: pin.y };
      this.rebuildPinForm();
      return this.update();
    }
    if (h.type === 'pin') {
      if (s.sel.pin !== h.i) {
        s.sel.pin = h.i;
        this.rebuildPinForm();
      }
      const pin = pins[h.i];
      s.drag = { type: 'pin', start, pin, x0: pin.x, y0: pin.y };
      return this.update();
    }
    const pin = this.selectedPin;
    const c = this.pinScreen(pin);
    s.drag = { ...h, start, pin, before: clone(pin), angle: Math.atan2(p.screenY - c.y, p.screenX - c.x), turned: 0 };
  }

  onPointerMove(p, dragging) {
    const s = this.session;
    if (!s) return;
    if (!dragging || !s.drag) {
      const h = this.hit(p);
      s.hover = h;
      const inside = (() => {
        const f = this.toFrac(p.x, p.y);
        return f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1;
      })();
      this.view.setCursor(!h ? (inside && !s.hidden ? 'crosshair' : 'default') : h.type === 'pin' || h.type === 'point' ? 'move' : h.type === 'segment' ? 'copy' : 'pointer');
      return;
    }
    const d = s.drag, r = s.edit.rect;
    if (s.kind === 'path-blur') return this.pathMove(p, d);
    const pin = d.pin;
    switch (d.type) {
      case 'pin':
        pin.x = clamp(d.x0 + (p.x - d.start.x) / r.width, 0, 1);
        pin.y = clamp(d.y0 + (p.y - d.start.y) / r.height, 0, 1);
        break;
      case 'ring': {
        // turning clockwise raises the value; the angle is accumulated so several turns keep counting
        const c = this.pinScreen(pin);
        const a = Math.atan2(p.screenY - c.y, p.screenX - c.x);
        let da = a - d.angle;
        if (da > Math.PI) da -= 2 * Math.PI;
        else if (da < -Math.PI) da += 2 * Math.PI;
        d.angle = a;
        d.turned += da;
        const key = ringParam(s.kind);
        pin[key] = Math.round(clamp(d.before[key] + (d.turned / (2 * Math.PI)) * RING_TURN[key], ...PIN_RANGES[key]) * 10) / 10;
        break;
      }
      case 'axis': {
        // the handle follows the pointer: its distance is the radius, its direction the rotation (Shift keeps the rotation)
        const e = this.ellipse(d.before);
        const dx = p.x - e.c.x, dy = p.y - e.c.y;
        const horizontal = d.k % 2 === 0;
        const along = horizontal ? dx * e.ux + dy * e.uy : dx * e.vx + dy * e.vy;
        const len = Math.max(2, p.shift ? Math.abs(along) : Math.hypot(dx, dy));
        if (horizontal) pin.rx = clamp(len / r.width, ...PIN_RANGES.rx);
        else pin.ry = clamp(len / r.height, ...PIN_RANGES.ry);
        if (!p.shift && Math.hypot(dx, dy) > 2) {
          let rot = Math.atan2(dy, dx) / DEG - d.k * 90;
          rot = ((((rot + 180) % 360) + 360) % 360) - 180;
          pin.rotation = Math.round(rot * 10) / 10;
        }
        break;
      }
      case 'feather': {
        const e = this.ellipse(pin);
        const dx = p.x - e.c.x, dy = p.y - e.c.y;
        const f = d.k % 2 === 0 ? Math.abs(dx * e.ux + dy * e.uy) / e.rx : Math.abs(dx * e.vx + dy * e.vy) / e.ry;
        pin.feather = Math.round(clamp(f, 0, 1) * 100) / 100;
        break;
      }
      case 'round': {
        // the handle sits on the diagonal of the shape: half way out is a diamond, further out a rectangle
        const e = this.ellipse(pin);
        const dx = p.x - e.c.x, dy = p.y - e.c.y;
        const t = clamp(((dx * e.ux + dy * e.uy) / e.rx + (dx * e.vx + dy * e.vy) / e.ry) / 2, 0.5, 2 ** (-1 / 8));
        const n = Math.LN2 / Math.log(1 / t);
        pin.roundness = Math.round(clamp(n >= 2 ? ((n - 2) / 6) * 100 : (n - 2) * 100, -100, 100));
        break;
      }
      case 'rotate': {
        const b = this.band(pin);
        const dx = p.x - b.c.x, dy = p.y - b.c.y;
        if (Math.hypot(dx, dy) < 2) break;
        let rot = Math.atan2(dy * d.sign, dx * d.sign) / DEG - 90;
        if (p.shift) rot = Math.round(rot / 15) * 15;
        pin.rotation = Math.round((((((rot + 180) % 360) + 360) % 360) - 180) * 10) / 10;
        break;
      }
      case 'focus':
      case 'fade': {
        const b = this.band(pin);
        const across = Math.abs((p.x - b.c.x) * b.nx + (p.y - b.c.y) * b.ny);
        if (d.type === 'focus') pin.focus = Math.round(clamp(across / r.height, 0, 1) * 1000) / 1000;
        else pin.fade = Math.round(clamp((across - b.focus) / r.height, 0, 1) * 1000) / 1000;
        break;
      }
      default:
    }
    this.update();
  }

  onPointerUp() {
    const s = this.session;
    if (!s || !s.drag) return;
    const d = s.drag;
    s.drag = null;
    if (d.type === 'new-path') this.finishNewPath(d);
    this.update(); // nothing is held any more: the full-quality render may start
  }

  onDoubleClick() {}

  // ---- path blur pointer --------------------------------------------------------------------------------------------

  pathDown(p, h, start) {
    const s = this.session, paths = s.params.paths;
    if (!h) {
      if (s.hidden) return;
      const f = this.toFrac(p.x, p.y);
      if (f.x < 0 || f.x > 1 || f.y < 0 || f.y > 1) return;
      // dragging on the image draws a new path (a plain click makes a short horizontal one, see finishNewPath)
      const path = { points: [{ x: f.x, y: f.y }, { x: f.x, y: f.y }], endSpeeds: clone(this.selectedPath?.endSpeeds ?? FILTERS[s.kind].defaults.paths[0].endSpeeds) };
      s.drag = { type: 'new-path', start, path };
      return;
    }
    if (h.type === 'speed') {
      s.drag = { ...h, start };
      return;
    }
    let j = h.j;
    if (h.type === 'segment') {
      // a click on the path adds a point there, which the drag then moves
      const f = this.toFrac(p.x, p.y);
      j = h.span + 1;
      paths[h.path].points.splice(j, 0, { x: clamp(f.x, 0, 1), y: clamp(f.y, 0, 1) });
    }
    const changed = s.sel.path !== h.path;
    s.sel = { path: h.path, point: j };
    if (changed) this.rebuildPinForm();
    const point = paths[h.path].points[j];
    s.drag = { type: 'point', start, point, x0: point.x, y0: point.y };
    this.update();
  }

  pathMove(p, d) {
    const s = this.session, r = s.edit.rect;
    if (d.type === 'point') {
      d.point.x = clamp(d.x0 + (p.x - d.start.x) / r.width, 0, 1);
      d.point.y = clamp(d.y0 + (p.y - d.start.y) / r.height, 0, 1);
    } else if (d.type === 'new-path') {
      const f = this.toFrac(p.x, p.y);
      d.path.points[1] = { x: clamp(f.x, 0, 1), y: clamp(f.y, 0, 1) };
      if (!d.added && Math.hypot(p.screenX - d.start.sx, p.screenY - d.start.sy) > 4) {
        d.added = true;
        s.params.paths.push(d.path);
        s.sel = { path: s.params.paths.length - 1, point: 1 };
        this.rebuildPinForm();
      }
      if (!d.added) return;
    } else if (d.type === 'speed') {
      const path = s.params.paths[d.path], a = this.arrow(path, d.e);
      if (!a) return;
      const along = ((p.screenX - a.base.x) * a.ux + (p.screenY - a.base.y) * a.uy) * a.sign;
      path.endSpeeds[d.e] = Math.round(clamp((along - ARROW_BASE) / ARROW_SCALE, 0, 500));
    }
    this.update();
  }

  finishNewPath(d) {
    const s = this.session;
    if (d.added) return;
    // a click without a drag: a horizontal path of 30 % of the width, centred on the click and kept inside the image
    const c = d.path.points[0], half = 0.15;
    const x = clamp(c.x, half, 1 - half);
    d.path.points = [{ x: x - half, y: c.y }, { x: x + half, y: c.y }];
    s.params.paths.push(d.path);
    s.sel = { path: s.params.paths.length - 1, point: -1 };
    this.rebuildPinForm();
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------

  onKeyDown(e) {
    const s = this.session;
    if (!s) return false;
    if (e.ctrlKey || e.metaKey) return false; // zoom shortcuts and the like go through the (guarded) command table
    const inPanel = e.target?.closest?.('.bg-panel');
    if (e.key === 'Enter') {
      // Enter on a focused action button of the panel (reached with Tab) presses it, anywhere else it applies
      if (inPanel && e.target.tagName === 'BUTTON' && e.target.dataset.action) e.target.click();
      else this.commit();
      return true;
    }
    if (e.key === 'Escape') return this.cancel();
    if (e.key === 'Tab') {
      // Tab would hide the panels (and with them this session's controls): inside the panel it moves the focus instead
      if (inPanel) {
        const list = [...inPanel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter((x) => x.offsetParent !== null);
        const i = list.indexOf(e.target);
        if (list.length) list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
      }
      return true;
    }
    if (inPanel && e.target.tagName === 'SELECT') return false;
    if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
    else if (/^Arrow/.test(e.key)) this.nudge(e.key, e.shiftKey ? 10 : 1);
    else if (e.key === 'p' || e.key === 'P') this.setPreview(!s.previewOn);
    else if (e.key === 'h' || e.key === 'H') {
      s.hidden = !s.hidden;
      this.app.view?.invalidate();
    }
    // every other plain key is swallowed: tool shortcuts must not end the session
    return true;
  }

  removeSelected() {
    const s = this.session;
    if (!s || s.drag) return;
    if (s.kind === 'path-blur') {
      const path = this.selectedPath;
      if (!path) return;
      if (s.sel.point >= 0 && path.points.length > 2) {
        path.points.splice(s.sel.point, 1);
        s.sel.point = -1;
      } else {
        s.params.paths.splice(s.sel.path, 1);
        s.sel = { path: s.params.paths.length ? Math.min(s.sel.path, s.params.paths.length - 1) : -1, point: -1 };
      }
    } else {
      const pins = s.params.pins;
      if (!pins[s.sel.pin]) return;
      pins.splice(s.sel.pin, 1);
      s.sel.pin = pins.length ? Math.min(s.sel.pin, pins.length - 1) : -1;
    }
    this.rebuildPinForm();
    this.update();
  }

  nudge(key, px) {
    const s = this.session, r = s.edit.rect;
    const target = s.kind === 'path-blur' ? (this.selectedPath?.points[s.sel.point] ? [this.selectedPath.points[s.sel.point]] : this.selectedPath?.points ?? []) : this.selectedPin ? [this.selectedPin] : [];
    const dx = key === 'ArrowLeft' ? -px : key === 'ArrowRight' ? px : 0, dy = key === 'ArrowUp' ? -px : key === 'ArrowDown' ? px : 0;
    for (const q of target) {
      q.x = clamp(q.x + dx / r.width, 0, 1);
      q.y = clamp(q.y + dy / r.height, 0, 1);
    }
    if (target.length) this.update();
  }

  setPreview(on) {
    const s = this.session;
    s.previewOn = !!on;
    const box = s.panel?.querySelector('[data-key="__preview"]');
    if (box) box.checked = s.previewOn;
    this.update({ form: false });
  }

  reset() {
    const s = this.session;
    s.params = normalise(s.kind, null);
    s.sel = s.kind === 'path-blur' ? { path: 0, point: -1 } : { pin: 0 };
    this.rebuildForms();
    this.update();
  }

  // ---- overlay ------------------------------------------------------------------------------------------------------

  drawOverlay(ctx) {
    const s = this.session;
    if (!s || s.hidden || s.doc !== this.app.doc) return;
    const accent = '#4f9dff';
    if (s.kind === 'path-blur') return this.drawPaths(ctx, accent);
    const pins = s.params.pins, sel = this.selectedPin;
    if (sel) {
      const c = this.pinScreen(sel);
      if (ELLIPSE_KINDS.has(s.kind)) {
        const e = this.ellipse(sel);
        const n = s.kind === 'iris-blur' ? irisExponent(sel.roundness) : 2;
        const shape = (scale) => {
          ctx.beginPath();
          for (let k = 0; k <= 96; k++) {
            const t = (k / 96) * Math.PI * 2, cs = Math.cos(t), sn = Math.sin(t);
            const q = this.screen(e.at(Math.sign(cs) * Math.abs(cs) ** (2 / n) * scale, Math.sign(sn) * Math.abs(sn) ** (2 / n) * scale));
            if (k) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
          }
          ctx.closePath();
        };
        shape(1);
        outline(ctx);
        if (sel.feather > 0.01 && sel.feather < 0.99) {
          shape(sel.feather);
          outline(ctx, { dash: [4, 4], width: 1 });
        }
        for (const [a, b] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          dot(ctx, this.screen(e.at(a, b)), 4, '#ffffff');
          dot(ctx, this.screen(e.at(a * sel.feather, b * sel.feather)), 3.5, 'rgba(255, 255, 255, 0.85)');
        }
        if (s.kind === 'iris-blur') {
          const t = 2 ** (-1 / n);
          square(ctx, this.screen(e.at(t, t)), 4, '#ffffff');
        }
      }
      if (s.kind === 'tilt-shift') {
        const b = this.band(sel);
        const far = (Math.max(s.doc.width, s.doc.height) + Math.max(this.view.cssWidth, this.view.cssHeight) / Math.max(0.01, this.view.zoom)) * 2;
        const line = (offset) => {
          const m = { x: b.c.x + b.nx * offset, y: b.c.y + b.ny * offset };
          const p0 = this.screen({ x: m.x - b.tx * far, y: m.y - b.ty * far }), p1 = this.screen({ x: m.x + b.tx * far, y: m.y + b.ty * far });
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
        };
        for (const sign of [1, -1]) {
          line(b.focus * sign);
          outline(ctx);
          line((b.focus + b.fade) * sign);
          outline(ctx, { dash: [6, 5], width: 1 });
          dot(ctx, this.screen({ x: b.c.x + b.nx * b.focus * sign, y: b.c.y + b.ny * b.focus * sign }), 4, '#ffffff');
        }
      }
      // the ring: a full faint circle and a bright arc for the value, clockwise from 12 o'clock
      const key = ringParam(s.kind), part = clamp(sel[key] / RING_TURN[key], 0, 1);
      ctx.beginPath();
      ctx.arc(c.x, c.y, RING, 0, Math.PI * 2);
      outline(ctx, { width: 3, color: 'rgba(255, 255, 255, 0.45)' });
      if (part > 0) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, RING, -Math.PI / 2, -Math.PI / 2 + part * Math.PI * 2);
        ctx.save();
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
      }
    }
    pins.forEach((pin, i) => {
      const c = this.pinScreen(pin);
      dot(ctx, c, 7, i === s.sel.pin ? accent : 'rgba(255, 255, 255, 0.9)');
      dot(ctx, c, 2.5, i === s.sel.pin ? '#ffffff' : '#222222', 'transparent');
    });
  }

  drawPaths(ctx, accent) {
    const s = this.session;
    s.params.paths.forEach((path, i) => {
      const ps = this.pathScreen(path), selected = i === s.sel.path;
      ctx.beginPath();
      ps.line.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      outline(ctx, { width: selected ? 2 : 1.25, color: selected ? accent : '#ffffff' });
      if (selected) {
        for (const e of [0, 1]) {
          const a = this.arrow(path, e, ps);
          if (!a) continue;
          // the arrow: a red shaft from the end point to the knob, with a head pointing along the motion
          ctx.beginPath();
          ctx.moveTo(a.base.x, a.base.y);
          ctx.lineTo(a.tip.x, a.tip.y);
          const hx = e ? a.tip.x : a.base.x - a.ux * 6, hy = e ? a.tip.y : a.base.y - a.uy * 6;
          ctx.moveTo(hx - a.ux * 9 - a.uy * 5, hy - a.uy * 9 + a.ux * 5);
          ctx.lineTo(hx, hy);
          ctx.lineTo(hx - a.ux * 9 + a.uy * 5, hy - a.uy * 9 - a.ux * 5);
          outline(ctx, { width: 2, color: '#ff5a4f' });
          dot(ctx, a.tip, 4.5, '#ff5a4f');
        }
      }
      ps.points.forEach((q, j) => {
        const end = j === 0 || j === ps.points.length - 1;
        if (end) dot(ctx, q, 5, selected && j === s.sel.point ? accent : '#ffffff');
        else square(ctx, q, 4, selected && j === s.sel.point ? accent : '#ffffff');
      });
    });
  }

  // ---- options bar and panel ----------------------------------------------------------------------------------------

  renderOptions(bar) {
    const s = this.session;
    if (!s) return;
    // the hint is in the panel and the status bar; the bar carries the two ways out, like Free Transform
    const mk = (label, iconName, action, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${primary ? ' primary' : ''}`;
      b.dataset.action = action;
      b.innerHTML = `${icon(iconName)}<span>${label}</span>`;
      b.addEventListener('click', () => (action === 'ok' ? this.commit() : this.cancel()));
      bar.appendChild(b);
    };
    mk('Cancel', 'close', 'cancel', false);
    mk('OK', 'check', 'ok', true);
  }

  buildPanel() {
    const s = this.session;
    const el = document.createElement('aside');
    el.className = 'bg-panel';
    el.dataset.kind = s.kind;
    el.setAttribute('aria-label', s.def.name);
    const effects = LENS_KINDS.has(s.kind) ? 'Effects' : 'Motion Effects';
    el.innerHTML = `
      <header class="bg-head"><span class="bg-title"></span><button type="button" class="btn small" data-action="reset" title="Back to the default pin and settings">Reset</button></header>
      <div class="bg-tabs" role="tablist">
        <button type="button" role="tab" data-tab="blur" aria-selected="true">Blur</button>
        <button type="button" role="tab" data-tab="effects" aria-selected="false">${effects}</button>
        <button type="button" role="tab" data-tab="noise" aria-selected="false">Noise</button>
      </div>
      <div class="bg-body">
        <section data-pane="blur">
          <div class="bg-pins"><span class="bg-pin-label"></span><button type="button" class="btn small" data-action="remove">${icon('trash')}<span>Remove</span></button></div>
          <div class="bg-pin-form"></div>
          <div class="bg-global-form"></div>
          <p class="bg-hint muted"></p>
        </section>
        <section data-pane="effects" hidden></section>
        <section data-pane="noise" hidden></section>
      </div>
      <footer class="bg-foot">
        <label class="checkbox" title="Show the blur on the image (P)"><input type="checkbox" data-key="__preview" checked>Preview</label>
        <span class="bg-spacer"></span>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="button" class="btn primary" data-action="ok">OK</button>
      </footer>`;
    el.querySelector('.bg-title').textContent = s.def.name;
    el.querySelector('.bg-hint').textContent = HINTS[s.kind];
    el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        s.tab = tab.dataset.tab;
        for (const b of el.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === tab));
        for (const pane of el.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== s.tab;
        tab.blur(); // keys go on to the session (Enter applies)
        return;
      }
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action || this.session !== s) return;
      e.target.closest('button')?.blur();
      if (action === 'ok') this.commit();
      else if (action === 'cancel') this.cancel();
      else if (action === 'remove') this.removeSelected();
      else if (action === 'reset') this.reset();
    });
    el.querySelector('[data-key="__preview"]').addEventListener('change', (e) => this.setPreview(e.target.checked));
    // Enter or Escape in a number field confirms the field and hands the keys back to the canvas
    // (so the next Enter applies and Delete removes the pin instead of editing the field)
    el.addEventListener('keydown', (e) => {
      if (e.target.tagName !== 'INPUT' || e.target.type !== 'number' || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      e.stopPropagation();
      e.target.blur();
      this.view?.canvas.focus({ preventScroll: true });
    });
    s.panel = el;
    s.forms = {};
    this.rebuildForms();
    // in the third column of #main, where the panel dock (hidden by the body class) normally sits
    document.getElementById('main').appendChild(el);
  }

  /** A form over `fields` that reads and writes `target()` (the params, the selected pin or the selected path). */
  makeForm(fields, target, host) {
    const s = this.session;
    const read = () => {
      const t = target(), values = {};
      for (const f of fields) {
        const v = t ? getPath(t, f.key) : undefined;
        values[f.key] = f.type === 'checkbox' ? !!v : f.type === 'segment' ? v : Math.round((Number(v) || 0) * (f.scale ?? 1) * 100) / 100;
      }
      return values;
    };
    const form = buildForm(fields, {
      values: read(),
      onChange: (values, key) => {
        const t = target(), f = fields.find((x) => x.key === key);
        if (!t || !f || this.session !== s) return;
        setPath(t, key, f.type === 'slider' ? values[key] / (f.scale ?? 1) : values[key]);
        // the two ends of the light range cannot cross
        if (key === 'bokeh.lightRange.0' && t.bokeh.lightRange[1] < t.bokeh.lightRange[0]) t.bokeh.lightRange[1] = t.bokeh.lightRange[0];
        if (key === 'bokeh.lightRange.1' && t.bokeh.lightRange[0] > t.bokeh.lightRange[1]) t.bokeh.lightRange[0] = t.bokeh.lightRange[1];
        this.update();
      },
    });
    host.replaceChildren(form.element);
    return { form, fields, read };
  }

  rebuildForms() {
    const s = this.session, el = s.panel;
    const params = () => s.params;
    s.forms.global = GLOBAL_FIELDS[s.kind] ? this.makeForm(GLOBAL_FIELDS[s.kind], params, el.querySelector('.bg-global-form')) : null;
    s.forms.effects = this.makeForm(LENS_KINDS.has(s.kind) ? BOKEH_FIELDS : STROBE_FIELDS, params, el.querySelector('[data-pane="effects"]'));
    s.forms.noise = this.makeForm(NOISE_FIELDS, params, el.querySelector('[data-pane="noise"]'));
    this.rebuildPinForm();
  }

  /** The Blur tab's sliders follow the selected pin (or path); without one they are disabled. */
  rebuildPinForm() {
    const s = this.session, el = s.panel;
    if (!el) return;
    const path = s.kind === 'path-blur';
    const target = () => (path ? this.selectedPath : this.selectedPin);
    s.forms.pin = this.makeForm(PIN_FIELDS[s.kind], target, el.querySelector('.bg-pin-form'));
    const has = !!target(), count = path ? s.params.paths.length : s.params.pins.length, index = path ? s.sel.path : s.sel.pin;
    const what = path ? 'Path' : 'Pin';
    el.querySelector('.bg-pin-label').textContent = has ? `${what} ${index + 1} of ${count}` : `No ${what.toLowerCase()}: click the image to add one`;
    el.querySelector('[data-action="remove"]').disabled = !has;
    for (const input of el.querySelectorAll('.bg-pin-form input')) input.disabled = !has;
  }

  /** Brings the panel's values in line with the params (after a drag on the canvas). */
  syncForms() {
    const s = this.session;
    if (!s?.forms) return;
    for (const entry of Object.values(s.forms)) {
      if (!entry) continue;
      const values = entry.read();
      for (const f of entry.fields) {
        // a field being typed into keeps what the user typed
        if (entry.form.values[f.key] !== values[f.key]) entry.form.set(f.key, values[f.key], { silent: true });
      }
    }
  }
}

// ---- installation -----------------------------------------------------------------------------------------------------

export function install(app) {
  const tool = new BlurGalleryTool(app);
  for (const kind of BLUR_GALLERY_KINDS) app.filterEditor?.register(kind, { open: (k, opts) => tool.open(k, opts ?? {}) });

  // While a session is open it owns the document like a modal dialog would: commands that could change
  // the document (or the tool, the layer, the tab) are refused with a hint instead of running half way.
  const run = app.commands.run.bind(app.commands);
  let warned = 0;
  app.commands.run = (id, arg, source) => {
    if (tool.session && !tool.ending && !SAFE_COMMANDS.test(id)) {
      if (source !== 'api' && performance.now() - warned > 2500) {
        warned = performance.now();
        app.dialogs.toast(`Finish ${tool.session.def.name} first: Enter applies it, Esc cancels`, { timeout: 2200 });
      }
      return undefined;
    }
    return run(id, arg, source);
  };

  // closing the window asks about unsaved documents: the preview must be off the layer before anything is saved
  bridge.on?.('before-close', () => tool.cancel());

  /** For other modules and tests: the running session's state (params are a copy). */
  app.blurGallery = {
    get active() {
      return !!tool.session;
    },
    get kind() {
      return tool.session?.kind ?? null;
    },
    get params() {
      return tool.session ? clone(tool.session.params) : null;
    },
    get selection() {
      return tool.session ? { ...tool.session.sel } : null;
    },
    /** Document rect the pins' fractions refer to. */
    get rect() {
      return tool.session ? { ...tool.session.edit.rect } : null;
    },
    /** What the preview currently shows: { full } (false while a reduced preview is up). */
    get shown() {
      return tool.session ? { full: tool.session.shown.full, current: tool.session.shown.key === JSON.stringify(tool.session.params) } : null;
    },
    apply: () => tool.commit(),
    cancel: () => tool.cancel(),
  };
}
