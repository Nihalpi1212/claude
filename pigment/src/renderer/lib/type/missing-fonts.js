// Missing fonts (type-fonts, ARCHITECTURE.md "0.5 features", package 12; S11.1 missing(doc), S12.6 open hooks).
//
// When a file opens (File > Open, Open Recent, a drop; not New, Duplicate, Revert, Place or smart object contents),
// an open hook asks the catalog which fonts of its text Pigment does not have (by PostScript name first, then
// family). An interactive open reports them once, in a notice whose button opens Manage Missing Fonts; Batch and the
// other non-interactive opens write a line to their log instead, with no dialog. The text keeps drawing with a
// substitute until the fonts are replaced.
//
// Type > Manage Missing Fonts… lists each missing font with a replacement family and style (the bundled default
// family, in the missing font's weight and slant, unless chosen otherwise) and replaces them in one history entry
// ("Resolve Missing Fonts"); Type > Replace All Missing Fonts replaces every one with the default family at once
// ("Replace All Missing Fonts"). Both record their replacements for action playback.
import { registerOpenHook } from '../documents.js';
import { editTypeLayers } from './target.js';
import * as M from './model.js';
import { textLayersOf, parsePostScriptStyle, nearestStyle } from './font-library.js';
import { createFamilyField, fillStyleSelect } from './font-picker.js';

const familyKey = (f) => String(f ?? '').trim().toLowerCase();
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
/** The key of a missing font (its PostScript name, else its family), as `catalog.missing` groups them. */
export const missingKey = (m) => (m.postScriptName ? `ps:${m.postScriptName}` : `f:${familyKey(m.family)}`);
const styleKeyOfRun = (st) => (st.postScriptName ? `ps:${st.postScriptName}` : `f:${familyKey(st.fontFamily)}`);

/** "Myriad Pro (MyriadPro-Bold)" */
export const missingLabel = (m) => (m.postScriptName && m.postScriptName !== m.family ? `${m.family} (${m.postScriptName})` : m.family);

/** The notice of an opened file with missing fonts. */
export function missingNotice(missing, name = '') {
  const list = missing.map(missingLabel);
  const shown = list.slice(0, 4).join(', ') + (list.length > 4 ? `, and ${list.length - 4} more` : '');
  return `${name ? `${name}: ` : ''}${missing.length === 1 ? 'a font is' : `${missing.length} fonts are`} missing: ${shown}. The text uses a substitute until it is replaced.`;
}

/**
 * The default replacement of a missing font: the default family's style nearest to the missing face's weight and
 * slant ({ fontFamily, style: key }).
 */
export function defaultReplacement(catalog, m) {
  const fam = catalog.defaultFamily ?? 'Arial';
  const { weight, italic } = m.postScriptName ? parsePostScriptStyle(m.postScriptName) : { weight: 400, italic: false };
  const entry = catalog.family(fam);
  const s = entry && !entry.synthetic ? nearestStyle(entry.styles, weight, italic) : null;
  return { fontFamily: fam, style: s?.postScriptName ?? `${weight === 700 ? 700 : 400}${italic ? 'i' : ''}` };
}

/**
 * Replaces missing fonts in a document's text: `replacements` [{ family, postScriptName, to: { fontFamily, style? } }]
 * (style a style key of the new family; without one each run keeps its weight and slant). One history entry with
 * `label`. Returns the number of layers changed.
 */
export function replaceFonts(app, catalog, doc, replacements, { label = 'Resolve Missing Fonts' } = {}) {
  if (!doc || !replacements?.length) return 0;
  const map = new Map(replacements.filter((r) => r?.to?.fontFamily).map((r) => [missingKey(r), r.to]));
  const patchFor = (resolved) => {
    const to = map.get(styleKeyOfRun(resolved)) ?? (resolved.postScriptName ? map.get(`f:${familyKey(resolved.fontFamily)}`) : null);
    if (!to) return null;
    if (to.style) return catalog.stylePatch(to.fontFamily, to.style);
    return { fontFamily: to.fontFamily, postScriptName: undefined, axes: undefined };
  };
  const layers = textLayersOf(doc).filter((l) => !l.locked?.all && M.runsIn(l.content, 0, Math.max(1, l.content.text.length)).some((r) => patchFor(r.style)) || (!l.content.text.length && l.content.runs?.[0] && patchFor(M.resolveChar(l.content.runs[0].style))));
  if (!layers.length) return 0;
  const prevDoc = app.doc;
  // editTypeLayers works on the active document
  if (app.doc !== doc) app.docs?.activate?.(doc);
  editTypeLayers(app, layers, (l) => ({ content: M.mapChar(l.content, (style, resolved) => {
    const p = patchFor(resolved);
    return p ? { ...style, ...p } : style;
  }) }), { label });
  if (prevDoc && prevDoc !== doc && app.docs?.list?.().includes(prevDoc)) app.docs.activate?.(prevDoc);
  return layers.length;
}

/** The Manage Missing Fonts dialog: resolves with the replacements chosen, or null when cancelled. */
export async function manageDialog(app, catalog, doc, missing) {
  const preview = { start() {}, stop() {}, family: null };
  const body = document.createElement('div');
  body.className = 'mf-body';
  const intro = document.createElement('p');
  intro.className = 'mf-intro';
  intro.textContent = missing.length === 1 ? 'This font is missing. Choose the font that replaces it.' : 'These fonts are missing. Choose the fonts that replace them.';
  body.appendChild(intro);
  const table = document.createElement('div');
  table.className = 'mf-table';
  table.setAttribute('role', 'table');
  const rows = [];
  for (const m of missing) {
    const row = document.createElement('div');
    row.className = 'mf-row';
    row.dataset.missing = missingKey(m);
    const name = document.createElement('div');
    name.className = 'mf-name';
    name.textContent = missingLabel(m);
    const count = document.createElement('div');
    count.className = 'mf-count';
    count.textContent = `${m.layers.length} ${m.layers.length === 1 ? 'layer' : 'layers'}`;
    const def = defaultReplacement(catalog, m);
    const choice = { fontFamily: def.fontFamily, style: def.style };
    const style = document.createElement('select');
    style.className = 'select mf-style';
    style.setAttribute('aria-label', `Replacement style for ${missingLabel(m)}`);
    const family = createFamilyField(app, catalog, preview, {
      value: choice.fontFamily,
      ariaLabel: `Replacement for ${missingLabel(m)}`,
      onChange: (f) => {
        const patch = catalog.stylePatch(f, choice.style);
        choice.fontFamily = f;
        choice.style = catalog.styleKey({ fontFamily: f, fontWeight: patch.fontWeight, fontItalic: patch.fontItalic, postScriptName: patch.postScriptName });
        fillStyleSelect(style, catalog, f, choice.style);
      },
    });
    family.element.classList.add('mf-family');
    fillStyleSelect(style, catalog, choice.fontFamily, choice.style);
    style.addEventListener('change', () => (choice.style = style.value));
    row.append(name, count, family.element, style);
    table.appendChild(row);
    rows.push({ m, choice });
  }
  body.appendChild(table);
  const ok = await app.dialogs.open({
    title: 'Manage Missing Fonts',
    content: body,
    width: 620,
    className: 'missing-fonts-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', value: true, primary: true }],
  });
  if (!ok) return null;
  return rows.map(({ m, choice }) => ({ family: m.family, postScriptName: m.postScriptName, to: { fontFamily: choice.fontFamily, style: choice.style } }));
}

export function installMissingFonts(app, catalog) {
  const ready = () => Promise.race([catalog.ready(), timeout(3000)]);
  // S12.6: after a file opens; an interactive open reports once (a notice with a button), Batch writes its log
  registerOpenHook(async (doc, info) => {
    await ready();
    const missing = catalog.missing(doc);
    if (!missing.length) return;
    const name = info.path ? String(info.path).split(/[\\/]/).pop() : doc.name ?? '';
    if (!info.interactive) {
      info.notice(missingNotice(missing, name));
      return;
    }
    if (doc.missingFontsReported) return;
    doc.missingFontsReported = true;
    app.dialogs.toast(missingNotice(missing), { kind: 'info', timeout: 12000, action: { label: 'Manage…', run: () => app.commands.run('type:manage-missing-fonts', undefined, 'ui') } });
  }, { order: 600 });

  const enabled = () => !!app.doc && textLayersOf(app.doc).length > 0;
  app.commands.register('type:manage-missing-fonts', {
    label: 'Manage Missing Fonts…',
    enabled,
    changesDocument: true,
    // arg { replacements } replaces without the dialog (action playback); from the menu the dialog asks
    run: async (arg, ctx) => {
      const doc = app.doc;
      await ready();
      let replacements = Array.isArray(arg?.replacements) ? arg.replacements : null;
      if (!replacements) {
        const missing = catalog.missing(doc);
        if (!missing.length) {
          app.dialogs.toast('No fonts are missing in this document.', { timeout: 3000 });
          return null;
        }
        replacements = await manageDialog(app, catalog, doc, missing);
        if (!replacements) return null;
        ctx?.setReplayArg?.({ replacements });
      }
      const n = replaceFonts(app, catalog, doc, replacements, { label: 'Resolve Missing Fonts' });
      return { layers: n };
    },
  });
  app.commands.register('type:replace-missing-fonts', {
    label: 'Replace All Missing Fonts',
    enabled,
    changesDocument: true,
    run: async () => {
      const doc = app.doc;
      await ready();
      const missing = catalog.missing(doc);
      if (!missing.length) {
        app.dialogs.toast('No fonts are missing in this document.', { timeout: 3000 });
        return { layers: 0 };
      }
      const fam = catalog.defaultFamily ?? 'Arial';
      const n = replaceFonts(app, catalog, doc, missing.map((m) => ({ family: m.family, postScriptName: m.postScriptName, to: { fontFamily: fam } })), { label: 'Replace All Missing Fonts' });
      app.dialogs.toast(`Replaced ${missing.length === 1 ? 'the missing font' : `${missing.length} missing fonts`} with ${fam}.`, { timeout: 3000 });
      return { layers: n };
    },
  });
}
