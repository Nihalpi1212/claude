// The document engine: pure functions over PDF bytes built on pdf-lib. See ARCHITECTURE.md
// "The engine" for the contract. Works in the browser (import map) and in Node (unit tests).
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray, PDFDict, PDFRef, PDFBool, PDFStream, StandardFonts, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setGraphicsState } from 'pdf-lib';
import { annotId, parseAnnotId } from './pdf-ids.js';
import { toPdfDate, fromPdfDate } from './pdf-date.js';
import {
  parseColor,
  colorToHex,
  normRect,
  quadsBounds,
  highlightAppearance,
  underlineAppearance,
  strikeoutAppearance,
  squigglyAppearance,
  squareAppearance,
  circleAppearance,
  lineAppearance,
  inkAppearance,
  freeTextAppearance,
  imageStampAppearance,
  textStampAppearance,
} from './appearance.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const SAVE_OPTIONS = { useObjectStreams: false };
const MARKUP_SUBTYPES = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact']);
const FLAG_HIDDEN = 2;
const FLAG_PRINT = 4;

// ---- loading -------------------------------------------------------------------------------------------

async function load(bytes, { ignoreEncryption = false } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new EngineError('invalid', 'Expected PDF bytes');
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption, updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/encrypted/i.test(message)) throw new EngineError('encrypted', 'This document is encrypted. Save an unprotected copy from the viewer first, then try again.');
    throw new EngineError('invalid', `This file could not be parsed as a PDF: ${message}`);
  }
}

async function save(doc) {
  const out = await doc.save(SAVE_OPTIONS);
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

function checkIndices(indices, count, what = 'page') {
  if (!Array.isArray(indices) || !indices.length) throw new EngineError('range', `No ${what}s selected`);
  const unique = [...new Set(indices.map((i) => Math.floor(Number(i))))];
  for (const i of unique) if (!Number.isInteger(i) || i < 0 || i >= count) throw new EngineError('range', `Page ${i + 1} does not exist (the document has ${count} pages)`);
  return unique.sort((a, b) => a - b);
}

// ---- pages -----------------------------------------------------------------------------------------------

export async function getPageInfo(bytes) {
  const doc = await load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { width, height, rotation: p.getRotation().angle };
  });
  return { count: pages.length, pages };
}

export async function rotatePages(bytes, pageIndices, deltaDeg) {
  const doc = await load(bytes);
  const delta = ((Math.round(Number(deltaDeg) / 90) * 90) % 360 + 360) % 360;
  for (const i of checkIndices(pageIndices, doc.getPageCount())) {
    const page = doc.getPage(i);
    page.setRotation(degrees((page.getRotation().angle + delta) % 360));
  }
  return save(doc);
}

export async function deletePages(bytes, pageIndices) {
  const doc = await load(bytes);
  const indices = checkIndices(pageIndices, doc.getPageCount());
  if (indices.length >= doc.getPageCount()) throw new EngineError('range', 'A document must keep at least one page');
  for (const i of [...indices].reverse()) doc.removePage(i);
  return save(doc);
}

/** newOrder[i] = old index of the page that ends up at position i (a permutation of 0..n-1). */
export async function reorderPages(bytes, newOrder) {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  if (!Array.isArray(newOrder) || newOrder.length !== count || new Set(newOrder).size !== count || newOrder.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
    throw new EngineError('range', 'The new page order must list every page exactly once');
  }
  if (newOrder.every((v, i) => v === i)) return save(doc);
  const pages = doc.getPages();
  // Remove every leaf, then re-insert in the requested order (page objects stay valid).
  for (let i = count - 1; i >= 0; i--) doc.removePage(i);
  newOrder.forEach((oldIndex, i) => doc.insertPage(i, pages[oldIndex]));
  return save(doc);
}

export async function insertPages(bytes, otherBytes, atIndex, pageIndices) {
  const doc = await load(bytes);
  const other = await load(otherBytes);
  const count = doc.getPageCount();
  const at = Math.max(0, Math.min(count, Math.floor(Number(atIndex) ?? count)));
  const indices = pageIndices ? checkIndices(pageIndices, other.getPageCount()) : other.getPageIndices();
  const copied = await doc.copyPages(other, indices);
  copied.forEach((page, i) => doc.insertPage(at + i, page));
  return save(doc);
}

export async function extractPages(bytes, pageIndices) {
  const doc = await load(bytes);
  const indices = checkIndices(pageIndices, doc.getPageCount());
  const out = await PDFDocument.create();
  copyMetadata(doc, out);
  const copied = await out.copyPages(doc, indices);
  for (const page of copied) out.addPage(page);
  return save(out);
}

export async function splitByRanges(bytes, ranges) {
  const doc = await load(bytes);
  const results = [];
  for (const range of ranges) {
    const indices = checkIndices(range, doc.getPageCount());
    const out = await PDFDocument.create();
    copyMetadata(doc, out);
    const copied = await out.copyPages(doc, indices);
    for (const page of copied) out.addPage(page);
    results.push(await save(out));
  }
  return results;
}

export async function mergeDocuments(list) {
  if (!Array.isArray(list) || !list.length) throw new EngineError('range', 'No documents to combine');
  const out = await PDFDocument.create();
  out.setProducer('Folio PDF');
  out.setCreator('Folio PDF');
  for (const bytes of list) {
    const doc = await load(bytes);
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  return save(out);
}

export async function cropPages(bytes, pageIndices, box) {
  const doc = await load(bytes);
  const { x, y, width, height } = box ?? {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new EngineError('range', 'Invalid crop box');
  for (const i of checkIndices(pageIndices, doc.getPageCount())) doc.getPage(i).setCropBox(x, y, width, height);
  return save(doc);
}

function copyMetadata(from, to) {
  try {
    const title = from.getTitle();
    if (title) to.setTitle(title);
    const author = from.getAuthor();
    if (author) to.setAuthor(author);
    const subject = from.getSubject();
    if (subject) to.setSubject(subject);
  } catch {
    /* ignore */
  }
  to.setProducer('Folio PDF');
  to.setCreator('Folio PDF');
}

// ---- document --------------------------------------------------------------------------------------------

export async function getMetadata(bytes) {
  const doc = await load(bytes, { ignoreEncryption: true });
  const safe = (fn) => {
    try {
      return fn() ?? '';
    } catch {
      return '';
    }
  };
  return {
    title: safe(() => doc.getTitle()),
    author: safe(() => doc.getAuthor()),
    subject: safe(() => doc.getSubject()),
    keywords: safe(() => doc.getKeywords()),
    creator: safe(() => doc.getCreator()),
    producer: safe(() => doc.getProducer()),
    creationDate: safe(() => doc.getCreationDate()) || null,
    modificationDate: safe(() => doc.getModificationDate()) || null,
    pageCount: doc.getPageCount(),
  };
}

export async function setMetadata(bytes, patch = {}) {
  const doc = await load(bytes);
  if (patch.title !== undefined) doc.setTitle(String(patch.title), { showInWindowTitleBar: true });
  if (patch.author !== undefined) doc.setAuthor(String(patch.author));
  if (patch.subject !== undefined) doc.setSubject(String(patch.subject));
  if (patch.keywords !== undefined) {
    const words = Array.isArray(patch.keywords) ? patch.keywords.map(String) : String(patch.keywords).split(/[,;]\s*/).filter(Boolean);
    doc.setKeywords(words.length ? [words.join(', ')] : []);
  }
  if (patch.creator !== undefined) doc.setCreator(String(patch.creator));
  if (patch.producer !== undefined) doc.setProducer(String(patch.producer));
  doc.setModificationDate(new Date());
  return save(doc);
}

export async function flattenForms(bytes) {
  const doc = await load(bytes);
  let form;
  try {
    form = doc.getForm();
  } catch {
    return save(doc);
  }
  try {
    form.updateFieldAppearances();
  } catch {
    /* fields without fonts: keep the existing appearances */
  }
  try {
    form.flatten({ updateFieldAppearances: false });
  } catch (err) {
    throw new EngineError('unsupported', `Could not flatten the form: ${err.message}`);
  }
  return save(doc);
}

export async function getFormData(bytes) {
  const doc = await load(bytes, { ignoreEncryption: true });
  let form;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  const out = [];
  for (const field of form.getFields()) {
    const type = field.constructor.name.replace(/^PDF/, '');
    let value = null;
    try {
      if (type === 'TextField') value = field.getText() ?? '';
      else if (type === 'CheckBox') value = field.isChecked();
      else if (type === 'RadioGroup') value = field.getSelected() ?? null;
      else if (type === 'Dropdown') value = field.getSelected();
      else if (type === 'OptionList') value = field.getSelected();
      else if (type === 'Signature') value = null;
    } catch {
      value = null;
    }
    out.push({ name: field.getName(), type, value });
  }
  return out;
}

export async function resetForm(bytes) {
  const doc = await load(bytes);
  let form;
  try {
    form = doc.getForm();
  } catch {
    return save(doc);
  }
  for (const field of form.getFields()) {
    const type = field.constructor.name;
    try {
      if (type === 'PDFTextField') field.setText('');
      else if (type === 'PDFCheckBox') field.uncheck();
      else if (type === 'PDFRadioGroup') field.clear();
      else if (type === 'PDFDropdown') field.clear();
      else if (type === 'PDFOptionList') field.clear();
    } catch {
      /* read-only or odd field: skip */
    }
  }
  try {
    form.updateFieldAppearances();
  } catch {
    /* ignore */
  }
  return save(doc);
}

const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1190.55], A5: [419.53, 595.28] };

export async function imagesToPdf(images, { pageSize = 'fit', margin = 0, landscape = false } = {}) {
  if (!Array.isArray(images) || !images.length) throw new EngineError('range', 'No images given');
  const doc = await PDFDocument.create();
  doc.setProducer('Folio PDF');
  doc.setCreator('Folio PDF');
  for (const { bytes, type } of images) {
    const image = type === 'jpeg' || type === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    if (pageSize === 'fit') {
      const page = doc.addPage([image.width + margin * 2, image.height + margin * 2]);
      page.drawImage(image, { x: margin, y: margin, width: image.width, height: image.height });
      continue;
    }
    let [w, h] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.A4;
    if (landscape) [w, h] = [h, w];
    const page = doc.addPage([w, h]);
    const maxW = w - margin * 2, maxH = h - margin * 2;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1e9);
    const dw = image.width * scale, dh = image.height * scale;
    page.drawImage(image, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
  }
  return save(doc);
}

/** Builds a PDF whose pages are PNG renderings (used by "flatten everything" / rasterized copies). */
export async function rasterizedCopy(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new EngineError('range', 'No pages given');
  const doc = await PDFDocument.create();
  doc.setProducer('Folio PDF');
  for (const { png, widthPt, heightPt } of pages) {
    const image = await doc.embedPng(png);
    const page = doc.addPage([widthPt, heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  return save(doc);
}

// ---- annotation helpers ----------------------------------------------------------------------------------

function refToId(ref) {
  return annotId(ref.objectNumber, ref.generationNumber);
}

function idToRef(id) {
  const parsed = parseAnnotId(id);
  if (!parsed) throw new EngineError('range', `Invalid annotation id "${id}"`);
  return PDFRef.of(parsed.num, parsed.gen);
}

function textOf(obj) {
  if (!obj) return '';
  if (obj instanceof PDFHexString || obj instanceof PDFString) {
    try {
      return obj.decodeText();
    } catch {
      return obj.asString?.() ?? '';
    }
  }
  if (obj instanceof PDFName) return obj.decodeText();
  return '';
}

function numberArray(doc, arr) {
  if (!(arr instanceof PDFArray)) return null;
  const out = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = doc.context.lookup(arr.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

function dictNumber(doc, dict, key, fallback) {
  const v = doc.context.lookup(dict.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function colorArrayToHex(arr) {
  if (!arr || !arr.length) return null;
  if (arr.length === 1) return colorToHex([arr[0], arr[0], arr[0]]);
  if (arr.length === 4) {
    const [c, m, y, k] = arr;
    return colorToHex([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]);
  }
  return colorToHex(arr);
}

/** Text colour from a default-appearance string such as "0 0 1 rg /Helv 12 Tf". */
function colorFromDA(da) {
  if (!da) return null;
  const rgb = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg/.exec(da);
  if (rgb) return colorToHex([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]);
  const g = /(-?[\d.]+)\s+g\b/.exec(da);
  if (g) return colorToHex([Number(g[1]), Number(g[1]), Number(g[1])]);
  return null;
}

/** All annotation (ref, dict) pairs of a page with the Annots array, creating the array when missing. */
function pageAnnots(doc, page) {
  let annots = page.node.Annots();
  if (!annots) {
    annots = doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  return annots;
}

function resolveDict(doc, obj) {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFDict ? v : null;
}

function findAnnotation(doc, id) {
  const ref = idToRef(id);
  const dict = doc.context.lookup(ref);
  if (!(dict instanceof PDFDict)) throw new EngineError('range', 'The annotation no longer exists');
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pages[p].node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && entry.objectNumber === ref.objectNumber && entry.generationNumber === ref.generationNumber) {
        return { ref, dict, page: pages[p], pageIndex: p, annots, index: i };
      }
    }
  }
  return { ref, dict, page: null, pageIndex: -1, annots: null, index: -1 };
}

function makeAppearanceRef(doc, { content, resources, bbox, matrix }) {
  const dict = { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox, Resources: resources ?? {} };
  if (matrix) dict.Matrix = matrix;
  const stream = doc.context.flateStream(content, dict);
  return doc.context.register(stream);
}

function setAppearance(doc, dict, ap) {
  const old = dict.get(PDFName.of('AP'));
  const oldDict = resolveDict(doc, old);
  const oldN = oldDict?.get(PDFName.of('N'));
  if (oldN instanceof PDFRef) {
    try {
      doc.context.delete(oldN);
    } catch {
      /* ignore */
    }
  }
  dict.set(PDFName.of('AP'), doc.context.obj({ N: makeAppearanceRef(doc, ap) }));
}

function commonFields({ author, contents, subject, color, opacity, now }) {
  const date = PDFString.of(toPdfDate(now ?? new Date()));
  const fields = {
    Type: 'Annot',
    F: FLAG_PRINT,
    NM: PDFString.of(randomName()),
    M: date,
    CreationDate: date,
    T: PDFHexString.fromText(String(author ?? '')),
  };
  if (contents !== undefined && contents !== null) fields.Contents = PDFHexString.fromText(String(contents));
  if (subject) fields.Subj = PDFHexString.fromText(String(subject));
  const c = parseColor(color);
  if (c) fields.C = c;
  if (opacity !== undefined && opacity !== null && Number.isFinite(opacity)) fields.CA = Math.max(0, Math.min(1, opacity));
  return fields;
}

function randomName() {
  const bytes = new Uint8Array(8);
  (globalThis.crypto ?? { getRandomValues: (b) => b.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  return 'folio-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function helvetica(doc) {
  if (!doc.__folioHelv) doc.__folioHelv = await doc.embedFont(StandardFonts.Helvetica);
  return doc.__folioHelv;
}

// ---- annotations ------------------------------------------------------------------------------------------

export async function listAnnotations(bytes) {
  const doc = await load(bytes, { ignoreEncryption: true });
  const out = [];
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pages[p].node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      if (!(entry instanceof PDFRef)) continue;
      const dict = resolveDict(doc, entry);
      if (!dict) continue;
      const subtype = textOf(dict.get(PDFName.of('Subtype')));
      if (!MARKUP_SUBTYPES.has(subtype)) continue;
      const irt = dict.get(PDFName.of('IRT'));
      const flags = dictNumber(doc, dict, 'F', 0);
      const rect = numberArray(doc, doc.context.lookup(dict.get(PDFName.of('Rect')))) ?? [0, 0, 0, 0];
      let color = colorArrayToHex(numberArray(doc, doc.context.lookup(dict.get(PDFName.of('C')))));
      if (!color && subtype === 'FreeText') color = colorFromDA(textOf(dict.get(PDFName.of('DA'))));
      out.push({
        id: refToId(entry),
        page: p,
        subtype,
        rect: normRect(rect),
        contents: textOf(dict.get(PDFName.of('Contents'))),
        author: textOf(dict.get(PDFName.of('T'))),
        created: fromPdfDate(textOf(dict.get(PDFName.of('CreationDate')))),
        modified: fromPdfDate(textOf(dict.get(PDFName.of('M')))),
        color,
        opacity: dictNumber(doc, dict, 'CA', 1),
        inReplyTo: irt instanceof PDFRef ? refToId(irt) : null,
        name: textOf(dict.get(PDFName.of('NM'))) || null,
        hidden: (flags & FLAG_HIDDEN) !== 0,
        subject: textOf(dict.get(PDFName.of('Subj'))) || null,
      });
    }
  }
  return out;
}

export async function addAnnotation(bytes, pageIndex, spec) {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) throw new EngineError('range', `Page ${pageIndex + 1} does not exist`);
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const now = new Date();
  let dictLiteral;
  let ap = null;
  const extraRefs = [];
  const base = (overrides) => ({ ...commonFields({ ...spec, now }), ...overrides });

  switch (spec.type) {
    case 'note': {
      const rect = normRect(spec.rect ?? [0, 0, 20, 20]);
      const { width, height } = page.getSize();
      dictLiteral = base({ Subtype: 'Text', Rect: rect, Name: spec.icon ?? 'Comment', Open: !!spec.open });
      const popupRect = [Math.min(rect[2] + 10, Math.max(0, width - 190)), Math.max(0, Math.min(rect[3], height) - 130), Math.min(rect[2] + 190, Math.max(180, width)), Math.min(rect[3], height)];
      const annotRef = ctx.nextRef();
      const popupRef = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: popupRect, Parent: annotRef, Open: !!spec.open, F: 28 }));
      dictLiteral.Popup = popupRef;
      ctx.assign(annotRef, ctx.obj(dictLiteral));
      pageAnnots(doc, page).push(annotRef);
      pageAnnots(doc, page).push(popupRef);
      return { bytes: await save(doc), id: refToId(annotRef) };
    }
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const quads = (spec.quads ?? []).filter((q) => Array.isArray(q) && q.length === 8);
      if (!quads.length) throw new EngineError('range', 'No text selected');
      const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' }[spec.type];
      const builder = { highlight: highlightAppearance, underline: underlineAppearance, strikeout: strikeoutAppearance, squiggly: squigglyAppearance }[spec.type];
      const opacity = spec.opacity ?? 1;
      ap = builder({ quads, color: spec.color, opacity });
      dictLiteral = base({ Subtype: subtype, Rect: quadsBounds(quads), QuadPoints: quads.flat(), CA: opacity });
      break;
    }
    case 'square':
    case 'circle': {
      const rect = normRect(spec.rect);
      const width = spec.width ?? 2;
      const opacity = spec.opacity ?? 1;
      ap = (spec.type === 'square' ? squareAppearance : circleAppearance)({ rect, color: spec.color, fill: spec.fill, width, opacity });
      dictLiteral = base({ Subtype: spec.type === 'square' ? 'Square' : 'Circle', Rect: rect, BS: { W: width, S: 'S' }, CA: opacity });
      const fill = parseColor(spec.fill);
      if (fill) dictLiteral.IC = fill;
      break;
    }
    case 'line':
    case 'arrow': {
      const [x1, y1] = spec.start;
      const [x2, y2] = spec.end;
      const width = spec.width ?? 2;
      const opacity = spec.opacity ?? 1;
      ap = lineAppearance({ start: [x1, y1], end: [x2, y2], color: spec.color, width, opacity, arrow: spec.type === 'arrow' });
      dictLiteral = base({ Subtype: 'Line', Rect: ap.bbox, L: [x1, y1, x2, y2], BS: { W: width, S: 'S' }, CA: opacity, LE: [PDFName.of('None'), PDFName.of(spec.type === 'arrow' ? 'OpenArrow' : 'None')] });
      const c = parseColor(spec.color);
      if (c) dictLiteral.IC = c;
      break;
    }
    case 'ink': {
      const paths = (spec.paths ?? []).filter((p) => Array.isArray(p) && p.length >= 2);
      if (!paths.length) throw new EngineError('range', 'Nothing drawn');
      const width = spec.width ?? 2;
      const opacity = spec.opacity ?? 1;
      ap = inkAppearance({ paths, color: spec.color, width, opacity });
      dictLiteral = base({ Subtype: 'Ink', Rect: ap.bbox, InkList: paths, BS: { W: width, S: 'S' }, CA: opacity });
      break;
    }
    case 'freetext': {
      const rect = normRect(spec.rect);
      const font = await helvetica(doc);
      const fontSize = spec.fontSize ?? 12;
      ap = freeTextAppearance({ rect, text: spec.text ?? '', font, fontRef: font.ref, fontSize, color: spec.color, border: spec.border ?? 0, borderColor: spec.borderColor, background: spec.background });
      dictLiteral = base({ Subtype: 'FreeText', Rect: rect, DA: PDFString.of(ap.da), Contents: PDFHexString.fromText(String(spec.text ?? '')), Q: 0 });
      ensureAcroFormFont(doc, font.ref);
      break;
    }
    case 'stamp-image': {
      const rect = normRect(spec.rect);
      const image = spec.imageType === 'jpeg' || spec.imageType === 'jpg' ? await doc.embedJpg(spec.image) : await doc.embedPng(spec.image);
      ap = imageStampAppearance({ rect, imageRef: image.ref, imageWidth: image.width, imageHeight: image.height });
      dictLiteral = base({ Subtype: 'Stamp', Rect: rect, Name: PDFName.of('FolioImage'), Subj: PDFHexString.fromText(spec.subject ?? 'Image') });
      break;
    }
    case 'stamp-text': {
      const rect = normRect(spec.rect);
      const font = await helvetica(doc);
      ap = textStampAppearance({ rect, text: spec.text ?? 'DRAFT', font, fontRef: font.ref, color: spec.color ?? '#c62828' });
      dictLiteral = base({ Subtype: 'Stamp', Rect: rect, Name: PDFName.of('Folio' + String(spec.text ?? 'Draft').replace(/[^A-Za-z0-9]/g, '')), Subj: PDFHexString.fromText(spec.text ?? 'Stamp'), Contents: PDFHexString.fromText(spec.contents ?? spec.text ?? '') });
      break;
    }
    default:
      throw new EngineError('unsupported', `Unknown annotation type "${spec.type}"`);
  }

  const dict = ctx.obj(dictLiteral);
  if (ap) dict.set(PDFName.of('AP'), ctx.obj({ N: makeAppearanceRef(doc, ap) }));
  const ref = ctx.register(dict);
  pageAnnots(doc, page).push(ref);
  for (const r of extraRefs) pageAnnots(doc, page).push(r);
  return { bytes: await save(doc), id: refToId(ref) };
}

/** Registers Helvetica in the AcroForm default resources so Acrobat can regenerate FreeText appearances. */
function ensureAcroFormFont(doc, fontRef) {
  try {
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (!acro) return;
    let dr = acro.lookupMaybe(PDFName.of('DR'), PDFDict);
    if (!dr) {
      dr = doc.context.obj({});
      acro.set(PDFName.of('DR'), dr);
    }
    let fonts = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!fonts) {
      fonts = doc.context.obj({});
      dr.set(PDFName.of('Font'), fonts);
    }
    if (!fonts.has(PDFName.of('Helv'))) fonts.set(PDFName.of('Helv'), fontRef);
  } catch {
    /* ignore */
  }
}

export async function updateAnnotation(bytes, id, patch = {}) {
  const doc = await load(bytes);
  const { dict } = findAnnotation(doc, id);
  const ctx = doc.context;
  if (patch.contents !== undefined) dict.set(PDFName.of('Contents'), PDFHexString.fromText(String(patch.contents ?? '')));
  if (patch.author !== undefined) dict.set(PDFName.of('T'), PDFHexString.fromText(String(patch.author ?? '')));
  if (patch.subject !== undefined) dict.set(PDFName.of('Subj'), PDFHexString.fromText(String(patch.subject ?? '')));
  if (patch.color !== undefined) {
    const c = parseColor(patch.color);
    if (c) dict.set(PDFName.of('C'), ctx.obj(c));
    else dict.delete(PDFName.of('C'));
  }
  if (patch.opacity !== undefined && Number.isFinite(patch.opacity)) dict.set(PDFName.of('CA'), PDFNumber.of(Math.max(0, Math.min(1, patch.opacity))));
  if (patch.hidden !== undefined) {
    const flags = dictNumber(doc, dict, 'F', FLAG_PRINT);
    dict.set(PDFName.of('F'), PDFNumber.of(patch.hidden ? flags | FLAG_HIDDEN : flags & ~FLAG_HIDDEN));
  }
  if (patch.rect !== undefined) dict.set(PDFName.of('Rect'), ctx.obj(normRect(patch.rect)));
  if (patch.open !== undefined) {
    dict.set(PDFName.of('Open'), patch.open ? PDFBool.True : PDFBool.False);
    const popup = resolveDict(doc, dict.get(PDFName.of('Popup')));
    popup?.set(PDFName.of('Open'), patch.open ? PDFBool.True : PDFBool.False);
  }
  dict.set(PDFName.of('M'), PDFString.of(toPdfDate(new Date())));
  if (patch.color !== undefined || patch.opacity !== undefined || patch.contents !== undefined || patch.rect !== undefined) await regenerateAppearance(doc, dict);
  return save(doc);
}

/** Rebuilds the appearance stream of annotations the engine knows how to draw; otherwise drops it. */
async function regenerateAppearance(doc, dict) {
  const subtype = textOf(dict.get(PDFName.of('Subtype')));
  const color = colorArrayToHex(numberArray(doc, doc.context.lookup(dict.get(PDFName.of('C')))));
  const opacity = dictNumber(doc, dict, 'CA', 1);
  const rect = numberArray(doc, doc.context.lookup(dict.get(PDFName.of('Rect'))));
  const bs = resolveDict(doc, dict.get(PDFName.of('BS')));
  const width = bs ? dictNumber(doc, bs, 'W', 1) : 1;
  const fill = colorArrayToHex(numberArray(doc, doc.context.lookup(dict.get(PDFName.of('IC')))));
  const quadsFlat = numberArray(doc, doc.context.lookup(dict.get(PDFName.of('QuadPoints'))));
  const quads = quadsFlat ? Array.from({ length: Math.floor(quadsFlat.length / 8) }, (_, i) => quadsFlat.slice(i * 8, i * 8 + 8)) : null;
  let ap = null;
  try {
    switch (subtype) {
      case 'Highlight': ap = quads && highlightAppearance({ quads, color, opacity }); break;
      case 'Underline': ap = quads && underlineAppearance({ quads, color, opacity }); break;
      case 'StrikeOut': ap = quads && strikeoutAppearance({ quads, color, opacity }); break;
      case 'Squiggly': ap = quads && squigglyAppearance({ quads, color, opacity }); break;
      case 'Square': ap = rect && squareAppearance({ rect, color, fill, width, opacity }); break;
      case 'Circle': ap = rect && circleAppearance({ rect, color, fill, width, opacity }); break;
      case 'Line': {
        const l = numberArray(doc, doc.context.lookup(dict.get(PDFName.of('L'))));
        const le = doc.context.lookup(dict.get(PDFName.of('LE')));
        const arrow = le instanceof PDFArray && le.size() > 1 && /Arrow/.test(textOf(doc.context.lookup(le.get(1))));
        if (l && l.length === 4) {
          ap = lineAppearance({ start: [l[0], l[1]], end: [l[2], l[3]], color, width, opacity, arrow });
          dict.set(PDFName.of('Rect'), doc.context.obj(ap.bbox));
        }
        break;
      }
      case 'Ink': {
        const inkList = doc.context.lookup(dict.get(PDFName.of('InkList')));
        if (inkList instanceof PDFArray) {
          const paths = [];
          for (let i = 0; i < inkList.size(); i++) paths.push(numberArray(doc, doc.context.lookup(inkList.get(i))) ?? []);
          ap = inkAppearance({ paths, color, width, opacity });
        }
        break;
      }
      case 'FreeText': {
        const font = await helvetica(doc);
        const da = textOf(dict.get(PDFName.of('DA')));
        const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 12;
        ap = rect && freeTextAppearance({ rect, text: textOf(dict.get(PDFName.of('Contents'))), font, fontRef: font.ref, fontSize: size, color: color ?? '#000000' });
        if (ap) dict.set(PDFName.of('DA'), PDFString.of(ap.da));
        break;
      }
      default:
        return; // keep whatever appearance exists (stamps, notes)
    }
  } catch {
    ap = null;
  }
  if (ap) setAppearance(doc, dict, ap);
  else dict.delete(PDFName.of('AP'));
}

export async function deleteAnnotation(bytes, id) {
  const doc = await load(bytes);
  const { ref, dict, annots, index } = findAnnotation(doc, id);
  const toRemove = new Set([refKey(ref)]);
  const popup = dict.get(PDFName.of('Popup'));
  if (popup instanceof PDFRef) toRemove.add(refKey(popup));
  // replies (any annotation whose IRT points at a removed annotation, transitively)
  if (annots) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        if (!(entry instanceof PDFRef) || toRemove.has(refKey(entry))) continue;
        const d = resolveDict(doc, entry);
        const irt = d?.get(PDFName.of('IRT'));
        if (irt instanceof PDFRef && toRemove.has(refKey(irt))) {
          toRemove.add(refKey(entry));
          const p = d.get(PDFName.of('Popup'));
          if (p instanceof PDFRef) toRemove.add(refKey(p));
          changed = true;
        }
      }
    }
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && toRemove.has(refKey(entry))) annots.remove(i);
    }
  } else if (index === -1) {
    throw new EngineError('range', 'The annotation is not attached to a page');
  }
  for (const key of toRemove) {
    const [num, gen] = key.split('/').map(Number);
    try {
      doc.context.delete(PDFRef.of(num, gen));
    } catch {
      /* ignore */
    }
  }
  return save(doc);
}

function refKey(ref) {
  return `${ref.objectNumber}/${ref.generationNumber}`;
}

export async function addReply(bytes, parentId, { contents, author }) {
  const doc = await load(bytes);
  const { ref: parentRef, dict: parent, page } = findAnnotation(doc, parentId);
  if (!page) throw new EngineError('range', 'The annotation is not attached to a page');
  const rect = numberArray(doc, doc.context.lookup(parent.get(PDFName.of('Rect')))) ?? [0, 0, 20, 20];
  const ctx = doc.context;
  const dict = ctx.obj({
    ...commonFields({ author, contents, now: new Date() }),
    Subtype: 'Text',
    Rect: rect,
    IRT: parentRef,
    RT: 'R',
    Name: 'Comment',
    F: FLAG_PRINT | FLAG_HIDDEN,
  });
  const ref = ctx.register(dict);
  pageAnnots(doc, page).push(ref);
  parent.set(PDFName.of('M'), PDFString.of(toPdfDate(new Date())));
  return { bytes: await save(doc), id: refToId(ref) };
}

/**
 * Bakes annotation appearances into the page content (PDF 32000-1 algorithm 8.1) and removes the
 * annotations. Widgets (form fields) are left alone: use flattenForms for those. Annotations without
 * an appearance stream (e.g. note icons) are simply removed.
 */
export async function flattenAnnotations(bytes) {
  const doc = await load(bytes);
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const dict = resolveDict(doc, ref);
      if (!dict) continue;
      const subtype = textOf(dict.get(PDFName.of('Subtype')));
      if (subtype === 'Widget' || subtype === 'Link') {
        keep.push(ref);
        continue;
      }
      if (subtype === 'Popup') continue;
      const flags = dictNumber(doc, dict, 'F', 0);
      if (flags & FLAG_HIDDEN) continue;
      const streamRef = appearanceStreamRef(doc, dict);
      const stream = streamRef ? doc.context.lookup(streamRef) : null;
      const rect = numberArray(doc, doc.context.lookup(dict.get(PDFName.of('Rect'))));
      if (!(stream instanceof PDFStream) || !rect || rect.length !== 4) continue;
      const bbox = numberArray(doc, doc.context.lookup(stream.dict.get(PDFName.of('BBox')))) ?? [0, 0, 1, 1];
      const m = numberArray(doc, doc.context.lookup(stream.dict.get(PDFName.of('Matrix')))) ?? [1, 0, 0, 1, 0, 0];
      const corners = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const tx1 = Math.min(...corners.map((c) => c[0])), tx2 = Math.max(...corners.map((c) => c[0]));
      const ty1 = Math.min(...corners.map((c) => c[1])), ty2 = Math.max(...corners.map((c) => c[1]));
      const [rx1, ry1, rx2, ry2] = normRect(rect);
      const sx = tx2 - tx1 > 1e-9 ? (rx2 - rx1) / (tx2 - tx1) : 1;
      const sy = ty2 - ty1 > 1e-9 ? (ry2 - ry1) / (ty2 - ty1) : 1;
      const name = page.node.newXObject('FolioAnnot', streamRef instanceof PDFRef ? streamRef : doc.context.register(stream));
      const ops = [pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx1 - tx1 * sx, ry1 - ty1 * sy)];
      const opacity = dictNumber(doc, dict, 'CA', 1);
      if (opacity < 1) {
        const gs = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity }));
        ops.push(setGraphicsState(page.node.newExtGState('FolioGS', gs)));
      }
      ops.push(drawObject(name), popGraphicsState());
      page.pushOperators(...ops);
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
  return save(doc);
}

/** The /AP /N stream ref of an annotation, honouring /AS for state dictionaries. */
function appearanceStreamRef(doc, dict) {
  const ap = resolveDict(doc, dict.get(PDFName.of('AP')));
  if (!ap) return null;
  const n = ap.get(PDFName.of('N'));
  if (n instanceof PDFRef) {
    const obj = doc.context.lookup(n);
    if (obj instanceof PDFStream) return n;
    if (obj instanceof PDFDict) {
      const as = dict.get(PDFName.of('AS'));
      const pick = as instanceof PDFName ? obj.get(as) : obj.entries()[0]?.[1];
      return pick instanceof PDFRef ? pick : null;
    }
    return null;
  }
  if (n instanceof PDFDict) {
    const as = dict.get(PDFName.of('AS'));
    const pick = as instanceof PDFName ? n.get(as) : n.entries()[0]?.[1];
    return pick instanceof PDFRef ? pick : null;
  }
  return null;
}

/** Lightweight check without parsing the whole file. */
export function looksLikePdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) return false;
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}

export const _internal = { load, save, PDFStream };
