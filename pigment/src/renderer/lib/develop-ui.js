// Camera Raw: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'filter:camera-raw': { enabled: () => false, run: () => app.dialogs.toast('Camera Raw is not available in this build', { kind: 'error' }), label: 'filter:camera-raw' },
  });
}
