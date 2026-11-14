// CSV import / export for the planner and queues (pure functions, no DOM).
//
// Columns (header row required, any order, case-insensitive):
//   date (YYYY-MM-DD), time (HH:mm, account time zone), type (post|carousel|reel|story),
//   caption, first_comment, media (library file names, asset ids or http(s) links, separated by |),
//   status (draft|scheduled)
//
// A media link becomes a new library asset with importUrl set: the browser cannot fetch other sites
// (the page's Content-Security-Policy), so the worker downloads the file on its next run. Rows that
// use the same link share one asset, and a link already in the library (still downloading, or
// downloaded before: asset.sourceUrl) reuses that asset.

import { toCsv } from '../core/analytics.js';
import { isHttpUrl, kindFromUrl, nameFromUrl } from '../core/feed.js';
import { newAsset, newPost, uid, validatePost } from '../core/model.js';
import { addDaysKey, dayKey, pad, timeKey, zonedToUtc } from '../core/time.js';

export const CSV_COLUMNS = ['date', 'time', 'type', 'caption', 'first_comment', 'media', 'status'];
export const MAX_IMPORT_ROWS = 500;

const HEADER_ALIASES = {
  date: 'date',
  day: 'date',
  publish_date: 'date',
  time: 'time',
  hour: 'time',
  publish_time: 'time',
  type: 'type',
  post_type: 'type',
  format: 'type',
  caption: 'caption',
  text: 'caption',
  first_comment: 'first_comment',
  firstcomment: 'first_comment',
  comment: 'first_comment',
  media: 'media',
  files: 'media',
  file: 'media',
  media_files: 'media',
  images: 'media',
  assets: 'media',
  status: 'status',
};

const TYPE_IN = {
  post: 'feed',
  feed: 'feed',
  photo: 'feed',
  image: 'feed',
  single: 'feed',
  carousel: 'carousel',
  album: 'carousel',
  reel: 'reel',
  reels: 'reel',
  video: 'reel',
  story: 'story',
  stories: 'story',
};

/** Post type -> CSV value. */
export const TYPE_OUT = { feed: 'post', carousel: 'carousel', reel: 'reel', story: 'story' };

function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Parse CSV text (RFC 4180: quoted fields, doubled quotes, CRLF/LF/CR line breaks, BOM).
 * The delimiter (comma, semicolon or tab) is detected from the header line.
 * Rows that are completely empty are dropped. Returns string[][].
 */
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const delim = detectDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((v) => v.trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
      i++;
    } else if (ch === delim) {
      endField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

function normalizeHeader(h) {
  const key = String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '');
  return HEADER_ALIASES[key] || null;
}

/** Undo the spreadsheet formula guard our export adds ('=... -> =...). */
function unguard(v) {
  const s = String(v ?? '');
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function parseDate(raw) {
  const v = raw.trim().replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (!m) return null;
  const key = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  // Round-trip through calendar arithmetic rejects dates like 2026-02-31.
  return addDaysKey(key, 0) === key ? key : null;
}

function parseTime(raw) {
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = /^p/i.test(m[3]);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

/** Index library assets for name / id / link lookups (library order is newest first). */
export function assetIndex(assets = []) {
  const byId = new Map();
  const byName = new Map();
  const byBase = new Map();
  const byUrl = new Map();
  const push = (map, key, a) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  };
  for (const a of assets) {
    byId.set(a.id, a);
    push(byName, String(a.name || '').trim().toLowerCase(), a);
    push(byBase, stripExt(String(a.name || '').trim()).toLowerCase(), a);
    for (const url of [a.importUrl, a.sourceUrl]) if (url && !byUrl.has(url) && !a.importError) byUrl.set(url, a);
  }
  // Links of this import that become new assets (shared by every row that uses the same link).
  return { byId, byName, byBase, byUrl, created: new Map() };
}

const NOT_JPEG_EXT = /\.(png|webp|gif|heic|heif|avif|bmp|tiff?)(?:$|[?#])/i;

/** A new library asset the worker downloads from `url` (kind and name from the link). */
export function linkAsset(url, { tag = 'csv' } = {}) {
  const kind = kindFromUrl(url) || 'image';
  return newAsset({
    id: uid('a_'),
    kind,
    name: nameFromUrl(url),
    mime: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    importUrl: url,
    tags: [tag],
    createdAt: new Date().toISOString(),
  });
}

function resolveLink(t, index, tag) {
  if (!isHttpUrl(t)) return { error: `"${shorten(t)}" is not a web link. Links must start with http:// or https://.` };
  const url = new URL(t).href;
  const known = index.byUrl.get(url) || index.byUrl.get(t);
  if (known) return { asset: known };
  let asset = index.created.get(url);
  if (!asset) {
    asset = linkAsset(url, { tag });
    index.created.set(url, asset);
  }
  const ext = NOT_JPEG_EXT.exec(new URL(url).pathname);
  const warning = ext
    ? `"${shorten(nameFromUrl(url))}" looks like a ${ext[1].toUpperCase()} image. The worker can only post JPEG photos, so this download will fail unless the link actually serves a JPEG. Upload the file in the Library instead (it converts it).`
    : null;
  return { asset, created: true, warning };
}

function resolveMedia(token, index, { tag = 'csv' } = {}) {
  const t = token.trim();
  if (!t) return { asset: null };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return resolveLink(t, index, tag);
  if (index.byId.has(t)) return { asset: index.byId.get(t) };
  const lower = t.toLowerCase();
  const hits = index.byName.get(lower) || index.byBase.get(stripExt(lower)) || [];
  if (!hits.length) return { error: `No library file is named "${shorten(t)}".` };
  if (hits.length > 1) return { asset: hits[0], warning: `${hits.length} library files are named "${shorten(t)}"; using the newest one.` };
  return { asset: hits[0] };
}

function shorten(s, n = 40) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Read an import file into preview rows.
 * @param {string} text CSV text
 * @param {{assets: object[], tz: string, now?: Date|number}} opts
 * @returns {{error?: string, columns: string[], ignored: string[], rows: Array<{line: number, data: object,
 *   post: object|null, assets: object[], errors: string[], warnings: string[]}>, truncated: boolean}}
 */
export function readImport(text, { assets = [], tz = 'UTC', now = Date.now() } = {}) {
  const table = parseCsv(text);
  const empty = { columns: [], ignored: [], rows: [], truncated: false };
  if (!table.length) return { ...empty, error: 'The file is empty.' };
  const header = table[0];
  const map = header.map(normalizeHeader);
  const columns = [...new Set(map.filter(Boolean))];
  const ignored = header.filter((h, i) => !map[i] && String(h).trim()).map((h) => String(h).trim());
  if (!columns.includes('media')) {
    return {
      ...empty,
      columns,
      ignored,
      error: 'The first row must name the columns, including a "media" column. Download the template to see the format.',
    };
  }
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const index = assetIndex(assets);
  const assetsById = Object.fromEntries(assets.map((a) => [a.id, a]));
  const body = table.slice(1);
  const truncated = body.length > MAX_IMPORT_ROWS;
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((cells, r) => {
    const data = {};
    map.forEach((key, i) => {
      if (key && data[key] === undefined) data[key] = unguard(cells[i] ?? '');
    });
    for (const k of CSV_COLUMNS) if (data[k] === undefined) data[k] = '';
    return readRow(data, { line: r + 2, index, assetsById, tz, nowMs });
  });
  return { columns, ignored, rows, truncated };
}

/** Media cells of one row: library assets plus new link assets (and what to tell the owner about them). */
function readMediaCell(cell, index, tag) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const picked = [];
  const newAssets = [];
  for (const token of String(cell).split('|')) {
    const r = resolveMedia(token, index, { tag });
    if (r.error) errors.push(r.error);
    if (r.warning) warnings.push(r.warning);
    if (!r.asset) continue;
    picked.push(r.asset);
    if (r.created) {
      newAssets.push(r.asset);
      notes.push(`"${shorten(r.asset.name)}" will be downloaded by the worker from its link.`);
    } else if (r.asset.importUrl) {
      notes.push(`"${shorten(r.asset.name || 'A file')}" is already in the library and still downloading from its link.`);
    }
  }
  return { errors, warnings, notes, picked, newAssets };
}

/** validatePost's note about files still downloading is replaced by the clearer import notes. */
const isDownloadNote = (issue) => issue.field === 'media' && /still being downloaded/.test(issue.message);

function readRow(data, { line, index, assetsById, tz, nowMs }) {
  const { errors, warnings, notes, picked, newAssets } = readMediaCell(data.media, index, 'csv');
  if (!picked.length && !errors.length) errors.push('Add at least one library file or link in the media column.');

  let type;
  const rawType = String(data.type).trim().toLowerCase();
  if (rawType) {
    type = TYPE_IN[rawType];
    if (!type) errors.push(`Type "${shorten(String(data.type).trim(), 20)}" is not one of post, carousel, reel or story.`);
  } else {
    type = picked.length > 1 ? 'carousel' : picked[0]?.kind === 'video' ? 'reel' : 'feed';
  }

  const rawDate = String(data.date).trim();
  const rawTime = String(data.time).trim();
  const date = rawDate ? parseDate(rawDate) : null;
  const time = rawTime ? parseTime(rawTime) : null;
  if (rawDate && !date) errors.push(`Date "${shorten(rawDate, 20)}" is not valid. Use YYYY-MM-DD, for example 2026-03-14.`);
  if (rawTime && !time) errors.push(`Time "${shorten(rawTime, 20)}" is not valid. Use 24-hour HH:mm, for example 18:30.`);
  if (date && !rawTime) errors.push('Add a time (HH:mm) for this date.');
  if (!rawDate && rawTime) errors.push('Add a date (YYYY-MM-DD) for this time.');

  const rawStatus = String(data.status).trim().toLowerCase();
  let status;
  if (!rawStatus) status = date && time ? 'scheduled' : 'draft';
  else if (rawStatus === 'draft' || rawStatus === 'scheduled') status = rawStatus;
  else {
    status = 'draft';
    errors.push(`Status "${shorten(rawStatus, 20)}" must be draft or scheduled.`);
  }

  let scheduledAt = null;
  if (date && time) {
    const d = zonedToUtc(date, time, tz);
    if (Number.isNaN(d.getTime())) errors.push('This date and time do not exist in your time zone.');
    else scheduledAt = d.toISOString();
  }
  if (status === 'scheduled') {
    if (!scheduledAt && !errors.some((e) => /date|time/i.test(e))) errors.push('Scheduled posts need a date and a time.');
    else if (scheduledAt && new Date(scheduledAt).getTime() < nowMs) errors.push('This time has already passed. Pick a future time or import it as a draft.');
  }

  let post = null;
  if (type) {
    post = newPost({
      type,
      status,
      caption: String(data.caption ?? ''),
      firstComment: String(data.first_comment ?? ''),
      media: picked.map((a) => ({ assetId: a.id, kind: a.kind, altText: '' })),
      scheduledAt,
      source: 'csv',
    });
    post.history = [{ at: post.createdAt, event: 'created', detail: 'Imported from CSV.' }];
    if (picked.length) {
      const known = { ...assetsById, ...Object.fromEntries(newAssets.map((a) => [a.id, a])) };
      for (const issue of validatePost(post, known)) {
        if (issue.field === 'scheduledAt') continue; // handled above with a clearer message
        if (issue.field === 'media' && issue.message === 'Add a photo or video.') continue;
        if (isDownloadNote(issue)) continue;
        (issue.level === 'error' ? errors : warnings).push(issue.message);
      }
    }
  }
  const ok = !errors.length;
  return {
    line,
    data,
    post: ok ? post : null,
    assets: picked,
    newAssets: ok ? newAssets : [],
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    notes: ok ? [...new Set(notes)] : [], // a skipped row downloads nothing
    status,
    type,
    scheduledAt,
  };
}

/**
 * Read a CSV into queue items (same columns; date, time and status are ignored because the queue's
 * time slots decide when items post). Each row needs media; type is worked out from the media when
 * blank. Links in the media column become new assets the worker downloads.
 * @returns {{error?: string, ignored: string[], rows: Array<{line, data, item: object|null, assets, newAssets,
 *   errors, warnings, notes}>, truncated: boolean}}
 */
export function readQueueImport(text, { assets = [] } = {}) {
  const table = parseCsv(text);
  const empty = { ignored: [], rows: [], truncated: false };
  if (!table.length) return { ...empty, error: 'The file is empty.' };
  const header = table[0];
  const map = header.map(normalizeHeader);
  const ignored = header
    .filter((h, i) => !map[i] || ['date', 'time', 'status'].includes(map[i]))
    .map((h) => String(h).trim())
    .filter(Boolean);
  if (!map.includes('media')) {
    return { ...empty, ignored, error: 'The first row must name the columns, including "media" (and usually "caption"). Download the template to see the format.' };
  }
  const index = assetIndex(assets);
  const assetsById = Object.fromEntries(assets.map((a) => [a.id, a]));
  const body = table.slice(1);
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((cells, r) => {
    const data = {};
    map.forEach((key, i) => {
      if (key && data[key] === undefined) data[key] = unguard(cells[i] ?? '');
    });
    for (const k of CSV_COLUMNS) if (data[k] === undefined) data[k] = '';
    const { errors, warnings, notes, picked, newAssets } = readMediaCell(data.media, index, 'csv');
    if (!picked.length && !errors.length) errors.push('Add at least one library file or link in the media column.');
    const rawType = String(data.type).trim().toLowerCase();
    let type = rawType ? TYPE_IN[rawType] : picked.length > 1 ? 'carousel' : picked[0]?.kind === 'video' ? 'reel' : 'feed';
    if (rawType && !type) errors.push(`Type "${shorten(String(data.type).trim(), 20)}" is not one of post, carousel or reel.`);
    if (type === 'story') {
      errors.push('Queues post to the feed, so stories cannot go in a queue.');
      type = null;
    }
    const item = type
      ? {
          id: uid('li_'),
          type,
          caption: String(data.caption ?? ''),
          firstComment: String(data.first_comment ?? ''),
          media: picked.map((a) => ({ assetId: a.id, kind: a.kind, altText: '' })),
          timesUsed: 0,
          lastUsedAt: null,
          source: 'csv',
        }
      : null;
    if (item && picked.length) {
      const known = { ...assetsById, ...Object.fromEntries(newAssets.map((a) => [a.id, a])) };
      for (const issue of validatePost({ ...item, status: 'draft' }, known)) {
        if (isDownloadNote(issue) || (issue.field === 'media' && issue.message === 'Add a photo or video.')) continue;
        (issue.level === 'error' ? errors : warnings).push(issue.message);
      }
    }
    const ok = !errors.length;
    // A skipped row downloads nothing, so it gets no download notes.
    return { line: r + 2, data, item: ok ? item : null, assets: picked, newAssets: ok ? newAssets : [], errors: [...new Set(errors)], warnings: [...new Set(warnings)], notes: ok ? [...new Set(notes)] : [] };
  });
  return { ignored, rows, truncated: body.length > MAX_IMPORT_ROWS };
}

/** A template for queue imports: caption, first_comment, media (files or links), type. */
export function queueTemplateCsv(assets = []) {
  const images = assets.filter((a) => a.kind === 'image' && !a.importUrl && !String(a.name || '').includes('|'));
  const rows = [
    { caption: 'A favourite from the archive.\n\n#throwback', first_comment: '', media: images[0] ? images[0].name || images[0].id : 'photo-1.jpg', type: 'post' },
    { caption: 'Straight from our blog.', first_comment: 'Read it via the link in bio.', media: 'https://example.com/images/photo.jpg', type: 'post' },
  ];
  return toCsv(rows, ['caption', 'first_comment', 'media', 'type'].map((key) => ({ key })), { bom: true }) + '\r\n';
}

function mediaLabel(m, index, assetsById) {
  const a = assetsById[m.assetId];
  if (!a) return m.assetId;
  const name = String(a.name || '').trim();
  if (!name || name.includes('|')) return a.id;
  const same = index.byName.get(name.toLowerCase()) || [];
  return same.length === 1 ? name : a.id;
}

/** Upcoming posts (drafts and scheduled posts that are not in the past) in export order. */
export function upcomingPosts(posts = [], { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  return posts
    .filter((p) => (p.status === 'draft' || p.status === 'scheduled') && (!p.scheduledAt || new Date(p.scheduledAt).getTime() >= nowMs - 60_000))
    .sort((a, b) => {
      const ta = a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity;
      const tb = b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity;
      return ta - tb || String(a.id).localeCompare(String(b.id));
    });
}

function columnsFor(tz, index, assetsById) {
  return [
    { key: 'date', value: (p) => (p.scheduledAt ? dayKey(new Date(p.scheduledAt), tz) : '') },
    { key: 'time', value: (p) => (p.scheduledAt ? timeKey(new Date(p.scheduledAt), tz) : '') },
    { key: 'type', value: (p) => TYPE_OUT[p.type] || 'post' },
    { key: 'caption', value: (p) => p.caption || '' },
    { key: 'first_comment', value: (p) => p.firstComment || '' },
    { key: 'media', value: (p) => (p.media || []).map((m) => mediaLabel(m, index, assetsById)).join('|') },
    { key: 'status', value: (p) => (p.status === 'scheduled' ? 'scheduled' : 'draft') },
  ];
}

/** CSV text (with a UTF-8 BOM for spreadsheet apps) of upcoming posts, in the import format. */
export function exportCsv(posts, assets = [], { tz = 'UTC', now = Date.now() } = {}) {
  const index = assetIndex(assets);
  const assetsById = Object.fromEntries(assets.map((a) => [a.id, a]));
  return toCsv(upcomingPosts(posts, { now }), columnsFor(tz, index, assetsById), { bom: true }) + '\r\n';
}

/** A template with two example rows that use real library files when there are any. */
export function templateCsv(assets = [], { tz = 'UTC', now = Date.now() } = {}) {
  const images = assets.filter((a) => a.kind === 'image' && !String(a.name || '').includes('|'));
  const nameOf = (a, fallback) => (a ? a.name || a.id : fallback);
  const tomorrow = addDaysKey(dayKey(new Date(now), tz), 1);
  const later = addDaysKey(tomorrow, 2);
  const rows = [
    { date: tomorrow, time: '12:00', type: 'post', caption: 'New in the studio this week. Which one is your favourite?\n\n#handmade', first_comment: '', media: nameOf(images[0], 'photo-1.jpg'), status: 'scheduled' },
    { date: later, time: '18:30', type: 'carousel', caption: 'A few frames from the weekend.', first_comment: 'More in our stories.', media: [nameOf(images[1] || images[0], 'photo-2.jpg'), nameOf(images[2] || images[0], 'photo-3.jpg')].join('|'), status: 'draft' },
  ];
  return toCsv(rows, CSV_COLUMNS.map((key) => ({ key })), { bom: true }) + '\r\n';
}
