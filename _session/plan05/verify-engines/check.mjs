export default async function (page, logs) {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('pigment.settings') || '{}');
    s.brushPresets = [{ id: 'my-old-brush', name: 'Old one', size: 77, hardness: 0.3, spacing: 0.2, angle: 15, roundness: 0.6, flow: 0.4 }, { id: 'hard', name: 'Clash id?', size: 9, hardness: 1 }];
    s.brushes = { locks: {}, recent: [], view: 'thumbs', migrated: false };
    localStorage.setItem('pigment.settings', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  await page.waitForTimeout(800);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.presets.ready('brushes');
    const list = app.presets.list('brushes');
    return { ids: list.map((p) => p.id), old: list.find((p) => p.id === 'my-old-brush')?.data?.tip, oldTool: list.find((p) => p.id === 'my-old-brush')?.data?.tool, migrated: app.settings.brushes?.migrated, keptOld: Array.isArray(app.settings.brushPresets) && app.settings.brushPresets.length };
  });
  console.log(JSON.stringify(r));
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  await page.waitForTimeout(800);
  const r2 = await page.evaluate(async () => { const app = window.pigmentApp; await app.presets.ready('brushes'); return { n: app.presets.list('brushes').filter((p) => p.id === 'my-old-brush' || p.name === 'Clash id?').length, migrated: app.settings.brushes?.migrated }; });
  console.log('after reload', JSON.stringify(r2));
  await page.evaluate(() => localStorage.clear());
}
