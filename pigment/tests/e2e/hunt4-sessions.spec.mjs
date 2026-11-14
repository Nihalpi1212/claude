// Regressions from the 0.3.1 cross-feature hunt, area "sessions": what happens when something else arrives while a
// tool box, a preview dialog or an on-canvas session is still open (a pending Perspective Crop and Save / a filter /
// the History panel, closing the window over a previewing dialog, smart filter stacks, 16-bit previews, Last Filter
// in actions, Displace replays, Fade, Content-Aware Scale and a tab switch or an action, files opened from the OS).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, layerPixel, confirmDialog, historyLength } from './helpers.mjs';

/** Page-side helpers (window.T): a test picture, the composite, a difference count and history labels. */
async function setup(page) {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const T = (window.T = {});
    T.paint = (l = app.doc.active) => {
      const c = l.canvas, ctx = c.getContext('2d');
      for (let y = 0; y < c.height; y += 20) for (let x = 0; x < c.width; x += 20) {
        ctx.fillStyle = ((x + y) / 20) % 2 ? '#e03030' : '#ffffff';
        ctx.fillRect(x, y, 20, 20);
        ctx.fillStyle = '#102040';
        ctx.fillRect(x + 7, y + 7, 4, 4);
      }
      const g = ctx.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, 'rgba(0,80,255,0.5)');
      g.addColorStop(1, 'rgba(0,255,80,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
      l.touch();
      app.doc.changed('pixels', { layer: l });
    };
    T.comp = (d = app.doc) => {
      const c = d.view.compositor.composite(d);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    /** { max, n }: the largest channel difference and how many channel values differ by more than 8. */
    T.diff = (a, b) => {
      if (a.length !== b.length) return { len: [a.length, b.length] };
      let max = 0, n = 0;
      for (let i = 0; i < a.length; i++) {
        const v = Math.abs(a[i] - b[i]);
        if (v > max) max = v;
        if (v > 8) n++;
      }
      return { max, n };
    };
    T.labels = (d = app.doc) => d.history.entries.map((e) => e.label);
    /** A 200 x 150 document with a painted layer "Art" above the white background. */
    T.make = async (name = 'Main', { smart = false } = {}) => {
      await app.newDocument({ width: 200, height: 150, name });
      await app.commands.run('layer:new', { name: 'Art' }, 'api');
      T.paint();
      if (smart) await app.commands.run('layer:smart-convert', undefined, 'api');
      return app.doc;
    };
    /** The composite of a .pigment file's bytes, read back without opening a tab. */
    T.reopen = async (bytes) => {
      const { openDocument } = await import('/lib/io.js');
      const { Compositor } = await import('/lib/compositor.js');
      const d = await openDocument(bytes, { name: 'saved.pigment', path: null });
      const c = new Compositor().composite(d);
      return { doc: d, pixels: c.getContext('2d').getImageData(0, 0, c.width, c.height).data };
    };
  });
  return errors;
}
/** Runs a command the way a menu click does (a user gesture, not code). */
const menu = (page, id, arg) =>
  page.evaluate(([c, a]) => {
    const r = window.pigmentApp.commands.run(c, a ?? undefined, 'menu');
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('command failed', c, err));
  }, [id, arg ?? null]);
const QUAD = [[30, 20], [170, 35], [180, 130], [20, 120]];
const setQuad = (page) => page.evaluate((q) => {
  const app = window.pigmentApp;
  app.tools.activate('perspective-crop');
  app.tools.active.setQuad(q);
}, QUAD);
const idle = (page) => page.waitForFunction(() => !document.body.classList.contains('busy'));
/** Closes the window through the bridge, answering Save to "Save changes…?"; resolves once the close was answered. */
async function closeWindowAndSave(page, savePath) {
  await page.evaluate(async (p) => {
    const { bridge } = await import('/lib/bridge.js');
    const t = window.__pigmentTest;
    t.autoRespond = () => 0; // Save
    t.closeResponse = undefined;
    t.nextSavePath = p;
    delete t.written[p];
    bridge.closeWindow();
  }, savePath);
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.closeResponse)).toBe(true);
  await expect.poll(() => page.evaluate((p) => !!window.__pigmentTest.written[p], savePath)).toBe(true);
}
const saveAs = async (page, path) => {
  await page.evaluate((p) => (window.__pigmentTest.nextSavePath = p), path);
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe(path);
};
const setNumber = async (page, key, value) => {
  const input = page.locator(`.dialog input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};
const chooseDisplaceMap = async (page) => {
  const select = page.locator('.dialog select[data-key="__map"]');
  await expect(select).toBeVisible();
  const options = await select.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  await select.selectOption(options.find((o) => o[1] === 'Layer: Map')[0]);
  await confirmDialog(page);
};

test('Perspective Crop with a quad up: Ctrl+S saves the cropped document', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(() => window.T.make('pc'));
  await setQuad(page);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/pc.pigment'));
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['browser:/pc.pigment'])).toBe(true);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false);
  const res = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const saved = await T.reopen(window.__pigmentTest.written['browser:/pc.pigment']);
    return { doc: [app.doc.width, app.doc.height], saved: [saved.doc.width, saved.doc.height], last: T.labels().at(-1), vsSaved: T.diff(T.comp(), saved.pixels), points: app.tools.active.points.length };
  });
  // the crop was applied before the bytes were encoded: the file is the document, and "saved" is true
  expect(res.last).toBe('Perspective crop');
  expect(res.doc[0]).toBeLessThan(200);
  expect(res.saved).toEqual(res.doc);
  expect(res.vsSaved).toEqual({ max: 0, n: 0 });
  expect(res.points).toBe(0);
  expect(errors).toEqual([]);
});

test('Perspective Crop with a quad up: a filter, a History click and a rotate come after the crop', async ({ page }) => {
  const errors = await setup(page);
  // a filter run from the menu works on the cropped document and undoes to it
  await page.evaluate(() => window.T.make('filter'));
  await setQuad(page);
  await runAwait(page, 'filter:gaussian-blur', { radius: 6 });
  await idle(page);
  const f = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const blurred = T.comp();
    await app.commands.run('edit:undo', undefined, 'api');
    return { labels: T.labels().slice(-2), size: [app.doc.width, app.doc.height], undo: T.diff(blurred, T.comp()) };
  });
  expect(f.labels).toEqual(['Perspective crop', 'Gaussian Blur']);
  expect(f.size[0]).toBeLessThan(200);
  expect(f.undo.n).toBeGreaterThan(1000); // the filter changed the cropped pixels, and undo takes exactly that back

  // a click in the History panel only moves in history: the crop is a state of its own after the others
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await window.T.make('history');
    await app.commands.run('image:adjust-invert', undefined, 'api');
    await app.commands.run('image:adjust-desaturate', undefined, 'api');
    app.panels.show('history', { reveal: true });
  });
  await setQuad(page);
  const before = await page.evaluate(() => window.T.labels());
  await page.locator('.history-states .history-item', { hasText: 'Invert' }).click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Invert');
  const h = await page.evaluate(() => ({ labels: window.T.labels(), size: [window.pigmentApp.doc.width, window.pigmentApp.doc.height] }));
  expect(h.labels).toEqual([...before, 'Perspective crop']); // Desaturate is still there to redo
  expect(h.size).toEqual([200, 150]);

  // a rotate from the menu: crop first, then the rotation
  await page.evaluate(() => window.T.make('rotate'));
  await setQuad(page);
  await menu(page, 'edit:transform-rotate-90');
  await expect.poll(() => page.evaluate(() => window.T.labels().length)).toBeGreaterThan(await page.evaluate(() => window.T.labels().indexOf('Perspective crop')) + 1);
  const r = await page.evaluate(() => window.T.labels());
  expect(r.indexOf('Perspective crop')).toBeGreaterThan(0);
  expect(r.at(-1)).not.toBe('Perspective crop');
  expect(errors).toEqual([]);
});

test('closing the window over a previewing dialog saves the document without the preview', async ({ page }) => {
  const errors = await setup(page);
  // a filter dialog previewing on a pixel layer
  await page.evaluate(() => window.T.make('ra'));
  await saveAs(page, 'browser:/ra.pigment');
  await runAwait(page, 'image:adjust-invert'); // the unsaved change
  await page.evaluate(() => (window.__start = window.T.comp()));
  const states = await historyLength(page);
  await menu(page, 'filter:gaussian-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await setNumber(page, 'radius', 8);
  await expect.poll(() => page.evaluate(() => window.T.diff(window.__start, window.T.comp()).n)).toBeGreaterThan(1000);
  await closeWindowAndSave(page, 'browser:/ra.pigment');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const a = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const saved = await T.reopen(window.__pigmentTest.written['browser:/ra.pigment']);
    return { saved: T.diff(window.__start, saved.pixels), live: T.diff(window.__start, T.comp()), dirty: app.doc.history.dirty, holds: app.doc.previewHolds ?? 0 };
  });
  expect(a.saved).toEqual({ max: 0, n: 0 });
  expect(a.live).toEqual({ max: 0, n: 0 });
  expect(a.dirty).toBe(false);
  expect(a.holds).toBe(0);
  expect(await historyLength(page)).toBe(states);

  // a kind with its own dialog on a smart object: the object is hidden behind a temporary copy meanwhile
  await page.evaluate(() => window.T.make('so', { smart: true }));
  await saveAs(page, 'browser:/so.pigment');
  await runAwait(page, 'select:all'); // the unsaved change
  await menu(page, 'filter:filter-gallery');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.type}:${l.visible}`))).toEqual(['raster:true', 'smart:false', 'raster:true']);
  await closeWindowAndSave(page, 'browser:/so.pigment');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const describe = () => page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const saved = (await T.reopen(window.__pigmentTest.written['browser:/so.pigment'])).doc;
    const list = (d) => d.layers().map((l) => `${l.name}:${l.type}:${l.visible}:${(l.filters ?? []).map((x) => x.kind).join('+')}`);
    return { saved: list(saved), savedSelection: !!saved.selection && !saved.selection.isEmpty, live: list(app.doc), liveSelection: !!app.doc.selection && !app.doc.selection.isEmpty };
  });
  const expected = { saved: ['Background:raster:true:', 'Art:smart:true:'], savedSelection: true, live: ['Background:raster:true:', 'Art:smart:true:'], liveSelection: true };
  expect(await describe()).toEqual(expected);

  // a smart filter dialog previews through the layer's filter list: the unconfirmed filter must not be saved
  await runAwait(page, 'select:inverse');
  await runAwait(page, 'select:all'); // dirty again
  await menu(page, 'filter:camera-raw');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers()[1].filters.length)).toBe(1);
  await closeWindowAndSave(page, 'browser:/so.pigment');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await describe()).toEqual(expected);
  expect(errors).toEqual([]);
});

test('a padded smart filter does not move the pins of a Blur Gallery smart filter in the same stack', async ({ page }) => {
  const errors = await setup(page);
  const res = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const { FILTERS } = await import('/shared/pixels/filters.js');
    await T.make('stack', { smart: true });
    const tilt = JSON.parse(JSON.stringify(FILTERS['tilt-shift'].defaults));
    tilt.pins = [{ ...tilt.pins[0], x: 0.5, y: 0.2, blur: 25 }];
    await app.commands.run('filter:tilt-shift', tilt, 'api');
    const alone = T.comp();
    // a filter that changes next to nothing by itself, but pads the render by 202 px on every side
    await app.commands.run('filter:surface-blur', { radius: 100, threshold: 2 }, 'api');
    return { filters: app.doc.active.filters.map((f) => f.kind), moved: T.diff(alone, T.comp()) };
  });
  expect(res.filters).toEqual(['tilt-shift', 'surface-blur']);
  expect(res.moved.n).toBeLessThan(50);

  // the session of a Blur Gallery kind above a padded filter is laid out on the object's bounds, like the result
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await window.T.make('session', { smart: true });
    await app.commands.run('filter:gaussian-blur', { radius: 20 }, 'api');
  });
  await menu(page, 'filter:iris-blur');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.blurGallery.active)).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.blurGallery.rect)).toEqual({ x: 0, y: 0, width: 200, height: 150 });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.blurGallery.active)).toBe(false);
  expect(errors).toEqual([]);
});

test('16-bit document: a preview left open does not round the deep pixels, cancelled or not', async ({ page }) => {
  const errors = await setup(page);
  await newDoc(page, { width: 200, height: 150, name: 'Deep' });
  await runAwait(page, 'image:depth', 16);
  await page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active, w = l.canvas.width, h = l.canvas.height;
    // samples no 8-bit value can stand for
    const data = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.min(65535, x * 320 + (y % 7) * 13 + 5);
      data[i + 1] = Math.min(65535, y * 430 + (x % 5) * 17 + 3);
      data[i + 2] = ((x * 31 + y * 57) % 65000) + 11;
      data[i + 3] = 65535;
    }
    app.deep.setPixels(l, data, 'Deep content');
    app.deep.sync(app.doc);
    window.__deep = l.deep.data.slice();
    window.__changed = () => {
      const d = app.doc.active.deep.data, o = window.__deep;
      let n = 0;
      for (let i = 0; i < d.length; i++) if (d[i] !== o[i]) n++;
      return n;
    };
  });
  const states = await historyLength(page);
  await menu(page, 'filter:gaussian-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await setNumber(page, 'radius', 6);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.previewHolds)).toBe(1);
  // the deep pixels follow the canvas after 150 ms of quiet: give that pass every chance to take the preview over
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__changed())).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.doc.previewHolds)).toBe(0);
  expect(await page.evaluate(() => (window.pigmentApp.deep.sync(), window.__changed()))).toBe(0);
  expect(await historyLength(page)).toBe(states);

  // confirmed, the filter does change them, and the hold is gone
  await menu(page, 'filter:gaussian-blur');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await setNumber(page, 'radius', 6);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(states + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.previewHolds)).toBe(0);
  expect(await page.evaluate(() => (window.pigmentApp.deep.sync(), window.__changed()))).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
});

test('Lens Blur on a smart object offers no depth map, and what it previews is what stays', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = await window.T.make('lens', { smart: true });
    const mask = new Uint8ClampedArray(200 * 150);
    for (let y = 0; y < 150; y++) for (let x = 100; x < 200; x++) mask[y * 200 + x] = 255;
    d.channels.push({ id: 'Ctest', name: 'Depth', mask });
    d.changed('channels');
    await app.commands.run('layer:mask', 'reveal-all', 'api');
    app.setEditingMask?.(false);
    window.__start = window.T.comp();
  });
  await menu(page, 'filter:lens-blur');
  const source = page.locator('.dialog select[data-key="source"]');
  await expect(source).toBeVisible();
  // a smart filter is re-run from its params alone: the transparency, the mask and the channel are not offered
  expect(await source.locator('option').allTextContents()).toEqual(['None']);
  await expect(page.locator('.dialog [data-key="__smart-depth-note"]')).toContainText('Rasterize');
  await setNumber(page, 'radius', 10);
  await expect.poll(() => page.evaluate(() => window.T.diff(window.__start, window.T.comp()).n)).toBeGreaterThan(1000);
  // the preview has settled when two readings agree
  await expect.poll(() => page.evaluate(() => {
    const now = window.T.comp();
    const same = window.__preview ? window.T.diff(window.__preview, now).max === 0 : false;
    window.__preview = now;
    return same;
  })).toBe(true);
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.filters.length)).toBe(1);
  const res = await page.evaluate(() => {
    const app = window.pigmentApp, T = window.T, now = T.comp();
    const px = (data, x, y) => Array.from(data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 3));
    return { params: app.doc.active.filters[0].params, left: [px(window.__preview, 47, 67), px(now, 47, 67)], right: [px(window.__preview, 147, 67), px(now, 147, 67)] };
  });
  expect(res.params.source).toBe('none');
  for (const [preview, result] of [res.left, res.right]) for (let c = 0; c < 3; c++) expect(Math.abs(preview[c] - result[c])).toBeLessThanOrEqual(6);
  expect(errors).toEqual([]);
});

test('Last Filter is recorded in an action as the filter it ran', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    const { FILTERS } = await import('/shared/pixels/filters.js');
    await T.make('A');
    await app.commands.run('filter:tilt-shift', JSON.parse(JSON.stringify(FILTERS['tilt-shift'].defaults)), 'api');
    await app.commands.run('edit:undo', undefined, 'api');
    window.__action = app.actions.newAction({ name: 'Again' });
    app.actions.record(window.__action);
  });
  const states = await historyLength(page);
  await page.keyboard.press('Control+Alt+f');
  await expect.poll(() => historyLength(page)).toBe(states + 1);
  await idle(page);
  const steps = await page.evaluate(() => {
    window.pigmentApp.actions.stopRecording();
    window.__recorded = window.T.comp();
    return JSON.parse(JSON.stringify(window.__action.steps));
  });
  expect(steps.map((s) => [s.command, s.label])).toEqual([['filter:tilt-shift', 'Tilt-Shift']]);
  expect(steps[0].arg.pins.length).toBe(1);
  // some other filter becomes the last one; the action still applies Tilt-Shift
  const res = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.T;
    await app.commands.run('edit:undo', undefined, 'api');
    await app.commands.run('filter:mosaic', { size: 20 }, 'api');
    await app.commands.run('edit:undo', undefined, 'api');
    const play = await app.commands.run('actions:play', { id: window.__action.id }, 'api');
    return { play, last: T.labels()[app.doc.history.index], lastFilter: app.settings.lastFilter.kind, vsRecorded: T.diff(window.__recorded, T.comp()) };
  });
  expect(res.play.ok).toBe(true);
  expect(res.last).toBe('Tilt-Shift');
  expect(res.vsRecorded).toEqual({ max: 0, n: 0 });
  expect(errors).toEqual([]);
});

test('Displace: Last Filter and a recorded step open the map chooser again, on a pixel layer and on a smart object', async ({ page }) => {
  const errors = await setup(page);
  const make = (smart) => page.evaluate(async (s) => {
    const app = window.pigmentApp, T = window.T;
    await app.newDocument({ width: 200, height: 150, name: s ? 'Smart' : 'Pixels' });
    await app.commands.run('layer:new', { name: 'Map' }, 'api');
    const m = app.doc.active, ctx = m.canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 200, 0);
    g.addColorStop(0, '#000000');
    g.addColorStop(1, '#ffff00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 200, 150);
    m.touch();
    m.visible = false;
    app.doc.changed('pixels', { layer: m });
    await app.commands.run('layer:new', { name: 'Art' }, 'api');
    T.paint();
    if (s) await app.commands.run('layer:smart-convert', undefined, 'api');
    window.__start = T.comp();
  }, smart);
  const state = () => page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active;
    return { states: app.doc.history.index + 1, filters: (l.filters ?? []).map((f) => `${f.kind}:${f.params.map ? 'map' : 'no map'}`), changed: window.T.diff(window.__start, window.T.comp()).n > 1000 };
  });

  // a pixel layer
  await make(false);
  await menu(page, 'filter:displace');
  await chooseDisplaceMap(page);
  const first = await state();
  expect(first.changed).toBe(true);
  // Ctrl+F: the map is not kept with the settings, so the chooser comes back; Escape adds no state
  await page.keyboard.press('Control+Alt+f');
  await expect(page.locator('.dialog select[data-key="__map"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await state()).states).toBe(first.states);
  await page.keyboard.press('Control+Alt+f');
  await chooseDisplaceMap(page);
  await expect.poll(async () => (await state()).states).toBe(first.states + 1);

  // a smart object, with the step recorded
  await make(true);
  await page.evaluate(() => {
    window.__action = window.pigmentApp.actions.newAction({ name: 'Displace' });
    window.pigmentApp.actions.record(window.__action);
  });
  await menu(page, 'filter:displace');
  await chooseDisplaceMap(page);
  await expect.poll(async () => (await state()).filters).toEqual(['displace:map']);
  expect(await page.evaluate(() => (window.pigmentApp.actions.stopRecording(), window.__action.steps.map((s) => s.command)))).toEqual(['filter:displace']);
  const smart = await state();
  await page.keyboard.press('Control+Alt+f');
  await expect(page.locator('.dialog select[data-key="__map"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await state()).toEqual(smart); // no second smart filter without a map
  // the recorded step on a fresh smart object asks for the map too, and the action goes on with it
  await make(true);
  await page.evaluate(() => {
    window.__played = null;
    window.pigmentApp.commands.run('actions:play', { id: window.__action.id }, 'api').then((r) => (window.__played = r));
  });
  await chooseDisplaceMap(page);
  await expect.poll(() => page.evaluate(() => window.__played)).toEqual({ ok: true });
  const played = await state();
  expect(played.filters).toEqual(['displace:map']);
  expect(played.changed).toBe(true);
  expect(errors).toEqual([]);
});

test('Fade after a filter that made pixels transparent does not darken them', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { FILTERS } = await import('/shared/pixels/filters.js');
    await app.newDocument({ width: 200, height: 150, name: 'Fade' });
    await app.commands.run('layer:new', { name: 'Flat' }, 'api');
    const l = app.doc.active, ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#c86432';
    ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
    l.touch();
    app.doc.changed('pixels', { layer: l });
    await app.commands.run('filter:lens-correction', { ...JSON.parse(JSON.stringify(FILTERS['lens-correction'].defaults)), angle: 20, edge: 'transparent' }, 'api');
  });
  await idle(page);
  expect(await layerPixel(page, 2, 2)).toEqual([0, 0, 0, 0]);
  const states = await historyLength(page);
  await run(page, 'edit:fade');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  await setNumber(page, 'opacity', 50);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(states + 1);
  // half way between an opaque #c86432 and nothing: the same colour at half the alpha
  const corner = await layerPixel(page, 2, 2);
  expect(Math.abs(corner[0] - 200)).toBeLessThanOrEqual(3);
  expect(Math.abs(corner[1] - 100)).toBeLessThanOrEqual(3);
  expect(Math.abs(corner[2] - 50)).toBeLessThanOrEqual(3);
  expect(Math.abs(corner[3] - 128)).toBeLessThanOrEqual(2);
  expect(await layerPixel(page, 100, 75)).toEqual([200, 100, 50, 255]);
  expect(errors).toEqual([]);
});

test('Content-Aware Scale: a tab switch applies the scale and hands the other document a real tool', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await window.T.make('Other');
    await window.T.make('Main');
    app.tools.activate('move');
  });
  await menu(page, 'edit:content-aware-scale');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.contentAwareScale.session)).toBe(true);
  await page.evaluate(() => window.pigmentApp.contentAwareScale.setSize(150, 120));
  await page.locator('#tabbar .tab', { hasText: 'Other' }).click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.name)).toBe('Other');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  const res = await page.evaluate(() => {
    const app = window.pigmentApp;
    const main = app.docs.list().find((d) => d.name === 'Main');
    return { session: !!app.contentAwareScale.session, registered: !!app.tools.get('content-aware-scale'), mainLast: main.history.entries.at(-1).label, otherStates: app.doc.history.entries.length, bar: document.getElementById('options-bar').textContent };
  });
  expect(res.session).toBe(false);
  expect(res.registered).toBe(false);
  expect(res.mainLast).toBe('Content-Aware Scale');
  expect(res.bar).not.toContain('Content-Aware');
  await expect(page.locator('#toolbox .active, #toolbox [aria-pressed="true"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Content-Aware Scale as an action step with its dialog on: Enter on the untouched box goes on, Escape stops', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await window.T.make('A');
    window.__action = app.actions.newAction({ name: 'Scale' });
    app.actions.record(window.__action);
    await app.commands.run('edit:content-aware-scale', { width: 75, height: 80, unit: 'percent' }, 'menu');
    await app.commands.run('image:adjust-desaturate', undefined, 'menu');
    app.actions.stopRecording();
    app.commands.run('actions:toggle-dialog', window.__action.steps[0].id, 'api');
  });
  expect(await page.evaluate(() => window.__action.steps.map((s) => `${s.command}:${s.dialog}`))).toEqual(['edit:content-aware-scale:true', 'image:adjust-desaturate:false']);
  const play = async (key) => {
    await page.evaluate(async () => {
      const app = window.pigmentApp;
      await window.T.make('B');
      window.__played = null;
      app.commands.run('actions:play', { id: window.__action.id }, 'api').then((r) => (window.__played = r));
    });
    await expect.poll(() => page.evaluate(() => !!window.pigmentApp.contentAwareScale.session)).toBe(true);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => window.__played)).not.toBeNull();
    return page.evaluate(() => ({ played: { ok: window.__played.ok, reason: window.__played.reason ?? null }, last: window.T.labels().at(-1) }));
  };
  // Enter confirms the box as it is: nothing to scale, and the remaining steps run
  expect(await play('Enter')).toEqual({ played: { ok: true, reason: null }, last: 'Desaturate' });
  // Escape is a cancel: the action stops there
  const stopped = await play('Escape');
  expect(stopped.played).toEqual({ ok: false, reason: 'cancelled' });
  expect(stopped.last).not.toBe('Desaturate');
  expect(errors).toEqual([]);
});

test('a file opened from the OS while a session owns the document is answered with the hint, and opens afterwards', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(async () => {
    await window.T.make('Main');
    const c = document.createElement('canvas');
    c.width = c.height = 20;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    window.__pigmentTest.files['browser:/x.png'] = new Uint8Array(await blob.arrayBuffer());
  });
  const openFromOs = () => page.evaluate(async () => {
    const { bridge } = await import('/lib/bridge.js');
    bridge.__emit('open-files', ['browser:/x.png']);
  });
  await menu(page, 'filter:iris-blur');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.blurGallery.active)).toBe(true);
  await openFromOs();
  await expect(page.locator('#toasts .toast', { hasText: 'Finish Iris Blur first' })).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.blurGallery.active)).toBe(false);
  await openFromOs();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(2);
  expect(errors).toEqual([]);
});
