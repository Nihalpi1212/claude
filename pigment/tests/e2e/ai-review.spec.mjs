// AI regressions from the review of the bug-hunt fixes: a cancelled Generative Expand takes its resize
// back, dialogs remember the provider they were last used with, unreadable JSON arguments are errors
// for the model, JSON scalars reach commands decoded, add_text treats null as the default, Stop ends
// the turn while a request is in flight, the sky mask stays opaque at the canvas border, and filter
// defaults are the advertised ones. Fake transport only.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, confirmDialog, historyLength } from './helpers.mjs';

const MODELS = {
  openai: { data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }] },
  gemini: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }] },
};

const installFakeAi = (page, answer, delayMs = 0) =>
  page.evaluate(({ body, models, delay }) => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    t.ai = {
      request: async (payload) => {
        t.aiCalls.push(JSON.parse(JSON.stringify(payload)));
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (body === 'fail') throw Object.assign(new Error('provider down'), { code: 'server' });
        return body;
      },
      models: async ({ provider }) => models[provider],
    };
  }, { body: answer, models: MODELS, delay: delayMs });

const callTool = (page, name, args) =>
  page.evaluate(async ([n, a]) => {
    try {
      return { ok: await window.pigmentApp.assistant.callTool(n, a) };
    } catch (err) {
      return { error: err.message };
    }
  }, [name, args]);

test('a failed Generative Expand takes its canvas resize back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await installFakeAi(page, 'fail');
  const n = await historyLength(page);
  await run(page, 'ai:generative-expand');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await dialog.locator('textarea[data-key="prompt"]').fill('more');
  await dialog.locator('input[data-key="width"]').fill('300');
  await confirmDialog(page);
  await expect(page.locator('.toast.error')).toContainText('Generative Expand failed');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 150]);
  expect(await historyLength(page)).toBe(n);
  expect(errors.filter((e) => !/provider down/.test(e))).toEqual([]);
});

test('a feature dialog opens on the provider it was last used with', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 64, height: 64 });
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    c.getContext('2d').fillRect(0, 0, 4, 4);
    return c.toDataURL('image/png').split(',')[1];
  });
  await installFakeAi(page, { data: [{ b64_json: png }], candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] });
  await page.evaluate(() => window.pigmentApp.ai.setPrefs({ defaultProvider: 'openai' }));
  await run(page, 'ai:generate-image');
  let dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog.locator('select[data-key="provider"]')).toHaveValue('openai');
  await dialog.locator('select[data-key="provider"]').selectOption('gemini');
  await expect(dialog.locator('select[data-key="model"]')).toHaveValue('gemini-2.5-flash-image');
  await dialog.locator('textarea[data-key="prompt"]').fill('x');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(1);
  await run(page, 'ai:generate-image');
  dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog.locator('select[data-key="provider"]')).toHaveValue('gemini');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('assistant arguments: unreadable JSON params are an error, JSON scalars are decoded, null text fields use the defaults', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 240, height: 120 });
  const n = await historyLength(page);
  const bad = await callTool(page, 'apply_filter', { kind: 'gaussian-blur', params: "{'radius': 0.1}" });
  expect(bad.error).toMatch(/params must be a JSON object/);
  expect(await historyLength(page)).toBe(n);
  const id = await page.evaluate(() => window.pigmentApp.doc.active.id);
  await callTool(page, 'new_layer', { name: 'Top' });
  const blend = await callTool(page, 'run_command', { id: 'layer:blend', arg: '"multiply"' });
  expect(blend.error).toBeUndefined();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.blend)).toBe('multiply');
  void id;
  const t = await callTool(page, 'add_text', { text: 'Hello', x: null, y: null, size: null, color: null });
  expect(t.ok?.id).toBeTruthy();
  const font = await page.evaluate(() => ({ size: window.pigmentApp.doc.active.font.size, x: window.pigmentApp.doc.active.x, y: window.pigmentApp.doc.active.y }));
  expect(font).toEqual({ size: 12, x: 24, y: 24 });
  expect(errors).toEqual([]);
});

test('Stop ends the turn at once while a model request is still in flight', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await installFakeAi(page, { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'late answer' }] }] }, 3000);
  await runAwait(page, 'ai:assistant');
  const panel = page.locator('[data-panel="assistant"].panel');
  await panel.locator('.assistant-input').fill('think hard');
  await panel.locator('.assistant-input').press('Enter');
  await expect(panel.locator('.assistant-stop')).toBeVisible();
  const t0 = Date.now();
  await panel.locator('.assistant-stop').click();
  await expect(panel.locator('.assistant-msg.assistant-assistant .assistant-text')).toHaveText('Stopped.');
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(await page.evaluate(() => window.pigmentApp.assistant.isRunning())).toBe(false);
  await page.waitForTimeout(3200);
  await expect(panel.locator('.assistant-msg.assistant-assistant .assistant-text')).toHaveText('Stopped.');
  expect(errors).toEqual([]);
});

test('the sky mask is fully opaque at the canvas border', async ({ page }) => {
  const errors = await openApp(page);
  const a = await page.evaluate(async () => {
    const { skyMask } = await import('/lib/ai/features.js');
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#6aa8ff';
    ctx.fillRect(0, 0, 200, 50);
    ctx.fillStyle = '#204010';
    ctx.fillRect(0, 50, 200, 50);
    const m = skyMask(c).getContext('2d');
    return [[0, 0], [100, 0], [0, 20], [199, 0], [100, 25]].map(([x, y]) => m.getImageData(x, y, 1, 1).data[3]);
  });
  expect(a).toEqual([255, 255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('apply_filter starts from the advertised defaults, not the last dialog run', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  const seen = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.settings.filterParams = { ...(app.settings.filterParams ?? {}), shear: { __bend: 40, edge: 'transparent' } };
    let got = null;
    const def = app.commands.commands.get('filter:shear');
    const orig = def.run;
    def.run = (arg) => {
      got = arg;
    };
    try {
      await app.assistant.callTool('apply_filter', { kind: 'shear', params: { points: [[0, 0], [0.5, -0.2], [1, 0]] } });
    } finally {
      def.run = orig;
    }
    return got;
  });
  expect(seen.__bend).toBeUndefined();
  expect(seen.points).toEqual([[0, 0], [0.5, -0.2], [1, 0]]);
  expect(errors).toEqual([]);
});
