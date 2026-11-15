export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const ids = ['window:panel-brush-settings','window:panel-styles','window:panel-shapes','window:panel-tool-presets','edit:define-brush','edit:define-custom-shape','edit:preset-manager','edit:export-import-presets','edit:migrate-presets','edit:assign-profile','edit:color-settings','edit:convert-profile','edit:camera-raw-preferences','edit:menus','edit:show-all-menu-items','help:shortcuts','type:add-fonts','type:font-preview-size','type:manage-missing-fonts','type:replace-missing-fonts','type:anti-alias','type:warp-text','type:create-work-path','type:convert-to-shape','type:convert-text-kind','type:update-all','type:paste-lorem-ipsum','type:toggle-orientation','tool:type-mask-horizontal','tool:type-mask-vertical','tool:brush-preset','tool:airbrush-toggle','tool:brush-prev','tool:brush-next','tool:brush-first','tool:brush-last','tool:preset','tool:reset','tool:reset-all','layer:style-preset','tool:opacity-digit-1','tool:flow-digit-0','tool:blend-mode-behind','tool:blend-mode-clear','tool:blend-mode-normal','tool:blend-mode-luminosity'];
    const info = {};
    for (const id of ids) { const c = app.commands.commands.get(id); info[id] = c ? { stub: !!c.stub, record: c.record, en: app.commands.isEnabled(id) } : 'MISSING'; }
    const s = app.settings;
    const ns = {}; for (const k of ['brushes','brushEngine','painting','colorManagement','psd','cameraRaw','presetPanels','presetManager','colorUI','typeFonts','typeCommands','keymap']) ns[k] = s[k];
    const keys = {}; for (const c of ['help:guide','window:panel-brush-settings','window:panel-color','window:panel-layers','window:panel-info','file:revert','help:devtools','edit:menus','help:shortcuts','tool:airbrush-toggle','tool:brush-prev','tool:flow-digit-3','tool:blend-mode-behind']) keys[c] = [app.keymap.keysFor(c), app.keymap.keysFor(c,'paint')];
    return { stubbed: [...app.stubbed].sort(), info, ns, keys, ui: Object.keys(app.uiState), uiKm: app.uiState.keymap, uiMenus: app.uiState.menus, uiAA: app.uiState.antiAlias, uiTK: app.uiState.textKind, uiFPS: app.uiState.fontPreviewSize, flat: { brush: !!s.brush, brushPresets: s.brushPresets !== undefined, cursorStyle: s.cursorStyle, tools: !!s.tools }, panels: [...document.querySelectorAll('[data-panel]')].map(e=>e.dataset.panel), keymapApi: Object.getOwnPropertyNames(Object.getPrototypeOf(app.keymap)) };
  });
  console.log(JSON.stringify(r, null, 1));
}
