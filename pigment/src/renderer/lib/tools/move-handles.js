// The Move tool's transform controls (ARCHITECTURE.md "0.5 features", package 15, S12.2, S12.5): Show Transform
// Controls draws the box of app.transformTool.previewBox(doc), and a drag on a handle continues as Free Transform
// through app.transformTool.start({ mode: 'free', grab: { pointer, handle } }). Owned by move-tool-depth, which imports
// this file from tools/move.js.
//
// Skeleton stub (S15): no handles yet (MOVE_FEATURES.handles false); the Move tool behaves as in 0.4.

export const MOVE_FEATURES = Object.freeze({ handles: false });
