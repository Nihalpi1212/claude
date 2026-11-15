// Commands of later releases that the menus already show (ARCHITECTURE.md "0.4 features", M.6; "0.5 features", S13.3):
// each stays a disabled stub until its release's package registers it. Owned by the skeleton; each later skeleton
// adds its ids. 0.5 moved edit:menus to shortcuts-editor's stub (lib/shortcuts-editor.js).
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    'edit:color-settings', // Edit > Color Settings…: color-settings, 0.6
    'edit:convert-profile', // Edit > Convert to Profile…: color-settings, 0.6
  ]);
}
