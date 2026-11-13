// Commands of later releases that the 0.4 menus already show (ARCHITECTURE.md "0.4 features", M.6): each stays a
// disabled stub until its release's package registers it. Owned by the skeleton; each later skeleton adds its ids.
import { stubCommands } from './stub.js';

export function install(app) {
  stubCommands(app, [
    'edit:menus', // Edit > Menus… (Alt+Shift+Ctrl+M): shortcuts-editor, 0.5
  ]);
}
