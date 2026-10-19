// Modal dialogs, prompts, confirmations, toasts and popover menus.
import { icon } from './icons.js';
import { describeAccelerator } from '../../shared/keymap.js';
import { isMac } from './bridge.js';

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

      if (opts.title) {
        const header = document.createElement('div');
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
      if (buttons.length) {
        const footer = document.createElement('div');
        footer.className = 'dialog-buttons';
        for (const b of buttons) {
          const btn = document.createElement('button');
          btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
          btn.textContent = b.label;
          btn.disabled = !!b.disabled;
          btn.dataset.value = String(b.value);
          btn.addEventListener('click', () => close(b.value, true));
          if (b.primary) primaryButton = btn;
          footer.appendChild(btn);
        }
        dialog.appendChild(footer);
      }

      backdrop.appendChild(dialog);
      this.root.appendChild(backdrop);
      const previousFocus = document.activeElement;
      const entry = { backdrop, close, opts };
      this.stack.push(entry);

      const onKey = (event) => {
        if (event.key === 'Escape' && opts.dismissible !== false) {
          event.preventDefault();
          event.stopPropagation();
          close(null);
        } else if (event.key === 'Enter' && primaryButton && !primaryButton.disabled && !['TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.closest('[data-no-enter]')) {
          if (document.activeElement?.tagName === 'BUTTON' && document.activeElement !== primaryButton) return;
          event.preventDefault();
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
      backdrop.addEventListener('keydown', onKey);
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop && opts.dismissible !== false) close(null);
      });

      let closed = false;
      async function close(value, fromButton = false) {
        if (closed) return;
        if (fromButton && opts.validate && value !== null) {
          const ok = await opts.validate(value, dialog);
          if (ok === false) return;
        }
        closed = true;
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

      requestAnimationFrame(() => {
        const auto = dialog.querySelector('[autofocus]');
        const target = auto ?? dialog.querySelector('input, textarea, select') ?? primaryButton ?? dialog.querySelector('button');
        target?.focus?.();
        if (target && target.select && (target.tagName === 'INPUT')) target.select();
      });
      opts.onOpen?.(dialog, close);
    });
  }

  closeAll() {
    for (const entry of [...this.stack]) entry.close(null);
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
  popover(anchor, items, { align = 'left', closeOnSelect = true } = {}) {
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
    const rect = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = align === 'right' ? rect.right - pw : rect.left;
    let top = rect.bottom + 4;
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
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    });
    this.activePopover = {
      element: pop,
      anchor,
      remove: () => {
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
