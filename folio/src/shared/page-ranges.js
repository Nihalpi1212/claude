// Page range parsing for dialogs such as "Extract pages" and "Print pages".
// Input is 1-based user text like "1-3, 5, 8-"; output is sorted unique 0-based indices.

/**
 * @param {string} text   e.g. "1-3,5,8-" ; "" or "all" selects every page
 * @param {number} pageCount
 * @returns {number[]} 0-based indices, ascending, unique
 * @throws {Error} with a readable message on bad input
 */
export function parsePageRanges(text, pageCount) {
  const count = Math.max(0, Math.floor(Number(pageCount) || 0));
  const cleaned = String(text ?? '').trim().toLowerCase();
  if (cleaned === '' || cleaned === 'all') return Array.from({ length: count }, (_, i) => i);
  const result = new Set();
  for (const part of cleaned.split(/[,\s;]+/)) {
    if (!part) continue;
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (m[1] === undefined && m[3] === undefined)) throw new Error(`"${part}" is not a page or range`);
    let from = m[1] !== undefined ? Number(m[1]) : 1;
    let to = m[2] ? (m[3] !== undefined ? Number(m[3]) : count) : from;
    if (from < 1 || to < 1 || from > count || to > count) throw new Error(`Page numbers must be between 1 and ${count}`);
    if (from > to) [from, to] = [to, from];
    for (let p = from; p <= to; p++) result.add(p - 1);
  }
  return [...result].sort((a, b) => a - b);
}

/** Formats 0-based indices as compact 1-based ranges: [0,1,2,4] -> "1-3, 5". */
export function formatPageRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}
