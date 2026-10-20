// AI features: Generative Fill / Expand, Remove Background, the Assistant panel and Describe Image, all
// against a fake transport (window.__pigmentTest.ai) so no provider is ever called. Each test asserts the
// request the feature built and the pixels / layers produced from the fake answer.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

const MODELS = { openai: { data: [{ id: 'gpt-5' }, { id: 'gpt-image-1' }] }, gemini: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }] } };

/** Installs the fake transport: `answer(payload)` returns the body; every payload is recorded in aiCalls. */
const installFakeAi = (page, answers) =>
  page.evaluate(({ list, models }) => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    const queue = list.slice();
    t.ai = {
      request: async (payload) => {
        t.aiCalls.push(JSON.parse(JSON.stringify(payload)));
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next;
      },
      models: async ({ provider }) => models[provider],
    };
  }, { list: answers, models: MODELS });

/** A solid PNG (base64) of the given size and colour, drawn in the page. */
const solidPng = (page, w, h, color) =>
  page.evaluate(([pw, ph, c]) => {
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, pw, ph);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [w, h, color]);

const selectRect = (page, rect) =>
  page.evaluate(async (r) => {
    const { Selection } = await import('./lib/selection.js');
    const d = window.pigmentApp.doc;
    window.pigmentApp.applySelection(Selection.fromRect(d.width, d.height, r), 'replace', 'Test selection');
  }, rect);

const layerNames = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
const activeName = (page) => page.evaluate(() => window.pigmentApp.doc.active?.name ?? null);

test('generative fill: a new layer holds the answer inside the selection, the request carried the mask and the prompt', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page); // 400 x 300, white Background
  const red = await solidPng(page, 4, 4, '#ff0000');
  await installFakeAi(page, [{ data: [{ b64_json: red }] }]);
  await selectRect(page, { x: 100, y: 100, width: 80, height: 60 });

  await run(page, 'ai:generative-fill');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dialog-header h2')).toHaveText('Generative Fill');
  await expect(dialog.locator('select[data-key="model"]')).toHaveValue('gpt-image-1');
  await dialog.locator('textarea[data-key="prompt"]').fill('a red ball');
  await confirmDialog(page);

  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Generative Fill']);
  expect(await activeName(page)).toBe('Generative Fill');
  // inside the selection the answer shows; outside the document is untouched (white) and the new layer transparent
  expect(await pixel(page, 140, 130)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 300, 250)).toEqual([255, 255, 255, 255]);
  expect(await layerPixel(page, 140, 130)).toEqual([255, 0, 0, 255]);
  expect((await layerPixel(page, 90, 90))[3]).toBe(0);
  expect((await layerPixel(page, 50, 50))[3]).toBe(0);
  // the region sent is the selection padded by 25 % (80x60 -> 120x120), not the whole canvas
  const layer = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
  });
  expect(layer).toEqual({ x: 80, y: 70, w: 120, h: 120 });

  const calls = await page.evaluate(() => window.__pigmentTest.aiCalls);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call.provider).toBe('openai');
  expect(call.path).toBe('/images/edits');
  expect(call.multipart.fields.prompt).toBe('a red ball');
  expect(call.multipart.fields.model).toBe('gpt-image-1');
  expect(call.multipart.files.map((f) => f.field)).toEqual(['image[]', 'mask']);
  // the mask (OpenAI: alpha 0 where the image may change) is transparent inside the selection and opaque outside
  const maskAlpha = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = `data:image/png;base64,${b64}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // the 120x120 region was padded to 1:1 = unchanged; selection at (20,30)-(100,90) in region space
    return { size: [c.width, c.height], inside: ctx.getImageData(60, 60, 1, 1).data[3], outside: ctx.getImageData(5, 5, 1, 1).data[3] };
  }, call.multipart.files[1].base64);
  expect(maskAlpha).toEqual({ size: [120, 120], inside: 0, outside: 255 });

  // the choice is remembered and the whole fill is one undo step
  expect(await page.evaluate(() => window.pigmentApp.ai.prefs())).toMatchObject({ imageProvider: 'openai', openaiImage: 'gpt-image-1' });
  await runAwait(page, 'edit:undo');
  expect(await layerNames(page)).toEqual(['Background']);
  expect(await pixel(page, 140, 130)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'edit:redo');
  expect(await layerNames(page)).toEqual(['Background', 'Generative Fill']);
  expect(errors).toEqual([]);
});

test('generative expand fills only the transparent band added by Canvas Size', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  const green = await solidPng(page, 4, 4, '#00ff00');
  await installFakeAi(page, [{ data: [{ b64_json: green }] }]);
  // without an opts.color the direct call leaves the new band transparent
  await runAwait(page, 'image:canvas-size', { width: 300, height: 150, anchor: 'w' });
  expect((await pixel(page, 250, 75))[3]).toBe(0);

  await run(page, 'ai:generative-expand');
  const dialog = page.locator('.dialog-backdrop .ai-dialog');
  await expect(dialog.locator('.dialog-header h2')).toHaveText('Generative Expand');
  await dialog.locator('textarea[data-key="prompt"]').fill('more grass');
  await confirmDialog(page);

  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Generative Expand']);
  expect(await pixel(page, 250, 75)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 50, 75)).toEqual([255, 255, 255, 255]);
  expect(await layerPixel(page, 250, 75)).toEqual([0, 255, 0, 255]);
  expect((await layerPixel(page, 50, 75))[3]).toBe(0);
  expect((await layerPixel(page, 190, 75))[3]).toBe(0);
  const call = (await page.evaluate(() => window.__pigmentTest.aiCalls))[0];
  expect(call.path).toBe('/images/edits');
  expect(call.multipart.fields.prompt).toBe('more grass');
  expect(call.multipart.files.map((f) => f.field)).toEqual(['image[]', 'mask']);
  // no transparent area: the command explains instead of calling the provider
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  await run(page, 'ai:generative-expand');
  await expect(page.locator('.toast.error')).toContainText('Nothing to expand');
  expect(await page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('remove background turns a subject-on-white answer into a layer mask on a copy of the layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  // the layer: a blue square on white; the fake answer: the same subject on a white background (no alpha)
  const answer = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const ctx = d.active.canvas.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(30, 30, 40, 40);
    d.active.touch();
    d.changed('pixels', { layer: d.active });
    return d.active.canvas.toDataURL('image/png').split(',')[1];
  });
  await installFakeAi(page, [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: answer } }] } }] }]);
  await page.evaluate(() => window.pigmentApp.ai.setPrefs({ imageProvider: 'gemini' }));

  await runAwait(page, 'ai:remove-background');
  await expect.poll(() => layerNames(page)).toEqual(['Background', 'Background (no background)']);
  const state = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const [orig, copy] = d.layers();
    const m = copy.mask.canvas.getContext('2d');
    return { active: d.active.name, origVisible: orig.visible, hasMask: !!copy.mask, maskInside: m.getImageData(50, 50, 1, 1).data[3], maskOutside: m.getImageData(5, 5, 1, 1).data[3], maskEdge: m.getImageData(29, 50, 1, 1).data[3] };
  });
  expect(state).toMatchObject({ active: 'Background (no background)', origVisible: false, hasMask: true, maskInside: 255, maskOutside: 0 });
  expect(state.maskEdge).toBeLessThan(255);
  // the composite shows the subject and nothing around it
  expect(await pixel(page, 50, 50)).toEqual([0, 0, 255, 255]);
  expect((await pixel(page, 5, 5))[3]).toBe(0);
  const call = (await page.evaluate(() => window.__pigmentTest.aiCalls))[0];
  expect(call.provider).toBe('gemini');
  expect(call.path).toBe('/models/gemini-2.5-flash-image:generateContent');
  expect(call.json.contents[0].parts[0].text).toMatch(/remove the background/i);
  expect(call.json.contents[0].parts).toHaveLength(2); // prompt + image, no mask
  // one undo restores the original layer and its visibility
  await runAwait(page, 'edit:undo');
  expect(await layerNames(page)).toEqual(['Background']);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.visible)).toBe(true);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('the assistant panel sends the image, runs a function call through history and shows the final text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await installFakeAi(page, [
    { output: [{ type: 'function_call', call_id: 'c1', name: 'apply_adjustment', arguments: '{"kind":"invert","params":{}}' }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inverted the image.' }] }] },
  ]);
  await runAwait(page, 'ai:assistant');
  const panel = page.locator('[data-panel="assistant"].panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-provider]')).toHaveValue('openai');
  await expect(panel.locator('[data-model]')).toHaveValue('gpt-5');
  const before = await historyLength(page);

  const input = panel.locator('.assistant-input');
  await input.fill('invert it');
  await input.press('Enter');
  await expect(panel.locator('.assistant-msg.assistant-assistant .assistant-text')).toHaveText('Inverted the image.');
  await expect(panel.locator('.assistant-call')).toHaveText('Applied Invert');
  await expect(panel.locator('.assistant-msg.assistant-user .assistant-text')).toHaveText('invert it');
  await expect(panel.locator('.assistant-msg.assistant-user img.assistant-attachment')).toHaveCount(1);
  expect(await pixel(page, 10, 10)).toEqual([0, 0, 0, 255]);
  expect(await historyLength(page)).toBe(before + 1);

  const calls = await page.evaluate(() => window.__pigmentTest.aiCalls);
  expect(calls).toHaveLength(2);
  expect(calls[0].path).toBe('/responses');
  expect(calls[0].json.model).toBe('gpt-5');
  expect(calls[0].json.instructions).toContain('hue-saturation (');
  expect(calls[0].json.instructions).toContain('gaussian-blur (radius=2)');
  expect(calls[0].json.instructions).toContain('image:crop-rect');
  expect(calls[0].json.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_document', 'apply_adjustment', 'apply_filter', 'run_command', 'new_layer', 'set_layer_props', 'select', 'crop', 'resize_image', 'canvas_size', 'fill_selection', 'add_text', 'generative_fill']));
  const content = calls[0].json.input[0].content;
  expect(content[0]).toEqual({ type: 'input_text', text: 'invert it' });
  expect(content[1].type).toBe('input_image');
  expect(content[1].image_url).toMatch(/^data:image\/png;base64,/);
  expect(calls[1].json.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
  expect(calls[1].json.input[2].output).toContain('Applied Invert');

  // undo restores the pixels (with the input focused, Ctrl+Z would edit the text instead); the conversation is kept per document
  await page.evaluate(() => document.activeElement?.blur());
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 10, 10)).toEqual([255, 255, 255, 255]);
  expect(await page.evaluate(() => window.pigmentApp.assistant.messages().length)).toBe(2);
  await newDoc(page, { name: 'Other' });
  await expect(panel.locator('.assistant-msg')).toHaveCount(0);

  // tool guards: bad ids and unknown kinds come back as errors for the model, not exceptions
  const guarded = await page.evaluate(async () => {
    const a = window.pigmentApp.assistant;
    const out = {};
    for (const [name, args] of [['set_active_layer', { id: 'nope' }], ['apply_adjustment', { kind: 'bogus' }], ['run_command', { id: 'file:quit' }], ['set_layer_props', { id: window.pigmentApp.doc.active.id, opacity: 500 }]]) {
      try {
        out[name] = await a.callTool(name, args);
      } catch (err) {
        out[name] = `error: ${err.message}`;
      }
    }
    out.opacity = window.pigmentApp.doc.active.opacity;
    return out;
  });
  expect(guarded.set_active_layer).toMatch(/^error: No layer/);
  expect(guarded.apply_adjustment).toMatch(/^error: Unknown adjustment/);
  expect(guarded.run_command).toMatch(/^error: .*cannot be run/);
  expect(guarded.set_layer_props).toMatch(/Updated/);
  expect(guarded.opacity).toBe(1);
  expect(errors).toEqual([]);
});

test('describe shows the text in a dialog and can store it as the document description', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await installFakeAi(page, [{ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A plain white rectangle with no visible subject.' }] }] }]);
  await run(page, 'ai:describe');
  const dialog = page.locator('.dialog-backdrop .ai-describe-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.ai-describe-text')).toHaveValue('A plain white rectangle with no visible subject.');
  const call = (await page.evaluate(() => window.__pigmentTest.aiCalls))[0];
  expect(call.path).toBe('/responses');
  expect(call.json.input[0].content.some((c) => c.type === 'input_image')).toBe(true);
  await dialog.locator('.dialog-buttons button[data-value="use"]').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.doc.meta.description)).toBe('A plain white rectangle with no visible subject.');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.meta.description ?? '')).toBe('');
  expect(errors).toEqual([]);
});

test('not connected: the feature opens the AI Accounts dialog instead of failing', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    t.ai = { request: async () => ({}), status: async () => ({ available: true, encryption: true, openai: { method: null }, gemini: { method: null } }), models: async () => ({ data: [] }) };
  });
  await run(page, 'ai:describe');
  const accounts = page.locator('.dialog-backdrop .ai-accounts-dialog');
  await expect(accounts).toBeVisible();
  await expect(accounts.locator('.ai-reason')).toContainText('needs an AI provider');
  await accounts.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(0);
  expect(errors).toEqual([]);
});
