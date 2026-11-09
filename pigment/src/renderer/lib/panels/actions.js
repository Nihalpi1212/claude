// STUB (0.3): Actions panel placeholder so Window > Actions exists; the builder replaces it with the real
// panel (sets, actions, steps, record/stop/play, button mode). Keeps id 'actions', group 'bottom', icon 'play'.
export function install(app) {
  const el = document.createElement('div');
  el.className = 'actions-panel';
  const hint = document.createElement('div');
  hint.className = 'panel-hint muted';
  hint.textContent = 'Actions (record and replay command sequences) arrive later in this release.';
  el.appendChild(hint);
  app.panels.register({ id: 'actions', title: 'Actions', icon: 'play', element: el, group: 'bottom' });
}
