// Canvas capture (ARCHITECTURE.md "0.4 features", I.3; E14): canvas input while a dialog is open or a panel tool
// is armed. Whoever needs the next canvas clicks (an adjustment eyedropper, an on-image tool, dragging a layer
// style's shadow, picking a guide) pushes a handler; CanvasView routes pointer events to the top handler before the
// active tool (Space and middle-button panning still come first). Skeleton file; no package edits it.
//
//   app.canvasCapture.push({ id, cursor?, down(p, view), move?(p, view, dragging), up?(p, view),
//                            overlay?(ctx, view), key?(e) -> boolean }) -> release()
//   app.canvasCapture.top() -> handler | null
//
// `p` is the view's normalised pointer (document x / y, screenX / screenY, modifiers). `overlay` draws in screen CSS
// pixels after the tool's overlay. `key` sees keydown events first while its handler is on top; true consumes one.

export class CanvasCapture {
  constructor(app) {
    this.app = app;
    this.stack = [];
    this.onKey = (e) => {
      const h = this.top();
      if (!h?.key) return;
      let used = false;
      try {
        used = !!h.key(e);
      } catch (err) {
        console.warn('canvas capture key handler failed', err);
      }
      if (used) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
  }

  /** Puts a handler on top; returns the function that removes it (safe to call twice). */
  push(handler) {
    if (!handler || typeof handler.down !== 'function') throw new Error('canvasCapture.push: a handler needs down(p, view)');
    this.stack.push(handler);
    if (this.stack.length === 1) window.addEventListener('keydown', this.onKey, true);
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.stack.lastIndexOf(handler);
      if (i >= 0) this.stack.splice(i, 1);
      if (!this.stack.length) window.removeEventListener('keydown', this.onKey, true);
      this.changed();
    };
  }

  /** The handler that receives canvas input now, or null (the active tool does). */
  top() {
    return this.stack[this.stack.length - 1] ?? null;
  }

  changed() {
    const view = this.app.view;
    if (!view) return;
    const h = this.top();
    view.setCursor(h ? h.cursor ?? 'crosshair' : this.app.tools?.active?.cursorStyle);
    view.invalidate();
  }
}

/** Creates app.canvasCapture (app.js start() calls it before MODULES). */
export function installCanvasCapture(app) {
  app.canvasCapture = new CanvasCapture(app);
  return app.canvasCapture;
}
