// Modal dialogs, prompts, confirmations, toasts and popover menus.
//
// 0.4 (conventions-shortcuts-fields, ARCHITECTURE.md "0.4 features", package 16; I.3, E15): dialogs follow Photoshop's
// conventions. A dialog with a title moves by its header and opens where it was last left
// (settings.conventions.dialogPositions, by `positionKey` or title; a double-click on the header centres it again).
// While a document is open the canvas stays visible under the dialog and navigable: the wheel over it zooms or scrolls
// the view, Space-drag pans it, the zoom keys work (passesMenu lets the native menu's view commands through), and a
// click beside the dialog no longer cancels it. Holding Alt turns Cancel into Reset in a dialog that has `onReset`.
import { icon } from './icons.js';
import { describeAccelerator } from '../../shared/keymap.js';
import { isMac } from './bridge.js';
import { noteSelectAll, commitActiveNumeric } from './numeric-field.js';

/** View navigation that works while a dialog is open (shortcuts.js and the native menu, E step 3). */
export const DIALOG_NAV = /^view:(zoom-in|zoom-out|zoom-fit|zoom-fill|zoom-100|zoom-200)$/;

export class Dialogs {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('dialogs');
    this.toastRoot = document.getElementById('toasts');
    this.stack = [];
  }

  get isOpen() {
    return this.stack.length > 0;
  }

  /**
   * Opens a modal. Resolves with the value of the pressed button (or null when dismissed).
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {HTMLElement|string} [opts.content]
   * @param {{label:string, value?:any, primary?:boolean, danger?:boolean, disabled?:boolean}[]} [opts.buttons]
   * @param {number} [opts.width]
   * @param {boolean} [opts.dismissible]   Escape/backdrop closes (default true)
   * @param {(dialog: HTMLElement, close: (value:any)=>void) => void} [opts.onOpen]
   * @param {(value:any) => boolean|Promise<boolean>} [opts.validate]  return false to keep the dialog open
   * @param {() => void} [opts.onReset]  Alt turns Cancel into Reset: a click on it then calls onReset and keeps the dialog
   * @param {string} [opts.positionKey]  where a moved dialog is remembered (default: its title)
   * @param {boolean} [opts.navigation]  false: the canvas under it is not navigable (default: true)
   */
  open(opts = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'dialog-backdrop';
      const dialog = document.createElement('div');
      dialog.className = 'dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      if (opts.width) dialog.style.width = `${opts.width}px`;
      if (opts.className) dialog.classList.add(...String(opts.className).split(/\s+/).filter(Boolean));

      let header = null;
      if (opts.title) {
        header = document.createElement('div');
        header.className = 'dialog-header';
        const h = document.createElement('h2');
        h.textContent = opts.title;
        header.appendChild(h);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'dialog-close';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = icon('close');
        closeBtn.addEventListener('click', () => close(null));
        header.appendChild(closeBtn);
        dialog.appendChild(header);
      }
      const body = document.createElement('div');
      body.className = 'dialog-body';
      if (typeof opts.content === 'string') body.innerHTML = opts.content;
      else if (opts.content) body.appendChild(opts.content);
      dialog.appendChild(body);

      const buttons = opts.buttons ?? [{ label: 'OK', value: true, primary: true }];
      let primaryButton = null;
      let cancelButton = null; // the button Alt turns into Reset (the first non-primary button whose value is null)
      const cancelSpec = opts.onReset ? buttons.find((b) => b.value === null && !b.primary) : null;
      if (buttons.length) {
        const footer = document.createElement('div');
        footer.className = 'dialog-buttons';
        for (const b of buttons) {
          const btn = document.createElement('button');
          btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
          btn.textContent = b.label;
          btn.disabled = !!b.disabled;
          btn.dataset.value = String(b.value);
          btn.addEventListener('click', (event) => {
            if (b === cancelSpec && (event.altKey || btn.classList.contains('as-reset'))) {
              event.preventDefault();
              try {
                opts.onReset();
              } catch (err) {
                console.error(err);
              }
              return;
            }
            close(b.value, true);
          });
          if (b.primary) primaryButton = btn;
          if (b === cancelSpec) cancelButton = btn;
          footer.appendChild(btn);
        }
        dialog.appendChild(footer);
      }

      backdrop.appendChild(dialog);
      // the canvas stays visible under a dialog over a document (no dimming), as in Photoshop
      if (this.app?.doc && opts.navigation !== false) backdrop.classList.add('over-canvas');
      this.root.appendChild(backdrop);
      const previousFocus = document.activeElement;
      const entry = { backdrop, close, opts, dialog };
      this.stack.push(entry);
      if (this.navThrough) backdrop.classList.add('nav-through');
      const positionKey = opts.positionKey ?? opts.title ?? null;
      if (header && positionKey) this.#makeMovable(entry, header, positionKey);

      // Alt shows Reset in place of Cancel while it is held
      const altLabel = cancelButton?.textContent;
      const showReset = (on) => {
        if (!cancelButton) return;
        cancelButton.textContent = on ? 'Reset' : altLabel;
        cancelButton.classList.toggle('as-reset', on);
      };
      const onAlt = (event) => {
        if (!cancelButton || event.key !== 'Alt' || this.stack[this.stack.length - 1] !== entry) return;
        showReset(event.type === 'keydown');
      };
      const onBlur = () => showReset(false);
      if (cancelButton) {
        document.addEventListener('keydown', onAlt, true);
        document.addEventListener('keyup', onAlt, true);
        window.addEventListener('blur', onBlur);
      }
      // the wheel over the canvas beside the dialog zooms or scrolls the view
      backdrop.addEventListener('wheel', (event) => {
        if (dialog.contains(event.target) || !backdrop.classList.contains('over-canvas')) return;
        const canvas = this.app?.view?.canvas;
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
        event.preventDefault();
        canvas.dispatchEvent(new WheelEvent('wheel', {
          deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
          clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
          ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
          bubbles: true, cancelable: true,
        }));
      }, { passive: false });

      const onKey = (event) => {
        if (event.key === 'Escape' && opts.dismissible !== false) {
          event.preventDefault();
          event.stopPropagation();
          close(null);
        } else if (event.key === 'Enter' && primaryButton && !primaryButton.disabled && !['TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.closest('[data-no-enter]')) {
          if (document.activeElement?.tagName === 'BUTTON' && document.activeElement !== primaryButton) return;
          event.preventDefault();
          // a typed expression in a numeric field (100+50) is evaluated before OK reads the values
          commitActiveNumeric();
          primaryButton.click();
        } else if (event.key === 'Tab') {
          const focusables = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      };
      // keys are trapped at the document level: a click on a non-focusable part of the dialog (a canvas, a
      // list entry) moves focus to the body, and Escape/Enter must keep working while no shortcut may run
      dialog.tabIndex = -1;
      const onDocKey = (event) => {
        if (this.stack[this.stack.length - 1] !== entry) return;
        onKey(event);
      };
      document.addEventListener('keydown', onDocKey, true);
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop && opts.dismissible !== false) {
          // over a document the click lands beside the dialog, on the canvas the user is looking at: Photoshop keeps
          // the dialog (it flashes); without a document 0.3's click-outside-cancels stays
          if (backdrop.classList.contains('over-canvas')) {
            event.preventDefault();
            dialog.classList.remove('attention');
            void dialog.offsetWidth;
            dialog.classList.add('attention');
            return;
          }
          return close(null);
        }
        if (!event.target.closest?.('input, select, textarea, button, a[href], [contenteditable], [tabindex]')) {
          requestAnimationFrame(() => {
            if (!closed && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
          });
        }
      });

      let closed = false;
      async function close(value, fromButton = false) {
        if (closed) return;
        if (fromButton && opts.validate && value !== null) {
          const ok = await opts.validate(value, dialog);
          if (ok === false) return;
        }
        closed = true;
        document.removeEventListener('keydown', onDocKey, true);
        document.removeEventListener('keydown', onAlt, true);
        document.removeEventListener('keyup', onAlt, true);
        window.removeEventListener('blur', onBlur);
        entry.through?.();
        entry.through = null;
        backdrop.remove();
        const i = entry.dialogs?.stack.indexOf(entry);
        if (entry.dialogs) entry.dialogs.stack.splice(i, 1);
        try {
          previousFocus?.focus?.();
        } catch {
          /* ignore */
        }
        resolve(value);
      }
      entry.dialogs = this;

      let proposed; // the text the autofocus field proposes (read after onOpen, which may fill it in)
      requestAnimationFrame(() => {
        // a field that was reached before this frame (a quick click, a script) keeps the focus: moving it now
        // would send the typing that follows into the first field
        if (closed) return;
        const auto = dialog.querySelector('[autofocus]');
        const target = auto ?? dialog.querySelector('input, textarea, select') ?? primaryButton ?? dialog.querySelector('button');
        const active = document.activeElement;
        if (dialog.contains(active) && active !== dialog) {
          // ...but the browser itself focuses the first [autofocus] field it sees: that is the dialog's own
          // target, whose proposed text is still selected so that typing replaces it (unless typing began already)
          if (active === target && target.tagName === 'INPUT' && target.value === proposed) {
            target.select();
            noteSelectAll(target);
          }
          return;
        }
        target?.focus?.();
        if (target && target.select && (target.tagName === 'INPUT')) {
          target.select();
          noteSelectAll(target);
        }
      });
      opts.onOpen?.(dialog, close);
      proposed = dialog.querySelector('[autofocus]')?.value;
    });
  }

  /**
   * Lets the canvas under an open dialog take pointer input (I.3): the backdrop stops catching pointer events, and a
   * swallowing canvas-capture handler keeps canvas clicks that no armed handler takes away from the active tool.
   * Off: the backdrop catches again (a click on it is Cancel, as in 0.3). The dialog's close turns it off.
   */
  setCanvasThrough(dialogEl, on) {
    const entry = this.stack.find((e) => e.backdrop.contains(dialogEl));
    if (!entry) return;
    const dialog = entry.backdrop.querySelector('.dialog');
    if (on) {
      if (entry.through) return;
      entry.backdrop.classList.add('canvas-through');
      entry.backdrop.style.pointerEvents = 'none';
      if (dialog) dialog.style.pointerEvents = 'auto';
      entry.through = this.app.canvasCapture?.push({ id: 'dialog-through', cursor: 'default', down() {} }) ?? (() => {});
    } else {
      if (!entry.through) return;
      entry.through();
      entry.through = null;
      entry.backdrop.classList.remove('canvas-through');
      entry.backdrop.style.pointerEvents = '';
      if (dialog) dialog.style.pointerEvents = '';
    }
  }

  /**
   * Whether a native menu command ('menu' / 'menu-key') runs while a dialog is open (commands.js, E step 3): the view
   * navigation commands do, so the canvas under a dialog zooms with the menu's keys on macOS as on Windows and Linux.
   */
  passesMenu(id) {
    return DIALOG_NAV.test(id) && this.allowsNavigation();
  }

  /** True while the canvas under the open dialogs may be navigated (a document is open, no dialog refuses it). */
  allowsNavigation() {
    if (!this.app?.view || !this.app?.doc) return false;
    return !this.stack.some((e) => e.opts?.navigation === false);
  }

  /**
   * While Space is held under a dialog the backdrop lets the pointer through, so a drag on the canvas pans it
   * (shortcuts.js). The dialog itself keeps taking the pointer.
   */
  setNavigationThrough(on) {
    this.navThrough = !!on && this.allowsNavigation();
    for (const e of this.stack) e.backdrop.classList.toggle('nav-through', this.navThrough);
  }

  /** Where a dialog was last moved to (settings.conventions.dialogPositions). */
  savedPosition(key) {
    const p = this.app?.settings?.conventions?.dialogPositions?.[key];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  }

  savePosition(key, pos) {
    const app = this.app;
    if (!app?.settings) return;
    const conv = app.settings.conventions ?? {};
    const positions = { ...(conv.dialogPositions ?? {}) };
    if (pos) positions[key] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    else delete positions[key];
    app.saveSettingsSoon?.({ conventions: { ...conv, dialogPositions: positions } });
  }

  /** The header drags the dialog; a double-click on it puts the dialog back in the middle. */
  #makeMovable(entry, header, key) {
    const { dialog } = entry;
    header.classList.add('movable');
    const place = (x, y) => {
      const w = dialog.offsetWidth;
      const h = header.offsetHeight || 32;
      const nx = Math.max(Math.min(x, window.innerWidth - 80), 80 - w);
      const ny = Math.max(0, Math.min(y, window.innerHeight - h));
      dialog.classList.add('moved');
      dialog.style.left = `${nx}px`;
      dialog.style.top = `${ny}px`;
      return { x: nx, y: ny };
    };
    const saved = this.savedPosition(key);
    if (saved) place(saved.x, saved.y);
    let drag = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) return;
      const r = dialog.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId, moved: false, pos: null };
      header.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.moved = true;
      drag.pos = place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (d.moved && d.pos) this.savePosition(key, d.pos);
    };
    header.addEventListener('pointerup', up);
    header.addEventListener('pointercancel', up);
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      dialog.classList.remove('moved');
      dialog.style.left = '';
      dialog.style.top = '';
      this.savePosition(key, null);
    });
  }

  /**
   * Dismisses open dialogs as Escape would; with `which`, only those whose open() options it accepts. Returns how
   * many it closed.
   */
  closeAll(which = null) {
    const entries = this.stack.filter((entry) => !which || which(entry.opts));
    for (const entry of entries) entry.close(null);
    return entries.length;
  }

  alert(message, { title = 'Pigment', detail } = {}) {
    const content = document.createElement('div');
    const p = document.createElement('p');
    p.className = 'dialog-message';
    p.textContent = message;
    content.appendChild(p);
    if (detail) {
      const d = document.createElement('p');
      d.className = 'muted';
      d.style.userSelect = 'text';
      d.textContent = detail;
      content.appendChild(d);
    }
    return this.open({ title, content, buttons: [{ label: 'OK', value: true, primary: true }] });
  }

  async confirm(message, { title = 'Pigment', detail, okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
    const content = document.createElement('div');
    const p = document.createElement('p');
    p.className = 'dialog-message';
    p.textContent = message;
    content.appendChild(p);
    if (detail) {
      const d = document.createElement('p');
      d.className = 'muted';
      d.textContent = detail;
      content.appendChild(d);
    }
    const result = await this.open({ title, content, buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: true, danger }] });
    return result === true;
  }

  /** Text prompt. Resolves to the string or null. */
  prompt(message, { title = 'Pigment', value = '', placeholder = '', type = 'text', okLabel = 'OK', multiline = false, min, max } = {}) {
    const content = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.textContent = message;
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.className = multiline ? 'textarea' : 'input';
    if (!multiline) input.type = type;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.placeholder = placeholder;
    input.value = value;
    label.append(span, input);
    content.appendChild(label);
    return this.open({ title, content, buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: true, primary: true }] }).then((result) => (result ? input.value : null));
  }

  /**
   * Shows a toast. kind: 'info' | 'success' | 'error'. Returns a function that removes it.
   */
  toast(message, { kind = 'info', timeout = 4000, action } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        remove();
        action.run();
      });
      el.appendChild(btn);
    }
    this.toastRoot.appendChild(el);
    let timer = timeout > 0 ? setTimeout(() => remove(), timeout) : null;
    function remove() {
      clearTimeout(timer);
      el.remove();
    }
    el.addEventListener('click', (event) => {
      if (event.target === el || event.target === text) remove();
    });
    return remove;
  }

  /**
   * Popover menu anchored to an element.
   * items: { label, icon?, shortcut?(accelerator), checked?, disabled?, onSelect?, type?: 'separator'|'title'|'custom', element?, keepOpen? }
   */
  popover(anchor, items, { align = 'left', closeOnSelect = true, at = null, side = 'bottom' } = {}) {
    this.closePopover();
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.setAttribute('role', 'menu');
    for (const item of items) {
      if (!item) continue;
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'popover-separator';
        pop.appendChild(sep);
        continue;
      }
      if (item.type === 'title') {
        const t = document.createElement('div');
        t.className = 'popover-title';
        t.textContent = item.label;
        pop.appendChild(t);
        continue;
      }
      if (item.type === 'custom') {
        pop.appendChild(item.element);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'popover-item';
      btn.setAttribute('role', item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
      if (item.checked !== undefined) btn.setAttribute('aria-checked', String(!!item.checked));
      btn.disabled = !!item.disabled;
      const check = document.createElement('span');
      check.className = 'popover-check';
      if (item.checked) check.innerHTML = icon('check');
      else if (item.icon) check.innerHTML = icon(item.icon);
      btn.appendChild(check);
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'popover-shortcut';
        sc.textContent = describeAccelerator(item.shortcut, isMac);
        btn.appendChild(sc);
      }
      btn.addEventListener('click', () => {
        if (closeOnSelect && !item.keepOpen) this.closePopover();
        item.onSelect?.();
      });
      pop.appendChild(btn);
    }
    document.body.appendChild(pop);
    const rect = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = align === 'right' ? rect.right - pw : rect.left;
    let top = rect.bottom + 4;
    if (side === 'right') {
      left = rect.right + 4;
      top = rect.top;
    }
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    const onDown = (event) => {
      if (!pop.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) this.closePopover();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        this.closePopover();
        anchor.focus?.();
      }
    };
    // registered after the opening click has finished; cancelled if the popover closes before that
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    });
    this.activePopover = {
      element: pop,
      anchor,
      remove: () => {
        clearTimeout(timer);
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        pop.remove();
        anchor.removeAttribute('aria-expanded');
      },
    };
    anchor.setAttribute('aria-expanded', 'true');
    pop.querySelector('button:not(:disabled)')?.focus();
    return pop;
  }

  closePopover() {
    this.activePopover?.remove();
    this.activePopover = null;
  }
}
