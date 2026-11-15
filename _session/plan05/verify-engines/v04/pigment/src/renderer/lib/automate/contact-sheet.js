// Automate: Contact Sheet. Thumbnails of a folder of images (or of the open documents) are laid out on
// one or more new documents: a white Background, one layer per thumbnail and a type layer per caption
// (or a single flattened layer). The grid arithmetic is in automate/naming.js.
import { bridge } from '../bridge.js';
import { createDocument, createCanvas, copyCanvas, RasterLayer, TextLayer, DEFAULT_TEXT_STYLE, cssFont, measureContext } from '../document.js';
import { flattenDocument } from '../compositor.js';
import { openDocument } from '../io.js';
import { formDialog } from '../form.js';
import { contactSheetLayout, placeThumbnail, paginate, splitName } from './naming.js';
import { listImages, progressDialog } from './batch.js';

export const SHEET_DEFAULTS = Object.freeze({
  source: 'folder', folder: '', subfolders: false,
  unit: 'in', width: 8, height: 10, dpi: 300, mode: 'rgb', flatten: true,
  across: true, columns: 5, rows: 6, autoSpacing: true, spacing: 20, rotate: false,
  caption: true, font: 'Arial', fontSize: 12,
});
const FONTS = ['Arial', 'Helvetica', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New'];
const UNIT_PX = { px: () => 1, in: (dpi) => dpi, cm: (dpi) => dpi / 2.54 };

export function sheetPixels(o) {
  const k = (UNIT_PX[o.unit] ?? UNIT_PX.px)(o.dpi);
  return { width: Math.round(o.width * k), height: Math.round(o.height * k) };
}

async function sheetDialog(app, start) {
  const values = { ...SHEET_DEFAULTS, ...start };
  if (values.source === 'open' && !app.docs.list().length) values.source = 'folder';
  let folderLabel = null;
  const o = await formDialog(app, {
    title: 'Contact Sheet',
    width: 520,
    className: 'automate-dialog',
    values,
    fields: [
      { type: 'section', label: 'Source Images' },
      { key: 'source', label: 'Use', type: 'select', value: values.source, options: [['folder', 'Folder'], ['open', `Open Documents (${app.docs.list().length})`]] },
      {
        key: 'folder', label: 'Folder', type: 'custom', when: (v) => v.source === 'folder',
        render: (vals, set) => {
          const row = document.createElement('div');
          row.className = 'automate-folder';
          const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Choose…' });
          folderLabel = Object.assign(document.createElement('span'), { className: 'automate-path muted', textContent: vals.folder || 'No folder chosen' });
          btn.addEventListener('click', async () => {
            const picked = await bridge.openDirectoryDialog?.({ title: 'Contact Sheet: folder of images' });
            const dir = Array.isArray(picked) ? picked[0] : picked;
            if (dir) set('folder', dir);
          });
          row.append(btn, folderLabel);
          return row;
        },
        sync: (vals) => folderLabel && (folderLabel.textContent = vals.folder || 'No folder chosen'),
      },
      { key: 'subfolders', label: 'Include Subfolders', type: 'checkbox', value: values.subfolders, when: (v) => v.source === 'folder' },
      { type: 'section', label: 'Document' },
      { key: 'unit', label: 'Units', type: 'select', value: values.unit, options: [['in', 'inches'], ['cm', 'cm'], ['px', 'pixels']] },
      { key: 'width', label: 'Width', type: 'number', value: values.width, min: 0.1, max: 30000, step: 0.01 },
      { key: 'height', label: 'Height', type: 'number', value: values.height, min: 0.1, max: 30000, step: 0.01 },
      { key: 'dpi', label: 'Resolution (pixels/inch)', type: 'number', value: values.dpi, min: 1, max: 2400 },
      { key: 'mode', label: 'Mode', type: 'select', value: values.mode, options: [['rgb', 'RGB Color'], ['grayscale', 'Grayscale']] },
      { key: 'flatten', label: 'Flatten All Layers', type: 'checkbox', value: values.flatten },
      { type: 'section', label: 'Thumbnails' },
      { key: 'across', label: 'Place', type: 'select', value: values.across, options: [[true, 'across first'], [false, 'down first']] },
      { key: 'columns', label: 'Columns', type: 'number', value: values.columns, min: 1, max: 100 },
      { key: 'rows', label: 'Rows', type: 'number', value: values.rows, min: 1, max: 100 },
      { key: 'autoSpacing', label: 'Use Auto-Spacing', type: 'checkbox', value: values.autoSpacing },
      { key: 'spacing', label: 'Spacing', type: 'number', value: values.spacing, min: 0, max: 2000, unit: 'px', when: (v) => !v.autoSpacing },
      { key: 'rotate', label: 'Rotate For Best Fit', type: 'checkbox', value: values.rotate },
      { type: 'section', label: 'Use Filename As Caption' },
      { key: 'caption', label: 'Caption with the file name', type: 'checkbox', value: values.caption },
      { key: 'font', label: 'Font', type: 'select', value: values.font, options: FONTS, when: (v) => v.caption },
      { key: 'fontSize', label: 'Font Size', type: 'number', value: values.fontSize, min: 4, max: 200, unit: 'pt', when: (v) => v.caption },
    ],
    validate: (v) => {
      const fail = (m) => {
        app.dialogs.toast(m, { kind: 'error' });
        return false;
      };
      if (v.source === 'folder' && !v.folder) return fail('Choose the folder of images');
      if (v.source === 'open' && !app.docs.list().length) return fail('No documents are open');
      const px = sheetPixels(v);
      if (px.width < 16 || px.height < 16 || px.width > 30000 || px.height > 30000) return fail('The sheet must be between 16 and 30,000 pixels');
      return true;
    },
  });
  if (!o) return null;
  const out = {};
  for (const k of Object.keys(SHEET_DEFAULTS)) out[k] = o[k] ?? SHEET_DEFAULTS[k];
  out.across = o.across === true || o.across === 'true';
  return out;
}

/** Shortens a caption with an ellipsis until it fits the width. */
function fitCaption(text, font, maxWidth) {
  const ctx = measureContext();
  ctx.font = cssFont(font);
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Flattened image of a source: an open document, or a file read without opening a tab. */
async function sourceImage(item) {
  if (item.doc) return flattenDocument(item.doc, item.doc.view?.compositor);
  if (window.__pigmentTest?.pending?.[item.path]) await window.__pigmentTest.pending[item.path];
  const doc = await openDocument(await bridge.readFile(item.path), { name: item.name, path: item.path });
  return flattenDocument(doc);
}

function thumbnail(src, place) {
  const c = createCanvas(place.width, place.height);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (place.rotated) {
    // a quarter turn counter-clockwise: the image's right edge becomes the thumbnail's top
    ctx.translate(0, place.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(src, 0, 0, place.height, place.width);
  } else ctx.drawImage(src, 0, 0, place.width, place.height);
  return c;
}

/** Builds the sheets. Resolves { documents: Document[], images, errors: [{ file, message }], cancelled }. */
export async function buildContactSheets(app, o) {
  const items = o.source === 'open' ? app.docs.list().map((doc) => ({ doc, name: doc.name, path: doc.path })) : await listImages(o.folder, { recursive: o.subfolders });
  const result = { documents: [], images: 0, errors: [], cancelled: false };
  if (!items.length) {
    app.dialogs.toast(o.source === 'open' ? 'No documents are open' : 'The folder holds no images Pigment can open', { kind: 'error' });
    return result;
  }
  const { width, height } = sheetPixels(o);
  const fontPx = Math.max(4, Math.round((o.fontSize * o.dpi) / 72));
  // auto-spacing: a gap of 2% of the shorter side, which reads as "even" at any sheet size
  const spacing = o.autoSpacing ? Math.max(2, Math.round(Math.min(width, height) * 0.02)) : Math.max(0, Math.round(o.spacing));
  const layout = contactSheetLayout({ width, height, columns: o.columns, rows: o.rows, spacing, caption: o.caption, fontSize: fontPx, across: o.across });
  const font = { ...DEFAULT_TEXT_STYLE, family: o.font, size: fontPx, align: 'center', color: '#000000', lineHeight: 1.2 };
  const pages = paginate(items, layout.perPage);
  const progress = progressDialog(app, 'Contact Sheet');
  let done = 0;
  try {
    await app.busy('Building the contact sheet…', async () => {
      for (let p = 0; p < pages.length && !result.cancelled; p++) {
        const doc = createDocument({ width, height, dpi: o.dpi, name: `ContactSheet-${String(p + 1).padStart(3, '0')}`, background: 'white' });
        const add = (layer) => {
          layer.parent = doc.root;
          doc.root.children.push(layer);
        };
        let placed = 0; // an image that cannot be read leaves no hole in the grid
        for (let i = 0; i < pages[p].length; i++) {
          if (progress.cancelled) {
            result.cancelled = true;
            break;
          }
          const item = pages[p][i];
          progress.update(done, items.length, `Thumbnail ${done + 1} of ${items.length}`, item.name);
          await new Promise((r) => setTimeout(r)); // lets the dialog repaint and Cancel register between images
          const cell = layout.cells[placed];
          try {
            const src = await sourceImage(item);
            const place = placeThumbnail(cell, src.width, src.height, { rotate: o.rotate });
            add(new RasterLayer({ name: item.name, canvas: thumbnail(src, place), x: place.x, y: place.y }));
            if (o.caption) {
              const label = fitCaption(splitName(item.name).name || item.name, font, cell.width);
              add(new TextLayer({ name: label, text: label, x: cell.x, y: cell.captionY + Math.round(fontPx * 0.15), width: cell.width, font: { ...font } }));
            }
            result.images++;
            placed++;
          } catch (err) {
            result.errors.push({ file: item.path ?? item.name, message: err?.message ?? String(err) });
          }
          done++;
        }
        if (doc.root.children.length < 2) continue; // nothing could be placed on this page
        if (o.flatten) {
          const flat = new RasterLayer({ name: 'Background', canvas: copyCanvas(flattenDocument(doc)) });
          flat.parent = doc.root;
          doc.root.children = [flat];
        }
        doc.active = doc.root.children[doc.root.children.length - 1];
        doc.selected = new Set([doc.active]);
        app.docs.add(doc);
        doc.history.markSaved();
        doc.history.savedIndex = -2; // never saved: closing asks
        if (o.mode === 'grayscale' && app.commands.isEnabled('image:mode')) await app.commands.run('image:mode', { mode: 'grayscale', flatten: false, silent: true }, 'api');
        result.documents.push(doc);
      }
    });
  } finally {
    progress.close();
  }
  return result;
}

export async function contactSheetCommand(app, arg, ctx) {
  let o = arg && typeof arg === 'object' ? { ...SHEET_DEFAULTS, ...arg } : null;
  if (!o) {
    o = await sheetDialog(app, app.settings.contactSheet ?? {});
    if (!o) return ctx?.cancel();
    app.saveSettingsSoon({ contactSheet: { ...o } });
  }
  ctx?.setReplayArg({ ...o });
  let result;
  try {
    result = await buildContactSheets(app, o);
  } catch (err) {
    app.reportError(err, 'Could not build the contact sheet');
    return null;
  }
  app.syncUiState();
  if (result.errors.length) app.dialogs.toast(`${result.errors.length} image${result.errors.length === 1 ? '' : 's'} could not be read (${result.errors[0].file.split(/[\\/]/).pop()}: ${result.errors[0].message})`, { kind: 'error', timeout: 6000 });
  else if (result.documents.length) app.dialogs.toast(`Contact sheet: ${result.images} image${result.images === 1 ? '' : 's'} on ${result.documents.length} page${result.documents.length === 1 ? '' : 's'}`, { kind: 'success', timeout: 3000 });
  return { documents: result.documents.length, images: result.images, errors: result.errors.length };
}
