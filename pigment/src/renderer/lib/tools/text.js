// Type tools: Horizontal Type and Vertical Type. Click for point text, drag for a paragraph box,
// click a text layer to edit it. Editing happens in place: a transparent <textarea> is laid over
// the layer with the same font, size (× zoom), line height and letter spacing, and only its caret
// and selection highlight show, while the layer itself re-renders live underneath. One history
// entry per editing session (creating a layer and typing into it is a single entry).
//
// Vertical type is horizontal text rotated 90° clockwise through the layer's `transform` (letters
// sideways, lines running right to left), flagged with font.orientation = 'vertical'. Stacked
// upright glyphs would need a vertical layout in TextLayer (lib/document.js).
import { Tool } from '../tools.js';
import { TextLayer, cssFont, measureContext, DEFAULT_TEXT_STYLE } from '../document.js';
import { structural, setLayerProps } from '../layer-ops.js';
import { bridge } from '../bridge.js';
import { icon } from '../icons.js';
import { invertMatrix, applyMatrix } from '../../../shared/pixels/transform.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

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
const autoName = (text) => String(text ?? '').split('\n')[0].slice(0, 30) || 'Text';
const snapshot = (layer) => ({ text: layer.text, font: JSON.parse(JSON.stringify(layer.font)), width: layer.width, name: layer.name, x: layer.x, y: layer.y });
function restore(layer, snap) {
  layer.text = snap.text;
  layer.font = JSON.parse(JSON.stringify(snap.font));
  layer.width = snap.width;
  layer.name = snap.name;
  if (snap.x !== undefined) layer.x = snap.x;
  if (snap.y !== undefined) layer.y = snap.y;
  layer.touch();
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

// ---- the tools ----------------------------------------------------------------------------------------------

function typeOptions() {
  return [
    { kind: 'select', key: 'family', label: '', options: fontFamilies().map((f) => [f, f]), default: 'Arial' },
    { kind: 'select', key: 'style', label: '', options: STYLES, default: '400' },
    { kind: 'number', key: 'size', label: 'Size', min: 1, max: 1296, step: 1, default: 48, unit: 'px' },
    { kind: 'segment', key: 'align', label: '', options: [['left', 'Left align text', 'align-left'], ['center', 'Center text', 'align-hcenter'], ['right', 'Right align text', 'align-right']], default: 'left' },
    { kind: 'color', key: 'color', label: '', default: '#000000' },
    { kind: 'button', key: 'charPanel', label: '', icon: 'character', onClick: (t) => t.app.commands.run('window:panel-character', undefined, 'toolbar') },
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
      hint: 'Click to add point text, drag to make a paragraph box, click text to edit it. Ctrl/Cmd+Enter or ✓ commits, Esc cancels.',
      options: typeOptions(),
    });
    this.vertical = vertical;
    this.session = null;
    this.drag = null;
    this.baselineCache = new Map();
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
    const values = layer
      ? { family: layer.font.family, style: styleOf(layer.font), size: Math.round(layer.font.size * 100) / 100, align: layer.font.align ?? 'left', color: hex6(layer.font.color) }
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
    if (this.session) setTimeout(() => this.session?.textarea.focus({ preventScroll: true }), 0);
  }
  /** Applies a font patch: live to the layer being edited, else (undoably) to the targeted text layers. */
  applyFont(patch, { label = 'Character', merge = true } = {}) {
    const s = this.session;
    if (s) {
      s.layer.font = { ...s.layer.font, ...patch };
      s.layer.touch();
      s.doc.changed('props', { layer: s.layer });
      this.layoutEditor();
      return;
    }
    const doc = this.doc;
    const targets = textTargets(doc);
    if (!targets.length) return;
    if (targets.length === 1) {
      setLayerProps(this.app, targets[0], { font: { ...targets[0].font, ...patch } }, label, { merge });
      return;
    }
    // several layers: consecutive changes of the same property (a colour-picker drag) merge into one entry
    const key = `text:${targets.map((l) => l.id).join('+')}:${Object.keys(patch).join(',')}`;
    const h = doc.history;
    const last = h.entries[h.index];
    const apply = (fonts) => {
      targets.forEach((l, i) => {
        l.font = { ...fonts[i] };
        l.touch();
        doc.changed('props', { layer: l });
      });
    };
    const after = targets.map((l) => ({ ...l.font, ...patch }));
    if (merge && last?.mergeKey === key && Date.now() - last.at < 1500) {
      apply(after);
      h.merge(() => apply(after));
      return;
    }
    const before = targets.map((l) => ({ ...l.font }));
    apply(after);
    h.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now(), mergeKey: key });
    doc.changed('history');
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
    this.commitSession();
    this.drag = null;
  }
  commit() {
    if (!this.session) return false;
    this.commitSession();
    return true;
  }
  cancel() {
    if (this.drag) {
      this.drag = null;
      return true;
    }
    if (this.resize) {
      const r = this.resize;
      this.resize = null;
      r.layer.x = r.x;
      r.layer.width = r.width;
      r.layer.touch();
      this.session?.doc.changed('props', { layer: r.layer });
      this.layoutEditor();
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
      const lay = l.layout();
      const w = l.width ?? lay.width, h = Math.max(lay.height, lay.lineHeight);
      const pad = 4 / zoom;
      if (q.x >= l.x - pad && q.x <= l.x + w + pad && q.y >= l.y - pad && q.y <= l.y + h + pad) return l;
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
  /** Which corner handle of the session's paragraph box is under the document point p (screen tolerance). */
  hitBoxHandle(p) {
    const s = this.session;
    const l = s?.layer;
    if (!l || l.width === null || !this.view) return null;
    const lay = l.layout();
    const w = l.width, h = Math.max(lay.height, lay.lineHeight);
    const sp = this.view.toScreen(p.x, p.y);
    const corners = { nw: [l.x, l.y], ne: [l.x + w, l.y], se: [l.x + w, l.y + h], sw: [l.x, l.y + h] };
    for (const [name, [x, y]] of Object.entries(corners)) {
      const [dx, dy] = l.transform ? applyMatrix(l.transform, x, y) : [x, y];
      const c = this.view.toScreen(dx, dy);
      if (Math.abs(c.x - sp.x) <= 6 && Math.abs(c.y - sp.y) <= 6) return name;
    }
    return null;
  }
  onPointerDown(p) {
    const s = this.session;
    if (s) {
      const handle = this.hitBoxHandle(p);
      if (handle) {
        const q = this.toLocal(s.layer, p) ?? p;
        this.resize = { layer: s.layer, handle, start: q, x: s.layer.x, width: s.layer.width };
        return;
      }
      const hit = this.hitTextLayer(p);
      if (hit === s.layer) {
        const i = this.caretIndex(hit, p);
        s.textarea.focus({ preventScroll: true });
        s.textarea.setSelectionRange(i, i);
        return;
      }
      this.commitSession();
      if (hit) this.beginEdit(hit, { at: p });
      return;
    }
    const hit = this.hitTextLayer(p);
    if (hit) {
      this.beginEdit(hit, { at: p });
      return;
    }
    this.drag = { start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, moved: false };
  }
  onPointerMove(p, dragging) {
    const r = this.resize;
    if (dragging && r && this.session?.layer === r.layer) {
      const q = this.toLocal(r.layer, p) ?? p;
      const dx = q.x - r.start.x;
      const min = r.layer.font.size;
      if (r.handle === 'ne' || r.handle === 'se') r.layer.width = Math.max(min, Math.round((r.width + dx) * 100) / 100);
      else {
        const w = Math.max(min, r.width - dx);
        r.layer.x = Math.round((r.x + (r.width - w)) * 100) / 100;
        r.layer.width = Math.round(w * 100) / 100;
      }
      r.layer.touch();
      this.session.doc.changed('props', { layer: r.layer });
      this.layoutEditor();
      return;
    }
    if (!dragging || !this.drag) return;
    this.drag.current = { x: p.x, y: p.y };
    if (Math.hypot(p.x - this.drag.start.x, p.y - this.drag.start.y) * this.view.zoom > 4) this.drag.moved = true;
  }
  onPointerUp(p) {
    if (this.resize) {
      this.resize = null;
      this.session?.textarea.focus({ preventScroll: true });
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled || !this.doc) return;
    const r2 = (n) => Math.round(n * 100) / 100;
    if (d.moved) {
      const x1 = Math.min(d.start.x, d.current.x), y1 = Math.min(d.start.y, d.current.y);
      this.beginNew(d.start, { x: r2(x1), y: r2(y1), width: r2(Math.abs(d.current.x - d.start.x)), height: r2(Math.abs(d.current.y - d.start.y)) });
    } else this.beginNew({ x: r2(d.start.x), y: r2(d.start.y) }, null);
  }
  /** Index into layer.text nearest to the document point p. */
  caretIndex(layer, p) {
    const q = this.toLocal(layer, p);
    if (!q) return layer.text.length;
    const lay = layer.layout();
    const ctx = measureContext();
    ctx.font = cssFont(layer.font);
    const starts = [];
    let pos = 0;
    for (const line of lay.lines) {
      starts.push(pos);
      pos += line.text.length;
      if (layer.text[pos] === ' ' || layer.text[pos] === '\n') pos++;
    }
    const li = Math.max(0, Math.min(lay.lines.length - 1, Math.floor((q.y - layer.y) / lay.lineHeight)));
    const line = lay.lines[li];
    let x0 = layer.x;
    if (layer.font.align === 'center') x0 += (lay.width - line.width) / 2;
    else if (layer.font.align === 'right') x0 += lay.width - line.width;
    const spacing = layer.font.letterSpacing ?? 0;
    let best = 0, bestD = Infinity;
    for (let k = 0; k <= line.text.length; k++) {
      const w = ctx.measureText(line.text.slice(0, k)).width + k * spacing;
      const dd = Math.abs(x0 + w - q.x);
      if (dd < bestD) {
        bestD = dd;
        best = k;
      }
    }
    return Math.min(layer.text.length, starts[li] + best);
  }

  // ---- sessions ----
  beginNew(at, box) {
    const doc = this.doc;
    const font = this.fontFromOptions();
    const ascent = font.size * 0.8; // TextLayer.layout() puts the first baseline at y + 0.8 × size
    let x, y, width = null, transform = null;
    if (this.vertical) {
      // rotate 90° clockwise about the box's local top-left corner (qx, qy)
      let qx, qy;
      if (box) {
        qx = box.x + box.width;
        qy = box.y;
        width = Math.max(font.size, box.height);
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
    } else {
      x = at.x;
      y = at.y - ascent;
    }
    const layer = new TextLayer({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, width, text: '', font, transform });
    structural(this.app, this.name, () => {
      doc.add(layer);
      doc.setActive(layer);
    });
    const entry = doc.history.entries[doc.history.index];
    this.session = { doc, layer, isNew: true, entry, before: snapshot(layer), autoName: true };
    this.openEditor();
  }
  beginEdit(layer, { at = null, selectAll = false } = {}) {
    if (this.session?.layer === layer) {
      this.session.textarea.focus({ preventScroll: true });
      if (selectAll) this.session.textarea.select();
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
    this.session = { doc, layer, isNew: false, before: snapshot(layer), autoName: layer.name === autoName(layer.text) };
    this.openEditor();
    const ta = this.session.textarea;
    if (selectAll) ta.select();
    else {
      const i = at ? this.caretIndex(layer, at) : layer.text.length;
      ta.setSelectionRange(i, i);
    }
  }
  openEditor() {
    const s = this.session;
    const ta = document.createElement('textarea');
    ta.className = 'text-editor type-editor';
    ta.spellcheck = false;
    ta.autocomplete = 'off';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('aria-label', 'Text');
    ta.value = s.layer.text;
    s.textarea = ta;
    s.doc.view.area.appendChild(ta);
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('keydown', (e) => this.onEditorKey(e));
    // the editor covers the text box, so its corner handles are grabbed here and driven like a canvas drag
    ta.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.session) return;
      const view = this.session.doc.view;
      const toDoc = (ev) => {
        const r = view.canvas.getBoundingClientRect();
        const d = view.toDoc(ev.clientX - r.left, ev.clientY - r.top);
        return { x: d.x, y: d.y, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, button: ev.button, buttons: ev.buttons, pointerType: ev.pointerType, pressure: 1, original: ev };
      };
      const p = toDoc(e);
      if (!this.hitBoxHandle(p)) return;
      e.preventDefault();
      this.onPointerDown(p);
      ta.setPointerCapture(e.pointerId);
      const move = (ev) => this.onPointerMove(toDoc(ev), true);
      const up = (ev) => {
        ta.removeEventListener('pointermove', move);
        ta.removeEventListener('pointerup', up);
        ta.removeEventListener('pointercancel', up);
        this.onPointerUp({ ...toDoc(ev), cancelled: ev.type === 'pointercancel' });
      };
      ta.addEventListener('pointermove', move);
      ta.addEventListener('pointerup', up);
      ta.addEventListener('pointercancel', up);
    });
    ta.addEventListener('scroll', () => {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    });
    // the canvas area is overflow:hidden but still scrollable: the browser would scroll it (and the
    // canvas with it) to reveal a caret that is off screen
    const area = s.doc.view.area;
    s.unpinArea = () => area.removeEventListener('scroll', s.pinArea);
    s.pinArea = () => {
      area.scrollTop = 0;
      area.scrollLeft = 0;
    };
    area.addEventListener('scroll', s.pinArea);
    ta.addEventListener('wheel', (e) => {
      e.preventDefault();
      s.doc.view.canvas.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    this.layoutEditor();
    const focus = () => {
      if (this.session?.textarea !== ta) return;
      ta.focus({ preventScroll: true });
    };
    focus();
    requestAnimationFrame(focus);
    this.syncFromLayer(s.layer);
    if (this.app.tools.active === this) this.app.tools.renderOptions();
    this.app.emit('type:session', { layer: s.layer });
    s.doc.view.invalidate();
  }
  closeEditor() {
    const s = this.session;
    if (!s) return null;
    this.session = null;
    s.unpinArea?.();
    s.textarea.remove();
    s.pinArea?.();
    s.doc.view?.invalidate();
    if (this.app.tools.active === this) this.app.tools.renderOptions();
    this.app.emit('type:session', { layer: null });
    return s;
  }
  onInput() {
    const s = this.session;
    if (!s) return;
    const layer = s.layer;
    layer.text = s.textarea.value;
    if (s.autoName) layer.name = autoName(layer.text);
    layer.touch();
    s.doc.changed('props', { layer });
    this.layoutEditor();
  }
  onEditorKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      stop();
      this.cancelSession();
      return;
    }
    if (e.key === 'Enter' && (mod || e.code === 'NumpadEnter')) {
      stop();
      this.commitSession();
      return;
    }
    if (e.key === 'Tab') {
      stop();
      return;
    }
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    const f = this.session.layer.font;
    if (e.shiftKey && (e.code === 'Period' || k === '>' || e.code === 'Comma' || k === '<')) {
      stop();
      const up = e.code === 'Period' || k === '>';
      this.applyFont({ size: Math.max(1, Math.round(f.size + (up ? 2 : -2))) });
      this.syncFromLayer();
      return;
    }
    if (k === 'b' || k === 'i' || k === 'u') {
      stop();
      if (k === 'b') this.applyFont({ weight: (f.weight ?? 400) >= 600 ? 400 : 700 });
      if (k === 'i') this.applyFont({ italic: !f.italic });
      if (k === 'u') this.applyFont({ underline: !f.underline });
      this.syncFromLayer();
      return;
    }
    // keep app shortcuts (filters, adjustments...) from acting on the layer while typing
    if (/^[a-z]$/.test(k) && !['z', 'y', 'x', 'c', 'v', 'a', 's'].includes(k)) e.preventDefault();
  }
  /** Keys pressed while the editor is open but not focused go to the text. */
  onKeyDown(e) {
    const s = this.session;
    if (!s || e.ctrlKey || e.metaKey || e.altKey) return false;
    const ta = s.textarea;
    const edit = (text, from, to) => {
      ta.focus({ preventScroll: true });
      ta.setRangeText(text, from, to, 'end');
      this.onInput();
      return true;
    };
    const a = ta.selectionStart, b = ta.selectionEnd;
    if (e.key.length === 1) return edit(e.key, a, b);
    if (e.key === 'Backspace') return edit('', a === b ? Math.max(0, a - 1) : a, b);
    if (e.key === 'Delete') return edit('', a, a === b ? Math.min(ta.value.length, b + 1) : b);
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
      ta.focus({ preventScroll: true });
      return true;
    }
    return false;
  }
  /** Positions the textarea exactly over the layer's text (font metrics, zoom, rotation, transform). */
  layoutEditor() {
    const s = this.session;
    if (!s) return;
    const { layer, doc, textarea: ta } = s;
    const view = doc.view;
    const z = view.zoom;
    const font = layer.font;
    const lay = layer.layout();
    const fs = font.size * z;
    const lh = font.size * font.lineHeight * z;
    const fontCss = cssFont({ ...font, size: fs });
    ta.style.font = fontCss;
    ta.style.lineHeight = `${lh}px`;
    ta.style.letterSpacing = `${(font.letterSpacing ?? 0) * z}px`;
    ta.style.textAlign = font.align ?? 'left';
    ta.style.caretColor = hex6(font.color);
    const point = layer.width === null;
    ta.wrap = point ? 'off' : 'soft';
    ta.style.whiteSpace = point ? 'pre' : 'pre-wrap';
    const extra = point ? Math.max(fs * 2, 40) : 0; // room for the next characters before the next layout
    const w = (point ? lay.width : layer.width) * z + (point ? extra : 1);
    const lines = Math.max(1, lay.lines.length);
    ta.style.width = `${w}px`;
    ta.style.height = `${lines * lh}px`;
    const align = font.align ?? 'left';
    const shiftX = point ? (align === 'center' ? -extra / 2 : align === 'right' ? -extra : 0) : 0;
    const dy = lay.ascent * z - this.cssBaseline(fontCss, lh, ta.parentElement);
    let m = view.matrix();
    if (layer.transform) m = m.multiply(new DOMMatrix(layer.transform));
    m = m.translate(layer.x, layer.y).scale(1 / z).translate(shiftX, dy);
    ta.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    s.pinArea?.();
    view.invalidate();
  }
  /** Distance from the top of a CSS line box to its baseline (measured, so it matches the textarea). */
  cssBaseline(fontCss, lineHeight, parent) {
    const key = `${fontCss}|${lineHeight}`;
    const cached = this.baselineCache.get(key);
    if (cached !== undefined) return cached;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;padding:0;margin:0;border:0;pointer-events:none';
    probe.style.font = fontCss;
    probe.style.lineHeight = `${lineHeight}px`;
    probe.innerHTML = 'Xg<span style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
    parent.appendChild(probe);
    const value = probe.lastChild.getBoundingClientRect().top - probe.getBoundingClientRect().top;
    probe.remove();
    if (this.baselineCache.size > 64) this.baselineCache.clear();
    this.baselineCache.set(key, value);
    return value;
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
        layer.touch();
        doc.changed('props', { layer });
      }
      return true;
    }
    const after = snapshot(layer);
    if (JSON.stringify(after) === JSON.stringify(s.before)) return true;
    restore(layer, s.before);
    if (!after.text.trim()) {
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
      const w = l.width ?? lay.width, h = Math.max(lay.height, lay.lineHeight);
      const corners = [[l.x, l.y], [l.x + w, l.y], [l.x + w, l.y + h], [l.x, l.y + h]].map(([x, y]) => {
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
      if (l.width !== null) {
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(30,136,255,0.9)';
        for (const c of corners) {
          ctx.fillRect(Math.round(c.x) - 3, Math.round(c.y) - 3, 6, 6);
          ctx.strokeRect(Math.round(c.x) - 2.5, Math.round(c.y) - 2.5, 6, 6);
        }
      }
    }
    ctx.restore();
  }
}

/** The type tool with an open editing session, if any. */
export function typeSession(app) {
  for (const id of ['type-horizontal', 'type-vertical']) {
    const t = app.tools?.get(id);
    if (t?.session) return t;
  }
  return null;
}

/** Applies a font patch from the Character panel: to the text being edited, else to the targeted text layers. */
export function applyTypeStyle(app, patch, opts) {
  const tool = typeSession(app) ?? app.tools.get('type-horizontal');
  tool?.applyFont(patch, opts);
}

export function install(app) {
  const h = new TypeTool(app, false);
  const v = new TypeTool(app, true);
  app.tools.register(h, 'text');
  app.tools.register(v, 'text');
  const tools = [h, v];

  loadSystemFonts();
  onFontsChanged((list) => {
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
        if (s.textarea.value !== s.layer.text) s.textarea.value = s.layer.text;
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
