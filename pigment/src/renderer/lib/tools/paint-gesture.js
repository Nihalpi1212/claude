// Paint gestures (ARCHITECTURE.md "0.5 features", S3.1; brush-painting-behaviours). Every StrokeTool (paint.js, the
// DabTool family and the stamps of retouch.js, the Adjustment Brush) routes its pointer events through
// `this.gesture`, which turns them into the tool's 0.4 handlers (strokeDown / strokeMove / strokeUp) and adds:
//   - Shift-click: a straight line from the end of the tool's last stroke in this document (one stroke, one history
//     entry, DabTools included);
//   - Shift-drag: the stroke is held to the horizontal or the vertical, whichever way it first moved (Shift pressed
//     mid-stroke holds it from there on);
//   - held ` (tilde): the Brush and the Pencil erase with their own brush (strokeDown(p, { erase: true }));
//   - the pen's eraser end (p.eraser): the stroke is the Eraser tool's, with the Eraser's brush, for that stroke;
//   - the brush-resize HUD: Alt+right-drag on Windows and Linux, Ctrl+Alt+drag on macOS (horizontal: size; vertical:
//     hardness, or opacity, settings.painting.hud.vertical);
//   - the HUD colour picker: Alt+Shift+right-drag on Windows and Linux, Ctrl+Alt+Cmd+drag on macOS. The gesture opens
//     app.colorPicker.hud() (color-picker-swatches' session, S7.1), forwards every move and the release, and cancels it
//     on Escape; the session draws and sets the colour (review decision 2).
// claims(p) answers true for exactly the two HUD presses, so canvas-view.js hands them to the tool past a temporary
// tool (S3.3: Alt's Eyedropper, Ctrl's Move tool).
//
// Node-safe at import (the pure parts, pressGesture, AxisLock and hudValues, are Node-tested); the HUD's drawing is
// lib/brush-hud.js'.
import { drawResizeHud } from '../brush-hud.js';

/** S15: brush-painting-behaviours has landed. */
const REAL = true;

/** How far (screen px) a Shift-drag moves before its axis is chosen. */
export const AXIS_THRESHOLD = 4;
/** Screen px of vertical HUD movement that span hardness (or opacity) 0 to 100 %. */
export const HUD_VERTICAL_SPAN = 200;

/** The keys painting reads while they are held (paint-keys.js keeps them up to date). */
export const paintKeyState = { tilde: false, capsLock: false, shift: false };

/**
 * Which HUD a press starts: 'resize' (the brush-resize HUD), 'color' (the HUD colour picker) or null (a normal press).
 * Windows and Linux: Alt+right button, with Shift for the colour picker. macOS: Ctrl+Alt with the primary button, with
 * Cmd for the colour picker. A pen's side button arrives as the right button (S2.5), so it works the same way.
 */
export function pressGesture(p, { mac = false } = {}) {
  if (!p) return null;
  if (mac) {
    if ((p.button === 0 || p.button === undefined) && p.ctrl && p.alt) return p.meta ? 'color' : 'resize';
    return null;
  }
  if (p.button === 2 && p.alt && !p.ctrl && !p.meta) return p.shift ? 'color' : 'resize';
  return null;
}

/**
 * The Shift constraint of a drag: until the pointer has moved `threshold` document px from the anchor it stays on the
 * anchor; then it keeps to the axis it moved along most (x: horizontal, y: vertical).
 */
export class AxisLock {
  constructor(anchor, { threshold = AXIS_THRESHOLD } = {}) {
    this.anchor = { x: anchor.x, y: anchor.y };
    this.threshold = threshold;
    this.axis = null;
  }
  apply(p) {
    const dx = p.x - this.anchor.x, dy = p.y - this.anchor.y;
    if (!this.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < this.threshold) return { ...p, x: this.anchor.x, y: this.anchor.y };
      this.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    }
    return this.axis === 'x' ? { ...p, y: this.anchor.y } : { ...p, x: this.anchor.x };
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The tool values a HUD drag gives: `start` { size, hardness?, opacity? } at the press, `dx` / `dy` the pointer's
 * screen movement since, `zoom` the view's. Dragging right by n screen px grows the diameter by 2n screen px (the
 * circle's edge follows the pointer); dragging up raises hardness (or opacity), HUD_VERTICAL_SPAN px for the full range.
 */
export function hudValues(start, dx, dy, { zoom = 1, maxSize = 5000, minSize = 1, vertical = 'hardness', minOpacity = 0.01 } = {}) {
  const out = {};
  const size = start.size + (2 * dx) / Math.max(1e-6, zoom);
  out.size = Math.round(clamp(size, minSize, maxSize));
  const key = vertical === 'opacity' ? 'opacity' : 'hardness';
  if (Number.isFinite(start[key])) {
    const v = start[key] - dy / HUD_VERTICAL_SPAN;
    out[key] = Math.round(clamp(v, key === 'opacity' ? minOpacity : 0, 1) * 100) / 100;
  }
  return out;
}

const optionOf = (tool, key) => tool?.options?.find((o) => o.key === key) ?? null;

export class PaintGesture {
  /** S15: brush-painting-behaviours has landed when this is true. */
  static real = REAL;
  /** macOS gestures (Ctrl+Alt): paint-keys.js sets it from the host's platform; tests may set it. */
  static mac = false;

  constructor(tool) {
    this.tool = tool;
    this.target = tool; // the tool whose stroke handlers this press drives (the Eraser for a pen's eraser end)
    this.hud = null; // { kind: 'resize' | 'color', ... } while a HUD drag runs
    this.lock = null; // AxisLock while Shift holds the stroke
    this.sent = null; // the last point given to the stroke (after the constraint)
    this.lines = new WeakMap(); // document -> the end of this tool's last stroke there
    this.pressing = false;
  }

  get app() {
    return this.tool.app;
  }

  /** A press the gesture takes from a temporary tool (canvas-view.js asks while view.tempTool is set, S3.3). */
  claims(p) {
    return pressGesture(p, { mac: PaintGesture.mac }) !== null;
  }

  /** The end point of this tool's last stroke in `doc` (Shift-click draws the line from it), or null. */
  lastPoint(doc = this.tool.doc) {
    return doc ? this.lines.get(doc) ?? null : null;
  }

  down(p) {
    const kind = pressGesture(p, { mac: PaintGesture.mac });
    if (kind && p.button !== 2) return this.beginHud(kind, p);
    this.pressing = true;
    this.target = this.strokeToolFor(p);
    const opts = this.target === this.tool && paintKeyState.tilde && this.tool.tildeErases ? { erase: true } : {};
    this.lock = null;
    const last = p.shift && !p.alt ? this.lastPoint() : null;
    if (last) {
      // Shift-click: one stroke from the last end point to here
      this.target.strokeDown({ ...p, x: last.x, y: last.y, shift: false }, opts);
      this.straighten();
      this.target.strokeMove(p, true);
      this.lock = new AxisLock(p, { threshold: this.threshold() });
    } else {
      this.target.strokeDown(p, opts);
      if (p.shift && !p.alt) {
        this.lock = new AxisLock(p, { threshold: this.threshold() });
        this.straighten();
      }
    }
    this.sent = { x: p.x, y: p.y };
  }

  move(p, dragging) {
    if (this.hud) {
      if (dragging) this.moveHud(p);
      return;
    }
    if (!dragging || !this.pressing) {
      this.tool.strokeMove(p, dragging);
      return;
    }
    const q = this.constrain(p);
    this.target.strokeMove(q, true);
    this.sent = { x: q.x, y: q.y };
  }

  up(p) {
    if (this.hud) return this.endHud(p);
    const wasPressing = this.pressing;
    this.pressing = false;
    const target = this.target;
    this.target = this.tool;
    const q = wasPressing && p && Number.isFinite(p.x) ? this.constrain(p) : p;
    this.lock = null;
    target.strokeUp(q);
    // the next Shift-click starts here (not after an Alt-click, which samples a colour or sets a source)
    const doc = this.tool.doc;
    if (wasPressing && doc && q && !q.cancelled && !q.alt && Number.isFinite(q.x)) this.lines.set(doc, { x: q.x, y: q.y });
  }

  /** A right-button press: true takes the drag (moves and the release then come here, S3.3). */
  contextDown(p) {
    const kind = pressGesture(p, { mac: PaintGesture.mac });
    if (!kind || p.button !== 2) return false;
    this.beginHud(kind, p);
    return true;
  }

  /** Escape mid-gesture: true when the gesture consumed it. */
  cancel() {
    if (!this.hud) return false;
    const hud = this.hud;
    this.hud = null;
    if (hud.kind === 'resize') this.applyTool(hud.start);
    else hud.session?.cancel?.();
    this.tool.view?.invalidate();
    return true;
  }

  /** Keys while the tool is active (shortcuts.js asks the tool first): Escape ends a HUD. */
  key(e) {
    if (e.key === 'Escape' && this.hud) return this.cancel();
    return false;
  }

  /** Draws the resize HUD; false when there is none (the brush cursor draws then). */
  drawOverlay(ctx, view) {
    if (this.hud?.kind !== 'resize') return false;
    drawResizeHud(ctx, view, this.tool, this.hud);
    return true;
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  /** The pen's eraser end strokes with the Eraser tool; anything else with this tool. */
  strokeToolFor(p) {
    if (!p?.eraser || this.tool.id === 'eraser') return this.tool;
    const eraser = this.app.tools?.get?.('eraser');
    return eraser && typeof eraser.strokeDown === 'function' ? eraser : this.tool;
  }

  threshold() {
    return AXIS_THRESHOLD / Math.max(1e-6, this.tool.view?.zoom ?? 1);
  }

  /** A straight stroke places its dabs on the line itself: smoothing would bend or shorten it. */
  straighten() {
    const s = this.target.stroke?.s;
    if (s && typeof s === 'object') s.smoothing = 0;
  }

  constrain(p) {
    if (!p?.shift) {
      this.lock = null;
      return p;
    }
    // Shift pressed mid-stroke: held from the point the stroke reached
    if (!this.lock) {
      this.lock = new AxisLock(this.sent ?? p, { threshold: this.threshold() });
      this.straighten();
    }
    return this.lock.apply(p);
  }

  beginHud(kind, p) {
    this.lock = null;
    this.pressing = false;
    const tool = this.tool;
    const app = this.app;
    if (kind === 'color') {
      const at = { x: p.original?.clientX ?? p.screenX ?? 0, y: p.original?.clientY ?? p.screenY ?? 0 };
      let session = null;
      try {
        session = app.colorPicker?.hud?.({ at, tool, initial: app.settings?.foreground }) ?? null;
      } catch (err) {
        console.warn('HUD colour picker failed', err);
      }
      this.hud = { kind, session };
      session?.done?.then?.(() => {
        if (this.hud?.session === session) this.hud = null;
      }, () => {});
      return;
    }
    const vertical = app.settings?.painting?.hud?.vertical === 'opacity' ? 'opacity' : 'hardness';
    const start = { size: Number(tool.opt('size')) || 1 };
    if (optionOf(tool, vertical)) start[vertical] = Number(tool.opt(vertical));
    const sizeOpt = optionOf(tool, 'size');
    this.hud = {
      kind,
      vertical,
      start,
      values: { ...start },
      at: { x: p.x, y: p.y },
      screen: { x: p.screenX ?? 0, y: p.screenY ?? 0 },
      maxSize: Math.min(5000, sizeOpt?.max ?? 5000),
      minSize: Math.max(1, sizeOpt?.min ?? 1),
    };
    tool.view?.invalidate();
  }

  moveHud(p) {
    const hud = this.hud;
    if (hud.kind === 'color') {
      hud.session?.move?.(p);
      return;
    }
    const v = hudValues(hud.start, (p.screenX ?? 0) - hud.screen.x, (p.screenY ?? 0) - hud.screen.y, {
      zoom: this.tool.view?.zoom ?? 1,
      maxSize: hud.maxSize,
      minSize: hud.minSize,
      vertical: hud.vertical,
      minOpacity: optionOf(this.tool, 'opacity')?.min ?? 0.01,
    });
    hud.values = v;
    this.applyTool(v);
    this.tool.view?.invalidate();
  }

  endHud(p) {
    const hud = this.hud;
    this.hud = null;
    if (hud.kind === 'color') {
      if (p?.cancelled) hud.session?.cancel?.();
      else hud.session?.up?.(p);
    } else if (p?.cancelled) this.applyTool(hud.start);
    this.tool.view?.invalidate();
  }

  /** Writes HUD values to the tool's options (the options bar and the cursor follow, as with [ and ]). */
  applyTool(values) {
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(value) || !optionOf(this.tool, key)) continue;
      if (this.tool.opt(key) !== value) this.tool.setOpt(key, value);
    }
  }
}
