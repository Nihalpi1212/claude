// guides-snapping (0.4 package 11): guides as store objects (colour, selection and moves with the Move tool, Delete,
// Edit Selected Guides, Clear Selected / Canvas Guides, Lock Guides), New Guide (with colour, recorded), New Guide
// Layout, New Guides From Shape, rulers (units, origin from the corner, context menu) through app.rulers, the grid
// preferences, View > Snap To for every snapping tool, Smart Guides and Ctrl-hover distances.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, screenPoint, drag, confirmDialog, historyLength } from './helpers.mjs';

const GUIDE_IDS = ['view:smart-guides', 'view:snap-to', 'view:lock-guides', 'view:clear-selected-guides', 'view:clear-artboard-guides', 'view:new-guide-layout', 'view:guides-from-shape', 'view:edit-selected-guides', 'view:ruler-unit', 'view:ruler-origin-reset', 'view:new-guide', 'view:clear-guides'];

/** A dialog focuses its first field one frame after it opens. */
const dialogReady = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const guides = (page) => page.evaluate(() => window.pigmentApp.doc.guides.map((g) => ({ ...g })));
const lastLabel = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index]?.label ?? null);

/** A layer with an opaque rectangle (document px), made active. */
async function addBox(page, name, x, y, w, h, color = '#ff0000') {
  await page.evaluate(async ([n, bx, by, bw, bh, c]) => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new', { name: n }, 'api');
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(bx - l.x, by - l.y, bw, bh);
    l.touch();
    app.doc.changed('pixels', { layer: l });
  }, [name, x, y, w, h, color]);
}

/** Calls a tool's handlers directly with document points (no mouse): what the tool does with snapping. */
const toolPoint = (x, y, extra = {}) => ({ x, y, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, meta: false, ...extra });

test('guide commands replace their stubs with their flags; New Guide asks for position, orientation and colour; the recorder keeps the colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  const info = await page.evaluate((ids) => {
    const app = window.pigmentApp;
    return {
      stubbed: ids.filter((id) => app.stubbed.includes(id) || app.commands.commands.get(id)?.stub),
      changes: ids.filter((id) => app.commands.commands.get(id)?.changesDocument),
    };
  }, GUIDE_IDS);
  expect(info.stubbed).toEqual([]);
  expect(info.changes).toEqual(['view:clear-selected-guides', 'view:clear-artboard-guides', 'view:new-guide-layout', 'view:guides-from-shape', 'view:edit-selected-guides', 'view:ruler-origin-reset', 'view:new-guide', 'view:clear-guides']);

  // record an action while New Guide runs through its dialog: horizontal at 2.5 cm (72 ppi), Light Red
  await page.evaluate(() => {
    const a = window.pigmentApp.actions.newAction({ name: 'Guide' });
    window.pigmentApp.actions.record(a);
  });
  await run(page, 'view:new-guide');
  await expect(page.locator('.dialog')).toContainText('New Guide');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="position"]').fill('2.5 cm');
  await page.locator('.dialog [data-key="orientation"] ~ * button, .dialog .opt-segment button[data-value="y"]').first().click();
  await page.locator('.dialog select[data-key="color"]').selectOption('#ff7f7f');
  await confirmDialog(page);
  await expect.poll(() => guides(page)).toMatchObject([{ axis: 'y', pos: 70.87, color: '#ff7f7f' }]);
  await page.evaluate(() => window.pigmentApp.actions.stopRecording());
  const steps = await page.evaluate(() => window.pigmentApp.actions.sets.flatMap((s) => s.actions).find((a) => a.name === 'Guide').steps.map((s) => [s.command, s.arg]));
  expect(steps).toEqual([['view:new-guide', { axis: 'y', pos: 70.87, color: '#ff7f7f' }]]);
  expect(await lastLabel(page)).toBe('New Guide');

  // "h40" in the position field makes a horizontal guide whatever the orientation buttons say; Cancel adds nothing
  await run(page, 'view:new-guide');
  await dialogReady(page);
  await page.locator('.dialog input').first().fill('h40');
  await confirmDialog(page);
  await expect.poll(async () => (await guides(page)).length).toBe(2);
  expect((await guides(page))[1]).toMatchObject({ axis: 'y', pos: 40 });
  expect((await guides(page))[1].color).toBeUndefined();
  await run(page, 'view:new-guide');
  await dialogReady(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await guides(page)).length).toBe(2);

  // the guide is drawn in its colour
  const px = await page.evaluate(() => {
    const v = window.pigmentApp.view;
    const s = v.toScreen(200, 70.87);
    v.dirty = true;
    v.paint();
    const c = v.canvas.getContext('2d');
    const d = c.getImageData(Math.round(s.x * v.dpr), Math.round(s.y * v.dpr) - 2, 1, 5).data;
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    return rows;
  });
  expect(px.some(([r, g, b]) => r === 255 && g === 127 && b === 127)).toBe(true);
  expect(errors).toEqual([]);
});

test('guides from the rulers snap to layers; Alt drags the other orientation; the Move tool selects, moves, deletes and edits guides', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await addBox(page, 'Box', 120, 60, 80, 50);
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  const ruler = page.locator('.doc-frame:not([hidden]) .ruler-v');
  const rb = await ruler.boundingBox();
  // from the vertical ruler to 2 px left of the box's left edge (well inside 6 screen px): the guide lands on it
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  const target = await screenPoint(page, 120 - 2 / zoom, 150);
  await page.mouse.move(rb.x + rb.width / 2, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => guides(page)).toMatchObject([{ axis: 'x', pos: 120 }]);
  // Alt: the vertical ruler gives a horizontal guide; dropped on the ruler itself, nothing is made
  const t2 = await screenPoint(page, 300, 200);
  await page.mouse.move(rb.x + rb.width / 2, t2.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(t2.x, t2.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await guides(page)).length).toBe(2);
  expect((await guides(page))[1]).toMatchObject({ axis: 'y', pos: 200 });
  await page.mouse.move(rb.x + rb.width / 2, t2.y);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, t2.y + 30, { steps: 3 });
  await page.mouse.up();
  expect((await guides(page)).length).toBe(2);

  // the Move tool: a click selects a guide (not the layer), a drag moves it as one entry
  const [vg, hg] = await guides(page);
  const h0 = await historyLength(page);
  await drag(page, [120, 250], [250, 250], { steps: 10 });
  await expect.poll(() => guides(page)).toMatchObject([{ id: vg.id, axis: 'x', pos: 250 }, { id: hg.id }]);
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await lastLabel(page)).toBe('Move Guide');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.x)).toBe(0); // the layer did not move
  expect(await page.evaluate(() => [...window.pigmentApp.view.selectedGuides])).toEqual([vg.id]);
  // undo puts it back
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await guides(page))[0].pos).toBe(120);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await guides(page))[0].pos).toBe(250);

  // Shift-click adds the other guide; Edit Selected Guides colours both; Delete clears them
  const a = await screenPoint(page, 250, 30), b = await screenPoint(page, 30, 200);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  expect((await page.evaluate(() => [...window.pigmentApp.view.selectedGuides])).sort()).toEqual([vg.id, hg.id].sort());
  await run(page, 'view:edit-selected-guides');
  await expect(page.locator('.dialog')).toContainText('2 guides are selected');
  await dialogReady(page);
  await page.locator('.dialog select[data-key="color"]').selectOption('#00c800');
  await confirmDialog(page);
  await expect.poll(async () => (await guides(page)).map((g) => g.color)).toEqual(['#00c800', '#00c800']);
  expect(await lastLabel(page)).toBe('Edit Guides');
  await page.locator('.doc-frame:not([hidden]) canvas.view').focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await guides(page)).length).toBe(0);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2); // Delete did not take the layer
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await guides(page)).length).toBe(2);

  // one guide: Edit Selected Guides moves it; a drag out of the canvas deletes it
  await page.mouse.click(a.x, a.y);
  await run(page, 'view:edit-selected-guides');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="position"]').fill('260');
  await confirmDialog(page);
  await expect.poll(async () => (await guides(page))[0].pos).toBe(260);
  const g260 = await screenPoint(page, 260, 30);
  const canvasBox = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  await page.mouse.move(g260.x, g260.y);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x - 8, g260.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await guides(page)).map((g) => g.axis)).toEqual(['y']);
  expect(await lastLabel(page)).toBe('Delete Guide');

  // Lock Guides: the Move tool moves the layer instead, the guide stays
  await runAwait(page, 'view:lock-guides');
  expect(await page.evaluate(() => [window.pigmentApp.settings.guides.lock, window.pigmentApp.uiState.lockGuides])).toEqual([true, true]);
  await drag(page, [150, 200], [150, 230], { steps: 6 }); // starts on the guide at y 200
  expect((await guides(page))[0].pos).toBe(200);
  await runAwait(page, 'view:lock-guides');
  expect(await page.evaluate(() => window.pigmentApp.settings.guides.lock)).toBe(false);
  expect(errors).toEqual([]);
});

test('Clear Selected Guides is refused while a slow operation runs and inside Blur Gallery; Clear Canvas Guides undoes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await runAwait(page, 'view:new-guide', { axis: 'x', pos: 100 });
  await runAwait(page, 'view:new-guide', { axis: 'y', pos: 50 });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.view.selectedGuides = new Set([app.doc.guides[0].id]);
  });
  // a slow operation: the menu command is refused, the guide stays
  const busy = await page.evaluate(async () => {
    const app = window.pigmentApp;
    let release;
    const p = app.busy('Working', () => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 30));
    const refused = app.commands.run('view:clear-selected-guides', undefined, 'menu');
    const left = app.doc.guides.length;
    release();
    await p;
    return { refused: refused === undefined, left };
  });
  expect(busy).toEqual({ refused: true, left: 2 });

  // inside Blur Gallery (a modal on-canvas session): refused too
  await run(page, 'filter:field-blur');
  await expect(page.locator('.bg-panel')).toBeVisible();
  const inside = await page.evaluate(() => {
    const app = window.pigmentApp;
    const r = app.commands.run('view:clear-selected-guides', undefined, 'menu');
    const r2 = app.commands.run('view:new-guide', { axis: 'x', pos: 5 }, 'menu');
    return { r: r === undefined, r2: r2 === undefined, left: app.doc.guides.length, sessions: app.sessions.list().map((s) => s.id) };
  });
  expect(inside).toEqual({ r: true, r2: true, left: 2, sessions: ['blur-gallery'] });
  await page.keyboard.press('Escape');
  await expect(page.locator('.bg-panel')).toHaveCount(0);

  // now it runs; then Clear Canvas Guides takes the rest, one undo brings them back
  await page.evaluate(() => window.pigmentApp.commands.run('view:clear-selected-guides', undefined, 'menu'));
  expect((await guides(page)).map((g) => g.axis)).toEqual(['y']);
  await runAwait(page, 'view:clear-guides');
  expect(await guides(page)).toEqual([]);
  expect(await lastLabel(page)).toBe('Clear Guides');
  await runAwait(page, 'edit:undo');
  expect((await guides(page)).map((g) => g.axis)).toEqual(['y']);
  expect(errors).toEqual([]);
});

test('Snap To decides what the marquee, crop, shapes, pen, Free Transform and Move snap to; Ctrl turns it off', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await addBox(page, 'Box', 200, 100, 60, 40);
  await runAwait(page, 'view:new-guide', { axis: 'x', pos: 80 });
  const r = await page.evaluate(async (tp) => {
    const app = window.pigmentApp;
    const P = (x, y, extra = {}) => ({ ...tp, x, y, ...extra });
    const zoom = app.view.zoom;
    const near = 1; // 1 document px is inside the 6 screen px reach at this zoom (about 2.4)
    const out = {};
    const marquee = (x0, y0, x1, y1, extra) => {
      app.tools.activate('marquee-rect');
      const t = app.tools.active;
      t.onPointerDown(P(x0, y0, extra));
      t.onPointerMove(P(x1, y1, extra), true);
      const rect = t.rect();
      t.onPointerUp(P(x1, y1, extra));
      app.snap.end();
      return rect;
    };
    // guide (x 80), layer edge (y 100 top of the box), document edge (x 400)
    out.marquee = marquee(80 + near, 30, 400 - near, 100 - near);
    // Ctrl held: nothing snaps
    out.ctrl = marquee(80 + near, 30, 400 - near, 100 - near, { ctrl: true });
    // Snap To: layers off, guides off
    await app.commands.run('view:snap-to', 'layers', 'api');
    await app.commands.run('view:snap-to', 'guides', 'api');
    out.state = app.uiState.snapTo;
    out.noLayers = marquee(80 + near, 30, 400 - near, 100 - near);
    await app.commands.run('view:snap-to', 'none', 'api');
    out.none = marquee(80 + near, 30, 400 - near, 100 - near);
    await app.commands.run('view:snap-to', 'all', 'api');
    // the grid snaps only while it shows: every 50 px, 5 subdivisions (10)
    app.saveSettings({ showGrid: true, gridSubdivisions: 5, guides: { ...app.settings.guides, snapTo: { ...app.settings.guides.snapTo, guides: false, layers: false, bounds: false } } });
    out.grid = marquee(38 + near, 26, 61 - near, 26);
    app.saveSettings({ showGrid: false });
    out.noGrid = marquee(38 + near, 26, 61 - near, 26);
    await app.commands.run('view:snap-to', 'all', 'api');
    // crop: a new box from near the guide to near the layer's right edge
    app.tools.activate('crop');
    const crop = app.tools.active;
    crop.onPointerDown(P(80 + near, 20));
    crop.onPointerMove(P(260 - near, 140 + near), true);
    out.crop = { ...crop.box };
    crop.onPointerUp(P(260 - near, 140 + near));
    crop.cancel();
    app.snap.end();
    // a shape: its drag start and end
    app.tools.activate('shape-rect');
    const shape = app.tools.active;
    shape.onPointerDown(P(80 + near, 200));
    shape.onPointerMove(P(200 - near, 250), true);
    out.shape = [shape.drag.start.x, shape.drag.current.x];
    shape.onPointerUp?.(P(200 - near, 250));
    app.snap.end();
    // the pen: the second anchor near the guide
    app.tools.activate('pen-tool');
    const pen = app.tools.active;
    pen.onPointerDown(P(40, 270));
    pen.onPointerUp(P(40, 270));
    pen.onPointerDown(P(80 - near, 272));
    pen.onPointerUp(P(80 - near, 272));
    const d = pen.draw;
    out.pen = d ? d.draft.subpaths[d.sp].points.at(-1).x : null;
    pen.cancel?.();
    app.snap.end();
    return out;
  }, toolPoint(0, 0));
  expect(r.marquee).toEqual({ x: 80, y: 30, width: 320, height: 70 });
  expect(r.ctrl).toEqual({ x: 81, y: 30, width: 318, height: 69 });
  expect(r.state).toBe('grid,bounds,artboards,slices');
  // without layers and guides: only the document edge (x 400) is still there
  expect(r.noLayers.x).not.toBe(80);
  expect(r.noLayers.x + r.noLayers.width).toBe(400);
  expect(r.none.x + r.none.width).not.toBe(400);
  expect(r.grid.x).toBe(40);
  expect(r.grid.x + r.grid.width).toBe(60);
  expect(r.noGrid.x).toBe(39);
  expect(r.crop).toEqual({ x: 80, y: 20, width: 180, height: 120 });
  expect(r.shape).toEqual([80, 200]);
  expect(r.pen).toBe(80);

  // Free Transform: the box move snaps the moved layer's box to the guide (the Box layer again: the shape tool made one)
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(d.layers().find((l) => l.name === 'Box'));
    window.pigmentApp.commands.run('edit:free-transform', undefined, 'api');
  });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('transform');
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  // the box's left edge 200 would land 2 screen px right of the guide at 80
  await drag(page, [212, 108], [212 - 120 + 2 / zoom, 108], { steps: 8 }); // not on the pivot in the middle
  const tx = await page.evaluate(() => {
    const t = window.pigmentApp.tools.active;
    return Math.min(...t.session.quad.map((q) => q[0]));
  });
  expect(tx).toBeCloseTo(80, 5);
  await page.keyboard.press('Escape');

  // the Move tool: the layer's content (not its canvas) meets the guide; Ctrl held does not snap
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  const x0 = await page.evaluate(() => window.pigmentApp.doc.active.x);
  await drag(page, [230, 120], [230 - 120 + 2 / zoom, 120], { steps: 8 });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.x)).toBe(x0 - 120);
  await runAwait(page, 'edit:undo');
  await drag(page, [230, 120], [230 - 120 + 2 / zoom, 120], { steps: 8, modifiers: ['Control'] });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.x)).toBe(x0 + Math.round(-120 + 2 / zoom));
  expect(errors).toEqual([]);
});

test('Smart Guides: alignment lines while moving, equal spacing snaps, Ctrl-hover measures; the menu toggles them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 420, height: 300, background: 'white' });
  await addBox(page, 'A', 20, 100, 40, 40, '#0000ff');
  await addBox(page, 'B', 100, 100, 40, 40, '#00ff00');
  await addBox(page, 'C', 200, 200, 40, 40, '#ff0000');
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  // drag C so its left edge comes 2 screen px short of 180 (B's right edge + the 40 px gap between A and B), its top
  // 2 screen px below 100: it lands at x 180 (equal spacing) and y 100 (aligned with A and B)
  const from = await screenPoint(page, 220, 220);
  const to = await screenPoint(page, 220 - 20 - 2 / zoom, 220 - 100 + 2 / zoom);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  const overlay = await page.evaluate(() => {
    const o = window.pigmentApp.snap.overlay;
    return o ? { lines: o.lines.map((l) => [l.axis, l.pos]), gaps: o.gaps.map((g) => [g.axis, g.from, g.to]) } : null;
  });
  await page.mouse.up();
  expect(await page.evaluate(() => { const l = window.pigmentApp.doc.active; return [l.x, l.y]; })).toEqual([-20, -100]);
  expect(overlay.lines).toContainEqual(['y', 100]);
  expect(overlay.gaps).toContainEqual(['x', 140, 180]);
  expect(overlay.gaps).toContainEqual(['x', 60, 100]);
  // the gesture is over: the overlay is gone
  expect(await page.evaluate(() => window.pigmentApp.snap.overlay)).toBeNull();

  // Ctrl-hover over B with C active: the gap between them is measured
  const over = await screenPoint(page, 120, 120);
  await page.keyboard.down('Control');
  await page.mouse.move(over.x, over.y);
  await page.mouse.move(over.x + 2, over.y + 1);
  const measured = await page.evaluate(() => window.pigmentApp.snap.overlay?.gaps.map((g) => [g.axis, g.from, g.to]) ?? null);
  await page.keyboard.up('Control');
  expect(measured).toContainEqual(['x', 140, 180]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.snap.overlay)).toBeNull();

  // View > Show > Smart Guides off: no overlay, no spacing snap
  await runAwait(page, 'view:smart-guides');
  expect(await page.evaluate(() => [window.pigmentApp.settings.guides.smartGuides, window.pigmentApp.uiState.smartGuides])).toEqual([false, false]);
  await runAwait(page, 'edit:undo');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  expect(await page.evaluate(() => window.pigmentApp.snap.overlay)).toBeNull();
  await page.mouse.up();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.x)).not.toBe(-20);
  expect(errors).toEqual([]);
});

test('rulers: units from the context menu; the corner drag sets the origin that Properties and Info read; double-click resets it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  // the ruler's context menu sets the units
  const ruler = page.locator('.doc-frame:not([hidden]) .ruler-h');
  await ruler.click({ button: 'right', position: { x: 100, y: 10 } });
  await page.locator('.popover .popover-item', { hasText: 'Centimeters' }).click();
  expect(await page.evaluate(() => window.pigmentApp.settings.rulerUnit)).toBe('cm');
  await ruler.click({ button: 'right', position: { x: 100, y: 10 } });
  await expect(page.locator('.popover .popover-item[aria-checked="true"]')).toHaveText(/Centimeters/);
  await page.locator('.popover .popover-item', { hasText: 'Pixels' }).click();

  // drag from the corner to (100, 50): the new origin, one undoable entry
  const corner = page.locator('.doc-frame:not([hidden]) .ruler-corner');
  const cb = await corner.boundingBox();
  const to = await screenPoint(page, 100, 50);
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.rulers.origin(window.pigmentApp.doc))).toEqual({ x: 100, y: 50 });
  expect(await lastLabel(page)).toBe('Ruler Origin');
  const read = await page.evaluate(() => {
    const app = window.pigmentApp;
    return { x: app.rulers.toRuler(app.doc, 'x', 150), fmt: app.rulers.format(app.doc, 'y', 0), unit: app.rulers.unit(app.doc) };
  });
  expect(read).toEqual({ x: 50, fmt: '-50 px', unit: 'px' });
  // the Properties transform section counts X / Y from the origin (Background at 0, 0 reads -100, -50)
  await runAwait(page, 'window:panel-properties');
  await expect(page.locator('[data-panel="properties"] input[data-axis="x"]').first()).toHaveValue('-100');
  // a guide made from the dialog counts from the origin too
  await run(page, 'view:new-guide');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="position"]').fill('20');
  await confirmDialog(page);
  await expect.poll(() => guides(page)).toMatchObject([{ axis: 'x', pos: 120 }]);
  // the rulers read 0 at the origin: double-click on the corner puts it back; undo moves it again
  await corner.dblclick();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.rulers.origin(window.pigmentApp.doc))).toEqual({ x: 0, y: 0 });
  expect(await lastLabel(page)).toBe('Reset Ruler Origin');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.rulers.origin(window.pigmentApp.doc))).toEqual({ x: 100, y: 50 });
  // the origin is saved with the document
  const saved = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const json = JSON.parse(JSON.stringify(app.doc.store.toJSON()));
    return json.rulerOrigin;
  });
  expect(saved).toEqual({ v: 1, data: { x: 100, y: 50 } });
  expect(errors).toEqual([]);
});

test('Guides, Grid & Slices preferences: guide and grid colours and styles, Gridline Every with its unit, Subdivisions', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await page.evaluate(() => {
    window.__prefs = window.pigmentApp.preferencesDialog();
  });
  await expect(page.locator('.prefs-dialog .section', { hasText: 'Guides, Grid & Slices' })).toHaveCount(1);
  for (const key of ['guideColor', 'guideStyle', 'smartGuideColor', 'gridColor', 'gridStyle', 'gridSize', 'gridUnit', 'gridSubdivisions']) await expect(page.locator(`.prefs-dialog [data-key="${key}"]`).first()).toHaveCount(1);
  const setColor = async (key, hex) => {
    const input = page.locator(`.prefs-dialog input[type="color"][data-key="${key}"]`);
    await input.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, hex);
  };
  await setColor('gridColor', '#00ff00');
  await setColor('guideColor', '#ff0000');
  await page.locator('.prefs-dialog select[data-key="gridStyle"]').selectOption('lines');
  await page.locator('.prefs-dialog select[data-key="guideStyle"]').selectOption('dashed');
  await page.locator('.prefs-dialog input[data-key="gridSize"]').fill('1');
  await page.locator('.prefs-dialog input[data-key="gridSize"]').dispatchEvent('change');
  await page.locator('.prefs-dialog select[data-key="gridUnit"]').selectOption('in');
  await page.locator('.prefs-dialog input[data-key="gridSubdivisions"]').fill('2');
  await page.locator('.prefs-dialog input[data-key="gridSubdivisions"]').dispatchEvent('change');
  await page.locator('.prefs-dialog .dialog-buttons .btn.primary').click();
  await page.evaluate(() => window.__prefs);
  const s = await page.evaluate(() => {
    const st = window.pigmentApp.settings;
    return { gridSize: st.gridSize, sub: st.gridSubdivisions, g: { color: st.guides.color, style: st.guides.style, gridColor: st.guides.gridColor, gridUnit: st.guides.gridUnit, snapTo: st.guides.snapTo.guides } };
  });
  expect(s).toEqual({ gridSize: 1, sub: 2, g: { color: '#ff0000', style: 'dashed', gridColor: '#00ff00', gridUnit: 'in', snapTo: true } });

  // the grid shows in its colour on its lines: 1 inch at 72 ppi = 72 px, subdivided every 36 px
  await runAwait(page, 'view:grid');
  const px = await page.evaluate(() => {
    const v = window.pigmentApp.view;
    v.dirty = true;
    v.paint();
    const c = v.canvas.getContext('2d');
    const at = (x, y) => {
      const s = v.toScreen(x, y);
      return Array.from(c.getImageData(Math.round(s.x * v.dpr), Math.round(s.y * v.dpr), 1, 1).data).slice(0, 3);
    };
    const line = (x, y) => [-1, 0, 1].map((d) => at(x + d / v.zoom, y));
    return { major: line(72, 150), off: at(54, 150) };
  });
  expect(px.major.some(([r, g, b]) => g > r + 40 && g > b + 40)).toBe(true);
  expect(px.off).toEqual([255, 255, 255]);
  await runAwait(page, 'view:grid');
  expect(errors).toEqual([]);
});

test('New Guide Layout previews on the canvas and adds its guides as one entry; New Guides From Shape; Clear Artboard Guides waits for artboards', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await runAwait(page, 'view:new-guide', { axis: 'x', pos: 33 });
  await run(page, 'view:new-guide-layout');
  await expect(page.locator('.dialog')).toContainText('New Guide Layout');
  await dialogReady(page);
  await page.locator('.dialog input[data-key="colNumber"]').fill('4');
  await page.locator('.dialog input[data-key="colNumber"]').dispatchEvent('change');
  await page.locator('.dialog input[data-key="colGutter"]').fill('20');
  await page.locator('.dialog input[data-key="colGutter"]').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.guidePreview?.map((g) => g.pos))).toEqual([0, 85, 105, 190, 210, 295, 315, 400]);
  const h0 = await historyLength(page);
  await confirmDialog(page);
  await expect.poll(async () => (await guides(page)).map((g) => g.pos)).toEqual([0, 85, 105, 190, 210, 295, 315, 400]); // Clear existing guides was on
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await lastLabel(page)).toBe('New Guide Layout');
  expect(await page.evaluate(() => window.pigmentApp.view.guidePreview)).toBeNull();
  // the same layout as an argument (what an action replays), adding to the guides there
  await runAwait(page, 'view:clear-guides');
  await runAwait(page, 'view:new-guide-layout', { rows: { enabled: true, number: 2, gutter: 0 }, margin: { enabled: true, top: 10, bottom: 10, left: 0, right: 0 } });
  expect((await guides(page)).map((g) => [g.axis, g.pos])).toEqual([['x', 0], ['x', 400], ['y', 10], ['y', 150], ['y', 290]]);

  // New Guides From Shape: only with a shape layer; guides on its edges and centres
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('view:guides-from-shape'))).toBe(false);
  await runAwait(page, 'view:clear-guides');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { ShapeLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    const pt = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
    const l = new ShapeLayer({ name: 'S', path: { subpaths: [{ closed: true, points: [pt(50, 60), pt(150, 60), pt(150, 100), pt(50, 100)] }] }, shapeKind: 'rect' });
    structural(app, 'Add shape', () => {
      d.add(l, d.root, d.root.children.length);
      d.setActive(l);
    });
  });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('view:guides-from-shape'))).toBe(true);
  await runAwait(page, 'view:guides-from-shape');
  expect((await guides(page)).map((g) => [g.axis, g.pos])).toEqual([['x', 50], ['x', 100], ['x', 150], ['y', 60], ['y', 80], ['y', 100]]);
  expect(await lastLabel(page)).toBe('New Guides From Shape');
  // no artboards yet: Clear Selected Artboard Guides has nothing to clear
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('view:clear-artboard-guides'))).toBe(false);
  expect(errors).toEqual([]);
});
