// Recent-files list logic (pure). Entries: { path, name, lastOpened, page?, zoom? }.
import { basename } from 'node:path';

export function normalizeRecent(stored) {
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of stored) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push({
      path: entry.path,
      name: typeof entry.name === 'string' && entry.name ? entry.name : basename(entry.path),
      lastOpened: Number.isFinite(entry.lastOpened) ? entry.lastOpened : 0,
      ...(Number.isFinite(entry.page) ? { page: entry.page } : {}),
      ...(entry.zoom !== undefined && entry.zoom !== null ? { zoom: entry.zoom } : {}),
    });
  }
  return out.sort((a, b) => b.lastOpened - a.lastOpened);
}

/** Returns a new list with the entry moved to the front (merging fields with any previous entry). */
export function addRecent(list, entry, limit = 20, now = Date.now()) {
  if (!entry || typeof entry.path !== 'string' || !entry.path) return normalizeRecent(list);
  const previous = normalizeRecent(list).find((e) => e.path === entry.path);
  const merged = {
    ...previous,
    ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null)),
    lastOpened: Number.isFinite(entry.lastOpened) ? entry.lastOpened : now,
  };
  const rest = normalizeRecent(list).filter((e) => e.path !== entry.path);
  return normalizeRecent([merged, ...rest]).slice(0, Math.max(1, limit));
}

export function removeRecent(list, path) {
  return normalizeRecent(list).filter((e) => e.path !== path);
}
