// File › Print… (see ARCHITECTURE.md "0.2 features: printing"). A dialog with printer, paper size,
// orientation, margins, scale, position and copies plus a live page preview; OK flattens the
// document to a PNG data URL and hands the page geometry (all in millimetres) to the main process
// (src/main/print.js) through bridge.printImage. The browser build has no printer access: the same
// page is opened in a hidden frame and window.print() is called on it.
import { bridge, isElectron } from './bridge.js';
import { formDialog } from './form.js';
import { flattenDocument } from './compositor.js';
import { createCanvas } from './document.js';

export const PAPER_SIZES = {
  a4: { label: 'A4 (210 × 297 mm)', width: 210, height: 297 },
  letter: { label: 'Letter (8.5 × 11 in)', width: 215.9, height: 279.4 },
  legal: { label: 'Legal (8.5 × 14 in)', width: 215.9, height: 355.6 },
  a3: { label: 'A3 (297 × 420 mm)', width: 297, height: 420 },
  tabloid: { label: 'Tabloid (11 × 17 in)', width: 279.4, height: 431.8 },
  a5: { label: 'A5 (148 × 210 mm)', width: 148, height: 210 },
  custom: { label: 'Custom…', width: 210, height: 297 },
};

const MM_PER_INCH = 25.4;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pure page geometry: where the image lands on the page, in millimetres.
 * Returns { pageW, pageH, margin, printableW, printableH, widthMm, heightMm, x, y, scale, fits }.
 */
export function computePrintLayout({ docWidth, docHeight, dpi = 72, paper = 'a4', customWidth, customHeight, landscape = false, marginsMm = 10, scaleMode = 'fit', scalePercent = 100, position = 'center', offsetX = 0, offsetY = 0 }) {
  const size = PAPER_SIZES[paper] ?? PAPER_SIZES.a4;
  let pageW = paper === 'custom' ? Math.max(10, Number(customWidth) || size.width) : size.width;
  let pageH = paper === 'custom' ? Math.max(10, Number(customHeight) || size.height) : size.height;
  if (landscape) [pageW, pageH] = [pageH, pageW];
  const margin = Math.max(0, Math.min(Number(marginsMm) || 0, Math.min(pageW, pageH) / 2 - 1));
  const printableW = pageW - margin * 2, printableH = pageH - margin * 2;
  const d = Math.max(1, Number(dpi) || 72);
  const naturalW = (docWidth / d) * MM_PER_INCH, naturalH = (docHeight / d) * MM_PER_INCH;
  let scale;
  if (scaleMode === 'fit') scale = Math.min(printableW / naturalW, printableH / naturalH);
  else if (scaleMode === 'custom') scale = Math.max(0.01, Number(scalePercent) || 100) / 100;
  else scale = 1;
  const widthMm = naturalW * scale, heightMm = naturalH * scale;
  let x, y;
  if (position === 'offset') {
    x = margin + (Number(offsetX) || 0);
    y = margin + (Number(offsetY) || 0);
  } else {
    x = margin + (printableW - widthMm) / 2;
    y = margin + (printableH - heightMm) / 2;
  }
  const fits = widthMm <= printableW + 0.01 && heightMm <= printableH + 0.01 && x >= margin - 0.01 && y >= margin - 0.01 && x + widthMm <= pageW - margin + 0.01 && y + heightMm <= pageH - margin + 0.01;
  return { pageW: round2(pageW), pageH: round2(pageH), margin: round2(margin), printableW: round2(printableW), printableH: round2(printableH), widthMm: round2(widthMm), heightMm: round2(heightMm), x: round2(x), y: round2(y), scale, fits };
}

/** Draws the page preview (paper, margin box, the image) into a canvas that fits the preview box. */
export function drawPagePreview(layout, image, { maxW = 290, maxH = 210 } = {}) {
  const s = Math.min(maxW / layout.pageW, maxH / layout.pageH);
  const c = createCanvas(Math.max(1, Math.round(layout.pageW * s)), Math.max(1, Math.round(layout.pageH * s)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(layout.margin * s + 0.5, layout.margin * s + 0.5, layout.printableW * s - 1, layout.printableH * s - 1);
  ctx.setLineDash([]);
  if (image) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, layout.x * s, layout.y * s, layout.widthMm * s, layout.heightMm * s);
    ctx.restore();
  }
  ctx.strokeStyle = layout.fits ? 'rgba(0,0,0,0.5)' : '#d33';
  ctx.lineWidth = layout.fits ? 1 : 2;
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
  return c;
}

/** Builds the HTML of a print page for the browser fallback (the desktop app builds its own in main). */
function pageHtml({ dataUrl, widthMm, heightMm, pageW, pageH, margin, x, y }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>
@page { size: ${pageW}mm ${pageH}mm; margin: ${margin}mm; }
html, body { margin: 0; padding: 0; background: #fff; }
img { position: absolute; left: ${x - margin}mm; top: ${y - margin}mm; width: ${widthMm}mm; height: ${heightMm}mm; }
</style></head><body><img src="${dataUrl}" alt=""></body></html>`;
}

/** Browser fallback: prints the page from a hidden iframe (window.print on that frame). */
function printInBrowser(opts) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    frame.srcdoc = pageHtml(opts);
    frame.addEventListener('load', () => {
      try {
        const w = frame.contentWindow;
        w.focus();
        w.print();
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, reason: err?.message ?? String(err) });
      } finally {
        setTimeout(() => frame.remove(), 2000);
      }
    });
    document.body.appendChild(frame);
  });
}

export function install(app) {
  const has = () => !!app.doc;
  const prefs = () => (app.settings.printDefaults ??= {});

  async function printDialog() {
    app.tools.active?.commit?.();
    const d = app.doc;
    if (!d) return;
    let printers = [];
    try {
      printers = (await bridge.getPrinters?.()) ?? [];
    } catch {
      printers = [];
    }
    const saved = prefs();
    const printerOptions = printers.length ? printers.map((p) => [p.name, p.displayName || p.name]) : [['', 'Default printer']];
    const defaultPrinter = printers.find((p) => p.name === saved.printer)?.name ?? printers.find((p) => p.isDefault)?.name ?? printerOptions[0][0];
    const thumb = flattenDocument(d, d.view?.compositor);
    const base = { docWidth: d.width, docHeight: d.height, dpi: d.dpi || 72 };
    const layoutOf = (v) => computePrintLayout({ ...base, paper: v.paper, customWidth: v.customWidth, customHeight: v.customHeight, landscape: v.orientation === 'landscape', marginsMm: v.margins, scaleMode: v.scaleMode, scalePercent: v.scalePercent, position: v.position, offsetX: v.offsetX, offsetY: v.offsetY });
    let lastLayout = null;
    const fields = [
      { key: 'printer', label: 'Printer', type: 'select', value: defaultPrinter, options: printerOptions, span: true },
      { key: 'copies', label: 'Copies', type: 'number', value: 1, min: 1, max: 99 },
      { key: 'paper', label: 'Paper size', type: 'select', value: saved.paper ?? 'a4', options: Object.entries(PAPER_SIZES).map(([k, v]) => [k, v.label]) },
      { key: 'customWidth', label: 'Width', type: 'number', value: saved.customWidth ?? 210, min: 10, max: 2000, unit: 'mm', when: (v) => v.paper === 'custom' },
      { key: 'customHeight', label: 'Height', type: 'number', value: saved.customHeight ?? 297, min: 10, max: 2000, unit: 'mm', when: (v) => v.paper === 'custom' },
      { key: 'orientation', label: 'Orientation', type: 'segment', value: saved.orientation ?? (d.width > d.height ? 'landscape' : 'portrait'), options: [['portrait', 'Portrait'], ['landscape', 'Landscape']] },
      { key: 'margins', label: 'Margins', type: 'number', value: saved.margins ?? 10, min: 0, max: 100, step: 0.5, unit: 'mm' },
      { key: 'scaleMode', label: 'Scale', type: 'segment', value: saved.scaleMode ?? 'fit', options: [['fit', 'Fit to page'], ['actual', '100 %'], ['custom', 'Custom']], span: true },
      { key: 'scalePercent', label: 'Scale', type: 'number', value: saved.scalePercent ?? 100, min: 1, max: 1000, unit: '%', when: (v) => v.scaleMode === 'custom' },
      { key: 'position', label: 'Position', type: 'segment', value: saved.position ?? 'center', options: [['center', 'Center'], ['offset', 'Offset']] },
      { key: 'offsetX', label: 'Left', type: 'number', value: saved.offsetX ?? 0, min: -2000, max: 2000, step: 0.5, unit: 'mm', when: (v) => v.position === 'offset' },
      { key: 'offsetY', label: 'Top', type: 'number', value: saved.offsetY ?? 0, min: -2000, max: 2000, step: 0.5, unit: 'mm', when: (v) => v.position === 'offset' },
      {
        type: 'custom',
        key: '__info',
        render: () => {
          const p = document.createElement('p');
          p.className = 'muted print-info';
          p.style.margin = '0';
          return p;
        },
        sync: (values, node) => {
          const l = layoutOf(values);
          node.textContent = `${l.widthMm} × ${l.heightMm} mm at ${Math.round(l.scale * 100)} %${l.fits ? '' : ' — the image does not fit the printable area'}`;
          node.style.color = l.fits ? '' : 'var(--danger)';
        },
      },
    ];
    const buttons = [
      ...(isElectron ? [{ label: 'Save as PDF…', value: 'pdf' }] : []),
      { label: 'Cancel', value: null },
      { label: 'Print', value: true, primary: true },
    ];
    const values = await formDialog(app, {
      title: 'Print',
      fields,
      buttons,
      width: 720,
      preview: (v) => {
        lastLayout = layoutOf(v);
        return drawPagePreview(lastLayout, thumb);
      },
      previewDelay: 20,
      onChange: (v, key, form) => form.set('__info', null, { silent: true }),
      onOpen: (dialog, form) => form.set('__info', null, { silent: true }),
    });
    if (!values || app.doc !== d) return null;
    const layout = layoutOf(values);
    const { printer, copies, paper, customWidth, customHeight, orientation, margins, scaleMode, scalePercent, position, offsetX, offsetY } = values;
    app.saveSettingsSoon({ printDefaults: { printer, paper, customWidth, customHeight, orientation, margins, scaleMode, scalePercent, position, offsetX, offsetY } });
    const dataUrl = flattenDocument(d, d.view?.compositor).toDataURL('image/png');
    const opts = {
      dataUrl,
      widthMm: layout.widthMm,
      heightMm: layout.heightMm,
      paper: { width: layout.pageW, height: layout.pageH, name: paper },
      landscape: orientation === 'landscape',
      marginsMm: layout.margin,
      offsetMm: { x: layout.x, y: layout.y },
      printer: printer || undefined,
      copies: Math.max(1, Math.round(Number(copies) || 1)),
      silent: false,
      pdf: values.__button === 'pdf',
    };
    // test hook: the e2e spec reads the geometry handed to the bridge
    if (window.__pigmentTest) window.__pigmentTest.printed = { ...opts, dataUrl: dataUrl.slice(0, 22), dataUrlLength: dataUrl.length };
    return opts.pdf ? saveAsPdf(d, opts) : printNow(opts);
  }

  async function printNow(opts) {
    try {
      let result;
      if (isElectron || window.__pigmentTest?.silent) result = await bridge.printImage(opts);
      else result = await printInBrowser({ ...opts, pageW: opts.paper.width, pageH: opts.paper.height, margin: opts.marginsMm, x: opts.offsetMm.x, y: opts.offsetMm.y });
      if (result && result.ok === false && result.reason && !/cancel/i.test(result.reason)) app.dialogs.toast(`Printing failed: ${result.reason}`, { kind: 'error' });
      return result;
    } catch (err) {
      app.reportError(err, 'Printing failed');
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }

  async function saveAsPdf(d, opts) {
    try {
      const result = await app.busy('Rendering PDF…', () => bridge.printImage({ ...opts, pdf: true }));
      if (!result?.ok || !result.pdf) {
        if (result?.reason) app.dialogs.toast(`PDF failed: ${result.reason}`, { kind: 'error' });
        return result;
      }
      const name = (d.name || 'Untitled').replace(/\.[^.]+$/, '') + '.pdf';
      const path = await bridge.saveFileDialog({ title: 'Save as PDF', defaultPath: name, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
      if (!path) return { ok: false, reason: 'cancelled' };
      await bridge.writeFile(path, result.pdf instanceof Uint8Array ? result.pdf : new Uint8Array(result.pdf));
      app.dialogs.toast(`Saved ${path.split(/[\\/]/).pop()}`);
      return { ok: true, path };
    } catch (err) {
      app.reportError(err, 'Save as PDF failed');
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }

  app.print = { dialog: printDialog, computePrintLayout, PAPER_SIZES };
  app.commands.registerAll({
    'file:print': { enabled: has, label: 'Print…', run: () => printDialog() },
  });
}
