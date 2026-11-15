export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('file:new', { width: 600, height: 400, background: 'white' }, 'api');
    app.tools.activate('brush');
    app.panels.show('brush-settings', { reveal: true });
    await new Promise((r) => setTimeout(r, 300));
    return { stubbed: app.stubbed.includes('window:panel-brush-settings'), visible: app.panels.isVisible('brush-settings'), sections: document.querySelectorAll('.bs-section').length };
  });
  logs.push(JSON.stringify(r));
  await page.locator('.bs-section[data-section="scattering"] input').click(); await page.setViewportSize({ width: 1400, height: 1300 });
  await page.waitForTimeout(300);
  logs.push(JSON.stringify(await page.evaluate(async () => { const { toolBrush } = await import('/lib/brush/tool-brush.js'); return toolBrush(window.pigmentApp, 'brush').preset.scattering; })));
  await page.locator('.brush-settings-panel').screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-brush-settings-panel/panel.png' });
  await page.evaluate(() => window.pigmentApp.panels.show('brushes', { reveal: true }));
  await page.waitForTimeout(300);
  await page.locator('.brush-panel').screenshot({ path: '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-brush-settings-panel/brushes.png' });
  await page.locator('#options-bar button.opt-brush').click();
  await page.waitForTimeout(300);
}
