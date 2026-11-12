// Actions (lib/actions.js, lib/panels/actions.js) and File > Automate / Scripts (lib/automate.js).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, openFixture, run, runAwait, pixel, drag, confirmDialog, historyLength } from './helpers.mjs';

/** FNV-1a hash of the flattened document plus its size: equal hashes mean equal pixels. */
const docHash = (page) =>
  page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = Math.imul(h, 0x01000193);
    }
    return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`;
  });

/**
 * A dialog focuses its first field one frame after it opens; typing that starts before would land in
 * that field instead of the one being filled.
 */
const dialogReady = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const setNumber = async (page, key, value) => {
  await dialogReady(page);
  const input = page.locator(`.dialog input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};

/** Waits until no command is running any more (a dialog command goes on working after its dialog has closed). */
const settled = (page) => expect.poll(() => page.evaluate(() => window.pigmentApp.actions.frames.length)).toBe(0);

/** Confirms the dialog of a command started with run() and waits for the command to finish. */
const confirmAndSettle = async (page) => {
  await confirmDialog(page);
  await settled(page);
};

const showPanel = async (page) => {
  await runAwait(page, 'window:panel-actions');
  await expect(page.locator('.actions-panel')).toBeVisible();
};

/** Starts recording a new action through the panel's New Action dialog. */
async function recordNewAction(page, name) {
  await page.locator('.actions-footer [data-cmd="actions:new-action"]').click();
  await expect(page.locator('.dialog')).toContainText('New Action');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="name"]').fill(name);
  await confirmDialog(page); // "Record"
  await expect.poll(() => page.evaluate(() => window.pigmentApp.actions.recording?.action.name ?? null)).toBe(name);
}

const stopRecording = async (page) => {
  await page.locator('.actions-footer [data-cmd="actions:stop"]').click();
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.actions.recording)).toBe(false);
};

/** The steps of an action by name: [{ command, arg, label, enabled, dialog }]. */
const stepsOf = (page, name) =>
  page.evaluate((n) => {
    for (const set of window.pigmentApp.actions.sets) for (const a of set.actions) if (a.name === n) return JSON.parse(JSON.stringify(a.steps));
    return null;
  }, name);

/** Creates an action from step data without the UI: steps are [command, arg] pairs. */
const makeAction = (page, name, steps) =>
  page.evaluate(
    async ([n, list]) => {
      const { makeStep } = await import('/lib/actions/model.js');
      const engine = window.pigmentApp.actions;
      return engine.newAction({ name: n, steps: list.map(([command, arg]) => makeStep(command, arg === null ? undefined : arg)) }).id;
    },
    [name, steps],
  );

const play = (page, name) => page.evaluate((n) => window.pigmentApp.commands.run('actions:play', { action: n }, 'api'), name);

const closeDoc = (page) => page.evaluate(() => window.pigmentApp.docs.close(window.pigmentApp.doc, { force: true }));

/** Stores solid-colour PNGs as browser files: { path: [width, height, color] }. */
const makeFiles = (page, files) =>
  page.evaluate(async (list) => {
    for (const [path, [w, h, color]] of Object.entries(list)) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = color;
      x.fillRect(0, 0, w, h);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      window.__pigmentTest.files[path] = new Uint8Array(await blob.arrayBuffer());
    }
  }, files);

/** Size and centre pixel of an image file that was written. */
const writtenImage = (page, path) =>
  page.evaluate(async (p) => {
    const bytes = window.__pigmentTest.written[p];
    if (!bytes) return null;
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, center: Array.from(x.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data) };
  }, path);

test('records Levels, Gaussian Blur and Invert from their dialogs and plays the same pixels on another document', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await showPanel(page);
  const original = await docHash(page);
  await recordNewAction(page, 'Tone and Blur');
  await expect(page.locator('.actions-footer .act-record')).toHaveClass(/recording/);

  await run(page, 'image:adjust-levels');
  await setNumber(page, 'inBlack', 60);
  await confirmAndSettle(page);
  await run(page, 'filter:gaussian-blur');
  await setNumber(page, 'radius', 3);
  await confirmAndSettle(page);
  await page.keyboard.press('Control+i');
  // a cancelled dialog and a view command leave no step
  await run(page, 'filter:gaussian-blur');
  await expect(page.locator('.dialog')).toContainText('Gaussian Blur');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await settled(page);
  await runAwait(page, 'view:zoom-in');
  await stopRecording(page);

  const steps = await stepsOf(page, 'Tone and Blur');
  expect(steps.map((s) => s.command)).toEqual(['image:adjust-levels', 'filter:gaussian-blur', 'image:adjust-invert']);
  expect(steps[0].arg.rgb.inBlack).toBe(60);
  expect(steps[1].arg.radius).toBe(3);
  expect(steps.every((s) => s.enabled && !s.dialog)).toBe(true);
  // the panel lists them under the action
  await expect(page.locator('.act-row.act-step')).toHaveCount(3);
  await expect(page.locator('.act-row.act-step .act-name')).toHaveText(['Levels', 'Gaussian Blur', 'Invert']);

  const recorded = await docHash(page);
  expect(recorded).not.toBe(original);
  await closeDoc(page);

  // played on a fresh copy of the image through the panel's Play button
  await openFixture(page, 'gradient.png');
  expect(await docHash(page)).toBe(original);
  const before = await historyLength(page);
  await page.locator('.act-row.act-action', { hasText: 'Tone and Blur' }).click();
  await page.locator('.actions-footer [data-cmd="actions:play"]').click();
  await expect.poll(() => historyLength(page)).toBe(before + 3);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.actions.playing)).toBe(false);
  expect(await docHash(page)).toBe(recorded);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.slice(-3).map((e) => e.label))).toEqual(['Levels', 'Gaussian Blur', 'Invert']);
  // each step is its own undo
  await page.keyboard.press('Control+z');
  expect(await docHash(page)).not.toBe(recorded);
  await closeDoc(page);

  // and the same as running the three commands with those parameters
  await openFixture(page, 'gradient.png');
  for (const s of steps) await runAwait(page, s.command, s.arg);
  expect(await docHash(page)).toBe(recorded);
  expect(errors).toEqual([]);
});

test('Insert Stop pauses playback: Stop leaves the next step selected, Continue goes on', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await showPanel(page);
  await makeAction(page, 'With Stop', [['image:adjust-invert', null]]);
  // Insert Stop through the panel menu and its dialog
  await page.locator('.actions-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Insert Stop' }).click();
  await dialogReady(page);
  await page.locator('.dialog textarea[data-key="message"]').fill('Check the image before going on');
  await confirmDialog(page);
  await page.evaluate(async () => {
    const { makeStep } = await import('/lib/actions/model.js');
    const a = window.pigmentApp.actions.selectedAction;
    a.steps.push(makeStep('image:adjust-posterize', { levels: 2 }));
    window.pigmentApp.actions.changed('edit');
  });
  const steps = await stepsOf(page, 'With Stop');
  expect(steps.map((s) => s.command)).toEqual(['image:adjust-invert', null, 'image:adjust-posterize']);
  expect(steps[1].stop).toEqual({ message: 'Check the image before going on', allowContinue: false });

  // playback stops at the message; the first step ran, the last did not
  const before = await historyLength(page);
  const first = play(page, 'With Stop');
  await expect(page.locator('.dialog')).toContainText('Check the image before going on');
  expect(await historyLength(page)).toBe(before + 1);
  expect(await pixel(page, 10, 10)).toEqual([0, 0, 0, 255]);
  await expect(page.locator('.dialog-buttons .btn')).toHaveText(['Stop']);
  await confirmDialog(page);
  const outcome = await first;
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('stop');
  expect(await historyLength(page)).toBe(before + 1);
  // Play now continues with the step after the Stop
  expect(await page.evaluate(() => window.pigmentApp.actions.selectedStep?.command)).toBe('image:adjust-posterize');
  await page.locator('.actions-footer [data-cmd="actions:play"]').click();
  await expect.poll(() => historyLength(page)).toBe(before + 2);

  // Allow Continue: the dialog offers Continue and the rest of the action runs
  await page.evaluate(() => {
    const a = window.pigmentApp.actions.selectedAction;
    a.steps[1].stop.allowContinue = true;
  });
  const second = play(page, 'With Stop');
  await expect(page.locator('.dialog-buttons .btn')).toHaveText(['Stop', 'Continue']);
  await confirmDialog(page); // Continue is the primary button
  expect((await second).ok).toBe(true);
  expect(await historyLength(page)).toBe(before + 4);
  expect(errors).toEqual([]);
});

test('step checkboxes, dialog toggles and the JSON argument editor change what playback does', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await showPanel(page);
  await makeAction(page, 'Three', [['image:adjust-invert', null], ['filter:gaussian-blur', { radius: 2 }], ['image:adjust-posterize', { levels: 4 }]]);
  const rows = page.locator('.act-row.act-step');
  await expect(rows).toHaveCount(3);

  // an unchecked step is skipped
  await rows.nth(0).locator('.act-check').uncheck();
  expect((await stepsOf(page, 'Three'))[0].enabled).toBe(false);
  let before = await historyLength(page);
  expect((await play(page, 'Three')).ok).toBe(true);
  expect(await historyLength(page)).toBe(before + 2);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]); // not inverted

  // a step with its dialog toggle on asks again: the dialog opens with the recorded radius, Cancel stops the action
  await expect(rows.nth(0).locator('button.act-dialog')).toHaveCount(0); // Invert has no dialog
  await rows.nth(1).locator('button.act-dialog').click();
  expect((await stepsOf(page, 'Three'))[1].dialog).toBe(true);
  before = await historyLength(page);
  const cancelled = play(page, 'Three');
  await expect(page.locator('.dialog')).toContainText('Gaussian Blur');
  await page.keyboard.press('Escape');
  const outcome = await cancelled;
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('cancelled');
  expect(await historyLength(page)).toBe(before);
  // OK continues with the settings chosen in the dialog
  const ok = play(page, 'Three');
  await expect(page.locator('.dialog')).toContainText('Gaussian Blur');
  await setNumber(page, 'radius', 5);
  await confirmDialog(page);
  expect((await ok).ok).toBe(true);
  expect(await historyLength(page)).toBe(before + 2);
  await rows.nth(1).locator('button.act-dialog').click();
  expect((await stepsOf(page, 'Three'))[1].dialog).toBe(false);

  // double-click a step: its argument as JSON
  await rows.nth(2).dblclick();
  const json = page.locator('.dialog textarea[data-key="json"]');
  await expect(json).toHaveValue(/"levels": 4/);
  await dialogReady(page);
  await json.fill('{ "levels": 2 }');
  await confirmDialog(page);
  expect((await stepsOf(page, 'Three'))[2].arg).toEqual({ levels: 2 });
  // invalid JSON keeps the dialog open
  await rows.nth(2).dblclick();
  await dialogReady(page);
  await json.fill('{ levels: ');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect((await stepsOf(page, 'Three'))[2].arg).toEqual({ levels: 2 });

  // the action's checkbox switches every step
  const actionRow = page.locator('.act-row.act-action', { hasText: 'Three' });
  await actionRow.locator('.act-check').click();
  expect((await stepsOf(page, 'Three')).map((s) => s.enabled)).toEqual([true, true, true]);
  expect(errors).toEqual([]);
});

test('Insert Menu Item asks on playback, Insert Conditional plays another action by document state', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await showPanel(page);
  await makeAction(page, 'Landscape Work', [['image:adjust-invert', null]]);
  await makeAction(page, 'Portrait Work', [['image:rotate-90', null]]);
  await makeAction(page, 'Decide', []);

  // conditional through the dialog
  await page.locator('.actions-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Insert Conditional' }).click();
  await page.locator('.dialog select[data-key="test"]').selectOption('document-is-landscape');
  await page.locator('.dialog select[data-key="thenAction"]').selectOption('Landscape Work');
  await page.locator('.dialog select[data-key="elseAction"]').selectOption('Portrait Work');
  await confirmDialog(page);
  expect((await stepsOf(page, 'Decide'))[0].conditional).toEqual({ test: 'document-is-landscape', thenAction: 'Landscape Work', elseAction: 'Portrait Work' });

  // landscape: the "then" action inverts
  expect((await play(page, 'Decide')).ok).toBe(true);
  expect(await pixel(page, 5, 5)).toEqual([0, 0, 0, 255]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([300, 200]);
  // portrait: the "else" action rotates
  await newDoc(page, { width: 200, height: 300, background: 'white' });
  expect((await play(page, 'Decide')).ok).toBe(true);
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([300, 200]);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]);

  // menu item: chosen from the searchable list, shows its dialog every time it plays
  await page.locator('.act-row.act-action', { hasText: 'Decide' }).click();
  await page.locator('.actions-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Insert Menu Item' }).click();
  await dialogReady(page);
  await page.locator('.dialog input[type="search"]').fill('posterize');
  await expect(page.locator('.dialog select.actions-command-list option')).toHaveCount(1);
  await confirmDialog(page);
  const steps = await stepsOf(page, 'Decide');
  expect(steps[1].menuItem).toBe('image:adjust-posterize');
  await page.evaluate(() => (window.pigmentApp.actions.selectedAction.steps[0].enabled = false));
  const before = await historyLength(page);
  const playing = play(page, 'Decide');
  await expect(page.locator('.dialog')).toContainText('Posterize');
  await confirmDialog(page);
  expect((await playing).ok).toBe(true);
  expect(await historyLength(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('function keys and Button Mode play actions; Action Options sets name, key and colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await showPanel(page);
  await makeAction(page, 'Flip It', [['image:adjust-invert', null]]);
  // Action Options through a double-click on the action
  await page.locator('.act-row.act-action', { hasText: 'Flip It' }).dblclick();
  await expect(page.locator('.dialog')).toContainText('Action Options');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="name"]').fill('Negative');
  await page.locator('.dialog select[data-key="key"]').selectOption('F9');
  await page.locator('.dialog input[data-key="shift"]').check();
  await page.locator('.dialog select[data-key="color"]').selectOption('red');
  await confirmDialog(page);
  const action = await page.evaluate(() => {
    const a = window.pigmentApp.actions.selectedAction;
    return { name: a.name, functionKey: a.functionKey, color: a.color };
  });
  expect(action).toEqual({ name: 'Negative', functionKey: { key: 'F9', shift: true, ctrl: false }, color: 'red' });
  await expect(page.locator('.act-row.act-action', { hasText: 'Negative' }).locator('.act-fkey')).toHaveText('Shift+F9');

  // the key plays it (not while typing in a field)
  const before = await historyLength(page);
  await page.locator('canvas.view').first().hover();
  await page.keyboard.press('Shift+F9');
  await expect.poll(() => historyLength(page)).toBe(before + 1);
  expect(await pixel(page, 5, 5)).toEqual([0, 0, 0, 255]);
  await page.keyboard.press('F9'); // without Shift: not this action
  await page.waitForTimeout(150);
  expect(await historyLength(page)).toBe(before + 1);

  // Button Mode: one button per action, a click plays
  await page.locator('.actions-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Button Mode' }).click();
  await expect(page.locator('.actions-tree')).toBeHidden();
  const button = page.locator('.act-button', { hasText: 'Negative' });
  await expect(button).toHaveClass(/has-color/);
  await button.click();
  await expect.poll(() => historyLength(page)).toBe(before + 2);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
  await runAwait(page, 'actions:button-mode', false);
  await expect(page.locator('.actions-tree')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Save Actions and Load Actions round-trip a set; Clear, Reset and the stored settings', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await showPanel(page);
  // the built-in set is there on a first start
  expect(await page.evaluate(() => window.pigmentApp.actions.sets.map((s) => [s.name, s.actions.length]))).toEqual([['Default Actions', 10]]);
  await runAwait(page, 'actions:new-set', 'Mine');
  await makeAction(page, 'Soften', [['filter:gaussian-blur', { radius: 2 }], ['image:adjust-invert', null]]);
  await runAwait(page, 'actions:insert-stop', { message: 'Done', allowContinue: true });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/actions/mine.pigment-actions'));
  expect(await runAwait(page, 'actions:save')).toBe(true);
  const file = await page.evaluate(() => JSON.parse(new TextDecoder().decode(window.__pigmentTest.written['browser:/actions/mine.pigment-actions'])));
  expect(file.format).toBe('pigment-actions');
  expect(file.sets).toHaveLength(1);
  expect(file.sets[0].name).toBe('Mine');
  expect(file.sets[0].actions[0].steps.map((s) => s.command ?? 'stop')).toEqual(['filter:gaussian-blur', 'image:adjust-invert', 'stop']);

  // Clear All Actions empties the panel (after a confirmation)
  await run(page, 'actions:clear');
  await confirmDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.actions.sets.length)).toBe(0);
  await expect(page.locator('.actions-tree .panel-empty')).toBeVisible();

  // Load Actions brings the set back with the same steps
  await page.evaluate(() => (window.__pigmentTest.nextOpenFiles = ['browser:/actions/mine.pigment-actions']));
  expect(await runAwait(page, 'actions:load')).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.actions.sets.map((s) => s.name))).toEqual(['Mine']);
  const steps = await stepsOf(page, 'Soften');
  expect(steps.map((s) => [s.command, s.arg ?? null])).toEqual([['filter:gaussian-blur', { radius: 2 }], ['image:adjust-invert', null], [null, null]]);
  expect(steps[2].stop).toEqual({ message: 'Done', allowContinue: true });
  // a Photoshop .atn file is refused with an explanation
  await page.evaluate(() => {
    window.__pigmentTest.files['browser:/actions/old.atn'] = new Uint8Array([0, 0, 0, 16, 0, 0, 0, 3, 0, 65, 0, 66, 0, 67]);
    window.pigmentApp.reported = [];
    window.pigmentApp.reportError = (err) => window.pigmentApp.reported.push(err.message);
  });
  expect(await runAwait(page, 'actions:load', 'browser:/actions/old.atn')).toBe(false);
  expect(await page.evaluate(() => window.pigmentApp.reported.join(' '))).toContain('.atn');
  await page.evaluate(() => delete window.pigmentApp.reportError);

  // Reset Actions: the default set only
  await runAwait(page, 'actions:reset', { force: true });
  expect(await page.evaluate(() => window.pigmentApp.actions.sets.map((s) => s.name))).toEqual(['Default Actions']);

  // actions live in the settings: a set made now is there after a reload
  await runAwait(page, 'actions:new-set', 'Kept');
  await makeAction(page, 'Keeper', [['image:adjust-invert', null]]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pigment.settings') ?? '{}').actions?.sets?.map((s) => s.name) ?? [])).toEqual(['Default Actions', 'Kept']);
  const stored = await page.evaluate(() => localStorage.getItem('pigment.settings'));
  await page.addInitScript((s) => localStorage.setItem('pigment.settings', s), stored);
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  expect(await page.evaluate(() => window.pigmentApp.actions.sets.map((s) => [s.name, s.actions.map((a) => a.name).slice(-1)[0]]))).toEqual([['Default Actions', 'Gradient Map'], ['Kept', 'Keeper']]);
  expect(errors).toEqual([]);
});

test('recording follows Undo, records tool selections and Free Transform, and skips what cannot replay', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'shapes.png');
  await showPanel(page);
  await recordNewAction(page, 'Mixed');
  await runAwait(page, 'image:adjust-invert');
  await runAwait(page, 'filter:gaussian-blur', { radius: 2 });
  expect((await stepsOf(page, 'Mixed')).map((s) => s.command)).toEqual(['image:adjust-invert', 'filter:gaussian-blur']);
  // Undo takes the step back out, Redo returns it
  await page.keyboard.press('Control+z');
  expect((await stepsOf(page, 'Mixed')).map((s) => s.command)).toEqual(['image:adjust-invert']);
  await page.keyboard.press('Control+Shift+z');
  expect((await stepsOf(page, 'Mixed')).map((s) => s.command)).toEqual(['image:adjust-invert', 'filter:gaussian-blur']);
  await page.keyboard.press('Control+z');

  // a marquee drag is recorded as the selection it made
  await page.evaluate(() => window.pigmentApp.tools.activate('marquee-rect'));
  await drag(page, [20, 20], [100, 80]);
  let steps = await stepsOf(page, 'Mixed');
  expect(steps.map((s) => s.command)).toEqual(['image:adjust-invert', 'actions:set-selection']);
  expect(steps[1].arg.rect).toEqual([20, 20, 80, 60]);
  await runAwait(page, 'select:none');

  // Free Transform is recorded when it commits
  await page.keyboard.press('Control+t');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.transformTool.session)).toBe(true);
  await page.evaluate(() => {
    const s = window.pigmentApp.transformTool.session;
    s.quad = s.quad.map(([x, y]) => [x + 30, y + 10]);
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.transformTool.session)).toBe(false);
  steps = await stepsOf(page, 'Mixed');
  expect(steps.map((s) => s.command)).toEqual(['image:adjust-invert', 'actions:set-selection', 'select:none', 'actions:transform']);
  expect(steps[3].arg.shift).toEqual([30, 10]);
  await stopRecording(page);
  const recorded = await docHash(page);
  await closeDoc(page);

  await openFixture(page, 'shapes.png');
  expect((await play(page, 'Mixed')).ok).toBe(true);
  expect(await docHash(page)).toBe(recorded);
  expect(errors).toEqual([]);
});

test('dialog commands record their settings and replay silently (replayability audit)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 120, background: 'white' });
  await showPanel(page);
  await recordNewAction(page, 'Dialogs');

  await run(page, 'image:size');
  await expect(page.locator('.dialog')).toContainText('Image Size');
  await confirmAndSettle(page);
  await run(page, 'image:canvas-size');
  await expect(page.locator('.dialog')).toContainText('Canvas Size');
  await confirmAndSettle(page);
  await run(page, 'layer:new', { dialog: true });
  await confirmAndSettle(page);
  await runAwait(page, 'select:all');
  await run(page, 'edit:fill');
  await expect(page.locator('.dialog')).toContainText('Fill');
  await confirmAndSettle(page);
  await run(page, 'edit:stroke');
  await expect(page.locator('.dialog')).toContainText('Stroke');
  await confirmAndSettle(page);
  await run(page, 'select:feather');
  await dialogReady(page);
  await page.locator('.dialog input').first().fill('4');
  await confirmAndSettle(page);
  await run(page, 'select:contract');
  await dialogReady(page);
  await page.locator('.dialog input').first().fill('6');
  await confirmAndSettle(page);
  await run(page, 'image:rotate-arbitrary');
  await setNumber(page, 'angle', 10);
  await confirmAndSettle(page);
  await run(page, 'layer:style');
  await expect(page.locator('.dialog')).toContainText('Layer Style');
  await confirmAndSettle(page);
  await run(page, 'image:duplicate');
  await confirmAndSettle(page);
  await stopRecording(page);

  const steps = await stepsOf(page, 'Dialogs');
  expect(steps.map((s) => s.command)).toEqual([
    'image:size', 'image:canvas-size', 'layer:new', 'select:all', 'edit:fill', 'edit:stroke', 'select:feather', 'select:contract', 'image:rotate-arbitrary', 'layer:style', 'image:duplicate',
  ]);
  // every dialog step carries the settings its dialog was closed with
  for (const s of steps) if (s.command !== 'select:all') expect(s.arg, s.command).toBeTruthy();
  expect(steps[6].arg).toEqual({ amount: 4 });
  expect(steps[7].arg).toEqual({ amount: 6 });
  expect(steps[8].arg).toEqual({ angle: 10 });
  const recorded = await docHash(page);
  const layers = await page.evaluate(() => window.pigmentApp.doc.layers().length);

  // replay on a fresh document: no dialog opens, the result is the same
  await page.evaluate(async () => {
    for (const d of [...window.pigmentApp.docs.docs]) await window.pigmentApp.docs.close(d, { force: true });
  });
  await newDoc(page, { width: 200, height: 120, background: 'white' });
  const outcome = await play(page, 'Dialogs');
  expect(outcome.ok).toBe(true);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await docHash(page)).toBe(recorded);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(layers);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(2); // Duplicate made the second
  expect(errors).toEqual([]);
});

test('the built-in Default Actions play to the end', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  const names = await page.evaluate(() => window.pigmentApp.actions.sets[0].actions.map((a) => a.name));
  expect(names).toEqual([
    'Vignette (selection)', 'Frame Channel – 50 pixel', 'Wood Frame – 50 pixel', 'Cast Shadow (type)', 'Water Reflection (type)',
    'Custom RGB to Grayscale', 'Molten Lead', 'Sepia Toning (layer)', 'Quadrant Colors', 'Gradient Map',
  ]);
  for (const name of names) {
    await openFixture(page, 'gradient.png');
    if (/selection/.test(name)) {
      await page.evaluate(async () => {
        const { Selection } = await import('/lib/selection.js');
        const d = window.pigmentApp.doc;
        window.pigmentApp.applySelection(Selection.fromRect(d.width, d.height, { x: 30, y: 30, width: 100, height: 80 }), 'replace', 'sel');
      });
    }
    if (/type/.test(name)) {
      await page.evaluate(async () => {
        const { TextLayer } = await import('/lib/document.js');
        const d = window.pigmentApp.doc;
        const layer = new TextLayer({ name: 'Title', text: 'Pigment', x: 40, y: 50, font: { family: 'Arial', size: 48, color: '#c02020', weight: 700 } });
        d.add(layer);
        d.setActive(layer);
        d.changed('structure');
      });
    }
    const before = await docHash(page);
    const outcome = await play(page, name);
    expect(outcome, name).toEqual({ ok: true });
    expect(await docHash(page), name).not.toBe(before);
    if (/type/.test(name)) {
      // the type layer itself stays editable: the effect is a rasterized copy
      expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.type).sort())).toEqual(['raster', 'raster', 'text']);
    }
    await closeDoc(page);
  }
  // on a pixel layer the optional "Rasterize Layer" step is skipped without a question
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#208040';
    ctx.fillRect(100, 60, 120, 80);
    l.touch();
    window.pigmentApp.doc.changed('pixels');
  });
  expect(await play(page, 'Cast Shadow (type)')).toEqual({ ok: true });
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(errors).toEqual([]);
});

test('Batch runs an action over browser:/batch/ and writes serial-numbered files into the destination', async ({ page }) => {
  const errors = await openApp(page);
  await makeFiles(page, { 'browser:/batch/a.png': [120, 80, '#ff0000'], 'browser:/batch/b.png': [60, 90, '#00ff00'] });
  await page.evaluate(() => (window.__pigmentTest.files['browser:/batch/notes.txt'] = new Uint8Array([1, 2, 3])));
  await makeAction(page, 'Negative', [['image:adjust-invert', null]]);

  // through the dialog: set, action, source folder, destination folder, naming fields
  await run(page, 'file:automate-batch');
  await expect(page.locator('.dialog')).toContainText('Batch');
  await page.locator('.dialog select[data-key="action"]').selectOption('Negative');
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/batch'));
  await page.locator('.dialog [data-choose="folder"]').click();
  await expect(page.locator('.dialog .automate-path').first()).toHaveText('browser:/batch');
  await page.locator('.dialog select[data-key="destination"]').selectOption('folder');
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/out'));
  await page.locator('.dialog [data-choose="destFolder"]').click();
  await dialogReady(page);
  await page.locator('.dialog [data-naming="0"]').fill('photo_');
  await dialogReady(page);
  await page.locator('.dialog [data-naming="1"]').fill('3 Digit Serial Number');
  await dialogReady(page);
  await page.locator('.dialog [data-naming="2"]').fill('extension');
  await expect(page.locator('.dialog .automate-example')).toHaveText('Example: photo_001.png');
  await setNumber(page, 'startSerial', 7);
  await expect(page.locator('.dialog .automate-example')).toHaveText('Example: photo_007.png');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.__pigmentTest.written).filter((p) => p.startsWith('browser:/out/')).sort())).toEqual(['browser:/out/photo_007.png', 'browser:/out/photo_008.png']);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);

  // the action ran on each file (red -> cyan, green -> magenta), sizes kept, sources untouched, nothing left open
  expect(await writtenImage(page, 'browser:/out/photo_007.png')).toEqual({ width: 120, height: 80, center: [0, 255, 255, 255] });
  expect(await writtenImage(page, 'browser:/out/photo_008.png')).toEqual({ width: 60, height: 90, center: [255, 0, 255, 255] });
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(0);

  // opened files as the source, Save and Close as the destination; replays from its argument without the dialog
  await page.evaluate(() => {
    for (const k of Object.keys(window.__pigmentTest.written)) delete window.__pigmentTest.written[k];
  });
  await runAwait(page, 'file:open-paths', ['browser:/batch/a.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('browser:/batch/a.png');
  const summary = await runAwait(page, 'file:automate-batch', { set: 'Default Actions', action: 'Negative', source: 'open', destination: 'save-close' });
  expect(summary.processed).toBe(1);
  expect(summary.saved).toEqual(['browser:/batch/a.png']);
  expect(summary.errors).toEqual([]);
  expect((await writtenImage(page, 'browser:/batch/a.png')).center).toEqual([0, 255, 255, 255]);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(0);

  // errors: an action that cannot run stops the batch, or is logged to a file and the batch goes on
  await makeAction(page, 'Needs Selection', [['select:inverse', null], ['edit:stroke', { width: 2, color: '#000000', location: 'inside', blend: 'normal', opacity: 100 }], ['select:none', null], ['edit:stroke', { width: 2, color: '#000000', location: 'inside', blend: 'normal', opacity: 100 }]]);
  const logged = await runAwait(page, 'file:automate-batch', { set: 'Default Actions', action: 'Needs Selection', source: 'folder', folder: 'browser:/batch', destination: 'folder', destFolder: 'browser:/out2', errors: 'log', logFile: 'browser:/out2/log.txt' });
  expect(logged.processed).toBe(2);
  expect(logged.errors).toHaveLength(2);
  expect(logged.saved).toEqual([]);
  const log = await page.evaluate(() => new TextDecoder().decode(window.__pigmentTest.written['browser:/out2/log.txt']));
  expect(log).toContain('browser:/batch/a.png');
  expect(log).toContain('Stroke');
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('Image Processor resizes to fit, saves JPEG and PNG copies and can run an action', async ({ page }) => {
  const errors = await openApp(page);
  await makeFiles(page, { 'browser:/shots/wide.png': [400, 200, '#ff0000'], 'browser:/shots/tall.png': [100, 300, '#0000ff'] });
  await makeAction(page, 'Negative', [['image:adjust-invert', null]]);
  await run(page, 'file:script-image-processor');
  await expect(page.locator('.dialog')).toContainText('Image Processor');
  await page.locator('.dialog select[data-key="source"]').selectOption('folder');
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/shots'));
  await page.locator('.dialog [data-choose="folder"]').click();
  await page.locator('.dialog select[data-key="destination"]').selectOption('folder');
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/done'));
  await page.locator('.dialog [data-choose="destFolder"]').click();
  await page.locator('.dialog input[data-key="jpegResize"]').check();
  await setNumber(page, 'jpegWidth', 100);
  await setNumber(page, 'jpegHeight', 100);
  await page.locator('.dialog input[data-key="png"]').check();
  await dialogReady(page);
  await page.locator('.dialog input[data-key="copyright"]').fill('© Test');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.__pigmentTest.written).filter((p) => p.startsWith('browser:/done/')).sort())).toEqual([
    'browser:/done/JPEG/tall.jpg', 'browser:/done/JPEG/wide.jpg', 'browser:/done/PNG/tall.png', 'browser:/done/PNG/wide.png',
  ]);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  // JPEGs fit inside 100 x 100 keeping their proportions; PNGs keep the original size
  const wide = await writtenImage(page, 'browser:/done/JPEG/wide.jpg');
  expect([wide.width, wide.height]).toEqual([100, 50]);
  expect(wide.center[0]).toBeGreaterThan(240);
  expect(wide.center[1]).toBeLessThan(15);
  const tall = await writtenImage(page, 'browser:/done/JPEG/tall.jpg');
  expect([tall.width, tall.height]).toEqual([33, 100]);
  expect(await writtenImage(page, 'browser:/done/PNG/wide.png')).toEqual({ width: 400, height: 200, center: [255, 0, 0, 255] });
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(0);

  // an open document: the action runs for the copies only, the document itself is left as it was
  await newDoc(page, { width: 300, height: 150, name: 'Open One', background: 'white' });
  const before = await historyLength(page);
  const summary = await runAwait(page, 'file:script-image-processor', {
    source: 'open', destination: 'folder', destFolder: 'browser:/done2', jpeg: false, png: true, pngResize: true, pngWidth: 60, pngHeight: 60, runAction: true, set: 'Default Actions', action: 'Negative',
  });
  expect(summary.errors).toEqual([]);
  expect(summary.saved).toEqual(['browser:/done2/PNG/Open One.png']);
  expect(await writtenImage(page, 'browser:/done2/PNG/Open One.png')).toEqual({ width: 60, height: 30, center: [0, 0, 0, 255] });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([300, 150]);
  expect(await pixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
  expect(await historyLength(page)).toBe(before);
  expect(errors).toEqual([]);
});

test('Fit Image scales inside a box through its dialog, is undoable and is recorded', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await showPanel(page);
  await recordNewAction(page, 'Fit');
  await run(page, 'file:automate-fit-image');
  await expect(page.locator('.dialog')).toContainText('Fit Image');
  await setNumber(page, 'width', 100);
  await setNumber(page, 'height', 100);
  await confirmAndSettle(page);
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([100, 75]);
  await stopRecording(page);
  expect(await stepsOf(page, 'Fit')).toMatchObject([{ command: 'file:automate-fit-image', arg: { width: 100, height: 100, dontEnlarge: false } }]);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([400, 300]);

  // a portrait image is limited by its height; Don't Enlarge leaves a small image alone
  await newDoc(page, { width: 200, height: 800 });
  expect((await play(page, 'Fit')).ok).toBe(true);
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([25, 100]);
  await newDoc(page, { width: 40, height: 30 });
  await runAwait(page, 'file:automate-fit-image', { width: 400, height: 400, dontEnlarge: true });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([40, 30]);
  await runAwait(page, 'file:automate-fit-image', { width: 400, height: 400 });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([400, 300]);
  expect(errors).toEqual([]);
});

test('Delete All Empty Layers, Flatten All Layer Effects and Flatten All Masks: one undo each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'white' });
  // Layer 1 empty, Layer 2 painted, Layer 3 empty, an empty group
  await runAwait(page, 'layer:new', { name: 'Layer 1' });
  await runAwait(page, 'layer:new', { name: 'Layer 2' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(20, 20, 60, 60);
    l.touch();
    window.pigmentApp.doc.changed('pixels');
  });
  await runAwait(page, 'layer:new', { name: 'Layer 3' });
  const names = () => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
  expect(await names()).toEqual(['Background', 'Layer 1', 'Layer 2', 'Layer 3']);
  let before = await historyLength(page);
  expect(await runAwait(page, 'file:script-delete-empty-layers')).toBe(2);
  expect(await names()).toEqual(['Background', 'Layer 2']);
  expect(await historyLength(page)).toBe(before + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.active?.name)).toBeTruthy();
  await page.keyboard.press('Control+z');
  expect(await names()).toEqual(['Background', 'Layer 1', 'Layer 2', 'Layer 3']);
  await page.keyboard.press('Control+Shift+z');
  expect(await names()).toEqual(['Background', 'Layer 2']);
  expect(await runAwait(page, 'file:script-delete-empty-layers')).toBe(0); // nothing left to delete, no history entry
  expect(await historyLength(page)).toBe(before + 1);

  // Flatten All Layer Effects: the drop shadow becomes pixels of the layer, the picture stays the same
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers().find((l) => l.name === 'Layer 2')));
  await runAwait(page, 'layer:style', { styles: { dropShadow: { enabled: true, distance: 12, size: 0, angle: 135, opacity: 1, color: '#0000ff', blend: 'normal', spread: 0 } } });
  const styledHash = await docHash(page);
  const shadow = await pixel(page, 85, 85);
  expect(shadow[2]).toBeGreaterThan(200);
  expect(shadow[0]).toBeLessThan(60);
  before = await historyLength(page);
  expect(await runAwait(page, 'file:script-flatten-effects')).toBe(1);
  expect(await historyLength(page)).toBe(before + 1);
  const flat = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Layer 2');
    return { type: l.type, styled: !!l.styles && Object.values(l.styles).some((s) => s?.enabled), alpha: l.canvas.getContext('2d').getImageData(85 - l.x, 85 - l.y, 1, 1).data[3] };
  });
  expect(flat).toEqual({ type: 'raster', styled: false, alpha: 255 });
  expect(await pixel(page, 85, 85)).toEqual(shadow);
  expect(await pixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
  await page.keyboard.press('Control+z');
  expect(await docHash(page)).toBe(styledHash);
  expect(await page.evaluate(() => !!window.pigmentApp.doc.layers().find((x) => x.name === 'Layer 2').styles?.dropShadow?.enabled)).toBe(true);
  await page.keyboard.press('Control+Shift+z');

  // Flatten All Masks: masks are applied to the pixels of every masked pixel layer
  await page.evaluate(async () => {
    const { Selection } = await import('/lib/selection.js');
    const app = window.pigmentApp;
    const d = app.doc;
    d.setActive(d.layers().find((l) => l.name === 'Layer 2'));
    app.applySelection(Selection.fromRect(d.width, d.height, { x: 20, y: 20, width: 30, height: 60 }), 'replace', 'sel');
  });
  await runAwait(page, 'layer:mask', 'reveal-selection');
  expect(await page.evaluate(() => !!window.pigmentApp.doc.active.mask)).toBe(true);
  const masked = await docHash(page);
  expect(await pixel(page, 30, 40)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 70, 40)).toEqual([255, 255, 255, 255]);
  before = await historyLength(page);
  expect(await runAwait(page, 'file:script-flatten-masks')).toBe(1);
  expect(await historyLength(page)).toBe(before + 1);
  const applied = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Layer 2');
    const a = (x, y) => l.canvas.getContext('2d').getImageData(x - l.x, y - l.y, 1, 1).data[3];
    return { mask: !!l.mask, inside: a(30, 40), outside: a(70, 40) };
  });
  expect(applied).toEqual({ mask: false, inside: 255, outside: 0 });
  expect(await docHash(page)).toBe(masked);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => !!window.pigmentApp.doc.layers().find((x) => x.name === 'Layer 2').mask)).toBe(true);
  expect(await docHash(page)).toBe(masked);
  expect(errors).toEqual([]);
});

test('Crop and Straighten Photos separates the photos of a scan; Contact Sheet lays thumbnails out with captions', async ({ page }) => {
  const errors = await openApp(page);
  // a "scan": two photos on a white bed, the second tilted by 8 degrees
  await newDoc(page, { width: 600, height: 400, name: 'Scan', background: 'white' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#c03020';
    ctx.fillRect(40, 60, 180, 120);
    ctx.save();
    ctx.translate(420, 240);
    ctx.rotate((8 * Math.PI) / 180);
    ctx.fillStyle = '#2040c0';
    ctx.fillRect(-100, -70, 200, 140);
    ctx.restore();
    l.touch();
    window.pigmentApp.doc.changed('pixels');
  });
  const result = await runAwait(page, 'file:automate-crop-straighten');
  expect(result.photos).toBe(2);
  expect(result.sizes[0]).toEqual([180, 120]);
  expect(Math.abs(result.sizes[1][0] - 200)).toBeLessThanOrEqual(4);
  expect(Math.abs(result.sizes[1][1] - 140)).toBeLessThanOrEqual(4);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => d.name))).toEqual(['Scan', 'Scan copy', 'Scan copy 2']);
  // the straightened photo is blue to its corners (no white bed left)
  for (const [x, y] of [[3, 3], [190, 3], [3, 132], [190, 132], [100, 70]]) {
    const p = await pixel(page, x, y);
    expect(p[2], `${x},${y}`).toBeGreaterThan(170);
    expect(p[0], `${x},${y}`).toBeLessThan(70);
  }
  await page.evaluate(async () => {
    for (const d of [...window.pigmentApp.docs.docs]) await window.pigmentApp.docs.close(d, { force: true });
  });

  // contact sheet of a folder: one layer per thumbnail and a type layer per caption
  await makeFiles(page, { 'browser:/sheet/one.png': [200, 100, '#ff0000'], 'browser:/sheet/two.png': [100, 200, '#00ff00'], 'browser:/sheet/three.png': [150, 150, '#0000ff'] });
  await run(page, 'file:automate-contact-sheet');
  await expect(page.locator('.dialog')).toContainText('Contact Sheet');
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/sheet'));
  await page.locator('.dialog .automate-folder .btn').click();
  await page.locator('.dialog select[data-key="unit"]').selectOption('px');
  await setNumber(page, 'width', 400);
  await setNumber(page, 'height', 300);
  await setNumber(page, 'dpi', 72);
  await setNumber(page, 'columns', 2);
  await setNumber(page, 'rows', 1);
  await page.locator('.dialog input[data-key="flatten"]').uncheck();
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.docs.map((d) => d.name))).toEqual(['ContactSheet-001', 'ContactSheet-002']);
  const sheets = await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => ({ size: [d.width, d.height], layers: d.layers().map((l) => [l.type, l.name]) })));
  expect(sheets[0].size).toEqual([400, 300]);
  expect(sheets[0].layers).toEqual([['raster', 'Background'], ['raster', 'one.png'], ['text', 'one'], ['raster', 'three.png'], ['text', 'three']]);
  expect(sheets[1].layers).toEqual([['raster', 'Background'], ['raster', 'two.png'], ['text', 'two']]);
  // thumbnails keep their proportions inside their cells
  const thumbs = await page.evaluate(() => window.pigmentApp.docs.docs[0].layers().filter((l) => l.type === 'raster' && l.name !== 'Background').map((l) => [l.canvas.width, l.canvas.height, l.x < 200]));
  expect(thumbs[0][0] / thumbs[0][1]).toBeCloseTo(2, 1);
  expect(thumbs[1][0] / thumbs[1][1]).toBeCloseTo(1, 1);
  expect(thumbs.map((t) => t[2])).toEqual([true, false]);
  expect(errors).toEqual([]);
});

test('Batch walks subfolders, overrides Save As steps with its own names and can be cancelled', async ({ page }) => {
  const errors = await openApp(page);
  await makeFiles(page, { 'browser:/tree/a.png': [40, 30, '#ff0000'], 'browser:/tree/sub/b.png': [40, 30, '#00ff00'], 'browser:/tree/sub/deep/c.png': [40, 30, '#0000ff'] });
  await makeAction(page, 'Save JPEG', [['image:adjust-invert', null], ['actions:save-as', { path: 'browser:/elsewhere/fixed.jpg', quality: 0.9 }]]);
  const base = { set: 'Default Actions', action: 'Save JPEG', source: 'folder', folder: 'browser:/tree', destination: 'folder', destFolder: 'browser:/treeout', naming: ['name-upper', '-', 'serial-2', 'ext'], startSerial: 1 };
  const written = () => page.evaluate(() => Object.keys(window.__pigmentTest.written).sort());

  // without subfolders only the top level is processed
  let summary = await runAwait(page, 'file:automate-batch', { ...base, overrideSave: true });
  expect(summary.processed).toBe(1);
  expect(await written()).toEqual(['browser:/treeout/A-01.jpg']);

  // with subfolders: three files; the Save As step decides the format (JPEG), the batch the folder and the names
  await page.evaluate(() => {
    for (const k of Object.keys(window.__pigmentTest.written)) delete window.__pigmentTest.written[k];
  });
  summary = await runAwait(page, 'file:automate-batch', { ...base, subfolders: true, overrideSave: true });
  expect(summary.processed).toBe(3);
  expect(summary.errors).toEqual([]);
  expect(await written()).toEqual(['browser:/treeout/A-01.jpg', 'browser:/treeout/B-02.jpg', 'browser:/treeout/C-03.jpg']);
  const b = await writtenImage(page, 'browser:/treeout/B-02.jpg');
  expect([b.width, b.height]).toEqual([40, 30]);
  expect(b.center[0]).toBeGreaterThan(235); // green inverted: magenta
  expect(b.center[1]).toBeLessThan(20);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(0);

  // Override Action "Open" Commands: an Open step in the action is skipped, the batch file is the one processed
  await makeAction(page, 'Open Then Invert', [['file:open-paths', ['browser:/tree/a.png']], ['image:adjust-invert', null]]);
  await page.evaluate(() => {
    for (const k of Object.keys(window.__pigmentTest.written)) delete window.__pigmentTest.written[k];
  });
  summary = await runAwait(page, 'file:automate-batch', { ...base, action: 'Open Then Invert', folder: 'browser:/tree/sub', overrideOpen: true, naming: ['name', 'ext'] });
  expect(summary.errors).toEqual([]);
  expect(await written()).toEqual(['browser:/treeout/b.png']);
  expect((await writtenImage(page, 'browser:/treeout/b.png')).center).toEqual([255, 0, 255, 255]);

  // Cancel in the progress dialog ends the batch after the file in work
  await runAwait(page, 'actions:playback-options', { mode: 'pause', pauseSeconds: 0.5 });
  await page.evaluate(() => {
    for (const k of Object.keys(window.__pigmentTest.written)) delete window.__pigmentTest.written[k];
  });
  await page.evaluate((o) => {
    window.__batch = window.pigmentApp.commands.run('file:automate-batch', o, 'api');
  }, { ...base, subfolders: true, overrideSave: true });
  await expect(page.locator('.automate-progress')).toBeVisible();
  await expect(page.locator('.automate-progress .dialog-message')).toContainText('of 3');
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  summary = await page.evaluate(() => window.__batch);
  expect(summary.cancelled).toBe(true);
  expect(summary.processed).toBeLessThan(3);
  expect((await written()).length).toBe(summary.processed);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains('busy'))).toBe(false);
  expect(errors).toEqual([]);
});

test('the panel: sets and actions through its buttons and menus, duplicate, delete, reorder by dragging', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await showPanel(page);
  const tree = () => page.evaluate(() => window.pigmentApp.actions.sets.map((s) => [s.name, s.actions.map((a) => [a.name, a.steps.map((st) => st.label)])]));

  // New Set through the footer button and its prompt
  await page.locator('.actions-footer [data-cmd="actions:new-set"]').click();
  await dialogReady(page);
  await page.locator('.dialog input').first().fill('Workshop');
  await confirmDialog(page);
  await expect(page.locator('.act-row.act-set.selected')).toContainText('Workshop');
  await makeAction(page, 'First', [['image:adjust-invert', null], ['filter:gaussian-blur', { radius: 2 }], ['image:adjust-posterize', { levels: 4 }]]);
  await makeAction(page, 'Second', [['image:adjust-desaturate', null]]);
  expect((await tree())[1]).toEqual(['Workshop', [['First', ['Invert', 'Gaussian Blur', 'Posterize']], ['Second', ['Desaturate']]]]);

  // the context menu of a row offers the panel's commands and acts on that row
  await page.locator('.act-row.act-action', { hasText: 'First' }).click({ button: 'right' });
  await expect(page.locator('.popover-item')).toContainText(['Button Mode', 'New Action…', 'New Set…', 'Duplicate', 'Delete', 'Play', 'Start Recording', 'Insert Menu Item…', 'Insert Stop…', 'Insert Conditional…', 'Action Options…', 'Playback Options…', 'Clear All Actions', 'Reset Actions', 'Load Actions…', 'Save Actions…']);
  await page.locator('.popover-item', { hasText: 'Duplicate' }).click();
  expect((await tree())[1][1].map((a) => a[0])).toEqual(['First', 'First copy', 'Second']);

  // Delete asks for an action, not for a step
  await page.locator('.act-row.act-action', { hasText: 'First copy' }).click();
  await page.locator('.actions-footer [data-cmd="actions:delete"]').click();
  await expect(page.locator('.dialog')).toContainText('Delete the action “First copy”?');
  await confirmDialog(page);
  await expect(page.locator('.act-row.act-action', { hasText: 'First copy' })).toHaveCount(0);
  await page.locator('.act-row.act-step', { hasText: 'Posterize' }).click();
  await page.locator('.actions-footer [data-cmd="actions:delete"]').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await tree())[1]).toEqual(['Workshop', [['First', ['Invert', 'Gaussian Blur']], ['Second', ['Desaturate']]]]);

  // dragging: a step to another position, a step into another action, an action above another
  await page.locator('.act-row.act-step', { hasText: 'Gaussian Blur' }).dragTo(page.locator('.act-row.act-step', { hasText: 'Invert' }), { targetPosition: { x: 80, y: 3 } });
  expect((await tree())[1][1][0]).toEqual(['First', ['Gaussian Blur', 'Invert']]);
  await page.locator('.act-row.act-step', { hasText: 'Invert' }).dragTo(page.locator('.act-row.act-step', { hasText: 'Desaturate' }), { targetPosition: { x: 80, y: 20 } });
  expect((await tree())[1][1]).toEqual([['First', ['Gaussian Blur']], ['Second', ['Desaturate', 'Invert']]]);
  await page.locator('.act-row.act-action', { hasText: 'Second' }).dragTo(page.locator('.act-row.act-action', { hasText: 'First' }), { targetPosition: { x: 80, y: 3 } });
  expect((await tree())[1][1].map((a) => a[0])).toEqual(['Second', 'First']);

  // folding a set hides its rows; Playback Options through its dialog
  await page.locator('.act-row.act-set', { hasText: 'Workshop' }).locator('button.act-twisty').click();
  await expect(page.locator('.act-row.act-action', { hasText: 'Second' })).toHaveCount(0);
  await page.locator('.actions-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Playback Options' }).click();
  await page.locator('.dialog select[data-key="mode"]').selectOption('pause');
  await setNumber(page, 'pauseSeconds', 2);
  await confirmDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.actions.playback)).toEqual({ mode: 'pause', pauseSeconds: 2 });

  // keyboard: arrows move the selection, Delete removes the selected step
  await page.locator('.act-row.act-set', { hasText: 'Workshop' }).locator('button.act-twisty').click();
  await page.locator('.act-row.act-step', { hasText: 'Desaturate' }).click();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => window.pigmentApp.actions.selectedStep?.label)).toBe('Invert');
  await page.keyboard.press('Delete');
  expect((await tree())[1][1][0]).toEqual(['Second', ['Desaturate']]);
  expect(errors).toEqual([]);
});
