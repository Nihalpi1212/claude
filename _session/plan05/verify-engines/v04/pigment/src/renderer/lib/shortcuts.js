// Keyboard dispatch (see src/shared/keymap.js for the rules). Plain letters select tools; Shift + the same letter
// cycles through the tools sharing a toolbox slot (or the letter itself, with "Use Shift Key for Tool Switch" off);
// the active tool gets first refusal on keys it handles itself (arrows, Backspace).
//
// 0.4 (conventions-shortcuts-fields): temporary tools (lib/temp-tools.js): Space pans, Ctrl+Space and Alt+Space zoom,
// Ctrl springs to the Move tool and Alt to the Eyedropper, a held tool key springs back on release. While a dialog is
// open the view navigation keys still work (zoom keys, Space to pan the canvas under the dialog), as in Photoshop.
import { MENU_KEYS, RENDERER_KEYS, parseAccelerator, eventMatches, TEXT_FIELD_EDIT_KEYS } from '../../shared/keymap.js';
import { isMac } from './bridge.js';
import { TempTools } from './temp-tools.js';
import { DIALOG_NAV } from './dialogs.js';

// the edit keys that go to a focused text field (shared with app.js's rule for the native menu's accelerators)
const NATIVE_IN_TEXT = TEXT_FIELD_EDIT_KEYS;

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'file', 'color'].includes(el.type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Where a typed space means a space (or presses a control) and must not pan: text entry, buttons, selects. */
function spaceIsOwnedBy(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return el.type !== 'number' && el.type !== 'range';
  return tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || el.isContentEditable || el.getAttribute?.('role') === 'button';
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

  const temp = new TempTools(app);
  app.tempTools = temp;
  const shiftSwitch = () => app.settings?.conventions?.toolSwitchWithShift !== false;

  let spaceTool = null; // 'pan' while Space pans (view.spaceHeld), 'zoom' while Ctrl/Alt+Space zooms
  const spaceDown = (dialogOpen) => {
    spaceTool = 'pan';
    app.view.spaceHeld = true;
    app.view.setCursor('grab');
    // under a dialog the canvas takes the drag (the backdrop lets the pointer through while Space is held)
    if (dialogOpen) app.dialogs?.setNavigationThrough?.(true);
  };
  const spaceUp = () => {
    const was = spaceTool;
    spaceTool = null;
    app.dialogs?.setNavigationThrough?.(false);
    if (was === 'zoom') temp.spaceUp();
    if (app.view && was === 'pan') {
      app.view.spaceHeld = false;
      if (temp.current) app.view.setCursor(temp.current.adapter.cursorStyle);
      else app.tools.updateCursor();
    }
  };

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const inText = isTextInput(event.target);
    const inDialog = !!app.dialogs?.isOpen || !!event.target.closest?.('.dialog-backdrop');
    if (event.key !== ' ') temp.otherKey(event);
    // Space: pan (Ctrl / Cmd + Space zooms in, Alt + Space zooms out), also on the canvas under a dialog
    if (event.key === ' ' && app.view && !(inDialog ? spaceIsOwnedBy(event.target) : inText)) {
      if (inDialog && app.dialogs?.allowsNavigation?.() === false) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (spaceTool === 'pan') {
          app.view.spaceHeld = false;
          spaceTool = null;
        }
        if (temp.zoomDown(event)) {
          spaceTool = 'zoom';
          if (inDialog) app.dialogs?.setNavigationThrough?.(true);
        }
        return;
      }
      if (!event.repeat && !spaceTool) spaceDown(inDialog);
      return;
    }
    // a modifier on its own: the temporary Move tool (Ctrl) or Eyedropper (Alt)
    if ((event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt') && !inText && !inDialog) {
      temp.modifierDown(event);
      return;
    }
    // a focused slider keeps its own arrow keys (the options bar's Bend slider, for example)
    if (event.target?.tagName === 'INPUT' && event.target.type === 'range' && /^(Arrow|Page|Home$|End$)/.test(event.key)) return;
    if (!inText && !inDialog && app.tools?.active?.onKeyDown?.(event)) {
      event.preventDefault();
      return;
    }
    // Shift+letter cycles the slot's tools
    if (!inText && !inDialog && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const slot = toolKeys.get(event.key.toLowerCase());
      if (slot && app.tools) {
        event.preventDefault();
        if (event.repeat) return;
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
      if (inDialog) {
        // the view under the dialog stays navigable: zoom keys pass, unless the focus is in a text entry
        if (DIALOG_NAV.test(cmd) && !(isTextInput(event.target) && event.target.type !== 'number' && event.target.dataset?.numericText === undefined) && app.dialogs?.allowsNavigation?.()) {
          event.preventDefault();
          event.stopPropagation();
          app.commands.run(cmd, undefined, 'key');
          return;
        }
        if (cmd !== 'app:escape') return;
      }
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
      if (plain && event.repeat && cmd !== 'tool:brush-size-up' && cmd !== 'tool:brush-size-down') {
        if (cmd.startsWith('tool:')) event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (plain && cmd.startsWith('tool:') && toolKeys.has(event.key.toLowerCase()) && app.tools) {
        // a plain letter picks the slot's current tool; it cycles only with "Use Shift Key for Tool Switch" off and
        // the slot's tool already active (Shift+letter always cycles)
        const slotId = toolKeys.get(event.key.toLowerCase());
        const slot = app.tools.slots.find((s) => s.id === slotId) ?? app.tools.slots.find((s) => s.tools.includes(slotId));
        if (slot) {
          const from = app.tools.active?.id ?? null;
          let target = slot.current ?? slot.tools[0];
          if (!shiftSwitch() && slot.tools.includes(from) && slot.tools.length > 1) target = slot.tools[(slot.tools.indexOf(from) + 1) % slot.tools.length];
          app.tools.activate(target);
          temp.toolKeyDown(event, from, app.tools.active?.id ?? null);
          return;
        }
      }
      app.commands.run(cmd, undefined, 'key');
      return;
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === ' ' && spaceTool) {
      spaceUp();
      return;
    }
    if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt') {
      temp.modifierUp(event);
      // Ctrl released before Space: the zoom ends with the Space
      return;
    }
    if (event.key.length === 1) temp.toolKeyUp(event);
  });
  window.addEventListener('blur', () => {
    if (spaceTool) spaceUp();
    temp.reset();
  });
}
