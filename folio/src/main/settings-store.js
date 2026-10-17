// A small JSON file store with atomic writes. Used for settings.json and recent.json.
// Pure Node (no Electron) so it is unit-testable.
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore {
  /**
   * @param {string} filePath
   * @param {(stored: any) => any} normalize  turns the raw parsed JSON (or undefined) into a valid value
   */
  constructor(filePath, normalize = (v) => v ?? {}) {
    this.filePath = filePath;
    this.normalize = normalize;
    this.value = normalize(undefined);
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      this.value = this.normalize(JSON.parse(text));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Corrupt file: keep a copy for the user and start from defaults.
        try {
          await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      this.value = this.normalize(undefined);
    }
    this.loaded = true;
    return this.value;
  }

  get() {
    return this.value;
  }

  /** Replaces the whole value and persists it. */
  async set(value) {
    this.value = this.normalize(value);
    await this.save();
    return this.value;
  }

  /** Shallow-merges a patch (object stores only) and persists. */
  async patch(patch) {
    const base = this.value && typeof this.value === 'object' && !Array.isArray(this.value) ? this.value : {};
    return this.set({ ...base, ...(patch ?? {}) });
  }

  /** Atomic write: temp file + rename, serialised so concurrent saves never interleave. */
  save() {
    const text = JSON.stringify(this.value, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
