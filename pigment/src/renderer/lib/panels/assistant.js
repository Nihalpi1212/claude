// Assistant panel placeholder (replaced by the AI assistant module).
export function install(app) {
  const el = document.createElement('div');
  el.className = 'assistant-panel';
  el.innerHTML = '<div class="panel-empty">The AI assistant is not available in this build.</div>';
  app.panels.register({ id: 'assistant', title: 'Assistant', icon: 'sparkle', element: el, group: 'bottom', order: 99 });
}
