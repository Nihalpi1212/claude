export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 800, height: 600 });
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const mk = (t, x, y, extra = {}, to = {}) => {
      const layer = new TextLayer({ content: M.fromPlain(t, { size: 48, color: '#1040a0', fontFamily: 'SourceSans3VF', ...extra }), x, y, ...to });
      app.doc.add(layer); app.doc.setActive(layer); app.doc.changed('tree');
      return layer;
    };
    const styles = ['arc', 'flag', 'fisheye', 'twist', 'rise', 'bulge'];
    styles.forEach((s, i) => {
      const l = mk(s.toUpperCase() + ' text', 20 + (i % 2) * 380, 20 + Math.floor(i / 2) * 120);
      app.commands.run('type:warp-text', { style: s, bend: 60, horizontal: true }, 'api');
    });
    const v = mk('Vertical', 20, 400, {}, { });
    app.commands.run('type:warp-text', { style: 'arc', bend: 50, horizontal: false }, 'api');
    const n = mk('None AA', 400, 400);
    app.commands.run('type:anti-alias', 'none', 'api');
    const u = mk('Underlined', 400, 480, { underline: true });
    app.commands.run('type:warp-text', { style: 'arc', bend: 40 }, 'api');
    app.view.zoomToFit?.();
    return app.doc.history.entries.map(e => e.label).slice(-6);
  });
  console.log(JSON.stringify(r));
  await page.waitForTimeout(500);
}
