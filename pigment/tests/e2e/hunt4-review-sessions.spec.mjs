// Regressions from the review of the 0.3.1 "sessions" fixes: the Actions panel's Stop while a step keeps Pigment
// busy, Close steps that answer "Save changes?" by themselves, closing the window over open dialogs (Cancel keeps
// them, a progress dialog always stays), Content-Aware Scale as a modal step, the first autofocus field of a window
// and AI requests that leave the commands available.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
const step = (command, arg, extra = {}) => ({ id: `s${Math.random().toString(36).slice(2)}`, command, label: command, arg, enabled: true, dialog: false, ...extra });

test('the Actions panel\'s Stop ends a playing action while one of its steps keeps Pigment busy', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await runAwait(page, 'window:panel-actions');
  await page.evaluate((steps) => {
    const app = window.pigmentApp;
    // a step that computes for a while under app.busy (a filter on a large image, Select Subject…)
    app.commands.register('test:hold', { run: () => app.busy('Working…', () => new Promise((r) => (window.__release = r))) });
    const a = app.actions.newAction({ name: 'Held', steps });
    app.actions.select({ action: a.id });
    window.__played = app.actions.play(a, { quiet: true });
  }, [step('test:hold'), step('image:adjust-invert'), step('image:adjust-invert')]);
  await page.waitForFunction(() => window.pigmentApp.busyDepth > 0 && !!window.__release);
  await page.locator('[data-cmd="actions:stop"]').click();
  expect(await page.evaluate(() => window.pigmentApp.actions.playing?.cancelled)).toBe(true);
  const out = await page.evaluate(async () => {
    window.__release();
    const o = await window.__played;
    return { ok: o.ok, reason: o.reason, index: o.index, history: window.pigmentApp.doc.history.entries.length };
  });
  expect(out).toEqual({ ok: false, reason: 'stop', index: 1, history: 0 }); // nothing after the held step ran
  expect((await toasts(page)).filter((t) => /still working/.test(t))).toEqual([]);
  // other panel gestures still wait meanwhile
  await page.evaluate(() => {
    const app = window.pigmentApp;
    window.__release = null;
    window.__busy = app.busy('Working…', () => new Promise((r) => (window.__release = r)));
  });
  await page.waitForFunction(() => window.pigmentApp.busyDepth > 0 && !!window.__release);
  await page.evaluate(() => window.pigmentApp.commands.run('layer:new', undefined, 'panel'));
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);
  await page.evaluate(async () => {
    window.__release();
    await window.__busy;
  });
  expect(errors).toEqual([]);
});

test('only a played Close step drops changes unasked, Close All always asks, and a loaded step says what it does', async ({ page }) => {
  const errors = await openApp(page);
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const asked = [];
    T.autoRespond = (o) => {
      asked.push(o.message);
      return 2; // Cancel
    };
    for (const name of ['One', 'Two']) {
      await app.newDocument({ width: 40, height: 30, name });
      await app.commands.run('image:adjust-invert', undefined, 'api');
    }
    const names = () => app.docs.list().map((d) => d.name);
    const out = {};
    // code and the assistant passing an answer still get the question
    await app.commands.run('file:close', { save: false }, 'api');
    await app.commands.run('file:close', { save: false }, 'assistant');
    out.byCode = { asked: asked.splice(0), docs: names() };
    // an actions file that hides Close steps under harmless names
    const file = { format: 'pigment-actions', version: 1, sets: [{ name: 'Fx', actions: [
      { name: 'All', steps: [{ label: 'Sharpen', command: 'image:adjust-invert' }, { label: 'Sharpen More', command: 'file:close-all', arg: { save: false } }] },
      { name: 'One', steps: [{ label: 'Sharpen More', command: 'file:close', arg: { save: false } }] },
    ] }] };
    T.files['browser:/fx.pigment-actions'] = new TextEncoder().encode(JSON.stringify(file));
    const [set] = await app.actions.loadFile('browser:/fx.pigment-actions');
    out.labels = set.actions.map((a) => a.steps.map((s) => s.label));
    await app.actions.play(set.actions[0], { quiet: true });
    out.closeAll = { asked: asked.splice(0), docs: names() };
    // the step that now reads "Close: don't save" does what it says
    app.docs.activate(app.docs.list().find((d) => d.name === 'Two'));
    await app.actions.play(set.actions[1], { quiet: true });
    out.closeStep = { asked: asked.splice(0), docs: names() };
    T.autoRespond = undefined;
    return out;
  });
  expect(result.byCode).toEqual({ asked: ['Save changes to "Two" before closing?', 'Save changes to "Two" before closing?'], docs: ['One', 'Two'] });
  expect(result.labels).toEqual([['Sharpen', 'Sharpen More'], ['Close: don’t save']]); // Close All takes no answer
  expect(result.closeAll).toEqual({ asked: ['Save changes to "One" before closing?'], docs: ['One', 'Two'] });
  expect(result.closeStep).toEqual({ asked: [], docs: ['One'] }); // Two, the active one, is gone
  expect(errors).toEqual([]);
});

test('closing the window: Cancel leaves every dialog as it was, Save dismisses previews but never a progress dialog', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/w.pigment'));
  await runAwait(page, 'file:save-as');
  await runAwait(page, 'image:adjust-invert'); // the unsaved change
  // a dialog the user is typing in, and a run's progress dialog (Batch and the Image Processor open it so)
  await page.evaluate(() => {
    window.pigmentApp.commands.run('image:canvas-size', undefined, 'menu');
  });
  const field = page.locator('.dialog input[type="number"]').first();
  await field.fill('123');
  await page.evaluate(() => {
    window.__progress = window.pigmentApp.dialogs.open({ title: 'Batch', content: 'Processing 1 of 6', dismissible: false, buttons: [{ label: 'Cancel', value: 'cancel' }] });
  });
  const close = (answer) => page.evaluate(async (a) => {
    const { bridge } = await import('/lib/bridge.js');
    const t = window.__pigmentTest;
    t.autoRespond = () => a;
    t.closeResponse = undefined;
    bridge.closeWindow();
  }, answer);
  const titles = () => page.evaluate(() => [...document.querySelectorAll('.dialog h2')].map((h) => h.textContent));
  await close(2); // Cancel
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.closeResponse)).toBe(false);
  expect(await titles()).toEqual(['Canvas Size', 'Batch']);
  expect(await field.inputValue()).toBe('123');
  await close(0); // Save
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.closeResponse)).toBe(true);
  expect(await page.evaluate(() => !!window.__pigmentTest.written['browser:/w.pigment'])).toBe(true);
  expect(await titles()).toEqual(['Batch']);
  // the run can still be cancelled
  await page.locator('.dialog button', { hasText: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__progress)).toBe('cancel');
  expect(errors).toEqual([]);
});

test('Content-Aware Scale as a modal step: only Enter on the box lets the action go on', async ({ page }) => {
  const errors = await openApp(page);
  const start = () => page.evaluate(async (steps) => {
    const app = window.pigmentApp;
    for (const d of app.docs.list()) await app.docs.close(d, { force: true });
    for (const name of ['Other', 'Main']) await app.newDocument({ width: 120, height: 90, name });
    await app.commands.run('layer:new', { name: 'Art' }, 'api');
    const l = app.doc.active, ctx = l.canvas.getContext('2d');
    for (let x = 0; x < l.canvas.width; x += 10) {
      ctx.fillStyle = (x / 10) % 2 ? '#e03030' : '#2040c0';
      ctx.fillRect(x, 0, 10, l.canvas.height);
    }
    l.touch();
    app.doc.changed('pixels', { layer: l });
    const a = app.actions.newAction({ name: `A${Math.random()}`, steps });
    window.__out = null;
    app.actions.play(a, { quiet: true }).then((o) => (window.__out = { ok: o.ok, reason: o.reason, index: o.index }));
  }, [step('edit:content-aware-scale', { width: 80, height: 100, unit: 'percent' }, { dialog: true }), step('image:adjust-invert')]);
  const up = () => page.waitForFunction(() => !!window.pigmentApp.contentAwareScale?.session);
  const result = () => page.evaluate(() => ({ outcome: window.__out, docs: window.pigmentApp.docs.list().map((d) => `${d.name}:${d.history.entries.map((e) => e.label).join(',')}`) }));

  await start();
  await up();
  await page.keyboard.press('Enter'); // an unchanged box: still the go-ahead
  await expect.poll(() => page.evaluate(() => window.__out)).not.toBeNull();
  expect(await result()).toEqual({ outcome: { ok: true }, docs: ['Other:', 'Main:New layer,Invert'] });

  await start();
  await up();
  await page.locator('#tabbar .tab', { hasText: 'Other' }).first().click(); // leaving the box is not
  await expect.poll(() => page.evaluate(() => window.__out)).not.toBeNull();
  expect(await result()).toEqual({ outcome: { ok: false, reason: 'cancelled', index: 0 }, docs: ['Other:', 'Main:New layer'] });

  await start();
  await up();
  await page.evaluate(() => {
    const cas = window.pigmentApp.contentAwareScale;
    cas.setSize(150, 150);
    cas.session.full.scale = () => {
      throw new Error('out of memory');
    };
  });
  await page.keyboard.press('Enter'); // a scale that failed is not either
  await expect.poll(() => page.evaluate(() => window.__out)).not.toBeNull();
  expect(await result()).toEqual({ outcome: { ok: false, reason: 'cancelled', index: 0 }, docs: ['Other:', 'Main:New layer'] });
  expect(errors.filter((e) => !/out of memory/.test(e))).toEqual([]);
});

test('the first dialog of a window with an autofocus field selects its proposed text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40, name: 'Photo' });
  for (const typed of ['New', 'Newer']) {
    await page.evaluate(() => {
      window.pigmentApp.commands.run('image:duplicate', undefined, 'menu');
    });
    const name = page.locator('.dialog input[data-key="name"]');
    await expect(name).toBeFocused();
    await expect.poll(() => name.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, 10, 10]);
    await page.keyboard.type(typed);
    expect(await name.inputValue()).toBe(typed);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('Save, Undo and the panels keep working while an AI request is on its way', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60, name: 'Main' });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/ai.pigment'));
  await runAwait(page, 'file:save-as');
  await runAwait(page, 'layer:new', { name: 'Art' });
  await runAwait(page, 'image:adjust-invert');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    delete window.__pigmentTest.written['mem:/ai.pigment'];
    // the real wrapper of every AI request (busy cursor, Cancel toast) around an answer that has not come yet
    window.__task = app.aiFeatures.task('Generative Fill…', () => new Promise((r) => (window.__answer = r)));
  });
  await page.waitForFunction(() => document.body.classList.contains('busy') && !!window.__answer);
  await page.keyboard.press('Control+z'); // the Invert
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.entries.at(window.pigmentApp.doc.history.index).label)).toBe('New layer');
  await page.evaluate(() => window.pigmentApp.commands.run('layer:opacity', 40, 'panel'));
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.opacity)).toBe(0.4);
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/ai.pigment'])).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  expect((await toasts(page)).filter((t) => /still working/.test(t))).toEqual([]);
  expect(await page.evaluate(async () => {
    window.__answer('done');
    return window.__task;
  })).toBe('done');
  expect(errors).toEqual([]);
});
