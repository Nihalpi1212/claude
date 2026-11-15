export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 300, height: 200, name: 'T' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    const TP = await import('/lib/tool-presets.js');
    await app.presets.ready('tool-presets');
    app.presets.add('tool-presets', { name: 'Soft 40', data: TP.captureToolPreset(app, 'brush') });
    app.presets.add('tool-presets', { name: 'Hard Eraser', data: TP.captureToolPreset(app, 'eraser') });
    app.commands.run('window:panel-shapes', undefined, 'api');
    app.commands.run('window:panel-tool-presets', undefined, 'api');
  });
  await page.locator('#options-bar .pset-tool-picker').click();
  await page.waitForTimeout(300);
}
