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
 * Toggle Last State: Photoshop's Alt+Ctrl+Z. The first press undoes; a press right after a toggle (nothing else
 * changed the history in between) goes the other way, so pressing it repeatedly flips between the last two states.
 */
export function toggleLastState(app, mark) {
  const doc = app.doc;
  const h = doc?.history;
  let dir = 'undo';
  if (h && mark.last && mark.last.doc === doc && mark.last.index === h.index) {
    const same = mark.last.dir === 'undo' ? h.entries[h.index + 1] === mark.last.entry : h.entries[h.index] === mark.last.entry;
    if (same) dir = mark.last.dir === 'undo' ? 'redo' : 'undo';
  }
  if (dir === 'redo' && !h?.canRedo) dir = 'undo';
  app.historyStep(dir);
  if (h && doc === app.doc) {
    mark.last = { doc, dir, index: h.index, entry: dir === 'undo' ? h.entries[h.index + 1] : h.entries[h.index] };
  } else mark.last = null;
}

export function install(app) {
  installNumericEnhancer(app);

  // the real numeric widget (H): the stub's spec, with units, popup slider and the scrubby label
  registerWidget('numeric', (spec, { value, onInput, onChange }) => {
    const f = numericField({ ...spec, value: value ?? spec.value, onInput, onChange });
    return { element: f.element, get: f.get, set: f.set, setDisabled: f.setDisabled, destroy: f.destroy };
  });

  app.preferences?.registerSection(conventionsPreferences);

  const mark = { last: null };
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
