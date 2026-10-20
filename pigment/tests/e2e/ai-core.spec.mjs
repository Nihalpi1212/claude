// AI core: providers (tool loops, image edits through a mask, resampling) with a fake transport and the
// AI Accounts dialog. No real provider is ever called: window.__pigmentTest.ai answers every request.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run } from './helpers.mjs';

/** Installs a fake transport that records payloads and answers from a queue (or a function). */
const installFakeAi = (page, answers) =>
  page.evaluate((list) => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    const queue = list.slice();
    t.ai = {
      request: async (payload) => {
        // snapshot: the tool loop grows the same body between rounds
        t.aiCalls.push(JSON.parse(JSON.stringify(payload)));
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return typeof next === 'function' ? next(payload) : next;
      },
    };
  }, answers);

const tools = [{ name: 'get_document', description: 'Document info', parameters: { type: 'object', properties: { detail: { type: 'string' } } } }];

test('OpenAI chat runs the tool loop: input items and function_call_output round trip', async ({ page }) => {
  const errors = await openApp(page);
  await installFakeAi(page, [
    { output: [{ type: 'function_call', call_id: 'call_1', name: 'get_document', arguments: '{"detail":"size"}' }, { type: 'reasoning', id: 'rs_1', summary: [] }] },
    { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The document is 400 × 300.' }] }] },
  ]);
  const result = await page.evaluate(async (tl) => {
    const ai = window.pigmentApp.ai;
    const seen = [];
    const r = await ai.providers.chat({
      provider: 'openai',
      model: 'gpt-5',
      instructions: 'You are Pigment.',
      messages: [{ role: 'user', text: 'How big is it?', images: ['data:image/png;base64,AAAA'] }],
      tools: tl,
      onToolCall: async (name, args) => {
        seen.push([name, args]);
        return { width: 400, height: 300 };
      },
    });
    return { r, seen, calls: window.__pigmentTest.aiCalls };
  }, tools);
  expect(result.r.text).toBe('The document is 400 × 300.');
  expect(result.r.calls).toEqual([{ name: 'get_document', args: { detail: 'size' }, result: { width: 400, height: 300 } }]);
  expect(result.seen).toEqual([['get_document', { detail: 'size' }]]);
  expect(result.calls).toHaveLength(2);
  const first = result.calls[0];
  expect(first.provider).toBe('openai');
  expect(first.path).toBe('/responses');
  expect(first.json.model).toBe('gpt-5');
  expect(first.json.instructions).toBe('You are Pigment.');
  expect(first.json.store).toBe(false);
  expect(first.json.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'How big is it?' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }] }]);
  expect(first.json.tools).toEqual([{ type: 'function', name: 'get_document', description: 'Document info', parameters: tools[0].parameters, strict: false }]);
  const second = result.calls[1].json.input;
  expect(second).toHaveLength(3); // the user turn, the function call, its output (reasoning without encrypted content is dropped)
  expect(second[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'get_document', arguments: '{"detail":"size"}' });
  expect(second[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"width":400,"height":300}' });
  expect(errors).toEqual([]);
});

test('Gemini chat runs the tool loop: parts, functionDeclarations and functionResponse', async ({ page }) => {
  const errors = await openApp(page);
  await installFakeAi(page, [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_document', args: { detail: 'layers' } }, thoughtSignature: 'sig' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Two layers.' }] } }] },
  ]);
  const result = await page.evaluate(async (tl) => {
    const r = await window.pigmentApp.ai.providers.chat({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      instructions: 'Be brief.',
      messages: [{ role: 'user', text: 'Layers?', images: ['data:image/png;base64,QUJD'] }, { role: 'assistant', text: 'Let me check.' }, { role: 'user', text: 'Please.' }],
      tools: tl,
      onToolCall: async () => 'two',
    });
    return { r, calls: window.__pigmentTest.aiCalls };
  }, tools);
  expect(result.r.text).toBe('Two layers.');
  expect(result.r.calls).toEqual([{ name: 'get_document', args: { detail: 'layers' }, result: 'two' }]);
  expect(result.calls).toHaveLength(2);
  const first = result.calls[0];
  expect(first.provider).toBe('gemini');
  expect(first.path).toBe('/models/gemini-2.5-flash:generateContent');
  expect(first.json.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  expect(first.json.contents).toEqual([
    { role: 'user', parts: [{ text: 'Layers?' }, { inline_data: { mime_type: 'image/png', data: 'QUJD' } }] },
    { role: 'model', parts: [{ text: 'Let me check.' }] },
    { role: 'user', parts: [{ text: 'Please.' }] },
  ]);
  expect(first.json.tools).toEqual([{ functionDeclarations: [{ name: 'get_document', description: 'Document info', parameters: tools[0].parameters }] }]);
  const second = result.calls[1].json.contents;
  expect(second).toHaveLength(5);
  expect(second[3]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_document', args: { detail: 'layers' } }, thoughtSignature: 'sig' }] });
  expect(second[4]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'get_document', response: { result: 'two' } } }] });
  expect(errors).toEqual([]);
});

test('editImage composites the answer only inside the mask (OpenAI multipart and Gemini parts)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // a 1x1 red PNG as the fake answer
  const red = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 1, 1);
    return c.toDataURL('image/png').split(',')[1];
  });
  await installFakeAi(page, [{ data: [{ b64_json: red }] }]);
  const out = await page.evaluate(async () => {
    const image = document.createElement('canvas');
    image.width = 120;
    image.height = 80;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 120, 80);
    const mask = document.createElement('canvas');
    mask.width = 120;
    mask.height = 80;
    mask.getContext('2d').fillRect(30, 20, 40, 30); // opaque = may change
    const result = await window.pigmentApp.ai.providers.editImage({ provider: 'openai', model: 'gpt-image-1', image, mask, prompt: 'make it red', transparent: false });
    const px = (x, y) => Array.from(result.getContext('2d').getImageData(x, y, 1, 1).data);
    return { size: [result.width, result.height], inside: px(50, 35), outside: px(10, 10), edge: px(29, 20), calls: window.__pigmentTest.aiCalls };
  });
  expect(out.size).toEqual([120, 80]);
  expect(out.inside).toEqual([255, 0, 0, 255]);
  expect(out.outside).toEqual([0, 0, 255, 255]);
  expect(out.edge).toEqual([0, 0, 255, 255]);
  const call = out.calls[0];
  expect(call.path).toBe('/images/edits');
  expect(call.multipart.fields).toMatchObject({ model: 'gpt-image-1', prompt: 'make it red', size: '1536x1024', output_format: 'png', input_fidelity: 'high', background: 'auto' });
  expect(call.multipart.files.map((f) => [f.field, f.name, f.type])).toEqual([['image[]', 'image.png', 'image/png'], ['mask', 'mask.png', 'image/png']]);
  // the OpenAI mask is transparent where the image may change
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
    // the image was padded to 3:2 (120x80 is already 3:2, so no offset)
    return { size: [c.width, c.height], inside: ctx.getImageData(50, 35, 1, 1).data[3], outside: ctx.getImageData(10, 10, 1, 1).data[3] };
  }, call.multipart.files[1].base64);
  expect(maskAlpha).toEqual({ size: [120, 80], inside: 0, outside: 255 });

  // Gemini: the image and a white-on-black mask go as inline parts; the answer is composited the same way
  await installFakeAi(page, [{ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: red } }] } }] }]);
  const gem = await page.evaluate(async () => {
    const image = document.createElement('canvas');
    image.width = 100;
    image.height = 100;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 100, 100);
    const mask = document.createElement('canvas');
    mask.width = 100;
    mask.height = 100;
    mask.getContext('2d').fillRect(0, 0, 50, 100);
    const result = await window.pigmentApp.ai.providers.editImage({ provider: 'gemini', model: 'gemini-2.5-flash-image', image, mask, prompt: 'red' });
    const px = (x, y) => Array.from(result.getContext('2d').getImageData(x, y, 1, 1).data);
    return { left: px(10, 50), right: px(90, 50), call: window.__pigmentTest.aiCalls[0] };
  });
  expect(gem.left).toEqual([255, 0, 0, 255]);
  expect(gem.right).toEqual([0, 255, 0, 255]);
  expect(gem.call.path).toBe('/models/gemini-2.5-flash-image:generateContent');
  const parts = gem.call.json.contents[0].parts;
  expect(parts).toHaveLength(3);
  expect(parts[0].text).toContain('red');
  expect(parts[0].text).toContain('white area');
  expect(parts[1].inline_data.mime_type).toBe('image/png');
  expect(parts[2].inline_data.mime_type).toBe('image/png');
  expect(gem.call.json.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } });
  expect(errors).toEqual([]);
});

test('generateImage picks the nearest size and resamples the answer to the requested size', async ({ page }) => {
  const errors = await openApp(page);
  const tiny = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 2, 2);
    return c.toDataURL('image/png').split(',')[1];
  });
  await installFakeAi(page, [{ data: [{ b64_json: tiny }] }]);
  const out = await page.evaluate(async () => {
    const c = await window.pigmentApp.ai.providers.generateImage({ provider: 'openai', model: 'gpt-image-1.5', prompt: 'a cat', width: 50, height: 90, transparent: true });
    return { size: [c.width, c.height], px: Array.from(c.getContext('2d').getImageData(25, 45, 1, 1).data), call: window.__pigmentTest.aiCalls[0] };
  });
  expect(out.size).toEqual([50, 90]);
  expect(out.px).toEqual([0x12, 0x34, 0x56, 255]);
  expect(out.call.path).toBe('/images/generations');
  expect(out.call.json).toEqual({ model: 'gpt-image-1.5', prompt: 'a cat', n: 1, size: '1024x1536', quality: 'auto', output_format: 'png', background: 'transparent' });

  await installFakeAi(page, [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: tiny } }] } }] }]);
  const gem = await page.evaluate(async () => {
    const c = await window.pigmentApp.ai.providers.generateImage({ provider: 'gemini', model: 'gemini-3-pro-image-preview', prompt: 'a dog', width: 160, height: 90 });
    return { size: [c.width, c.height], call: window.__pigmentTest.aiCalls[0] };
  });
  expect(gem.size).toEqual([160, 90]);
  expect(gem.call.json.generationConfig).toEqual({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '1K' } });
  expect(gem.call.json.contents).toEqual([{ role: 'user', parts: [{ text: 'a dog' }] }]);

  // model catalogs: defaults follow the preference lists
  await page.evaluate(() => {
    window.__pigmentTest.ai.models = async ({ provider }) => (provider === 'openai' ? { data: [{ id: 'gpt-4o' }, { id: 'gpt-5.1' }, { id: 'gpt-image-1' }, { id: 'whisper-1' }] } : { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }] });
  });
  const lists = await page.evaluate(async () => [await window.pigmentApp.ai.providers.listModels('openai'), await window.pigmentApp.ai.providers.listModels('gemini')]);
  expect(lists[0].chat).toEqual(['gpt-4o', 'gpt-5.1']);
  expect(lists[0].image).toEqual(['gpt-image-1']);
  expect(lists[0].default).toEqual({ chat: 'gpt-5.1', image: 'gpt-image-1' });
  expect(lists[1].default).toEqual({ chat: 'gemini-2.5-flash', image: 'gemini-2.5-flash-image' });
  expect(errors).toEqual([]);
});

test('the AI Accounts dialog opens from ai:accounts, shows both providers and app.ai reports what fits', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const t = (window.__pigmentTest ||= {});
    t.ai = {
      request: async () => ({}),
      status: async () => ({ available: true, encryption: false, openai: { method: 'chatgpt', email: 'me@example.com', plan: true }, gemini: { method: null } }),
      models: async () => ({ data: [{ id: 'gpt-5.1' }] }),
    };
  });
  expect(await page.evaluate(() => window.pigmentApp.commands.has('ai:accounts'))).toBe(true);
  await run(page, 'ai:accounts');
  const dialog = page.locator('.dialog-backdrop .ai-accounts-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.dialog-header h2')).toHaveText('AI Accounts');
  await expect(dialog.locator('.ai-card')).toHaveCount(2);
  await expect(dialog.locator('.ai-card-openai .ai-state')).toContainText('Signed in with ChatGPT · me@example.com');
  await expect(dialog.locator('.ai-card-gemini .ai-state')).toHaveText('Not connected');
  await expect(dialog.locator('.ai-card-gemini')).toContainText('Google offers no plan-based sign-in');
  await expect(dialog.locator('.ai-card-gemini .ai-link')).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
  await expect(dialog.locator('.ai-warning')).toContainText('no secure storage');
  // model preferences: the chat select fills from the catalog, the image select needs an API key under a ChatGPT plan
  await expect(dialog.locator('select[data-ai="openai-chat"]')).toHaveValue('gpt-5.1');
  await expect(dialog.locator('select[data-ai="openai-image"]')).toBeDisabled();
  await dialog.locator('select[data-ai="default-provider"]').selectOption('gemini');
  expect(await page.evaluate(() => window.pigmentApp.ai.prefs().defaultProvider)).toBe('gemini');
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  // app.ai: chat fits through ChatGPT, image does not (the dialog opens, then nothing fits -> null)
  expect(await page.evaluate(() => window.pigmentApp.ai.ensureConnected('chat'))).toBe('openai');
  const statusEvents = await page.evaluate(() => {
    const seen = [];
    window.pigmentApp.on('ai:status', (s) => seen.push(s.openai.method));
    window.__pigmentTest.ai.status = async () => ({ available: true, encryption: true, openai: { method: null }, gemini: { method: null } });
    return window.pigmentApp.ai.status().then(() => seen);
  });
  expect(statusEvents).toEqual([null]);
  const pending = page.evaluate(() => window.pigmentApp.ai.ensureConnected('image'));
  await expect(page.locator('.ai-accounts-dialog .ai-reason')).toContainText('needs an image model');
  await expect(page.locator('.ai-accounts-dialog .ai-chatgpt')).toBeVisible();
  await expect(page.locator('.ai-accounts-dialog .ai-card-openai .ai-link')).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  await page.locator('.ai-accounts-dialog .dialog-buttons .btn.primary').click();
  expect(await pending).toBeNull();
  expect(errors).toEqual([]);
});
