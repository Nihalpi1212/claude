// conventions-shortcuts-fields (package 16, ARCHITECTURE.md "0.4 features (contracts)", Packages): Photoshop's
// conventions across the app.
//   - Edit > Toggle Last State (Alt+Ctrl+Z, `undoLike`): undoes the last step, and redoes it when pressed again
//     right after, through app.historyStep (so a text field, the type session or Select and Mask answer it first).
//   - Edit > Search… (Ctrl+F, `record: false`): lib/command-search.js.
//   - the numeric field (lib/numeric-field.js) as the `numeric` widget, and its document-level enhancer for every
//     other number input of the app (arithmetic, typed units, Shift+arrow, the wheel, scrubby labels).
//   - the "Tools and shortcuts" preferences: Use Shift Key for Tool Switch, spring-loaded tools, dialog positions.
// Temporary and spring-loaded tools are lib/temp-tools.js (driven by shortcuts.js); movable dialogs, the canvas under
// them and Alt = Reset are lib/dialogs.js and lib/form.js.
import { registerWidget } from './fields.js';
import { numericField, installNumericEnhancer } from './numeric-field.js';
import { openSearch } from './command-search.js';
import { isMac, platform } from './bridge.js';

/** The "Tools and shortcuts" section of Preferences (L.2), over settings.conventions. */
export const conventionsPreferences = {
  id: 'conventions',
  title: 'Tools and shortcuts',
  order: 25,
  fields: [
    { key: 'conventionsShiftSwitch', label: 'Use Shift key for tool switch (off: pressing a tool key again steps through its tools)', type: 'checkbox', span: true },
    { key: 'conventionsSpringLoaded', label: 'Spring-loaded tools (hold a tool key, Ctrl or Alt to switch only while it is held)', type: 'checkbox', span: true },
    { key: 'conventionsResetPositions', label: 'Open moved dialogs in the middle again', type: 'checkbox', span: true },
  ],
  read(s) {
    const c = s.conventions ?? {};
    return {
      conventionsShiftSwitch: c.toolSwitchWithShift !== false,
      conventionsSpringLoaded: c.springLoaded !== false,
      conventionsResetPositions: false,
    };
  },
  write(v, s) {
    const c = s.conventions ?? {};
    const next = {
      ...c,
      toolSwitchWithShift: !!v.conventionsShiftSwitch,
      springLoaded: !!v.conventionsSpringLoaded,
      dialogPositions: v.conventionsResetPositions ? {} : c.dialogPositions ?? {},
    };
    const changed = next.toolSwitchWithShift !== (c.toolSwitchWithShift !== false) || next.springLoaded !== (c.springLoaded !== false) || (v.conventionsResetPositions && Object.keys(c.dialogPositions ?? {}).length);
    return changed ? { conventions: next } : {};
  },
};

/**
 * Follows where a document's history stands, so Toggle Last State knows the state the user came from. The steps of one
 * gesture (History panel jump: several undos in a row) settle in a microtask, so the jump counts as one move.
 * mark.docs: doc -> { cur, prev, pending }, a position being { index, entry } (the entry identifies the state).
 */
export function trackHistory(mark, doc) {
  const h = doc?.history;
  if (!h) return;
  mark.docs ??= new WeakMap();
  const here = () => ({ index: h.index, entry: h.entries[h.index] ?? null });
  let st = mark.docs.get(doc);
  if (!st) {
    // the first change seen: a new entry (the usual case) came from the state below it
    const cur = here();
    st = { cur, prev: cur.index >= 0 ? { index: cur.index - 1, entry: h.entries[cur.index - 1] ?? null } : null, pending: null };
    mark.docs.set(doc, st);
    return;
  }
  if (st.pending) return;
  st.pending = st.cur;
  queueMicrotask(() => {
    const from = st.pending;
    st.pending = null;
    const now = here();
    if (now.index === from.index && now.entry === from.entry) return;
    st.prev = from;
    st.cur = now;
  });
}

/**
 * Toggle Last State: Photoshop's Alt+Ctrl+Z. It goes back to the history state the document was in before the
 * current one: after an edit that is the state before it (an undo), after Undo or a History panel jump it is the
 * state the user came from, so pressing it repeatedly flips between the last two states. When that state is gone
 * (a new edit dropped it, or the history was trimmed) it undoes.
 */
export function toggleLastState(app, mark) {
  const doc = app.doc;
  const h = doc?.history;
  if (!h) return;
  const st = mark.docs?.get(doc);
  const prev = st && !st.pending && st.cur.index === h.index && st.cur.entry === (h.entries[h.index] ?? null) ? st.prev : null;
  const reachable = !!prev && prev.index !== h.index && prev.index >= -1 && prev.index < h.entries.length && (prev.index === -1 || h.entries[prev.index] === prev.entry);
  if (!reachable || prev.index === h.index - 1) return app.historyStep('undo');
  if (prev.index === h.index + 1) return app.historyStep('redo');
  return app.historyStep({ goTo: prev.index });
}

export function install(app) {
  installNumericEnhancer(app);

  // the real numeric widget (H): the stub's spec, with units, popup slider and the scrubby label
  registerWidget('numeric', (spec, { value, onInput, onChange }) => {
    const f = numericField({ ...spec, value: value ?? spec.value, onInput, onChange });
    return { element: f.element, get: f.get, set: f.set, setDisabled: f.setDisabled, destroy: f.destroy };
  });

  app.preferences?.registerSection(conventionsPreferences);

  const mark = { docs: new WeakMap() };
  app.on('history:changed', (doc) => trackHistory(mark, doc));
  app.commands.registerAll({
    'edit:toggle-last-state': {
      label: 'Toggle Last State',
      undoLike: true,
      enabled: () => !!app.doc,
      run: () => toggleLastState(app, mark),
    },
    'edit:search': {
      label: 'Search…',
      record: false,
      // opens the palette and returns at once; the chosen command runs on its own once the palette has closed
      run: () => {
        openSearch(app, { isMac, platform: isMac ? 'darwin' : platform === 'win32' ? 'win32' : 'linux' });
      },
    },
  });
}
