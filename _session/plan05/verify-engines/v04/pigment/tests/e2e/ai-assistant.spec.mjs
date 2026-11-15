// AI Assistant regressions (bug hunt 3): Gemini-compatible tool declarations, Stop ending the turn,
// rectangle intersection, per-kind filter ranges, canvas extension colour, null properties, transparent
// fills, the tool-round limit, commands that open dialogs, and the input surviving a cancelled sign-in.
// Everything runs against the fake transport (window.__pigmentTest.ai); no provider is ever called.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel, layerPixel } from './helpers.mjs';

const MODELS = { openai: { data: [{ id: 'gpt-5' }] }, gemini: { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] } };

/** Fake transport: `answers` are returned in order (the last one repeats); `delayMs` waits before each answer. */
const installFakeAi = (page, answers, delayMs = 0) =>
  page.evaluate(({ list, models, delay }) => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    const queue = list.slice();
    t.ai = {
      request: async (payload) => {
        t.aiCalls.push(JSON.parse(JSON.stringify(payload)));
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return queue.length > 1 ? queue.shift() : queue[0];
      },
      models: async ({ provider }) => models[provider],
    };
  }, { list: answers, models: MODELS, delay: delayMs });

const callTool = (page, name, args) =>
  page.evaluate(async ([n, a]) => {
    try {
      return { ok: await window.pigmentApp.assistant.callTool(n, a) };
    } catch (err) {
      return { error: err.message };
    }
  }, [name, args]);

const docSize = (page) => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height]);
const selBounds = (page) => page.evaluate(() => (window.pigmentApp.doc.selection && !window.pigmentApp.doc.selection.isEmpty ? window.pigmentApp.doc.selection.bounds : null));

test('Gemini gets typed declarations without empty objects, and JSON-string arguments are understood', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  await installFakeAi(page, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }]);
  const decls = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.ai.providers.chat({ provider: 'gemini', model: 'gemini-2.5-flash', instructions: 'x', messages: [{ role: 'user', text: 'hi' }], tools: app.assistant.tools, onToolCall: async () => 'ok' });
    return window.__pigmentTest.aiCalls[0].json.tools[0].functionDeclarations;
  });
  const walk = (schema, path, out) => {
    if (!schema || typeof schema !== 'object') return;
    if (!schema.type) out.push(`${path}: no type`);
    if (schema.type === 'object' && !Object.keys(schema.properties ?? {}).length) out.push(`${path}: empty object`);
    for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${path}.${k}`, out);
    if (schema.items) walk(schema.items, `${path}[]`, out);
  };
  const problems = [];
  for (const d of decls) if (d.parameters) walk(d.parameters, d.name, problems);
  expect(problems).toEqual([]);
  expect(decls.find((d) => d.name === 'get_document').parameters).toBeUndefined();
  expect(decls.find((d) => d.name === 'apply_filter').parameters.properties.params.type).toBe('string');
  expect(decls.find((d) => d.name === 'run_command').parameters.properties.arg.type).toBe('string');
  expect(decls.find((d) => d.name === 'select').parameters.properties.kind.enum).toContain('rect');
  // the string forms come back through the tools as real values
  const sel = await callTool(page, 'select', { kind: 'rect', rect: '{"x":10,"y":20,"width":30,"height":40}' });
  expect(sel.ok).toEqual({ selection: { x: 10, y: 20, width: 30, height: 40 } });
  const adj = await callTool(page, 'apply_adjustment', { kind: 'hue-saturation', params: '{"lightness":-100}' });
  expect(adj.ok).toMatch(/Applied/);
  expect(await pixel(page, 20, 30)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Stop ends the turn: no further provider requests after the current step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80 });
  // a model that always asks for another tool call, 200 ms per request
  await installFakeAi(page, [{ output: [{ type: 'function_call', call_id: 'c', name: 'get_document', arguments: '{}' }] }], 200);
  await runAwait(page, 'ai:assistant');
  const panel = page.locator('[data-panel="assistant"].panel');
  await panel.locator('.assistant-input').fill('loop forever');
  await panel.locator('.assistant-input').press('Enter');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBeGreaterThanOrEqual(2);
  await panel.locator('.assistant-stop').click();
  const atStop = await page.evaluate(() => window.__pigmentTest.aiCalls.length);
  await expect(panel.locator('.assistant-msg.assistant-assistant .assistant-text')).toHaveText('Stopped.');
  await expect(panel.locator('.assistant-stop')).toBeHidden();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__pigmentTest.aiCalls.length);
  expect(after).toBeLessThanOrEqual(atStop + 1);
  expect(await page.evaluate(() => window.pigmentApp.assistant.isRunning())).toBe(false);
  expect(errors).toEqual([]);
});

test('rectangles are intersected with the canvas; empty intersections are errors, not 1 px crops', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 400 });
  expect((await callTool(page, 'select', { kind: 'rect', rect: { x: 1000, y: 1000, width: 100, height: 100 } })).error).toMatch(/outside the canvas/);
  expect(await selBounds(page)).toBeNull();
  expect((await callTool(page, 'select', { kind: 'rect', rect: { x: -100, y: -100, width: 300, height: 300 } })).ok).toEqual({ selection: { x: 0, y: 0, width: 200, height: 200 } });
  expect((await callTool(page, 'select', { kind: 'rect', rect: { x: 10, y: 10, width: 0, height: 5 } })).error).toMatch(/positive/);
  expect((await callTool(page, 'crop', { rect: { x: 1000, y: 1000, width: 100, height: 100 } })).error).toMatch(/outside the canvas/);
  expect(await docSize(page)).toEqual([300, 400]);
  expect((await callTool(page, 'crop', { rect: { x: 250, y: 350, width: 500, height: 500 } })).ok).toBe('Cropped to 50 × 50');
  expect(await docSize(page)).toEqual([50, 50]);
  expect(errors).toEqual([]);
});

test('apply_filter uses the filter dialog ranges per kind (vignette size 0..1 darkens the corners)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 200, background: 'custom', backgroundColor: '#808080' });
  const r = await callTool(page, 'apply_filter', { kind: 'vignette', params: { amount: -100, size: 0.5 } });
  expect(r.ok).toMatch(/Applied Vignette/);
  const corner = await pixel(page, 2, 2);
  const centre = await pixel(page, 100, 100);
  expect(corner[0]).toBeLessThan(centre[0] - 60);
  expect(centre[0]).toBe(128);
  // mosaic keeps its own range (a cell size of 0.5 clamps up to 2, not to 0)
  expect((await callTool(page, 'apply_filter', { kind: 'mosaic', params: { size: 0.5 } })).ok).toMatch(/Applied Mosaic/);
  expect(errors).toEqual([]);
});

test('canvas_size extends an opaque Background with the background colour, like the dialog', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  await page.evaluate(() => {
    window.pigmentApp.settings.background = '#00ff00';
  });
  const r = await callTool(page, 'canvas_size', { width: 200, height: 100, anchor: 'w' });
  expect(r.ok).toMatch(/200 × 100; the added area is filled with #00ff00/);
  expect(await pixel(page, 150, 50)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  // a transparent document stays transparent
  await newDoc(page, { width: 50, height: 50, background: 'transparent' });
  const t = await callTool(page, 'canvas_size', { width: 100, height: 50, anchor: 'w' });
  expect(t.ok).toMatch(/transparent/);
  expect((await pixel(page, 75, 25))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('set_layer_props: null leaves a property unchanged; an empty name is refused', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await page.evaluate(() => window.pigmentApp.doc.active.id);
  expect((await callTool(page, 'set_layer_props', { id, opacity: null, visible: null, name: null })).error).toMatch(/Nothing to change/);
  expect((await callTool(page, 'set_layer_props', { id, name: '   ' })).error).toMatch(/name is empty/);
  expect((await callTool(page, 'set_layer_props', { id, opacity: null, name: 'Renamed' })).ok).toMatch(/Updated Renamed: name/);
  const l = await page.evaluate(() => ({ opacity: window.pigmentApp.doc.active.opacity, visible: window.pigmentApp.doc.active.visible, name: window.pigmentApp.doc.active.name }));
  expect(l).toEqual({ opacity: 1, visible: true, name: 'Renamed' });
  expect(errors).toEqual([]);
});

test('fill_selection honours alpha: transparent clears, half alpha fills at 50 %', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  await callTool(page, 'select', { kind: 'rect', rect: { x: 10, y: 10, width: 20, height: 20 } });
  expect((await callTool(page, 'fill_selection', { color: 'transparent' })).ok).toMatch(/Cleared the selection/);
  expect((await layerPixel(page, 15, 15))[3]).toBe(0);
  expect(await layerPixel(page, 50, 50)).toEqual([255, 255, 255, 255]);
  await callTool(page, 'select', { kind: 'rect', rect: { x: 40, y: 40, width: 20, height: 20 } });
  expect((await callTool(page, 'fill_selection', { color: 'rgba(0,0,255,0.5)' })).ok).toMatch(/#0000ff at 50 % opacity/);
  const p = await layerPixel(page, 50, 50);
  expect(p[2]).toBe(255);
  expect(Math.abs(p[0] - 128)).toBeLessThanOrEqual(2);
  // without a selection a transparent fill clears the layer, never deletes it
  await callTool(page, 'select', { kind: 'none' });
  expect((await callTool(page, 'fill_selection', { color: '#00000000' })).ok).toMatch(/Cleared the layer/);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);
  expect((await layerPixel(page, 90, 90))[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('the tool-round limit is reported instead of a silent "Done."', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  await installFakeAi(page, [{ output: [{ type: 'function_call', call_id: 'c', name: 'get_document', arguments: '{}' }] }]);
  const m = await page.evaluate(() => window.pigmentApp.assistant.send('go on forever', { provider: 'openai', model: 'gpt-5', attach: false }));
  expect(m.truncated).toBe(true);
  expect(m.text).toMatch(/Stopped after 12 tool steps/);
  expect(m.calls).toHaveLength(12);
  expect(await page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(13);
  expect(errors).toEqual([]);
});

test('a command that opens a dialog makes the tool wait for the user instead of running on behind it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  await page.evaluate(() => {
    window.__pigmentTest.toolPromise = window.pigmentApp.assistant.callTool('run_command', { id: 'image:canvas-size' }).then((r) => ({ ok: r }), (e) => ({ error: e.message }));
    window.__pigmentTest.toolDone = false;
    window.__pigmentTest.toolPromise.then(() => (window.__pigmentTest.toolDone = true));
  });
  await expect(page.locator('.dialog-backdrop')).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__pigmentTest.toolDone)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const r = await page.evaluate(() => window.__pigmentTest.toolPromise);
  expect(r.ok).toMatch(/closed it/);
  expect(await docSize(page)).toEqual([200, 100]);
  expect(errors).toEqual([]);
});

test('a message typed while nothing is connected survives a cancelled accounts dialog', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const t = (window.__pigmentTest ||= {});
    t.aiCalls = [];
    t.ai = { request: async () => ({}), status: async () => ({ available: true, encryption: true, openai: { method: null }, gemini: { method: null } }), models: async () => ({ data: [] }) };
  });
  await runAwait(page, 'ai:assistant');
  const panel = page.locator('[data-panel="assistant"].panel');
  await panel.locator('.assistant-input').fill('make it blue');
  await panel.locator('.assistant-input').press('Enter');
  const accounts = page.locator('.dialog-backdrop .ai-accounts-dialog');
  await expect(accounts).toBeVisible();
  await accounts.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await expect(panel.locator('.assistant-input')).toHaveValue('make it blue');
  await expect(panel.locator('.assistant-msg')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pigmentTest.aiCalls.length)).toBe(0);
  expect(errors).toEqual([]);
});
