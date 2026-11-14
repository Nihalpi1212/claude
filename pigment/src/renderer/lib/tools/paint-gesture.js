// Paint gestures (ARCHITECTURE.md "0.5 features", S3.1). brush-painting-behaviours' file; this is the skeleton's stub:
// a pass-through to the tool's 0.4 handlers (strokeDown / strokeMove / strokeUp), claiming no press and no right-button
// drag. Every StrokeTool (paint.js, the DabTool family and stamps of retouch.js, the Adjustment Brush) routes its
// pointer events through `this.gesture`, so the package adds Shift-click lines, the axis lock, the tilde erase, the
// pen's eraser end, the resize HUD and the HUD colour picker gesture here without touching the tools.
export class PaintGesture {
  /** S15: brush-painting-behaviours has landed when this is true. */
  static real = false;

  constructor(tool) {
    this.tool = tool;
  }

  /** A press the gesture takes from a temporary tool (canvas-view.js asks while view.tempTool is set, S3.3). */
  claims(p) {
    void p;
    return false;
  }

  down(p) {
    this.tool.strokeDown(p);
  }

  move(p, dragging) {
    this.tool.strokeMove(p, dragging);
  }

  up(p) {
    this.tool.strokeUp(p);
  }

  /** A right-button press: true takes the drag (moves and the release then come here, S3.3). */
  contextDown(p) {
    void p;
    return false;
  }

  /** Escape mid-gesture: true when the gesture consumed it. */
  cancel() {
    return false;
  }
}
