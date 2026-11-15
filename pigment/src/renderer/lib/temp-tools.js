// Temporary and spring-loaded tools (conventions-shortcuts-fields, ARCHITECTURE.md "0.4 features", package 16; L.12).
//
// While a modifier is held the canvas routes pointer input to a temporary tool: `view.tempTool` with
// `view.tempToolVia` ('ctrl' | 'alt' | 'space'), which canvas-view.js reads (it sets `p.temporary`, so the modifier
// that summoned the tool does not turn snapping off):
//   - Ctrl (Cmd on macOS) held: the Move tool, unless the active tool uses Ctrl itself (claimsModifier, L.12) or is a
//     navigation tool;
//   - Alt held with a painting tool whose Alt is free (Brush, Pencil, Color Replacement, Gradient, Mixer-like tools):
//     the Eyedropper, which then sets the foreground colour;
//   - Ctrl+Space / Alt+Space: the Zoom tool zooming in / out (plain Space stays 0.3's hand panning, view.spaceHeld).
// A temporary tool is a thin adapter over the real tool: it forwards the pointer events with the summoning modifier
// taken out, so the Move tool does not read the held Ctrl as "auto-select" and the Eyedropper does not read Alt as
// "background colour".
//
// Holding a tool's key (spring-loaded tools, settings.conventions.springLoaded): the key switches to the tool as a
// short press does, and releasing it after a hold (or after using the tool while it was held) switches back.
//
// The temporary tool never outlives its gesture: a release in the middle of a drag waits for the pointer to come up.
import { claimsModifier } from './tool-traits.js';

/** Tools whose Alt-click is free for the Eyedropper (Photoshop: the painting tools that do not use Alt themselves). */
const ALT_EYEDROPPER = new Set(['brush', 'pencil', 'color-replace', 'gradient']);
/**
 * Toolbox slots whose tools spring to the Move tool on Ctrl (Photoshop: the selection, painting and retouching
 * tools). The Move, Crop, navigation, pen, type and shape slots keep Ctrl, and so do the on-canvas workspaces (Free
 * Transform distorts with Ctrl), which are not in these slots.
 */
const CTRL_MOVE_SLOTS = new Set(['marquee', 'lasso', 'wand', 'eyedropper', 'heal', 'brush', 'clone', 'history', 'eraser', 'fill', 'blur', 'retouch']);
/** How long a tool key is held before its release switches back (ms). */
export const HOLD_MS = 450;

/** Wraps a tool so that its pointer events arrive with `strip` applied. */
function adapter(tool, { strip, cursor } = {}) {
  const fix = (p) => (p && strip ? strip(p) : p);
  const call = (name) => (p, ...rest) => tool[name]?.(fix(p), ...rest);
  return {
    id: tool.id,
    name: tool.name,
    temporary: true,
    tool,
    get cursorStyle() {
      return cursor ?? tool.cursorStyle;
    },
    onPointerDown: call('onPointerDown'),
    onPointerMove: call('onPointerMove'),
    onPointerUp: call('onPointerUp'),
    onPointerCancel: call('onPointerCancel'),
    onDoubleClick: call('onDoubleClick'),
    onContextMenu: call('onContextMenu'),
    drawOverlay: (...a) => tool.drawOverlay?.(...a),
  };
}

export class TempTools {
  constructor(app) {
    this.app = app;
    this.current = null; // { via, view, adapter }
    this.pointerDown = false;
    this.pendingEnd = false;
    this.spring = null; // { key, from, to, at, used }
    this.onPointerDownDoc = (e) => {
      if (e.target?.closest?.('.canvas-view')) {
        this.pointerDown = true;
        if (this.spring) this.spring.used = true;
      }
    };
    this.onPointerUpDoc = () => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      // the canvas's own pointerup ran first (it bubbles up to here): the gesture is over
      if (this.pendingEnd) this.end();
    };
    document.addEventListener('pointerdown', this.onPointerDownDoc, true);
    document.addEventListener('pointerup', this.onPointerUpDoc);
    document.addEventListener('pointercancel', this.onPointerUpDoc);
    app.on?.('tool:changed', () => {
      if (this.current && !this.pointerDown) this.end();
    });
  }

  get enabled() {
    return this.app.settings?.conventions?.springLoaded !== false;
  }

  /** Puts a temporary tool on the current view. */
  begin(via, tool, opts) {
    const view = this.app.view;
    if (!view || !tool) return false;
    if (this.current) this.clear();
    const a = adapter(tool, opts);
    view.tempTool = a;
    view.tempToolVia = via;
    this.current = { via, view, adapter: a };
    view.setCursor(a.cursorStyle);
    return true;
  }

  /** Ends the temporary tool now, or when the drag in progress ends. */
  end(via = null) {
    if (!this.current) return;
    if (via && this.current.via !== via) return;
    if (this.pointerDown) {
      this.pendingEnd = true;
      return;
    }
    this.clear();
  }

  clear() {
    const c = this.current;
    this.current = null;
    this.pendingEnd = false;
    if (!c) return;
    if (c.view.tempTool === c.adapter) {
      c.view.tempTool = null;
      c.view.tempToolVia = null;
    }
    if (c.view === this.app.view) {
      if (c.view.spaceHeld) c.view.setCursor('grab');
      else this.app.tools?.updateCursor();
    }
  }

  /** Alt or Ctrl pressed on its own: the temporary Eyedropper or Move tool, where the active tool allows it. */
  modifierDown(event) {
    if (!this.enabled || event.repeat || this.pointerDown || !this.app.doc || !this.app.view) return false;
    const active = this.app.tools?.active;
    if (!active) return false;
    // an on-canvas workspace, Free Transform or an armed canvas capture keeps its own modifiers
    if (this.app.sessions?.list?.().length || this.app.canvasCapture?.top?.()) return false;
    const isCtrl = event.key === 'Control' || event.key === 'Meta';
    const isAlt = event.key === 'Alt';
    if (isCtrl && !event.altKey && !event.shiftKey) {
      const slot = this.app.tools.slots?.find((s) => s.tools.includes(active.id))?.id;
      if (!CTRL_MOVE_SLOTS.has(slot) || claimsModifier(active, 'ctrl')) return false;
      const move = this.app.tools.get('move');
      return this.begin('ctrl', move, { strip: (p) => ({ ...p, ctrl: false, meta: false }) });
    }
    if (isAlt && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (!ALT_EYEDROPPER.has(active.id) || claimsModifier(active, 'alt')) return false;
      const dropper = this.app.tools.get('eyedropper');
      return this.begin('alt', dropper, { strip: (p) => ({ ...p, alt: false }) });
    }
    return false;
  }

  modifierUp(event) {
    if (event.key === 'Control' || event.key === 'Meta') this.end('ctrl');
    else if (event.key === 'Alt') this.end('alt');
  }

  /** Any other key while a modifier tool is up: a shortcut is being typed, so the temporary tool goes. */
  otherKey(event) {
    if (!this.current || this.pointerDown) return;
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    if (this.current.via === 'ctrl' || this.current.via === 'alt') this.clear();
  }

  /** Ctrl+Space (zoom in) or Alt+Space (zoom out). Returns true when it took the key. */
  zoomDown(event) {
    if (!this.app.doc || !this.app.view) return false;
    const zoomIn = (event.ctrlKey || event.metaKey) && !event.altKey;
    const zoomOut = event.altKey && !event.ctrlKey && !event.metaKey;
    if (!zoomIn && !zoomOut) return false;
    if (event.repeat && this.current?.via === 'space') return true;
    const zoom = this.app.tools?.get('zoom');
    if (!zoom) return false;
    // the Zoom tool zooms out on Alt-click (in when its direction is "out"): give it the Alt that means what was asked
    const wantOut = zoomOut;
    this.begin('space', zoom, {
      cursor: wantOut ? 'zoom-out' : 'zoom-in',
      strip: (p) => ({ ...p, ctrl: false, meta: false, alt: (zoom.opt?.('direction') === 'out') !== wantOut }),
    });
    return true;
  }

  spaceUp() {
    this.end('space');
  }

  // ---- spring-loaded tool keys --------------------------------------------------------------------------------

  /** A tool key went down and switched from `from` to `to`. */
  toolKeyDown(event, from, to) {
    if (!this.enabled || !from || from === to) {
      this.spring = null;
      return;
    }
    this.spring = { key: event.key.toLowerCase(), code: event.code, from, to, at: performance.now(), used: this.pointerDown };
  }

  /** The key came up: after a hold, or after the tool was used meanwhile, the previous tool comes back. */
  toolKeyUp(event) {
    const s = this.spring;
    if (!s) return false;
    if (event.key.toLowerCase() !== s.key && event.code !== s.code) return false;
    this.spring = null;
    const held = performance.now() - s.at >= HOLD_MS;
    if (!(held || s.used)) return false;
    const tools = this.app.tools;
    if (tools?.active?.id !== s.to || !tools.get(s.from)) return false;
    const back = () => tools.active?.id === s.to && tools.activate(s.from);
    // a drag still running with the spring-loaded tool finishes with it first
    if (this.pointerDown) {
      const once = () => {
        document.removeEventListener('pointerup', once);
        setTimeout(back, 0);
      };
      document.addEventListener('pointerup', once);
    } else back();
    return true;
  }

  /** Focus left the window: nothing stays held. */
  reset() {
    this.spring = null;
    this.pointerDown = false;
    this.clear();
  }
}
