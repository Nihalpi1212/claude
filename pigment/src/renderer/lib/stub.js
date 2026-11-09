// Placeholder registration for 0.3 feature modules that have not landed yet. The native menu already
// names their commands; a stub registers each missing id as a disabled no-op and lists it in
// app.stubbed so the menu greys it out (app.syncUiState sends `stubs`). A module that lands replaces
// its stub file and registers the real commands, so nothing else has to change.
export function stubCommands(app, ids, label = 'Not available yet') {
  app.stubbed ??= [];
  for (const id of ids) {
    if (!app.commands.has(id)) app.commands.register(id, { enabled: () => false, run: () => {}, label });
    if (!app.stubbed.includes(id)) app.stubbed.push(id);
  }
}
