// Main-process printing helpers (src/main/print.js): option validation and the inline page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrintOptions, buildPrintHtml, printImage, isImageDataUrl } from '../../src/main/print.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizePrintOptions validates the data URL and fills in the page geometry', () => {
  assert.throws(() => normalizePrintOptions({}), /data URL/);
  assert.throws(() => normalizePrintOptions({ dataUrl: 'javascript:alert(1)' }), /data URL/);
  const o = normalizePrintOptions({ dataUrl: PNG, widthMm: 100, heightMm: 50, paper: { width: 210, height: 297 }, marginsMm: 10, offsetMm: { x: 20, y: 30 }, copies: '2', printer: 'HP' });
  assert.equal(o.pageW, 210);
  assert.equal(o.pageH, 297);
  assert.equal(o.widthMm, 100);
  assert.equal(o.x, 20);
  assert.equal(o.y, 30);
  assert.equal(o.copies, 2);
  assert.equal(o.printer, 'HP');
  assert.equal(o.pdf, false);
  // landscape swaps a portrait paper, centres by default
  const l = normalizePrintOptions({ dataUrl: PNG, widthMm: 100, heightMm: 50, paper: { width: 210, height: 297 }, landscape: true, marginsMm: 0 });
  assert.equal(l.pageW, 297);
  assert.equal(l.pageH, 210);
  assert.equal(l.x, (297 - 100) / 2);
  assert.equal(l.y, (210 - 50) / 2);
  // margins never exceed half the page
  assert.ok(normalizePrintOptions({ dataUrl: PNG, paper: { width: 100, height: 100 }, marginsMm: 80 }).margin < 50);
});

test('buildPrintHtml places the image in millimetres inside the @page box', () => {
  const html = buildPrintHtml(normalizePrintOptions({ dataUrl: PNG, widthMm: 100, heightMm: 50, paper: { width: 210, height: 297 }, marginsMm: 10, offsetMm: { x: 25, y: 40 } }));
  assert.match(html, /@page \{ size: 210mm 297mm; margin: 10mm; \}/);
  assert.match(html, /left: 15mm; top: 30mm; width: 100mm; height: 50mm/);
  assert.ok(html.includes(`src="${PNG}"`));
  assert.ok(!html.includes('<script'));
});

test('printImage resolves { ok: false } on bad input and drives a fake BrowserWindow', async () => {
  const bad = await printImage({ electron: {}, getWindow: () => null }, { dataUrl: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /data URL/);
  const calls = [];
  class FakeWindow {
    constructor(opts) {
      calls.push(['new', opts.show]);
      this.webContents = {
        on: (event) => calls.push(['on', event]),
        setWindowOpenHandler: (fn) => calls.push(['windowOpen', fn().action]),
        executeJavaScript: async () => true,
        print: (options, cb) => {
          calls.push(['print', options]);
          cb(true);
        },
        printToPDF: async (options) => {
          calls.push(['pdf', options]);
          return Buffer.from([1, 2, 3]);
        },
      };
    }
    async loadURL(url) {
      calls.push(['load', url.slice(0, 30)]);
    }
    isDestroyed() {
      return false;
    }
    destroy() {
      calls.push(['destroy']);
    }
  }
  const electron = { BrowserWindow: FakeWindow, app: { getPath: () => '/tmp' } };
  const r = await printImage({ electron, getWindow: () => null }, { dataUrl: PNG, widthMm: 100, heightMm: 50, paper: { width: 210, height: 297 }, marginsMm: 10, copies: 3, printer: 'Office', landscape: false });
  assert.deepEqual(r, { ok: true, reason: undefined });
  const print = calls.find((c) => c[0] === 'print')[1];
  assert.equal(print.deviceName, 'Office');
  assert.equal(print.copies, 3);
  assert.deepEqual(print.pageSize, { width: 210000, height: 297000 });
  assert.equal(print.margins.marginType, 'custom');
  assert.ok(Math.abs(print.margins.top - (10 * 96) / 25.4) < 1e-6);
  assert.equal(calls[0][1], false, 'the window is hidden');
  assert.ok(calls.some((c) => c[0] === 'on' && c[1] === 'will-navigate'), 'navigation is blocked');
  assert.ok(calls.some((c) => c[0] === 'windowOpen' && c[1] === 'deny'), 'new windows are denied');
  assert.ok(calls.some((c) => c[0] === 'destroy'));
  const pdf = await printImage({ electron, getWindow: () => null }, { dataUrl: PNG, widthMm: 100, heightMm: 50, paper: { width: 210, height: 297 }, marginsMm: 10, pdf: true });
  assert.equal(pdf.ok, true);
  assert.ok(pdf.pdf instanceof Uint8Array && pdf.pdf.length === 3);
  const pdfOpts = calls.find((c) => c[0] === 'pdf')[1];
  assert.equal(pdfOpts.preferCSSPageSize, true);
});

test('normalizePrintOptions accepts only well-formed base64 image data, and the print page allows no script', () => {
  assert.throws(() => normalizePrintOptions({ dataUrl: 'data:image/png;base64,AAAA" onload="fetch(1)"><script>fetch(2)</script>' }), /data URL/);
  assert.throws(() => normalizePrintOptions({ dataUrl: 'data:image/png;base64,AA AA' }), /data URL/);
  assert.equal(normalizePrintOptions({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQ==' }).dataUrl, 'data:image/jpeg;base64,/9j/4AAQ==');
  const html = buildPrintHtml(normalizePrintOptions({ dataUrl: PNG }));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.doesNotMatch(html, /<script/i);
});

test('isImageDataUrl: base64 characters only, padding only at the end', () => {
  for (const ok of ['data:image/png;base64,AAAA', 'data:image/png;base64,AA==', 'data:image/jpeg;base64,AAA=', 'data:image/webp;base64,a+/9']) assert.equal(isImageDataUrl(ok), true, ok);
  for (const bad of ['data:image/png;base64,', 'data:image/png;base64,A=AA', 'data:image/png;base64,AAA===', 'data:image/png;base64,AA"x', 'data:image/gif;base64,AAAA', 'data:text/html;base64,AAAA', null, 42]) assert.equal(isImageDataUrl(bad), false, String(bad));
});
