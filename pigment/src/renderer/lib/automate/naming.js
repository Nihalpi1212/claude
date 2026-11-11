// Automate: the pure helpers of Batch, Image Processor, Fit Image and Contact Sheet (no DOM, no app):
// file naming tokens, destination paths, fitting sizes and the contact sheet grid. Unit-tested in
// tests/unit/actions.test.mjs.

/** File naming fields of the Batch dialog (Photoshop's list). Anything else typed into a field is literal text. */
export const NAME_TOKENS = [
  ['name', 'Document Name'], ['name-lower', 'document name'], ['name-upper', 'DOCUMENT NAME'],
  ['serial-1', '1 Digit Serial Number'], ['serial-2', '2 Digit Serial Number'], ['serial-3', '3 Digit Serial Number'], ['serial-4', '4 Digit Serial Number'],
  ['letter-lower', 'Serial Letter (a, b, c…)'], ['letter-upper', 'Serial Letter (A, B, C…)'],
  ['mmddyy', 'mmddyy (date)'], ['mmdd', 'mmdd (date)'], ['yyyymmdd', 'yyyymmdd (date)'], ['yymmdd', 'yymmdd (date)'], ['yyddmm', 'yyddmm (date)'], ['ddmmyy', 'ddmmyy (date)'], ['ddmm', 'ddmm (date)'],
  ['ext', 'extension'], ['ext-upper', 'EXTENSION'], ['none', 'None'],
];
const TOKEN_IDS = new Set(NAME_TOKENS.map((t) => t[0]));
export const isNameToken = (t) => TOKEN_IDS.has(t);
export const DEFAULT_NAMING = ['name', 'ext', 'none', 'none', 'none', 'none'];

const pad = (n, len) => String(n).padStart(len, '0');

/** 1 -> a, 26 -> z, 27 -> aa (a spreadsheet column, so any number of files gets a letter). */
export function serialLetter(n) {
  let v = Math.max(1, Math.floor(n));
  let out = '';
  while (v > 0) {
    v--;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

/** Characters no file system Pigment runs on accepts in a name, replaced by '-'. */
export const sanitizeFileName = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');

export const splitName = (file) => {
  const base = String(file ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? { name: base.slice(0, dot), ext: base.slice(dot + 1) } : { name: base, ext: '' };
};

/**
 * Builds a file name from naming fields.
 * @param {string[]} tokens   token ids (NAME_TOKENS) or literal text, in order
 * @param {{ name: string, ext: string, serial: number, date?: Date }} ctx   `serial` is the file's number (starting serial + index)
 * The result always ends with the extension: a naming scheme without an extension field gets ".ext" appended,
 * so the format of the written file never depends on the scheme.
 */
export function buildFileName(tokens, { name, ext, serial = 1, date = new Date() }) {
  const d = { dd: pad(date.getDate(), 2), mm: pad(date.getMonth() + 1, 2), yy: pad(date.getFullYear() % 100, 2), yyyy: String(date.getFullYear()) };
  const e = String(ext ?? '').replace(/^\./, '');
  let hasExt = false;
  let out = '';
  for (const t of tokens ?? []) {
    if (t === undefined || t === null || t === '' || t === 'none') continue;
    switch (t) {
      case 'name': out += name; break;
      case 'name-lower': out += String(name).toLowerCase(); break;
      case 'name-upper': out += String(name).toUpperCase(); break;
      case 'serial-1': case 'serial-2': case 'serial-3': case 'serial-4': out += pad(serial, Number(t.slice(-1))); break;
      case 'letter-lower': out += serialLetter(serial); break;
      case 'letter-upper': out += serialLetter(serial).toUpperCase(); break;
      case 'mmddyy': out += d.mm + d.dd + d.yy; break;
      case 'mmdd': out += d.mm + d.dd; break;
      case 'yyyymmdd': out += d.yyyy + d.mm + d.dd; break;
      case 'yymmdd': out += d.yy + d.mm + d.dd; break;
      case 'yyddmm': out += d.yy + d.dd + d.mm; break;
      case 'ddmmyy': out += d.dd + d.mm + d.yy; break;
      case 'ddmm': out += d.dd + d.mm; break;
      case 'ext': if (e) out += `.${e.toLowerCase()}`; hasExt = true; break;
      case 'ext-upper': if (e) out += `.${e.toUpperCase()}`; hasExt = true; break;
      default: out += String(t);
    }
  }
  if (hasExt && e) {
    // the extension field must end the name to mean anything to the file system: text after it moves in front
    const lower = out.toLowerCase();
    const at = lower.lastIndexOf(`.${e.toLowerCase()}`);
    if (at >= 0 && at + e.length + 1 < out.length) out = out.slice(0, at) + out.slice(at + e.length + 1) + out.slice(at, at + e.length + 1);
  } else if (e) out += `.${e.toLowerCase()}`;
  const dot = e ? out.length - e.length - 1 : out.length;
  let stem = sanitizeFileName(out.slice(0, dot));
  if (!stem) stem = sanitizeFileName(name) || 'Untitled';
  return stem + out.slice(dot);
}

/** Does the scheme give every file its own name? (A scheme without the document name or a serial collides.) */
export function namingIsUnique(tokens) {
  return (tokens ?? []).some((t) => /^(name|name-lower|name-upper|serial-\d|letter-(lower|upper))$/.test(t));
}

/** `name` unless taken (case-insensitively, as on Windows and macOS); then "stem-2.ext", "stem-3.ext"… */
export function uniqueFileName(name, taken) {
  const has = (n) => taken.has(n.toLowerCase());
  if (!has(name)) return name;
  const { name: stem, ext } = splitName(name);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext ? `.${ext}` : ''}`;
    if (!has(candidate)) return candidate;
  }
}

export function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

export const dirName = (path) => {
  const s = String(path ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '';
};

/**
 * Size that fits (width, height) inside (maxWidth, maxHeight) keeping the proportions.
 * enlarge: false never scales up (Fit Image's "Don't Enlarge").
 */
export function fitSize(width, height, maxWidth, maxHeight, { enlarge = true } = {}) {
  const mw = Number(maxWidth) > 0 ? Number(maxWidth) : Infinity;
  const mh = Number(maxHeight) > 0 ? Number(maxHeight) : Infinity;
  let scale = Math.min(mw / width, mh / height);
  if (!Number.isFinite(scale)) scale = 1;
  if (!enlarge) scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * Contact sheet grid. All lengths in pixels.
 * @returns {{ cellWidth, cellHeight, imageHeight, captionHeight, perPage, cells: { x, y, width, height, captionY }[] }}
 *   one cell per position of a page (row-major, or column-major with across: false); `height` is the room
 *   for the thumbnail, the caption line sits below it at captionY (baseline box of captionHeight).
 */
export function contactSheetLayout({ width, height, columns, rows, spacing = 0, margin = spacing, caption = false, fontSize = 12, across = true }) {
  const cols = Math.max(1, Math.floor(columns)), rws = Math.max(1, Math.floor(rows));
  const gap = Math.max(0, spacing), m = Math.max(0, margin);
  const cellWidth = Math.max(1, Math.floor((width - 2 * m - gap * (cols - 1)) / cols));
  const cellHeight = Math.max(1, Math.floor((height - 2 * m - gap * (rws - 1)) / rws));
  const captionHeight = caption ? Math.min(cellHeight - 1, Math.ceil(fontSize * 1.5)) : 0;
  const imageHeight = Math.max(1, cellHeight - captionHeight);
  const cells = [];
  for (let i = 0; i < cols * rws; i++) {
    const c = across ? i % cols : Math.floor(i / rws);
    const r = across ? Math.floor(i / cols) : i % rws;
    const x = m + c * (cellWidth + gap), y = m + r * (cellHeight + gap);
    cells.push({ x, y, width: cellWidth, height: imageHeight, captionY: y + imageHeight });
  }
  return { cellWidth, cellHeight, imageHeight, captionHeight, perPage: cols * rws, cells };
}

/**
 * Where a thumbnail of an image goes inside a cell: centred, never enlarged beyond the cell; with
 * rotate: true a quarter turn is used when it makes the thumbnail larger ("Rotate For Best Fit").
 */
export function placeThumbnail(cell, imageWidth, imageHeight, { rotate = false } = {}) {
  const plain = fitSize(imageWidth, imageHeight, cell.width, cell.height);
  const turned = fitSize(imageHeight, imageWidth, cell.width, cell.height);
  const rotated = rotate && turned.scale > plain.scale * 1.001;
  const f = rotated ? turned : plain;
  return { x: cell.x + Math.round((cell.width - f.width) / 2), y: cell.y + Math.round((cell.height - f.height) / 2), width: f.width, height: f.height, rotated, scale: f.scale };
}

/** Splits a list into pages of `size`. */
export function paginate(list, size) {
  const pages = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) pages.push(list.slice(i, i + size));
  return pages;
}
