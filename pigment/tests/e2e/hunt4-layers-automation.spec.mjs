// Regressions from the 0.3.1 cross-feature hunt, area "layers, automation": documents built by Photomerge and the
// stack scripts, what an action file may run and how large it may be, recording multi-layer selections and the
// answer of a Close step, Isolate Layers with the Move tool, commands during a busy operation, colour labels and
// links through duplicates, the Image Processor's File Info and history, and the locks of the Background.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel, drag, historyLength } from './helpers.mjs';

/** window.H: small helpers that build layers the way the app does (one history entry each). */
async function setup(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const LO = await import('/lib/layer-ops.js');
    const M = await import('/lib/actions/model.js');
    const FI = await import('/lib/file-info.js');
    window.H = {
      M, FI,
      add(name, draw, { width, height } = {}) {
        const d = app.doc;
        const layer = new D.RasterLayer({ name, width: width ?? d.width, height: height ?? d.height });
        draw(layer.canvas.getContext('2d'), layer.canvas);
        LO.structural(app, `Add ${name}`, () => {
          d.add(layer, d.root, d.root.children.length);
          d.setActive(layer);
        });
        return layer;
      },
      rect(name, color, x, y, w, h) {
        return this.add(name, (ctx) => {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        });
      },
      /** Three layers cut from one random texture at different offsets (what Auto-Align registers). */
      textured(offsets, w = 180, h = 130) {
        const base = document.createElement('canvas');
        base.width = w + 40;
        base.height = h + 30;
        const bx = base.getContext('2d');
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        bx.fillStyle = '#888';
        bx.fillRect(0, 0, base.width, base.height);
        for (let i = 0; i < 260; i++) {
          bx.fillStyle = `rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})`;
          bx.fillRect(rnd() * base.width, rnd() * base.height, 4 + rnd() * 18, 4 + rnd() * 18);
        }
        for (const [name, x, y] of offsets) this.add(name, (ctx) => ctx.drawImage(base, -x, -y), { width: w, height: h });
      },
      select(names) {
        const d = app.doc;
        const layers = names.map((n) => d.layers().find((l) => l.name === n));
        d.selected = new Set(layers);
        d.active = layers[layers.length - 1];
        d.changed('active', { layer: d.active });
      },
      /** [name, colour label, link set id] per layer, bottom first (groups listed before their children). */
      tags(d = app.doc) {
        return d.layers().map((l) => [l.name, l.color ?? null, l.linked ?? null]);
      },
      locks(d = app.doc) {
        return d.root.children.map((l) => [l.name, Object.keys(l.locked).filter((k) => l.locked[k]).join('+')]);
      },
      labels(d = app.doc) {
        return d.history.entries.map((e) => e.label);
      },
      async png(w, h, color) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = color;
        x.fillRect(0, 0, w, h);
        for (let i = 0; i < 40; i++) {
          x.fillStyle = `hsl(${i * 37},80%,50%)`;
          x.fillRect((i * 53) % w, (i * 31) % h, 9, 7);
        }
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
      },
      /** A new, selected action in a new set; returns it. */
      action(setName, name, steps = []) {
        const set = M.makeSet(setName);
        const action = M.makeAction(name, steps);
        set.actions.push(action);
        app.actions.sets.push(set);
        app.actions.selection = { set: set.id, action: action.id, step: null };
        return action;
      },
    };
  });
}

const row = (page, name) => page.locator('[data-panel="layers"] .layer-list > .layer-row', { has: page.locator('.layer-name', { hasText: new RegExp(`^${name}$`) }) }).first();
const toasts = (page) => page.locator('.toast').allTextContents();
const notBusy = (page) => page.waitForFunction(() => !document.body.classList.contains('busy'));

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await setup(page);
});

test('Photomerge, Load Files into Stack and Statistics documents are unsaved: closing them asks', async ({ page }) => {
  await newDoc(page, { width: 60, height: 40 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const go = (c, a) => app.commands.run(c, a, 'api');
    T.files['browser:/q/a.png'] = await H.png(120, 90, '#888');
    T.files['browser:/q/b.png'] = await H.png(120, 90, '#888');
    const paths = ['browser:/q/a.png', 'browser:/q/b.png'];
    const made = [];
    const note = () => made.push([app.doc.name, app.doc.path ?? null, app.doc.history.dirty, app.doc.history.entries.length]);
    await go('file:automate-photomerge', { source: 'files', paths, layout: 'reposition', blend: true });
    note();
    await go('file:script-load-stack', { source: 'files', paths, align: false, smart: false });
    note();
    await go('file:script-statistics', { source: 'files', paths, mode: 'mean' });
    note();
    // every prompt is answered Cancel: nothing may be closed silently
    const asked = [];
    T.autoRespond = (o) => {
      asked.push(o.message);
      return 2;
    };
    app.docs.activate(app.docs.docs[0]);
    const closed = await go('file:close-others');
    const left = app.docs.docs.map((d) => d.name);
    // "Don't Save" closes them
    T.autoRespond = () => 1;
    const closedNow = await go('file:close-others');
    T.autoRespond = undefined;
    return { made, asked, closed, left, closedNow, end: app.docs.docs.map((d) => d.name) };
  });
  // new documents: no path, nothing to undo, but not saved anywhere
  expect(result.made).toEqual([['Panorama', null, true, 0], ['a stack', null, true, 0], ['Mean of 2 images', null, true, 0]]);
  expect(result.asked).toEqual(['Save changes to "Panorama" before closing?']);
  expect(result.closed).toBe(false);
  expect(result.left).toEqual(['Test', 'Panorama', 'a stack', 'Mean of 2 images']);
  expect(result.closedNow).toBe(true);
  expect(result.end).toEqual(['Test']);
  // the tab shows the unsaved dot from the start
  await runAwait(page, 'file:script-load-stack', { source: 'files', paths: ['browser:/q/a.png', 'browser:/q/b.png'], align: false, smart: false });
  await expect(page.locator('#tabbar .tab[aria-selected="true"] .tab-dirty')).toHaveCount(1);
});

test('an action cannot run what recording never records: loaded files lose those steps, playback refuses them, Purge always asks', async ({ page }) => {
  await newDoc(page, { width: 80, height: 60 });
  await page.evaluate(() => {
    H.rect('A', '#ff0000', 5, 5, 30, 30);
    H.rect('B', '#0000ff', 20, 20, 30, 30);
  });
  expect(await historyLength(page)).toBe(2);
  // a file whose steps hide application commands behind harmless labels
  const loaded = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const steps = [
      { command: 'edit:purge', arg: { what: 'all', confirm: false }, label: 'Blur' },
      { command: 'actions:clear', arg: { force: true }, label: 'Sharpen' },
      { command: 'file:quit', label: 'Levels' },
      { command: 'edit:undo', label: 'Curves' },
      { command: 'image:adjust-invert', label: 'Invert' },
    ];
    T.files['browser:/evil.pigment-actions'] = new TextEncoder().encode(JSON.stringify({ format: 'pigment-actions', version: 1, sets: [{ name: 'Evil', actions: [{ name: 'Looks harmless', steps }] }] }));
    const ok = await app.commands.run('actions:load', 'browser:/evil.pigment-actions', 'api');
    const set = app.actions.sets.find((s) => s.name === 'Evil');
    return { ok, steps: set.actions[0].steps.map((s) => s.command) };
  });
  expect(loaded).toEqual({ ok: true, steps: ['image:adjust-invert'] });
  expect((await toasts(page)).some((t) => /4 steps were left out/.test(t))).toBe(true);
  // steps put together in code are refused when they play: the history and the sets stay
  const played = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const out = [];
    for (const [command, arg] of [['edit:purge', { what: 'all', confirm: false }], ['actions:clear', { force: true }], ['edit:undo'], ['file:clear-recent'], ['edit:preferences'], ['file:quit']]) {
      const action = H.action(`Hand ${out.length}`, 'Made in code', [H.M.makeStep(command, arg, 'Blur')]);
      const r = await app.actions.play(action, { quiet: true });
      out.push([command, r.ok, r.reason]);
    }
    return { out, history: app.doc.history.entries.length, index: app.doc.history.index, sets: app.actions.sets.length, dialogs: document.querySelectorAll('.dialog-backdrop').length };
  });
  expect(played.out.every(([, ok, reason]) => ok === false && reason === 'unavailable')).toBe(true);
  expect(played).toMatchObject({ history: 2, index: 1, dialogs: 0 });
  expect(played.sets).toBeGreaterThanOrEqual(8); // Default Actions, Evil and the six made here: nothing was cleared
  // Insert Menu Item refuses them as well
  expect(await page.evaluate(async () => (await window.pigmentApp.actions.insertMenuItem('edit:purge')) === null)).toBe(true);
  // Purge asks whatever runs it, playback included
  await page.evaluate(() => {
    window.pigmentApp.commands.run('edit:purge', 'all', 'action');
  });
  await expect(page.locator('.dialog-backdrop')).toContainText('cannot be undone');
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await historyLength(page)).toBe(2);
});

test('Load Actions refuses oversized files and the settings keep saving', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const file = (sets) => new TextEncoder().encode(JSON.stringify({ format: 'pigment-actions', version: 1, sets }));
    const step = (i) => ({ command: 'filter:gaussian-blur', arg: { radius: 1 + (i % 9), note: 'x'.repeat(200) }, label: `Blur ${i}` });
    // 30,000 steps (7 MB), 6,000 small steps, and one step with a 3 MB argument
    T.files['browser:/huge.pigment-actions'] = file([{ name: 'Huge', actions: [{ name: 'Many', steps: Array.from({ length: 30000 }, (_, i) => step(i)) }] }]);
    T.files['browser:/many.pigment-actions'] = file([{ name: 'Many', actions: [{ name: 'Many', steps: Array.from({ length: 6000 }, () => ({ command: 'image:adjust-invert' })) }] }]);
    T.files['browser:/arg.pigment-actions'] = file([{ name: 'Arg', actions: [{ name: 'A'.repeat(200000), steps: [{ command: 'filter:gaussian-blur', arg: { s: 'y'.repeat(3_000_000) }, label: 'L'.repeat(500000) }] }] }]);
    // a file that fits: 2,000 steps
    T.files['browser:/fits.pigment-actions'] = file([{ name: 'Fits', actions: [{ name: 'Two thousand', steps: Array.from({ length: 2000 }, () => ({ command: 'image:adjust-invert' })) }] }]);
    const before = app.actions.sets.length;
    const out = { loads: [] };
    for (const name of ['huge', 'many', 'arg', 'fits', 'fits', 'fits']) out.loads.push([name, await app.commands.run('actions:load', `browser:/${name}.pigment-actions`, 'api')]);
    out.added = app.actions.sets.length - before;
    out.names = app.actions.sets.slice(before).map((s) => s.name);
    out.bytes = JSON.stringify(app.actions.sets).length;
    return out;
  });
  // the third copy of "fits" would put more than 5000 rows into the panel
  expect(result.loads).toEqual([['huge', false], ['many', false], ['arg', false], ['fits', true], ['fits', true], ['fits', false]]);
  expect(result.names).toEqual(['Fits', 'Fits 2']);
  expect(result.bytes).toBeLessThan(1024 * 1024);
  const errors = (await toasts(page)).join('\n');
  expect(errors).toContain('too large');
  expect(errors).toContain('more than 5000 actions and steps');
  expect(errors).toContain('more than 256 KB of settings');
  expect(errors).toContain('Delete some action sets first');
  // recording keeps to the same size: it stops when the panel is full
  await newDoc(page, { width: 40, height: 30 });
  const full = await page.evaluate(async () => {
    const app = window.pigmentApp, M = H.M;
    const items = app.actions.sets.reduce((n, s) => n + 1 + s.actions.length + s.actions.reduce((m, a) => m + a.steps.length, 0), 0);
    // a set, an action and enough steps to leave room for exactly one more
    const filler = H.action('Full', 'Filler', Array.from({ length: M.MAX_ITEMS - items - 3 }, () => M.makeStep('image:adjust-invert')));
    const before = filler.steps.length;
    app.actions.record(filler);
    for (let i = 0; i < 3; i++) await app.commands.run('image:flip-h', undefined, 'menu');
    return { added: filler.steps.length - before, recording: !!app.actions.recording, history: app.doc.history.entries.length };
  });
  expect(full).toEqual({ added: 1, recording: false, history: 3 });
  expect((await toasts(page)).some((t) => /Recording stopped/.test(t))).toBe(true);
  // the settings (with the loaded sets) are written, and later preferences still are
  await page.evaluate(() => window.pigmentApp.saveSettingsSoon({ rulerUnit: 'cm' }));
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('pigment.settings') ?? '{}');
    return [stored.rulerUnit, stored.actions?.sets?.some((s) => s.name === 'Fits 2') ?? false];
  })).toEqual(['cm', true]);
});

test('"__proto__" keys in a command argument never reach the Layers filter', async ({ page }) => {
  await newDoc(page, { width: 60, height: 40 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('select:find-layers', JSON.parse('{"__proto__":{"polluted":5},"constructor":{"prototype":{"polluted":6}},"bogus":1,"type":"name","name":"zz"}'), 'api');
    const f = app.ui.layerFilter;
    const out = { type: f.type, name: f.name, on: f.on, polluted: f.polluted ?? null, plain: Object.getPrototypeOf(f) === Object.prototype, keys: Object.keys(f).sort() };
    await app.commands.run('select:find-layers', false, 'api');
    // the step editor's JSON goes through the same cleaning
    out.cloned = H.M.cloneData(JSON.parse('{"__proto__":{"polluted":5},"radius":2}'));
    return out;
  });
  expect(result).toMatchObject({ type: 'name', name: 'zz', on: true, polluted: null, plain: true, cloned: { radius: 2 } });
  expect(result.keys).toEqual(['attribute', 'color', 'effect', 'kinds', 'mode', 'name', 'on', 'shown', 'type']);
});

test('layers picked together while recording are selected together on playback (Link, Auto-Align, Group from Layers)', async ({ page }) => {
  const build = async () => {
    await newDoc(page, { width: 200, height: 140 });
    await page.evaluate(() => H.textured([['A', 0, 0], ['B', 14, 9], ['C', 5, 5]]));
    await runAwait(page, 'window:panel-layers');
    await expect(row(page, 'C')).toBeVisible();
  };
  await build();
  await page.evaluate(() => {
    H.action('Mine', 'Pair up');
    window.pigmentApp.actions.record();
  });
  await row(page, 'A').locator('.layer-name').click();
  await row(page, 'B').locator('.layer-name').click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((l) => l.name))).toEqual(['B', 'A']);
  const state = () => page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const pair = d.layers().find((l) => l.name === 'Pair');
    const byName = Object.fromEntries(d.layers().map((l) => [l.name, l]));
    return {
      top: d.root.children.map((l) => l.name),
      pair: pair?.children.map((l) => l.name) ?? null,
      linked: !!byName.A.linked && byName.A.linked === byName.B.linked && !byName.C.linked,
      b: [byName.B.x, byName.B.y],
    };
  });
  const recorded = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:link', undefined, 'menu');
    await app.commands.run('edit:auto-align', { projection: 'reposition' }, 'menu');
    await app.commands.run('layer:group-from-layers', { name: 'Pair' }, 'menu');
    app.actions.stop();
    return app.actions.selectedAction.steps.map((s) => [s.command, s.arg ?? null, s.label]);
  });
  expect(recorded[0]).toEqual(['actions:select-layer', { name: 'B', index: 2, also: [{ name: 'A', index: 1 }] }, 'Select layers “B”, “A”']);
  expect(recorded.map((s) => s[0])).toEqual(['actions:select-layer', 'layer:link', 'edit:auto-align', 'layer:group-from-layers']);
  const want = { top: ['Background', 'Pair', 'C'], pair: ['A', 'B'], linked: true, b: [14, 9] };
  expect(await state()).toEqual(want);
  // the same document again, another layer selected: the action gives the same result
  await build();
  const played = await page.evaluate(async () => {
    const app = window.pigmentApp;
    H.select(['C']);
    const action = app.actions.sets.find((s) => s.name === 'Mine').actions[0];
    return app.actions.play(action, { quiet: true });
  });
  expect(played).toEqual({ ok: true });
  expect(await state()).toEqual(want);
  // a layer of the pick that does not exist stops the action with a reason
  await newDoc(page, { width: 200, height: 140 });
  await page.evaluate(() => H.textured([['B', 14, 9]]));
  const missing = await page.evaluate(async () => {
    const app = window.pigmentApp;
    return app.actions.play(app.actions.sets.find((s) => s.name === 'Mine').actions[0], { quiet: true });
  });
  expect(missing).toMatchObject({ ok: false, reason: 'unavailable', index: 0 });
  expect(missing.message).toContain('“A”');
});

test('the Move tool does not pick or drag a layer that Isolate Layers hides', async ({ page }) => {
  await newDoc(page, { width: 200, height: 150 });
  await page.evaluate(() => {
    H.rect('A', '#ff0000', 10, 10, 60, 60);
    H.rect('B', '#0000ff', 100, 10, 60, 60);
    H.select(['A']);
    const app = window.pigmentApp;
    app.tools.activate('move');
    app.tools.setOpt('move', 'autoSelect', true);
  });
  expect(await page.evaluate(() => window.pigmentApp.tools.active.opt('autoSelect'))).toBe(true);
  await runAwait(page, 'select:isolate-layers', true);
  const where = () => page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { active: d.active.name, pos: d.layers().map((l) => [l.name, l.x, l.y]) };
  });
  // B is not drawn: a drag that starts on it moves the isolated layer, as a drag on empty canvas does
  await drag(page, [120, 30], [130, 80]);
  expect(await where()).toEqual({ active: 'A', pos: [['Background', 0, 0], ['A', 10, 50], ['B', 0, 0]] });
  expect(await page.evaluate(() => window.pigmentApp.ui.isolated)).toBe(true);
  // without isolation the same drag picks B
  await runAwait(page, 'select:isolate-layers', false);
  await drag(page, [120, 30], [130, 80]);
  expect(await where()).toEqual({ active: 'B', pos: [['Background', 0, 0], ['A', 10, 50], ['B', 10, 50]] });
});

test('menu, key and panel commands wait while a slow operation runs; a result computed for a changed document is dropped', async ({ page }) => {
  await newDoc(page, { width: 200, height: 140 });
  await page.evaluate(() => {
    H.textured([['A', 0, 0], ['B', 14, 9], ['C', 5, 5]]);
    H.select(['A', 'B', 'C']);
    const app = window.pigmentApp;
    window.__busy = app.busy('Working…', () => new Promise((r) => (window.__release = r)));
  });
  await page.waitForFunction(() => document.body.classList.contains('busy') && !!window.__release);
  const zoomBefore = await page.evaluate(() => window.pigmentApp.view.zoom);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.commands.run('layer:delete', undefined, 'key');
    app.commands.run('layer:delete', undefined, 'menu');
    app.commands.run('layer:delete', undefined, 'panel');
    app.commands.run('layer:delete', undefined, 'toolbar');
    app.commands.run('view:zoom-in', undefined, 'key'); // viewing stays available
  });
  expect((await toasts(page)).filter((t) => /still working/.test(t))).toHaveLength(1); // said once, not per gesture
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => [window.pigmentApp.doc.layers().map((l) => l.name), window.pigmentApp.doc.history.index])).toEqual([['Background', 'A', 'B', 'C'], 2]);
  expect(await page.evaluate(() => window.pigmentApp.view.zoom)).toBeGreaterThan(zoomBefore);
  // code that runs commands (the operation itself, playback) is not held back
  await page.evaluate(async () => {
    await window.pigmentApp.commands.run('layer:opacity', 50, 'api');
    window.__release();
    await window.__busy;
  });
  await notBusy(page);
  // afterwards gestures work again
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.index)).toBeLessThan(3);

  // Auto-Align computes over several frames: when the layers are deleted meanwhile (by code, which may), it
  // must not grow the canvas or move the Background for layers that are gone
  await newDoc(page, { width: 200, height: 140 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp;
    H.textured([['A', 0, 0], ['B', 14, 9], ['C', 5, 5]]);
    H.select(['A', 'B', 'C']);
    const p = app.commands.run('edit:auto-align', { projection: 'perspective' }, 'api');
    app.commands.run('layer:delete', undefined, 'api');
    await p;
    const d = app.doc;
    return { labels: H.labels(), layers: d.layers().map((l) => [l.name, l.x, l.y]), size: [d.width, d.height] };
  });
  expect(result).toEqual({ labels: ['Add A', 'Add B', 'Add C', 'Delete layers'], layers: [['Background', 0, 0]], size: [200, 140] });
  expect((await toasts(page)).some((t) => /nothing was aligned/.test(t))).toBe(true);
  // undisturbed, the same command aligns
  await newDoc(page, { width: 200, height: 140 });
  const aligned = await page.evaluate(async () => {
    const app = window.pigmentApp;
    H.textured([['A', 0, 0], ['B', 14, 9], ['C', 5, 5]]);
    H.select(['A', 'B', 'C']);
    await app.commands.run('edit:auto-align', { projection: 'reposition' }, 'api');
    const [, a, b, c] = app.doc.layers();
    // positions relative to A (which layer stays put is the command's choice)
    return [H.labels().pop(), [b.x - a.x, b.y - a.y], [c.x - a.x, c.y - a.y]];
  });
  expect(aligned).toEqual(['Auto-Align Layers', [14, 9], [5, 5]]);
});

test('a recorded Close step replays the answer to "Save changes?": Batch closes every file without asking', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest;
    const go = (c, a) => app.commands.run(c, a, 'api');
    T.files['browser:/in/a.png'] = await H.png(40, 30, '#ff0000');
    T.files['browser:/in/b.png'] = await H.png(40, 30, '#00ff00');
    const action = H.action('Rec', 'FlipClose');
    const asked = [];
    T.autoRespond = (o) => {
      asked.push(o.message);
      return 1; // Don't Save
    };
    await go('file:open-paths', ['browser:/in/a.png']);
    app.actions.record();
    await app.commands.run('image:flip-h', undefined, 'menu');
    await app.commands.run('file:close', undefined, 'menu');
    app.actions.stop();
    const out = { recorded: action.steps.map((s) => [s.command, s.arg ?? null, s.label]), askedRecording: asked.slice() };
    asked.length = 0;
    // an unsaved document of the user's is open while the batch runs
    app.newDocument({ width: 50, height: 40, name: 'UserDoc' });
    H.rect('U', '#123456', 0, 0, 30, 30);
    const user = app.doc;
    const r = await go('file:automate-batch', { set: 'Rec', action: 'FlipClose', source: 'folder', folder: 'browser:/in', destination: 'none', errors: 'stop' });
    out.batch = { processed: r?.processed, errors: r?.errors, stopped: r?.stopped, asked: asked.slice(), docs: app.docs.docs.map((d) => d.name), userHistory: user.history.entries.length };
    // a Close step that says "save" writes the file first
    T.files['mem:/c.png'] = await H.png(40, 30, '#0000ff');
    await go('file:open-paths', ['mem:/c.png']);
    await go('image:flip-v');
    const closed = await go('file:close', { save: true });
    out.saved = { closed, written: Object.keys(T.written).filter((p) => p.endsWith('c.png')), asked: asked.slice(), docs: app.docs.docs.map((d) => d.name) };
    // a clean document closes without a prompt and records no answer
    await go('file:open-paths', ['browser:/in/b.png']);
    const plain = H.action('Rec2', 'JustClose');
    app.actions.record();
    await app.commands.run('file:close', undefined, 'menu');
    app.actions.stop();
    out.plain = plain.steps.map((s) => [s.command, s.arg ?? null]);
    T.autoRespond = undefined;
    return out;
  });
  expect(result.recorded.map((s) => s.slice(0, 2))).toEqual([['image:flip-h', null], ['file:close', { save: false }]]);
  expect(result.recorded[1][2]).toBe('Close: don’t save');
  expect(result.askedRecording).toEqual(['Save changes to "a" before closing?']);
  expect(result.batch).toEqual({ processed: 2, errors: [], stopped: false, asked: [], docs: ['UserDoc'], userHistory: 1 });
  expect(result.saved).toEqual({ closed: true, written: ['mem:/c.png'], asked: [], docs: ['UserDoc'] });
  expect(result.plain).toEqual([['file:close', null]]);
});

test('colour labels and links survive Duplicate Layer, group duplicates, Convert to Smart Object and Image > Duplicate', async ({ page }) => {
  await newDoc(page, { width: 100, height: 80 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const go = (c, a) => app.commands.run(c, a, 'api');
    const undoTo = (n) => {
      while (d.history.index >= n) d.history.undo();
    };
    const out = {};
    H.rect('A', '#ff0000', 5, 5, 30, 30);
    await go('layer:color', 'red');
    H.rect('B', '#0000ff', 30, 20, 30, 30);
    await go('layer:color', 'green');
    H.select(['A', 'B']);
    await go('layer:link');
    const base = d.history.index + 1;
    const link = d.layers().find((l) => l.name === 'A').linked;
    out.linked = !!link;
    const norm = (rows) => rows.map(([n, c, k]) => [n, c, k === link ? 'same' : k ? 'new' : null]);
    // one linked layer duplicated: the copy keeps the label and is linked to nothing
    H.select(['A']);
    await go('layer:duplicate');
    out.one = norm(H.tags());
    undoTo(base);
    // both duplicated: the copies are linked to each other, not to the originals
    H.select(['A', 'B']);
    await go('layer:duplicate');
    out.both = norm(H.tags());
    const copies = d.layers().filter((l) => / copy$/.test(l.name));
    out.copiesShare = copies[0].linked === copies[1].linked && copies[0].linked !== link;
    undoTo(base);
    // a labelled group
    H.select(['A', 'B']);
    await go('layer:group-from-layers', { name: 'G', color: 'blue' });
    await go('layer:duplicate');
    out.group = norm(H.tags());
    const inCopy = d.layers().find((l) => l.name === 'G copy').children;
    out.groupCopyShare = inCopy[0].linked === inCopy[1].linked;
    undoTo(base);
    // Convert to Smart Object keeps the label; the partner left behind is not linked to nothing
    H.select(['A']);
    await go('layer:smart-convert');
    out.smart = d.layers().map((l) => [l.name, l.type, l.color ?? null, l.linked ?? null]);
    undoTo(base);
    out.restored = norm(H.tags());
    // Image > Duplicate: labels and links are in the copy, under its own ids, and in what a .pigment file stores
    await go('image:duplicate', { name: 'Copy', merged: false });
    const copy = app.doc;
    out.copyIsNew = copy !== d;
    out.copy = H.tags(copy).map(([n, c, k]) => [n, c, k ? (k === link ? 'same' : 'new') : null]);
    const ids = new Set(copy.layers().map((l) => l.id));
    out.copyMeta = Object.keys(copy.meta?.layerTags ?? {}).every((id) => ids.has(id)) ? Object.values(copy.meta?.layerTags ?? {}).map((t) => t.color).sort() : 'stale';
    return out;
  });
  expect(result.linked).toBe(true);
  expect(result.one).toEqual([['Background', null, null], ['A', 'red', 'same'], ['A copy', 'red', null], ['B', 'green', 'same']]);
  expect(result.both).toEqual([['Background', null, null], ['A', 'red', 'same'], ['A copy', 'red', 'new'], ['B', 'green', 'same'], ['B copy', 'green', 'new']]);
  expect(result.copiesShare).toBe(true);
  expect(result.group).toEqual([['Background', null, null], ['G', 'blue', null], ['A', 'red', 'same'], ['B', 'green', 'same'], ['G copy', 'blue', null], ['A', 'red', 'new'], ['B', 'green', 'new']]);
  expect(result.groupCopyShare).toBe(true);
  expect(result.smart).toEqual([['Background', 'raster', null, null], ['A', 'smart', 'red', null], ['B', 'raster', 'green', null]]);
  expect(result.restored).toEqual([['Background', null, null], ['A', 'red', 'same'], ['B', 'green', 'same']]);
  expect(result.copyIsNew).toBe(true);
  expect(result.copy).toEqual([['Background', null, null], ['A', 'red', 'new'], ['B', 'green', 'new']]);
  expect(result.copyMeta).toEqual(['green', 'red']);
});

test('a link set left with one layer is dissolved, and Undo brings it back', async ({ page }) => {
  await newDoc(page, { width: 100, height: 80 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    H.rect('A', '#ff0000', 5, 5, 30, 30);
    H.rect('B', '#0000ff', 30, 20, 30, 30);
    H.rect('C', '#00ff00', 50, 40, 30, 30);
    H.select(['A', 'B']);
    await app.commands.run('layer:link', undefined, 'api');
  });
  await runAwait(page, 'window:panel-layers');
  const linkedRows = page.locator('[data-panel="layers"] .layer-row[data-linked] .layer-name');
  await expect(linkedRows).toHaveText(['B', 'A']);
  await page.evaluate(() => H.select(['B']));
  await runAwait(page, 'layer:delete');
  await expect(linkedRows).toHaveCount(0);
  const after = await page.evaluate(() => {
    const app = window.pigmentApp;
    H.select(['A']);
    return { tags: H.tags(), checked: app.commands.isChecked('layer:link'), stored: app.doc.meta?.layerTags ?? null };
  });
  expect(after).toEqual({ tags: [['Background', null, null], ['A', null, null], ['C', null, null]], checked: false, stored: null });
  // Undo restores the pair; Redo dissolves it again
  await runAwait(page, 'edit:undo');
  await expect(linkedRows).toHaveText(['B', 'A']);
  expect(await page.evaluate(() => {
    const [, a, b] = H.tags();
    return !!a[2] && a[2] === b[2];
  })).toBe(true);
  await runAwait(page, 'edit:redo');
  await expect(linkedRows).toHaveCount(0);
  // linked layers still move together after all of this
  await runAwait(page, 'edit:undo');
  await page.evaluate(() => {
    H.select(['A']);
    window.pigmentApp.tools.activate('move');
  });
  await drag(page, [15, 15], [25, 35]);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => [l.name, l.x, l.y]))).toEqual([['Background', 0, 0], ['A', 10, 20], ['B', 10, 20], ['C', 0, 0]]);
});

test('Image Processor: the Copyright Info and the File Info reach PSD and JPEG outputs, and an open document keeps its history', async ({ page }) => {
  await newDoc(page, { width: 80, height: 60, name: 'IP' });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, T = window.__pigmentTest, d = app.doc;
    H.rect('A', '#00ff00', 5, 5, 30, 30);
    H.rect('B', '#0000ff', 25, 25, 30, 30);
    H.rect('C', '#ff00ff', 45, 5, 20, 20);
    d.history.undo(); // the user has one step to redo
    d.meta = { ...d.meta, title: 'Keep me', keywords: ['a', 'b c'] };
    const before = { labels: H.labels(), index: d.history.index, saved: d.history.savedIndex };
    const r = await app.commands.run('file:script-image-processor', { source: 'open', destination: 'folder', destFolder: 'browser:/ip', jpeg: true, jpegQuality: 8, jpegResize: true, jpegWidth: 40, jpegHeight: 40, psd: true, png: false, tiff: false, copyright: 'IP (c) Me', runAction: false }, 'api');
    const out = { errors: r?.errors, written: Object.keys(T.written).sort(), info: {} };
    for (const p of out.written) out.info[p] = H.FI.parseXmp(H.FI.findXmp(T.written[p]));
    // the JPEG still decodes, at the size asked for
    const bmp = await createImageBitmap(new Blob([T.written['browser:/ip/JPEG/IP.jpg']], { type: 'image/jpeg' }));
    out.jpegSize = [bmp.width, bmp.height];
    out.after = { labels: H.labels(), index: d.history.index, saved: d.history.savedIndex, size: [d.width, d.height], meta: d.meta, canRedo: d.history.canRedo };
    out.before = before;
    d.history.redo();
    out.redone = d.layers().map((l) => l.name);
    return out;
  });
  expect(result.errors).toEqual([]);
  expect(result.written).toEqual(['browser:/ip/JPEG/IP.jpg', 'browser:/ip/PSD/IP.psd']);
  const info = { title: 'Keep me', keywords: ['a', 'b c'], copyright: 'IP (c) Me' };
  expect(result.info['browser:/ip/PSD/IP.psd']).toMatchObject(info);
  expect(result.info['browser:/ip/JPEG/IP.jpg']).toMatchObject(info);
  expect(result.jpegSize).toEqual([40, 30]);
  // the document is as it was: same entries (the user's own redo step included), same size, no copyright left behind
  expect(result.after).toMatchObject({ labels: result.before.labels, index: result.before.index, saved: result.before.saved, size: [80, 60], meta: { title: 'Keep me', keywords: ['a', 'b c'] }, canRedo: true });
  expect(result.before.labels).toEqual(['Add A', 'Add B', 'Add C']);
  expect(result.after.meta.copyright).toBeUndefined();
  expect(result.redone).toEqual(['Background', 'A', 'B', 'C']);
});

test('the Background made by Background from Layer keeps its locks through Merge Down and Flatten; its duplicate is an ordinary layer', async ({ page }) => {
  await newDoc(page, { width: 120, height: 90 });
  const result = await page.evaluate(async () => {
    const app = window.pigmentApp, d = app.doc;
    const go = (c, a) => app.commands.run(c, a, 'api');
    const out = {};
    await go('layer:from-background', { name: 'Layer 0' });
    await go('layer:from-background');
    out.made = H.locks();
    const base = d.history.index + 1;
    const undoTo = (n) => {
      while (d.history.index >= n) d.history.undo();
    };
    H.rect('Blue', '#0000ff', 40, 30, 40, 30);
    await go('layer:merge-down');
    out.merged = H.locks();
    undoTo(base + 1);
    await go('image:flatten');
    out.flat = H.locks();
    undoTo(base + 1);
    await go('layer:merge-visible');
    out.visible = H.locks();
    undoTo(base);
    H.select(['Background']);
    await go('layer:duplicate');
    out.dup = H.locks();
    undoTo(base);
    // an ordinary layer's locks are still copied (all but "lock all"), and Flatten in a document whose Background
    // was never locked gives an unlocked one
    H.rect('Pinned', '#00ff00', 10, 10, 20, 20);
    d.active.locked = { ...d.active.locked, position: true, all: true };
    await go('layer:duplicate');
    out.pinned = H.locks();
    return out;
  });
  const bg = ['Background', 'position+transparency'];
  expect(result.made).toEqual([bg]);
  expect(result.merged).toEqual([bg]);
  expect(result.flat).toEqual([bg]);
  expect(result.visible).toEqual([bg]);
  expect(result.dup).toEqual([bg, ['Background copy', '']]);
  expect(result.pinned).toEqual([bg, ['Pinned', 'position+all'], ['Pinned copy', 'position']]);
  // the merged Background still cannot be moved, and stays opaque under the eraser's reach
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    H.rect('Blue', '#0000ff', 40, 30, 40, 30);
    await app.commands.run('layer:merge-down', undefined, 'api');
    app.tools.activate('move');
  });
  await drag(page, [50, 40], [70, 60]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.name, window.pigmentApp.doc.active.x, window.pigmentApp.doc.active.y])).toEqual(['Background', 0, 0]);
  expect(await pixel(page, 50, 40)).toEqual([0, 0, 255, 255]);
  // a new document's Background was never locked: flattening keeps it that way
  await newDoc(page, { width: 60, height: 40 });
  await page.evaluate(() => H.rect('X', '#ff0000', 5, 5, 10, 10));
  await runAwait(page, 'image:flatten');
  expect(await page.evaluate(() => H.locks())).toEqual([['Background', '']]);
});
