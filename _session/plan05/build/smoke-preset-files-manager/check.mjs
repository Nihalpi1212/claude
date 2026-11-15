export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const out = {};
    out.stubbed = app.stubbed.filter((s) => s.startsWith('edit:pre') || s.startsWith('edit:exp') || s.startsWith('edit:mig'));
    const F = await import('/lib/preset-formats.js');
    out.formats = F.presetFileFormats().map((f) => `${f.id}:${f.kinds.join('+')}`);
    const M = await import('/lib/preset-manager.js');
    out.libs = (await M.pigmentLibraries()).map((l) => l.id);
    for (const l of out.libs) {
      const res = await M.loadPigmentLibrary(app, l);
      out[l] = [res.added, res.report];
    }
    app.commands.run('edit:preset-manager', { kind: 'gradients' });
    await new Promise((r) => setTimeout(r, 800));
    out.items = document.querySelectorAll('.preset-manager .pm-item').length;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
