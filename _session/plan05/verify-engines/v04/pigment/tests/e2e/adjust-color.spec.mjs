// adjust-color (0.4 package 8): Hue/Saturation colour ranges with their eyedroppers, bars and on-image tool; presets
// and Photoshop's preset files; the three new kinds as adjustment layers (partial repaints match full ones); Gradient
// Map's gradient widget; Shadows/Highlights' Show More Options; the Properties controls of adjustment layers
// (presets, eyedroppers sampling below, Auto, previous state); the Adjustments panel's presets; the Adjustment Brush.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, screenPoint, confirmDialog, historyLength, drag } from './helpers.mjs';

const dialog = '.dialog-backdrop .dialog';
const field = (page, key, scope = dialog) => page.locator(`${scope} input[type="number"][data-key="${key}"]`);
const setField = async (page, key, value, scope = dialog) => {
  await field(page, key, scope).fill(String(value));
  await field(page, key, scope).dispatchEvent('change');
};
const cancel = async (page) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
};
const clickDoc = async (page, x, y, opts = {}) => {
  const at = await screenPoint(page, x, y);
  await page.mouse.click(at.x, at.y, opts);
};

/** 400 x 300: red (x < 100), blue (100..199), green (200..299), a grey ramp (300..399). */
async function testImage(page) {
  await newDoc(page, { width: 400, height: 300 });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 100, 300);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(100, 0, 100, 300);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(200, 0, 100, 300);
    const g = ctx.createLinearGradient(300, 0, 400, 0);
    g.addColorStop(0, '#202020');
    g.addColorStop(1, '#e0e0e0');
    ctx.fillStyle = g;
    ctx.fillRect(300, 0, 100, 300);
    l.touch();
    app.doc.changed('pixels', { layer: l });
  });
}

test('Hue/Saturation: the range eyedropper picks Reds, its saturation greys the reds only; params are J.9 ranges', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await run(page, 'image:adjust-hue-saturation');
  await expect(page.locator(`${dialog} .hue-sat-editor`)).toBeVisible();
  // the frame shows the preset menu (Photoshop's built-ins), the three range eyedroppers and the on-image tool
  await expect(page.locator(`${dialog} select[data-preset-kind="adjustment:hue-saturation"] option`, { hasText: 'Sepia' })).toHaveCount(1);
  for (const id of ['sample', 'add', 'subtract']) await expect(page.locator(`${dialog} [data-eyedropper="${id}"]`)).toBeVisible();
  await expect(page.locator(`${dialog} [data-on-image]`)).toBeVisible();
  const range = page.locator(`${dialog} select[data-key="__range"]`);
  await expect(range).toHaveValue('master');
  await expect(page.locator(`${dialog} .hs-bars`)).toBeHidden();
  await page.locator(`${dialog} [data-eyedropper="sample"]`).click();
  await clickDoc(page, 20, 280);
  await expect(range).toHaveValue('reds');
  await expect(page.locator(`${dialog} .hs-bars`)).toBeVisible();
  await expect(page.locator(`${dialog} .hs-readout`)).toContainText('315°/345°');
  await page.keyboard.press('Escape'); // puts the eyedropper down, the dialog stays
  await setField(page, 'saturation', -100);
  await expect.poll(() => pixel(page, 20, 20)).toEqual([76, 76, 76, 255]);
  expect(await pixel(page, 150, 20)).toEqual([0, 0, 255, 255]);
  await confirmDialog(page);
  const used = await page.evaluate(() => window.pigmentApp.settings.adjustLast['hue-saturation']);
  expect(used.range).toBe('master');
  expect(used.ranges).toEqual([{ base: 'reds', bounds: [315, 345, 15, 45], hue: 0, saturation: -100, lightness: 0 }]);
  expect(await pixel(page, 20, 20)).toEqual([76, 76, 76, 255]);
  expect(await pixel(page, 250, 20)).toEqual([0, 255, 0, 255]);
  // Alt+Ctrl+U reopens with the last values (adjust-tonal's command), the Reds range selected by the user stays in params
  await page.keyboard.press('Control+Alt+u');
  await expect(page.locator(`${dialog} .hue-sat-editor`)).toBeVisible();
  await range.selectOption('reds');
  await expect(field(page, 'saturation')).toHaveValue('-100');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('Hue/Saturation: + and - eyedroppers move the bounds; the bars drag; the on-image tool drags the saturation of the clicked colour', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  // a colour at hue 330 (pink-red) next to the red strip
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = 'hsl(330, 100%, 50%)';
    ctx.fillRect(0, 200, 100, 100);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  });
  await run(page, 'image:adjust-hue-saturation');
  const range = page.locator(`${dialog} select[data-key="__range"]`);
  await range.selectOption('reds');
  const readout = page.locator(`${dialog} .hs-readout`);
  await expect(readout).toContainText('315°/345°');
  await page.locator(`${dialog} [data-eyedropper="add"]`).click();
  await clickDoc(page, 20, 280);
  await expect(readout).toContainText('300°/330°'); // the full-effect part now starts at 330
  await page.locator(`${dialog} [data-eyedropper="subtract"]`).click();
  await clickDoc(page, 20, 280);
  await expect(readout).toContainText('330°/0°'); // 330 itself left the range: the fall-off starts there now
  await page.keyboard.press('Escape');
  // drag the band (the full-effect part) 10 % to the right: the whole range moves by about 36 degrees
  const band = page.locator(`${dialog} .hs-band`);
  const before = await readout.textContent();
  const bb = await band.boundingBox();
  const track = await page.locator(`${dialog} .hs-track`).boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + track.width * 0.1, bb.y + bb.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(readout).not.toHaveText(before);
  // on-image: click the blue strip and drag right: Blues gets selected, its saturation goes up from 0
  await page.locator(`${dialog} [data-on-image]`).click();
  await range.selectOption('master');
  const a = await screenPoint(page, 150, 280);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x - 40, a.y, { steps: 5 });
  await page.mouse.up();
  await expect(range).toHaveValue('blues');
  await expect.poll(async () => Number(await field(page, 'saturation').inputValue())).toBeLessThan(-30);
  await expect.poll(async () => (await pixel(page, 150, 20))[0]).toBeGreaterThan(5); // the blue lost saturation
  expect(await pixel(page, 250, 20)).toEqual([0, 255, 0, 255]);
  await page.keyboard.press('Escape');
  await cancel(page);
  expect(await pixel(page, 150, 20)).toEqual([0, 0, 255, 255]);
  expect(errors).toEqual([]);
});

test('Hue/Saturation presets: a built-in fills the dialog; Save to File writes Photoshop’s 100-byte .ahu, Load reads it back', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await run(page, 'image:adjust-hue-saturation');
  const select = page.locator(`${dialog} select[data-preset-kind="adjustment:hue-saturation"]`);
  await select.selectOption({ label: 'Sepia' });
  await expect(page.locator(`${dialog} input[data-key="colorize"]`)).toBeChecked();
  await expect(field(page, 'colorizeHue')).toHaveValue('35');
  await select.selectOption({ label: 'Red Boost' });
  await expect(page.locator(`${dialog} input[data-key="colorize"]`)).not.toBeChecked();
  await page.locator(`${dialog} select[data-key="__range"]`).selectOption('reds');
  await expect(field(page, 'saturation')).toHaveValue('40');
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = '/presets/red.ahu'));
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="export"]`).click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['/presets/red.ahu']?.length ?? 0)).toBe(100);
  await select.selectOption({ label: 'Increase Saturation' });
  await page.evaluate(() => (window.__pigmentTest.nextOpenFiles = ['/presets/red.ahu']));
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="load"]`).click();
  await expect(select.locator('option:checked')).toHaveText('red');
  await page.locator(`${dialog} select[data-key="__range"]`).selectOption('reds');
  await expect(field(page, 'saturation')).toHaveValue('40');
  await cancel(page);
  expect(errors).toEqual([]);
});

test('the new kinds are enabled in both menus and make adjustment layers; partial repaints match full composites', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  const info = await page.evaluate(() => {
    const app = window.pigmentApp;
    return ['color-vibrance', 'clarity-dehaze', 'grain'].map((k) => [app.commands.isEnabled(`image:adjust-${k}`), app.stubbed.includes(`image:adjust-${k}`)]);
  });
  expect(info).toEqual([[true, false], [true, false], [true, false]]);
  // the Adjustments panel offers them too
  for (const k of ['color-vibrance', 'clarity-dehaze', 'grain']) await expect(page.locator(`.adjustments-panel .adjust-grid button[data-kind="${k}"]`)).toHaveCount(1);
  await runAwait(page, 'layer:new-adjustment', { kind: 'clarity-dehaze', params: { clarity: 60, dehaze: 30 } });
  await runAwait(page, 'layer:new-adjustment', { kind: 'grain', params: { amount: 70, size: 30, roughness: 40 } });
  await runAwait(page, 'layer:new-adjustment', { kind: 'color-vibrance', params: { temperature: 40, vibrance: 20 } });
  const cmp = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const full = d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const out = [];
    for (const r of [{ x: 90, y: 40, width: 30, height: 25 }, { x: 290, y: 200, width: 40, height: 40 }]) {
      const part = d.view.compositor.composite(d, { rect: r });
      const ctx = part.getContext('2d');
      // composite(doc, { rect }) returns the document canvas with the rect painted, or the rect alone
      const img = part.width === d.width ? ctx.getImageData(r.x, r.y, r.width, r.height).data : ctx.getImageData(0, 0, r.width, r.height).data;
      let diff = 0;
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) for (let c = 0; c < 4; c++) {
        if (img[(y * r.width + x) * 4 + c] !== full[((r.y + y) * d.width + r.x + x) * 4 + c]) diff++;
      }
      out.push(diff);
    }
    return { diffs: out, changed: full[(20 * d.width + 350) * 4] !== 0 };
  });
  expect(cmp.diffs).toEqual([0, 0]);
  // the Properties panel edits them with their fields
  await expect(page.locator('.props-adjust input[type="number"][data-key="temperature"]')).toHaveValue('40');
  expect(errors).toEqual([]);
});

test('Gradient Map uses the gradient widget with Reverse and Dither; Black & White Auto; Photo Filter list; Channel Mixer total', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await run(page, 'image:adjust-gradient-map');
  await expect(page.locator(`${dialog} .gradient-map-editor [data-widget="gradient"]`)).toBeVisible();
  const before = await pixel(page, 310, 20);
  await page.locator(`${dialog} input[data-key="reverse"]`).check();
  await expect.poll(() => pixel(page, 310, 20)).not.toEqual(before);
  await page.locator(`${dialog} input[data-key="dither"]`).check();
  await confirmDialog(page);
  const gm = await page.evaluate(() => window.pigmentApp.settings.adjustLast['gradient-map']);
  expect([gm.reverse, gm.dither, gm.gradientVersion]).toEqual([true, true, 2]);
  await runAwait(page, 'edit:undo');

  // Black & White: Auto spreads the colours apart
  await run(page, 'image:adjust-black-white');
  await expect(page.locator(`${dialog} .bw-editor`)).toBeVisible();
  await page.locator(`${dialog} [data-act="auto"]`).click();
  await expect.poll(async () => Number(await field(page, 'blues').inputValue())).not.toBe(20);
  await expect(page.locator(`${dialog} select[data-preset-kind="adjustment:black-white"] option`, { hasText: 'Infrared' })).toHaveCount(1);
  await cancel(page);

  // Photo Filter: picking a filter sets its colour
  await run(page, 'image:adjust-photo-filter');
  const filter = page.locator(`${dialog} select[data-key="__filter"]`);
  await expect(filter).toHaveValue('warming-85');
  await filter.selectOption('cooling-80');
  await expect(page.locator(`${dialog} input[data-key="color"]`)).toHaveValue('#006dff');
  await cancel(page);

  // Channel Mixer: the total, with a warning above 100 %
  await run(page, 'image:adjust-channel-mixer');
  const total = page.locator(`${dialog} .mixer-total[data-total="r"]`);
  await expect(total).toHaveText('Total: +100 %');
  await setField(page, 'r.g', 50);
  await expect(total).toHaveText('Total: +150 %');
  await expect(total).toHaveClass(/over/);
  await cancel(page);
  expect(errors).toEqual([]);
});

test('Shadows/Highlights: Show More Options adds Tone, Radius and the adjustments, and is remembered', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await run(page, 'image:adjust-shadows-highlights');
  await expect(field(page, 'shadows')).toHaveValue('35');
  await expect(field(page, 'shadowTone')).toBeHidden();
  await page.locator(`${dialog} input[data-key="__more"]`).check();
  for (const k of ['shadowTone', 'shadowRadius', 'highlightTone', 'highlightRadius', 'color', 'midtone', 'blackClip', 'whiteClip']) await expect(field(page, k)).toBeVisible();
  await expect(field(page, 'color')).toHaveValue('20');
  await setField(page, 'shadowRadius', 12);
  await confirmDialog(page);
  const used = await page.evaluate(() => [window.pigmentApp.settings.adjustLast['shadows-highlights'], window.pigmentApp.settings.adjust.shMoreOptions]);
  expect(used[0]).toMatchObject({ shadows: 35, shadowRadius: 12, color: 20 });
  expect(used[1]).toBe(true);
  await run(page, 'image:adjust-shadows-highlights');
  await expect(field(page, 'shadowTone')).toBeVisible();
  await expect(field(page, 'shadowRadius')).toHaveValue('12');
  await cancel(page);
  // HDR Toning's flatten question is a prepare hook now (I.2), not a wrapped command
  expect(await page.evaluate(() => typeof window.pigmentApp.adjustEditors.get('hdr-toning').prepare)).toBe('function');
  expect(errors).toEqual([]);
});

test('Properties: an adjustment layer’s presets, eyedroppers sampling the composite below, Auto and View Previous State', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await runAwait(page, 'layer:new-adjustment', 'hue-saturation');
  const props = '.props-adjust';
  await expect(page.locator(`${props} .hue-sat-editor`)).toBeVisible();
  await expect(page.locator(`${props} select[data-preset-kind="adjustment:hue-saturation"]`)).toBeVisible();
  // the sample eyedropper reads the composite below the layer (the blue strip)
  await page.locator(`${props} [data-eyedropper="sample"]`).click();
  await clickDoc(page, 150, 150);
  await expect(page.locator(`${props} select[data-key="__range"]`)).toHaveValue('blues');
  await page.keyboard.press('Escape');
  await setField(page, 'hue', 120, props);
  await expect.poll(() => pixel(page, 150, 20)).not.toEqual([0, 0, 255, 255]);
  const edited = await pixel(page, 150, 20);
  // View previous state shows the layer as it was selected (no adjustment), then the edit again; no history entry
  const n = await historyLength(page);
  const prev = page.locator('.props-adjust-bar [data-act="previous"]');
  await prev.click();
  await expect(prev).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pixel(page, 150, 20)).toEqual([0, 0, 255, 255]);
  await prev.click();
  await expect(prev).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => pixel(page, 150, 20)).toEqual(edited);
  expect(await historyLength(page)).toBe(n);
  const params = await page.evaluate(() => window.pigmentApp.doc.active.params);
  expect(params.ranges).toEqual([{ base: 'blues', bounds: [195, 225, 255, 285], hue: 120, saturation: 0, lightness: 0 }]);
  // a Black & White layer's Auto computes from the composite below
  await runAwait(page, 'layer:new-adjustment', 'black-white');
  await expect(page.locator(`${props} .bw-editor`)).toBeVisible();
  await page.locator(`${props} [data-act="auto"]`).click();
  // (below it: red, the blue turned red by the Hue/Saturation layer, green and grey)
  await expect.poll(() => page.evaluate(() => ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'].map((k) => window.pigmentApp.doc.active.params[k]).join())).not.toBe('40,60,40,60,20,80');
  // a 0.3 single-range layer opens with its range selected and renders as before
  await runAwait(page, 'layer:new-adjustment', { kind: 'hue-saturation', params: { hue: 0, saturation: -100, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'greens' } });
  await expect(page.locator(`${props} select[data-key="__range"]`)).toHaveValue('greens');
  await expect(field(page, 'saturation', props)).toHaveValue('-100');
  expect(errors).toEqual([]);
});

test('Adjustments panel presets add their layers in a group, in one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await page.evaluate(() => window.pigmentApp.panels.show('adjustments', { reveal: true }));
  await expect(page.locator('.adjustments-panel .adjustment-presets')).toBeVisible();
  const n = await historyLength(page);
  await page.locator('.adjust-preset-group[data-group="creative"] > summary').click();
  await page.locator('.adjust-preset[data-preset="creative/vintage-fade"]').click();
  const tree = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const top = d.root.children[d.root.children.length - 1];
    return [top.type, top.name, top.children?.map((c) => c.kind)];
  });
  expect(tree).toEqual(['group', 'Vintage Fade', ['curves', 'hue-saturation', 'grain']]);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(1);
  // a one-layer preset adds just that layer
  await runAwait(page, 'layer:adjustment-preset', 'black-white/infrared');
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.kind, window.pigmentApp.doc.active.params.yellows])).toEqual(['black-white', 235]);
  expect(errors).toEqual([]);
});

test('Adjustment Brush: the first stroke adds a masked adjustment layer and reveals it where painted; Alt subtracts; one undo', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('adjustment-brush');
    app.tools.setOpt('adjustment-brush', 'kind', 'invert');
    app.tools.setOpt('adjustment-brush', 'size', 30);
    app.tools.setOpt('adjustment-brush', 'hardness', 1);
  });
  expect(await page.evaluate(() => window.pigmentApp.tools.slots.find((s) => s.id === 'brush').tools)).toContain('adjustment-brush');
  const n = await historyLength(page);
  await drag(page, [20, 150], [80, 150]);
  await expect.poll(() => pixel(page, 50, 150)).toEqual([0, 255, 255, 255]); // red inverted to cyan under the stroke
  expect(await pixel(page, 50, 20)).toEqual([255, 0, 0, 255]); // elsewhere untouched
  const layer = await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.kind]);
  expect(layer).toEqual(['adjustment', 'invert']);
  expect(await historyLength(page)).toBe(n + 1);
  // a second stroke paints the same layer's mask
  await drag(page, [150, 150], [180, 150]);
  await expect.poll(() => pixel(page, 165, 150)).toEqual([255, 255, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(2);
  // Alt subtracts
  await drag(page, [150, 150], [180, 150], { modifiers: ['Alt'] });
  await expect.poll(() => pixel(page, 165, 150)).toEqual([0, 0, 255, 255]);
  // undo three times: the layer is gone
  for (let i = 0; i < 3; i++) await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(1);
  expect(await pixel(page, 50, 150)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.tools.get('adjustment-brush').paints)).toBe(true);
  expect(errors).toEqual([]);
});
