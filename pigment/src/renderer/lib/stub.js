// Placeholder registration for feature modules that have not landed yet. The native menu already
// names their commands; a stub registers each missing id as a disabled no-op and lists it in
// app.stubbed so the menu greys it out (app.syncUiState sends `stubs`). A module that lands replaces
// its stub file and registers the real commands, so nothing else has to change.
//
// 0.4: a stub definition carries `stub: true`, and CommandRegistry.register() of a definition without
// it removes the id from app.stubbed, so a real command replaces its stub whatever the module order.
// An entry of `ids` may be `{ id, ...flags }` to give the stub the definition flags its owner will declare
// (`record: false`, `undoLike: true`, `changesDocument: true`, ARCHITECTURE.md "0.4 features" E31), so the
// actions recorder and the sessions treat the id the same way before and after the package lands.
const FLAGS = ['record', 'undoLike', 'changesDocument'];

export function stubCommands(app, ids, label = 'Not available yet') {
  app.stubbed ??= [];
  for (const entry of ids) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const flags = {};
    if (typeof entry === 'object') for (const k of FLAGS) if (k in entry) flags[k] = entry[k];
    if (!app.commands.has(id)) app.commands.register(id, { enabled: () => false, run: () => {}, label, stub: true, ...flags });
    if (app.commands.commands.get(id)?.stub && !app.stubbed.includes(id)) app.stubbed.push(id);
  }
}
