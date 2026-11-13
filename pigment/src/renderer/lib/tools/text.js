// Type tools: Horizontal Type and Vertical Type. Click for point text, drag for a paragraph box, Alt-click for a box
// of a size typed in, click a text layer to edit it. One history entry per editing session (creating a layer and
// typing into it is a single entry).
//
// Editing (0.4, type-editing; ARCHITECTURE.md "0.4 features" B.8) runs on lib/type/editor.js: the editor draws its own
// caret and selection over the layer's layout and a hidden <textarea> receives what is typed (IME and dead keys
// included). While editing: the eight handles of a paragraph box set its width and height (a dragged box keeps its
// height: text beyond it is hidden and the bottom-right handle shows +); holding Ctrl/Cmd shows the transform box
// (its handles run Free Transform, then editing goes on); Ctrl/Cmd-drag, or a drag that starts outside the text,
// moves the layer; a click outside commits.
//
// Vertical type is horizontal text rotated 90° clockwise through the layer's `transform` (letters sideways, lines
// running right to left), flagged with typeOptions.orientation = 'vertical'.
//
// The stable surface of B.8 (other modules and the specs import it): FALLBACK_FONTS, fontFamilies, onFontsChanged,
// loadSystemFonts, STYLES, styleOf, styleToFont, textTargets, typeSession, applyTypeStyle; typeSession(app) is the
// tool whose `session` is { layer, doc, isNew, textarea } (textarea: the editor's hidden input, its value the plain
// text and its selection the editor's).
import { Tool } from '../tools.js';
import { TextLayer, measureContext, DEFAULT_TEXT_STYLE, applyLegacyFont } from '../document.js';
import { structural, setLayerProps } from '../layer-ops.js';
import { bridge } from '../bridge.js';
import { icon } from '../icons.js';
import { invertMatrix, applyMatrix } from '../../../shared/pixels/transform.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { hitSegment, isEmptyPath, clonePath, visibleTargets } from './vector.js';
import { pathOffsetAt } from '../text-path.js';
import * as M from '../type/model.js';
import * as typeApi from '../type/api.js';
import { applyChar as targetApplyChar, applyPara as targetApplyPara, applyTypeOptions as targetApplyTypeOptions, editTypeLayers } from '../type/target.js';
import { fontsChanged } from '../type/api.js';
import { TypeEditor, autoName, boxSizeDialog, PLACEHOLDER_POINT, PLACEHOLDER_PARAGRAPH } from '../type/editor.js';

// type-on-path (lib/text-path.js): an I-beam crossing a curve, shown when the pointer is over a path
const PATH_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 17q9-12 18-2" fill="none" stroke="#fff" stroke-width="3"/><path d="M3 17q9-12 18-2" fill="none" stroke="#000" stroke-width="1.5"/><path d="M9 4h6M12 4v16M9 20h6" stroke="#fff" stroke-width="3" fill="none"/><path d="M9 4h6M12 4v16M9 20h6" stroke="#000" stroke-width="1.2" fill="none"/></svg>')}") 12 12, text`;

// ---- fonts --------------------------------------------------------------------------------------------------

const GENERIC = ['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive', 'fantasy'];
export const FALLBACK_FONTS = [
  'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Inter', 'Verdana', 'Tahoma',
  'Trebuchet MS', 'Calibri', 'Candara', 'Corbel', 'Cambria', 'Constantia', 'Georgia', 'Times New Roman', 'Times', 'Palatino Linotype', 'Palatino',
  'Book Antiqua', 'Garamond', 'Baskerville', 'Didot', 'Optima', 'Futura', 'Avenir', 'Avenir Next', 'Gill Sans', 'Franklin Gothic Medium', 'Century Gothic',
  'Rockwell', 'Copperplate', 'Impact', 'Comic Sans MS', 'Brush Script MT', 'Lucida Grande', 'Lucida Sans Unicode', 'Lucida Console', 'Courier New', 'Courier',
  'Consolas', 'Menlo', 'Monaco', 'SF Pro Text', 'SF Pro Display', 'SF Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'DejaVu Sans', 'DejaVu Serif',
  'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Ubuntu', 'Ubuntu Mono', 'Cantarell', 'Fira Sans', 'Fira Code', 'Source Sans Pro',
  'Source Serif Pro', 'Source Code Pro', 'Nimbus Sans', 'Nimbus Roman', 'FreeSans', 'FreeSerif', 'Droid Sans', 'Oswald', 'Raleway', 'Poppins', 'Merriweather',
];

let fonts = null;
let loading = null;
const fontListeners = new Set();

function uniqueSorted(list) {
  const seen = new Set();
  const named = [];
  for (const f of list) {
    const name = String(f ?? '').trim();
    if (!name || seen.has(name.toLowerCase()) || GENERIC.includes(name)) continue;
    seen.add(name.toLowerCase());
    named.push(name);
  }
  named.sort((a, b) => a.localeCompare(b));
  return [...named, ...GENERIC];
}

/** Families from the fixed list that render differently from the generic fallbacks (i.e. are installed). */
function detectFonts(list) {
  const ctx = measureContext();
  const sample = 'mmmmmmmmmmlli WWW 0123456789 @#&';
  const bases = ['monospace', 'serif', 'sans-serif'];
  const base = {};
  for (const g of bases) {
    ctx.font = `72px ${g}`;
    base[g] = ctx.measureText(sample).width;
  }
  const ok = list.filter((f) => bases.some((g) => {
    ctx.font = `72px "${f}", ${g}`;
    return Math.abs(ctx.measureText(sample).width - base[g]) > 0.05;
  }));
  return uniqueSorted(ok);
}

/** Font families for the font pickers (installed fonts when the host lists them, else detected common ones). */
export function fontFamilies() {
  if (!fonts) fonts = detectFonts(FALLBACK_FONTS);
  return fonts;
}

export function onFontsChanged(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Asks the host for the installed fonts (bridge.localFonts, else window.queryLocalFonts). Safe to call repeatedly. */
export function loadSystemFonts() {
  if (loading) return loading;
  loading = (async () => {
    let list = [];
    try {
      if (typeof bridge.localFonts === 'function') list = (await withTimeout(bridge.localFonts(), 4000)) ?? [];
    } catch {
      list = [];
    }
    if (!list.length && typeof window.queryLocalFonts === 'function') {
      try {
        const all = await withTimeout(window.queryLocalFonts(), 4000);
        list = all.map((f) => f.family);
      } catch {
        list = [];
      }
    }
    if (list.length) {
      fonts = uniqueSorted(list);
      for (const fn of fontListeners) fn(fonts);
    } else {
      setTimeout(() => (loading = null), 0); // allow another try from a user gesture
    }
    return fontFamilies();
  })();
  return loading;
}

// ---- styles -------------------------------------------------------------------------------------------------

const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [700, 'Bold'], [900, 'Black']];
export const STYLES = WEIGHTS.flatMap(([w, n]) => [[`${w}`, n], [`${w}i`, w === 400 ? 'Italic' : `${n} Italic`]]);

export function styleOf(font) {
  const w = Number(font?.weight ?? 400);
  const near = WEIGHTS.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a))[0];
  return `${near}${font?.italic ? 'i' : ''}`;
}

export function styleToFont(style) {
  const s = String(style ?? '400');
  return { weight: parseInt(s, 10) || 400, italic: s.endsWith('i') };
}

const hex6 = (c) => rgbaToHex(parseColor(c ?? '#000000')).slice(0, 7);
// the rich-text content (immutable) and its layer options, so cancel and undo restore formatting exactly
const snapshot = (layer) => ({ content: layer.content, typeOptions: layer.typeOptions, width: layer.width, height: layer.height ?? null, name: layer.name, x: layer.x, y: layer.y, pathText: layer.pathText ? JSON.parse(JSON.stringify(layer.pathText)) : null });
function restore(layer, snap) {
  layer.content = snap.content;
  layer.typeOptions = snap.typeOptions;
  layer.width = snap.width;
  layer.height = snap.height ?? null;
  layer.name = snap.name;
  if (snap.x !== undefined) layer.x = snap.x;
  if (snap.y !== undefined) layer.y = snap.y;
  if ('pathText' in snap) layer.pathText = snap.pathText ? JSON.parse(JSON.stringify(snap.pathText)) : null;
  layer.touch();
}
/**
 * The text box in the layer's base space: the paragraph/point box for plain text (the layout's frame: a fixed
 * height when set, else the lines), the glyph union (`layout().box`, only text extensions set it) for text on a
 * path and stacked text (lib/text-path.js).
 */
function textBox(layer, lay = layer.layout()) {
  if (lay.box) return { x: lay.box.x, y: lay.box.y, width: lay.box.width, height: lay.box.height, glyphs: true };
  const frame = lay.frame ?? { width: layer.width, height: null };
  return { x: layer.x, y: layer.y, width: frame.width ?? lay.width, height: frame.height ?? Math.max(lay.height, lay.lineHeight), glyphs: false };
}
/** False when the layer or any group above it is hidden. */
const shown = (layer) => {
  for (let l = layer; l; l = l.parent) if (l.visible === false) return false;
  return true;
};

/** Text layers a style change applies to: the selected text layers, else the active one. */
export function textTargets(doc) {
  if (!doc) return [];
  const sel = doc.selectedLayers().filter((l) => l.type === 'text' && !l.locked.all);
  if (sel.length) return sel;
  return doc.active?.type === 'text' && !doc.active.locked.all ? [doc.active] : [];
}

// the eight handles of a box: [name, u, v] with u, v the position across the box (0 = left/top, 1 = right/bottom)
const BOX_HANDLES = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
/** Screen px a press may start beyond the text box and still move the text instead of committing it. */
const MOVE_SLOP = 3;

// ---- the tools ----------------------------------------------------------------------------------------------

function typeOptions() {
  return [
    { kind: 'select', key: 'family', label: '', options: fontFamilies().map((f) => [f, f]), default: 'Arial' },
    { kind: 'select', key: 'style', label: '', options: STYLES, default: '400' },
    // kind font-size (lib/fields.js; type-character-panel adds units and the preset list): today's px field
    { kind: 'font-size', key: 'size', label: 'Size', min: 1, max: 1296, step: 1, default: 48, unit: 'px' },
    { kind: 'segment', key: 'align', label: '', options: [['left', 'Left align text', 'align-left'], ['center', 'Center text', 'align-hcenter'], ['right', 'Right align text', 'align-right']], default: 'left' },
    { kind: 'color', key: 'color', label: '', default: '#000000' },
    { kind: 'button', key: 'charPanel', label: '', icon: 'character', onClick: (t) => t.app.commands.run('type:toggle-panels', undefined, 'toolbar') },
  ];
}

const FONT_KEYS = { family: (v) => ({ family: v }), style: (v) => styleToFont(v), size: (v) => ({ size: Math.max(1, Number(v) || 1) }), align: (v) => ({ align: v }), color: (v) => ({ color: v }) };

export class TypeTool extends Tool {
  constructor(app, vertical = false) {
    super(app, {
      id: vertical ? 'type-vertical' : 'type-horizontal',
      name: vertical ? 'Vertical Type Tool' : 'Horizontal Type Tool',
      icon: vertical ? 'text-vertical' : 'text',
      cursor: vertical ? 'vertical-text' : 'text',
      hint: 'Click to add point text, drag to make a paragraph box (Alt-click to type its size), click text to edit it. While editing: drag a box handle to resize, hold Ctrl/Cmd to transform or drag to move. Ctrl/Cmd+Enter or ✓ commits, Esc cancels.',
      options: typeOptions(),
    });
    this.vertical = vertical;
    this.session = null;
    this.drag = null;
    // tool traits (L.12): the type tools never paint; Ctrl/Cmd is theirs (transform box, move while editing)
    this.paints = false;
    this.claimsModifiers = new Set(['ctrl']);
  }
  get sibling() {
    return this.app.tools.get(this.vertical ? 'type-horizontal' : 'type-vertical');
  }

  // ---- options ----
  fontFromOptions() {
    const o = (k, d) => this.opt(k) ?? d;
    return {
      ...DEFAULT_TEXT_STYLE,
      family: o('family', 'Arial'),
      size: Math.max(1, Number(o('size', 48))),
      ...styleToFont(o('style', '400')),
      align: o('align', 'left'),
      color: this.app.settings.foreground ?? '#000000',
      lineHeight: Number(o('lineHeight', 1.2)) || 1.2,
      letterSpacing: Number(o('letterSpacing', 0)) || 0,
      underline: !!o('underline', false),
      stroke: o('stroke', null),
      ...(this.vertical ? { orientation: 'vertical' } : {}),
    };
  }
  setFamilyOptions(list) {
    const spec = this.options.find((o) => o.key === 'family');
    const current = this.opt('family');
    const names = current && !list.includes(current) ? [current, ...list] : list;
    spec.options = names.map((f) => [f, f]);
  }
  /** Shows a text layer's font in the options bar (silently, without applying anything). */
  syncFromLayer(layer = this.session?.layer ?? (this.doc?.active?.type === 'text' ? this.doc.active : null)) {
    const tm = this.app.tools;
    let font = null;
    if (layer) {
      // while editing, the options bar shows the style at the caret or the start of the selection
      const ed = this.session?.layer === layer ? this.session.editor : null;
      if (ed) {
        const [a] = ed.range();
        const st = M.charStyleAt(layer.content, a > 0 && ed.sel.anchor === ed.sel.focus ? a - 1 : a);
        font = { family: st.fontFamily, weight: st.fontWeight, italic: st.fontItalic, size: st.size, color: st.color, align: M.paraAttrs(layer.content, a, a).align };
      } else font = layer.font;
    }
    const values = font
      ? { family: font.family, style: styleOf(font), size: Math.round(font.size * 100) / 100, align: alignOf(font.align), color: hex6(font.color) }
      : { color: hex6(this.app.settings.foreground) };
    let rerender = false;
    for (const [k, v] of Object.entries(values)) {
      if (this.opt(k) === v) continue;
      tm.setOpt(this.id, k, v, { silent: true });
      if (k === 'family' && !this.options.find((o) => o.key === 'family').options.some(([f]) => f === v)) {
        this.setFamilyOptions(fontFamilies());
        rerender = true;
      }
      if (tm.active === this && !rerender) tm.updateControl(k, v);
    }
    if (rerender && tm.active === this) tm.renderOptions();
  }
  onOptionChanged(key, value) {
    const sib = this.sibling;
    if (sib && key in FONT_KEYS) this.app.tools.setOpt(sib.id, key, value, { silent: true });
    const make = FONT_KEYS[key];
    if (!make) return;
    if (this.session || textTargets(this.doc).length) this.applyFont(make(value), { merge: key === 'size' || key === 'color' });
    else if (key === 'color') this.app.setColors({ foreground: value });
    if (this.session) setTimeout(() => this.session?.editor.focus(), 0);
  }
  /**
   * Applies a font patch: while editing, to the selected range (or, with a caret, the whole text, as 0.3's options
   * bar did) as one step of the session; else (undoably) to the targeted text layers.
   */
  applyFont(patch, { label = 'Character', merge = true } = {}) {
    const s = this.session;
    if (s) {
      const ed = s.editor;
      const [a, b] = ed.range();
      if (a !== b) {
        applyTypeStyle(this.app, patch, { label, merge });
        return;
      }
      ed.typeSession().edit((content) => {
        const r = applyLegacyFont(content, s.layer.typeOptions, { ...legacyFontOf(content, s.layer.typeOptions), ...patch });
        return { content: r.content, typeOptions: r.typeOptions };
      }, { label, merge });
      return;
    }
    const doc = this.doc;
    const targets = textTargets(doc);
    if (!targets.length) return;
    if (targets.length === 1) {
      setLayerProps(this.app, targets[0], { font: { ...targets[0].font, ...patch } }, label, { merge });
      return;
    }
    // several layers (lib/type/target.js): one entry with 0.3's merge key, so consecutive changes of the same
    // property (a colour-picker drag) merge; undo restores each layer's formatting exactly
    editTypeLayers(this.app, targets, (l) => applyLegacyFont(l.content, l.typeOptions, { ...l.font, ...patch }), { label, merge, keys: Object.keys(patch) });
  }
  renderOptions(bar) {
    if (!this.session) return;
    const wrap = document.createElement('span');
    wrap.className = 'opt type-commit';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn small primary';
    ok.dataset.action = 'commit';
    ok.title = 'Commit (Ctrl/Cmd+Enter)';
    ok.innerHTML = icon('check');
    ok.addEventListener('click', () => this.commitSession());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn small';
    cancel.dataset.action = 'cancel';
    cancel.title = 'Cancel (Esc)';
    cancel.innerHTML = icon('x');
    cancel.addEventListener('click', () => this.cancelSession());
    wrap.append(ok, cancel);
    bar.appendChild(wrap);
  }

  // ---- lifecycle ----
  activate() {
    this.syncFromLayer();
  }
  deactivate() {
    // a Ctrl-drag hands the pointer to Free Transform; the session was committed before that
    this.commitSession();
    this.drag = null;
    this.gesture = null;
  }
  commit() {
    if (!this.session) return false;
    this.commitSession();
    return true;
  }
  cancel() {
    if (this.drag || this.offsetDrag) {
      this.drag = null;
      this.offsetDrag = null;
      return true;
    }
    const g = this.gesture;
    if (g && (g.kind === 'resize' || g.kind === 'move')) {
      this.gesture = null;
      this.session?.editor.restore(g.before);
      return true;
    }
    if (!this.session) return false;
    this.cancelSession();
    return true;
  }

  // ---- pointer ----
  /** Topmost visible text layer whose text box contains p (the active layer first). */
  hitTextLayer(p) {
    const doc = this.doc;
    const zoom = this.view?.zoom ?? 1;
    const list = doc.layers().filter((l) => l.type === 'text' && shown(l)).reverse();
    if (doc.active?.type === 'text' && shown(doc.active)) list.unshift(doc.active);
    for (const l of list) {
      const q = this.toLocal(l, p);
      if (!q) continue;
      const b = textBox(l);
      const pad = 4 / zoom;
      if (q.x >= b.x - pad && q.x <= b.x + b.width + pad && q.y >= b.y - pad && q.y <= b.y + b.height + pad) return l;
    }
    return null;
  }
  toLocal(layer, p) {
    if (!layer.transform) return { x: p.x, y: p.y };
    try {
      const [x, y] = applyMatrix(invertMatrix(layer.transform), p.x, p.y);
      return { x, y };
    } catch {
      return null;
    }
  }
  /** The eight handles of the session's paragraph box on screen: [name, screen point]. */
  boxHandles() {
    const l = this.session?.layer;
    if (!l || l.width === null || !this.view) return [];
    const lay = l.layout();
    if (lay.glyphs) return []; // text on a path / stacked text has no resizable box
    const b = textBox(l, lay);
    return BOX_HANDLES.map(([name, u, v]) => {
      const x = b.x + u * b.width, y = b.y + v * b.height;
      const [dx, dy] = l.transform ? applyMatrix(l.transform, x, y) : [x, y];
      return [name, this.view.toScreen(dx, dy)];
    });
  }
  /** Which handle of the session's paragraph box is under the document point p (screen tolerance). */
  hitBoxHandle(p) {
    if (!this.view) return null;
    const sp = this.view.toScreen(p.x, p.y);
    for (const [name, c] of this.boxHandles()) if (Math.abs(c.x - sp.x) <= 6 && Math.abs(c.y - sp.y) <= 6) return name;
    return null;
  }
  /** The transform box Ctrl/Cmd shows (Free Transform's box: the layer's bounds) as eight screen points. */
  transformHandles() {
    const l = this.session?.layer;
    if (!l || !this.view) return [];
    const b = l.bounds();
    return BOX_HANDLES.map(([name, u, v]) => [name, this.view.toScreen(b.x + u * b.width, b.y + v * b.height)]);
  }
  /** 'handle' (a transform handle), 'near' (just outside the box: rotate) or null, for a Ctrl/Cmd press at p. */
  hitTransform(p) {
    if (!this.view || !this.session) return null;
    const sp = this.view.toScreen(p.x, p.y);
    const hs = this.transformHandles();
    if (hs.some(([, c]) => Math.hypot(c.x - sp.x, c.y - sp.y) < 8)) return 'handle';
    const xs = hs.map(([, c]) => c.x), ys = hs.map(([, c]) => c.y);
    const inside = sp.x >= Math.min(...xs) && sp.x <= Math.max(...xs) && sp.y >= Math.min(...ys) && sp.y <= Math.max(...ys);
    if (inside) return null;
    const near = sp.x >= Math.min(...xs) - 40 && sp.x <= Math.max(...xs) + 40 && sp.y >= Math.min(...ys) - 40 && sp.y <= Math.max(...ys) + 40;
    return near ? 'near' : null;
  }
  /** A visible path (active shape layer, chosen path, work path) under the document point p, for type-on-path. */
  pathHit(p) {
    if (!this.doc || !this.view) return null;
    const tol = 6 / this.view.zoom;
    for (const t of visibleTargets(this.app)) {
      const path = t.get();
      if (isEmptyPath(path)) continue;
      const seg = hitSegment(path, p.x, p.y, tol);
      if (seg) return { path, target: t };
    }
    return null;
  }
  /** Is the document point p on the start-offset I-beam of the session's text on a path (screen tolerance)? */
  hitOffsetHandle(p) {
    const s = this.session;
    const l = s?.layer;
    if (!l?.pathText || !this.view) return false;
    const a = l.layout().anchor;
    if (!a) return false;
    const [dx, dy] = l.transform ? applyMatrix(l.transform, a.x, a.y) : [a.x, a.y];
    const c = this.view.toScreen(dx, dy), sp = this.view.toScreen(p.x, p.y);
    return Math.hypot(c.x - sp.x, c.y - sp.y) <= 9;
  }
  onPointerDown(p) {
    const s = this.session;
    if (s) {
      const ed = s.editor;
      if (p.ctrl || p.meta) {
        // Ctrl/Cmd: the transform box's handles transform the text (Free Transform), inside it a drag moves it
        const t = this.hitTransform(p);
        if (t) {
          this.transformWhileEditing(p);
          return;
        }
        if (this.hitTextLayer(p) === s.layer) {
          this.gesture = { kind: 'move', start: { x: p.x, y: p.y }, before: ed.snapshot(), x: s.layer.x, y: s.layer.y, moved: false };
          ed.focus();
          return;
        }
      }
      const handle = this.hitBoxHandle(p);
      if (handle) {
        const q = this.toLocal(s.layer, p) ?? p;
        const lay = s.layer.layout();
        const b = textBox(s.layer, lay);
        this.gesture = { kind: 'resize', handle, start: q, before: ed.snapshot(), x: s.layer.x, y: s.layer.y, width: s.layer.width, height: s.layer.height ?? b.height };
        ed.focus();
        return;
      }
      if (this.hitOffsetHandle(p)) {
        this.offsetDrag = { layer: s.layer, before: ed.snapshot() };
        return;
      }
      const hit = this.hitTextLayer(p);
      if (hit === s.layer) {
        this.gesture = { kind: 'select' };
        ed.pointerDown(p);
        return;
      }
      if (hit) {
        this.commitSession();
        this.beginEdit(hit, { at: p });
        return;
      }
      // outside the text: a drag moves it (Photoshop's move cursor there), a click commits on release
      this.gesture = { kind: 'outside', start: { x: p.x, y: p.y }, screen: { x: p.screenX, y: p.screenY }, before: ed.snapshot(), x: s.layer.x, y: s.layer.y, moved: false };
      ed.focus();
      return;
    }
    const hit = this.hitTextLayer(p);
    if (hit && !p.alt) {
      this.beginEdit(hit, { at: p });
      return;
    }
    const onPath = p.alt ? null : this.pathHit(p);
    if (onPath) {
      this.beginNew({ x: p.x, y: p.y }, null, { path: onPath.path });
      return;
    }
    this.drag = { start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, moved: false, alt: !!p.alt };
  }
  onPointerMove(p, dragging) {
    const s = this.session;
    if (!dragging) {
      if (!s && !this.drag) this.view?.setCursor(this.pathHit(p) ? PATH_CURSOR : this.cursorStyle);
      else if (s) {
        // Ctrl/Cmd held over the canvas shows the transform box even while the hidden input has no focus
        const ctrl = !!(p.ctrl || p.meta);
        if (s.editor.ctrlHeld !== ctrl) {
          s.editor.ctrlHeld = ctrl;
          s.editor.invalidate();
        }
        this.view?.setCursor(this.hoverCursor(p));
      }
      return;
    }
    const od = this.offsetDrag;
    if (od && s?.layer === od.layer) {
      // dragging the I-beam slides the text along its path (part of the editing session's entry)
      const l = od.layer;
      const q = this.toLocal(l, p) ?? p;
      // offsets are measured along the direction of travel, which flip reverses
      const raw = pathOffsetAt(l.pathText.path, q.x - l.x, q.y - l.y);
      const startOffset = Math.round((l.pathText.flip ? 1 - raw : raw) * 1000) / 1000;
      l.pathText = { ...l.pathText, startOffset };
      l.touch();
      s.doc.changed('props', { layer: l });
      s.editor.placeInput();
      return;
    }
    const g = this.gesture;
    if (g && s) {
      if (g.kind === 'select') {
        s.editor.pointerMove(p);
        return;
      }
      if (g.kind === 'resize') return this.resizeTo(g, p);
      if (g.kind === 'outside' && !g.moved && Math.hypot(p.screenX - g.screen.x, p.screenY - g.screen.y) > MOVE_SLOP) g.moved = true;
      if (g.kind === 'move' || (g.kind === 'outside' && g.moved)) return this.moveTo(g, p);
      return;
    }
    if (!this.drag) return;
    const sp = this.app.snap?.point(p, { source: 'type-box', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
    this.drag.current = { x: sp.x, y: sp.y };
    if (Math.hypot(p.x - this.drag.start.x, p.y - this.drag.start.y) * this.view.zoom > 4) this.drag.moved = true;
  }
  /** A box handle drag: width and height in the layer's base space; the box keeps the height it is dragged to. */
  resizeTo(g, p) {
    const s = this.session;
    const l = s.layer;
    const sp = this.app.snap?.point(p, { source: 'type-box', pointer: p, exclude: [l], view: this.view }) ?? p; // snap (lib/snap.js)
    const q = this.toLocal(l, { ...p, x: sp.x, y: sp.y }) ?? p;
    const dx = q.x - g.start.x, dy = q.y - g.start.y;
    const min = Math.max(1, M.charStyleAt(l.content, 0).size);
    const r2 = (n) => Math.round(n * 100) / 100;
    const h = g.handle;
    if (h.includes('e')) l.width = r2(Math.max(min, g.width + dx));
    if (h.includes('w')) {
      const wv = Math.max(min, g.width - dx);
      l.x = r2(g.x + (g.width - wv));
      l.width = r2(wv);
    }
    if (h.includes('s') || h.includes('n')) {
      if (h.includes('s')) l.height = r2(Math.max(min, g.height + dy));
      else {
        const hv = Math.max(min, g.height - dy);
        l.y = r2(g.y + (g.height - hv));
        l.height = r2(hv);
      }
    }
    l.touch();
    s.doc.changed('props', { layer: l });
    s.editor.placeInput();
    s.editor.invalidate();
  }
  /** Moves the text being edited (Ctrl/Cmd-drag inside it, or a drag that starts outside it). */
  moveTo(g, p) {
    const s = this.session;
    const l = s.layer;
    let dx = p.x - g.start.x, dy = p.y - g.start.y;
    // snap (lib/snap.js): the moved text's bounds meet guides and the document like a Move tool drag
    const b = l.bounds();
    const box = { x: b.x + (g.x - l.x) + dx, y: b.y + (g.y - l.y) + dy, width: b.width, height: b.height };
    const sn = this.app.snap?.box(box, { source: 'move', pointer: p, exclude: [l], view: this.view }); // snap (lib/snap.js)
    if (sn) {
      dx += sn.dx ?? 0;
      dy += sn.dy ?? 0;
    }
    // a document move is a base-space move through the inverse of the layer's linear transform
    let bx = dx, by = dy;
    const t = l.transform;
    if (t) {
      try {
        const inv = invertMatrix([t[0], t[1], t[2], t[3], 0, 0]);
        [bx, by] = applyMatrix(inv, dx, dy);
      } catch {
        return;
      }
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    l.x = r2(g.x + bx);
    l.y = r2(g.y + by);
    g.moved = true;
    l.touch();
    s.doc.changed('props', { layer: l });
    s.editor.placeInput();
    s.editor.invalidate();
  }
  hoverCursor(p) {
    const s = this.session;
    if (p.ctrl || p.meta) {
      if (this.hitTransform(p)) return 'nwse-resize';
      return this.hitTextLayer(p) === s.layer ? 'move' : 'default';
    }
    const h = this.hitBoxHandle(p);
    if (h) return HANDLE_CURSORS[h];
    const hit = this.hitTextLayer(p);
    if (hit) return this.cursorStyle;
    return 'move';
  }
  onPointerUp(p) {
    const s = this.session;
    if (this.offsetDrag) {
      const od = this.offsetDrag;
      this.offsetDrag = null;
      if (s?.layer === od.layer) s.editor.recordFrom(od.before, 'path-offset');
      s?.editor.focus();
      return;
    }
    const g = this.gesture;
    this.gesture = null;
    if (g && s) {
      if (g.kind === 'select') s.editor.pointerUp(p);
      else if (g.kind === 'resize' || (g.kind === 'move' && g.moved) || (g.kind === 'outside' && g.moved)) {
        if (p.cancelled) s.editor.restore(g.before);
        else s.editor.recordFrom(g.before, g.kind === 'resize' ? 'box' : 'move');
        s.editor.focus();
      } else if (g.kind === 'outside' && !p.cancelled) this.commitSession();
      else s.editor.focus();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled || !this.doc) return;
    const r2 = (n) => Math.round(n * 100) / 100;
    if (d.alt) {
      // Alt-click (or Alt-drag): the size of the paragraph box typed in (Photoshop's Paragraph Text Size)
      const at = { x: r2(Math.min(d.start.x, d.current.x)), y: r2(Math.min(d.start.y, d.current.y)) };
      const size = d.moved ? { width: Math.abs(d.current.x - d.start.x), height: Math.abs(d.current.y - d.start.y) } : {};
      this.askBoxSize(at, size);
      return;
    }
    if (d.moved) {
      const x1 = Math.min(d.start.x, d.current.x), y1 = Math.min(d.start.y, d.current.y);
      this.beginNew(d.start, { x: r2(x1), y: r2(y1), width: r2(Math.abs(d.current.x - d.start.x)), height: r2(Math.abs(d.current.y - d.start.y)) });
    } else this.beginNew({ x: r2(d.start.x), y: r2(d.start.y) }, null);
  }
  /** The internal type:box-size (M.7): asks for a box size, then starts paragraph text there. */
  async askBoxSize(at, size) {
    const v = await boxSizeDialog(this.app, size);
    if (!v || !this.doc || this.app.tools.active !== this) return;
    this.beginNew(at, { x: at.x, y: at.y, width: v.width, height: v.height });
  }
  onDoubleClick() {
    // multi-click selection is counted on pointerdown (lib/type/editor.js); the native dblclick adds nothing
  }
  /** Keys pressed while the editor is open but its input does not have focus go to the text. */
  onKeyDown(e) {
    const s = this.session;
    if (!s || e.ctrlKey || e.metaKey || e.altKey) return false;
    const ed = s.editor;
    if (e.key.length === 1) {
      ed.focus();
      ed.insert(e.key);
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      ed.focus();
      const [a, b] = ed.range();
      const t = ed.text;
      if (a === b) {
        const from = e.key === 'Backspace' ? Math.max(0, a - 1) : a, to = e.key === 'Backspace' ? a : Math.min(t.length, b + 1);
        ed.select(from, to, { seal: false });
      }
      ed.insert('', { kind: 'delete' });
      return true;
    }
    if (/^(Arrow|Home$|End$|Page)/.test(e.key)) {
      ed.focus();
      ed.navigate(e);
      return true;
    }
    return false;
  }
  /** Index into layer.text nearest to the document point p (lib/type/api.js hitTest). */
  caretIndex(layer, p) {
    const q = this.toLocal(layer, p);
    if (!q) return layer.text.length;
    return Math.min(layer.text.length, typeApi.hitTest(layer, q.x, q.y).index);
  }

  /**
   * Ctrl/Cmd on the transform box while editing: the text is committed, Free Transform (app.transformTool) takes the
   * drag, and when the button is released the transform is applied and editing goes on with the same selection.
   */
  transformWhileEditing(p) {
    const s = this.session;
    const tt = this.app.transformTool;
    if (!s || !tt) return;
    const { layer, doc } = s;
    const sel = { ...s.editor.sel };
    this.commitSession();
    if (!layer.parent || doc.find(layer.id) !== layer) return;
    if (doc.active !== layer) doc.setActive(layer);
    if (doc.selectedLayers().some((l) => l !== layer)) doc.selected?.clear?.();
    tt.start({ mode: 'free' });
    if (!tt.session) {
      this.beginEdit(layer, { sel });
      return;
    }
    // Ctrl in Free Transform means distort or skew: the press that summoned it is a plain one
    tt.onPointerDown({ ...p, ctrl: false, meta: false });
    const done = () => {
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      // after Free Transform's own pointerup (the canvas's listener runs before this one on window)
      setTimeout(() => {
        if (tt.session && !tt.committing) tt.commit();
        if (this.app.tools.active !== this) this.app.tools.activate(this.id);
        if (layer.parent && this.app.doc === doc) this.beginEdit(layer, { sel });
      }, 0);
    };
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }

  // ---- sessions ----
  /** Placeholder text for a new layer (settings.type.placeholder), or ''. */
  placeholderFor(box) {
    if (this.app.settings?.type?.placeholder === false) return '';
    return box ? PLACEHOLDER_PARAGRAPH : PLACEHOLDER_POINT;
  }
  beginNew(at, box, { path = null } = {}) {
    const doc = this.doc;
    const font = this.fontFromOptions();
    const ascent = font.size * 0.8; // the first baseline is at y + 0.8 × size (A, "First baseline")
    let x, y, width = null, height = null, transform = null, pathText = null;
    if (path) {
      // type on a path (lib/text-path.js): the text starts where the path was clicked; the path is
      // stored in document space, so the layer's offset is zero
      x = 0;
      y = 0;
      if (font.orientation === 'vertical') delete font.orientation;
      pathText = { path: clonePath(path), startOffset: Math.round(pathOffsetAt(path, at.x, at.y) * 1000) / 1000, flip: false, align: font.align ?? 'left' };
    } else if (this.vertical) {
      // rotate 90° clockwise about the box's local top-left corner (qx, qy)
      let qx, qy;
      if (box) {
        qx = box.x + box.width;
        qy = box.y;
        width = Math.max(font.size, box.height);
        height = Math.max(font.size, box.width);
      } else {
        qx = at.x + (font.size * font.lineHeight) / 2;
        qy = at.y;
      }
      x = qx;
      y = qy;
      transform = [0, 1, -1, 0, qx + qy, qy - qx];
    } else if (box) {
      x = box.x;
      y = box.y;
      width = Math.max(font.size, box.width);
      // a dragged box is a fixed box: text beyond its height is hidden and the bottom-right handle shows +
      height = Math.max(font.size, box.height);
    } else {
      x = at.x;
      y = at.y - ascent;
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const text = path ? this.placeholderFor(false) : this.placeholderFor(!!box);
    const layer = new TextLayer({ x: r2(x), y: r2(y), width: width === null ? null : r2(width), text, font, transform, pathText });
    if (height !== null) layer.height = r2(height);
    if (text) layer.name = autoName(text);
    structural(this.app, this.name, () => {
      doc.add(layer);
      doc.setActive(layer);
    });
    const entry = doc.history.entries[doc.history.index];
    this.session = this.makeSession({ doc, layer, isNew: true, entry, before: snapshot(layer), autoName: true });
    this.session.placeholder = !!text;
    this.openEditor();
    // the placeholder is selected, so the first key typed replaces it
    if (text) this.session.editor.select(0, text.length);
  }
  makeSession(s) {
    const session = { ...s, editor: null };
    // B.8: `textarea` is the editor's hidden input (its value the plain text, its selection the editor's)
    Object.defineProperty(session, 'textarea', { enumerable: true, get: () => session.editor?.input ?? null });
    session.editor = new TypeEditor(this, session);
    return session;
  }
  /**
   * Starts editing a text layer: { at } puts the caret at a document point, { selectAll } selects the text,
   * { sel } restores a selection ({ anchor, focus }).
   */
  beginEdit(layer, { at = null, selectAll = false, sel = null } = {}) {
    if (this.session?.layer === layer) {
      const ed = this.session.editor;
      ed.focus();
      if (selectAll) ed.selectAll();
      else if (at) ed.select(ed.indexAt(at).index);
      return;
    }
    if (this.session) this.commitSession();
    const doc = this.doc;
    if (!doc || layer.type !== 'text') return;
    if (layer.locked.all) {
      this.app.dialogs.toast(`"${layer.name}" is locked`, { kind: 'error', timeout: 1800 });
      return;
    }
    if (doc.active !== layer) doc.setActive(layer);
    this.session = this.makeSession({ doc, layer, isNew: false, before: snapshot(layer), autoName: layer.name === autoName(layer.text) });
    this.openEditor();
    const ed = this.session.editor;
    const n = layer.text.length;
    if (selectAll) ed.select(0, n);
    else if (sel) ed.select(Math.min(sel.anchor, n), Math.min(sel.focus, n));
    else if (at) {
      const { index, affinity } = ed.indexAt(at);
      ed.select(index, index, { affinity });
    } else ed.select(n);
  }
  openEditor() {
    const s = this.session;
    s.editor.open();
    this.syncFromLayer(s.layer);
    if (this.app.tools.active === this) this.app.tools.renderOptions();
    this.app.emit('type:session', { layer: s.layer });
    this.app.syncUiState?.();
    s.doc.view.invalidate();
  }
  closeEditor() {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    this.gesture = null;
    s.editor.close();
    s.doc.view?.invalidate();
    if (this.app.tools.active === this) this.app.tools.renderOptions();
    this.app.emit('type:session', { layer: null });
    this.app.syncUiState?.();
    return s;
  }
  /** The TypeSession of lib/type/target.js over this tool's editing session (B.7). */
  typeSessionApi() {
    return this.session?.editor.typeSession() ?? null;
  }
  /** Repositions what the editor shows after the view or the layer changed. */
  layoutEditor() {
    const ed = this.session?.editor;
    if (!ed) return;
    ed.placeInput();
    ed.invalidate();
  }
  /** Ends the session and records it (one history entry). */
  commitSession() {
    const s = this.closeEditor();
    if (!s) return false;
    const { doc, layer } = s;
    if (!layer.parent || !doc.history) return true;
    if (s.isNew) {
      if (!layer.text.trim()) this.dropNew(s);
      else {
        // the creation entry holds the layer object, which now has its text: one entry for creating and typing
        layer.touch();
        doc.changed('props', { layer });
      }
      return true;
    }
    const after = snapshot(layer);
    if (JSON.stringify(after) === JSON.stringify(s.before)) return true;
    restore(layer, s.before);
    if (!M.plainText(after.content).trim()) {
      if (this.app.doc === doc) structural(this.app, 'Delete Type Layer', () => doc.remove(layer));
      return true;
    }
    if (this.app.doc === doc) setLayerProps(this.app, layer, after, 'Edit Type Layer');
    else {
      const apply = (v) => {
        restore(layer, v);
        doc.changed('props', { layer });
      };
      apply(after);
      doc.history.push({ label: 'Edit Type Layer', undo: () => apply(s.before), redo: () => apply(after), bytes: 0, at: Date.now() });
    }
    return true;
  }
  /** Ends the session and reverts it. */
  cancelSession() {
    const s = this.closeEditor();
    if (!s) return false;
    if (s.isNew) this.dropNew(s);
    else {
      restore(s.layer, s.before);
      s.doc.changed('props', { layer: s.layer });
    }
    return true;
  }
  /** Removes a new, empty text layer together with its creation entry. */
  dropNew(s) {
    const { doc, layer } = s;
    const h = doc.history;
    if (h.entries[h.index] === s.entry) {
      h.undo();
      h.entries.length = h.index + 1;
      if (h.savedIndex > h.index) h.savedIndex = -2;
      h.onChange();
    } else if (layer.parent && this.app.doc === doc) structural(this.app, 'Delete Type Layer', () => doc.remove(layer));
  }

  drawOverlay(ctx, view) {
    ctx.save();
    const d = this.drag;
    if (d?.moved) {
      const a = view.toScreen(d.start.x, d.start.y), b = view.toScreen(d.current.x, d.current.y);
      ctx.strokeStyle = '#000';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = 4;
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.round(Math.abs(b.x - a.x)), Math.round(Math.abs(b.y - a.y)));
    }
    const s = this.session;
    if (s && s.doc === view.doc) {
      const l = s.layer;
      const lay = l.layout();
      const b = textBox(l, lay);
      const corners = [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]].map(([x, y]) => {
        const [dx, dy] = l.transform ? applyMatrix(l.transform, x, y) : [x, y];
        return view.toScreen(dx, dy);
      });
      ctx.beginPath();
      corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.setLineDash(l.width === null ? [2, 3] : [5, 3]);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = 'rgba(30,136,255,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      // the eight handles of a paragraph box; + in the bottom-right one when text overflows the box
      for (const [name, c] of this.boxHandles()) {
        const x = Math.round(c.x), y = Math.round(c.y);
        const big = name === 'se' && lay.overflow;
        const r = big ? 5 : 3;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(30,136,255,0.9)';
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.strokeRect(x - r + 0.5, y - r + 0.5, r * 2, r * 2);
        if (big) {
          ctx.strokeStyle = '#d00';
          ctx.beginPath();
          ctx.moveTo(x - 3, y + 0.5);
          ctx.lineTo(x + 4, y + 0.5);
          ctx.moveTo(x + 0.5, y - 3);
          ctx.lineTo(x + 0.5, y + 4);
          ctx.stroke();
        }
      }
      if (s.editor.ctrlHeld && !this.gesture) {
        // Ctrl/Cmd: Free Transform's box around the layer, drawn before it takes over
        const hs = this.transformHandles();
        const at = Object.fromEntries(hs);
        ctx.strokeStyle = 'rgba(30,136,255,1)';
        ctx.beginPath();
        ['nw', 'ne', 'se', 'sw'].forEach((n, i) => (i ? ctx.lineTo(at[n].x, at[n].y) : ctx.moveTo(at[n].x, at[n].y)));
        ctx.closePath();
        ctx.stroke();
        for (const [, c] of hs) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(Math.round(c.x) - 3.5, Math.round(c.y) - 3.5, 7, 7);
          ctx.strokeRect(Math.round(c.x) - 3, Math.round(c.y) - 3, 7, 7);
        }
      }
      if (lay.anchor) {
        // the start-offset I-beam of text on a path: drag it to slide the text along
        const a = lay.anchor;
        const [dx, dy] = l.transform ? applyMatrix(l.transform, a.x, a.y) : [a.x, a.y];
        const c = view.toScreen(dx, dy);
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(a.angle + (view.rotation * Math.PI) / 180);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(0, 10);
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(30,136,255,1)';
        ctx.stroke();
        ctx.restore();
      }
      s.editor.draw(ctx, view);
    }
    ctx.restore();
  }
}

/** The 0.3 flat font of content (memoised by document.js through a TextLayer; here for content in flight). */
function legacyFontOf(content, typeOptions) {
  return M.legacyFont(content, typeOptions);
}
/** The options bar's three alignments: a justify alignment shows its last-line alignment. */
function alignOf(a) {
  if (a === 'center' || a === 'justify-center') return 'center';
  if (a === 'right' || a === 'justify-right') return 'right';
  return 'left';
}

/** The type tool with an open editing session, if any. */
export function typeSession(app) {
  for (const id of ['type-horizontal', 'type-vertical']) {
    const t = app.tools?.get(id);
    if (t?.session) return t;
  }
  return null;
}

/**
 * A 0.3 font patch as model attributes for a range: { char, para, typeOptions } (letterSpacing in px becomes
 * tracking at the size being set, lineHeight auto leading of the paragraphs).
 */
function legacyPatch(layer, patch, from) {
  const char = {}, para = {};
  let typeOptions = null;
  const size = Number.isFinite(patch.size) && patch.size > 0 ? patch.size : M.charStyleAt(layer.content, from).size;
  const map = { family: 'fontFamily', weight: 'fontWeight', italic: 'fontItalic', size: 'size', color: 'color', underline: 'underline' };
  for (const [k, v] of Object.entries(patch)) {
    if (map[k]) char[map[k]] = k === 'italic' || k === 'underline' ? !!v : v;
    else if (k === 'stroke') char.stroke = v ? { color: v.color, width: v.width } : null;
    else if (k === 'letterSpacing') char.tracking = Number.isFinite(v) && v ? (v * 1000) / size : undefined;
    else if (k === 'align') para.align = v;
    else if (k === 'lineHeight' && Number.isFinite(v)) {
      char.leading = undefined;
      para.justification = { ...M.paraAttrs(layer.content, from, from).justification, autoLeading: M.tidyNumber(v * 100) };
    } else if (k === 'orientation') typeOptions = { orientation: v ?? 'horizontal' };
  }
  return { char, para, typeOptions };
}

/**
 * Applies a 0.3 font patch from the Character panel through the type target (lib/type/target.js): a selected range
 * of the text being edited gets it as model attributes; while editing with a caret the whole text changes (as in
 * 0.3); otherwise the targeted text layers change as a whole, with 0.3's merge rule.
 */
export function applyTypeStyle(app, patch, opts = {}) {
  const tool = typeSession(app);
  const ed = tool?.session?.editor;
  if (ed) {
    const [a, b] = ed.range();
    if (a !== b) {
      const { char, para, typeOptions } = legacyPatch(tool.session.layer, patch, a);
      if (Object.keys(char).length) targetApplyChar(app, char, opts);
      if (Object.keys(para).length) targetApplyPara(app, para, opts);
      if (typeOptions) targetApplyTypeOptions(app, typeOptions, opts);
      return;
    }
  }
  (tool ?? app.tools.get('type-horizontal'))?.applyFont(patch, opts);
}

export function install(app) {
  const h = new TypeTool(app, false);
  const v = new TypeTool(app, true);
  app.tools.register(h, 'text');
  app.tools.register(v, 'text');
  const tools = [h, v];

  // the options bar's panel button: the Character panel, and the Paragraph panel once a package registers it (M.6)
  app.commands.register('type:toggle-panels', {
    label: 'Toggle the Character and Paragraph Panels',
    run: () => {
      app.commands.run('window:panel-character', undefined, 'api');
      if (app.commands.has('window:panel-paragraph') && !app.stubbed?.includes('window:panel-paragraph')) app.commands.run('window:panel-paragraph', undefined, 'api');
    },
  });

  // B.8: the type session. Another command commits the text first ('commit'); the editor's input owns focus, so
  // app.isTextTarget() is false for it and Edit > Undo reaches the session; `handle` answers undo, the clipboard and
  // Select All itself, and the type keys that share an accelerator with a menu command (lib/type/editor.js)
  const editor = () => typeSession(app)?.session.editor ?? null;
  app.sessions?.register({
    id: 'type',
    policy: 'commit',
    label: 'Type',
    active: () => !!typeSession(app),
    ownsFocus: (el) => !!el && el === editor()?.input,
    allow: /^(view:|window:|help:|app:|type:|text:orientation$)/,
    handle: (id, arg, source) => editor()?.handle(id, arg, source),
    undo: () => editor()?.undo() ?? false,
    redo: () => editor()?.redo() ?? false,
    commit: () => typeSession(app)?.commitSession(),
    cancel: () => typeSession(app)?.cancelSession(),
    onClose: 'commit',
  });

  loadSystemFonts();
  onFontsChanged((list) => {
    // the type facade redraws every text layer with the faces that arrived (B.4)
    fontsChanged();
    for (const t of tools) t.setFamilyOptions(list);
    if (tools.includes(app.tools.active) && !document.activeElement?.closest?.('#options-bar')) app.tools.renderOptions();
  });
  // a user gesture lets window.queryLocalFonts ask for permission in the browser
  document.getElementById('options-bar')?.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.opt[data-key="family"]')) loadSystemFonts();
  }, true);

  app.commands.register('layer:edit-text', {
    enabled: () => !!app.doc,
    label: 'Edit Text',
    run: (id) => {
      const doc = app.doc;
      const layer = (typeof id === 'string' && doc.find(id)) || doc.active;
      if (layer?.type !== 'text') {
        app.dialogs.toast('Select a text layer to edit', { kind: 'error', timeout: 1800 });
        return;
      }
      const tool = layer.font?.orientation === 'vertical' ? v : h;
      if (doc.active !== layer) doc.setActive(layer);
      app.tools.activate(tool.id);
      tool.beginEdit(layer, { selectAll: true });
    },
  });

  app.on('view:changed', () => {
    for (const t of tools) t.layoutEditor();
  });
  app.on('layer:activated', ({ doc, layer }) => {
    for (const t of tools) if (t.session && t.session.doc === doc && layer !== t.session.layer) t.commitSession();
    const active = app.tools.active;
    if (tools.includes(active) && !active.session) active.syncFromLayer();
  });
  app.on('doc:change', (e) => {
    const active = app.tools.active;
    if (tools.includes(active) && !active.session && e.doc === app.doc && (e.kind === 'props' || e.kind === 'history') && e.doc.active?.type === 'text') active.syncFromLayer();
    for (const t of tools) {
      const s = t.session;
      if (!s || s.doc !== e.doc) continue;
      if (!s.layer.parent || s.doc.find(s.layer.id) !== s.layer) t.closeEditor();
      else if (e.kind === 'props' || e.kind === 'history' || e.kind === 'canvas') {
        // the text may have changed under the editor (history, the assistant): keep the selection inside it
        const ed = s.editor;
        const n = s.layer.text.length;
        if (ed.sel.anchor > n || ed.sel.focus > n) ed.sel = { anchor: Math.min(ed.sel.anchor, n), focus: Math.min(ed.sel.focus, n), affinity: 'leading' };
        ed.syncInput();
        t.layoutEditor();
      }
    }
  });
  app.on('doc:closed', (id) => {
    for (const t of tools) if (t.session?.doc.id === id) t.closeEditor();
  });
  app.on('color:changed', ({ fg }) => {
    const active = app.tools.active;
    if (!tools.includes(active) || active.session || active.doc?.active?.type === 'text') return;
    for (const t of tools) app.tools.setOpt(t.id, 'color', hex6(fg), { silent: true });
    app.tools.updateControl('color', hex6(fg));
  });
}
