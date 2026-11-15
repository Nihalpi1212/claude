// Keyboard shortcuts in the renderer (see src/shared/keymap.js for the dispatch rules).
import { MENU_KEYS, RENDERER_KEYS, parseAccelerator, eventMatches } from '../../shared/keymap.js';
import { isMac } from './bridge.js';

const NATIVE_IN_TEXT = new Set(['edit:undo', 'edit:redo', 'edit:cut', 'edit:copy', 'edit:paste', 'edit:select-all', 'edit:delete', 'view:first-page', 'view:last-page', 'view:next-page', 'view:prev-page', 'view:back', 'view:forward', 'view:zoom-in', 'view:zoom-out']);
const NAV_WHEN_EDITOR_SELECTED = new Set(['view:first-page', 'view:last-page', 'view:next-page', 'view:prev-page', 'view:back', 'view:forward', 'edit:delete']);

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'file', 'color'].includes(el.type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function install(app) {
  const table = [];
  for (const [cmd, accel] of Object.entries(MENU_KEYS)) table.push({ cmd, desc: parseAccelerator(accel), plain: false });
  for (const [cmd, accels] of Object.entries(RENDERER_KEYS)) {
    for (const accel of accels) {
      const desc = parseAccelerator(accel);
      const plain = !desc.ctrl && !desc.meta && !desc.cmdOrCtrl && !desc.alt && !desc.shift;
      table.push({ cmd, desc, plain });
    }
  }
  // longer modifier combos first so Ctrl+Shift+Z wins over Ctrl+Z
  table.sort((a, b) => Number(b.desc.shift) + Number(b.desc.alt) - (Number(a.desc.shift) + Number(a.desc.alt)));

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const inText = isTextInput(event.target);
    const inDialog = !!event.target.closest?.('.dialog-backdrop');
    const view = app.view;
    const editorBusy = !!view?.uiManager && (view.uiManager.isEditorHandlingKeyboard || view.uiManager.hasSelection);
    for (const entry of table) {
      if (!eventMatches(event, entry.desc, isMac)) continue;
      const { cmd, plain } = entry;
      if (inDialog && cmd !== 'app:escape') return;
      if (inText) {
        if (plain || NATIVE_IN_TEXT.has(cmd)) return;
        if (cmd === 'app:escape') {
          event.target.blur();
          event.preventDefault();
          return;
        }
      }
      if (editorBusy && (NAV_WHEN_EDITOR_SELECTED.has(cmd) || plain)) {
        if (cmd === 'app:escape') break;
        return; // pdf.js moves/deletes the selected editor itself
      }
      if (plain && event.repeat) return;
      // "n"/"p"/"j"/"k" style letters only apply when the viewer has focus (not when typing in forms)
      if (plain && !app.session && !['app:escape'].includes(cmd)) return;
      event.preventDefault();
      event.stopPropagation();
      app.commands.run(cmd, undefined, 'key');
      return;
    }
    // Space / Shift+Space page through the document when the viewer is focused.
    if (event.key === ' ' && !inText && view && !editorBusy && !inDialog) {
      const c = view.container;
      if (c.contains(event.target) || event.target === document.body) {
        event.preventDefault();
        const delta = event.shiftKey ? -c.clientHeight * 0.9 : c.clientHeight * 0.9;
        if (view.scrollMode === 3) app.commands.run(event.shiftKey ? 'view:prev-page' : 'view:next-page', undefined, 'key');
        else c.scrollBy({ top: delta, behavior: 'auto' });
      }
    }
  });
}
