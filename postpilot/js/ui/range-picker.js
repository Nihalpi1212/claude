// Date range picker for Analytics and Reports: presets as menu rows (with their dates), an
// optional custom from/to pair, and the "compare with previous period" switch.
// Also exports the range math (resolveRange, previousRange) and query-string helpers so the
// range survives reloads and shared links.

import { html } from '../../vendor/preact.js';
import { addDaysKey, dayKey, dayRange } from '../../core/time.js';
import { Icon } from './icons.js';
import { Menu, Toggle, cx } from './kit.js';

export const RANGE_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '28d', label: 'Last 28 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastmonth', label: 'Last month' },
  { id: 'custom', label: 'Custom range' },
];

const PRESET_IDS = new Set(RANGE_PRESETS.map((p) => p.id));
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUSTOM_DAYS = 366;

function validKey(k) {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function keyDate(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const fmtCache = new Map();
function fmt(opts) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }));
  return fmtCache.get(k);
}

/** "Sep 14" for a day key. */
export function shortDay(key) {
  return validKey(key) ? fmt({ month: 'short', day: 'numeric' }).format(keyDate(key)) : '';
}

/** "Mon, Sep 14, 2026" for a day key. */
export function longDay(key) {
  return validKey(key) ? fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(keyDate(key)) : '';
}

/** "Sep 14 – Oct 11, 2026" (the year once when both ends share it). */
export function formatRangeLabel(fromKey, toKey) {
  if (!validKey(fromKey) || !validKey(toKey)) return '';
  if (fromKey === toKey) return fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(keyDate(fromKey));
  const sameYear = fromKey.slice(0, 4) === toKey.slice(0, 4);
  const a = fmt(sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(keyDate(fromKey));
  const b = fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(keyDate(toKey));
  return `${a} – ${b}`;
}

/** Number of days in an inclusive range. */
export function rangeLength(fromKey, toKey) {
  return validKey(fromKey) && validKey(toKey) && fromKey <= toKey ? dayRange(fromKey, toKey).length : 0;
}

/** The same-length window right before a range: { fromKey, toKey, days }. */
export function previousRange(fromKey, toKey) {
  const days = Math.max(1, rangeLength(fromKey, toKey));
  return { fromKey: addDaysKey(fromKey, -days), toKey: addDaysKey(fromKey, -1), days };
}

function lastDayOfMonth(key) {
  const [y, m] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m, 0));
  return `${key.slice(0, 7)}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Resolve a range selection to concrete day keys in `tz`.
 * "Last N days" end yesterday (complete days only); "This month" runs to today.
 * @param {{preset?: string, from?: string, to?: string}} sel
 * @param {string} tz
 * @param {Date|number} [now]
 * @returns {{preset, fromKey, toKey, days, label, presetLabel, today}}
 */
export function resolveRange(sel = {}, tz = 'UTC', now = new Date()) {
  const today = dayKey(now instanceof Date ? now : new Date(now), tz);
  const yesterday = addDaysKey(today, -1);
  const preset = PRESET_IDS.has(sel.preset) ? sel.preset : '28d';
  let fromKey;
  let toKey;
  switch (preset) {
    case '7d':
      toKey = yesterday;
      fromKey = addDaysKey(toKey, -6);
      break;
    case '90d':
      toKey = yesterday;
      fromKey = addDaysKey(toKey, -89);
      break;
    case 'month':
      fromKey = `${today.slice(0, 7)}-01`;
      toKey = today;
      break;
    case 'lastmonth': {
      const firstThis = `${today.slice(0, 7)}-01`;
      toKey = addDaysKey(firstThis, -1);
      fromKey = `${toKey.slice(0, 7)}-01`;
      break;
    }
    case 'custom': {
      let a = validKey(sel.from) ? sel.from : addDaysKey(yesterday, -27);
      let b = validKey(sel.to) ? sel.to : yesterday;
      if (a > b) [a, b] = [b, a];
      if (b > today) b = today;
      if (a > b) a = b;
      if (rangeLength(a, b) > MAX_CUSTOM_DAYS) a = addDaysKey(b, -(MAX_CUSTOM_DAYS - 1));
      fromKey = a;
      toKey = b;
      break;
    }
    default:
      toKey = yesterday;
      fromKey = addDaysKey(toKey, -27);
  }
  const presetLabel = RANGE_PRESETS.find((p) => p.id === preset).label;
  return { preset, fromKey, toKey, days: rangeLength(fromKey, toKey), label: formatRangeLabel(fromKey, toKey), presetLabel, today, lastDayOfMonth: lastDayOfMonth(toKey) };
}

/** Range selection from a route query ({range, from, to, compare}). */
export function rangeFromQuery(query = {}) {
  return {
    preset: PRESET_IDS.has(query.range) ? query.range : '28d',
    from: validKey(query.from) ? query.from : undefined,
    to: validKey(query.to) ? query.to : undefined,
  };
}

/** Query patch for a range selection (custom keeps from/to, presets clear them). */
export function rangeToQuery(sel) {
  const custom = sel.preset === 'custom';
  return { range: sel.preset === '28d' ? undefined : sel.preset, from: custom ? sel.from : undefined, to: custom ? sel.to : undefined };
}

/**
 * RangePicker {value: {preset, from?, to?}, onChange(sel), tz, compare?, onCompareChange?(bool), now?, class?}
 * The trigger reads "Last 28 days · Sep 14 – Oct 11"; the menu lists every preset with its dates.
 * Choosing "Custom range" reveals two native date inputs (max = today in tz).
 */
export function RangePicker({ value = {}, onChange, tz = 'UTC', compare, onCompareChange, now, class: cls }) {
  const r = resolveRange(value, tz, now);
  const items = RANGE_PRESETS.map((p) => {
    const pr = resolveRange({ ...value, preset: p.id }, tz, now);
    return {
      label: p.label,
      icon: p.id === r.preset ? 'check' : undefined,
      hint: p.id === 'custom' ? '' : formatRangeLabel(pr.fromKey, pr.toKey).replace(/, \d{4}$/, ''),
      onClick: () => onChange?.(p.id === 'custom' ? { preset: 'custom', from: r.fromKey, to: r.toKey } : { preset: p.id }),
    };
  });
  const setCustom = (patch) => {
    const next = { preset: 'custom', from: r.fromKey, to: r.toKey, ...patch };
    if (!validKey(next.from) || !validKey(next.to)) return;
    if (next.from > next.to) [next.from, next.to] = [next.to, next.from];
    onChange?.(next);
  };
  const trigger = (props) => html`<button type="button" class="btn btn-secondary range-trigger" ...${props} aria-label=${`Date range: ${r.presetLabel}, ${r.label}`}>
    <${Icon} name="calendar" size=${16} />
    <span class="range-trigger-label">${r.presetLabel}</span>
    <span class="range-trigger-dates">${r.label}</span>
    <${Icon} name="chevron-down" size=${16} />
  </button>`;
  return html`<div class=${cx('range-picker', cls)}>
    <${Menu} items=${items} trigger=${trigger} label="Date range" align="start" />
    ${r.preset === 'custom'
      ? html`<div class="range-custom" role="group" aria-label="Custom date range">
          <input type="date" class="input" aria-label="From" value=${r.fromKey} max=${r.today}
            onChange=${(e) => e.currentTarget.value && setCustom({ from: e.currentTarget.value })} />
          <span class="range-sep" aria-hidden="true">–</span>
          <input type="date" class="input" aria-label="To" value=${r.toKey} max=${r.today}
            onChange=${(e) => e.currentTarget.value && setCustom({ to: e.currentTarget.value })} />
        </div>`
      : null}
    ${onCompareChange ? html`<${Toggle} class="range-compare" checked=${!!compare} onChange=${(v) => onCompareChange(v)} label="Compare with previous period" />` : null}
  </div>`;
}
