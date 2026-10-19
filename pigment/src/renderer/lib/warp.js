// Warp: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'edit:transform-warp': { enabled: () => false, run: () => app.dialogs.toast('Warp is not available in this build', { kind: 'error' }), label: 'edit:transform-warp' },
    'edit:puppet-warp': { enabled: () => false, run: () => app.dialogs.toast('Warp is not available in this build', { kind: 'error' }), label: 'edit:puppet-warp' },
    'edit:perspective-warp': { enabled: () => false, run: () => app.dialogs.toast('Warp is not available in this build', { kind: 'error' }), label: 'edit:perspective-warp' },
  });
}
