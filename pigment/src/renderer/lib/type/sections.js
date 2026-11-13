// Type panel sections (ARCHITECTURE.md "0.4 features", L.14; E26). The Character panel, the Paragraph panel and the
// Properties text / paragraph sections render the registered sections after their own controls; a section with
// `replaces` takes the place of the built-in control of that id (rows: family, style, size, leading, kerning,
// tracking, scale, baseline, color, toggles, language, align, indents, spacing, hyphenate). Later packages
// (OpenType, fonts, international type) plug in here without editing the panels. Skeleton file; no package edits it.

const PANELS = ['character', 'paragraph'];
const sections = { character: [], paragraph: [] };
let app = null;

/** Lets the registry announce changes on app ('type:sections-changed'); app.js calls it once. */
export function attachSections(a) {
  app = a;
}

/**
 * Registers (or replaces, same id) a section:
 * { id, order, replaces?, test?(ctx) -> boolean, render(ctx: { app, attrs, apply(patch), unit }) -> HTMLElement }.
 */
export function registerTypeSection(panel, spec) {
  if (!PANELS.includes(panel)) throw new Error(`registerTypeSection: unknown panel "${panel}" (character or paragraph)`);
  if (!spec?.id || typeof spec.render !== 'function') throw new Error('registerTypeSection needs an id and render()');
  const list = sections[panel];
  const i = list.findIndex((s) => s.id === spec.id);
  if (i >= 0) list.splice(i, 1);
  list.push({ order: 0, ...spec });
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  app?.emit('type:sections-changed', { panel });
}

/** The sections of a panel in order. */
export function typeSections(panel) {
  return (sections[panel] ?? []).slice();
}
