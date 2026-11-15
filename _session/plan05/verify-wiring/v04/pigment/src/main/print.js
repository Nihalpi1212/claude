// Printing (see ARCHITECTURE.md "0.2 features: printing"). The renderer hands over the flattened
// image as a PNG data URL plus the page geometry in millimetres; this module opens a hidden
// BrowserWindow on an inline HTML page (@page size and margins, the image positioned in mm) and
// prints it with webContents.print, or returns PDF bytes (printToPDF) when opts.pdf is true.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const MM_PER_INCH = 25.4;
const CSS_PX_PER_MM = 96 / MM_PER_INCH;
/** Chromium refuses to navigate to data: URLs much larger than this; bigger pages go through a temp file. */
const DATA_URL_LIMIT = 1_500_000;

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * A base64 PNG / JPEG / WebP data URL and nothing else. A negated character class runs in one linear
 * pass (a whole-string anchored regex took seconds on 100 MB prints, blocking the main process).
 */
export function isImageDataUrl(s) {
  if (typeof s !== 'string') return false;
  const m = /^data:image\/(png|jpeg|webp);base64,/.exec(s);
  if (!m) return false;
  const start = m[0].length;
  if (start >= s.length) return false;
  // scan in place (no copy of a possibly huge string): only base64 characters after the prefix
  const bad = /[^A-Za-z0-9+/=]/g;
  bad.lastIndex = start;
  if (bad.test(s)) return false;
  // '=' only as padding: at most the last two characters
  const eq = s.indexOf('=', start);
  return eq === -1 || (eq >= s.length - 2 && (eq === s.length - 1 || s[s.length - 1] === '='));
}

/** Validates and normalises the renderer's options (the renderer is sandboxed and untrusted). */
export function normalizePrintOptions(opts = {}) {
  // the whole string must be base64 image data: it is written into the print page's HTML
  const dataUrl = isImageDataUrl(opts.dataUrl) ? opts.dataUrl : null;
  if (!dataUrl) throw new Error('printImage needs a PNG/JPEG/WebP data URL');
  const paper = opts.paper && typeof opts.paper === 'object' ? opts.paper : {};
  let pageW = Math.max(10, num(paper.width, 210)), pageH = Math.max(10, num(paper.height, 297));
  const landscape = !!opts.landscape;
  // the renderer already swapped the page for landscape; accept either convention
  if (landscape && pageW < pageH) [pageW, pageH] = [pageH, pageW];
  const margin = Math.max(0, Math.min(num(opts.marginsMm, 10), Math.min(pageW, pageH) / 2 - 1));
  const widthMm = Math.max(0.1, num(opts.widthMm, pageW - margin * 2));
  const heightMm = Math.max(0.1, num(opts.heightMm, pageH - margin * 2));
  const offset = opts.offsetMm && typeof opts.offsetMm === 'object' ? opts.offsetMm : {};
  const x = num(offset.x, margin + (pageW - margin * 2 - widthMm) / 2);
  const y = num(offset.y, margin + (pageH - margin * 2 - heightMm) / 2);
  return {
    dataUrl,
    pageW,
    pageH,
    landscape,
    margin,
    widthMm,
    heightMm,
    x,
    y,
    printer: typeof opts.printer === 'string' && opts.printer ? opts.printer : null,
    copies: Math.max(1, Math.min(999, Math.round(num(opts.copies, 1)))),
    silent: !!opts.silent,
    pdf: !!opts.pdf,
  };
}

/** The inline page: @page carries the paper size and margins, the image sits at (x, y) mm on the page. */
export function buildPrintHtml(o) {
  const r = (n) => Math.round(n * 1000) / 1000;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Pigment print</title><style>
@page { size: ${r(o.pageW)}mm ${r(o.pageH)}mm; margin: ${r(o.margin)}mm; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { width: ${r(o.pageW - o.margin * 2)}mm; height: ${r(o.pageH - o.margin * 2)}mm; position: relative; overflow: hidden; }
img { position: absolute; left: ${r(o.x - o.margin)}mm; top: ${r(o.y - o.margin)}mm; width: ${r(o.widthMm)}mm; height: ${r(o.heightMm)}mm; image-rendering: auto; }
</style></head><body><img src="${o.dataUrl}" alt=""></body></html>`;
}

/**
 * @param {{ electron: typeof import('electron'), getWindow: () => import('electron').BrowserWindow | null }} ctx
 * @param {object} opts { dataUrl, widthMm, heightMm, paper: { width, height }, landscape, marginsMm, offsetMm: { x, y }, printer, copies, silent, pdf }
 * @returns {Promise<{ ok: boolean, reason?: string, pdf?: Uint8Array }>}
 */
export async function printImage({ electron, getWindow }, opts = {}) {
  let o;
  try {
    o = normalizePrintOptions(opts);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const { BrowserWindow, app } = electron;
  const parent = getWindow?.() ?? undefined;
  let win = null;
  let tempFile = null;
  try {
    win = new BrowserWindow({
      show: false,
      parent,
      width: 800,
      height: 600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, javascript: true },
    });
    // the print page never navigates or opens windows
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    const html = buildPrintHtml(o);
    if (html.length <= DATA_URL_LIMIT) await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    else {
      tempFile = join(app.getPath('temp'), `pigment-print-${process.pid}-${Date.now()}.html`);
      await fs.writeFile(tempFile, html, 'utf8');
      await win.loadFile(tempFile);
    }
    // make sure the image is decoded before the page is rasterised
    await Promise.race([
      win.webContents.executeJavaScript('(document.images[0] ? document.images[0].decode() : Promise.resolve()).then(() => true, () => false)', true).catch(() => false),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (o.pdf) {
      const buffer = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        landscape: false, // the @page rule already carries the orientation
        margins: { top: o.margin / MM_PER_INCH, bottom: o.margin / MM_PER_INCH, left: o.margin / MM_PER_INCH, right: o.margin / MM_PER_INCH },
        pageSize: { width: o.pageW / MM_PER_INCH, height: o.pageH / MM_PER_INCH },
      });
      return { ok: true, pdf: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
    }
    const marginPx = o.margin * CSS_PX_PER_MM;
    const options = {
      silent: o.silent,
      printBackground: true,
      copies: o.copies,
      landscape: o.landscape,
      // microns, as webContents.print expects; the orientation is already baked into the page size
      pageSize: { width: Math.round(o.pageW * 1000), height: Math.round(o.pageH * 1000) },
      margins: { marginType: 'custom', top: marginPx, bottom: marginPx, left: marginPx, right: marginPx },
    };
    if (o.printer) options.deviceName = o.printer;
    return await new Promise((resolve) => {
      try {
        win.webContents.print(options, (success, failureReason) => resolve({ ok: !!success, reason: success ? undefined : failureReason || 'Printing failed' }));
      } catch (err) {
        resolve({ ok: false, reason: err.message });
      }
    });
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
    if (tempFile) fs.unlink(tempFile).catch(() => {});
  }
}
