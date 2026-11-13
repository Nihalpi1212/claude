// Tool traits (ARCHITECTURE.md "0.4 features", L.12; E29): what other features need to know about the active tool.
// A tool may declare `paints?: boolean` and `claimsModifiers?: Set<'ctrl' | 'alt' | 'space'>`; until each owner
// does, the fallback tables below (by tool id) answer. Skeleton file; no package edits it.
//
// conventions' temporary tools do not spring-load on a modifier the active tool claims; finish-layer-menu's opacity
// digits act only while !paints(app.tools.active).

/** Tools that put paint on pixels (0.3 ids). */
const PAINTING = new Set([
  'brush', 'pencil', 'color-replace',
  'eraser', 'eraser-bg', 'eraser-magic',
  'clone', 'pattern-stamp', 'history-brush',
  'gradient', 'bucket',
  'dodge', 'burn', 'sponge', 'blur', 'sharpen', 'smudge',
]);

/** Modifiers a tool uses itself (0.3 ids). */
const CLAIMS = new Map([
  // type tools: Ctrl shows the box transform and moves the text
  ...['type-horizontal', 'type-vertical'].map((id) => [id, new Set(['ctrl'])]),
  // pen, path and shape tools: Ctrl = direct selection, Alt = convert point
  ...['pen-tool', 'pen-free', 'pen-add', 'pen-delete', 'pen-convert', 'path-selection', 'direct-selection', 'shape-rect', 'shape-rrect', 'shape-ellipse', 'shape-polygon', 'shape-line', 'shape-custom', 'shape-triangle'].map((id) => [id, new Set(['ctrl', 'alt'])]),
  // the Move tool: Ctrl toggles auto-select
  ['move', new Set(['ctrl'])],
]);

/** True when the tool paints pixels (its own `paints` flag, else the fallback table). */
export function paints(tool) {
  if (!tool) return false;
  if (typeof tool.paints === 'boolean') return tool.paints;
  return PAINTING.has(tool.id);
}

/** True when the tool uses the modifier itself ('ctrl' | 'alt' | 'space'). */
export function claimsModifier(tool, mod) {
  if (!tool) return false;
  if (tool.claimsModifiers instanceof Set) return tool.claimsModifiers.has(mod);
  return CLAIMS.get(tool.id)?.has(mod) ?? false;
}
