const D = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-brush-settings-panel/';
export default async function (page, logs) {
  await page.setViewportSize({ width: 1400, height: 1400 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('file:new', { width: 600, height: 400, background: 'white' }, 'api');
    app.tools.activate('brush');
    app.panels.setCollapsed('middle', true); app.panels.setCollapsed('bottom', true);
    app.panels.show('brushes', { reveal: true });
    await app.presets.ready('brushes');
    app.saveSettingsSoon({ brushes: { ...app.settings.brushes, view: 'strokes', collapsed: { general: true } } });
    app.panels.show('brushes', { reveal: true });
  });
  await page.waitForTimeout(800);
  await page.locator('.brush-panel').screenshot({ path: D + 'strokes.png' });
  await page.locator('#options-bar button.opt-brush').click();
  await page.waitForTimeout(500);
  await page.locator('.popover-brush').screenshot({ path: D + 'popover.png' });
  await page.locator('#options-bar').screenshot({ path: D + 'bar.png' });
}
