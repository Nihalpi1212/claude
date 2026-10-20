// AI feature regressions (bug hunt 3): Generative Expand sizing, unsaved generated documents, answers
// that keep their proportions, full coverage along the canvas border, DALL·E request sizes, the
// preferred provider, Gemini transparency, Enter in the key field, browser key validation and
// existing masks in Remove Background. Fake transport only; no provider is ever called.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, confirmDialog } from './helpers.mjs';

const MODELS = {
  openai: { data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }, { id: 'dall-e-2' }] },
  gemini: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }] },
};

const installFakeAi = (page, answers) =>
  page.evaluate(({ list, models }) => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    const queue = list.slice();
    t.ai = {
      request: async (payload) => {
        t.aiCalls.push(JSON.parse(JSON.stringify(payload)));
        return queue.length > 1 ? queue.shift() : queue[0];
      },
      models: async ({ provider }) => models[provider],
    };
  }, { list: answers, models: MODELS });

/** A PNG (base64) drawn in the page by `draw(ctx, w, h)` (a function body as a string). */
const drawnPng = (page, w, h, draw) =>
  page.evaluate(([pw, ph, body]) => {
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');
    new Function('ctx', 'w', 'h', body)(ctx, pw, ph);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [w, h, draw]);

const solidPng = (page, w, h, color) => drawnPng(page, w, h, `ctx.fillStyle = '${color}'; ctx.fillRect(0, 0, w, h);`);
/** A fake answer body that satisfies both providers' decoders. */
const bothAnswers = (b64) => ({ data: [{ b64_json: b64 }], candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] });

const selectRect = (page, rect) =>
  page.evaluate(async (r) => {
    const { Selection } = await import('./lib/selection.js');
    const d = window.pigmentApp.doc;
    window.pigmentApp.applySelection(Selection.fromRect(d.width, d.height, r), 'replace', 'Test selection');
  }, rect);
const layerNames = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
const docSize = (page) => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height]);

test('generative expand grows the canvas itself with a transparent extension when a larger size is entered', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await installFakeAi(page, [{ data: [{ b64_json: await solidPng(page, 4, 4, '#00ff00') }] }]);
  // the Canvas Size dialog fills the band of an opaque Background by default: nothing is transparent
  await runAwait(page, 'image:canvas-size', { width: 250, height: 150, anchor: 'w', color: '#ffffff' });
  expect(await pixel(page, 225, 75)).toEqual([255, 255, 255, 255]);
  await run(page, 'ai:generative-expand');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog.locator('.dialog-header h2')).toHaveText('Generative Expand');
  await dialog.locator('textarea[data-key="prompt"]').fill('more grass');
  await dialog.locator('input[data-key="width"]').fill('350');
  await dialog.locator('select[data-key="anchor"]').selectOption('w');
  await confirmDialog(page);
  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Generative Expand']);
  expect(await docSize(page)).toEqual([350, 150]);
  expect(await pixel(page, 300, 75)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 225, 75)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 50, 75)).toEqual([255, 255, 255, 255]);
  expect((await layerPixel(page, 100, 75))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('a generated new document counts as unsaved, closing asks, and the generation is one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await installFakeAi(page, [{ data: [{ b64_json: await solidPng(page, 4, 4, '#ff0000') }] }]);
  await run(page, 'ai:generate-image');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog.locator('.dialog-header h2')).toHaveText('Generate Image');
  await dialog.locator('textarea[data-key="prompt"]').fill('a red ball');
  await dialog.locator('input[data-key="width"]').fill('64');
  await dialog.locator('input[data-key="height"]').fill('48');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.width ?? 0)).toBe(64);
  expect(await page.evaluate(() => ({ dirty: window.pigmentApp.doc.history.dirty, label: window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index]?.label }))).toEqual({ dirty: true, label: 'Generate Image' });
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  await runAwait(page, 'edit:undo');
  expect((await pixel(page, 10, 10))[3]).toBe(0);
  await runAwait(page, 'edit:redo');
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  // closing prompts about unsaved changes (answered with Cancel here)
  const prompt = await page.evaluate(async () => {
    const seen = [];
    window.__pigmentTest.autoRespond = (o) => {
      seen.push(o.message ?? '');
      const i = (o.buttons ?? []).findIndex((b) => /cancel/i.test(b));
      return i >= 0 ? i : 0;
    };
    await window.pigmentApp.commands.run('file:close', undefined, 'api');
    delete window.__pigmentTest.autoRespond;
    return { seen, stillOpen: !!window.pigmentApp.doc };
  });
  expect(prompt.seen.join(' ')).toMatch(/save/i);
  expect(prompt.stillOpen).toBe(true);
  expect(errors).toEqual([]);
});

test('generate image keeps the proportions of the answer: cover and crop, never stretch', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  // a 2:1 answer with a red band at x 75..125: covering a square keeps the band 50 px wide
  const wide = await drawnPng(page, 200, 100, "ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#ff0000'; ctx.fillRect(75, 0, 50, h);");
  await installFakeAi(page, [{ data: [{ b64_json: wide }] }]);
  await run(page, 'ai:generate-image');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await dialog.locator('textarea[data-key="prompt"]').fill('stripes');
  await confirmDialog(page);
  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Generated 1']);
  expect(await pixel(page, 30, 50)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 70, 50)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 10, 50)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 90, 50)).toEqual([0, 0, 255, 255]);
  expect((await page.evaluate(() => window.__pigmentTest.aiCalls))[0].json.size).toBe('1024x1024');
  expect(errors).toEqual([]);
});

test('generative fill keeps full coverage where the selection touches the canvas border', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 200 });
  await installFakeAi(page, [{ data: [{ b64_json: await solidPng(page, 4, 4, '#ff0000') }] }]);
  await selectRect(page, { x: 0, y: 0, width: 100, height: 100 });
  await run(page, 'ai:generative-fill');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await dialog.locator('textarea[data-key="prompt"]').fill('red');
  await confirmDialog(page);
  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Generative Fill']);
  for (const [x, y] of [[0, 50], [50, 0], [0, 0], [50, 50]]) {
    expect(await layerPixel(page, x, y)).toEqual([255, 0, 0, 255]);
    expect(await pixel(page, x, y)).toEqual([255, 0, 0, 255]);
  }
  // the inner edge of the selection is still feathered (a soft 1 px fall-off), then nothing
  expect((await layerPixel(page, 100, 50))[3]).toBeLessThan(255);
  expect((await layerPixel(page, 104, 50))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('DALL·E models get sizes and fields they accept; dall-e-3 is refused for edits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await installFakeAi(page, [{ data: [{ b64_json: await solidPng(page, 4, 4, '#ff0000') }] }]);
  const r = await page.evaluate(async () => {
    const p = window.pigmentApp.ai.providers;
    const img = document.createElement('canvas');
    img.width = 300;
    img.height = 200;
    await p.generateImage({ provider: 'openai', model: 'dall-e-3', prompt: 'x', width: 400, height: 300 });
    let refused = null;
    try {
      await p.editImage({ provider: 'openai', model: 'dall-e-3', image: img, prompt: 'x' });
    } catch (err) {
      refused = err.message;
    }
    await p.editImage({ provider: 'openai', model: 'dall-e-2', image: img, prompt: 'x' });
    await p.generateImage({ provider: 'openai', model: 'gpt-image-1', prompt: 'x', width: 400, height: 300 });
    return { calls: window.__pigmentTest.aiCalls, refused };
  });
  expect(r.refused).toMatch(/dall-e-3 cannot edit/);
  expect(r.calls[0].json).toMatchObject({ model: 'dall-e-3', size: '1792x1024', response_format: 'b64_json' });
  expect(r.calls[0].json.quality).toBeUndefined();
  expect(r.calls[1].path).toBe('/images/edits');
  expect(r.calls[1].multipart.fields).toMatchObject({ model: 'dall-e-2', size: '512x512', response_format: 'b64_json' });
  expect(r.calls[1].multipart.files.map((f) => f.field)).toEqual(['image']);
  expect(r.calls[2].json).toMatchObject({ model: 'gpt-image-1', size: '1536x1024', quality: 'auto', background: 'auto' });
  expect(errors).toEqual([]);
});

test('the preferred provider decides for dialog-less features, whatever the last dialog used', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 60 });
  const subject = await drawnPng(page, 60, 60, "ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#0000ff'; ctx.fillRect(20, 20, 20, 20);");
  await installFakeAi(page, [bothAnswers(subject)]);
  await page.evaluate(() => window.pigmentApp.ai.setPrefs({ imageProvider: 'gemini', defaultProvider: 'openai' }));
  await runAwait(page, 'ai:remove-background');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(1);
  expect((await page.evaluate(() => window.__pigmentTest.aiCalls))[0].provider).toBe('openai');
  await runAwait(page, 'edit:undo');
  await page.evaluate(() => window.pigmentApp.ai.setPrefs({ defaultProvider: 'gemini' }));
  await runAwait(page, 'ai:remove-background');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(2);
  expect((await page.evaluate(() => window.__pigmentTest.aiCalls))[1].provider).toBe('gemini');
  expect(errors).toEqual([]);
});

test('generate image with a transparent background on Gemini asks for white and keys it out', async ({ page }) => {
  const errors = await openApp(page);
  const sticker = await drawnPng(page, 40, 40, "ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#00ff00'; ctx.fillRect(10, 10, 20, 20);");
  await installFakeAi(page, [bothAnswers(sticker)]);
  const r = await page.evaluate(async () => {
    const c = await window.pigmentApp.ai.providers.generateImage({ provider: 'gemini', model: 'gemini-2.5-flash-image', prompt: 'a sticker', width: 40, height: 40, transparent: true });
    const ctx = c.getContext('2d');
    return { corner: Array.from(ctx.getImageData(2, 2, 1, 1).data), centre: Array.from(ctx.getImageData(20, 20, 1, 1).data), text: window.__pigmentTest.aiCalls[0].json.contents[0].parts[0].text };
  });
  expect(r.corner[3]).toBe(0);
  expect(r.centre).toEqual([0, 255, 0, 255]);
  expect(r.text).toMatch(/pure white/);
  expect(errors).toEqual([]);
});

test('Enter in an API key field connects and keeps the AI Accounts dialog open', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    let connected = false;
    const status = () => ({ available: true, encryption: true, openai: { method: connected ? 'api_key' : null }, gemini: { method: null } });
    t.ai = { request: async () => ({}), status: async () => status(), setApiKey: async ({ key }) => ((connected = key === 'sk-good'), status()), models: async () => ({ data: [{ id: 'gpt-5' }] }) };
  });
  await run(page, 'ai:accounts');
  const dialog = page.locator('.dialog-backdrop .ai-accounts-dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.locator('.ai-card-openai input[type="password"]');
  await input.fill('sk-good');
  await input.press('Enter');
  await expect(dialog.locator('.ai-card-openai .ai-state')).toContainText('Connected with an API key');
  await expect(dialog).toBeVisible();
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('browser build: a rejected API key is not stored', async ({ page }) => {
  const errors = await openApp(page);
  await page.route('https://api.openai.com/v1/models', (route) => {
    const auth = route.request().headers().authorization ?? '';
    if (auth === 'Bearer sk-good') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-5' }] }) });
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }) });
  });
  const r = await page.evaluate(async () => {
    delete window.__pigmentTest.ai;
    const { aiCall } = await import('./lib/ai/client.js');
    let bad = null;
    try {
      await aiCall('setApiKey', { provider: 'openai', key: 'sk-bad' });
    } catch (err) {
      bad = err.message;
    }
    const afterBad = JSON.parse(localStorage.getItem('pigment.ai.keys') || '{}');
    const status = await aiCall('setApiKey', { provider: 'openai', key: 'sk-good' });
    return { bad, afterBad, method: status.openai.method, stored: JSON.parse(localStorage.getItem('pigment.ai.keys')).openai };
  });
  expect(r.bad).toMatch(/Incorrect API key/);
  expect(r.afterBad).toEqual({});
  expect(r.method).toBe('api_key');
  expect(r.stored).toBe('sk-good');
  // the browser logs the faked 401 itself; nothing else may fail
  expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
});

test('remove background keeps what an existing layer mask already hid', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  const subject = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const ctx = d.active.canvas.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(30, 30, 40, 40);
    d.active.touch();
    d.changed('pixels', { layer: d.active });
    return d.active.canvas.toDataURL('image/png').split(',')[1];
  });
  // a mask that reveals only the top half
  await selectRect(page, { x: 0, y: 0, width: 100, height: 50 });
  await runAwait(page, 'layer:mask', 'reveal-selection');
  await runAwait(page, 'select:none');
  await page.evaluate(() => window.pigmentApp.setEditingMask(false));
  expect((await pixel(page, 50, 60))[3]).toBe(0);
  await installFakeAi(page, [bothAnswers(subject)]);
  await page.evaluate(() => window.pigmentApp.ai.setPrefs({ defaultProvider: 'gemini' }));
  await runAwait(page, 'ai:remove-background');
  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Background (no background)']);
  const state = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const m = d.active.mask.canvas.getContext('2d');
    return { top: m.getImageData(50, 40, 1, 1).data[3], bottom: m.getImageData(50, 60, 1, 1).data[3] };
  });
  expect(state).toEqual({ top: 255, bottom: 0 });
  expect(await pixel(page, 50, 40)).toEqual([0, 0, 255, 255]);
  expect((await pixel(page, 50, 60))[3]).toBe(0);
  // the model saw the masked pixels as transparent
  const sent = await page.evaluate(async () => {
    const part = window.__pigmentTest.aiCalls[0].json.contents[0].parts[1];
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = `data:image/png;base64,${part.inline_data.data}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { top: ctx.getImageData(50, 40, 1, 1).data[3], bottom: ctx.getImageData(50, 60, 1, 1).data[3], size: [c.width, c.height] };
  });
  expect(sent.size).toEqual([100, 100]);
  expect(sent.top).toBe(255);
  expect(sent.bottom).toBe(0);
  expect(errors).toEqual([]);
});
