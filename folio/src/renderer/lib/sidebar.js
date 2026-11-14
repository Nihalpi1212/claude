// Sidebar frame: panel registry, tab strip, open/close state, resizing.
import { icon } from './icons.js';

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('sidebar');
    this.tabs = document.getElementById('sidebar-tabs');
    this.panels = document.getElementById('sidebar-panels');
    this.resizer = document.getElementById('sidebar-resizer');
    this.registry = new Map();
    this.current = null;
    this.#setupResizer();
    app.on('tab:activated', () => this.#refreshCurrent());
    app.on('doc:loaded', () => this.#refreshCurrent());
    app.on('doc:reloaded', () => this.#refreshCurrent());
  }

  /**
   * @param {{ id: string, title: string, icon: string, element: HTMLElement, onShow?: (session) => void, onHide?: () => void, order?: number }} panel
   */
  registerPanel(panel) {
    panel.element.classList.add('sidebar-panel');
    panel.element.hidden = true;
    panel.element.id = `panel-${panel.id}`;
    panel.element.setAttribute('role', 'tabpanel');
    this.panels.appendChild(panel.element);
    const tab = document.createElement('button');
    tab.className = 'sidebar-tab';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', panel.element.id);
    tab.title = panel.title;
    tab.dataset.panel = panel.id;
    tab.innerHTML = icon(panel.icon);
    tab.addEventListener('click', () => this.show(panel.id));
    const entries = [...this.registry.values()];
    const after = entries.find((e) => (e.panel.order ?? 0) > (panel.order ?? 0));
    if (after) this.tabs.insertBefore(tab, after.tab);
    else this.tabs.appendChild(tab);
    this.registry.set(panel.id, { panel, tab });
    if (!this.current && this.app.settings.sidebarView === panel.id) this.current = panel.id;
  }

  isOpen() {
    return !this.root.hidden;
  }

  show(id, { open = true } = {}) {
    const entry = this.registry.get(id);
    if (!entry) return;
    if (this.current && this.current !== id) {
      const prev = this.registry.get(this.current);
      if (prev) {
        prev.panel.element.hidden = true;
        prev.tab.setAttribute('aria-selected', 'false');
        prev.panel.onHide?.();
      }
    }
    this.current = id;
    entry.panel.element.hidden = false;
    entry.tab.setAttribute('aria-selected', 'true');
    if (open) this.root.hidden = false;
    entry.panel.onShow?.(this.app.session);
    this.app.saveSettings({ sidebarView: id, sidebarOpen: !this.root.hidden });
    this.app.emit('sidebar:changed', { open: !this.root.hidden, view: id });
    this.app.commands.invalidate();
  }

  toggle(force) {
    const open = force ?? this.root.hidden;
    if (open) {
      const id = this.current ?? this.registry.keys().next().value;
      if (id) this.show(id);
    } else {
      this.root.hidden = true;
      this.app.saveSettings({ sidebarOpen: false });
      this.app.emit('sidebar:changed', { open: false, view: this.current });
      this.app.commands.invalidate();
    }
  }

  #refreshCurrent() {
    if (!this.isOpen() || !this.current) return;
    this.registry.get(this.current)?.panel.onShow?.(this.app.session);
  }

  #setupResizer() {
    let startX = 0;
    let startWidth = 0;
    const onMove = (event) => {
      const width = Math.min(window.innerWidth * 0.6, Math.max(180, startWidth + event.clientX - startX));
      this.root.style.width = `${width}px`;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      this.app.emit('layout:changed');
    };
    this.resizer.addEventListener('pointerdown', (event) => {
      startX = event.clientX;
      startWidth = this.root.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      event.preventDefault();
    });
  }
}
