// Command registry: every user action is a command id (see ARCHITECTURE.md). Menus, toolbar,
// shortcuts and context menus all run commands; modules register handlers.

const DEDUPE_MS = 40;

export class CommandRegistry {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    this.lastRun = new Map(); // id -> { at, source }
  }

  /**
   * @param {string} id
   * @param {{ run: (arg?: any) => any, enabled?: () => boolean, checked?: () => boolean, label?: string }} def
   */
  register(id, def) {
    if (typeof def === 'function') def = { run: def };
    if (!def || typeof def.run !== 'function') throw new Error(`Command ${id} needs a run()`);
    this.commands.set(id, def);
    return this;
  }

  registerAll(map) {
    for (const [id, def] of Object.entries(map)) this.register(id, def);
    return this;
  }

  has(id) {
    return this.commands.has(id);
  }

  isEnabled(id) {
    const def = this.commands.get(id);
    if (!def) return false;
    try {
      return def.enabled ? !!def.enabled() : true;
    } catch {
      return false;
    }
  }

  isChecked(id) {
    const def = this.commands.get(id);
    if (!def?.checked) return false;
    try {
      return !!def.checked();
    } catch {
      return false;
    }
  }

  /**
   * Runs a command. `source` tells where it came from ('menu' | 'key' | 'toolbar' | 'api'); the same
   * command arriving from two different sources within a few milliseconds is run once (native menu
   * accelerators and the renderer's own key handling can both see one key press, see keymap.js).
   */
  run(id, arg, source = 'api') {
    const def = this.commands.get(id);
    if (!def) {
      console.warn(`Unknown command: ${id}`);
      return undefined;
    }
    const now = performance.now();
    const last = this.lastRun.get(id);
    if (last && last.source !== source && now - last.at < DEDUPE_MS && last.arg === arg) return undefined;
    this.lastRun.set(id, { at: now, source, arg });
    if (!this.isEnabled(id)) return undefined;
    try {
      const result = def.run(arg);
      if (result && typeof result.then === 'function') {
        result.catch((err) => this.app.reportError(err, `Command ${id} failed`)).finally(() => this.app.emit('commands:changed'));
      } else {
        this.app.emit('commands:changed');
      }
      return result;
    } catch (err) {
      this.app.reportError(err, `Command ${id} failed`);
      return undefined;
    }
  }

  /** Marks state as changed so toolbars/menus refresh their enabled/checked state. */
  invalidate() {
    this.app.emit('commands:changed');
  }
}
