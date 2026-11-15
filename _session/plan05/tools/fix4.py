import json, sys
P = []
def r(a, b): P.append((a, b))
r("""  cancel(): boolean;            // Escape mid-gesture
  key?(e: KeyboardEvent): boolean;
}
// paint.js after the skeleton: StrokeTool's constructor sets this.gesture = new PaintGesture(this), and
onPointerDown(p) { this.gesture.down(p) }  onPointerMove(p, d) { this.gesture.move(p, d) }  onPointerUp(p) { this.gesture.up(p) }""",
"""  contextDown(p): boolean;      // a right-button press: true takes the drag (S3.3); stub false
  cancel(): boolean;            // Escape mid-gesture
  key?(e: KeyboardEvent): boolean;
}
// paint.js after the skeleton: StrokeTool's constructor sets this.gesture = new PaintGesture(this), and
onPointerDown(p) { this.gesture.down(p) }  onPointerMove(p, d) { this.gesture.move(p, d) }  onPointerUp(p) { this.gesture.up(p) }
onContextMenu(p) { return this.gesture.contextDown(p) }""")
r("| E38 | Paint-context keys | `keymap.js PAINT_KEYS`, `shortcuts.js`, `app.keymap.resolveKey` (S13.4) | brush-painting-behaviours, brush-engine-core | shortcuts-editor edits them |",
  "| E38 | Paint-context keys | `keymap.js PAINT_KEYS`, `shortcuts.js`, `app.keymap.resolveKey` (S13.4) | brush-painting-behaviours, brush-engine-core, shortcuts-editor (edits them) | retouch-tools-depth, brush-tips-mixer |")
json.dump(P, open(sys.argv[1], 'w'))
