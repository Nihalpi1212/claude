// Automate: Batch and Image Processor. Both walk a list of source images (a folder, or the open
// documents), run work on each (an action; resize and save in several formats) and report progress in a
// small dialog with a Cancel button. The pure naming / fitting helpers are in automate/naming.js.
import { bridge } from '../bridge.js';
import { flattenDocument } from '../compositor.js';
import { openDocument, encodeForPath, canWritePath, extOf, baseName, OPEN_EXTENSIONS, exportFormatForPath } from '../io.js';
import { buildForm } from '../form.js';
import { NAME_TOKENS, DEFAULT_NAMING, buildFileName, uniqueFileName, namingIsUnique, joinPath, dirName, fitSize, splitName } from './naming.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const fileName = (path) => String(path).split(/[\\/]/).pop();

// ---- shared -------------------------------------------------------------------------------------------------

/** Image files of a folder (optionally of its subfolders too), in name order; `skip` folders are not entered. */
export async function listImages(dir, { recursive = false, skip = [] } = {}) {
  const out = [];
  const seen = new Set();
  const walk = async (folder, depth) => {
    if (seen.has(folder) || depth > 16) return;
    seen.add(folder);
    const entries = await bridge.listDir(folder);
    for (const e of entries) {
      if (e.isDir) continue;
      if (OPEN_EXTENSIONS.includes(extOf(e.name))) out.push({ path: e.path, name: e.name });
    }
    if (!recursive) return;
    for (const e of entries) if (e.isDir && !skip.includes(e.path)) await walk(e.path, depth + 1);
  };
  await walk(dir, 0);
  return out;
}

async function chooseFolder(title) {
  const picked = await bridge.openDirectoryDialog?.({ title });
  return (Array.isArray(picked) ? picked[0] : picked) || null;
}

/** A row with a "Choose…" button and the chosen folder (form.js custom field). */
function folderField(key, label, title, extra = {}) {
  return {
    key,
    label,
    type: 'custom',
    ...extra,
    render: (values, set) => {
      const row = document.createElement('div');
      row.className = 'automate-folder';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = 'Choose…';
      btn.dataset.choose = key;
      const path = document.createElement('span');
      path.className = 'automate-path muted';
      const sync = () => {
        path.textContent = values[key] || 'No folder chosen';
        path.title = values[key] || '';
      };
      btn.addEventListener('click', async () => {
        const dir = await chooseFolder(title);
        if (dir) set(key, dir);
      });
      row._sync = sync;
      sync();
      row.append(btn, path);
      return row;
    },
    sync: (values, node) => node?._sync?.(),
  };
}

/** Progress dialog with Cancel: { update(done, total, text), cancelled, close() }. */
export function progressDialog(app, title) {
  const content = document.createElement('div');
  content.className = 'automate-progress';
  const text = document.createElement('p');
  text.className = 'dialog-message';
  text.textContent = 'Preparing…';
  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  const detail = document.createElement('p');
  detail.className = 'muted automate-progress-detail';
  content.append(text, bar, detail);
  const state = { cancelled: false, closed: false, closeFn: null };
  app.dialogs
    .open({ title, content, width: 420, dismissible: false, className: 'automate-progress-dialog', buttons: [{ label: 'Cancel', value: 'cancel' }], onOpen: (dialog, close) => (state.closeFn = close) })
    .then((value) => {
      state.closed = true;
      if (value === 'cancel') {
        state.cancelled = true;
        app.statusbar.set('busy', `${title}: cancelling after the current file…`);
      }
    });
  return {
    update(done, total, message, sub = '') {
      text.textContent = message;
      bar.max = Math.max(1, total);
      bar.value = done;
      detail.textContent = sub;
    },
    get cancelled() {
      return state.cancelled;
    },
    close() {
      if (!state.closed) state.closeFn?.(null);
    },
  };
}

/**
 * While a batch runs, errors that commands report (app.reportError, error toasts) are collected instead of
 * shown, so they can stop the batch or go into its log; success toasts ("Saved a.png") are dropped.
 * Returns { take() -> string[] (and clears), restore() }.
 */
function captureErrors(app) {
  let errors = [];
  app.reportError = (err, context) => {
    console.warn(context ?? 'Error', err);
    const message = err?.message ?? String(err);
    errors.push(context ? `${context}: ${message}` : message);
  };
  app.dialogs.toast = (message, opts = {}) => {
    if (opts.kind === 'error') errors.push(String(message));
    return () => {};
  };
  return {
    take() {
      const list = errors;
      errors = [];
      return list;
    },
    restore() {
      // both are prototype methods that were shadowed on the instance: deleting the shadows restores them
      delete app.reportError;
      delete app.dialogs.toast;
    },
  };
}

/** Opens a source file as a document tab; resolves { doc, opened } (opened: false when it was open already). */
async function openSource(app, file) {
  const existing = app.docs.findByPath(file.path);
  if (existing) {
    app.docs.activate(existing);
    return { doc: existing, opened: false };
  }
  if (window.__pigmentTest?.pending?.[file.path]) await window.__pigmentTest.pending[file.path];
  const bytes = await bridge.readFile(file.path);
  const doc = await openDocument(bytes, { name: file.name, path: file.path });
  app.docs.add(doc);
  doc.history.markSaved(flattenDocument(doc, doc.view.compositor));
  return { doc, opened: true };
}

const stillOpen = (app, doc) => app.docs.docs.includes(doc);

/** Extension a document is saved with when nothing says otherwise: its own when Pigment writes it, else PNG. */
function keepExtension(doc) {
  const ext = extOf(doc.path ?? doc.name ?? '') || (doc.format ?? '');
  return ext && canWritePath(`x.${ext}`) ? ext : 'png';
}

function sourceList(app, o) {
  if (o.source === 'open') return app.docs.list().map((doc) => ({ doc, name: doc.path ? fileName(doc.path) : doc.name, path: doc.path ?? null }));
  return null;
}

// ---- Batch --------------------------------------------------------------------------------------------------

export const BATCH_DEFAULTS = Object.freeze({
  set: '', action: '', source: 'folder', folder: '', subfolders: false, overrideOpen: false,
  destination: 'none', destFolder: '', overrideSave: false, naming: DEFAULT_NAMING, startSerial: 1, errors: 'stop', logFile: '',
});

const tokenLabel = (t) => NAME_TOKENS.find((x) => x[0] === t)?.[1] ?? t;
const tokenOf = (text) => NAME_TOKENS.find((x) => x[1] === text)?.[0] ?? text;

async function batchDialog(app, start) {
  const engine = app.actions;
  const sets = engine.sets.filter((s) => s.actions.length);
  if (!sets.length) {
    app.dialogs.toast('There are no actions to run. Record one in the Actions panel first.', { kind: 'error' });
    return null;
  }
  const values = { ...BATCH_DEFAULTS, ...start, naming: [...(start.naming ?? DEFAULT_NAMING)] };
  const selSet = engine.selectedSet && sets.includes(engine.selectedSet) ? engine.selectedSet : null;
  if (!sets.some((s) => s.name === values.set)) values.set = (selSet ?? sets[0]).name;
  const actionsOf = (name) => sets.find((s) => s.name === name)?.actions ?? [];
  if (!actionsOf(values.set).some((a) => a.name === values.action)) values.action = (selSet && engine.selectedAction ? engine.selectedAction : actionsOf(values.set)[0])?.name ?? '';
  if (values.source === 'open' && !app.docs.list().length) values.source = 'folder';

  const example = document.createElement('div');
  example.className = 'muted automate-example';
  const naming = document.createElement('div');
  naming.className = 'automate-naming';
  const listId = `naming-tokens-${Date.now().toString(36)}`;
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  for (const [, label] of NAME_TOKENS) datalist.appendChild(Object.assign(document.createElement('option'), { value: label }));
  naming.appendChild(datalist);
  const updateExample = () => {
    const sample = { name: 'MyFile', ext: 'png', serial: Number(form?.values.startSerial ?? values.startSerial) || 1 };
    example.textContent = `Example: ${buildFileName(values.naming, sample)}${namingIsUnique(values.naming) ? '' : ' — add the document name or a serial number, or every file gets this name (a number is appended)'}`;
  };
  for (let i = 0; i < 6; i++) {
    const input = document.createElement('input');
    input.className = 'input';
    input.setAttribute('list', listId);
    input.setAttribute('aria-label', `File naming field ${i + 1}`);
    input.dataset.naming = String(i);
    input.placeholder = 'None';
    input.value = values.naming[i] && values.naming[i] !== 'none' ? tokenLabel(values.naming[i]) : '';
    input.addEventListener('input', () => {
      values.naming[i] = input.value ? tokenOf(input.value) : 'none';
      updateExample();
    });
    naming.appendChild(input);
  }

  const isFolder = (v) => v.destination === 'folder';
  const fields = [
    { type: 'section', label: 'Play' },
    { key: 'set', label: 'Set', type: 'select', value: values.set, options: sets.map((s) => [s.name, s.name]) },
    { key: 'action', label: 'Action', type: 'custom', render: () => actionSelect },
    { type: 'section', label: 'Source' },
    { key: 'source', label: 'Source', type: 'select', value: values.source, options: [['folder', 'Folder'], ['open', `Opened Files (${app.docs.list().length})`]] },
    folderField('folder', 'Folder', 'Batch: source folder', { when: (v) => v.source === 'folder' }),
    { key: 'subfolders', label: 'Include All Subfolders', type: 'checkbox', value: values.subfolders, when: (v) => v.source === 'folder' },
    { key: 'overrideOpen', label: 'Override Action “Open” Commands', type: 'checkbox', value: values.overrideOpen, help: 'Open steps in the action are skipped: the batch opens each file itself.' },
    { type: 'section', label: 'Destination' },
    { key: 'destination', label: 'Destination', type: 'select', value: values.destination, options: [['none', 'None'], ['save-close', 'Save and Close'], ['folder', 'Folder']] },
    folderField('destFolder', 'Folder', 'Batch: destination folder', { when: isFolder }),
    { key: 'overrideSave', label: 'Override Action “Save As” Commands', type: 'checkbox', value: values.overrideSave, when: isFolder, help: 'Save As steps in the action write into this folder with the names below (keeping their file format) instead of their recorded path.' },
    { key: 'naming', label: 'File Naming', type: 'custom', when: isFolder, render: () => naming, span: true },
    { key: 'startSerial', label: 'Starting Serial #', type: 'number', value: values.startSerial, min: 0, max: 99999, when: isFolder },
    { key: 'example', type: 'custom', when: isFolder, render: () => example },
    { type: 'section', label: 'Errors' },
    { key: 'errors', label: 'Errors', type: 'select', value: values.errors, options: [['stop', 'Stop for Errors'], ['log', 'Log Errors to File']] },
    {
      key: 'logFile', label: 'Log file', type: 'custom', when: (v) => v.errors === 'log',
      render: (vals, set) => {
        const row = document.createElement('div');
        row.className = 'automate-folder';
        const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Save As…' });
        const path = Object.assign(document.createElement('span'), { className: 'automate-path muted' });
        const sync = () => (path.textContent = vals.logFile || 'No file chosen');
        btn.addEventListener('click', async () => {
          const p = await bridge.saveFileDialog({ title: 'Batch error log', defaultPath: 'batch-errors.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
          if (p) set('logFile', p);
        });
        row._sync = sync;
        sync();
        row.append(btn, path);
        return row;
      },
      sync: (vals, node) => node?._sync?.(),
    },
  ];
  const actionSelect = document.createElement('select');
  actionSelect.className = 'select';
  actionSelect.dataset.key = 'action';
  const fillActions = (setName, keep) => {
    actionSelect.replaceChildren(...actionsOf(setName).map((a) => Object.assign(document.createElement('option'), { value: a.name, textContent: a.name })));
    if (keep && actionsOf(setName).some((a) => a.name === keep)) actionSelect.value = keep;
    values.action = actionSelect.value;
  };
  fillActions(values.set, values.action);
  actionSelect.addEventListener('change', () => (values.action = actionSelect.value));

  let form = null;
  form = buildForm(fields, {
    values,
    onChange: (v, key) => {
      if (key === 'set') fillActions(v.set, null);
      if (key === 'startSerial') updateExample();
    },
  });
  form.element.classList.add('automate-form');
  updateExample();
  const validate = () => {
    const v = form.values;
    const fail = (m) => {
      app.dialogs.toast(m, { kind: 'error' });
      return false;
    };
    if (!values.action) return fail('Choose an action');
    if (v.source === 'folder' && !v.folder) return fail('Choose the source folder');
    if (v.source === 'open' && !app.docs.list().length) return fail('No documents are open');
    if (v.destination === 'folder' && !v.destFolder) return fail('Choose the destination folder');
    if (v.errors === 'log' && !v.logFile) return fail('Choose where to save the error log');
    return true;
  };
  const ok = await app.dialogs.open({ title: 'Batch', content: form.element, width: 520, className: 'automate-dialog', buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }], validate });
  if (!ok) return null;
  const v = form.values;
  return {
    set: v.set, action: values.action, source: v.source, folder: v.folder, subfolders: !!v.subfolders, overrideOpen: !!v.overrideOpen,
    destination: v.destination, destFolder: v.destFolder, overrideSave: !!v.overrideSave, naming: values.naming.slice(0, 6), startSerial: Math.max(0, Math.round(Number(v.startSerial) || 0)),
    errors: v.errors, logFile: v.logFile,
  };
}

/**
 * Runs a batch. Resolves { processed, saved: string[], errors: [{ file, message }], cancelled, stopped }.
 * `o` is the dialog's result (see BATCH_DEFAULTS).
 */
export async function runBatch(app, o) {
  const engine = app.actions;
  const found = engine.resolve({ set: o.set, action: o.action });
  if (!found) throw new Error(`The action “${o.action}” does not exist`);
  let files = sourceList(app, o);
  if (!files) files = await listImages(o.folder, { recursive: o.subfolders, skip: o.destination === 'folder' && o.destFolder ? [o.destFolder] : [] });
  const summary = { processed: 0, saved: [], errors: [], cancelled: false, stopped: false, total: files.length };
  if (!files.length) {
    app.dialogs.toast(o.source === 'open' ? 'No documents are open' : 'The source folder holds no images Pigment can open', { kind: 'error' });
    return summary;
  }
  if (o.destination === 'folder') await bridge.makeDir?.(o.destFolder);
  const taken = new Set();
  const progress = progressDialog(app, 'Batch');
  const capture = captureErrors(app);
  const quality = app.settings.saveQuality ?? 0.92;
  const targetName = (doc, serial, ext) => uniqueFileName(buildFileName(o.naming, { name: baseName(doc.name), ext, serial }), taken);
  const write = async (doc, path) => {
    const ext = extOf(path);
    if (['jpg', 'jpeg', 'webp'].includes(ext)) doc.saveOpts = { format: ext, quality: doc.saveOpts?.format === ext ? doc.saveOpts.quality : quality };
    const ok = await app.docs.writeTo(doc, path, { copy: true });
    if (ok) summary.saved.push(path);
    return ok;
  };
  try {
    await app.busy('Batch…', async () => {
      for (let i = 0; i < files.length; i++) {
        if (progress.cancelled) {
          summary.cancelled = true;
          break;
        }
        const file = files[i];
        const serial = (Number(o.startSerial) || 0) + i;
        progress.update(i, files.length, `Processing ${i + 1} of ${files.length}`, file.name);
        let doc = file.doc ?? null, opened = false, savedByAction = false;
        const errors = [];
        try {
          if (!doc) ({ doc, opened } = await openSource(app, file));
          else app.docs.activate(doc);
          engine.batch = {
            overrideOpen: !!o.overrideOpen,
            overrideSave:
              o.destination === 'folder' && o.overrideSave
                ? async (d, arg) => {
                    // the step decides the format, the batch the folder and the name
                    const path = joinPath(o.destFolder, targetName(d, serial, extOf(arg.path) || keepExtension(d)));
                    taken.add(fileName(path).toLowerCase());
                    if (arg.quality) d.saveOpts = { format: extOf(path), quality: arg.quality };
                    const ok = await write(d, path);
                    if (ok && d === doc) savedByAction = true;
                    return ok;
                  }
                : null,
          };
          const result = await engine.play(found.action, { quiet: true });
          engine.batch = null;
          errors.push(...capture.take());
          if (!result.ok) {
            if (result.reason === 'stop' || result.reason === 'cancelled') {
              // a Stop step or a cancelled dialog: the user ended the batch; the document stays open for them
              summary.stopped = true;
              summary.processed++;
              break;
            }
            errors.push(result.message ?? 'The action failed');
          }
          if (!errors.length && stillOpen(app, doc)) {
            if (o.destination === 'folder') {
              if (!savedByAction) {
                const name = targetName(doc, serial, keepExtension(doc));
                taken.add(name.toLowerCase());
                if (!(await write(doc, joinPath(o.destFolder, name)))) errors.push(...capture.take(), `Could not save ${name}`);
              }
              if (!errors.length) await app.docs.close(doc, { force: true });
            } else if (o.destination === 'save-close') {
              if (!doc.path || !canWritePath(doc.path)) errors.push(doc.path ? `Pigment cannot write .${extOf(doc.path)} files: the document was left open` : 'The document has never been saved: it was left open');
              else {
                const ext = extOf(doc.path);
                if (['jpg', 'jpeg', 'webp'].includes(ext) && doc.saveOpts?.format !== ext) doc.saveOpts = { format: ext, quality };
                if (await app.docs.writeTo(doc, doc.path)) {
                  summary.saved.push(doc.path);
                  await app.docs.close(doc, { force: true });
                } else errors.push(...capture.take(), `Could not save ${fileName(doc.path)}`);
              }
            }
          } else if (errors.length && opened && o.errors === 'log' && stillOpen(app, doc)) {
            // a failed file is not saved; with logging on the batch moves on, so the half-processed document is closed
            await app.docs.close(doc, { force: true });
          }
        } catch (err) {
          engine.batch = null;
          errors.push(...capture.take(), err?.message ?? String(err));
        }
        summary.processed++;
        const unique = [...new Set(errors)];
        for (const message of unique) summary.errors.push({ file: file.path ?? file.name, message });
        if (unique.length && o.errors !== 'log') {
          summary.stopped = true;
          break;
        }
      }
    });
  } finally {
    engine.batch = null;
    capture.restore();
    progress.close();
  }
  if (summary.errors.length && o.errors === 'log' && o.logFile) {
    const lines = [`Pigment batch log — ${new Date().toLocaleString()}`, `Action: ${o.set} › ${o.action}`, '', ...summary.errors.map((e) => `${e.file}\n    ${e.message}`), ''];
    try {
      await bridge.writeFile(o.logFile, new TextEncoder().encode(lines.join('\n')));
    } catch (err) {
      app.reportError(err, 'Could not write the batch log');
    }
  }
  return summary;
}

function reportBatch(app, title, s, o = {}) {
  const n = s.processed;
  const files = `${n} file${n === 1 ? '' : 's'}`;
  if (s.errors.length && o.errors !== 'log') {
    const e = s.errors[0];
    return app.dialogs.alert(`${title} stopped at ${fileName(e.file)}.`, { title, detail: `${e.message}\n\n${n - 1} of ${s.total} file${s.total === 1 ? '' : 's'} were finished before it.` });
  }
  const parts = [`${title}: ${files} processed`];
  if (s.saved.length) parts.push(`${s.saved.length} saved`);
  if (s.errors.length) parts.push(`${s.errors.length} error${s.errors.length === 1 ? '' : 's'}${o.logFile ? ` logged to ${fileName(o.logFile)}` : ''}`);
  if (s.cancelled) parts.push('cancelled');
  else if (s.stopped) parts.push('stopped by the action');
  app.dialogs.toast(parts.join(', '), { kind: s.errors.length ? 'error' : 'success', timeout: 5000 });
  return null;
}

export async function batchCommand(app, arg, ctx) {
  if (!app.actions) return ctx?.cancel();
  if (app.actions.recording) app.actions.stopRecording();
  let o = arg && typeof arg === 'object' ? { ...BATCH_DEFAULTS, ...arg } : null;
  if (!o) {
    o = await batchDialog(app, app.settings.batch ?? {});
    if (!o) return ctx?.cancel();
    app.saveSettingsSoon({ batch: clone(o) });
  }
  ctx?.setReplayArg(clone(o));
  let summary;
  try {
    summary = await runBatch(app, o);
  } catch (err) {
    app.reportError(err, 'Batch failed');
    return null;
  }
  await reportBatch(app, 'Batch', summary, o);
  return summary;
}

// ---- Image Processor ----------------------------------------------------------------------------------------

export const PROCESSOR_DEFAULTS = Object.freeze({
  source: 'open', folder: '', subfolders: false, destination: 'same', destFolder: '',
  jpeg: true, jpegQuality: 8, jpegResize: false, jpegWidth: 1920, jpegHeight: 1920, srgb: true,
  psd: false, psdResize: false, psdWidth: 1920, psdHeight: 1920,
  png: false, pngResize: false, pngWidth: 1920, pngHeight: 1920,
  tiff: false, tiffResize: false, tiffWidth: 1920, tiffHeight: 1920,
  runAction: false, set: '', action: '', copyright: '',
});

/** Photoshop's JPEG quality 0–12 as the 0..1 the encoder takes. */
export const jpegQuality = (q) => Math.max(0.05, Math.min(1, 0.1 + (Math.max(0, Math.min(12, Number(q) || 0)) / 12) * 0.9));

const tiffFormat = () => exportFormatForPath('x.tif') ?? exportFormatForPath('x.tiff');

async function processorDialog(app, start) {
  const engine = app.actions;
  const sets = (engine?.sets ?? []).filter((s) => s.actions.length);
  const values = { ...PROCESSOR_DEFAULTS, ...start };
  if (values.source === 'open' && !app.docs.list().length) values.source = 'folder';
  if (!sets.some((s) => s.name === values.set)) values.set = sets[0]?.name ?? '';
  const actionsOf = (name) => sets.find((s) => s.name === name)?.actions ?? [];
  const hasTiff = !!tiffFormat();
  const typeFields = (key, label, extra = []) => [
    { key, label: `Save as ${label}`, type: 'checkbox', value: values[key], span: true },
    ...extra,
    { key: `${key}Resize`, label: 'Resize to Fit', type: 'checkbox', value: values[`${key}Resize`], when: (v) => v[key] },
    { key: `${key}Width`, label: 'W', type: 'number', value: values[`${key}Width`], min: 1, max: 30000, unit: 'px', when: (v) => v[key] && v[`${key}Resize`] },
    { key: `${key}Height`, label: 'H', type: 'number', value: values[`${key}Height`], min: 1, max: 30000, unit: 'px', when: (v) => v[key] && v[`${key}Resize`] },
  ];
  const actionSelect = document.createElement('select');
  actionSelect.className = 'select';
  actionSelect.dataset.key = 'action';
  const fillActions = (setName, keep) => {
    actionSelect.replaceChildren(...actionsOf(setName).map((a) => Object.assign(document.createElement('option'), { value: a.name, textContent: a.name })));
    if (keep && actionsOf(setName).some((a) => a.name === keep)) actionSelect.value = keep;
    values.action = actionSelect.value;
  };
  fillActions(values.set, values.action);
  actionSelect.addEventListener('change', () => (values.action = actionSelect.value));
  const fields = [
    { type: 'section', label: '1  Select the images to process' },
    { key: 'source', label: 'Images', type: 'select', value: values.source, options: [['open', `Use Open Images (${app.docs.list().length})`], ['folder', 'Select Folder']] },
    folderField('folder', 'Folder', 'Image Processor: source folder', { when: (v) => v.source === 'folder' }),
    { key: 'subfolders', label: 'Include All Sub-folders', type: 'checkbox', value: values.subfolders, when: (v) => v.source === 'folder' },
    { type: 'section', label: '2  Select location to save processed images' },
    { key: 'destination', label: 'Save in', type: 'select', value: values.destination, options: [['same', 'Same Location'], ['folder', 'Select Folder']], help: 'Each file type goes into its own subfolder (JPEG, PSD, PNG, TIFF).' },
    folderField('destFolder', 'Folder', 'Image Processor: destination folder', { when: (v) => v.destination === 'folder' }),
    { type: 'section', label: '3  File type' },
    ...typeFields('jpeg', 'JPEG', [
      { key: 'jpegQuality', label: 'Quality', type: 'slider', value: values.jpegQuality, min: 0, max: 12, step: 1, when: (v) => v.jpeg },
      { key: 'srgb', label: 'Convert Profile to sRGB', type: 'checkbox', value: values.srgb, when: (v) => v.jpeg, help: 'Pigment documents are sRGB already.' },
    ]),
    ...typeFields('psd', 'PSD'),
    ...typeFields('png', 'PNG'),
    ...(hasTiff ? typeFields('tiff', 'TIFF') : []),
    { type: 'section', label: '4  Preferences' },
    { key: 'runAction', label: 'Run Action', type: 'checkbox', value: values.runAction && sets.length > 0, disabled: () => !sets.length },
    { key: 'set', label: 'Set', type: 'select', value: values.set, options: sets.map((s) => [s.name, s.name]), when: (v) => v.runAction },
    { key: 'action', label: 'Action', type: 'custom', when: (v) => v.runAction, render: () => actionSelect },
    { key: 'copyright', label: 'Copyright Info', type: 'text', value: values.copyright, span: true },
  ];
  const form = buildForm(fields, {
    values,
    onChange: (v, key) => {
      if (key === 'set') fillActions(v.set, null);
    },
  });
  form.element.classList.add('automate-form');
  const validate = () => {
    const v = form.values;
    const fail = (m) => {
      app.dialogs.toast(m, { kind: 'error' });
      return false;
    };
    if (v.source === 'folder' && !v.folder) return fail('Choose the folder of images to process');
    if (v.source === 'open' && !app.docs.list().length) return fail('No documents are open');
    if (v.destination === 'folder' && !v.destFolder) return fail('Choose the folder to save into');
    if (!v.jpeg && !v.psd && !v.png && !(hasTiff && v.tiff)) return fail('Choose at least one file type');
    if (v.runAction && !values.action) return fail('Choose the action to run');
    return true;
  };
  const ok = await app.dialogs.open({ title: 'Image Processor', content: form.element, width: 520, className: 'automate-dialog', buttons: [{ label: 'Cancel', value: null }, { label: 'Run', value: true, primary: true }], validate });
  if (!ok) return null;
  const out = {};
  for (const k of Object.keys(PROCESSOR_DEFAULTS)) out[k] = form.values[k] ?? PROCESSOR_DEFAULTS[k];
  out.action = values.action;
  if (!hasTiff) out.tiff = false;
  return out;
}

/** Resolves { processed, saved: string[], errors: [{ file, message }], cancelled, total }. */
export async function runImageProcessor(app, o) {
  const engine = app.actions;
  const action = o.runAction ? engine?.resolve({ set: o.set, action: o.action }) : null;
  if (o.runAction && !action) throw new Error(`The action “${o.action}” does not exist`);
  let files = sourceList(app, o);
  if (!files) files = await listImages(o.folder, { recursive: o.subfolders, skip: o.destination === 'folder' && o.destFolder ? [o.destFolder] : [] });
  const summary = { processed: 0, saved: [], errors: [], cancelled: false, stopped: false, total: files.length };
  if (!files.length) {
    app.dialogs.toast(o.source === 'open' ? 'No documents are open' : 'The folder holds no images Pigment can open', { kind: 'error' });
    return summary;
  }
  const tiff = tiffFormat();
  const types = [
    o.jpeg && { key: 'jpeg', folder: 'JPEG', ext: 'jpg', opts: { quality: jpegQuality(o.jpegQuality) } },
    o.psd && { key: 'psd', folder: 'PSD', ext: 'psd', opts: {} },
    o.png && { key: 'png', folder: 'PNG', ext: 'png', opts: {} },
    o.tiff && tiff && { key: 'tiff', folder: 'TIFF', ext: tiff.ext, opts: {} },
  ].filter(Boolean);
  const taken = new Map(); // folder -> names written in this run
  const progress = progressDialog(app, 'Image Processor');
  const capture = captureErrors(app);
  try {
    await app.busy('Image Processor…', async () => {
      for (let i = 0; i < files.length; i++) {
        if (progress.cancelled) {
          summary.cancelled = true;
          break;
        }
        const file = files[i];
        progress.update(i, files.length, `Processing ${i + 1} of ${files.length}`, file.name);
        const errors = [];
        let doc = file.doc ?? null, opened = false;
        try {
          if (!doc) ({ doc, opened } = await openSource(app, file));
          else app.docs.activate(doc);
          // everything done to an open document is undone again: the processor only writes copies
          const start = doc.history.index;
          const metaBefore = doc.meta;
          if (o.copyright) doc.meta = { ...(doc.meta ?? {}), copyright: o.copyright };
          if (action) {
            const r = await engine.play(action.action, { quiet: true });
            errors.push(...capture.take());
            if (!r.ok) {
              if (r.reason === 'stop' || r.reason === 'cancelled') {
                summary.stopped = true;
                summary.processed++;
                break;
              }
              errors.push(r.message ?? 'The action failed');
            }
          }
          const base = o.destination === 'folder' ? o.destFolder : dirName(file.path ?? doc.path ?? '');
          if (!errors.length && stillOpen(app, doc)) {
            if (!base) errors.push('The document has never been saved, so it has no location: choose a destination folder');
            else {
              for (const type of types) {
                const afterAction = doc.history.index;
                if (o[`${type.key}Resize`]) {
                  const fit = fitSize(doc.width, doc.height, o[`${type.key}Width`], o[`${type.key}Height`], { enlarge: false });
                  if (fit.width !== doc.width || fit.height !== doc.height) await app.commands.run('image:size', { width: fit.width, height: fit.height, method: 'bicubic' }, 'api');
                }
                const dir = joinPath(base, type.folder);
                await bridge.makeDir?.(dir);
                if (!taken.has(dir)) taken.set(dir, new Set());
                const name = uniqueFileName(`${splitName(file.name).name || baseName(doc.name)}.${type.ext}`, taken.get(dir));
                taken.get(dir).add(name.toLowerCase());
                const path = joinPath(dir, name);
                const bytes = await encodeForPath(doc, path, doc.view.compositor, type.opts);
                await bridge.writeFile(path, bytes);
                summary.saved.push(path);
                if (doc.history.index !== afterAction) doc.history.goTo(afterAction);
                errors.push(...capture.take());
              }
            }
          }
          if (stillOpen(app, doc)) {
            if (opened) await app.docs.close(doc, { force: true });
            else {
              if (doc.history.index !== start) doc.history.goTo(start);
              doc.meta = metaBefore;
            }
          }
        } catch (err) {
          errors.push(...capture.take(), err?.message ?? String(err));
          if (opened && doc && stillOpen(app, doc)) await app.docs.close(doc, { force: true });
        }
        summary.processed++;
        for (const message of new Set(errors)) summary.errors.push({ file: file.path ?? file.name, message });
      }
    });
  } finally {
    capture.restore();
    progress.close();
  }
  return summary;
}

export async function imageProcessorCommand(app, arg, ctx) {
  if (app.actions?.recording) app.actions.stopRecording();
  let o = arg && typeof arg === 'object' ? { ...PROCESSOR_DEFAULTS, ...arg } : null;
  if (!o) {
    o = await processorDialog(app, app.settings.imageProcessor ?? {});
    if (!o) return ctx?.cancel();
    app.saveSettingsSoon({ imageProcessor: clone(o) });
  }
  ctx?.setReplayArg(clone(o));
  let summary;
  try {
    summary = await runImageProcessor(app, o);
  } catch (err) {
    app.reportError(err, 'Image Processor failed');
    return null;
  }
  if (summary.errors.length) {
    const first = summary.errors[0];
    await app.dialogs.alert(`${summary.errors.length} of ${summary.total} image${summary.total === 1 ? '' : 's'} could not be processed.`, { title: 'Image Processor', detail: summary.errors.slice(0, 8).map((e) => `${fileName(e.file)}: ${e.message}`).join('\n') || first.message });
  } else reportBatch(app, 'Image Processor', summary, { errors: 'log' });
  return summary;
}
