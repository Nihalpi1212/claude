// AI assistant: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'ai:assistant': { enabled: () => false, run: () => app.dialogs.toast('AI assistant is not available in this build', { kind: 'error' }), label: 'ai:assistant' },
  });
}
