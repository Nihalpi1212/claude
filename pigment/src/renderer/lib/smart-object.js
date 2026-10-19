// Smart objects: placeholder registering its commands as disabled (see ARCHITECTURE.md "0.2 features").
export function install(app) {
  app.commands.registerAll({
    'layer:smart-convert': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-convert' },
    'layer:smart-via-copy': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-via-copy' },
    'layer:smart-edit': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-edit' },
    'layer:smart-replace': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-replace' },
    'layer:smart-export': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-export' },
    'layer:smart-reset': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-reset' },
    'layer:smart-rasterize': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-rasterize' },
    'layer:smart-filters-toggle': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-filters-toggle' },
    'layer:smart-filters-clear': { enabled: () => false, run: () => app.dialogs.toast('Smart objects is not available in this build', { kind: 'error' }), label: 'layer:smart-filters-clear' },
  });
}
