export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const P = await import('/lib/color/pipeline.js');
    const L = await import('/lib/color/lcms.js');
    const e = P.colorEngine();
    await e.ready();
    const out = { id: e.id, available: e.available, lcms: !!L.lcms(), stubbed: app.stubbed.includes('edit:assign-profile'), list: P.profilesList().map((p) => p.id) };
    const { writeChunks } = await import('/lib/io-chunks.js');
    const { builtinIcc } = await import('/lib/color/profiles.js');
    const c = document.createElement('canvas'); c.width = 2000; c.height = 2000;
    const g = c.getContext('2d'); const grad = g.createLinearGradient(0,0,2000,2000); grad.addColorStop(0,'#ff0000'); grad.addColorStop(0.5,'#20c040'); grad.addColorStop(1,'#1030ff'); g.fillStyle = grad; g.fillRect(0,0,2000,2000);
    const png = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    window.__pigmentTest.files['mem:/p3.png'] = await writeChunks(png, 'png', { icc: builtinIcc('display-p3') });
    await app.commands.run('file:open-paths', ['mem:/p3.png'], 'api');
    await new Promise((r) => setTimeout(r, 0));
    const d = app.doc;
    out.profile = d.profile?.name; out.desc = P.describe(d); out.space = d.view.space;
    const D = await import('/lib/color/display.js');
    D.resetDisplayStats();
    d.view.invalidate(); 
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    out.stats1 = D.displayStats();
    // measure the full conversion several times
    const times = [];
    for (let i = 0; i < 5; i++) { d.view.compositor.noteDamage('full'); d.view.invalidate(); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); times.push(D.displayStats().last); }
    out.times = times;
    out.status = document.querySelector('#statusbar [data-key="profile"]')?.textContent ?? null;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
