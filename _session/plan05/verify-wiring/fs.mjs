import { KeymapStore } from '/home/user/claude/pigment/src/renderer/lib/keymap-store.js';
import { buildMenuTemplate } from '/home/user/claude/pigment/src/shared/menu-template.js';
const app = { settings: {}, on() {}, emit() {}, saveSettingsSoon(p) { Object.assign(app.settings, p); }, syncUiState() {}, tools: { active: null }, commands: { isEnabled: () => true } };
const k = new KeymapStore(app);
console.log(JSON.stringify(k.set('view:fullscreen', ['CmdOrCtrl+Alt+Shift+F11'])), JSON.stringify(k.resolvedOverlay()));
for (const platform of ['win32', 'darwin']) {
  const t = buildMenuTemplate({ platform, state: { hasDocument: true, keymap: JSON.stringify(k.resolvedOverlay()) }, recent: [], run: () => {}, isPackaged: false });
  const find = (l) => { for (const it of l) { if (it.label === 'Toggle Full Screen') return it; if (Array.isArray(it.submenu)) { const f = find(it.submenu); if (f) return f; } } };
  console.log(platform, find(t).accelerator, 'keysFor', k.keysFor('view:fullscreen'));
}
