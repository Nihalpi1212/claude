export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 600, height: 300, name: 'T' }));
  await page.waitForTimeout(1500);
  const id = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const l = new TextLayer({ content: M.fromPlain('Hello fonts', { fontFamily: 'SourceSans3VF', size: 60, color: '#000000' }), x: 20, y: 60 });
    app.doc.add(l); app.doc.setActive(l); app.doc.changed('tree');
    app.tools.activate('type-horizontal');
    return l.id;
  });
  await page.waitForTimeout(1500);
  const info = await page.evaluate((lid) => { const l = window.pigmentApp.doc.find(lid); const r = l.layout().lines[0].runs[0]; return { engine: l.layout().engine, face: r.face?.postScriptName, w: r.face?.weight, bar: [...document.querySelectorAll('#options-bar .opt')].map((o) => o.dataset.key + ':' + (o.querySelector('select')?.value ?? o.querySelector('.fp-field')?.dataset.value ?? '')) }; }, id);
  console.log(JSON.stringify(info));
  await page.click('#options-bar .opt[data-key="family"] .fp-field');
  await page.waitForTimeout(500);
  await page.hover('.fp-menu .fp-row[data-family="Liberation Sans"]').catch((e) => console.log('nohover', e.message));
  await page.waitForTimeout(400);
  const pv = await page.evaluate(() => window.pigmentApp.fontPicker.preview.family);
  console.log('preview', pv);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-type-fonts/menu.png' });
  await page.keyboard.press('Escape');
}
