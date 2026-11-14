// Command registry: every user action is a command id (see ARCHITECTURE.md). Menus, toolbar,
// shortcuts and context menus all run commands; modules register handlers.
//
// 0.4 (ARCHITECTURE.md "0.4 features", E): nothing replaces run() any more. Sessions (on-canvas
// workspaces, Free Transform, app.busy, the type session) are answered by app.sessions
// (lib/sessions.js), and modules that need to know which commands run observe them
// (observe({ before, after })). The order inside run() is 0.3's order of wrappers and checks:
//   1. every observer's before (the actions recorder was the outermost wrapper in 0.3);
//   2. app.sessions.guardModal (a session's handle answers, a modal session refuses);
//   3. unknown id, de-duplication, menu commands while a dialog is open (dialogs.passesMenu);
//   4. app.sessions.guardBusy (gestures while a slow operation runs);
//   5. app.sessions.commitBefore (Free Transform is applied first; undo-like commands cancel it);
//   6. enabled, the command, 'command:done';
// and every observer's after(token, result, { handledBy, refused }) once run returns, early or not.

import { GESTURE_SOURCES } from './sessions.js';

export { GESTURE_SOURCES };

const DEDUPE_MS = 40;

export class CommandRegistry {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    this.lastRun = new Map(); // id -> { at, source }
    this.observers = [];
  }

  /**
   * @param {string} id
   * @param {{ run: (arg?: any, ctx?: { source: string, setReplayArg(v: any): void, setReplayCommand(id: string, arg?: any): void, cancel(): void }) => any,
   *   enabled?: () => boolean, checked?: () => boolean, label?: string | (() => string), dialog?: boolean,
   *   changesDocument?: boolean, record?: boolean, undoLike?: boolean, stub?: boolean }} def
   *   dialog: true marks a command that asks the user something when run without an argument (actions record it only through ctx)
   *   changesDocument: true: it changes the document although its group says otherwise (view: guide commands): refused
   *     while busy, never admitted by a session's RegExp allow, recorded by actions
   *   record: false: actions never record it; true: always (wins over the recorder's 0.3 lists)
   *   undoLike: true: treated like Edit > Undo (a 'commit' session cancels, the recorder follows it, never records it)
   *   stub: true: a placeholder (lib/stub.js); registering a definition without it takes the id out of app.stubbed
   */
  register(id, def) {
    if (typeof def === 'function') def = { run: def };
    if (!def || typeof def.run !== 'function') throw new Error(`Command ${id} needs a run()`);
    this.commands.set(id, def);
    if (!def.stub && this.app?.stubbed?.includes(id)) {
      this.app.stubbed = this.app.stubbed.filter((x) => x !== id);
      this.app.emit?.('commands:changed');
    }
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
   * Watches every command run: before(id, arg, source) returns a token, after(token, result, { handledBy, refused })
   * gets it back with whatever run() returned (a promise or a value; the observer waits for a promise itself), also
   * when run() returned early. Observers are called in registration order. Returns the function that removes it.
   */
  observe(observer) {
    this.observers.push(observer);
    return () => {
      const i = this.observers.indexOf(observer);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /**
   * Runs a command. `source` tells where it came from ('menu' | 'menu-key' | 'key' | 'toolbar' | 'panel' | 'drop' |
   * 'api' | 'action' | 'assistant' | 'os'); the same command arriving from two different sources within a few
   * milliseconds is run once (native menu accelerators and the renderer's own key handling can both see one key
   * press, see keymap.js).
   */
  run(id, arg, source = 'api') {
    const tokens = [];
    for (const o of this.observers.slice()) {
      let token;
      try {
        token = o.before ? o.before(id, arg, source) : undefined;
      } catch (err) {
        console.warn('Command observer failed', err);
      }
      tokens.push([o, token]);
    }
    const info = { handledBy: null, refused: false };
    let result;
    try {
      result = this.dispatch(id, arg, source, info);
    } finally {
      for (const [o, token] of tokens) {
        try {
          o.after?.(token, result, info);
        } catch (err) {
          console.warn('Command observer failed', err);
        }
      }
    }
    return result;
  }

  dispatch(id, arg, source, info) {
    const app = this.app;
    const sessions = app.sessions;
    const guard = sessions?.guardModal(id, arg, source);
    if (guard?.handled) {
      info.handledBy = guard.by;
      return guard.result;
    }
    if (guard?.refused) {
      info.refused = true;
      return undefined;
    }
    const def = this.commands.get(id);
    if (!def) {
      console.warn(`Unknown command: ${id}`);
      return undefined;
    }
    const now = performance.now();
    const last = this.lastRun.get(id);
    if (last && last.source !== source && now - last.at < DEDUPE_MS && last.arg === arg) return undefined;
    this.lastRun.set(id, { at: now, source, arg });
    // menus stay live in the native menu bar while a modal dialog previews on the canvas: ignore them, unless the
    // dialog lets that command through (dialogs.passesMenu: view navigation under a movable dialog)
    if ((source === 'menu' || source === 'menu-key') && app.dialogs?.isOpen && !app.dialogs.passesMenu?.(id)) return undefined;
    // A slow operation (app.busy: Auto-Align, opening a file…) works on the document as it was when it started and
    // commits when it is done: a gesture that deletes its layers or undoes under it would leave a result that fits
    // nothing. Gestures wait; what a dialog offers while busy (Batch shows one) is that dialog's business.
    if (sessions?.guardBusy(id, source)?.refused) {
      info.refused = true;
      return undefined;
    }
    // a running Free Transform is applied before anything else touches the document (undo/redo cancel it)
    if (sessions?.commitBefore(id)?.cancelled) return undefined;
    if (!this.isEnabled(id)) return undefined;
    // The context lets a command with a dialog report what it finally did (lib/actions.js records
    // `command:done` events to build actions): setReplayArg(params) names the argument that re-runs the
    // command without a dialog, setReplayCommand(id, arg) names another command that does what this run did
    // (layer:merge records layer:merge-down), cancel() marks a dismissed dialog so nothing is recorded.
    const ctx = {
      id, source, replayArg: undefined, replayId: undefined, cancelled: false,
      setReplayArg: (v) => { ctx.replayArg = v; },
      setReplayCommand: (cmd, v) => { ctx.replayId = cmd; ctx.replayArg = v; },
      cancel: () => { ctx.cancelled = true; },
    };
    const done = (result) => {
      const ev = {
        id,
        arg: ctx.replayId !== undefined || ctx.replayArg !== undefined ? ctx.replayArg : arg,
        source, result, cancelled: ctx.cancelled,
        replayable: ctx.replayId !== undefined || ctx.replayArg !== undefined || arg !== undefined || !def.dialog,
      };
      if (ctx.replayId !== undefined) {
        ev.replayId = ctx.replayId;
        ev.replayArg = ctx.replayArg;
      }
      app.emit('command:done', ev);
    };
    try {
      const result = def.run(arg, ctx);
      if (result && typeof result.then === 'function') {
        result.then(done, (err) => app.reportError(err, `Command ${id} failed`)).finally(() => app.emit('commands:changed'));
      } else {
        app.emit('commands:changed');
        done(result);
      }
      return result;
    } catch (err) {
      app.reportError(err, `Command ${id} failed`);
      return undefined;
    }
  }

  /** Marks state as changed so toolbars/menus refresh their enabled/checked state. */
  invalidate() {
    this.app.emit('commands:changed');
  }
}
