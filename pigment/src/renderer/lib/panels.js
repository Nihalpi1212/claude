// Right-hand panel dock: three tabbed groups (top, middle, bottom). Panels register themselves;
// which tab is shown in each group and whether a group is collapsed is kept in settings.panelLayout.
import { icon } from './icons.js';

const GROUPS = ['top', 'middle', 'bottom'];

export class PanelDock {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('panels');
    this.dock = document.getElementById('panels-dock');
    this.resizer = document.getElementById('panels-resizer');
    this.panels = new Map();
    this.groups = new Map();
    for (const g of GROUPS) {
      const el = document.createElement('section');
      el.className = 'panel-group';
      el.dataset.group = g;
      el.innerHTML = `<div class="panel-tabs" role="tablist"></div><div class="panel-body"></div>`;
      const tabs = el.querySelector('.panel-tabs');
      const spacer = document.createElement('span');
      spacer.className = 'panel-tab-spacer';
      const collapse = document.createElement('button');
      collapse.className = 'panel-collapse';
      collapse.title = 'Collapse';
      collapse.innerHTML = icon('chevron-down');
      collapse.addEventListener('click', () => this.setCollapsed(g, !el.classList.contains('collapsed')));
      tabs.append(spacer, collapse);
      this.dock.appendChild(el);
      this.groups.set(g, { el, tabs, body: el.querySelector('.panel-body'), spacer, current: null });
    }
    this.layout = { ...(app.settings.panelLayout ?? {}) };
    this.#setupResizer();
    if (this.layout.width) this.root.style.width = `${this.layout.width}px`;
  }

  /**
   * @param {{ id: string, title: string, icon?: string, element: HTMLElement, group: 'top'|'middle'|'bottom', onShow?: () => void, order?: number }} panel
   */
  register(panel) {
    const group = this.groups.get(panel.group) ?? this.groups.get('middle');
    panel.element.classList.add('panel');
    panel.element.dataset.panel = panel.id;
    panel.element.hidden = true;
    group.body.appendChild(panel.element);
    const tab = document.createElement('button');
    tab.className = 'panel-tab';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.panel = panel.id;
    tab.innerHTML = `${panel.icon ? icon(panel.icon) : ''}<span>${panel.title}</span>`;
    tab.addEventListener('click', () => this.show(panel.id, { reveal: true }));
    group.tabs.insertBefore(tab, group.spacer);
    this.panels.set(panel.id, { panel, tab, group });
    const preferred = this.layout[`${panel.group}:current`];
    if (!group.current || preferred === panel.id) this.show(panel.id, { save: false });
    if (this.layout[`${panel.group}:collapsed`]) this.setCollapsed(panel.group, true, { save: false });
    this.app.commands.register(`window:panel-${panel.id}`, { run: () => this.show(panel.id, { reveal: true }), checked: () => this.isVisible(panel.id), label: panel.title });
  }

  /** Re-renders the panels that became visible again (they skip rendering while hidden). */
  refreshVisible() {
    for (const g of this.groups.values()) if (g.current && !g.el.classList.contains('collapsed')) this.panels.get(g.current)?.panel.onShow?.();
  }

  isVisible(id) {
    const e = this.panels.get(id);
    return !!e && e.group.current === id && !e.group.el.classList.contains('collapsed') && !this.root.hidden && !document.getElementById('app')?.classList.contains('panels-hidden');
  }

  show(id, { save = true, reveal = false } = {}) {
    const entry = this.panels.get(id);
    if (!entry) return;
    const g = entry.group;
    if (g.current && g.current !== id) {
      const prev = this.panels.get(g.current);
      prev.panel.element.hidden = true;
      prev.tab.setAttribute('aria-selected', 'false');
    }
    g.current = id;
    entry.panel.element.hidden = false;
    entry.tab.setAttribute('aria-selected', 'true');
    if (reveal) {
      this.root.hidden = false;
      document.getElementById('app').classList.remove('panels-hidden');
      this.setCollapsed(entry.panel.group, false, { save });
    }
    entry.panel.onShow?.();
    if (save) {
      this.layout[`${entry.panel.group}:current`] = id;
      this.persist();
    }
    this.app.commands.invalidate();
  }

  setCollapsed(group, collapsed, { save = true } = {}) {
    const g = this.groups.get(group);
    if (!g) return;
    g.el.classList.toggle('collapsed', collapsed);
    if (save) {
      this.layout[`${group}:collapsed`] = collapsed;
      this.persist();
    }
    if (!collapsed && g.current) this.panels.get(g.current)?.panel.onShow?.();
  }

  persist() {
    this.app.saveSettingsSoon({ panelLayout: { ...this.layout } });
  }

  reset() {
    this.layout = {};
    this.root.style.width = '';
    for (const g of GROUPS) this.setCollapsed(g, false, { save: false });
    this.persist();
  }

  #setupResizer() {
    let startX = 0, startW = 0;
    const move = (e) => {
      const w = Math.min(window.innerWidth * 0.6, Math.max(220, startW - (e.clientX - startX)));
      this.root.style.width = `${w}px`;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      this.layout.width = this.root.getBoundingClientRect().width;
      this.persist();
      this.app.view?.resize();
    };
    this.resizer.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startW = this.root.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
}

/** Small helper to build a panel element with toolbar/body/footer. */
export function panelElement(className = '') {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
