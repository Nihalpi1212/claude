export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 600, height: 300, name: 'T' }));
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { fontCatalog } = await import('/lib/type/api.js');
    await fontCatalog().ready();
    const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/LiberationSans-Bold.ttf')).arrayBuffer());
    await fontCatalog().addFiles([{ bytes, name: 'LiberationSans-Bold.ttf' }, { bytes: new Uint8Array(await (await fetch('/fixtures/fonts/LiberationSans-Regular.ttf')).arrayBuffer()), name: 'LiberationSans-Regular.ttf' }]);
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const io = await import('/lib/io.js');
    const l = new TextLayer({ content: M.fromPlain('Bold PSD', { fontFamily: 'Liberation Sans', fontWeight: 700, postScriptName: 'LiberationSans-Bold', size: 40, color: '#000000' }), x: 20, y: 60 });
    const l2 = new TextLayer({ content: M.fromPlain('Axis PSD', { fontFamily: 'SourceSans3VF', fontWeight: 650, postScriptName: 'SourceSans3VF-Semibold', axes: { wght: 650 }, size: 40, color: '#000000' }), x: 20, y: 160 });
    app.doc.add(l); app.doc.add(l2); app.doc.changed('tree');
    await new Promise((r) => setTimeout(r, 1500));
    const psd = await io.writePsdDocument(app.doc, app.compositor);
    const back = await io.openDocument(psd instanceof Uint8Array ? psd : psd.bytes ?? psd, { name: 'x.psd' });
    const types = back.layers().map((x) => x.type + ':' + x.name); const texts = back.layers().filter((x) => x.type === 'text').map((x) => x.content.runs.map((r) => ({ f: r.style.fontFamily, ps: r.style.postScriptName, w: r.style.fontWeight, axes: r.style.axes })));
    const missing = fontCatalog().missing(back).map((m) => m.family);
    // 16-bit grayscale document: options bar style change
    try { await app.commands.run('image:mode', { mode: 'grayscale', silent: true, flatten: false }, 'api'); } catch {}
    try { await app.commands.run('image:depth', 16, 'api'); } catch {}
    app.doc.setActive(l); app.doc.changed('tree');
    app.tools.activate('type-horizontal');
    await new Promise((r) => setTimeout(r, 300));
    app.tools.setOpt('type-horizontal', 'style', 'LiberationSans', {});
    await new Promise((r) => setTimeout(r, 300));
    return { types, psdType: typeof psd, texts, missing, mode: app.doc.mode, depth: app.doc.depth, after: l.content.runs.map((r) => [r.style.postScriptName, r.style.fontWeight]), label: app.doc.history.entries.at(-1).label };
  });
  console.log(JSON.stringify(r, null, 1));
}
