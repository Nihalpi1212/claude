// Tabs: one DocumentSession per open document. Owns the tab strip and the active session.
import { DocumentView, PasswordError } from './viewer.js';
import { bridge } from './bridge.js';
import { icon } from './icons.js';

let nextId = 1;

export class DocumentSession {
  constructor(app, { path, name, bytes, password }) {
    this.app = app;
    this.id = `doc${nextId++}`;
    this.path = path ?? null;
    this.name = name ?? (path ? path.split(/[\\/]/).pop() : 'Untitled.pdf');
    this.bytes = bytes;
    this.password = password;
    this.opsDirty = false;
    this.host = document.createElement('div');
    this.host.className = 'doc-host';
    this.host.hidden = true;
    document.getElementById('viewer-host').appendChild(this.host);
    this.view = new DocumentView({ host: this.host, app, session: this });
    this.loaded = false;
  }

  get dirty() {
    return this.opsDirty || this.view.hasUnsavedEdits();
  }

  async load() {
    const result = await this.view.load(this.bytes, { password: this.password, name: this.name });
    this.loaded = true;
    return result;
  }

  /** Flushes pdf.js edits (forms, editor annotations) into this.bytes. */
  async flush() {
    this.bytes = await this.view.flush();
    return this.bytes;
  }

  /** Replaces the document bytes (after a pdf-lib operation) and reloads it in place. */
  async replaceBytes(bytes, { keepPosition = true, markDirty = true } = {}) {
    this.bytes = bytes;
    if (markDirty) this.opsDirty = true;
    await this.view.reload(bytes, { keepPosition, password: this.password });
    this.app.emit('doc:reloaded', this);
    this.app.emit('doc:dirty', { session: this, dirty: this.dirty });
    this.app.commands.invalidate();
  }

  async #write(path) {
    await this.flush();
    await bridge.writeFile(path, this.bytes);
  }

  async save() {
    if (!this.path || this.path.startsWith('browser:/')) return this.saveAs();
    try {
      await this.#write(this.path);
    } catch (err) {
      this.app.reportError(err, 'Could not save the document');
      return false;
    }
    this.opsDirty = false;
    this.view.markSaved();
    this.app.emit('doc:saved', this);
    this.app.emit('doc:dirty', { session: this, dirty: false });
    this.app.commands.invalidate();
    this.app.dialogs.toast('Saved', { kind: 'success', timeout: 1500 });
    return true;
  }

  async saveAs() {
    const target = await bridge.saveFileDialog({ defaultPath: this.path ?? this.name, title: 'Save As' });
    if (!target) return false;
    try {
      await this.#write(target);
    } catch (err) {
      this.app.reportError(err, 'Could not save the document');
      return false;
    }
    if (this.path) bridge.unwatchFile(this.path).catch(() => {});
    this.path = target;
    this.name = target.split(/[\\/]/).pop();
    this.opsDirty = false;
    this.view.markSaved();
    bridge.watchFile(target).catch(() => {});
    this.app.tabs.rememberRecent(this);
    this.app.emit('doc:saved', this);
    this.app.emit('doc:dirty', { session: this, dirty: false });
    this.app.tabs.render();
    this.app.commands.invalidate();
    this.app.dialogs.toast(`Saved as ${this.name}`, { kind: 'success', timeout: 1800 });
    return true;
  }

  async saveCopy() {
    const target = await bridge.saveFileDialog({ defaultPath: this.path ? this.path.replace(/(\.pdf)?$/i, ' copy.pdf') : 'Copy of ' + this.name, title: 'Save a Copy' });
    if (!target) return false;
    try {
      await this.#write(target);
    } catch (err) {
      this.app.reportError(err, 'Could not save the copy');
      return false;
    }
    this.app.dialogs.toast(`Copy saved`, { kind: 'success', timeout: 1500 });
    return true;
  }

  /** Asks about unsaved changes. Resolves true when the caller may proceed. */
  async confirmDiscard() {
    if (!this.dirty) return true;
    const { response } = await bridge.showMessage({
      type: 'warning',
      title: 'Unsaved changes',
      message: `Save changes to "${this.name}"?`,
      detail: 'Your annotations and form entries will be lost if you do not save them.',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return false;
    if (response === 0) return this.save();
    return true;
  }

  async close({ force = false } = {}) {
    if (!force && !(await this.confirmDiscard())) return false;
    this.app.tabs.remove(this);
    return true;
  }

  destroy() {
    if (this.path) bridge.unwatchFile(this.path).catch(() => {});
    this.view.destroy();
    this.host.remove();
  }
}

export class TabManager {
  constructor(app) {
    this.app = app;
    this.sessions = [];
    this.active = null;
    this.bar = document.getElementById('tabbar');
    this.newButton = document.createElement('button');
    this.newButton.className = 'tab-new';
    this.newButton.title = 'Open a PDF';
    this.newButton.innerHTML = icon('plus');
    this.newButton.addEventListener('click', () => app.commands.run('file:open', undefined, 'toolbar'));
    this.render();
  }

  list() {
    return this.sessions.slice();
  }

  findByPath(path) {
    return this.sessions.find((s) => s.path && s.path === path) ?? null;
  }

  /**
   * Opens a document from a path or from bytes. Returns the session (or null on failure/cancel).
   * @param {{ path?: string, bytes?: Uint8Array, name?: string, activate?: boolean, page?: number }} opts
   */
  async open(opts) {
    const { path, name, activate = true } = opts;
    let bytes = opts.bytes;
    if (path) {
      const existing = this.findByPath(path);
      if (existing) {
        if (activate) this.activate(existing);
        return existing;
      }
      if (window.__folioTest?.pending?.[path]) await window.__folioTest.pending[path];
      try {
        bytes = await bridge.readFile(path);
      } catch (err) {
        this.app.reportError(err, `Could not open "${path.split(/[\\/]/).pop()}"`);
        bridge.removeRecent(path).catch(() => {});
        this.app.emit('recent:changed');
        return null;
      }
    }
    if (!bytes) return null;
    const session = new DocumentSession(this.app, { path, name, bytes });
    this.sessions.push(session);
    this.render();
    if (activate || !this.active) this.activate(session);
    this.app.emit('tab:opened', session);
    try {
      await this.#loadWithPassword(session);
    } catch (err) {
      this.remove(session);
      this.app.reportError(err, `Could not open "${session.name}"`);
      return null;
    }
    if (path) {
      bridge.watchFile(path).catch(() => {});
      const recent = (await bridge.getRecent()).find((r) => r.path === path);
      const page = Number.isInteger(opts.page) ? opts.page : this.app.settings.rememberLastPage ? recent?.page : undefined;
      if (page && page > 1 && page <= session.view.numPages) session.view.page = page;
      this.rememberRecent(session);
    }
    this.app.emit('doc:loaded', session);
    this.app.commands.invalidate();
    return session;
  }

  async #loadWithPassword(session) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await session.load();
        return;
      } catch (err) {
        if (!(err instanceof PasswordError)) throw err;
        const password = await this.app.askPassword(session.name, attempt > 0 || err.wrong);
        if (password === null) throw new Error('No password entered');
        session.password = password;
      }
    }
    throw new Error('Too many wrong passwords');
  }

  rememberRecent(session) {
    if (!session.path || session.path.startsWith('browser:/')) return;
    bridge
      .addRecent({ path: session.path, name: session.name, page: session.view.page })
      .then(() => this.app.emit('recent:changed'))
      .catch(() => {});
  }

  activate(session) {
    if (this.active === session) return;
    if (this.active) {
      this.active.host.hidden = true;
      this.active.view.onDeactivate?.();
    }
    this.active = session;
    if (session) {
      session.host.hidden = false;
      session.view.onActivate?.();
    }
    document.getElementById('welcome').hidden = !!session;
    this.render();
    this.app.emit('tab:activated', session);
    this.app.commands.invalidate();
  }

  remove(session) {
    const index = this.sessions.indexOf(session);
    if (index === -1) return;
    this.sessions.splice(index, 1);
    session.destroy();
    this.app.emit('tab:closed', session.id);
    if (this.active === session) {
      this.active = null;
      this.activate(this.sessions[Math.min(index, this.sessions.length - 1)] ?? null);
    } else {
      this.render();
    }
    this.app.commands.invalidate();
  }

  next(delta = 1) {
    if (this.sessions.length < 2) return;
    const index = this.sessions.indexOf(this.active);
    this.activate(this.sessions[(index + delta + this.sessions.length) % this.sessions.length]);
  }

  render() {
    this.bar.replaceChildren();
    for (const session of this.sessions) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(session === this.active));
      tab.dataset.id = session.id;
      tab.title = session.path ?? session.name;
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = session.name;
      tab.appendChild(title);
      if (session.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tab-dirty';
        dot.title = 'Unsaved changes';
        tab.appendChild(dot);
      }
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.title = 'Close';
      close.setAttribute('aria-label', `Close ${session.name}`);
      close.innerHTML = icon('close');
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        session.close();
      });
      tab.appendChild(close);
      tab.addEventListener('click', () => this.activate(session));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) session.close();
      });
      this.bar.appendChild(tab);
    }
    this.bar.appendChild(this.newButton);
  }
}
