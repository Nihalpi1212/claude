export default async function (page, logs) {
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('file:new', { width: 400, height: 300 }, 'api');
    const r = { real: app.colorPicker.real, stubbed: app.stubbed?.includes?.('x') };
    r.migrated = app.settings.colorUI.swatchesMigrated;
    window.__p = app.colorPicker.pick({ initial: '#ff0000', title: 'Test' });
    await new Promise((res) => setTimeout(res, 300));
    const d = document.querySelector('.color-picker-dialog');
    r.dialog = !!d;
    r.fields = [...d.querySelectorAll('[data-f]')].map((i) => i.dataset.f + '=' + i.value);
    r.modes = [...d.querySelectorAll('[data-m]')].map((i) => i.dataset.m + '=' + i.value);
    r.gamut = !d.querySelector('.cp-gamut').hidden;
    r.web = !d.querySelector('.cp-web').hidden;
    return r;
  });
  console.log(JSON.stringify(out));
  await page.screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-color-picker-swatches/picker.png' });
  await page.locator('.color-picker-dialog [data-axis="L"]').check();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-color-picker-swatches/picker-L.png' });
  await page.locator('.color-picker-dialog .dialog-buttons .btn.primary').click();
  console.log(JSON.stringify(await page.evaluate(() => window.__p)));
  // panels
  await page.evaluate(() => { window.pigmentApp.commands.run('window:panel-swatches', undefined, 'api'); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-color-picker-swatches/panels.png' });
  // HUD
  const hud = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const s = app.colorPicker.hud({ at: { x: 500, y: 400 }, tool: app.tools.active, initial: '#ff0000' });
    s.move({ clientX: 450, clientY: 450 });
    const mid = app.settings.foreground;
    s.up({ clientX: 450, clientY: 450 });
    return { mid, v: await s.done, recent: app.settings.recentColors.slice(0, 2) };
  });
  console.log(JSON.stringify(hud));
}
