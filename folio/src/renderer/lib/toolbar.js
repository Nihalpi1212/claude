// Main toolbar: buttons bound to commands, custom controls, and the contextual secondary bar.
import { icon } from './icons.js';
import { MENU_KEYS, RENDERER_KEYS, describeAccelerator } from '../../shared/keymap.js';
import { isMac } from './bridge.js';

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('toolbar');
    this.secondary = document.getElementById('toolbar-secondary');
    this.buttons = new Map();
    app.on('commands:changed', () => this.update());
  }

  group(name) {
    let el = this.root.querySelector(`.toolbar-group[data-group="${name}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'toolbar-group';
      el.dataset.group = name;
      this.root.appendChild(el);
    }
    return el;
  }

  /**
   * @param {object} def
   * @param {string} def.id
   * @param {string} def.group        file | nav | zoom | tools | view | right
   * @param {string} def.icon
   * @param {string} def.title        tooltip (shortcut appended automatically when the command has one)
   * @param {string} [def.command]    command run on click
   * @param {any} [def.arg]
   * @param {string} [def.label]      visible text next to the icon
   * @param {boolean} [def.toggle]    aria-pressed follows command.checked()
   * @param {() => any[]} [def.menu]  popover items shown on click instead of running the command
   * @param {() => boolean} [def.enabled]
   * @param {() => boolean} [def.pressed]
   */
  addButton(def) {
    const btn = document.createElement('button');
    btn.className = 'tb-button';
    btn.id = `tb-${def.id}`;
    btn.type = 'button';
    btn.innerHTML = icon(def.icon);
    if (def.label) {
      const span = document.createElement('span');
      span.className = 'tb-label';
      span.textContent = def.label;
      btn.appendChild(span);
    }
    if (def.menu) btn.classList.add('has-menu');
    const accel = def.command ? MENU_KEYS[def.command] ?? RENDERER_KEYS[def.command]?.[0] : null;
    btn.title = accel ? `${def.title} (${describeAccelerator(accel, isMac)})` : def.title;
    btn.setAttribute('aria-label', def.title);
    if (def.toggle || def.pressed) btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      if (def.menu) {
        this.app.dialogs.popover(btn, def.menu(), { align: def.group === 'right' || def.group === 'view' ? 'right' : 'left' });
        return;
      }
      if (def.command) this.app.commands.run(def.command, def.arg, 'toolbar');
      def.onClick?.(event);
    });
    this.group(def.group).appendChild(btn);
    this.buttons.set(def.id, { el: btn, def });
    this.updateButton(btn, def);
    return btn;
  }

  addElement(group, element) {
    this.group(group).appendChild(element);
    return element;
  }

  addSeparator(group) {
    const sep = document.createElement('span');
    sep.className = 'tb-separator';
    this.group(group).appendChild(sep);
  }

  updateButton(btn, def) {
    const { commands } = this.app;
    let enabled = true;
    if (def.enabled) enabled = !!def.enabled();
    else if (def.command) enabled = commands.isEnabled(def.command);
    btn.disabled = !enabled;
    if (def.pressed) btn.setAttribute('aria-pressed', String(!!def.pressed()));
    else if (def.toggle && def.command) btn.setAttribute('aria-pressed', String(commands.isChecked(def.command)));
    if (def.iconFn) btn.querySelector('svg')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: icon(def.iconFn()) }).content.firstElementChild);
    if (def.render) def.render(btn);
  }

  update() {
    for (const { el, def } of this.buttons.values()) this.updateButton(el, def);
    for (const fn of this.updaters ?? []) fn();
  }

  /** Registers an extra updater called on every commands:changed (for custom controls). */
  onUpdate(fn) {
    (this.updaters ||= []).push(fn);
  }

  /** Shows a contextual bar below the toolbar (e.g. annotation tool options). Pass null to hide. */
  setSecondary(element) {
    this.secondary.replaceChildren();
    if (element) {
      this.secondary.appendChild(element);
      this.secondary.hidden = false;
    } else {
      this.secondary.hidden = true;
    }
    this.app.emit('layout:changed');
  }
}
