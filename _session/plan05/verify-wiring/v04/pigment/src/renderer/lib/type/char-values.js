// Character panel values (type-character-panel, ARCHITECTURE.md "0.4 features", package 3): type units, the preset
// lists, what a field shows for mixed values, Reset Character and the language list. Pure: no DOM, so Node tests
// check the numbers. The model stores px (A); the panels show and take pt, px or mm (settings.type.unit), converted
// with the document resolution.
import * as M from './model.js';

export const TYPE_UNITS = Object.freeze(['px', 'pt', 'mm']);
export const UNIT_NAMES = Object.freeze({ px: 'Pixels', pt: 'Points', mm: 'Millimeters' });

/** settings.type.unit, checked ('px' when missing or unknown). */
export function typeUnit(settings) {
  const u = settings?.type?.unit;
  return TYPE_UNITS.includes(u) ? u : 'px';
}

const goodDpi = (dpi) => (Number(dpi) > 0 ? Number(dpi) : 72);

/** px -> the unit (pt = 1/72 in, mm = 1/25.4 in at the document resolution). */
export function toUnit(px, unit, dpi = 72) {
  const v = Number(px);
  if (!Number.isFinite(v)) return v;
  if (unit === 'pt') return (v * 72) / goodDpi(dpi);
  if (unit === 'mm') return (v * 25.4) / goodDpi(dpi);
  return v;
}

/** The unit -> px. */
export function fromUnit(value, unit, dpi = 72) {
  const v = Number(value);
  if (!Number.isFinite(v)) return v;
  if (unit === 'pt') return (v * goodDpi(dpi)) / 72;
  if (unit === 'mm') return (v * goodDpi(dpi)) / 25.4;
  return v;
}

/** A number as a field shows it: at most `decimals` places, no trailing zeros, no "-0". */
export function formatNumber(v, decimals = 2) {
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 10 ** decimals) / 10 ** decimals;
  return String(r === 0 ? 0 : r);
}

/** A length (px) for a field in `unit`: '' for MIXED or missing. */
export function showLength(px, unit, dpi, decimals = 2) {
  if (px === M.MIXED || px === undefined || px === null || !Number.isFinite(Number(px))) return '';
  return formatNumber(toUnit(Number(px), unit, dpi), decimals);
}

/** A plain number for a field ('' for MIXED). */
export function showNumber(v, decimals = 2) {
  if (v === M.MIXED || v === undefined || v === null || !Number.isFinite(Number(v))) return '';
  return formatNumber(Number(v), decimals);
}

// Photoshop's lists: font sizes 6..72 (shown in the current unit; for mm the point sizes converted, since 6..72 mm
// would be poster sizes), tracking and kerning values in 1/1000 em
export const SIZE_PRESETS = Object.freeze([6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72]);
export const SPACING_PRESETS = Object.freeze([-100, -75, -50, -25, -10, -5, 0, 5, 10, 25, 50, 75, 100, 200]);

/** The size list in a unit: [{ label, px }]. */
export function sizePresets(unit, dpi = 72) {
  return SIZE_PRESETS.map((n) => {
    const px = unit === 'mm' ? fromUnit(n, 'pt', dpi) : fromUnit(n, unit, dpi);
    const shown = unit === 'mm' ? formatNumber(toUnit(px, 'mm', dpi), 2) : String(n);
    return { label: `${shown} ${unit}`, px };
  });
}

/** What the leading field shows: 'auto' (the field shows "Auto"), '' (mixed) or the length in the unit. */
export function showLeading(v, unit, dpi) {
  if (v === 'auto') return 'auto';
  return showLength(v, unit, dpi);
}

/** The state of a toggle button for an attribute: true, false or 'mixed'. */
export function toggleState(attrs, key, on = true) {
  const v = attrs?.[key];
  if (v === M.MIXED) return 'mixed';
  return v === on;
}

/** The style select's value for weight and italic ('' when either is mixed). */
export function styleValue(attrs) {
  if (!attrs || attrs.fontWeight === M.MIXED || attrs.fontItalic === M.MIXED) return '';
  return `${attrs.fontWeight ?? 400}${attrs.fontItalic ? 'i' : ''}`;
}

/** The character patch of a style select value ('700i' -> bold italic); the exact face (postScriptName) is dropped. */
export function styleToChar(value) {
  const s = String(value ?? '400');
  return { fontWeight: parseInt(s, 10) || 400, fontItalic: s.endsWith('i'), postScriptName: undefined };
}

/**
 * Reset Character: every attribute of the Character panel back to its default, except the face, the size and the
 * colour (what the options bar sets) and Pigment's text stroke. Keys set to undefined reset to CHAR_DEFAULTS (A).
 */
export const RESET_KEEPS = Object.freeze(['fontFamily', 'fontWeight', 'fontItalic', 'postScriptName', 'size', 'color', 'stroke']);
export function resetCharacterPatch() {
  const patch = {};
  for (const k of M.CHAR_KEYS) if (!RESET_KEEPS.includes(k)) patch[k] = undefined;
  return patch;
}

/** The languages the runs of the given contents use (BCP 47 tags, in first-seen order). */
export function documentLanguages(contents) {
  const out = [];
  for (const c of contents ?? []) {
    if (!c) continue;
    const runs = c.text.length ? M.runsIn(c, 0, c.text.length) : [{ style: M.charStyleAt(c, 0) }];
    for (const r of runs) if (r.style.language && !out.includes(r.style.language)) out.push(r.style.language);
  }
  return out;
}

/** A readable name of a language tag ('en-US' -> 'English (United States)'), the tag itself when unknown. */
export function languageName(tag) {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The Language list (package 3: the languages a hyphenator covers plus those the document's text uses, plus the
 * current one): [{ value, label }] sorted by label; the default language is always there.
 */
export function languageOptions(hyphenationLangs, docLangs, current) {
  const tags = new Set([M.CHAR_DEFAULTS.language]);
  for (const t of hyphenationLangs ?? []) if (t) tags.add(t);
  for (const t of docLangs ?? []) if (t) tags.add(t);
  if (current && current !== M.MIXED) tags.add(current);
  return [...tags].map((value) => ({ value, label: languageName(value) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** The leading in px a field shows for a resolved style (auto: the paragraph's auto leading of the size). */
export function autoLeadingPx(size, autoLeading = M.PARA_DEFAULTS.justification.autoLeading) {
  return (Number(size) * (Number.isFinite(autoLeading) ? autoLeading : 120)) / 100;
}
