// type-editing (ARCHITECTURE.md "0.4 features", package 2; M.4 TYPE_KEYS): Photoshop's type keyboard shortcuts.
// The editor's hidden input has focus while text is edited, so shortcuts.js never sees these keys: the editor asks
// typeCommandFor(event) on every keydown and runs the command it names (registered by lib/type/editor.js, acting
// through lib/type/target.js). The command bodies below are pure (model in, patch out), so Node tests check them.
import { TYPE_KEYS, parseAccelerator, eventMatches } from '../../../shared/keymap.js';
import * as M from './model.js';

const TABLE = Object.entries(TYPE_KEYS).map(([id, accel]) => ({ id, desc: parseAccelerator(accel) }));
// more modifiers first, so Alt+Shift+Ctrl+. is not taken for Shift+Ctrl+.
TABLE.sort((a, b) => weight(b.desc) - weight(a.desc));
function weight(d) {
  return Number(d.shift) + Number(d.alt) + Number(d.cmdOrCtrl || d.ctrl || d.meta);
}

/** The TYPE_KEYS command a keydown asks for, or null. */
export function typeCommandFor(event, isMac = false) {
  for (const { id, desc } of TABLE) if (eventMatches(event, desc, isMac)) return id;
  return null;
}

const SIZE_STEP = 2; // px (M.4: Photoshop's 2 pt step, in the model's unit)
const LEADING_STEP = 2;
const KERN_STEP = 20; // 1/1000 em
const SHIFT_STEP = 2;

/** The leading in px a run shows: its own, or auto (the paragraph's auto leading percent of its size). */
export function leadingPx(style, autoLeading = M.PARA_DEFAULTS.justification.autoLeading) {
  if (style.leading !== 'auto' && Number.isFinite(style.leading)) return style.leading;
  return (style.size * (Number.isFinite(autoLeading) ? autoLeading : 120)) / 100;
}

const n2 = (v) => M.tidyNumber(v);

/**
 * What each command does. `run(style, ctx)` returns a character patch for one run (resolved style in; ctx.autoLeading
 * is the paragraph's auto leading); `toggle(attrs)` a patch decided from the selection's attributes (MIXED counts as
 * "off", so the first press turns the attribute on everywhere, as Photoshop does); `para(attrs)` a paragraph patch;
 * `kern` the kerning keys (kerning after the character before a caret, tracking on a range); `editor` the editor's
 * own state.
 */
export const TYPE_COMMANDS = {
  'type:size-up': { label: 'Font Size', run: (s) => ({ size: n2(s.size + SIZE_STEP) }) },
  'type:size-down': { label: 'Font Size', run: (s) => ({ size: n2(Math.max(0.1, s.size - SIZE_STEP)) }) },
  'type:size-up-10': { label: 'Font Size', run: (s) => ({ size: n2(s.size + SIZE_STEP * 5) }) },
  'type:size-down-10': { label: 'Font Size', run: (s) => ({ size: n2(Math.max(0.1, s.size - SIZE_STEP * 5)) }) },
  // Alt+Up tightens the lines (smaller leading), Alt+Down loosens them, as in Photoshop
  'type:leading-down': { label: 'Leading', run: (s, c) => ({ leading: n2(Math.max(0.1, leadingPx(s, c?.autoLeading) - LEADING_STEP)) }) },
  'type:leading-up': { label: 'Leading', run: (s, c) => ({ leading: n2(leadingPx(s, c?.autoLeading) + LEADING_STEP) }) },
  'type:leading-down-10': { label: 'Leading', run: (s, c) => ({ leading: n2(Math.max(0.1, leadingPx(s, c?.autoLeading) - LEADING_STEP * 5)) }) },
  'type:leading-up-10': { label: 'Leading', run: (s, c) => ({ leading: n2(leadingPx(s, c?.autoLeading) + LEADING_STEP * 5) }) },
  'type:kern-down': { label: 'Kerning', kern: -KERN_STEP },
  'type:kern-up': { label: 'Kerning', kern: KERN_STEP },
  'type:kern-down-100': { label: 'Kerning', kern: -KERN_STEP * 5 },
  'type:kern-up-100': { label: 'Kerning', kern: KERN_STEP * 5 },
  'type:baseline-up': { label: 'Baseline Shift', run: (s) => ({ baselineShift: n2(s.baselineShift + SHIFT_STEP) }) },
  'type:baseline-down': { label: 'Baseline Shift', run: (s) => ({ baselineShift: n2(s.baselineShift - SHIFT_STEP) }) },
  'type:baseline-up-10': { label: 'Baseline Shift', run: (s) => ({ baselineShift: n2(s.baselineShift + SHIFT_STEP * 5) }) },
  'type:baseline-down-10': { label: 'Baseline Shift', run: (s) => ({ baselineShift: n2(s.baselineShift - SHIFT_STEP * 5) }) },
  'type:align-left': { label: 'Align Left', para: () => ({ align: 'left' }) },
  'type:align-center': { label: 'Align Center', para: () => ({ align: 'center' }) },
  'type:align-right': { label: 'Align Right', para: () => ({ align: 'right' }) },
  'type:align-justify-left': { label: 'Justify Last Left', para: () => ({ align: 'justify-left' }) },
  'type:align-justify-all': { label: 'Justify All', para: () => ({ align: 'justify-all' }) },
  'type:toggle-faux-bold': { label: 'Faux Bold', toggle: (a) => ({ fauxBold: a.fauxBold !== true }) },
  'type:toggle-faux-italic': { label: 'Faux Italic', toggle: (a) => ({ fauxItalic: a.fauxItalic !== true }) },
  'type:toggle-underline': { label: 'Underline', toggle: (a) => ({ underline: a.underline !== true }) },
  'type:toggle-strike': { label: 'Strikethrough', toggle: (a) => ({ strike: a.strike !== true }) },
  'type:toggle-all-caps': { label: 'All Caps', toggle: (a) => ({ caps: a.caps === 'all' ? 'normal' : 'all' }) },
  'type:toggle-small-caps': { label: 'Small Caps', toggle: (a) => ({ caps: a.caps === 'small' ? 'normal' : 'small' }) },
  'type:toggle-superscript': { label: 'Superscript', toggle: (a) => ({ position: a.position === 'super' ? 'normal' : 'super' }) },
  'type:toggle-subscript': { label: 'Subscript', toggle: (a) => ({ position: a.position === 'sub' ? 'normal' : 'sub' }) },
  'type:reset-scale-x': { label: 'Horizontal Scale', toggle: () => ({ scaleX: 100 }) },
  'type:reset-scale-y': { label: 'Vertical Scale', toggle: () => ({ scaleY: 100 }) },
  'type:auto-leading': { label: 'Leading', toggle: () => ({ leading: 'auto' }) },
  'type:reset-tracking': { label: 'Tracking', toggle: () => ({ tracking: 0 }) },
  'type:toggle-hyphenation': { label: 'Hyphenate', para: (a) => ({ hyphenate: a.hyphenate !== true }) },
  'type:toggle-composer': { label: 'Composer', para: (a) => ({ composer: a.composer === 'single' ? 'every' : 'single' }) },
  'type:hide-selection': { label: 'Hide Selection', editor: 'hide-selection' },
};

/** Applies fn(resolvedStyle, ctx) -> patch to every run of [from, to) (each run keeps its own values). */
export function mapCharRuns(content, from, to, fn, ctx = {}) {
  let out = content;
  for (const r of M.runsIn(content, from, to)) {
    const patch = fn(r.style, { ...ctx, autoLeading: autoLeadingAt(content, r.from) });
    if (patch && Object.keys(patch).length) out = M.applyChar(out, r.from, r.to, patch);
  }
  return out;
}

function autoLeadingAt(content, index) {
  const p = M.paragraphs(content)[M.paraIndexAt(content, index)];
  return p?.style.justification?.autoLeading ?? M.PARA_DEFAULTS.justification.autoLeading;
}

/**
 * The kerning keys: at a caret (from === to), the manual kerning after the character before it changes by `delta`
 * (nothing at the very start); on a range, the tracking of every run changes by `delta`. Returns the new content.
 */
export function kernStep(content, from, to, delta) {
  const a = Math.min(from, to), b = Math.max(from, to);
  if (a === b) {
    if (a <= 0) return content;
    const cur = M.charStyleAt(content, a - 1).kern ?? 0;
    return M.applyChar(content, a - 1, a, { kern: n2(cur + delta) });
  }
  return mapCharRuns(content, a, b, (s) => ({ tracking: n2((s.tracking ?? 0) + delta) }));
}
