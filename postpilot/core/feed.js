// Feeds and linked media (pure, environment-neutral): a tolerant XML scanner, RSS 2.0 / RSS 1.0 (RDF) /
// Atom parsing, og:image lookup in web pages, and byte sniffing for files the worker downloads
// (JPEG size and orientation, JPEG metadata stripping, PNG/WebP/GIF/HEIC/MP4/MOV detection).
//
// No DOMParser (the worker runs in Node), no regular-expression XML parsing of whole documents: the
// scanner walks the text once, keeps going after malformed markup and never throws on bad input.

import { LIMITS } from './model.js';

// ---------------------------------------------------------------------------
// Entities and text

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sect: '§', para: '¶',
  iexcl: '¡', iquest: '¿', shy: '', zwj: '‍', zwnj: '‌', thinsp: ' ', ensp: ' ', emsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ntilde: 'ñ', Ntilde: 'Ñ', ccedil: 'ç', Ccedil: 'Ç', aring: 'å', Aring: 'Å',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', atilde: 'ã', otilde: 'õ',
};

/** Decode XML/HTML character references (&amp; &#39; &#x27; and common named entities). Unknown ones stay as they are. */
export function decodeEntities(text) {
  const s = String(text ?? '');
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (all, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : all;
  });
}

// Tags whose content is not text (dropped up to their end tag).
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg']);
// End tags that end a paragraph.
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'section', 'article', 'header', 'footer', 'figure', 'ul', 'ol', 'table', 'pre']);
// Inline tags vanish without leaving a space ("<em>tucked</em>." stays "tucked.").
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'del', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
// WordPress appends "The post <title> appeared first on <site>." to every feed summary.
const WP_FOOTER = /^The post .{1,300} appeared first on .{1,200}\.$/;
// Captions are 2,200 characters at most; this much HTML is plenty and bounds the work on hostile input.
const STRIP_MAX = 256 * 1024;

/**
 * Plain text from an HTML fragment: scripts, styles and comments removed, tags dropped, entities
 * decoded, paragraphs kept as blank lines and other whitespace collapsed. One pass over the text
 * (no backtracking regular expressions), so unclosed comments or tags in a hostile feed stay cheap.
 */
export function stripHtml(html) {
  let s = String(html ?? '');
  if (s.length > STRIP_MAX) s = s.slice(0, STRIP_MAX);
  const lower = s.toLowerCase();
  const unclosed = new Set(); // raw-text tags with no end tag left in the text
  let out = '';
  let i = 0;
  let gt = -1; // first '>' after the current '<' (reused while it is still ahead)
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end < 0) break; // an unclosed comment hides the rest, as in a browser
      out += ' ';
      i = end + 3;
      continue;
    }
    const m = /^<(\/?)([a-z][a-z0-9-]*)|^<[!?]/i.exec(s.slice(lt, lt + 40));
    if (!m) {
      out += '<'; // "5 < 6": not a tag
      i = lt + 1;
      continue;
    }
    if (gt <= lt) gt = s.indexOf('>', lt + 1);
    if (gt < 0) {
      out += s.slice(lt); // no tag can end any more: the rest is text
      break;
    }
    i = gt + 1;
    const name = (m[2] || '').toLowerCase();
    if (!name) {
      out += ' '; // <!DOCTYPE …>, <?xml …?>
      continue;
    }
    const closing = m[1] === '/';
    if (!closing && RAW_TEXT.has(name) && s[gt - 1] !== '/' && !unclosed.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const close = end < 0 ? -1 : s.indexOf('>', end);
      if (close >= 0) {
        out += ' ';
        i = close + 1;
        continue;
      }
      unclosed.add(name);
    }
    if (name === 'br') out += '\n';
    else if (closing && BLOCK_TAGS.has(name)) out += '\n\n';
    else if (!INLINE_TAGS.has(name)) out += ' ';
  }
  // Collapse runs of spaces first: the paragraph clean-up below then only meets single spaces.
  const text = decodeEntities(out).replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ');
  return text
    .split(/\n{2,}/)
    .map((para) => para.replace(/ ?\n ?/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter((para) => para && !WP_FOOTER.test(para))
    .join('\n\n');
}

/** Cut text to at most n characters at a word boundary, ending with "…". */
export function clipText(text, n) {
  const s = String(text ?? '').trim();
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, Math.max(0, n));
  const cut = s.slice(0, n - 1);
  // Cut at the last space unless the cut already ends a word.
  const space = /\s/.test(s[n - 1]) ? cut.length : cut.search(/\s\S*$/);
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// XML scanner

const MAX_DEPTH = 200;
// Bounds on hostile input; real feeds stay far below them. Elements past MAX_ELEMENTS end the parse
// (feeds list their newest items first); attributes past MAX_ATTRS in one tag are skipped.
const MAX_ELEMENTS = 200_000;
const MAX_ATTRS = 64;

/**
 * Parse XML into a small element tree. Tolerant: unknown entities stay as text, unclosed elements
 * are closed at the end, stray end tags are ignored, attributes may be unquoted, a DOCTYPE (with an
 * internal subset) is skipped. Element objects:
 *   { name: 'media:content', local: 'content', prefix: 'media', ns: 'http://search.yahoo.com/mrss/',
 *     attrs: {url: '...'}, children: [Element], text: 'direct text', start, end }
 * `start`/`end` are offsets of the element's inner source (for raw XHTML content). Elements nested
 * deeper than MAX_DEPTH are dropped (their text is kept); after MAX_ELEMENTS elements the rest of the
 * document is ignored (`truncated`).
 * Namespace prefixes in scope live on a stack beside the open elements, not on the elements: an
 * element that declares none shares its parent's scope, one that does gets a scope inheriting from
 * its parent's (prototype chain), so cost stays linear in the input however many prefixes a feed declares.
 * @param {string} source
 * @returns {{root: object, source: string, truncated: boolean}} root is a synthetic element holding the top-level elements
 */
export function parseXml(source) {
  const src = String(source ?? '').replace(/^﻿/, '');
  const root = { name: '#root', local: '#root', prefix: '', ns: '', attrs: {}, children: [], text: '', start: 0, end: src.length };
  const stack = [root];
  const scopes = [Object.create(null)]; // scopes[k]: prefixes in scope inside stack[k] ('' = default namespace)
  let elements = 0;
  let stop = src.length; // where parsing ended (before src.length when MAX_ELEMENTS was reached)
  let i = 0;
  const top = () => stack[stack.length - 1];
  const addText = (t) => {
    if (t) top().text += t;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      addText(src.slice(lt + 9, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE or other declaration; skip a bracketed internal subset.
      let j = lt + 2;
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === '>' && depth === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim();
      i = end < 0 ? src.length : end + 1;
      // Close the nearest open element with this name; ignore stray end tags.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          for (let m = stack.length - 1; m >= k; m--) if (stack[m].end == null) stack[m].end = lt;
          stack.length = k;
          scopes.length = k;
          break;
        }
      }
      continue;
    }
    // Start tag: name, attributes, optional self-close. Attribute values may contain '>'.
    const m = /^<([A-Za-z_][\w.:-]*)/.exec(src.slice(lt, lt + 256));
    if (!m) {
      addText('<');
      i = lt + 1;
      continue;
    }
    let j = lt + m[0].length;
    const attrs = {};
    let attrCount = 0;
    let selfClose = false;
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      const an = /^[^\s=/>]+/.exec(src.slice(j, j + 256));
      if (!an) {
        j++;
        continue;
      }
      j += an[0].length;
      while (j < src.length && /\s/.test(src[j])) j++;
      let value = '';
      if (src[j] === '=') {
        j++;
        while (j < src.length && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const close = src.indexOf(q, j + 1);
          value = src.slice(j + 1, close < 0 ? src.length : close);
          j = close < 0 ? src.length : close + 1;
        } else {
          const raw = /^[^\s>]+/.exec(src.slice(j, j + 4096));
          value = raw ? raw[0] : '';
          j += value.length;
          if (value.endsWith('/') && src[j] === '>') {
            value = value.slice(0, -1); // <img src=a.jpg/>: the slash closes the tag
            j -= 1;
          }
        }
      }
      if (attrCount++ < MAX_ATTRS) attrs[an[0]] = decodeEntities(value);
    }
    // Past MAX_DEPTH, elements are not nested further (their text goes to the deepest element):
    // real feeds never come close, and it keeps end-tag lookups cheap on hostile input.
    if (stack.length > MAX_DEPTH) {
      i = j;
      continue;
    }
    if (++elements > MAX_ELEMENTS) {
      stop = lt;
      break;
    }
    const parent = top();
    const parentScope = scopes[scopes.length - 1];
    let scope = parentScope;
    for (const k of Object.keys(attrs)) {
      if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
      if (scope === parentScope) scope = Object.create(parentScope);
      scope[k === 'xmlns' ? '' : k.slice(6)] = attrs[k];
    }
    const name = m[1];
    const colon = name.indexOf(':');
    const prefix = colon > 0 ? name.slice(0, colon) : '';
    const ns = scope[prefix];
    const el = {
      name,
      local: (colon > 0 ? name.slice(colon + 1) : name).toLowerCase(),
      prefix: prefix.toLowerCase(),
      ns: typeof ns === 'string' ? ns : '',
      attrs,
      children: [],
      text: '',
      start: j,
      end: selfClose ? j : null,
    };
    parent.children.push(el);
    if (!selfClose) {
      stack.push(el);
      scopes.push(scope);
    }
    i = j;
  }
  for (let k = stack.length - 1; k > 0; k--) if (stack[k].end == null) stack[k].end = stop;
  return { root, source: src, truncated: stop < src.length };
}

/** All text inside an element (its own and its descendants', in document order). No recursion. */
function textOf(el) {
  if (!el) return '';
  let out = '';
  const stack = [el];
  while (stack.length) {
    const e = stack.pop();
    out += e.text;
    for (let k = e.children.length - 1; k >= 0; k--) stack.push(e.children[k]);
  }
  return out;
}

/** Raw inner markup of an element with CDATA unwrapped (for HTML in descriptions and XHTML content). */
function innerHtml(el, source) {
  if (!el) return '';
  if (!el.children.length) return el.text;
  const raw = source.slice(el.start, el.end ?? el.start);
  // CDATA sections hold HTML as-is; text outside them is XML-escaped HTML.
  return raw
    .split(/(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))/)
    .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9).replace(/\]\]>$/, '') : part))
    .join('');
}

const NS = {
  atom: 'http://www.w3.org/2005/atom',
  media: 'search.yahoo.com/mrss',
  content: 'purl.org/rss/1.0/modules/content',
  dc: 'purl.org/dc/elements/1.1',
};

function inNs(el, key) {
  const ns = el.ns.toLowerCase();
  if (key === 'atom') return ns === NS.atom || ns === 'http://purl.org/atom/ns#' || (!ns && el.prefix === 'atom');
  if (ns) return ns.includes(NS[key]);
  return el.prefix === key;
}

const children = (el, pred) => (el ? el.children.filter(pred) : []);
const child = (el, pred) => (el ? el.children.find(pred) : undefined);
const named = (local, ns) => (e) => e.local === local && (ns === undefined ? true : ns === '' ? !e.prefix || inNs(e, 'atom') : inNs(e, ns));
const plain = (local) => (e) => e.local === local && !e.prefix;

// ---------------------------------------------------------------------------
// URLs and dates

/** Absolute http(s) URL for href relative to base, or '' when it is not a web address. */
export function resolveUrl(href, base) {
  const h = decodeEntities(String(href ?? '').trim());
  if (!h) return '';
  let u = null;
  try {
    u = new URL(h);
  } catch {
    try {
      u = base ? new URL(h, base) : null;
    } catch {
      u = null;
    }
  }
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
}

/** True for an absolute http:// or https:// URL. */
export function isHttpUrl(value) {
  try {
    const u = new URL(String(value ?? '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/** ISO string from an RSS (RFC 822) or Atom (ISO 8601) date, or null. */
export function parseFeedDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isFinite(t)) {
    // "Mon, 12 Oct 2026 10:00:00 +0200 (CEST)" and other trailing comments.
    t = Date.parse(s.replace(/\s*\([^)]*\)\s*$/, '').replace(/^[A-Za-z]{3,9},?\s*/, ''));
  }
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif)(?:$|[?#])/i;
const VIDEO_EXT = /\.(mp4|m4v|mov)(?:$|[?#])/i;

/** 'image' | 'video' | null from a URL's file extension. */
export function kindFromUrl(url) {
  let path = String(url ?? '');
  try {
    path = new URL(path).pathname;
  } catch {
    /* keep as is */
  }
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  return null;
}

/** A short file name for a URL: the last path segment, decoded ("photo.jpg"), else the host name. */
export function nameFromUrl(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      /* keep encoded */
    }
    name = name.replace(/[\u0000-\u001f]/g, '').trim();
    return (name || u.hostname.replace(/^www\./, '')).slice(0, 120);
  } catch {
    return 'Linked file';
  }
}

// ---------------------------------------------------------------------------
// Feeds

// Instagram scales photos narrower than 320 px up, so smaller declared sizes are thumbnails or icons.
const MIN_IMAGE_SIDE = 320;
// Tracking pixels and feed-burner style counters.
const TRACKER = /\b(feeds\.feedburner\.com\/~r|pixel|tracking|1x1|spacer)\b/i;
const FORMAT_BY_TYPE = { 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/heic': 'HEIC', 'image/heif': 'HEIC', 'image/svg+xml': 'SVG', 'image/bmp': 'BMP', 'image/tiff': 'TIFF' };
const FORMAT_BY_EXT = { png: 'PNG', webp: 'WebP', gif: 'GIF', avif: 'AVIF', heic: 'HEIC', heif: 'HEIC', svg: 'SVG', bmp: 'BMP', tif: 'TIFF', tiff: 'TIFF' };

/**
 * The format of an image link when it is known not to be JPEG ('PNG', 'WebP', 'GIF', ...): from the
 * declared MIME type, else the file extension. '' when it may be a JPEG. The worker can only post
 * JPEG photos, so such links are not worth downloading.
 */
export function nonJpegFormat(url, type = '') {
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  if (t.startsWith('image/')) return FORMAT_BY_TYPE[t] || '';
  let path = String(url ?? '');
  try {
    path = new URL(path).pathname;
  } catch {
    /* keep as is */
  }
  const ext = /\.([a-z0-9]{3,4})$/i.exec(path);
  return (ext && FORMAT_BY_EXT[ext[1].toLowerCase()]) || '';
}

/** Author avatars and emoji images are never the picture of a post (gravatar.com, /avatar/ paths, WordPress emoji). */
function isIconUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)gravatar\.com$/i.test(u.hostname) || /\/avatars?\//i.test(u.pathname) || /\/images\/core\/emoji\//i.test(u.pathname);
  } catch {
    return true;
  }
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/**
 * Attributes of one start tag (names lower-cased, entities decoded; names without a value are left
 * out). One pass over the text, so a long run of junk in a hostile page stays cheap.
 */
function tagAttrs(tag) {
  const attrs = {};
  const s = String(tag ?? '');
  const n = s.length;
  let i = 0;
  let count = 0;
  while (i < n && count < MAX_ATTRS) {
    while (i < n && (isSpace(s[i]) || s[i] === '/' || s[i] === '>' || s[i] === '=')) i++;
    const from = i;
    while (i < n && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '/' && s[i] !== '>') i++;
    if (i === from) continue;
    const name = s.slice(from, i).toLowerCase();
    while (i < n && isSpace(s[i])) i++;
    if (s[i] !== '=') continue;
    i++;
    while (i < n && isSpace(s[i])) i++;
    const q = s[i];
    const close = q === '"' || q === "'" ? s.indexOf(q, i + 1) : -1;
    let value;
    if (close >= 0) {
      value = s.slice(i + 1, close);
      i = close + 1;
    } else {
      const start = i; // unquoted (or an unclosed quote: up to the next space, as before)
      while (i < n && !isSpace(s[i]) && s[i] !== '>') i++;
      value = s.slice(start, i);
    }
    attrs[name] = decodeEntities(value);
    count++;
  }
  return attrs;
}

/** <img> candidates of an HTML fragment in document order: [{url, width, height, type}]. */
function imagesInHtml(html, base) {
  const src = String(html ?? '').slice(0, 512 * 1024);
  const out = [];
  // Bounded and always matching (no required '>'), so unclosed tags keep the scan linear.
  const re = /<img\b[^>]{0,4000}/gi;
  let m;
  while ((m = re.exec(src)) && out.length < 10) {
    const a = tagAttrs(m[0].slice(4));
    // Lazy-loading themes put a placeholder in src and the real picture in data-src.
    const url = resolveUrl(a.src, base) || resolveUrl(a['data-src'], base);
    if (!url || TRACKER.test(url) || /\b(wp-smiley|emoji)\b/i.test(a.class || '')) continue;
    out.push({ url, width: Number(a.width) || 0, height: Number(a.height) || 0, type: '' });
  }
  return out;
}

function isImageType(type) {
  return /^image\//i.test(String(type || ''));
}

const widestFirst = (list) => [...list].sort((a, b) => b.width - a.width); // stable: same width keeps feed order

/** media:content images and media:thumbnails of an item (media:group may wrap several renditions). */
function mediaImages(el, base) {
  const holders = [el, ...children(el, (c) => c.local === 'group' && inNs(c, 'media'))];
  const contents = [];
  const thumbs = [];
  const size = (x) => ({ width: Number(x.attrs.width) || 0, height: Number(x.attrs.height) || 0 });
  for (const h of holders) {
    for (const c of children(h, (x) => x.local === 'content' && inNs(x, 'media'))) {
      const url = resolveUrl(c.attrs.url, base);
      if (!url) continue;
      const medium = String(c.attrs.medium || '').toLowerCase();
      const type = String(c.attrs.type || '');
      const image = medium === 'image' || isImageType(type) || (!medium && !type && kindFromUrl(url) === 'image');
      if (image) contents.push({ url, ...size(c), type });
      for (const t of children(c, (x) => x.local === 'thumbnail' && inNs(x, 'media'))) {
        const tu = resolveUrl(t.attrs.url, base);
        if (tu) thumbs.push({ url: tu, ...size(t), type: '' });
      }
    }
    for (const t of children(h, (x) => x.local === 'thumbnail' && inNs(x, 'media'))) {
      const url = resolveUrl(t.attrs.url, base);
      if (url) thumbs.push({ url, ...size(t), type: '' });
    }
  }
  return { contents: widestFirst(contents), thumbs: widestFirst(thumbs) };
}

/**
 * The picture of an item from its candidates, best first: media:content images (widest first), image
 * enclosures, <img> in the content, then media:thumbnail. Avatars, emoji and images declared smaller
 * than 320 px are skipped (Blogger's 72 px "s72-c" thumbnails, WordPress.com author avatars), and a
 * link that may be a JPEG wins over one known to be PNG, WebP or GIF.
 * @returns {{url: string, format: string}} format: nonJpegFormat of the pick ('' = may be a JPEG)
 */
function pickImage(candidates) {
  const usable = candidates.filter((c) => c && c.url && !isIconUrl(c.url) && !(c.width && c.width < MIN_IMAGE_SIDE) && !(c.height && c.height < MIN_IMAGE_SIDE));
  const best = usable.find((c) => !nonJpegFormat(c.url, c.type)) || usable[0];
  return best ? { url: best.url, format: nonJpegFormat(best.url, best.type) } : { url: '', format: '' };
}

function guidFrom(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s.slice(0, 500);
  }
  return '';
}

function hashText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cleanTitle(raw) {
  const s = String(raw ?? '');
  return (/[<&]/.test(s) ? stripHtml(s) : s.replace(/\s+/g, ' ')).trim();
}

function rssItem(el, source, base) {
  const link = resolveUrl(textOf(child(el, plain('link'))), base) || resolveUrl(child(el, (c) => c.local === 'link' && inNs(c, 'atom'))?.attrs.href, base);
  const itemBase = link || base;
  const title = cleanTitle(textOf(child(el, plain('title'))) || textOf(child(el, named('title', 'dc'))));
  const descEl = child(el, plain('description')) || child(el, named('description', 'dc'));
  const contentEl = child(el, named('encoded', 'content'));
  const descHtml = innerHtml(descEl, source);
  const contentHtml = innerHtml(contentEl, source);
  const media = mediaImages(el, itemBase);
  const enclosures = children(el, plain('enclosure'))
    .filter((e) => isImageType(e.attrs.type) || (!e.attrs.type && kindFromUrl(e.attrs.url) === 'image'))
    .map((e) => ({ url: resolveUrl(e.attrs.url, itemBase), width: 0, height: 0, type: e.attrs.type || '' }));
  const image = pickImage([...media.contents, ...enclosures, ...imagesInHtml(contentHtml, itemBase), ...imagesInHtml(descHtml, itemBase), ...media.thumbs]);
  const published = parseFeedDate(textOf(child(el, plain('pubdate')))) || parseFeedDate(textOf(child(el, named('date', 'dc')))) || parseFeedDate(textOf(child(el, (c) => (c.local === 'published' || c.local === 'updated') && inNs(c, 'atom'))));
  const guidEl = child(el, plain('guid'));
  const summary = stripHtml(descHtml || contentHtml);
  const guid = guidFrom(textOf(guidEl), el.attrs['rdf:about'], link) || `h:${hashText(`${title}|${published || ''}|${summary.slice(0, 200)}`)}`;
  return { guid, title, link, summary, published, imageUrl: image.url, imageFormat: image.format };
}

function atomLink(el, base, rels) {
  for (const l of children(el, (c) => c.local === 'link')) {
    const rel = String(l.attrs.rel || 'alternate').toLowerCase();
    if (rels.includes(rel)) {
      const url = resolveUrl(l.attrs.href, base);
      if (url) return { url, type: l.attrs.type || '' };
    }
  }
  return null;
}

function atomHtml(el, source) {
  if (!el) return '';
  const type = String(el.attrs.type || 'text').toLowerCase();
  if (type === 'xhtml' || (el.children.length && type !== 'text')) return innerHtml(el, source);
  if (type === 'text') return textOf(el).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  return textOf(el); // type="html": the decoded text is HTML
}

/** Atom text constructs default to type="text": plain text, never parsed as HTML. */
function atomTitle(el, source) {
  if (!el) return '';
  const type = String(el.attrs.type || 'text').toLowerCase();
  return type === 'text' ? textOf(el).replace(/\s+/g, ' ').trim() : stripHtml(atomHtml(el, source)).replace(/\s+/g, ' ').trim();
}

function atomEntry(el, source, base) {
  const entryBase = resolveUrl(el.attrs['xml:base'], base) || base;
  const link = atomLink(el, entryBase, ['alternate'])?.url || '';
  const itemBase = link || entryBase;
  const title = atomTitle(child(el, (c) => c.local === 'title'), source);
  const summaryHtml = atomHtml(child(el, (c) => c.local === 'summary' && (!c.prefix || inNs(c, 'atom'))), source);
  const contentHtml = atomHtml(child(el, (c) => c.local === 'content' && (!c.prefix || inNs(c, 'atom'))), source);
  const media = mediaImages(el, itemBase);
  const enclosures = children(el, (c) => c.local === 'link' && String(c.attrs.rel || '').toLowerCase() === 'enclosure' && isImageType(c.attrs.type))
    .map((l) => ({ url: resolveUrl(l.attrs.href, itemBase), width: 0, height: 0, type: l.attrs.type }));
  const image = pickImage([...media.contents, ...enclosures, ...imagesInHtml(contentHtml, itemBase), ...imagesInHtml(summaryHtml, itemBase), ...media.thumbs]);
  const published =
    parseFeedDate(textOf(child(el, (c) => c.local === 'published'))) ||
    parseFeedDate(textOf(child(el, (c) => c.local === 'updated'))) ||
    parseFeedDate(textOf(child(el, named('date', 'dc'))));
  const summary = stripHtml(summaryHtml || contentHtml);
  const guid = guidFrom(textOf(child(el, (c) => c.local === 'id')), link) || `h:${hashText(`${title}|${published || ''}|${summary.slice(0, 200)}`)}`;
  return { guid, title, link, summary, published, imageUrl: image.url, imageFormat: image.format };
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF) or Atom feed.
 * Items: { guid, title, link, summary (plain text), published (ISO|null), imageUrl, imageFormat } in
 * feed order (newest first for almost every feed). The image comes from media:content, an image
 * enclosure, the item's HTML or media:thumbnail (see pickImage), resolved against the item link;
 * imageFormat is 'PNG', 'WebP'... when the link is known not to be a JPEG, else ''.
 * @param {string} xml
 * @param {{url?: string}} opts url: the feed's own address, used to resolve relative links
 * @returns {{format: 'rss'|'atom'|'rdf'|null, title: string, link: string, items: object[], error?: string}}
 */
export function parseFeed(xml, { url = '' } = {}) {
  const { root, source } = parseXml(xml);
  const top = root.children.find((c) => ['rss', 'feed', 'rdf', 'channel'].includes(c.local));
  if (!top) {
    const looksHtml = /<html[\s>]/i.test(String(xml ?? '').slice(0, 2000));
    return { format: null, title: '', link: '', items: [], error: looksHtml ? 'This address is a web page, not a feed. Look for an RSS or Atom link on the site.' : 'This address did not return an RSS or Atom feed.' };
  }
  const base = resolveUrl(top.attrs['xml:base'], url) || url || undefined;
  if (top.local === 'feed') {
    const title = atomTitle(child(top, (c) => c.local === 'title'), source);
    const link = atomLink(top, base, ['alternate'])?.url || '';
    const items = children(top, (c) => c.local === 'entry').map((e) => atomEntry(e, source, link || base));
    return { format: 'atom', title, link, items };
  }
  const channel = top.local === 'channel' ? top : child(top, (c) => c.local === 'channel');
  const title = cleanTitle(textOf(child(channel, plain('title'))) || textOf(child(channel, named('title', 'dc'))));
  const link = resolveUrl(textOf(child(channel, plain('link'))), base) || '';
  // RSS 2.0 items live in <channel>; RSS 1.0 (RDF) items are siblings of <channel>.
  const itemEls = [...children(channel, (c) => c.local === 'item'), ...(top !== channel ? children(top, (c) => c.local === 'item') : [])];
  const items = itemEls.map((e) => rssItem(e, source, link || base));
  return { format: top.local === 'rdf' ? 'rdf' : 'rss', title, link, items };
}

/**
 * Items newest first: by published date when every item has one, else in feed order (feeds list
 * their newest entries first).
 */
export function newestFirst(items) {
  const list = [...(items || [])];
  if (list.length && list.every((it) => it.published)) list.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return list;
}

/**
 * The share image of a web page: og:image (or og:image:secure_url / og:image:url), then
 * twitter:image, then <link rel="image_src">. Relative URLs resolve against the page URL.
 * @returns {string} absolute http(s) URL or ''
 */
export function ogImage(html, pageUrl) {
  const head = String(html ?? '').slice(0, 1024 * 1024);
  const found = {};
  // Bounded and always matching (no required '>'), so unclosed tags keep the scan linear.
  const tagRe = /<(meta|link)\b([^>]{0,4000})/gi;
  let m;
  while ((m = tagRe.exec(head))) {
    const attrs = tagAttrs(m[2]);
    if (m[1].toLowerCase() === 'link') {
      if (String(attrs.rel || '').toLowerCase() === 'image_src' && attrs.href && !found.link) found.link = attrs.href;
      continue;
    }
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content;
    if (!content) continue;
    if ((key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') && !found.og) found.og = content;
    else if ((key === 'twitter:image' || key === 'twitter:image:src') && !found.tw) found.tw = content;
    else if (key === 'image' && !found.itemprop) found.itemprop = content;
  }
  for (const k of ['og', 'tw', 'link', 'itemprop']) {
    const url = found[k] && resolveUrl(found[k], pageUrl || undefined);
    if (url) return url;
  }
  return '';
}

/**
 * How many unused items (timesUsed 0) from one feed a queue may hold: two rounds of its slots over
 * its fill-ahead days, at least 10 and at most 50. Keeps a busy feed from growing the queue, the
 * library and the downloads without bound when the queue posts once a day (worker/jobs/feeds.mjs).
 */
export function feedBacklogCap(list) {
  const slots = ((list && list.slots) || []).length;
  const horizon = Number(list && list.horizonDays) > 0 ? Number(list.horizonDays) : 14;
  return Math.min(50, Math.max(10, Math.ceil((2 * slots * horizon) / 7)));
}

/** Default caption template for feed items. {title}, {summary} and {link} are filled in. */
export const FEED_TEMPLATE = '{title}\n\n{summary}';

/**
 * Caption for a feed item from a template ({title}, {summary}, {link}), clipped to Instagram's
 * caption limit by shortening the summary first. Links are not clickable in Instagram captions,
 * so the default template leaves the link out.
 */
export function feedCaption(item, template = FEED_TEMPLATE, max = LIMITS.captionChars) {
  const tpl = String(template || FEED_TEMPLATE);
  const fill = (summary) =>
    tpl
      .replace(/\{title\}/g, item.title || '')
      .replace(/\{link\}/g, item.link || '')
      .replace(/\{summary\}/g, summary)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const summary = String(item.summary || '');
  let caption = fill(summary);
  if (caption.length <= max) return caption;
  const room = Math.max(0, summary.length - (caption.length - max));
  caption = fill(clipText(summary, room));
  return caption.length <= max ? caption : clipText(caption, max);
}

// ---------------------------------------------------------------------------
// Downloaded bytes

// Linked media downloads (worker/jobs/feeds.mjs); here so the app can explain them.
export const DOWNLOADS_PER_RUN = 8;
export const MAX_DOWNLOAD_TRIES = 5;
export const DOWNLOAD_RETRY_BASE_MS = 10 * 60e3; // then 20, 40, 80 minutes

/**
 * When the worker tries a pending download again after a temporary failure (asset.importAttempts,
 * importTriedAt): epoch ms, or null when it has not failed yet.
 */
export function downloadRetryAt(asset) {
  const tries = Number(asset && asset.importAttempts) || 0;
  const tried = Date.parse((asset && asset.importTriedAt) || '');
  if (!tries || !Number.isFinite(tried)) return null;
  return tried + DOWNLOAD_RETRY_BASE_MS * 2 ** (tries - 1);
}

/**
 * Import errors that trying again cannot fix: the file itself cannot be posted as it is (not a JPEG,
 * the wrong shape for the feed, rotated, too large, damaged). asset.importErrorCode holds the code.
 */
export const IMPORT_REFUSED = new Set(['not_jpeg', 'shape', 'rotated', 'too_big', 'bad_jpeg']);

/**
 * Does a photo of width x height fit Instagram's feed (4:5 portrait to 1.91:1 landscape, with the
 * same 1% tolerance as validatePost)? Unknown sizes pass. Feed posts and carousels with a photo
 * outside this range fail at publish (error 2207009); stories and reels have no such limit.
 */
export function fitsFeed(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return true;
  const r = w / h;
  return r >= LIMITS.feedAspectMin - 0.01 && r <= LIMITS.feedAspectMax + 0.01;
}

/**
 * Library assets a queue item cannot be posted with: downloads from a link that failed or were
 * refused (importError) and photos outside the feed's 4:5 to 1.91:1 range. Evergreen skips their items
 * and they do not count toward a feed's backlog (worker/jobs/evergreen.mjs, worker/jobs/feeds.mjs).
 * @returns {Set<string>}
 */
export function brokenAssetIds(assets) {
  return new Set((assets || []).filter((a) => a && ((a.importUrl && a.importError) || (a.kind === 'image' && !fitsFeed(a.width, a.height)))).map((a) => a.id));
}

/**
 * What a downloaded file is, from its first bytes:
 * { format: 'jpeg'|'png'|'webp'|'gif'|'heic'|'avif'|'mp4'|'mov'|'html'|null, kind: 'image'|'video'|null, mime }
 */
export function sniffMedia(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: 'jpeg', kind: 'image', mime: 'image/jpeg' };
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return { format: 'png', kind: 'image', mime: 'image/png' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { format: 'webp', kind: 'image', mime: 'image/webp' };
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { format: 'gif', kind: 'image', mime: 'image/gif' };
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { format: 'heic', kind: 'image', mime: 'image/heic' };
    if (/^avi[fs]$/.test(brand)) return { format: 'avif', kind: 'image', mime: 'image/avif' };
    if (brand === 'qt  ') return { format: 'mov', kind: 'video', mime: 'video/quicktime' };
    return { format: 'mp4', kind: 'video', mime: 'video/mp4' };
  }
  const head = ascii(0, Math.min(b.length, 512)).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<(head|body|meta)\b/.test(head)) return { format: 'html', kind: null, mime: 'text/html' };
  return { format: null, kind: null, mime: '' };
}

function jpegSegments(b) {
  // Yields {marker, at, len} for each segment before the scan data (SOS).
  const out = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return out; // not at a marker: malformed
    let marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return out;
    out.push({ marker, at: i, len });
    if (marker === 0xda || marker === 0xd9) return out;
    i += 2 + len;
  }
  return out;
}

function exifOrientation(b, seg) {
  const start = seg.at + 4;
  if (String.fromCharCode(...b.subarray(start, start + 4)) !== 'Exif') return 1;
  const tiff = start + 6;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const end = seg.at + 2 + seg.len;
  if (tiff + 8 > end) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * Size of a JPEG from its SOF marker, plus the EXIF orientation (1 = upright; 5-8 = rotated by 90
 * degrees, so the displayed width and height are swapped). Null when the bytes are not a JPEG.
 * @returns {{width: number, height: number, orientation: number, displayWidth: number, displayHeight: number}|null}
 */
export function jpegInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  for (const seg of jpegSegments(b)) {
    if (seg.marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, seg);
    const m = seg.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (seg.len < 7) return null;
      const height = (b[seg.at + 5] << 8) | b[seg.at + 6];
      const width = (b[seg.at + 7] << 8) | b[seg.at + 8];
      if (!width || !height) return null;
      const turned = orientation >= 5;
      return { width, height, orientation, displayWidth: turned ? height : width, displayHeight: turned ? width : height };
    }
  }
  return null;
}

/**
 * Offset just past the EOI marker that ends the image whose scan data starts at `from` (the scans of
 * a progressive JPEG and the table segments between them included), or b.length when there is none
 * or the data cannot be followed safely.
 */
function jpegEnd(b, from) {
  let i = from;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) i += 2; // stuffed 0xFF byte, restart marker
    else if (m === 0xff) i++; // fill byte
    else if (m === 0xd9) return i + 2;
    else {
      // DHT, DQT, DRI, SOS... between scans: skip the segment.
      if (m === 0xd8 || m === 0x01 || i + 4 > b.length) return b.length;
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return b.length;
      i += 2 + len;
    }
  }
  return b.length;
}

/** Segments before the scan data that only hold metadata (see stripJpegMetadata). */
function isMetadataSegment(b, seg) {
  const m = seg.marker;
  // APP2 holds ICC colour profiles (kept) but also the multi-picture index and Flashpix data.
  if (m === 0xe2) return /^(MPF|FPXR)\0/.test(String.fromCharCode(...b.subarray(seg.at + 4, seg.at + 9)));
  return m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;
}

/**
 * Copy of a JPEG without metadata: EXIF and XMP (APP1, which can hold GPS coordinates and camera
 * details), IPTC/Photoshop (APP13), other application segments (APP3-APP12, APP15), the multi-picture
 * index and Flashpix data (APP2 "MPF" / "FPXR") and comments, plus anything
 * after the image's end marker: cameras and phones append secondary images with their own EXIF (MPO),
 * motion-photo videos and vendor data there. JFIF (APP0), ICC colour profiles (APP2) and the Adobe
 * colour-transform segment (APP14) are kept, so colours do not change. Returns the input unchanged
 * when it is not a JPEG or cannot be read safely.
 */
export function stripJpegMetadata(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return bytes;
  const segs = jpegSegments(b);
  const sos = segs.find((s) => s.marker === 0xda);
  if (!sos) return bytes;
  const end = jpegEnd(b, sos.at + 2 + sos.len);
  const drop = segs.filter((s) => isMetadataSegment(b, s));
  if (!drop.length && end === b.length) return bytes;
  const parts = [b.subarray(0, 2)];
  let at = 2;
  for (const s of drop) {
    if (s.at > at) parts.push(b.subarray(at, s.at));
    at = s.at + 2 + s.len;
  }
  parts.push(b.subarray(at, end));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
