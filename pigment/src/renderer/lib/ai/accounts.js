// AI accounts: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'ai:accounts': { enabled: () => false, run: () => app.dialogs.toast('AI accounts is not available in this build', { kind: 'error' }), label: 'ai:accounts' },
  });
}
