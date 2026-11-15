// type-editing (ARCHITECTURE.md "0.4 features", package 2): the undo stack inside one Type tool editing session.
// Pure (no DOM), unit-tested in Node.
//
// A step holds two snapshots of the edited layer, `before` and `after` (content objects are immutable, so a
// snapshot is a handful of references), each with the selection to show. Undo restores `before`, redo `after`.
// Consecutive edits of the same kind (typing a word, one IME composition, a held Shift+Ctrl+.) merge into one step:
// the step keeps its first `before` and takes the newest `after`. The whole session is still one document history
// entry when it is committed (B.8); this stack only lives while the session does.

export class EditStack {
  /**
   * @param {{ limit?: number, mergeMs?: number, clock?: () => number }} [opts]
   */
  constructor({ limit = 500, mergeMs = 1500, clock = () => Date.now() } = {}) {
    this.steps = [];
    this.index = 0; // steps[0 .. index) are done
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.clock = clock;
    this.sealed = true; // the next record starts a new step even when its kind matches
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.steps.length;
  }

  /**
   * Records an edit. `kind` groups edits that merge ('typing', 'delete', 'compose', or a command label); `merge:
   * false` always starts a new step. Returns the step.
   */
  record(before, after, { kind = 'edit', merge = true } = {}) {
    const t = this.clock();
    const last = this.index > 0 ? this.steps[this.index - 1] : null;
    if (merge && !this.sealed && last && last.kind === kind && this.index === this.steps.length && t - last.at <= this.mergeMs) {
      last.after = after;
      last.at = t;
      return last;
    }
    this.steps.length = this.index; // a new edit drops what could have been redone
    const step = { kind, before, after, at: t };
    this.steps.push(step);
    if (this.steps.length > this.limit) this.steps.shift();
    this.index = this.steps.length;
    this.sealed = false;
    return step;
  }

  /** The next record starts a new step (the caret moved, the pointer clicked, a different command ran). */
  seal() {
    this.sealed = true;
  }

  /** The snapshot to restore for Undo, or null. */
  undo() {
    if (!this.canUndo) return null;
    this.index--;
    this.sealed = true;
    return this.steps[this.index].before;
  }

  /** The snapshot to restore for Redo, or null. */
  redo() {
    if (!this.canRedo) return null;
    const step = this.steps[this.index];
    this.index++;
    this.sealed = true;
    return step.after;
  }

  clear() {
    this.steps = [];
    this.index = 0;
    this.sealed = true;
  }
}
