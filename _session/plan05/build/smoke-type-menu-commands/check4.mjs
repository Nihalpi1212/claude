export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 400, height: 300 });
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain('Hi', { size: 60, color: '#000000', fontFamily: 'SourceSans3VF' }), x: 20, y: 40 });
    app.doc.add(layer); app.doc.setActive(layer); app.doc.changed('tree');
    const a = app.actions.newAction({ name: 'Warp' });
    app.actions.record(a);
    app.commands.run('type:warp-text', { style: 'wave', bend: 40 }, 'api');
    app.commands.run('type:anti-alias', 'crisp', 'api');
    app.commands.run('layer:opacity', 50, 'api');
    await new Promise(r => setTimeout(r, 50));
    app.actions.stopRecording();
    const found = app.actions.sets.flatMap((s) => s.actions).find((x) => x.id === a.id);
    return { a: a.steps.length, found: found?.steps.map(s => [s.command, s.arg]) };
  });
  console.log(JSON.stringify(r));
}
