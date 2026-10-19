// Text on a path: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'text:on-path': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'text:on-path' },
    'text:release-path': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'text:release-path' },
    'text:flip-path': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'text:flip-path' },
    'text:orientation': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'text:orientation' },
    'path:op': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'path:op' },
    'path:merge-components': { enabled: () => false, run: () => app.dialogs.toast('Text on a path is not available in this build', { kind: 'error' }), label: 'path:merge-components' },
  });
}
