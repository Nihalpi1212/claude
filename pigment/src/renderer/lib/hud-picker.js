// The HUD colour picker (ARCHITECTURE.md "0.5 features", S7.1, review decision 2; color-picker-swatches, package 11).
// brush-painting-behaviours' gesture (Alt+Shift+right-drag; Ctrl+Alt+Cmd+drag on macOS) opens
// app.colorPicker.hud({ at, tool, initial }) and forwards every move and the release; this session draws the HUD, sets
// the foreground live through app.setColors as the drag moves (no history entry, as the Color panel), restores the
// initial colour on cancel(), adds the colour to the recent colours on up(), and resolves `done` with the final
// ColorValue (null when cancelled).
//
// The HUD is a fixed element over the window, placed so that the press lands on the current colour in its square
// (settings.colorUI.hud: Hue Strip or Hue Wheel, small, medium or large). The state machine is lib/color-picker-model.js
// HudController (Node-tested); this file adds the drawing.
import * as M from './color-picker-model.js';
import { drawHueSquare, drawHueStrip, drawHueRing } from './panels/color-views.js';

const colorValueOf = (hex) => ({ hex, rgb: M.rgbOfHex(hex), book: null, space: 'hsb' });

/** The client (window) position of a pointer sample: its event's, else the view's screen point. */
function clientOf(p, tool) {
  if (Number.isFinite(p?.original?.clientX)) return { x: p.original.clientX, y: p.original.clientY };
  if (Number.isFinite(p?.clientX)) return { x: p.clientX, y: p.clientY };
  const r = tool?.view?.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  return { x: (p?.screenX ?? 0) + r.left, y: (p?.screenY ?? 0) + r.top };
}

/** The DOM view of a HudController: a canvas redrawn on each change. */
function hudView(model, at) {
  const root = document.createElement('div');
  root.className = 'hud-picker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'HUD colour picker');
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(model.width * dpr);
  canvas.height = Math.round(model.height * dpr);
  canvas.style.width = `${model.width}px`;
  canvas.style.height = `${model.height}px`;
  const chip = document.createElement('div');
  chip.className = 'hud-picker-chip';
  root.append(canvas, chip);
  // the press point lands on the current colour; the panel stays inside the window (then it is offset)
  const a = model.anchor();
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.max(4, Math.min(vw - model.width - 4, at.x - a.x));
  const top = Math.max(4, Math.min(vh - model.height - 28, at.y - a.y));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  document.body.appendChild(root);
  return {
    origin: { x: left, y: top },
    root,
    update(m, hex) {
      // a few gradients: cheap enough to draw whole on every move
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, m.width, m.height);
      if (m.layout === 'strip') drawHueStrip(ctx, m.strip.x, m.strip.y, m.strip.width, m.strip.height);
      else drawHueRing(ctx, m.center.x, m.center.y, m.ring.inner, m.ring.outer);
      const q = m.square;
      drawHueSquare(ctx, q.x, q.y, q.size, m.hsv.h);
      const p = m.anchor();
      ctx.lineWidth = 2;
      ctx.strokeStyle = m.hsv.v > 0.6 && m.hsv.s < 0.4 ? '#000' : '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      const h = m.hueMarker();
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      if (m.layout === 'strip') ctx.rect(m.strip.x - 2, h.y - 2, m.strip.width + 4, 4);
      else ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      chip.style.background = hex;
      chip.textContent = hex;
      root.dataset.color = hex;
      root.dataset.zone = m.zone;
    },
    destroy() {
      root.remove();
    },
  };
}

/** A HUD session (S7.1) for app.colorPicker.hud({ at, tool, initial }). */
export function createHudSession(app, { at = { x: 0, y: 0 }, tool = null, initial } = {}) {
  const start = M.hexOfRgb(M.rgbOfHex(typeof initial === 'string' ? initial : initial?.hex ?? app.settings.foreground));
  const style = M.hudStyle(app.settings.colorUI?.hud);
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let view = null;
  const host = {
    setForeground: (hex) => app.setColors({ foreground: hex }),
    remember: (hex) => app.saveSettingsSoon({ recentColors: M.addRecentColor(app.settings.recentColors, hex) }),
    done: (hex) => resolve(hex ? colorValueOf(hex) : null),
  };
  const ctl = new M.HudController({ initial: start, layout: style.layout, size: style.size, host });
  try {
    view = hudView(ctl.model, at);
    ctl.view = view;
    view.update(ctl.model, ctl.hex);
  } catch (err) {
    console.warn('The HUD colour picker could not be drawn', err);
  }
  const local = (p) => {
    const c = clientOf(p, tool);
    const o = view?.origin ?? { x: at.x - ctl.anchor.x, y: at.y - ctl.anchor.y };
    return [c.x - o.x, c.y - o.y];
  };
  // Escape while the session runs without a gesture forwarding it (a session opened by a script)
  return {
    model: ctl.model,
    get color() {
      return ctl.hex;
    },
    get element() {
      return view?.root ?? null;
    },
    move(p) {
      ctl.move(...local(p));
    },
    up(p) {
      if (p) ctl.up(...local(p));
      else ctl.up();
    },
    cancel() {
      ctl.cancel();
    },
    done,
  };
}
