// Color proofing: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'view:proof': { enabled: () => false, run: () => app.dialogs.toast('Color proofing is not available in this build', { kind: 'error' }), label: 'view:proof' },
    'view:gamut': { enabled: () => false, run: () => app.dialogs.toast('Color proofing is not available in this build', { kind: 'error' }), label: 'view:gamut' },
  });
}
