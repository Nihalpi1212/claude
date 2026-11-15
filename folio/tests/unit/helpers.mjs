// Shared helpers for unit tests: fixtures, pdf.js (legacy build) loading in Node, tiny PNGs.
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { makeTextPdf, makeFormPdf, makeMixedPdf, makeAnnotatedPdf, makeEncryptedPdf } from '../fixtures/make-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
const PDFJS_DIR = join(ROOT, 'node_modules', 'pdfjs-dist');

const cache = new Map();
export async function fixture(name) {
  if (!cache.has(name)) {
    const makers = { text: () => makeTextPdf(5), long: () => makeTextPdf(40), form: makeFormPdf, mixed: makeMixedPdf, annotated: makeAnnotatedPdf, secret: () => makeEncryptedPdf('secret') };
    cache.set(name, await makers[name]());
  }
  return cache.get(name).slice();
}

/** Loads bytes with pdf.js and returns the PDFDocumentProxy (caller destroys). */
export async function pdfjsLoad(bytes, password) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
    cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
    cMapPacked: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  return task.promise;
}

/** Convenience: run fn with a pdf.js document, then destroy it. */
export async function withPdfjs(bytes, fn) {
  const doc = await pdfjsLoad(bytes);
  try {
    return await fn(doc);
  } finally {
    await doc.loadingTask.destroy();
  }
}

export async function pageTexts(bytes) {
  return withPdfjs(bytes, async (doc) => {
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
    }
    return out;
  });
}

export async function annotationsOfPage(bytes, pageIndex = 0) {
  return withPdfjs(bytes, async (doc) => {
    const page = await doc.getPage(pageIndex + 1);
    return page.getAnnotations();
  });
}

/** pdf.js getFieldObjects() returns a Map name -> [parent, ...widgets]; the widget (page >= 0) id is the storage key. */
export function widgetOf(fields, name) {
  const entries = fields instanceof Map ? fields.get(name) : fields?.[name];
  return (entries ?? []).find((f) => f.page >= 0) ?? entries?.[0];
}

export async function pdflibLoad(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

export { pdfjs };

// ---- PNG encoder (RGBA, no dependencies) ----------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Solid colour PNG with an optional diagonal line, as a Uint8Array. */
export function makePng(width = 64, height = 32, rgba = [220, 30, 30, 255]) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 4 + 1) + 1 + x * 4;
      const onLine = Math.abs(x - (y * width) / height) < 2;
      raw[o] = onLine ? 0 : rgba[0];
      raw[o + 1] = onLine ? 0 : rgba[1];
      raw[o + 2] = onLine ? 0 : rgba[2];
      raw[o + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return new Uint8Array(png);
}
