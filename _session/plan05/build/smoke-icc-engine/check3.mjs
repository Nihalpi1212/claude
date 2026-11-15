export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const P = await import('/lib/color/pipeline.js');
    await P.colorEngine().ready();
    const { writeChunks } = await import('/lib/io-chunks.js');
    const { builtinIcc } = await import('/lib/color/profiles.js');
    const D = await import('/lib/color/display.js');
    const c = document.createElement('canvas'); c.width = 200; c.height = 150; const g = c.getContext('2d'); g.fillStyle = '#c86432'; g.fillRect(0,0,200,150);
    const png = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    window.__pigmentTest.files['mem:/p3.png'] = await writeChunks(png, 'png', { icc: builtinIcc('display-p3') });
    await app.commands.run('file:open-paths', ['mem:/p3.png'], 'api');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const d = app.doc; const v = d.view; const reads = []; for (let i = 0; i < 6; i++) { await new Promise((res) => requestAnimationFrame(res)); const q = v.toScreen(100,75); reads.push(Array.from(v.ctx.getImageData(Math.round(q.x), Math.round(q.y), 1, 1).data).join(",")); } window.__reads = reads;
    const p = v.toScreen(100, 75);
    const kept = D.keptCanvas(v);
    return { reads: window.__reads, p, dpr: v.dpr, zoom: v.zoom, space: v.space, ctxSpace: v.ctx.getContextAttributes().colorSpace, viewPx: Array.from(v.ctx.getImageData(Math.round(p.x*v.dpr), Math.round(p.y*v.dpr), 1, 1).data), kept: kept && Array.from(kept.getContext('2d').getImageData(100,75,1,1).data), stats: D.displayStats(), conv: P.convertColor([200,100,50], d.profile, P.SRGB), cw: v.canvas.width, ch: v.canvas.height };
  });
  console.log(JSON.stringify(r));
}
