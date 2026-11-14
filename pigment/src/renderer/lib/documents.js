// Open documents and their tabs: each tab owns a Document, its History and a CanvasView.
import { bridge } from './bridge.js';
import { icon } from './icons.js';
import { History } from './history.js';
import { CanvasView } from './canvas-view.js';
import { flattenDocument } from './compositor.js';
import { openDocument, encodeForPath, isLayeredPath, canWritePath, extOf, baseName, OPEN_FILTERS } from './io.js';
import { formDialog } from './form.js';
import { MODES } from '../../shared/pixels/modes.js';

export const SAVE_FILTERS = [
  { name: 'Pigment document (layers)', extensions: ['pigment'] },
  { name: 'Photoshop document (layers)', extensions: ['psd'] },
  { name: 'PNG image', extensions: ['png'] },
  { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP image', extensions: ['webp'] },
];

export class DocumentManager {
  constructor(app) {
    this.app = app;
    this.docs = [];
    this.active = null;
    this.host = document.getElementById('canvas-host');
    this.tabbar = document.getElementById('tabbar');
    this.modeNoticed = new WeakSet(); // documents already told that a PSD does not keep their image mode
  }

  list() {
    return this.docs.slice();
  }

  findByPath(path) {
    return this.docs.find((d) => d.path && d.path === path) ?? null;
  }

  /** Adds a document (new or opened) and shows it. */
  add(doc, { activate = true, index = -1 } = {}) {
    const app = this.app;
    doc.history = new History(doc, {
      limit: app.settings.historyLimit,
      memoryMB: app.settings.historyMemoryMB,
      onChange: () => {
        app.emit('history:changed', doc);
        this.renderTabs();
        app.syncUiState();
        app.commands.invalidate();
      },
    });
    const frame = document.createElement('div');
    frame.className = 'doc-frame';
    frame.hidden = true;
    this.host.appendChild(frame);
    doc.frame = frame;
    doc.view = new CanvasView(app, doc, frame);
    doc.onChange((e) => {
      app.emit('doc:change', e);
      if (e.kind === 'selection') app.emit('selection:changed', doc);
      if (e.kind === 'active') app.emit('layer:activated', { doc, layer: doc.active });
    });
    if (index >= 0 && index < this.docs.length) this.docs.splice(index, 0, doc);
    else this.docs.push(doc);
    if (activate || !this.active) this.activate(doc);
    else this.renderTabs();
    app.emit('doc:opened', doc);
    return doc;
  }

  activate(doc) {
    if (this.active === doc) return;
    const app = this.app;
    app.tools?.active?.deactivate?.();
    if (this.active?.frame) this.active.frame.hidden = true;
    this.active = doc;
    if (doc) {
      doc.frame.hidden = false;
      requestAnimationFrame(() => doc.view.resize());
    }
    document.getElementById('welcome').hidden = !!doc;
    this.host.hidden = !doc;
    app.tools?.active?.activate?.();
    app.tools?.updateCursor();
    this.renderTabs();
    app.emit('doc:activated', doc);
    app.syncUiState();
    app.commands.invalidate();
  }

  next(delta = 1) {
    if (this.docs.length < 2) return;
    const i = this.docs.indexOf(this.active);
    this.activate(this.docs[(i + delta + this.docs.length) % this.docs.length]);
  }

  /** Opens files from paths (already-open paths are activated). */
  async openPaths(paths) {
    let last = null;
    for (const path of paths) {
      const existing = this.findByPath(path);
      if (existing) {
        this.activate(existing);
        last = existing;
        continue;
      }
      try {
        if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
        const bytes = await bridge.readFile(path);
        const name = path.split(/[\\/]/).pop();
        const doc = await this.app.busy(`Opening ${name}…`, () => openDocument(bytes, { name, path }));
        this.add(doc);
        doc.history.markSaved(flattenDocument(doc, doc.view.compositor));
        this.rememberRecent(doc);
        last = doc;
      } catch (err) {
        this.app.reportError(err, `Could not open "${path.split(/[\\/]/).pop()}"`);
        bridge.removeRecent(path).catch(() => {});
        this.app.emit('recent:changed');
      }
    }
    return last;
  }

  async openDialog() {
    const paths = await bridge.openFileDialog({ multiple: true, filters: OPEN_FILTERS, title: 'Open' });
    if (paths?.length) return this.openPaths(paths);
    return null;
  }

  rememberRecent(doc) {
    if (!doc.path || doc.path.startsWith('browser:/') || doc.path.startsWith('download:/')) return;
    bridge
      .addRecent({ path: doc.path, name: doc.path.split(/[\\/]/).pop() })
      .then(() => this.app.emit('recent:changed'))
      .catch(() => {});
  }

  /**
   * Saves to the document's path; flattened formats ask before discarding layers. `askOptions: false` writes a
   * JPEG / WebP without the options dialog (see lossyOptions).
   */
  async save(doc = this.active, { askOptions = true } = {}) {
    if (!doc) return false;
    // formats Pigment can only read (GIF, SVG, BMP, ...) go through Save As: the original file is never overwritten with other bytes
    if (!doc.path || doc.path.startsWith('browser:/') || !canWritePath(doc.path) || !isLayeredPath(doc.path) && doc.layers().length > 1 && !doc.flattenOk) return this.saveAs(doc);
    return this.writeTo(doc, doc.path, { askOptions });
  }

  /**
   * JPEG/WebP quality for this document: asked once (JPEG Options), then reused by later saves. With `ask: false`
   * (a save nobody is there to answer for: a recorded "Close: save changes" step replayed over a folder) a document
   * that has no quality yet takes the last one chosen, as Batch's own Save and Close does.
   */
  async lossyOptions(doc, path, { ask = true } = {}) {
    const ext = extOf(path);
    if (!['jpg', 'jpeg', 'webp'].includes(ext)) return {};
    if (doc.saveOpts?.format === ext) return doc.saveOpts;
    const last = this.app.settings.saveQuality ?? 0.92;
    if (!ask) return (doc.saveOpts = { format: ext, quality: last });
    const o = await formDialog(this.app, {
      title: `${ext === 'webp' ? 'WebP' : 'JPEG'} Options`,
      fields: [{ key: 'quality', label: 'Quality', type: 'slider', value: Math.round(last * 100), min: 1, max: 100, unit: '%' }],
      okLabel: 'Save',
    });
    if (!o) return null;
    doc.saveOpts = { format: ext, quality: o.quality / 100 };
    this.app.settings.saveQuality = o.quality / 100;
    this.app.saveSettingsSoon();
    return doc.saveOpts;
  }

  async saveAs(doc = this.active, { copy = false } = {}) {
    if (!doc) return false;
    const defaultName = `${baseName(doc.name)}${copy ? ' copy' : ''}.${doc.path && isLayeredPath(doc.path) ? extOf(doc.path) : 'pigment'}`;
    const target = await bridge.saveFileDialog({ defaultPath: doc.path ? doc.path.replace(/[^\\/]+$/, defaultName) : defaultName, filters: SAVE_FILTERS, title: copy ? 'Save a Copy' : 'Save As' });
    if (!target) return false;
    let path = target;
    if (!extOf(path)) path += '.pigment';
    if (!canWritePath(path)) {
      // a typed-in extension Pigment cannot write (.gif, .svg, .bmp, ...): save a PNG instead of mislabelled bytes
      const typed = extOf(path);
      path = path.replace(/\.[^.\\/]+$/, '.png');
      this.app.dialogs.toast(`Pigment cannot write .${typed} files; saving as PNG instead`, { kind: 'info', timeout: 3200 });
    }
    if (!isLayeredPath(path) && doc.layers().filter((l) => l.visible).length > 1) {
      const ok = await this.app.dialogs.confirm(`${extOf(path).toUpperCase()} files cannot hold layers. The image will be flattened in the saved file (your document keeps its layers).`, { title: 'Save as a flat image', okLabel: 'Save' });
      if (!ok) return false;
    }
    const written = await this.writeTo(doc, path, { copy });
    if (written && !copy) {
      doc.path = path;
      doc.name = baseName(path);
      doc.format = extOf(path);
      doc.flattenOk = !isLayeredPath(path);
      this.renderTabs();
      this.rememberRecent(doc);
      this.app.syncUiState();
    }
    return written;
  }

  async writeTo(doc, path, { copy = false, askOptions = true } = {}) {
    try {
      this.app.tools?.active?.commit?.();
      // what only shows for a moment ends first (View previous state in Properties): a save not run as a command, such
      // as Save in the quit prompt, writes the document's own state too
      this.app.emit?.('doc:saving', { doc });
      const opts = await this.lossyOptions(doc, path, { ask: askOptions });
      if (!opts) return false;
      const bytes = await this.app.busy(`Saving ${path.split(/[\\/]/).pop()}…`, () => encodeForPath(doc, path, doc.view.compositor, opts));
      await bridge.writeFile(path, bytes);
      if (!copy) doc.history.markSaved(flattenDocument(doc, doc.view.compositor));
      this.app.dialogs.toast(`Saved ${path.split(/[\\/]/).pop()}`, { kind: 'success', timeout: 1600 });
      // a PSD is written as RGB (io.js bakes in what Duotone and Multichannel show): the mode itself, with its inks,
      // colour table or spot channels, is not in the file. Said once per document, like the bit depth notice of lib/depth.js
      if (extOf(path) === 'psd' && doc.mode && doc.mode !== 'rgb' && MODES[doc.mode] && !this.modeNoticed.has(doc)) {
        this.modeNoticed.add(doc);
        this.app.dialogs.toast(`PSD files are written as RGB. Save as .pigment to keep the document in ${MODES[doc.mode].name} mode.`, { timeout: 6000 });
      }
      this.app.emit('doc:saved', doc);
      return true;
    } catch (err) {
      this.app.reportError(err, 'Could not save');
      return false;
    }
  }

  /** Asks to save unsaved changes. Resolves true when it is fine to close. */
  async confirmDiscard(doc) {
    const answer = await this.askSave(doc);
    if (answer === 'cancel') return false;
    if (answer === 'save') return this.save(doc);
    return true;
  }

  /**
   * Only the question of confirmDiscard: 'save' | 'discard' | 'cancel', or null when there is nothing to ask. Closing
   * the window (app.js) asks first and prepares the document for saving only once the answer is Save.
   */
  async askSave(doc) {
    if (!doc.history?.dirty) return null;
    this.activate(doc);
    const { response } = await bridge.showMessage({
      type: 'question',
      message: `Save changes to "${doc.name}" before closing?`,
      detail: 'Your changes will be lost if you don\'t save them.',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return 'cancel';
    // remembered for a Close step being recorded (lib/actions.js): the step replays the answer instead of asking
    doc.closeAnswer = response === 0 ? 'save' : 'discard';
    return doc.closeAnswer;
  }

  /**
   * Closes a document. Unsaved changes ask first, unless the answer comes along: `save: true` saves them,
   * `save: false` drops them (a recorded Close step, so a batch does not stop at every file), `force` closes as it is.
   */
  async close(doc = this.active, { force = false, save = null } = {}) {
    if (!doc) return true;
    delete doc.closeAnswer;
    if (force || save === false) {
      // nothing to ask
    } else if (save === true) {
      // the answer came with the call, so the save does not stop at JPEG Options either
      if (doc.history?.dirty && !(await this.save(doc, { askOptions: false }))) return false;
    } else if (!(await this.confirmDiscard(doc))) return false;
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    doc.view.destroy();
    doc.frame.remove();
    if (this.active === doc) {
      this.active = null;
      this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
      if (!this.docs.length) {
        document.getElementById('welcome').hidden = false;
        this.host.hidden = true;
        this.renderTabs();
        this.app.emit('doc:activated', null);
        this.app.syncUiState();
        this.app.commands.invalidate();
      }
    } else this.renderTabs();
    this.app.emit('doc:closed', doc.id);
    return true;
  }

  /** Closes every document; each one with unsaved changes asks (there is no answer to pass along, see close()). */
  async closeAll() {
    for (const doc of this.docs.slice()) if (!(await this.close(doc))) return false;
    return true;
  }

  renderTabs() {
    const bar = this.tabbar;
    bar.replaceChildren();
    for (const doc of this.docs) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(doc === this.active));
      tab.title = doc.path ?? doc.name;
      const title = document.createElement('span');
      title.className = 'tab-title';
      const zoom = doc.view ? ` @ ${Math.round(doc.view.zoom * 100)}%` : '';
      title.textContent = `${doc.name}${zoom}`;
      tab.appendChild(title);
      if (doc.history?.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tab-dirty';
        dot.title = 'Unsaved changes';
        tab.appendChild(dot);
      }
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.innerHTML = icon('close');
      close.setAttribute('aria-label', `Close ${doc.name}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close(doc);
      });
      tab.appendChild(close);
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.close(doc);
        } else if (e.button === 0) this.activate(doc);
      });
      bar.appendChild(tab);
    }
    const add = document.createElement('button');
    add.className = 'tab-new';
    add.title = 'New document';
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => this.app.commands.run('file:new', undefined, 'toolbar'));
    bar.appendChild(add);
  }
}
