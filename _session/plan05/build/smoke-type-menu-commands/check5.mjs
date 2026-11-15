export default async function (page, logs) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 600, height: 400 });
    app.tools.activate('type-mask-horizontal');
    app.tools.setOpt('type-mask-horizontal', 'family', 'SourceSans3VF');
    app.tools.setOpt('type-mask-horizontal', 'size', 120);
    const t = app.tools.active;
    t.beginNew({ x: 60, y: 220 }, null);
    t.session.editor.insert('Mask me');
    app.view.invalidate();
  });
  await page.waitForTimeout(400);
}
