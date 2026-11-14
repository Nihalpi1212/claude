// File Info (File › File Info…, the properties() dialog of lib/file-ops.js): what doc.meta holds,
// how it travels as an XMP packet, and the camera data (EXIF) read from photographs.
//
// Everything above installFileInfo() is pure (no DOM, no bridge) so it runs under node:test.
// doc.meta fields: title, author, description, copyright, keywords (string[]), rating (0..5),
// credit, source, copyrightStatus ('unknown' | 'copyrighted' | 'public'), copyrightUrl, exif.

export const COPYRIGHT_STATUS = [['unknown', 'Unknown'], ['copyrighted', 'Copyrighted'], ['public', 'Public Domain']];
const TEXT_KEYS = ['title', 'author', 'description', 'copyright', 'credit', 'source', 'copyrightUrl'];

/** "a; b, c" or an array -> trimmed, de-duplicated keywords. */
export function parseKeywords(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[;,\n]+/);
  const seen = new Set();
  const out = [];
  for (const k of list) {
    const t = String(k ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** The File Info part of a meta object, cleaned: strings trimmed, rating clamped, unknown status dropped. */
export function normaliseInfo(o = {}) {
  const out = {};
  for (const k of TEXT_KEYS) out[k] = String(o[k] ?? '').trim();
  out.description = String(o.description ?? '').replace(/\s+$/, '');
  out.keywords = parseKeywords(o.keywords);
  const r = Math.round(Number(o.rating));
  out.rating = Number.isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;
  out.copyrightStatus = COPYRIGHT_STATUS.some(([v]) => v === o.copyrightStatus) ? o.copyrightStatus : 'unknown';
  return out;
}

/** True when the meta carries anything worth writing into a file. */
export function hasInfo(meta = {}) {
  const m = normaliseInfo(meta);
  return TEXT_KEYS.some((k) => m[k]) || m.keywords.length > 0 || m.rating > 0 || m.copyrightStatus !== 'unknown';
}

// ---- XMP ------------------------------------------------------------------------------------------------------

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

/** The XMP packet for a document's File Info (what Photoshop reads in a PSD's image resource 1060), or '' when there is none. */
export function xmpPacket(meta = {}) {
  if (!hasInfo(meta)) return '';
  const m = normaliseInfo(meta);
  const alt = (tag, v) => (v ? `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt></${tag}>\n` : '');
  const list = (tag, kind, items) => (items.length ? `   <${tag}><rdf:${kind}>${items.map((i) => `<rdf:li>${escapeXml(i)}</rdf:li>`).join('')}</rdf:${kind}></${tag}>\n` : '');
  const simple = (tag, v) => (v !== '' && v !== null && v !== undefined ? `   <${tag}>${escapeXml(v)}</${tag}>\n` : '');
  const body =
    alt('dc:title', m.title) +
    list('dc:creator', 'Seq', m.author ? [m.author] : []) +
    alt('dc:description', m.description) +
    alt('dc:rights', m.copyright) +
    list('dc:subject', 'Bag', m.keywords) +
    simple('xmp:Rating', m.rating > 0 ? m.rating : '') +
    simple('photoshop:Credit', m.credit) +
    simple('photoshop:Source', m.source) +
    simple('xmpRights:Marked', m.copyrightStatus === 'copyrighted' ? 'True' : m.copyrightStatus === 'public' ? 'False' : '') +
    simple('xmpRights:WebStatement', m.copyrightUrl);
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Pigment">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">\n' +
    body +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>'
  );
}

/**
 * Reads the File Info fields out of an XMP packet (ours or Adobe's: properties may be elements or attributes of
 * rdf:Description). Returns only the fields the packet has; {} for anything that is not XMP.
 */
export function parseXmp(xml) {
  const out = {};
  if (typeof xml !== 'string' || !xml.includes('rdf:RDF')) return out;
  const element = (tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
  const items = (inner) => (inner === null ? [] : [...inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) => unescapeXml(m[1]).trim()).filter(Boolean));
  const simple = (tag) => {
    const el = element(tag);
    if (el !== null && !el.includes('<')) return unescapeXml(el).trim();
    const attr = new RegExp(`\\s${tag}="([^"]*)"`).exec(xml)?.[1];
    return attr !== undefined ? unescapeXml(attr).trim() : null;
  };
  const first = (tag) => items(element(tag))[0] ?? null;
  const put = (key, v) => {
    if (v !== null && v !== undefined && v !== '') out[key] = v;
  };
  put('title', first('dc:title'));
  const creators = items(element('dc:creator'));
  put('author', creators.length ? creators.join('; ') : null);
  put('description', first('dc:description'));
  put('copyright', first('dc:rights'));
  const keywords = items(element('dc:subject'));
  if (keywords.length) out.keywords = parseKeywords(keywords);
  const rating = Number(simple('xmp:Rating'));
  if (Number.isFinite(rating) && rating > 0) out.rating = Math.min(5, Math.round(rating));
  put('credit', simple('photoshop:Credit'));
  put('source', simple('photoshop:Source'));
  const marked = simple('xmpRights:Marked');
  if (marked !== null) out.copyrightStatus = /^true$/i.test(marked) ? 'copyrighted' : 'public';
  put('copyrightUrl', simple('xmpRights:WebStatement'));
  return out;
}

/** Finds an XMP packet inside file bytes (JPEG, PNG, TIFF and PSD all store it as plain UTF-8 text). */
export function findXmp(bytes, limit = 8 << 20) {
  const n = Math.min(bytes.length, limit);
  const open = [0x3c, 0x78, 0x3a, 0x78, 0x6d, 0x70, 0x6d, 0x65, 0x74, 0x61]; // <x:xmpmeta
  const close = [0x3c, 0x2f, 0x78, 0x3a, 0x78, 0x6d, 0x70, 0x6d, 0x65, 0x74, 0x61, 0x3e]; // </x:xmpmeta>
  const indexOf = (pattern, from) => {
    outer: for (let i = from; i <= n - pattern.length; i++) {
      for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
      return i;
    }
    return -1;
  };
  const start = indexOf(open, 0);
  if (start < 0) return '';
  const end = indexOf(close, start);
  if (end < 0) return '';
  return new TextDecoder('utf-8').decode(bytes.subarray(start, end + close.length));
}

/**
 * Adds an XMP packet to PSD / PSB bytes as image resource 1060 (where Photoshop keeps File Info). Bytes that are
 * no PSD, or that already carry the resource, come back untouched (the same array).
 */
export function injectPsdXmp(bytes, packet) {
  if (!packet || !bytes || bytes.length < 34) return bytes;
  if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) return bytes; // "8BPS"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorLen = view.getUint32(26);
  const resAt = 26 + 4 + colorLen; // the image resources section: a length, then "8BIM" blocks
  if (resAt + 4 > bytes.length) return bytes;
  const resLen = view.getUint32(resAt);
  const resEnd = resAt + 4 + resLen;
  if (resEnd > bytes.length) return bytes;
  for (let p = resAt + 4; p + 12 <= resEnd; ) {
    const id = view.getUint16(p + 4);
    if (id === 1060) return bytes;
    const nameLen = bytes[p + 6];
    const sizeAt = p + 6 + ((nameLen + 2) & ~1); // the Pascal name is padded to an even length, its length byte included
    if (sizeAt + 4 > resEnd) return bytes;
    p = sizeAt + 4 + ((view.getUint32(sizeAt) + 1) & ~1);
  }
  const data = new TextEncoder().encode(packet);
  const block = new Uint8Array(12 + ((data.length + 1) & ~1));
  block.set([0x38, 0x42, 0x49, 0x4d, 0x04, 0x24, 0, 0], 0); // "8BIM", id 1060, an empty name
  new DataView(block.buffer).setUint32(8, data.length);
  block.set(data, 12);
  const out = new Uint8Array(bytes.length + block.length);
  out.set(bytes.subarray(0, resEnd), 0);
  out.set(block, resEnd);
  out.set(bytes.subarray(resEnd), resEnd + block.length);
  new DataView(out.buffer).setUint32(resAt, resLen + block.length);
  return out;
}

// ---- EXIF -----------------------------------------------------------------------------------------------------

const TAGS0 = { 0x010f: 'make', 0x0110: 'model', 0x0131: 'software', 0x0132: 'dateTime', 0x0112: 'orientation' };
const TAGS_EXIF = {
  0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8822: 'exposureProgram', 0x8827: 'iso', 0x9003: 'dateTimeOriginal', 0x9204: 'exposureBias',
  0x9207: 'meteringMode', 0x9209: 'flash', 0x920a: 'focalLength', 0xa405: 'focalLength35', 0xa403: 'whiteBalance', 0xa433: 'lensMake', 0xa434: 'lens',
};
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** Parses a TIFF structure (the body of a JPEG's Exif segment, or a TIFF file) into camera data. */
function readTiffExif(bytes, base) {
  if (bytes.length < base + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  if (view.getUint16(base + 2, le) !== 42) return null;
  const out = {};
  const readIfd = (offset, tags, depth = 0) => {
    const at = base + offset;
    if (offset <= 0 || at + 2 > bytes.length) return;
    const count = view.getUint16(at, le);
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > bytes.length) return;
      const tag = view.getUint16(e, le), type = view.getUint16(e + 2, le), n = view.getUint32(e + 4, le);
      if ((tag === 0x8769 || tag === 0x8825) && depth === 0) {
        if (tag === 0x8769) readIfd(view.getUint32(e + 8, le), TAGS_EXIF, 1);
        continue;
      }
      const name = tags[tag];
      if (!name) continue;
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (!size) continue;
      const p = size <= 4 ? e + 8 : base + view.getUint32(e + 8, le);
      if (p < 0 || p + size > bytes.length) continue;
      let value = null;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < n; k++) {
          const c = bytes[p + k];
          if (!c) break;
          s += String.fromCharCode(c);
        }
        value = s.trim();
      } else if (type === 3) value = view.getUint16(p, le);
      else if (type === 4) value = view.getUint32(p, le);
      else if (type === 9) value = view.getInt32(p, le);
      else if (type === 5) {
        const d = view.getUint32(p + 4, le);
        value = d ? view.getUint32(p, le) / d : null;
      } else if (type === 10) {
        const d = view.getInt32(p + 4, le);
        value = d ? view.getInt32(p, le) / d : null;
      }
      if (value !== null && value !== '') out[name] = value;
    }
  };
  readIfd(view.getUint32(base + 4, le), TAGS0);
  return Object.keys(out).length ? out : null;
}

/** Camera data of a JPEG or TIFF file ({ make, model, lens, exposureTime, fNumber, iso, focalLength, ... }), or null. */
/**
 * Adds an XMP packet to JPEG bytes as an APP1 segment behind the JFIF / EXIF headers (where readers look for it).
 * Bytes that are no JPEG, that already carry a packet, or a packet above the 64 KB of one segment come back
 * untouched (the same array).
 */
export function injectJpegXmp(bytes, packet) {
  if (!packet || !bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  if (findXmp(bytes)) return bytes;
  const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
  const body = new TextEncoder().encode(packet);
  const length = 2 + head.length + body.length;
  if (length > 0xffff) return bytes;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff && (bytes[at + 1] === 0xe0 || bytes[at + 1] === 0xe1)) at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  if (at > bytes.length) return bytes;
  const out = new Uint8Array(bytes.length + 2 + length);
  out.set(bytes.subarray(0, at));
  out.set([0xff, 0xe1, length >> 8, length & 0xff], at);
  out.set(head, at + 4);
  out.set(body, at + 4 + head.length);
  out.set(bytes.subarray(at), at + 2 + length);
  return out;
}

export function readExif(bytes) {
  try {
    if (!bytes || bytes.length < 12) return null;
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return readTiffExif(bytes, 0);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xff) return null;
      const marker = bytes[p + 1];
      if (marker === 0xda || marker === 0xd9) return null; // image data: no Exif segment before it
      const len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (marker === 0xe1 && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78 && bytes[p + 6] === 0x69 && bytes[p + 7] === 0x66 && bytes[p + 8] === 0 && bytes[p + 9] === 0) return readTiffExif(bytes.subarray(0, Math.min(bytes.length, p + 2 + len)), p + 10);
      p += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

const trimNum = (v, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);

/** Camera data as [label, text] rows for the File Info dialog. */
export function describeExif(exif) {
  if (!exif || typeof exif !== 'object') return [];
  const rows = [];
  const add = (label, text) => {
    if (text !== null && text !== undefined && String(text).trim()) rows.push([label, String(text).trim()]);
  };
  const make = String(exif.make ?? '').trim(), model = String(exif.model ?? '').trim();
  add('Camera', model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`);
  add('Lens', [exif.lensMake, exif.lens].filter(Boolean).join(' '));
  const t = Number(exif.exposureTime), f = Number(exif.fNumber);
  const shutter = t > 0 ? (t >= 1 ? `${trimNum(t)} s` : `1/${Math.round(1 / t)} s`) : '';
  add('Exposure', [shutter, f > 0 ? `f/${trimNum(f)}` : ''].filter(Boolean).join(' at '));
  if (Number(exif.iso) > 0) add('ISO', exif.iso);
  if (Number.isFinite(Number(exif.exposureBias)) && Number(exif.exposureBias) !== 0) add('Exposure bias', `${Number(exif.exposureBias) > 0 ? '+' : ''}${trimNum(Number(exif.exposureBias), 2)} EV`);
  const fl = Number(exif.focalLength), fl35 = Number(exif.focalLength35);
  if (fl > 0) add('Focal length', `${trimNum(fl)} mm${fl35 > 0 ? ` (${Math.round(fl35)} mm in 35 mm film)` : ''}`);
  if (exif.flash !== undefined) add('Flash', Number(exif.flash) & 1 ? 'Fired' : 'Did not fire');
  add('Date taken', String(exif.dateTimeOriginal ?? exif.dateTime ?? '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  add('Software', exif.software);
  return rows;
}

// ---- renderer side --------------------------------------------------------------------------------------------

const META_FORMATS = /\.(jpe?g|tiff?|psd|psb|png|webp)$/i;
const MAX_SCAN_BYTES = 64 << 20; // larger files are not read a second time just for their metadata

/**
 * After a file is opened, its bytes are looked at once more for camera data (EXIF) and an XMP packet, and what
 * they hold fills the gaps in doc.meta. (lib/io.js builds documents from pixels only; this keeps it that way.)
 */
export function installFileInfo(app) {
  async function readFileInfo(doc) {
    const path = doc?.path;
    if (!path || !META_FORMATS.test(path) || path.startsWith('download:/') || doc.meta?.exif) return;
    try {
      const info = await Promise.resolve(app.bridge.pathInfo?.(path)).catch(() => null);
      if (info?.size > MAX_SCAN_BYTES) return;
      const bytes = await app.bridge.readFile(path);
      if (!app.docs.docs.includes(doc)) return;
      const exif = /\.(jpe?g|tiff?)$/i.test(path) ? readExif(bytes) : null;
      const xmp = parseXmp(findXmp(bytes));
      const meta = { ...(doc.meta ?? {}) };
      let changed = false;
      for (const [k, v] of Object.entries(xmp)) if (meta[k] === undefined || meta[k] === '') {
        meta[k] = v;
        changed = true;
      }
      if (exif) {
        meta.exif = exif;
        changed = true;
      }
      if (changed) doc.meta = meta; // not an edit: nothing is recorded and the document stays "saved"
    } catch {
      /* metadata is optional: a file that cannot be read again simply has none */
    }
  }
  app.on('doc:opened', (doc) => {
    readFileInfo(doc);
  });

  /**
   * PSD saves carry the File Info as XMP. lib/io.js writes PSDs without one and documents.js has no "saved bytes"
   * hook (lib/depth.js wraps writeTo for the same reason), so the saved file gets the packet added right after it
   * is written. When the writer starts adding the resource itself this finds it there and changes nothing.
   */
  async function stampPsd(doc, path) {
    if (!/\.(psd|psb)$/i.test(path) || !hasInfo(doc?.meta)) return false;
    try {
      const bytes = await app.bridge.readFile(path);
      const out = injectPsdXmp(bytes, xmpPacket(doc.meta));
      if (out === bytes) return false;
      await app.bridge.writeFile(path, out);
      return true;
    } catch (err) {
      console.warn('File Info could not be added to the PSD', err); // the PSD itself is complete and valid
      return false;
    }
  }
  const docs = app.docs;
  if (docs && typeof docs.writeTo === 'function') {
    const writeTo = docs.writeTo.bind(docs);
    docs.writeTo = async (doc, path, opts) => {
      const ok = await writeTo(doc, path, opts);
      if (ok) await stampPsd(doc, path);
      return ok;
    };
  }
  /**
   * Encoded bytes of a document with its File Info added, for writers that do not go through docs.writeTo (the
   * Image Processor): PSD as Save As does, and JPEG, so the Copyright Info typed there reaches its outputs.
   */
  function withInfo(doc, path, bytes) {
    if (!hasInfo(doc?.meta)) return bytes;
    try {
      if (/\.(psd|psb)$/i.test(path)) return injectPsdXmp(bytes, xmpPacket(doc.meta));
      if (/\.jpe?g$/i.test(path)) return injectJpegXmp(bytes, xmpPacket(doc.meta));
    } catch (err) {
      console.warn('File Info could not be added', err); // the image itself is complete and valid
    }
    return bytes;
  }
  app.fileInfo = { read: readFileInfo, stampPsd, withInfo };
}
