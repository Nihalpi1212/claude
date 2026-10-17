// PDF date strings: D:YYYYMMDDHHmmSSOHH'mm'  (PDF 32000-1 section 7.9.4)

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Formats a Date as a PDF date string in UTC, e.g. D:20261017153000Z */
export function toPdfDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Parses a PDF date string (with or without the D: prefix, any precision) into a Date, or null. */
export function fromPdfDate(text) {
  if (text instanceof Date) return isNaN(text) ? null : text;
  if (typeof text !== 'string') return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+\-])?(\d{2})?'?(\d{2})?'?/.exec(text.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tzSign, tzH = '00', tzM = '00'] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (isNaN(ms)) return null;
  if (tzSign === '+' || tzSign === '-') {
    const offset = (Number(tzH) * 60 + Number(tzM)) * 60 * 1000;
    ms += tzSign === '+' ? -offset : offset;
  }
  return new Date(ms);
}
