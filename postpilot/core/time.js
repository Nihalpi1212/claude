// Time-zone helpers built on Intl (no dependencies). All stored timestamps are
// UTC ISO strings; these helpers convert to and from the owner's time zone.

const dtfCache = new Map();
function partsFormatter(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return dtfCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `date` in `tz`: {year, month(1-12), day, hour, minute, second, weekday(0=Sun)} */
export function zonedParts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(d)) {
    if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock date/time in `tz` to a UTC Date. dateStr 'YYYY-MM-DD', timeStr 'HH:mm'. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let off = tzOffsetMs(new Date(guess), tz);
  let result = new Date(guess - off);
  // Second pass handles DST transitions.
  const off2 = tzOffsetMs(result, tz);
  if (off2 !== off) result = new Date(guess - off2);
  return result;
}

/** 'YYYY-MM-DD' for the calendar day of `date` in `tz`. */
export function dayKey(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'HH:mm' wall-clock time of `date` in `tz`. */
export function timeKey(date, tz) {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Shift a 'YYYY-MM-DD' key by n days (calendar arithmetic, tz-independent). */
export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of week (0=Sun) for a 'YYYY-MM-DD' key. */
export function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Inclusive list of day keys from `from` to `to`. */
export function dayRange(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDaysKey(k, 1)) out.push(k);
  return out;
}

/** Start of the zoned day as a UTC Date. */
export function startOfDay(key, tz) {
  return zonedToUtc(key, '00:00', tz);
}

export function format(date, tz, opts = {}) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(d);
}

export function formatDateTime(date, tz) {
  return format(date, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatTime(date, tz) {
  return format(date, tz, { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(date, tz) {
  return format(date, tz, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "in 3h", "2d ago" etc. */
export function relative(date, now = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  const units = [
    ['year', 365 * 864e5],
    ['month', 30 * 864e5],
    ['week', 7 * 864e5],
    ['day', 864e5],
    ['hour', 36e5],
    ['minute', 6e4],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return rtf.format(Math.round(diff / 1000), 'second');
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
