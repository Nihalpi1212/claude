// Session registry (ARCHITECTURE.md "0.4 features", E): the one place that decides what a command
// may do while an on-canvas session or a slow operation runs. Before 0.4 four modules replaced
// app.commands.run to guard their sessions and commands.js held the Free Transform and busy rules;
// CommandRegistry.run now asks this registry (guardModal, guardBusy, commitBefore) instead.
// Pure apart from app.dialogs.toast; owned by the skeleton.
//
// Policies:
//  - 'modal'   (Blur Gallery, Content-Aware Scale, Select and Mask): everything but `allow` is refused
//               with a hint; `handle` may answer commands itself (Select and Mask's own undo);
//  - 'commit'  (Free Transform, the 0.4 type editor): another command commits the session first, an
//               undo-like command cancels it instead;
//  - 'busy'    (app.busy): gestures (GESTURE_SOURCES) are refused while no dialog is open;
//  - 'observe' (the 0.3 type session): claims Edit > Undo / Redo through undo() / redo().

/** Where a user gesture comes from (code runs commands as 'api', playback as 'action', the assistant as 'assistant'). */
export const GESTURE_SOURCES = new Set(['menu', 'menu-key', 'key', 'toolbar', 'panel']);
/** Commands that never change a document: allowed while a busy session runs (a def with changesDocument is not). */
export const SAFE_WHILE_BUSY = /^(view:|window:|help:|actions:stop$)/;
/** Edit > Undo and its relatives: a 'commit' session cancels on them (a def with undoLike counts too). */
export const UNDO_LIKE = /^edit:(undo|redo|step-backward|step-forward|toggle-last-state)$/;

const HINT_MS = 2500;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SessionRegistry {
  /**
   * @param {object} app the App (reads app.commands for definitions, app.dialogs for toasts)
   * @param {{ clock?: () => number }} [opts]
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.entries = []; // { spec, ended }, oldest first
    this.clock = opts.clock ?? now;
    this.hintAt = -Infinity;
    this.busyNoticeAt = -Infinity;
  }

  /** A permanent entry, counted while spec.active() is true. Returns the function that removes it. */
  register(spec) {
    const entry = { spec, ended: false };
    this.entries.push(entry);
    return () => this.drop(entry);
  }

  /** A temporary entry, counted until end() (busy, the 0.4 sessions). */
  begin(spec) {
    const entry = { spec, ended: false };
    this.entries.push(entry);
    return { end: () => this.drop(entry) };
  }

  drop(entry) {
    entry.ended = true;
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
  }

  isActive(entry) {
    if (entry.ended) return false;
    const a = entry.spec.active;
    if (!a) return true;
    try {
      return !!a();
    } catch {
      return false;
    }
  }

  /** Active entries, newest first. */
  activeEntries() {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.isActive(this.entries[i])) out.push(this.entries[i]);
    return out;
  }

  /** Active session specs, newest last. */
  list() {
    return this.activeEntries().reverse().map((e) => e.spec);
  }

  def(id) {
    return this.app?.commands?.commands?.get?.(id) ?? null;
  }

  /** True when spec lets the command run alongside it (a RegExp never admits a changesDocument def). */
  allows(spec, id, arg, source, def = this.def(id)) {
    const allow = spec.allow;
    if (!allow) return false;
    if (allow instanceof RegExp) return !def?.changesDocument && allow.test(id);
    try {
      return !!allow(id, arg, source);
    } catch {
      return false;
    }
  }

  labelOf(spec) {
    try {
      return typeof spec.label === 'function' ? spec.label() : spec.label ?? spec.id;
    } catch {
      return spec.id;
    }
  }

  hint(spec, source) {
    if (source === 'api' || spec.hint === false) return;
    const t = this.clock();
    if (t - this.hintAt <= HINT_MS) return;
    this.hintAt = t;
    const text = typeof spec.hint === 'string' ? spec.hint : `Finish ${this.labelOf(spec)} first: Enter applies it, Esc cancels`;
    this.app?.dialogs?.toast?.(text, { timeout: 2200 });
  }

  /**
   * Step 2 of CommandRegistry.run: a session's handle answers (any policy); a modal session refuses
   * what it does not allow (hint at most every 2.5 s, never for 'api'). Allowed ids pass on to the
   * next (older) session.
   * @returns {{ refused: true, by: string } | { handled: true, by: string, result: any } | null}
   */
  guardModal(id, arg, source) {
    const def = this.def(id);
    for (const { spec } of this.activeEntries()) {
      if (spec.handle) {
        let r;
        try {
          r = spec.handle(id, arg, source);
        } catch (err) {
          console.warn(`Session ${spec.id} failed to handle ${id}`, err);
          r = undefined;
        }
        if (r && typeof r === 'object') return { handled: true, by: spec.id, result: r.result };
      }
      if (spec.policy !== 'modal') continue;
      if (this.allows(spec, id, arg, source, def)) continue;
      this.hint(spec, source);
      return { refused: true, by: spec.id };
    }
    return null;
  }

  /** Step 4: while a busy session runs, gestures are refused unless a dialog is open or the session allows them. */
  guardBusy(id, source) {
    const def = this.def(id);
    for (const { spec } of this.activeEntries()) {
      if (spec.policy !== 'busy') continue;
      const sources = spec.sources ?? GESTURE_SOURCES;
      if (!sources.has(source)) continue;
      if (this.app?.dialogs?.isOpen) return null;
      if (this.allows(spec, id, undefined, source, def)) continue;
      const t = this.clock();
      if (t - this.busyNoticeAt > HINT_MS) {
        this.busyNoticeAt = t;
        this.app?.dialogs?.toast?.(typeof spec.hint === 'string' ? spec.hint : 'Pigment is still working: try again when it has finished', { kind: 'info', timeout: 2200 });
      }
      return { refused: true, by: spec.id };
    }
    return null;
  }

  /** Step 5: 'commit' sessions commit before another command; undo-like commands cancel them instead (and do not run). */
  commitBefore(id) {
    const def = this.def(id);
    for (const { spec } of this.activeEntries()) {
      if (spec.policy !== 'commit') continue;
      if (this.allows(spec, id, undefined, undefined, def)) continue;
      if (UNDO_LIKE.test(id) || def?.undoLike) {
        spec.cancel?.('undo');
        return { cancelled: true, by: spec.id };
      }
      spec.commit?.();
    }
    return null;
  }

  /** Edit > Undo for sessions that claim it (newest first); true when one did. */
  undo() {
    for (const { spec } of this.activeEntries()) if (spec.undo && spec.undo()) return true;
    return false;
  }

  redo() {
    for (const { spec } of this.activeEntries()) if (spec.redo && spec.redo()) return true;
    return false;
  }

  /** True when an active session owns el (app.isTextTarget() answers false for it). */
  ownsFocus(el) {
    if (!el) return false;
    for (const { spec } of this.activeEntries()) {
      try {
        if (spec.ownsFocus?.(el)) return true;
      } catch {
        // a broken test counts as "not mine"
      }
    }
    return false;
  }

  /** Number of active busy sessions (app.busyDepth). */
  get busyDepth() {
    return this.activeEntries().filter((e) => e.spec.policy === 'busy').length;
  }

  /** Window close: every active session, newest first, cancels, commits or is kept (spec.onClose). */
  async cancelAll(reason = 'close') {
    for (const { spec } of this.activeEntries()) {
      const what = spec.onClose ?? (spec.policy === 'modal' || spec.policy === 'commit' ? 'cancel' : 'keep');
      try {
        if (what === 'cancel') await spec.cancel?.(reason);
        else if (what === 'commit') await spec.commit?.();
      } catch (err) {
        console.warn(`Session ${spec.id} could not be closed`, err);
      }
    }
  }
}
