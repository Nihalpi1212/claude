// Adjustments panel (middle group): one button per adjustment-layer kind; each adds a new adjustment
// layer above the active layer (limited to the selection, if any) and opens it in Properties.
import { icon } from '../icons.js';
import { LAYER_KINDS, ADJUSTMENT_ICONS } from '../adjust-ui.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';

export function install(app) {
  const el = document.createElement('div');
  el.className = 'adjustments-panel';
  const intro = document.createElement('div');
  intro.className = 'panel-hint muted';
  intro.textContent = 'Add an adjustment layer (non-destructive)';
  const grid = document.createElement('div');
  grid.className = 'adjust-grid';
  for (const kind of LAYER_KINDS) {
    const name = app.adjustments?.[kind]?.name ?? ADJUSTMENTS[kind]?.name ?? kind;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.kind = kind;
    b.title = `New ${name} adjustment layer`;
    b.innerHTML = `${icon(ADJUSTMENT_ICONS[kind] ?? 'adjust')}<span>${name}</span>`;
    b.addEventListener('click', () => app.commands.run('layer:new-adjustment', kind, 'panel'));
    grid.appendChild(b);
  }
  const fills = document.createElement('div');
  fills.className = 'panel-hint muted';
  fills.textContent = 'Fill layers';
  const fillGrid = document.createElement('div');
  fillGrid.className = 'adjust-grid';
  for (const [kind, label, ic] of [['solid', 'Solid Color', 'fill'], ['gradient', 'Gradient', 'gradient'], ['pattern', 'Pattern', 'pattern-stamp']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.fill = kind;
    b.title = `New ${label} fill layer`;
    b.innerHTML = `${icon(ic)}<span>${label}</span>`;
    b.addEventListener('click', () => app.commands.run('layer:new-fill', kind, 'panel'));
    fillGrid.appendChild(b);
  }
  el.append(intro, grid, fills, fillGrid);

  const update = () => {
    const enabled = !!app.doc;
    for (const b of el.querySelectorAll('button')) b.disabled = !enabled;
  };
  app.on('doc:activated', update);
  app.panels.register({ id: 'adjustments', title: 'Adjustments', icon: 'adjust', element: el, group: 'middle', onShow: update });
  update();
}
