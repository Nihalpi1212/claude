// The native application menu's template lives in src/shared/menu-template.js since 0.4 (ARCHITECTURE.md
// "0.4 features", M.1), so the renderer can read the menu's labels and paths too. This file keeps the 0.3
// import path for main.js and the tests.
export { buildMenuTemplate, PANELS, IMAGE_MODES, STACK_MODES } from '../shared/menu-template.js';
