// AI: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'ai:generative-fill': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:generative-fill' },
    'ai:generative-expand': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:generative-expand' },
    'ai:generate-image': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:generate-image' },
    'ai:remove-background': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:remove-background' },
    'ai:replace-background': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:replace-background' },
    'ai:replace-sky': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:replace-sky' },
    'ai:describe': { enabled: () => false, run: () => app.dialogs.toast('AI is not available in this build', { kind: 'error' }), label: 'ai:describe' },
  });
}
