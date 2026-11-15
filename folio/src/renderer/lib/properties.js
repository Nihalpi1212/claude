// Document properties: editable description, details, and security/permissions.
import * as engine from '../../shared/engine.js';
import { bridge } from './bridge.js';
import { fromPdfDate } from '../../shared/pdf-date.js';

const PERMISSIONS = [
  [0x04, 'Printing'],
  [0x800, 'High-quality printing'],
  [0x08, 'Changing the document'],
  [0x20, 'Commenting'],
  [0x100, 'Filling in form fields'],
  [0x10, 'Copying text and images'],
  [0x200, 'Copying for accessibility'],
  [0x400, 'Assembling pages'],
];

export function install(app) {
  app.commands.register('file:properties', {
    enabled: () => !!app.session,
    run: () => propertiesDialog(app),
  });
}

function fmtDate(value) {
  const d = value instanceof Date ? value : fromPdfDate(String(value ?? ''));
  if (!d || isNaN(d)) return value ? String(value) : '—';
  try {
    return d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return d.toISOString();
  }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString()} bytes)`;
  return `${(bytes / 1048576).toFixed(2)} MB (${bytes.toLocaleString()} bytes)`;
}

async function propertiesDialog(app) {
  const session = app.session;
  const v = session.view;
  const { info = {}, metadata } = await v.getMetadata();
  const permissions = await v.getPermissions().catch(() => null);
  const page = await v.pdfDocument.getPage(v.page);
  const unit = app.settings.measureUnit ?? 'mm';
  const perPt = { mm: 25.4 / 72, cm: 2.54 / 72, in: 1 / 72, pt: 1 }[unit] ?? 1;
  const digits = unit === 'pt' ? 0 : unit === 'mm' ? 0 : 2;
  const w = ((page.view[2] - page.view[0]) * perPt).toFixed(digits);
  const h = ((page.view[3] - page.view[1]) * perPt).toFixed(digits);
  let pathInfo = null;
  if (session.path && !session.path.startsWith('browser:/')) pathInfo = await bridge.pathInfo(session.path).catch(() => null);

  const content = document.createElement('div');
  content.innerHTML = `
    <div class="dialog-tabs" role="tablist">
      <button class="dialog-tab" data-tab="desc" aria-selected="true">Description</button>
      <button class="dialog-tab" data-tab="details" aria-selected="false">Details</button>
      <button class="dialog-tab" data-tab="security" aria-selected="false">Security</button>
    </div>
    <div data-pane="desc">
      <label class="field"><span>Title</span><input class="input" data-k="title"></label>
      <label class="field"><span>Author</span><input class="input" data-k="author"></label>
      <label class="field"><span>Subject</span><input class="input" data-k="subject"></label>
      <label class="field"><span>Keywords (comma separated)</span><input class="input" data-k="keywords"></label>
      <dl class="props-grid">
        <dt>Application</dt><dd data-v="creator"></dd>
        <dt>PDF producer</dt><dd data-v="producer"></dd>
        <dt>Created</dt><dd data-v="created"></dd>
        <dt>Modified</dt><dd data-v="modified"></dd>
      </dl>
    </div>
    <div data-pane="details" hidden>
      <dl class="props-grid">
        <dt>File</dt><dd data-v="path"></dd>
        <dt>File size</dt><dd data-v="size"></dd>
        <dt>Pages</dt><dd data-v="pages"></dd>
        <dt>Page size</dt><dd data-v="pagesize"></dd>
        <dt>PDF version</dt><dd data-v="version"></dd>
        <dt>Fast web view</dt><dd data-v="linearized"></dd>
        <dt>Forms</dt><dd data-v="forms"></dd>
        <dt>Tagged PDF</dt><dd data-v="tagged"></dd>
        <dt>XMP metadata</dt><dd data-v="xmp"></dd>
      </dl>
    </div>
    <div data-pane="security" hidden>
      <dl class="props-grid">
        <dt>Encryption</dt><dd data-v="encryption"></dd>
      </dl>
      <h4 style="margin:14px 0 6px">Permissions</h4>
      <dl class="props-grid" data-perms></dl>
    </div>`;
  const set = (k, text) => (content.querySelector(`[data-v="${k}"]`).textContent = text ?? '—');
  const inputs = Object.fromEntries([...content.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el]));
  inputs.title.value = info.Title ?? '';
  inputs.author.value = info.Author ?? '';
  inputs.subject.value = info.Subject ?? '';
  inputs.keywords.value = info.Keywords ?? '';
  set('creator', info.Creator || '—');
  set('producer', info.Producer || '—');
  set('created', fmtDate(info.CreationDate));
  set('modified', fmtDate(info.ModDate));
  set('path', session.path ?? '(not saved yet)');
  set('size', fmtSize(session.bytes.byteLength) + (pathInfo && pathInfo.size !== session.bytes.byteLength ? ` · on disk ${fmtSize(pathInfo.size)}` : ''));
  set('pages', String(v.numPages));
  set('pagesize', `${w} × ${h} ${unit} (page ${v.page}${page.rotate ? `, rotated ${page.rotate}°` : ''})`);
  set('version', info.PDFFormatVersion ?? '—');
  set('linearized', info.IsLinearized ? 'Yes' : 'No');
  set('forms', info.IsXFAPresent ? 'XFA form' : info.IsAcroFormPresent ? 'AcroForm' : 'None');
  set('tagged', (await v.pdfDocument.getMarkInfo().catch(() => null))?.Marked ? 'Yes' : 'No');
  set('xmp', metadata ? 'Present' : 'None');
  set('encryption', info.EncryptFilterName ? `Yes (${info.EncryptFilterName})` : 'None');
  const perms = content.querySelector('[data-perms]');
  for (const [flag, label] of PERMISSIONS) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = permissions === null || permissions === undefined ? 'Allowed' : permissions & flag ? 'Allowed' : 'Not allowed';
    if (permissions !== null && permissions !== undefined && !(permissions & flag)) dd.style.color = 'var(--danger)';
    perms.append(dt, dd);
  }
  for (const tab of content.querySelectorAll('.dialog-tab')) {
    tab.addEventListener('click', () => {
      for (const t of content.querySelectorAll('.dialog-tab')) t.setAttribute('aria-selected', String(t === tab));
      for (const pane of content.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    });
  }
  const ok = await app.dialogs.open({ title: 'Document properties', content, width: 560, buttons: [{ label: 'Cancel', value: null }, { label: 'Save changes', value: true, primary: true }] });
  if (!ok) return;
  const patch = { title: inputs.title.value, author: inputs.author.value, subject: inputs.subject.value, keywords: inputs.keywords.value };
  const changed = patch.title !== (info.Title ?? '') || patch.author !== (info.Author ?? '') || patch.subject !== (info.Subject ?? '') || patch.keywords !== (info.Keywords ?? '');
  if (!changed) return;
  await app.edit.apply((bytes) => engine.setMetadata(bytes, patch), { label: 'Edit properties' });
}
