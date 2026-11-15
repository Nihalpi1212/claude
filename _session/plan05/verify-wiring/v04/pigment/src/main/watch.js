// Watches open documents for changes on disk and reports them (debounced) to the renderer.
import { watch } from 'node:fs';
import { promises as fs } from 'node:fs';

export class FileWatcher {
  /** @param {(path: string) => void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    this.watchers = new Map(); // path -> { watcher, timer, mtimeMs }
  }

  async add(path) {
    if (this.watchers.has(path)) return;
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(path)).mtimeMs;
    } catch {
      return;
    }
    let watcher;
    try {
      watcher = watch(path, { persistent: false }, () => this.#changed(path));
    } catch {
      return;
    }
    watcher.on('error', () => this.remove(path));
    this.watchers.set(path, { watcher, timer: null, mtimeMs });
  }

  remove(path) {
    const entry = this.watchers.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      /* ignore */
    }
    this.watchers.delete(path);
  }

  /** Call after the app itself wrote the file so its own save is not reported as an external change. */
  async markSelfWrite(path) {
    const entry = this.watchers.get(path);
    if (!entry) return;
    try {
      entry.mtimeMs = (await fs.stat(path)).mtimeMs;
    } catch {
      /* ignore */
    }
  }

  #changed(path) {
    const entry = this.watchers.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      try {
        const stat = await fs.stat(path);
        if (stat.mtimeMs !== entry.mtimeMs) {
          entry.mtimeMs = stat.mtimeMs;
          this.onChange(path);
        }
      } catch {
        // File removed/renamed: editors often save via rename, so re-arm the watcher.
        this.remove(path);
        setTimeout(() => this.add(path).then(() => this.onChange(path)), 250);
      }
    }, 300);
  }

  close() {
    for (const path of [...this.watchers.keys()]) this.remove(path);
  }
}
