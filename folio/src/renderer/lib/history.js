// Document-level undo/redo for engine (pdf-lib) operations: snapshots of the bytes per session.
// pdf.js keeps its own undo stack for its annotation editors; app.js consults both.
const MAX_ENTRIES = 25;
const MAX_BYTES = 300 * 1024 * 1024;

class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }
  push(bytes, label) {
    this.undoStack.push({ bytes, label });
    this.redoStack.length = 0;
    this.#trim();
  }
  #trim() {
    while (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    let total = this.undoStack.reduce((n, e) => n + e.bytes.byteLength, 0);
    while (total > MAX_BYTES && this.undoStack.length > 1) total -= this.undoStack.shift().bytes.byteLength;
  }
}

export function install(app) {
  const histories = new WeakMap();
  const of = (session) => {
    if (!histories.has(session)) histories.set(session, new History());
    return histories.get(session);
  };

  app.edit = {
    /**
     * Runs an engine operation on the active session: flush pdf.js edits, snapshot, apply, reload.
     * @param {(bytes: Uint8Array, session) => Promise<Uint8Array | { bytes: Uint8Array } | null>} op
     * @param {{ label?: string, keepPosition?: boolean, session?: any, silent?: boolean }} [opts]
     */
    async apply(op, { label = 'Edit', keepPosition = true, session = app.session, silent = false } = {}) {
      if (!session) return null;
      const before = await session.flush();
      let result;
      try {
        result = await op(before, session);
      } catch (err) {
        if (!silent) app.reportError(err, label);
        return null;
      }
      const bytes = result instanceof Uint8Array ? result : result?.bytes;
      if (!bytes) return result;
      of(session).push(before, label);
      await session.replaceBytes(bytes, { keepPosition });
      app.commands.invalidate();
      return result;
    },
    canUndo(session = app.session) {
      return !!session && of(session).undoStack.length > 0;
    },
    canRedo(session = app.session) {
      return !!session && of(session).redoStack.length > 0;
    },
    async undo(session = app.session) {
      if (!session) return false;
      const h = of(session);
      const entry = h.undoStack.pop();
      if (!entry) return false;
      const current = await session.flush();
      h.redoStack.push({ bytes: current, label: entry.label });
      await session.replaceBytes(entry.bytes, { keepPosition: true });
      app.dialogs.toast(`Undo: ${entry.label}`, { timeout: 1200 });
      return true;
    },
    async redo(session = app.session) {
      if (!session) return false;
      const h = of(session);
      const entry = h.redoStack.pop();
      if (!entry) return false;
      const current = await session.flush();
      h.undoStack.push({ bytes: current, label: entry.label });
      await session.replaceBytes(entry.bytes, { keepPosition: true });
      app.dialogs.toast(`Redo: ${entry.label}`, { timeout: 1200 });
      return true;
    },
    clear(session) {
      histories.delete(session);
    },
  };
  app.on('tab:closed', () => {
    /* WeakMap entries go away with the session */
  });
}
