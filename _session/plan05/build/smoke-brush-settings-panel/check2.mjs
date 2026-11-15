const D = '/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/smoke-brush-settings-panel/';
export default async function (page, logs) {
  await page.setViewportSize({ width: 1400, height: 1400 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('file:new', { width: 600, height: 400, background: 'white' }, 'api');
    app.tools.activate('brush');
    // collapse the middle and bottom groups so the top one has room
    app.panels.setCollapsed('middle', true); app.panels.setCollapsed('bottom', true);
    app.panels.show('brush-settings', { reveal: true });
  });
  await page.waitForTimeout(300);
  await page.locator('.bs-section[data-section="tip"] .bs-section-label').click();
  await page.waitForTimeout(400);
  await page.locator('.brush-settings-panel').screenshot({ path: D + 'tip.png' });
  await page.locator('.bs-section[data-section="texture"] input').click();
  await page.waitForTimeout(600);
  await page.locator('.brush-settings-panel').screenshot({ path: D + 'texture.png' });
  await page.locator('.bs-section[data-section="dualBrush"] input').click();
  await page.waitForTimeout(600);
  await page.locator('.brush-settings-panel').screenshot({ path: D + 'dual.png' });
  await page.locator('#options-bar button.opt-brush').click();
  await page.waitForTimeout(500);
  await page.locator('.popover-brush').screenshot({ path: D + 'popover.png' });
}
