export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 600, height: 300, name: 'T' }));
  await page.evaluate(async () => { const { fontCatalog } = await import('/lib/type/api.js'); await fontCatalog().ready(); });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const l = new TextLayer({ content: M.fromPlain('Hello fonts', { fontFamily: 'SourceSans3VF', size: 60, color: '#000000' }), x: 20, y: 60 });
    app.doc.add(l); app.doc.setActive(l); app.doc.changed('tree');
    await app.commands.run('tool:text', undefined, 'api');
  });
  await page.waitForTimeout(800);
  const field = page.locator('#options-bar .opt[data-key="family"] .fp-field');
  await field.click();
  await page.locator('.fp-menu .fp-search').fill('Source');
  await page.locator('.fp-menu .fp-row[data-family="SourceSans3VF"]').click();
  await page.waitForTimeout(300);
  console.log('after choose', await page.locator('.fp-menu').count(), await page.evaluate(() => JSON.stringify(window.pigmentApp.settings.typeFonts)));
  await field.click();
  await page.waitForTimeout(300);
  console.log('after reopen', await page.locator('.fp-menu').count(), await page.locator('.fp-menu .fp-heading').count());
  console.log(await page.evaluate(() => document.activeElement?.className));
}
