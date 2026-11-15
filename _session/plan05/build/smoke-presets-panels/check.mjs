export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('file:new', { width: 300, height: 200 }, 'api');
    const out = { stubbed: app.stubbed.filter((s) => /style|shape|tool:|preset/.test(s)) };
    await app.presets.ready('styles');
    out.styles = app.presets.list('styles').map((p) => p.id);
    out.groups = app.presets.groups('styles');
    out.title = document.querySelector('#options-bar > *')?.className;
    await app.commands.run('layer:new', undefined, 'api');
    const c = app.doc.active.canvas.getContext('2d'); c.fillStyle = '#3366cc'; c.fillRect(50, 50, 100, 80); app.doc.active.touch(); app.doc.changed('pixels', { layer: app.doc.active });
    const h0 = app.doc.history.index;
    await app.commands.run('layer:style-preset', 'basic-stroke', 'api');
    out.after = { styles: app.doc.active.styles, entries: app.doc.history.index - h0, label: app.doc.history.entries[app.doc.history.index].label };
    app.commands.run('window:panel-styles', undefined, 'api');
    out.items = document.querySelectorAll('[data-panel="styles"] .pset-item').length;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
