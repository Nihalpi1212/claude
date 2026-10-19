// Printing: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'file:print': { enabled: () => false, run: () => app.dialogs.toast('Printing is not available in this build', { kind: 'error' }), label: 'file:print' },
  });
}
