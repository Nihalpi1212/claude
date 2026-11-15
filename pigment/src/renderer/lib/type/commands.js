// Type menu commands (0.5, type-menu-commands; ARCHITECTURE.md "0.5 features", package 13, S11.3–S11.5, S13.3).
//
// This MODULES entry replaces the skeleton's stub at the same path. It installs the two text render stages (Warp
// Text, lib/type/warp-text.js; the anti-aliasing methods, lib/type/antialias.js), the Horizontal and Vertical Type
// Mask tools (lib/tools/type-mask.js) and registers the Type menu's commands:
//   type:anti-alias (method)          one "Anti-Alias" entry; the Type > Anti-Alias radios, the options bar and the
//                                     Character panel's select all run it (S11.4)
//   type:warp-text (warp | none)      the Warp Text dialog without an argument; one "Warp Text" entry
//   type:create-work-path             the glyph outlines (warp and transform included) as the Work Path
//   type:convert-to-shape             the text layer becomes a shape layer of its outlines
//   type:convert-text-kind ('point' | 'paragraph', else the other kind)
//   type:update-all                   lays every text layer out again with the fonts there are now
//   type:paste-lorem-ipsum            placeholder text at the caret while text is edited
//   type:toggle-orientation           the options bar's button: horizontal <-> vertical text and Type tool
// Commands that need glyph outlines (Create Work Path, Convert to Shape) say so when the text is drawn by the
// Canvas fallback engine, which has none (S11.3).
import { registerIcons } from '../icons.js';
import { typeSession, textTargets } from '../tools/text.js';
import { installTypeMaskTools } from '../tools/type-mask.js';
import { applyTypeOptions } from './target.js';
import { setOrientation } from '../text-path.js';
import { recordPaths } from '../tools/vector.js';
import { structural, setLayerProps } from '../layer-ops.js';
import { ShapeLayer, textExtensionFor, copyCanvas } from '../document.js';
import { formDialog } from '../form.js';
import * as M from './model.js';
import { fontsChanged, stageGeometry, layoutText } from './api.js';
import { outlinePath } from './outlines.js';
import { installAntiAlias } from './antialias.js';
import { installWarpStage, dialogFields, dialogValues, warpFromValues } from './warp-text.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

export const LOREM_IPSUM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';
const LOREM_SENTENCES = LOREM_IPSUM.split(/(?<=\.)\s+/);

const NO_OUTLINES = 'has no glyph outlines: its font is drawn by the browser. Choose a font Pigment can read (a bundled font, an installed font Pigment may read, or one added with Type > Add Fonts…) and try again.';

registerIcons({
  'type-mask': '<path d="M5 6V4h14v2" stroke-dasharray="2 2"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M9 20h6" stroke-dasharray="2 2"/>',
  'type-mask-vertical': '<path d="M6 5h2v14H6z" stroke-dasharray="2 2"/><path d="M12 4h8M16 4v16" stroke-dasharray="2 2"/>',
});

const hex6 = (c) => rgbaToHex(parseColor(c ?? '#000000')).slice(0, 7);
const ANTI_ALIAS = new Set(M.ANTI_ALIAS_METHODS);
const ANTI_ALIAS_LABEL = 'Anti-Alias';

export async function install(app) {
  // warp.js imports the Free Transform tool (not Node-safe): read its presets here, at start-up
  const { presetControls } = await import('../warp.js');
  installAntiAlias(app);
  installWarpStage(presetControls);
  installTypeMaskTools(app);

  const doc = () => app.doc;
  const session = () => typeSession(app);
  /** Ends a type session first: these commands act on whole layers (a Type Mask session becomes its selection). */
  const commitTyping = () => session()?.commitSession();
  const isStraight = (l) => !textExtensionFor(l);
  const targets = () => textTargets(doc());
  const toast = (msg, kind = 'error') => app.dialogs.toast(msg, { kind, timeout: 3200 });
  const activeText = () => {
    const d = doc();
    const s = session();
    if (s?.session?.doc === d) return s.session.layer;
    return d?.active?.type === 'text' && !d.active.locked.all ? d.active : null;
  };
  const hasText = () => !!session() || targets().length > 0;

  /** The warp each target has after `warp` (null removes it), as typeOptions. */
  const withWarp = (l, warp) => {
    const next = { ...l.typeOptions };
    if (warp) next.warp = warp;
    else delete next.warp;
    return M.normalizeTypeOptions(next);
  };

  /** Applies typeOptions to layers as one entry (lib/type/target.js editTypeLayers through applyTypeOptions). */
  const setWarp = (layers, warp, label = 'Warp Text') => {
    const same = layers.every((l) => JSON.stringify(l.typeOptions?.warp ?? null) === JSON.stringify(warp ?? null));
    if (same) return false;
    if (layers.length === 1) setLayerProps(app, layers[0], { typeOptions: withWarp(layers[0], warp) }, label);
    else {
      const d = doc();
      const before = layers.map((l) => l.typeOptions);
      const after = layers.map((l) => withWarp(l, warp));
      const apply = (list) => layers.forEach((l, i) => {
        l.typeOptions = list[i];
        l.touch();
        d.changed('props', { layer: l });
      });
      apply(after);
      d.history.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now() });
      d.changed('history');
    }
    return true;
  };

  /** The document-space outline path of a text layer: its warp and transform included, or null. */
  const outlinesOf = (layer) => outlinePath(layer, { geometry: stageGeometry(layer, Infinity) });

  async function warpText(arg, ctx) {
    commitTyping();
    const list = targets().filter(isStraight);
    if (!list.length) {
      if (targets().length) return toast('Warp Text does not work on text on a path or stacked vertical text');
      return toast('Select a text layer first');
    }
    let warp;
    if (arg !== undefined && arg !== null && typeof arg === 'object') warp = arg.style === 'none' ? null : M.normalizeWarp(arg);
    else if (arg === 'none' || arg === null) warp = null;
    else {
      const first = list[0];
      const originals = list.map((l) => l.typeOptions);
      const d = doc();
      const preview = (w) => {
        list.forEach((l, i) => {
          l.typeOptions = w === undefined ? originals[i] : withWarp({ typeOptions: originals[i] }, w);
          l.touch();
        });
        d.changed('canvas');
      };
      const values = await formDialog(app, {
        title: 'Warp Text',
        className: 'warp-text-dialog',
        fields: dialogFields(),
        values: dialogValues(first.typeOptions?.warp),
        live: { apply: (v) => preview(warpFromValues(v)), revert: () => preview(undefined) },
      });
      preview(undefined);
      if (!values) return ctx?.cancel();
      warp = warpFromValues(values);
    }
    ctx?.setReplayArg(warp ? { ...warp } : { style: 'none' });
    setWarp(list, warp);
    app.syncUiState?.();
    return true;
  }

  function createWorkPath() {
    commitTyping();
    const d = doc();
    const list = targets();
    if (!list.length) return toast('Select a text layer first');
    const subpaths = [];
    const missing = [];
    let partial = false;
    for (const l of list) {
      const o = outlinesOf(l);
      if (!o) {
        missing.push(l.name);
        continue;
      }
      if (!o.complete) partial = true;
      subpaths.push(...o.path.subpaths);
    }
    if (!subpaths.length) return toast(missing.length === 1 ? `"${missing[0]}" ${NO_OUTLINES}` : `These text layers ${NO_OUTLINES.replace(/^has no glyph outlines: its font is/, 'have no glyph outlines: their fonts are')}`);
    recordPaths(d, 'Create Work Path', { workPath: { subpaths } });
    if (missing.length) toast(`Left out ${missing.map((n) => `"${n}"`).join(', ')}: no glyph outlines (a font drawn by the browser)`, 'info');
    else if (partial) toast('Some characters (colour glyphs, or characters drawn by the browser) have no outlines and were left out', 'info');
    return true;
  }

  function convertToShape() {
    commitTyping();
    const d = doc();
    const list = targets();
    if (!list.length) return toast('Select a text layer first');
    const pairs = [];
    const missing = [];
    let partial = false;
    for (const l of list) {
      const o = outlinesOf(l);
      if (!o || !o.path.subpaths.length) {
        missing.push(l.name);
        continue;
      }
      if (!o.complete) partial = true;
      const st = M.charStyleAt(l.content, 0);
      const stroke = st.stroke && st.stroke.width > 0 ? { color: hex6(st.stroke.color), width: st.stroke.width, align: 'outside', dash: [] } : null;
      const shape = new ShapeLayer({
        name: l.name, path: o.path, fill: { type: 'solid', color: hex6(st.color) }, stroke, shapeKind: 'path', shapeProps: {},
        opacity: l.opacity, fillOpacity: l.fillOpacity, blend: l.blend, visible: l.visible, clip: l.clip, styles: l.styles ? JSON.parse(JSON.stringify(l.styles)) : null,
        blending: l.blending, vectorMask: l.vectorMask ? JSON.parse(JSON.stringify(l.vectorMask)) : null, locked: { ...l.locked },
      });
      shape.x = 0;
      shape.y = 0;
      if (l.mask) shape.mask = { ...l.mask, canvas: copyCanvas(l.mask.canvas) };
      if (l.color) shape.color = l.color;
      if (l.linked) shape.linked = l.linked;
      pairs.push([l, shape]);
    }
    if (!pairs.length) return toast(missing.length === 1 ? `"${missing[0]}" ${NO_OUTLINES}` : `These text layers ${NO_OUTLINES.replace(/^has no glyph outlines: its font is/, 'have no glyph outlines: their fonts are')}`);
    structural(app, 'Convert to Shape', () => {
      const wasActive = d.active;
      const selected = new Set(d.selected);
      for (const [l, shape] of pairs) {
        const parent = l.parent, i = parent.children.indexOf(l);
        d.remove(l);
        d.add(shape, parent, i);
      }
      const swap = new Map(pairs);
      d.selected = new Set([...selected].map((l) => swap.get(l) ?? l).filter((l) => l.parent));
      d.active = swap.get(wasActive) ?? (wasActive?.parent ? wasActive : pairs[pairs.length - 1][1]);
      d.selected.add(d.active);
      d.changed('active', { layer: d.active });
    }, d);
    if (missing.length) toast(`Left out ${missing.map((n) => `"${n}"`).join(', ')}: no glyph outlines (a font drawn by the browser)`, 'info');
    else if (partial) toast('Some characters (colour glyphs, or characters drawn by the browser) have no outlines and were left out', 'info');
    return true;
  }

  /** The content and box of a paragraph text as point text: a return at each wrapped line end, overflow dropped. */
  function asPointText(layer) {
    const lay = layoutText(layer);
    const text = layer.content.text;
    let content = layer.content;
    const lines = lay.lines ?? [];
    const hidden = lines.find((l) => !l.visible);
    let dropped = false;
    if (hidden && hidden.from < text.length) {
      // text beyond a fixed box is not shown: Photoshop deletes it in the conversion
      content = M.deleteRange(content, Math.max(0, hidden.from - (/\s/.test(text[hidden.from - 1] ?? '') ? 1 : 0)), text.length);
      dropped = true;
    }
    const shown = lines.filter((l) => l.visible);
    // from the end, so earlier positions stay valid
    for (let i = shown.length - 2; i >= 0; i--) {
      const l = shown[i];
      if (l.last) continue; // the paragraph ends here: its return is in the text already
      const next = shown[i + 1];
      const end = next.from;
      // a forced line break is a break already
      if (/[\n\r\u2028\u2029\u0003]/.test(text[end - 1] ?? '')) continue;
      let start = end;
      while (start > l.from && /[ \t ]/.test(text[start - 1])) start--;
      content = M.replaceRange(content, start, end, l.hyphen ? '-\n' : '\n');
    }
    // the lines keep their place: an aligned paragraph's lines move with the narrower box
    const width = Math.max(0, ...shown.map((l) => l.width ?? 0));
    const align = M.paragraphs(layer.content)[0]?.style.align ?? 'left';
    const W = layer.width ?? width;
    const x = align === 'center' || align === 'justify-center' ? layer.x + (W - width) / 2 : align === 'right' || align === 'justify-right' ? layer.x + W - width : layer.x;
    return { content, x: Math.round(x * 100) / 100, dropped };
  }

  function convertTextKind(arg) {
    commitTyping();
    const layer = activeText();
    if (!layer) return toast('Select a text layer first');
    if (!isStraight(layer)) return toast('Text on a path and stacked vertical text cannot change kind');
    const now = layer.width == null ? 'point' : 'paragraph';
    const to = arg === 'point' || arg === 'paragraph' ? arg : now === 'point' ? 'paragraph' : 'point';
    if (to === now) return false;
    if (to === 'paragraph') {
      const lay = layoutText(layer);
      // the box the text fills now: wide enough that no line wraps again
      const width = Math.max(1, Math.ceil(lay.width) + 1);
      setLayerProps(app, layer, { width, height: null }, 'Convert to Paragraph Text');
    } else {
      const r = asPointText(layer);
      setLayerProps(app, layer, { content: r.content, width: null, height: null, x: r.x }, 'Convert to Point Text');
      if (r.dropped) toast('The text that did not fit in the box was deleted', 'info');
    }
    app.syncUiState?.();
    return true;
  }

  function antiAlias(arg) {
    const method = typeof arg === 'string' && ANTI_ALIAS.has(arg) ? arg : null;
    if (!method) return toast(`Unknown anti-aliasing method: ${arg}`);
    const s = session();
    const layers = s ? [s.session.layer] : targets();
    if (!layers.length) return toast('Select a text layer first');
    // the type tools show the method for new text as well
    for (const t of app.typeTools?.() ?? []) app.tools.setOpt(t.id, 'antiAlias', method, { silent: true });
    if (app.tools.active && (app.typeTools?.() ?? []).includes(app.tools.active)) app.tools.updateControl('antiAlias', method);
    if (layers.every((l) => (l.typeOptions?.antiAlias ?? 'smooth') === method)) {
      app.syncUiState?.();
      return false;
    }
    applyTypeOptions(app, { antiAlias: method }, { label: ANTI_ALIAS_LABEL });
    app.syncUiState?.();
    return true;
  }

  function pasteLorem() {
    const t = session();
    const ed = t?.session?.editor;
    if (!ed) return toast('Paste Lorem Ipsum works while you edit text: click into a text layer with a Type tool first');
    const layer = t.session.layer;
    ed.insert(LOREM_IPSUM, { kind: 'paste' });
    // a fixed paragraph box is filled to its end, as in Photoshop
    if (layer.width != null && layer.height != null) {
      for (let i = 0; i < 60 && !layoutText(layer).overflow; i++) ed.insert(` ${LOREM_SENTENCES[i % LOREM_SENTENCES.length]}`, { kind: 'paste' });
    }
    ed.stack?.seal?.();
    ed.focus();
    return true;
  }

  function updateAll() {
    const d = doc();
    const layers = d.layers().filter((l) => l.type === 'text');
    for (const l of layers) l.touch();
    // every layout is redone with the faces there are now (B.4), in every open document
    fontsChanged();
    d.changed('canvas');
    toast(layers.length === 1 ? 'Updated 1 text layer' : `Updated ${layers.length} text layers`, 'info');
    return layers.length;
  }

  function toggleOrientation() {
    const active = app.tools.active;
    const tools = app.typeTools?.() ?? [];
    commitTyping();
    const d = doc();
    const list = d ? targets().filter((l) => !l.pathText) : [];
    if (list.length) {
      const next = (activeText() ?? list[0]).font.orientation === 'vertical' ? 'horizontal' : 'vertical';
      const apply = () => {
        for (const l of list) setOrientation(app, l, next);
      };
      if (list.length > 1) d.history.group('Text Orientation', apply);
      else apply();
      app.syncUiState?.();
    }
    // the Type tool follows: the tool of the other orientation (Photoshop's button switches both)
    if (tools.includes(active) && active.sibling) app.tools.activate(active.sibling.id);
    return true;
  }

  app.commands.registerAll({
    'type:anti-alias': {
      label: 'Anti-Alias',
      enabled: () => !!doc() && hasText(),
      run: (arg) => antiAlias(arg),
    },
    'type:warp-text': {
      label: 'Warp Text',
      dialog: true,
      enabled: () => !!doc() && hasText(),
      run: (arg, ctx) => warpText(arg, ctx),
    },
    'type:create-work-path': {
      label: 'Create Work Path',
      enabled: () => !!doc() && hasText(),
      run: () => createWorkPath(),
    },
    'type:convert-to-shape': {
      label: 'Convert to Shape',
      enabled: () => !!doc() && hasText(),
      run: () => convertToShape(),
    },
    'type:convert-text-kind': {
      label: () => (activeText()?.width == null ? 'Convert to Paragraph Text' : 'Convert to Point Text'),
      enabled: () => !!activeText() && isStraight(activeText()),
      run: (arg) => convertTextKind(arg),
    },
    'type:update-all': {
      label: 'Update All Text Layers',
      enabled: () => !!doc(),
      run: () => updateAll(),
    },
    'type:paste-lorem-ipsum': {
      label: 'Paste Lorem Ipsum',
      enabled: () => !!session()?.session?.editor,
      run: () => pasteLorem(),
    },
    'type:toggle-orientation': {
      label: 'Toggle Text Orientation',
      enabled: () => true,
      run: () => toggleOrientation(),
    },
  });
}
