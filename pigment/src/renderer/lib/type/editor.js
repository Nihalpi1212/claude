// type-editing (ARCHITECTURE.md "0.4 features", package 2; B.7, B.8): the Type tool's editor.
//
// 0.3 laid a transparent <textarea> over the layer and let the browser lay out a copy of the text, which cannot
// follow several formats in one layer. 0.4 draws its own caret, selection and composition underline over the
// layer's real layout (lib/type/api.js hitTest, caretRect, selectionRects: quads, so text on a path and stacked
// text work through B.5), and keeps a hidden <textarea> only to receive what the platform types: characters, IME
// composition, dead keys, Backspace and Delete. The hidden input's value is always the plain text and its selection
// mirrors the editor's (B.8: specs and the stable tools/text.js surface read `session.textarea`).
//
// Text changes arrive as `input` events: the change is found between the selection before it (beforeinput) and the
// new value, and applied to the rich-text model (A), so the formatting outside it stays. Navigation keys, Tab,
// Shift+Enter, the clipboard, undo and TYPE_KEYS are handled here before the browser or shortcuts.js see them.
// Every change is a step of the session's own undo stack (edit-history.js); the commit is one history entry.
//
// This module is also the package's MODULES entry: install() registers the 36 TYPE_KEYS commands,
// edit:paste-without-formatting, the selection provider of lib/type/target.js, the Move tool's double-click on
// text (L.7) and the "type" Preferences section (L.2).
import * as M from './model.js';
import * as api from './api.js';
import { setSelectionProvider, selectionChanged, typeTargets, readChar, readPara, applyPara as targetApplyPara, applyChar as targetApplyChar, editTypeLayers } from './target.js';
import { EditStack } from './edit-history.js';
import { snapToCluster, nextCluster, prevCluster, nextWord, prevWord, paragraphRange, lineAt, unitRange, extendByUnit, nextClickCount, ordered } from './edit-selection.js';
import { makeClip, setInAppClip, inAppClip, choosePaste, applyPaste } from './clipboard.js';
import { typeCommandFor, TYPE_COMMANDS, mapCharRuns, kernStep } from './edit-keys.js';
import { MENU_KEYS, RENDERER_KEYS, TYPE_KEYS, parseAccelerator, eventMatches, typeKeyFor } from '../../../shared/keymap.js';
import { UNDO_LIKE } from '../sessions.js';
import { bridge, isMac } from '../bridge.js';
import { applyMatrix, invertMatrix } from '../../../shared/pixels/transform.js';

/** Placeholder text of new type layers (settings.type.placeholder): point text, and a paragraph box's filling. */
export const PLACEHOLDER_POINT = 'Lorem Ipsum';
export const PLACEHOLDER_PARAGRAPH = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

/** A id ran by the editor's own key handler is swallowed when it arrives again this soon (B.8 (3)). */
const ECHO_MS = 40;
const BLINK_MS = 530;
/** Commands the session answers with the editor's own operations (B.8 (1)), whatever their source. */
const ANSWERED = new Set(['edit:cut', 'edit:copy', 'edit:paste', 'edit:paste-without-formatting', 'select:all', 'edit:select-all', 'edit:clear']);
/** Commands that run while text is edited: shortcuts.js lets these through from a text field (see shortcuts.js). */
const PASSES_IN_TEXT = /^(file:|view:|help:|window:)/;

// menu and renderer accelerators, so a keydown the editor swallows can name the command a menu would also send
const ACCEL_TABLE = [
  ...Object.entries(MENU_KEYS).map(([cmd, a]) => ({ cmd, desc: parseAccelerator(a) })),
  ...Object.entries(RENDERER_KEYS).flatMap(([cmd, list]) => list.map((a) => ({ cmd, desc: parseAccelerator(a) }))),
].sort((a, b) => w(b.desc) - w(a.desc));
function w(d) {
  return Number(d.shift) + Number(d.alt) + Number(d.cmdOrCtrl || d.ctrl || d.meta);
}
function commandForKey(e) {
  for (const { cmd, desc } of ACCEL_TABLE) if (eventMatches(e, desc, isMac)) return cmd;
  return null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const isGlyphLayout = (lay) => !!lay?.glyphs;

/** The type tool (horizontal or vertical) whose session is open, or null. */
export function editingTool(app) {
  for (const id of ['type-horizontal', 'type-vertical']) {
    const t = app.tools?.get?.(id);
    if (t?.session?.editor) return t;
  }
  return null;
}

/** The editor of the open type session, or null. */
export function activeEditor(app) {
  return editingTool(app)?.session.editor ?? null;
}

export class TypeEditor {
  /**
   * @param {object} tool the TypeTool (lib/tools/text.js) that owns the session
   * @param {{ layer, doc }} session
   */
  constructor(tool, session) {
    this.tool = tool;
    this.app = tool.app;
    this.session = session;
    this.layer = session.layer;
    this.doc = session.doc;
    this.sel = { anchor: 0, focus: 0, affinity: 'leading' };
    this.stack = new EditStack();
    this.insertion = null; // a caret's insertion style (target.js applyChar at a caret): a sparse patch
    this.insertionAt = -1;
    this.composing = null; // { from, to } while an IME composes
    this.pre = null; // the selection and text before the input event in flight (beforeinput)
    this.mirror = null; // what was last written into the hidden input
    this.goalX = null; // Up / Down keep the column they started from
    this.clicks = null; // multi-click counting
    this.dragUnit = null; // { count, unit } of the click a drag started with
    this.hideSelection = false; // Ctrl+H
    this.ctrlHeld = false; // Ctrl/Cmd shows the transform box
    this.ran = new Map(); // command id -> time the editor's own key handler ran it
    this.dispatching = 0;
    this.caretOn = true;
    this.blink = null;
    this.input = null;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  open() {
    const ta = document.createElement('textarea');
    ta.className = 'type-input';
    ta.spellcheck = false;
    ta.autocomplete = 'off';
    ta.wrap = 'off';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('aria-label', 'Text');
    ta.tabIndex = -1;
    ta.value = this.layer.text;
    this.input = ta;
    const area = this.doc.view.area;
    area.appendChild(ta);
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    ta.addEventListener('keyup', (e) => this.onKeyUp(e));
    ta.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    ta.addEventListener('input', (e) => this.onInput(e));
    ta.addEventListener('compositionstart', () => this.onCompositionStart());
    ta.addEventListener('compositionupdate', (e) => this.onCompositionUpdate(e));
    ta.addEventListener('compositionend', () => this.onCompositionEnd());
    ta.addEventListener('focus', () => this.restartBlink());
    ta.addEventListener('blur', () => {
      this.ctrlHeld = false;
      this.stopBlink();
      this.invalidate();
    });
    // a selection set on the hidden input from outside (a spec, assistive technology) becomes the editor's
    ta.addEventListener('select', () => this.adoptInputSelection());
    // the canvas area is overflow:hidden but still scrollable: focusing the input must not scroll it
    this.pinArea = () => {
      area.scrollTop = 0;
      area.scrollLeft = 0;
    };
    area.addEventListener('scroll', this.pinArea);
    this.syncInput();
    this.focus();
    requestAnimationFrame(() => {
      if (this.input === ta && this.tool.session?.editor === this) this.focus();
    });
  }

  close() {
    this.stopBlink();
    const area = this.doc.view?.area;
    if (area && this.pinArea) area.removeEventListener('scroll', this.pinArea);
    this.input?.remove();
    this.pinArea?.();
    this.input = null;
  }

  focus() {
    if (!this.input) return;
    if (document.activeElement !== this.input) this.input.focus({ preventScroll: true });
    this.restartBlink();
  }

  restartBlink() {
    this.caretOn = true;
    clearInterval(this.blink);
    // the caret blinks while the input has focus; each tick repaints the view once (measured in docs/0.4/type-editing.md)
    this.blink = setInterval(() => {
      if (!this.input || document.activeElement !== this.input) return this.stopBlink();
      this.caretOn = !this.caretOn;
      this.invalidate();
    }, BLINK_MS);
    this.invalidate();
  }

  stopBlink() {
    clearInterval(this.blink);
    this.blink = null;
    this.caretOn = true;
  }

  invalidate() {
    this.doc.view?.invalidate();
  }

  // ---- state -----------------------------------------------------------------------------------------------------

  get text() {
    return this.layer.text;
  }

  range() {
    return ordered(this.sel);
  }

  /** Everything the session undo stack restores. */
  snapshot() {
    const l = this.layer;
    return { content: l.content, typeOptions: l.typeOptions, x: l.x, y: l.y, width: l.width, height: l.height ?? null, pathText: l.pathText ?? null, sel: { ...this.sel } };
  }

  restore(s) {
    const l = this.layer;
    l.content = s.content;
    l.typeOptions = s.typeOptions;
    l.x = s.x;
    l.y = s.y;
    l.width = s.width;
    l.height = s.height;
    if ('pathText' in s && (s.pathText || l.pathText)) l.pathText = s.pathText;
    this.sel = { ...s.sel };
    this.insertion = null;
    this.changed();
  }

  /** The layer changed: redraw, mirror the input, tell the panels. */
  changed({ select = true } = {}) {
    const l = this.layer;
    if (this.session.autoName) l.name = autoName(l.text);
    l.touch();
    this.doc.changed('props', { layer: l });
    this.syncInput();
    if (select) selectionChanged(this.app);
    this.restartBlink();
  }

  /** Sets the selection (anchor and focus), keeps the caret's insertion style only when the caret stays put. */
  select(anchor, focus = anchor, { affinity = 'leading', keepGoal = false, seal = true } = {}) {
    const t = this.text;
    const a = snapToCluster(t, anchor), f = snapToCluster(t, focus);
    if (a === this.sel.anchor && f === this.sel.focus && affinity === this.sel.affinity) return;
    this.sel = { anchor: a, focus: f, affinity };
    if (this.insertion && !(a === f && a === this.insertionAt)) this.insertion = null;
    if (!keepGoal) this.goalX = null;
    if (seal) this.stack.seal();
    this.syncInput();
    selectionChanged(this.app);
    this.restartBlink();
  }

  /** Writes the plain text and the selection into the hidden input (never while an IME composes). */
  syncInput() {
    const ta = this.input;
    if (!ta || this.composing) return;
    const t = this.text;
    if (ta.value !== t) ta.value = t;
    const [a, b] = this.range();
    const dir = this.sel.focus < this.sel.anchor ? 'backward' : 'forward';
    if (ta.selectionStart !== a || ta.selectionEnd !== b || (a !== b && ta.selectionDirection !== dir)) ta.setSelectionRange(a, b, dir);
    this.mirror = { a, b, dir };
    this.placeInput();
  }

  /** A selection someone set on the input directly (not through the editor) is adopted. */
  adoptInputSelection() {
    const ta = this.input;
    if (!ta || this.composing || ta.value !== this.text) return;
    const m = this.mirror;
    const a = ta.selectionStart, b = ta.selectionEnd, dir = ta.selectionDirection;
    if (m && m.a === a && m.b === b && (a === b || m.dir === dir)) return;
    if (dir === 'backward') this.select(b, a);
    else this.select(a, b);
  }

  /** Keeps the hidden input at the caret, so an IME shows its candidates next to the text. */
  placeInput() {
    const ta = this.input, view = this.doc.view;
    if (!ta || !view) return;
    try {
      const c = this.caretGeometry(this.sel.focus);
      const top = this.toScreen(c.x, c.y);
      const h = Math.max(8, Math.min(200, c.height * view.zoom));
      ta.style.left = `${Math.round(top.x)}px`;
      ta.style.top = `${Math.round(top.y)}px`;
      ta.style.height = `${Math.round(h)}px`;
      ta.style.fontSize = `${Math.round(h * 0.8)}px`;
    } catch {
      // a layout that cannot answer yet (fonts arriving) keeps the last place
    }
  }

  // ---- geometry --------------------------------------------------------------------------------------------------

  /** A base-space point of the layer on screen (CSS px of the view). */
  toScreen(x, y) {
    const t = this.layer.transform;
    const [dx, dy] = t ? applyMatrix(t, x, y) : [x, y];
    return this.doc.view.toScreen(dx, dy);
  }

  /** A document point in the layer's base space (null when its transform cannot be inverted). */
  toBase(p) {
    const t = this.layer.transform;
    if (!t) return { x: p.x, y: p.y };
    try {
      const [x, y] = applyMatrix(invertMatrix(t), p.x, p.y);
      return { x, y };
    } catch {
      return null;
    }
  }

  /** The caret at index i: api.caretRect, with the end of a soft-wrapped line for a 'trailing' caret. */
  caretGeometry(i, affinity = this.sel.affinity) {
    const layer = this.layer;
    const c = api.caretRect(layer, i, affinity);
    if (affinity !== 'trailing') return c;
    const lay = layer.layout();
    if (isGlyphLayout(lay) || !lay.lines?.length) return c;
    const line = lineAt(lay.lines, i, 'trailing');
    if (!line || line.to !== i || line.index === c.line) return c;
    const last = line.runs[line.runs.length - 1];
    const x = last ? last.x + last.advance : line.x + line.width;
    return { x, y: line.top, height: line.height, angle: 0, line: line.index };
  }

  /** Content index and affinity at a document point. */
  indexAt(p) {
    const q = this.toBase(p);
    if (!q) return { index: this.text.length, affinity: 'leading' };
    const h = api.hitTest(this.layer, q.x, q.y);
    return { index: snapToCluster(this.text, h.index), affinity: h.affinity ?? 'leading' };
  }

  // ---- edits -----------------------------------------------------------------------------------------------------

  /**
   * Applies a change to the layer as one session step: next = { content?, typeOptions?, width?, height?, x?, y?,
   * pathText? }, sel = the selection after it.
   */
  apply(next, sel, { kind = 'edit', merge = true } = {}) {
    const before = this.snapshot();
    const l = this.layer;
    if (next.content) l.content = next.content;
    if (next.typeOptions) l.typeOptions = next.typeOptions;
    for (const k of ['width', 'height', 'x', 'y', 'pathText']) if (k in next) l[k] = next[k];
    if (sel) this.sel = { anchor: sel.anchor, focus: sel.focus, affinity: sel.affinity ?? 'leading' };
    this.session.placeholder = false;
    this.goalX = null;
    this.changed();
    this.stack.record(before, this.snapshot(), { kind, merge });
  }

  /** Records a change the tool already made to the layer (box resize, move) from the snapshot taken before it. */
  recordFrom(before, kind) {
    this.stack.seal();
    this.stack.record(before, this.snapshot(), { kind, merge: false });
    this.stack.seal();
    this.session.placeholder = false;
  }

  /** Replaces the selection with str (typing, Tab, a forced line break). */
  insert(str, { kind = 'typing' } = {}) {
    const [a, b] = this.range();
    let content = M.replaceRange(this.layer.content, a, b, str);
    if (this.insertion && str) content = M.applyChar(content, a, a + str.length, this.insertion);
    const keep = this.insertion;
    const at = a + str.length;
    this.apply({ content }, { anchor: at, focus: at }, { kind });
    if (keep) {
      // the insertion style goes on formatting what is typed next at this caret
      this.insertion = keep;
      this.insertionAt = at;
    }
  }

  undo() {
    const s = this.stack.undo();
    if (s) this.restore(s);
    this.focus();
    return true;
  }

  redo() {
    const s = this.stack.redo();
    if (s) this.restore(s);
    this.focus();
    return true;
  }

  selectAll() {
    this.select(0, this.text.length);
  }

  copy({ cut = false } = {}) {
    const [a, b] = this.range();
    if (a === b) return false;
    const clip = makeClip(this.layer.content, a, b);
    setInAppClip(clip);
    bridge.writeClipboardText(clip.text);
    if (cut) this.apply({ content: M.deleteRange(this.layer.content, a, b) }, { anchor: a, focus: a }, { kind: 'cut', merge: false });
    return true;
  }

  /** Pastes the clipboard (formatted when the in-app clipboard is still current); `plain` drops the formatting. */
  async paste({ plain = false, text } = {}) {
    let sys = text;
    if (sys === undefined) {
      try {
        sys = await bridge.readClipboardText();
      } catch {
        sys = null;
      }
    }
    if (this.tool.session?.editor !== this) return false; // the session ended while the clipboard was read
    const paste = choosePaste(inAppClip(), sys, { plain });
    if (!paste) return false;
    const [a, b] = this.range();
    const style = paste.kind === 'plain' && this.insertion ? { ...M.charAttrs(this.layer.content, a, a), ...this.insertion } : undefined;
    const r = applyPaste(this.layer.content, a, b, paste, { style });
    this.apply({ content: r.content }, { anchor: r.caret, focus: r.caret }, { kind: 'paste', merge: false });
    this.stack.seal();
    this.focus();
    return true;
  }

  clear() {
    const [a, b] = this.range();
    if (a === b) return false;
    this.apply({ content: M.deleteRange(this.layer.content, a, b) }, { anchor: a, focus: a }, { kind: 'delete', merge: false });
    return true;
  }

  // ---- the TypeSession of lib/type/target.js (B.7) -----------------------------------------------------------------

  typeSession() {
    const [from, to] = this.range();
    const ed = this;
    const caretStyle = M.charAttrs(this.layer.content, from, from);
    return {
      layer: this.layer,
      from,
      to,
      insertionStyle: this.insertion && this.insertionAt === from ? M.resolveChar({ ...caretStyle, ...this.insertion }) : caretStyle,
      edit(fn, { label = 'Edit', merge = false } = {}) {
        const r = fn(ed.layer.content, from, to) ?? {};
        const next = {};
        if (r.content) next.content = r.content;
        if (r.typeOptions) next.typeOptions = r.typeOptions;
        if ('width' in r) next.width = r.width;
        if ('height' in r) next.height = r.height;
        const back = ed.sel.focus < ed.sel.anchor;
        const a = r.from ?? from, b = r.to ?? to;
        ed.apply(next, back ? { anchor: b, focus: a } : { anchor: a, focus: b }, { kind: `cmd:${label}`, merge: !!merge });
        if (!merge) ed.stack.seal();
        ed.tool.syncFromLayer?.();
      },
      setInsertionStyle(patch) {
        ed.insertion = { ...(ed.insertionAt === from ? ed.insertion ?? {} : {}), ...patch };
        ed.insertionAt = from;
        selectionChanged(ed.app);
      },
    };
  }

  // ---- input events ------------------------------------------------------------------------------------------------

  onBeforeInput(e) {
    this.adoptInputSelection();
    const t = e.inputType;
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      this.run(t === 'historyUndo' ? 'edit:undo' : 'edit:redo');
      return;
    }
    if (t === 'insertFromPaste' || t === 'insertFromDrop') {
      // a paste the platform delivers (a context menu, a drop): the clipboard rules of Ctrl+V with its text
      e.preventDefault();
      const text = e.dataTransfer?.getData?.('text/plain') ?? null;
      this.paste({ text });
      return;
    }
    const ta = this.input;
    this.pre = { a: ta.selectionStart, b: ta.selectionEnd, text: this.text };
  }

  onInput(e) {
    const ta = this.input;
    if (!ta) return;
    const old = this.pre?.text ?? this.text;
    const next = ta.value;
    const pre = this.pre ?? { a: ta.selectionStart, b: ta.selectionEnd };
    this.pre = null;
    if (old === next) {
      this.adoptInputSelection();
      return;
    }
    // the changed span: bounded by the selection before the input, so typing "l" after "Hel" in "Hello" inserts at 3
    let prefix = 0;
    const max = Math.min(old.length, next.length);
    while (prefix < max && old.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
    prefix = Math.min(prefix, Math.min(pre.a, pre.b));
    let suffix = 0;
    const room = Math.min(old.length - Math.max(prefix, Math.max(pre.a, pre.b)), next.length - prefix);
    while (suffix < room && old.charCodeAt(old.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
    const from = prefix, oldTo = old.length - suffix, inserted = next.slice(prefix, next.length - suffix);
    let content = M.replaceRange(this.layer.content, from, oldTo, inserted);
    if (this.insertion && inserted) content = M.applyChar(content, from, from + inserted.length, this.insertion);
    const keep = this.insertion;
    const composing = this.composing || e.isComposing;
    const kind = composing ? 'compose' : /^delete/.test(e.inputType ?? '') ? 'delete' : 'typing';
    const caret = ta.selectionEnd;
    if (this.composing) this.composing.to = Math.min(next.length, this.composing.from + (this.composing.len || inserted.length));
    // while an IME composes, apply() leaves the hidden input alone (syncInput) and the composition stays one step
    this.apply({ content }, { anchor: caret, focus: caret }, { kind });
    if (this.composing) this.placeInput();
    if (keep && inserted) {
      this.insertion = keep;
      this.insertionAt = caret;
    }
  }

  onCompositionStart() {
    this.adoptInputSelection();
    const [a] = this.range();
    this.stack.seal();
    this.composing = { from: a, to: a, len: 0 };
    this.invalidate();
  }

  onCompositionUpdate(e) {
    if (!this.composing) return;
    this.composing.len = (e.data ?? '').length;
    this.composing.to = this.composing.from + this.composing.len;
  }

  onCompositionEnd() {
    this.composing = null;
    this.stack.seal();
    this.syncInput();
    this.invalidate();
  }

  onKeyUp(e) {
    if ((e.key === 'Control' || e.key === 'Meta') && this.ctrlHeld) {
      this.ctrlHeld = false;
      this.invalidate();
    }
  }

  /** Runs a command through the registry as a key the editor took (B.8 (3) knows it ran). */
  run(id, arg) {
    this.dispatching++;
    let r;
    try {
      r = this.app.commands.run(id, arg, 'key');
    } finally {
      this.dispatching--;
    }
    this.ran.set(id, now());
    return r;
  }

  /** True when the editor's key handler ran `id` within ECHO_MS (the menu delivering the same accelerator). */
  ranRecently(id) {
    const t = this.ran.get(id);
    return t !== undefined && now() - t <= ECHO_MS;
  }

  onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return; // the IME owns the key
    this.adoptInputSelection();
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Control' || e.key === 'Meta') {
      if (!this.ctrlHeld) {
        this.ctrlHeld = true;
        this.invalidate();
      }
      return;
    }
    if (e.key === 'Escape') {
      stop();
      this.tool.cancelSession();
      return;
    }
    if (e.key === 'Enter' && (mod || e.code === 'NumpadEnter')) {
      stop();
      this.tool.commitSession();
      return;
    }
    // Photoshop's type keys (M.4) first: Shift+Ctrl+L aligns left here instead of running Auto Tone
    const typeCmd = typeCommandFor(e, isMac);
    if (typeCmd) {
      stop();
      this.run(typeCmd);
      return;
    }
    if (mod) {
      const cmd = commandForKey(e);
      if (cmd && (UNDO_LIKE.test(cmd) || ANSWERED.has(cmd)) && cmd !== 'edit:clear') {
        stop();
        this.run(cmd);
        return;
      }
      if (cmd && !PASSES_IN_TEXT.test(cmd)) {
        // Ctrl+I must not invert the image while typing: the key does nothing, and the menu's copy of the same
        // accelerator (Windows and Linux deliver both) is swallowed by the session's handle
        e.preventDefault();
        this.ran.set(cmd, now());
        return;
      }
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      stop();
      this.insert('\t');
      return;
    }
    if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) {
      // Shift+Enter: a forced line break inside the paragraph
      stop();
      this.insert('\u2028');
      return;
    }
    if (this.navigate(e)) stop();
  }

  /** Arrow keys, Home, End, Page Up / Down; with Shift they extend the selection. True when handled. */
  navigate(e) {
    const k = e.key;
    if (!/^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(k) || e.altKey) return false;
    const t = this.text;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const word = isMac ? false : e.ctrlKey;
    const [a, b] = this.range();
    const f = this.sel.focus;
    const collapse = !e.shiftKey && a !== b;
    let target = f, affinity = 'leading', keepGoal = false;
    const lay = this.layer.layout();
    const glyphs = isGlyphLayout(lay) || !lay.lines?.length;
    if (k === 'ArrowLeft') {
      if (collapse && !word) target = a;
      else if (isMac && mod) target = this.lineEdge(f, 'start', lay, glyphs).index;
      else target = word ? prevWord(t, f) : prevCluster(t, f);
    } else if (k === 'ArrowRight') {
      if (collapse && !word) target = b;
      else if (isMac && mod) ({ index: target, affinity } = this.lineEdge(f, 'end', lay, glyphs));
      else target = word ? nextWord(t, f) : nextCluster(t, f);
    } else if (k === 'Home' || k === 'End') {
      if (e.ctrlKey || e.metaKey) target = k === 'Home' ? 0 : t.length;
      else ({ index: target, affinity } = this.lineEdge(f, k === 'Home' ? 'start' : 'end', lay, glyphs));
    } else if (k === 'PageUp' || k === 'PageDown') target = k === 'PageUp' ? 0 : t.length;
    else {
      const up = k === 'ArrowUp';
      if (mod && isMac) target = up ? 0 : t.length;
      else if (mod) {
        // Ctrl+Up / Down: paragraph by paragraph
        const [ps, pe] = paragraphRange(t, f);
        target = up ? (f > ps ? ps : paragraphRange(t, Math.max(0, ps - 1))[0]) : pe < t.length ? paragraphRange(t, pe + 1)[1] : t.length;
      } else ({ index: target, affinity } = this.vertical(collapse ? (up ? a : b) : f, up ? -1 : 1, lay, glyphs));
      keepGoal = !mod;
    }
    if (e.shiftKey) this.select(this.sel.anchor, target, { affinity, keepGoal });
    else this.select(target, target, { affinity, keepGoal });
    return true;
  }

  /** Start or end of the line holding the caret: the laid-out line, or the logical one on a path (0.3 rule). */
  lineEdge(i, edge, lay, glyphs) {
    const t = this.text;
    if (glyphs) {
      const start = Math.max(t.lastIndexOf('\n', i - 1), t.lastIndexOf('\u2028', i - 1)) + 1;
      const ends = [t.indexOf('\n', i), t.indexOf('\u2028', i)].filter((x) => x !== -1);
      return { index: edge === 'start' ? start : ends.length ? Math.min(...ends) : t.length, affinity: 'leading' };
    }
    const line = lineAt(lay.lines, i, this.sel.affinity);
    if (!line) return { index: i, affinity: 'leading' };
    if (edge === 'start') return { index: line.from, affinity: 'leading' };
    // the end of a wrapped line is after its trailing spaces, shown on that line
    return { index: line.to, affinity: line.last ? 'leading' : 'trailing' };
  }

  /** Up / Down: the same column on the line above or below (the column kept while moving). */
  vertical(i, dir, lay, glyphs) {
    const t = this.text;
    if (glyphs) {
      // text on a path or stacked: logical lines
      const [ps, pe] = paragraphRange(t, i);
      const col = i - ps;
      if (dir < 0) {
        if (ps === 0) return { index: 0, affinity: 'leading' };
        const [qs, qe] = paragraphRange(t, ps - 1);
        return { index: Math.min(qs + col, qe), affinity: 'leading' };
      }
      if (pe >= t.length) return { index: t.length, affinity: 'leading' };
      const [qs, qe] = paragraphRange(t, pe + 1);
      return { index: Math.min(qs + col, qe), affinity: 'leading' };
    }
    const c = this.caretGeometry(i);
    if (this.goalX === null) this.goalX = c.x;
    const lines = lay.lines;
    const k = lines.findIndex((l) => l.index === c.line);
    const n = k + dir;
    if (n < 0) return { index: 0, affinity: 'leading' };
    if (n >= lines.length) return { index: t.length, affinity: 'leading' };
    const line = lines[n];
    const h = api.hitTest(this.layer, this.goalX, line.top + line.height / 2);
    return { index: Math.max(line.from, Math.min(line.to, h.index)), affinity: h.affinity ?? 'leading' };
  }

  // ---- pointer (called by the tool) --------------------------------------------------------------------------------

  /** A press inside the text: caret, Shift-extend, or the unit of a multi-click. */
  pointerDown(p) {
    const { index, affinity } = this.indexAt(p);
    const sx = p.screenX ?? 0, sy = p.screenY ?? 0;
    const count = nextClickCount(this.clicks, { t: now(), x: sx, y: sy });
    this.clicks = { t: now(), x: sx, y: sy, count };
    this.stack.seal();
    if (p.shift && count === 1) {
      this.dragUnit = { count: 1, unit: [this.sel.anchor, this.sel.anchor] };
      this.select(this.sel.anchor, index, { affinity });
    } else {
      const unit = this.unitAt(count, index, affinity);
      this.dragUnit = { count, unit };
      this.select(unit[0], unit[1], { affinity: count === 1 ? affinity : 'leading' });
    }
    this.focus();
  }

  pointerMove(p) {
    const d = this.dragUnit;
    if (!d) return;
    const { index, affinity } = this.indexAt(p);
    if (d.count === 1) this.select(d.unit[0], index, { affinity });
    else {
      const r = extendByUnit(d.unit, this.unitAt(d.count, index, affinity));
      this.select(r.anchor, r.focus);
    }
  }

  pointerUp() {
    this.dragUnit = null;
    this.focus();
  }

  unitAt(count, index, affinity) {
    const lay = this.layer.layout();
    const lines = isGlyphLayout(lay) ? null : lay.lines;
    return unitRange(count, this.text, index, { lines, affinity, locale: M.charStyleAt(this.layer.content, index).language });
  }

  // ---- the session's command handle (B.8) -----------------------------------------------------------------------

  /** Commands the session answers itself; undefined lets the command run (after the commit policy). */
  handle(id, arg, source) {
    const keyish = source === 'key' || source === 'menu-key';
    // (3) the menu's copy of an accelerator the editor's key handler already ran (Windows and Linux send both)
    if (keyish && !this.dispatching) {
      const typeId = typeKeyFor(id);
      if (this.ranRecently(id) || (typeId && this.ranRecently(typeId))) return {};
    }
    // (1) undo and the clipboard: the editor's own operations
    const def = this.app.commands.commands?.get?.(id);
    if (UNDO_LIKE.test(id) || def?.undoLike) {
      if (id === 'edit:redo' || id === 'edit:step-forward') return { result: this.redo() };
      if (id === 'edit:toggle-last-state') return { result: this.stack.canRedo && !this.stack.canUndo ? this.redo() : this.undo() };
      return { result: this.undo() };
    }
    switch (id) {
      case 'edit:cut': return { result: this.copy({ cut: true }) };
      case 'edit:copy': return { result: this.copy() };
      case 'edit:paste': return { result: this.paste() };
      case 'edit:paste-without-formatting': return { result: this.paste({ plain: true }) };
      case 'select:all':
      case 'edit:select-all': return { result: this.selectAll() };
      case 'edit:clear': return { result: this.clear() };
      default: break;
    }
    // (2) a menu accelerator that is also a type key (Shift+Ctrl+L: Align Left, not Auto Tone)
    if (keyish) {
      const typeId = typeKeyFor(id);
      if (typeId) {
        this.ran.set(typeId, now());
        return { result: this.app.commands.run(typeId, undefined, 'api') };
      }
    }
    return undefined;
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------

  /** Selection (inverted, as Photoshop shows it), composition underline and the blinking caret. */
  draw(ctx, view) {
    const layer = this.layer;
    const [a, b] = this.range();
    const quadOnScreen = (q) => q.points.map(([x, y]) => this.toScreen(x, y));
    ctx.save();
    if (a !== b && !this.hideSelection) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      for (const q of api.selectionRects(layer, a, b)) {
        const pts = quadOnScreen(q);
        ctx.beginPath();
        pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    const comp = this.composing;
    if (comp && comp.to > comp.from) {
      // the IME's text so far, underlined until it is committed
      ctx.strokeStyle = 'rgba(30,136,255,1)';
      ctx.lineWidth = 2;
      for (const q of api.selectionRects(layer, comp.from, comp.to)) {
        const pts = quadOnScreen(q);
        ctx.beginPath();
        ctx.moveTo(pts[3].x, pts[3].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.stroke();
      }
    }
    if (a === b && this.caretOn && document.activeElement === this.input) {
      const c = this.caretGeometry(this.sel.focus);
      const top = this.toScreen(c.x, c.y);
      const bx = c.x - Math.sin(c.angle) * c.height, by = c.y + Math.cos(c.angle) * c.height;
      const bottom = this.toScreen(bx, by);
      ctx.globalCompositeOperation = 'difference';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, Math.min(2, view.zoom));
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

const autoName = (text) => String(text ?? '').split(/[\n\u2028]/)[0].slice(0, 30) || 'Text';
export { autoName };

// ---- commands ----------------------------------------------------------------------------------------------------

/** Runs one TYPE_KEYS command on the type target (the editing session's selection, else the targeted layers). */
function runTypeCommand(app, id) {
  const def = TYPE_COMMANDS[id];
  if (!def) return false;
  const ed = activeEditor(app);
  const opts = { label: def.label, merge: true };
  if (def.editor === 'hide-selection') {
    if (!ed) return false;
    ed.hideSelection = !ed.hideSelection;
    ed.invalidate();
    return true;
  }
  if (def.para) return targetApplyPara(app, def.para(readPara(app)), opts), true;
  if (def.toggle) return targetApplyChar(app, def.toggle(readChar(app)), opts), true;
  const targets = typeTargets(app);
  if (def.kern !== undefined) {
    if (ed) {
      ed.typeSession().edit((content, from, to) => ({ content: kernStep(content, from, to, def.kern), from, to }), opts);
      return true;
    }
    // not editing: tracking of the whole text of every targeted layer
    editTypeLayers(app, targets.layers, (l) => ({ content: kernStep(l.content, 0, M.contentLength(l.content), def.kern) }), { ...opts, keys: ['tracking'] });
    return true;
  }
  if (def.run) {
    if (ed) {
      const s = ed.typeSession();
      if (s.from === s.to) {
        // a caret: the next typed characters get the stepped value
        const ctx = { autoLeading: M.paraAttrs(ed.layer.content, s.from, s.to).justification?.autoLeading };
        s.setInsertionStyle(def.run(s.insertionStyle, ctx));
        return true;
      }
      s.edit((content, from, to) => ({ content: mapCharRuns(content, from, to, def.run), from, to }), opts);
      return true;
    }
    editTypeLayers(app, targets.layers, (l) => ({ content: mapCharRuns(l.content, 0, M.contentLength(l.content), def.run) }), { ...opts, keys: [id] });
    return true;
  }
  return false;
}

/** The Alt-click dialog: the width and height of a new paragraph box (Photoshop's Paragraph Text Size). */
export async function boxSizeDialog(app, { width = 200, height = 100 } = {}) {
  const { formDialog } = await import('../form.js');
  const v = await formDialog(app, {
    title: 'Paragraph Text Size',
    width: 320,
    className: 'type-box-size',
    fields: [
      { key: 'width', label: 'Width', type: 'number', min: 1, max: 30000, step: 1, unit: 'px', value: Math.round(width) },
      { key: 'height', label: 'Height', type: 'number', min: 1, max: 30000, step: 1, unit: 'px', value: Math.round(height) },
    ],
  });
  if (!v) return null;
  const wv = Number(v.width), hv = Number(v.height);
  if (!(wv > 0) || !(hv > 0)) return null;
  return { width: wv, height: hv };
}

export function install(app) {
  // the selection provider of the type target (B.7): the editor of the open session
  setSelectionProvider({ active: (a) => activeEditor(a)?.typeSession() ?? null });

  // the 36 TYPE_KEYS commands (M.4, M.7); while editing the editor's key handler runs them, otherwise they act on the
  // selected text layers as a whole (one history entry, merged like the Character panel's)
  for (const id of Object.keys(TYPE_KEYS)) {
    app.commands.register(id, {
      label: TYPE_COMMANDS[id]?.label,
      enabled: () => (id === 'type:hide-selection' ? !!activeEditor(app) : !!activeEditor(app) || typeTargets(app).layers.length > 0),
      run: () => runTypeCommand(app, id),
    });
  }

  // Edit > Paste Special > Paste Without Formatting (M.3): while editing, the session's handle answers it (B.8); from
  // the menu there is no paste event, so the editor reads the clipboard through bridge.readClipboardText() (O)
  app.commands.register('edit:paste-without-formatting', {
    label: 'Paste Without Formatting',
    enabled: () => !!activeEditor(app),
    run: () => activeEditor(app)?.paste({ plain: true }) ?? false,
  });

  // L.7: double-clicking a text layer with the Move tool edits it at the click
  app.registerLayerDoubleClick?.('text', (layer, p) => {
    if (layer.locked?.all) return false;
    const vertical = (layer.typeOptions?.orientation ?? 'horizontal') === 'vertical';
    const id = vertical ? 'type-vertical' : 'type-horizontal';
    const tool = app.tools.get(id);
    if (!tool) return false;
    if (app.doc?.active !== layer) app.doc.setActive(layer);
    app.tools.activate(id);
    tool.beginEdit(layer, { at: p });
    return true;
  });

  // L.2: the "Type" Preferences section (placeholder text)
  app.preferences?.registerSection({
    id: 'type',
    title: 'Type',
    order: 35,
    fields: [{ key: 'typePlaceholder', label: 'Fill new type layers with placeholder text', type: 'checkbox', span: true }],
    read: (s) => ({ typePlaceholder: s.type?.placeholder !== false }),
    write: (values, s) => {
      const on = !!values.typePlaceholder;
      return on === (s.type?.placeholder !== false) ? {} : { type: { ...(s.type ?? {}), placeholder: on } };
    },
  });
}
