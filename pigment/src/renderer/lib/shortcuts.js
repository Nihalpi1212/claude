// Keyboard dispatch (see src/shared/keymap.js for the rules). Plain letters select tools; Shift +
// the same letter cycles through the tools sharing a toolbox slot; Space temporarily switches to
// the hand tool; the active tool gets first refusal on keys it handles itself (arrows, Backspace).
import { MENU_KEYS, RENDERER_KEYS, parseAccelerator, eventMatches } from '../../shared/keymap.js';
import { isMac } from './bridge.js';

const NATIVE_IN_TEXT = new Set(['edit:undo', 'edit:redo', 'edit:cut', 'edit:copy', 'edit:paste', 'edit:select-all', 'select:all', 'edit:clear', 'view:zoom-in', 'view:zoom-out']);

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
  // more modifiers first so Ctrl+Shift+Z wins over Ctrl+Z
  table.sort((a, b) => Number(b.desc.shift) + Number(b.desc.alt) + Number(b.desc.cmdOrCtrl) - (Number(a.desc.shift) + Number(a.desc.alt) + Number(a.desc.cmdOrCtrl)));

  const toolKeys = new Map(); // letter -> slot id
  for (const [cmd, accels] of Object.entries(RENDERER_KEYS)) {
    if (!cmd.startsWith('tool:')) continue;
    for (const a of accels) if (/^[a-z]$/.test(a)) toolKeys.set(a, cmd.slice(5));
  }

  let spaceTool = null;
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const inText = isTextInput(event.target);
    const inDialog = !!event.target.closest?.('.dialog-backdrop');
    // Space: temporary hand tool
    if (event.key === ' ' && !inText && !inDialog && app.view) {
      event.preventDefault();
      if (!event.repeat && !spaceTool) {
        spaceTool = true;
        app.view.spaceHeld = true;
        app.view.setCursor('grab');
      }
      return;
    }
    if (!inText && !inDialog && app.tools?.active?.onKeyDown?.(event)) {
      event.preventDefault();
      return;
    }
    // Shift+letter cycles the slot's tools
    if (!inText && !inDialog && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const slot = toolKeys.get(event.key.toLowerCase());
      if (slot && app.tools) {
        event.preventDefault();
        const s = app.tools.slots.find((x) => x.id === slot);
        if (s) {
          const current = s.tools.includes(app.tools.active?.id) ? app.tools.active.id : s.current;
          const next = s.tools[(s.tools.indexOf(current) + 1) % s.tools.length];
          app.tools.activate(next);
        }
        return;
      }
    }
    for (const entry of table) {
      if (!eventMatches(event, entry.desc, isMac)) continue;
      const { cmd, plain } = entry;
      if (inDialog && cmd !== 'app:escape') return;
      if (inText) {
        if (plain || NATIVE_IN_TEXT.has(cmd) || cmd === 'app:enter' || cmd === 'window:toggle-panels') return;
        // while typing, only file, window and view commands may run (Ctrl+I must not invert the image)
        if (!/^(file:|view:|help:|window:)/.test(cmd) && cmd !== 'app:escape') return;
        if (cmd === 'app:escape') {
          event.target.blur();
          event.preventDefault();
          return;
        }
      }
      if (plain && event.repeat && cmd !== 'tool:brush-size-up' && cmd !== 'tool:brush-size-down') return;
      if (plain && !app.doc && cmd.startsWith('tool:') && !['tool:swap-colors', 'tool:default-colors'].includes(cmd)) {
        // tools can still be chosen without a document
      }
      event.preventDefault();
      event.stopPropagation();
      if (cmd.startsWith('tool:') && !app.commands.has(cmd) && toolKeys.has(event.key.toLowerCase())) {
        app.tools.activateSlot(cmd.slice(5));
        return;
      }
      app.commands.run(cmd, undefined, 'key');
      return;
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === ' ' && spaceTool) {
      spaceTool = null;
      if (app.view) {
        app.view.spaceHeld = false;
        app.tools.updateCursor();
      }
    }
  });
  window.addEventListener('blur', () => {
    if (spaceTool && app.view) {
      spaceTool = null;
      app.view.spaceHeld = false;
      app.tools.updateCursor();
    }
  });
}
