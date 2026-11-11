// Content-Aware Scale (lib/content-aware-scale.js + src/shared/pixels/seam-carve.js) and Lens Correction
// (lib/lens-correction.js + src/shared/pixels/lens.js): the commands are live, the on-canvas scale session
// carves around protected areas, respects the selection, commits one undoable entry and cancels cleanly; the
// Lens Correction dialog previews, commits one entry that Last Filter reproduces, and its straighten tool,
// "Straighten horizon", correction checkboxes and auto scale do what they say.
import { test, expect } from '@playwright/test';
import { openApp, openFixture, newDoc, run, runAwait, layerPixel, drag, confirmDialog, historyLength } from './helpers.mjs';

/** Hash of the active layer's pixels together with its size and offset. */
const layerHash = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active;
  const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
  let h = (l.canvas.width * 31 + l.canvas.height) * 31 + l.x * 7 + l.y;
  for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
  return h;
});
const layerBox = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active;
  return { x: l.x, y: l.y, width: l.canvas.width, height: l.canvas.height };
});
const selectRect = (page, rect) => page.evaluate(async (r) => {
  const { Selection } = await import('/lib/selection.js');
  const d = window.pigmentApp.doc;
  window.pigmentApp.applySelection(Selection.fromRect(d.width, d.height, r), 'replace', 'Test selection');
}, rect);

// ---- Content-Aware Scale ---------------------------------------------------------------------------------------

/**
 * Paints the active layer: noise everywhere (expensive to carve) and a flat red disc of diameter 100 at
 * (200, 150) — flat, so without protection the cheapest seams run straight through it. Also saves an alpha
 * channel "Disc" that covers the disc. Deterministic.
 */
const paintDisc = (page, { width = 400, height = 300, cx = 200, cy = 150, r = 50 } = {}) => page.evaluate(([W, H, CX, CY, R]) => {
  const app = window.pigmentApp, d = app.doc, l = d.active;
  const ctx = l.canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const mask = new Uint8ClampedArray(d.width * d.height);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const inside = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) < R;
    if (inside) {
      img.data[p] = 255;
      img.data[p + 1] = 0;
      img.data[p + 2] = 0;
      mask[y * d.width + x] = 255;
    } else {
      img.data[p] = rnd() * 120;
      img.data[p + 1] = 80 + rnd() * 175;
      img.data[p + 2] = 80 + rnd() * 175;
    }
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  l.touch();
  d.channels.push({ id: 'disc-channel', name: 'Disc', mask });
  d.changed('channels');
  d.changed('pixels');
}, [width, height, cx, cy, r]);

/** Extent of the red disc: the longest run of red pixels along any row (width) and any column (height) of the active layer. */
const discSize = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active, W = l.canvas.width, H = l.canvas.height;
  const d = l.canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const red = (x, y) => {
    const p = (y * W + x) * 4;
    return d[p] > 230 && d[p + 1] < 30 && d[p + 2] < 30 && d[p + 3] === 255;
  };
  let width = 0, height = 0, count = 0;
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (red(x, y)) n++;
    count += n;
    if (n > width) width = n;
  }
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < H; y++) if (red(x, y)) n++;
    if (n > height) height = n;
  }
  return { width, height, count };
});
const cas = (page) => page.evaluate(() => {
  const s = window.pigmentApp.contentAwareScale.session;
  return s ? { rect: { ...s.rect }, box: { ...s.box }, amount: s.amount, protect: s.protectId, skin: s.skin, pvScale: s.pvScale, applying: s.applying } : null;
});
const startCas = async (page) => {
  await run(page, 'edit:content-aware-scale');
  await expect(page.locator('#options-bar input[data-key="w"]')).toBeVisible();
  expect(await cas(page)).not.toBeNull();
};
/** Types a value into an options bar field; Enter there commits the field (not the scale) and leaves it. */
const setBarField = async (page, key, value) => {
  const input = page.locator(`#options-bar input[data-key="${key}"]`);
  await input.fill(String(value));
  await input.press('Enter');
  await expect(input).not.toBeFocused();
  expect(await cas(page)).not.toBeNull();
};
const casEnded = (page) => expect.poll(() => page.evaluate(() => !window.pigmentApp.contentAwareScale.session)).toBe(true);

test('edit:content-aware-scale is a live command with an options bar session', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const info = await page.evaluate(() => {
    const app = window.pigmentApp;
    const def = app.commands.commands.get('edit:content-aware-scale');
    return { has: app.commands.has('edit:content-aware-scale'), enabled: app.commands.isEnabled('edit:content-aware-scale'), label: typeof def.label === 'function' ? def.label() : def.label, stubbed: app.stubbed.includes('edit:content-aware-scale') };
  });
  expect(info).toEqual({ has: true, enabled: true, label: 'Content-Aware Scale', stubbed: false });
  await paintDisc(page);
  await startCas(page);
  // the box hugs the layer; the bar has Amount, Protect (the saved channel is offered), skin tones, W and H
  expect((await cas(page)).rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  await expect(page.locator('#options-bar .options-title')).toHaveText('Content-Aware Scale');
  await expect(page.locator('#options-bar input[data-key="amount"]')).toHaveValue('100');
  await expect(page.locator('#options-bar input[data-key="w"]')).toHaveValue('400');
  await expect(page.locator('#options-bar input[data-key="h"]')).toHaveValue('300');
  expect(await page.locator('#options-bar select[data-key="protect"] option').allTextContents()).toEqual(['None', 'Disc']);
  await expect(page.locator('#options-bar input[data-key="skin"]')).not.toBeChecked();
  await page.locator('#options-bar input[data-key="skin"]').check();
  expect((await cas(page)).skin).toBe(true);
  // a typo in W cannot ask for a gigantic canvas
  await setBarField(page, 'w', 99999999);
  expect((await cas(page)).rect.width).toBe(16384);
  await setBarField(page, 'w', 400);
  expect((await cas(page)).rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('content-aware-scale');
  // the command is not available twice, and nothing is recorded until the box is applied
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('edit:content-aware-scale'))).toBe(false);
  await page.keyboard.press('Escape');
  await casEnded(page);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  expect(await historyLength(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('Content-Aware Scale shrinks a layer with a protected circle: the circle keeps its diameter, the background narrows', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintDisc(page);
  const before = await layerHash(page);
  expect(await discSize(page)).toMatchObject({ width: 100, height: 100 });

  // without protection the seams take the flat disc first: it loses most of the width that goes
  await startCas(page);
  await setBarField(page, 'w', 300);
  await expect.poll(() => layerBox(page)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  const unprotected = await discSize(page);
  expect(unprotected.width).toBeLessThan(40);
  await page.keyboard.press('Escape');
  await casEnded(page);
  expect(await layerHash(page)).toBe(before);
  expect(await historyLength(page)).toBe(0);

  // protected by the channel: drag the right edge handle 100 px to the left
  await startCas(page);
  await page.locator('#options-bar select[data-key="protect"]').selectOption({ label: 'Disc' });
  expect((await cas(page)).protect).toBe('disc-channel');
  await drag(page, [400, 150], [300, 150]);
  await expect(page.locator('#options-bar input[data-key="w"]')).toHaveValue('300');
  expect((await cas(page)).rect).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  // the preview already shows the carved layer
  await expect.poll(() => layerBox(page)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  await page.keyboard.press('Enter');
  await casEnded(page);
  expect(await historyLength(page)).toBe(1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[0].label)).toBe('Content-Aware Scale');
  expect(await layerBox(page)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  const kept = await discSize(page);
  expect(kept.width).toBe(100);
  expect(kept.height).toBe(100);
  expect(kept.count).toBe((await page.evaluate(() => window.pigmentApp.doc.channels[0].mask.reduce((n, v) => n + (v ? 1 : 0), 0))));
  // the disc is still a disc: its rows are as long as a circle's chord at that height
  const chords = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active, W = l.canvas.width;
    const d = l.canvas.getContext('2d').getImageData(0, 0, W, l.canvas.height).data;
    const run = (y) => {
      let n = 0;
      for (let x = 0; x < W; x++) if (d[(y * W + x) * 4] > 230 && d[(y * W + x) * 4 + 1] < 30) n++;
      return n;
    };
    return [run(110), run(150), run(185)];
  });
  expect(Math.abs(chords[0] - 2 * Math.sqrt(50 * 50 - 39.5 * 39.5))).toBeLessThanOrEqual(2);
  expect(chords[1]).toBe(100);
  expect(Math.abs(chords[2] - 2 * Math.sqrt(50 * 50 - 35.5 * 35.5))).toBeLessThanOrEqual(2);
  // the document shows the narrower layer and transparency where it used to be
  expect((await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(350, 150, 1, 1).data);
  }))[3]).toBe(0);

  // undo and redo
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(before);
  await runAwait(page, 'edit:redo');
  expect(await layerBox(page)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  expect((await discSize(page)).width).toBe(100);
  expect(errors).toEqual([]);
});

test('handles scale both axes, Amount 0 is a plain resize, and the command replays from its argument', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintDisc(page);
  const before = await layerHash(page);
  // corner handle: both axes; edge handle with Alt scales about the centre
  await startCas(page);
  await drag(page, [400, 300], [360, 270]);
  expect((await cas(page)).rect).toEqual({ x: 0, y: 0, width: 360, height: 270 });
  await drag(page, [180, 0], [180, 20], { modifiers: ['Alt'] });
  expect((await cas(page)).rect).toEqual({ x: 0, y: 20, width: 360, height: 230 });
  // dragging inside moves the box
  await drag(page, [100, 100], [130, 110]);
  expect((await cas(page)).rect).toEqual({ x: 30, y: 30, width: 360, height: 230 });
  // arrow keys nudge
  await page.keyboard.press('ArrowLeft');
  expect((await cas(page)).rect.x).toBe(29);
  await page.locator('#options-bar button[data-action="cancel"]').click();
  await casEnded(page);
  expect(await layerHash(page)).toBe(before);

  // Amount 0: an ordinary resize squeezes the disc with everything else
  await startCas(page);
  await setBarField(page, 'amount', 0);
  await setBarField(page, 'w', 200);
  expect((await cas(page)).amount).toBe(0);
  await page.locator('#options-bar button[data-action="apply"]').click();
  await casEnded(page);
  expect(await historyLength(page)).toBe(1);
  const squeezed = await discSize(page);
  expect(Math.abs(squeezed.width - 50)).toBeLessThanOrEqual(2);
  expect(squeezed.height).toBe(100);
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(before);

  // with an argument the scale applies at once and reports what it did (what an action records)
  const used = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const events = [];
    const off = app.on('command:done', (e) => {
      if (e.id === 'edit:content-aware-scale') events.push(e);
    });
    const result = await app.commands.run('edit:content-aware-scale', { width: 75, unit: 'percent', protect: 'Disc' }, 'api');
    await new Promise((r) => setTimeout(r, 0));
    off?.();
    return { result, arg: events[0]?.arg, cancelled: events[0]?.cancelled, replayable: events[0]?.replayable };
  });
  expect(used.result).toEqual({ width: 75, height: 100, unit: 'percent', dx: 0, dy: 0, amount: 100, protect: 'Disc', skin: false });
  expect(used.arg).toEqual(used.result);
  expect(used.cancelled).toBe(false);
  expect(used.replayable).toBe(true);
  expect(await layerBox(page)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  expect((await discSize(page)).width).toBe(100);
  expect(await historyLength(page)).toBe(1);
  expect(await page.evaluate(() => !!window.pigmentApp.contentAwareScale.session)).toBe(false);
  expect(errors).toEqual([]);
});

test('with a selection only the selected pixels are scaled: everything outside stays, the selection follows', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintDisc(page);
  /** Hash of the layer's pixels outside the document rect r (in document coordinates, transparent where the layer is not). */
  const outsideHash = (r) => page.evaluate((rect) => {
    const d = window.pigmentApp.doc, l = d.active;
    const c = document.createElement('canvas');
    c.width = d.width;
    c.height = d.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(l.canvas, l.x, l.y);
    const data = ctx.getImageData(0, 0, d.width, d.height).data;
    let h = 0;
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue;
      const p = (y * d.width + x) * 4;
      h = (Math.imul(h, 31) + data[p] + data[p + 1] * 3 + data[p + 2] * 5 + data[p + 3] * 7) | 0;
    }
    return h;
  }, r);
  const sel = { x: 100, y: 60, width: 200, height: 180 };
  await selectRect(page, sel);
  const h0 = await historyLength(page);
  const outside = await outsideHash(sel);
  const before = await layerHash(page);

  await startCas(page);
  expect((await cas(page)).rect).toEqual(sel);
  await page.locator('#options-bar select[data-key="protect"]').selectOption({ label: 'Disc' });
  await setBarField(page, 'w', 150);
  await setBarField(page, 'h', 150);
  await expect.poll(async () => (await cas(page)).rect).toEqual({ x: 100, y: 60, width: 150, height: 150 });
  await page.keyboard.press('Enter');
  await casEnded(page);
  expect(await historyLength(page)).toBe(h0 + 1);
  // outside the selection nothing moved
  expect(await outsideHash(sel)).toBe(outside);
  // inside: the piece now covers 150 x 150 from the selection's corner, the rest of the old area is empty
  expect((await layerPixel(page, 120, 80))[3]).toBe(255);
  expect((await layerPixel(page, 249, 209))[3]).toBe(255);
  expect((await layerPixel(page, 270, 150))[3]).toBe(0);
  expect((await layerPixel(page, 150, 225))[3]).toBe(0);
  expect((await layerPixel(page, 320, 150))[3]).toBe(255);
  // the protected disc survived whole inside the smaller piece
  const disc = await discSize(page);
  expect(disc.width).toBe(100);
  expect(disc.height).toBe(100);
  // the selection followed its pixels
  expect(await page.evaluate(() => ({ ...window.pigmentApp.doc.selection.bounds }))).toEqual({ x: 100, y: 60, width: 150, height: 150 });
  // one undo brings back pixels and selection
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(before);
  expect(await page.evaluate(() => ({ ...window.pigmentApp.doc.selection.bounds }))).toEqual(sel);
  expect(await historyLength(page)).toBe(h0);
  expect(errors).toEqual([]);
});

test('the session owns the document: other commands wait, undo cancels, non-pixel layers are refused', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintDisc(page);
  const before = await layerHash(page);
  await startCas(page);
  await setBarField(page, 'w', 320);
  await expect.poll(() => layerBox(page)).toEqual({ x: 0, y: 0, width: 320, height: 300 });
  // a command that would edit the previewed pixels does not run
  await runAwait(page, 'image:adjust-invert');
  expect(await historyLength(page)).toBe(0);
  expect(await cas(page)).not.toBeNull();
  // undo cancels the scale
  await runAwait(page, 'edit:undo');
  await casEnded(page);
  expect(await layerHash(page)).toBe(before);
  expect(await historyLength(page)).toBe(0);
  // afterwards commands run again
  await runAwait(page, 'image:adjust-invert');
  expect(await historyLength(page)).toBe(1);
  await runAwait(page, 'edit:undo');
  // an unchanged box applies nothing
  await startCas(page);
  await page.keyboard.press('Enter');
  await casEnded(page);
  expect(await historyLength(page)).toBe(0);
  expect(await layerHash(page)).toBe(before);
  // a text layer has no pixels to carve
  await page.evaluate(async () => {
    const { TextLayer } = await import('/lib/document.js');
    const app = window.pigmentApp, d = app.doc;
    const t = new TextLayer({ name: 'T', text: 'Hello', x: 20, y: 20 });
    d.root.children.push(t);
    t.parent = d.root;
    d.active = t;
    d.selected = new Set([t]);
    d.changed('tree');
  });
  await runAwait(page, 'edit:content-aware-scale');
  expect(await cas(page)).toBeNull();
  await expect(page.locator('.toast.error')).toContainText('pixel layer');
  expect(errors).toEqual([]);
});

test('a large layer previews on a reduced copy and applies at full size', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1200, height: 900 });
  await paintDisc(page, { width: 1200, height: 900, cx: 600, cy: 450, r: 150 });
  await startCas(page);
  const s = await cas(page);
  expect(s.pvScale).toBeLessThan(0.7);
  await page.locator('#options-bar select[data-key="protect"]').selectOption({ label: 'Disc' });
  await setBarField(page, 'w', 900);
  // the reduced preview is stretched to the box
  await expect.poll(() => layerBox(page)).toEqual({ x: 0, y: 0, width: 900, height: 900 });
  await page.keyboard.press('Enter');
  await casEnded(page);
  expect(await historyLength(page)).toBe(1);
  expect(await layerBox(page)).toEqual({ x: 0, y: 0, width: 900, height: 900 });
  const disc = await discSize(page);
  expect(disc.width).toBe(300);
  expect(disc.height).toBe(300);
  // full-size pixels, not the stretched preview: the noise is still pixel sharp
  const sharp = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 20, 200, 1).data;
    let sum = 0;
    for (let x = 1; x < 200; x++) sum += Math.abs(d[x * 4 + 1] - d[(x - 1) * 4 + 1]);
    return sum / 199;
  });
  expect(sharp).toBeGreaterThan(35);
  expect(errors).toEqual([]);
});

// ---- Lens Correction ---------------------------------------------------------------------------------------------

const lens = (page) => page.locator('.lens-dialog');
const lensParams = (page) => page.evaluate(() => JSON.parse(document.querySelector('.lens-dialog .lc-root')?.dataset.params ?? 'null'));
const lensRenders = (page) => page.evaluate(() => Number(document.querySelector('.lens-dialog .lc-root')?.dataset.renders ?? 0));
const openLens = async (page) => {
  await run(page, 'filter:lens-correction');
  await expect(lens(page)).toBeVisible();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(0);
};
/** Sets a field of the dialog and waits until the preview has rendered with it. */
const setLens = async (page, key, value) => {
  const n = await lensRenders(page);
  const input = lens(page).locator(`input[data-key="${key}"]`).last();
  await input.fill(String(value));
  await input.press('Tab');
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
};
const showTab = (page, id) => lens(page).locator(`.dialog-tab[data-tab="${id}"]`).click();
/** Hash and opaque share of what the dialog's preview canvas shows. */
const previewState = (page) => page.evaluate(() => {
  const c = document.querySelector('.lens-dialog .lc-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0, opaque = 0;
  for (let i = 0; i < d.length; i += 4) {
    h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 5 + d[i + 3] * 7) | 0;
    if (d[i + 3] === 255) opaque++;
  }
  return { hash: h, opaque: opaque / (d.length / 4) };
});
/** Paints sky over ground split by a line through the centre tilted by `deg` (clockwise positive). */
const paintHorizon = (page, deg) => page.evaluate((angle) => {
  const d = window.pigmentApp.doc, l = d.active, W = l.canvas.width, H = l.canvas.height;
  const ctx = l.canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const t = Math.tan((angle * Math.PI) / 180);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = Math.max(0, Math.min(1, y + 1 - (H / 2 + (x + 0.5 - W / 2) * t)));
    const p = (y * W + x) * 4;
    img.data[p] = 110 - 70 * k;
    img.data[p + 1] = 170 - 80 * k;
    img.data[p + 2] = 230 - 190 * k;
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  l.touch();
  d.changed('pixels');
}, deg);

test('filter:lens-correction is a live dialog command (no placeholder, no stub)', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const info = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { FILTERS } = await import('/shared/pixels/filters.js');
    const def = app.commands.commands.get('filter:lens-correction');
    return {
      has: app.commands.has('filter:lens-correction'), enabled: app.commands.isEnabled('filter:lens-correction'), label: def.label(), dialog: !!def.dialog,
      stubbed: app.stubbed.includes('filter:lens-correction'), placeholder: !!FILTERS['lens-correction'].placeholder, opener: typeof app.filterEditor.opener('lens-correction'),
    };
  });
  expect(info).toEqual({ has: true, enabled: true, label: 'Lens Correction…', dialog: true, stubbed: false, placeholder: false, opener: 'function' });
  expect(errors).toEqual([]);
});

test('the Lens Correction dialog previews, OK commits one entry that Last Filter reproduces, Cancel and a neutral OK commit nothing', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  const original = await layerHash(page);
  const h0 = await historyLength(page);

  await openLens(page);
  // it opens neutral on the Custom tab: the preview shows the picture as it is
  expect(await lensParams(page)).toMatchObject({ distortion: 0, angle: 0, scale: 100, vignette: 0, edge: 'transparent', autoScale: false });
  await expect(lens(page).locator('.dialog-tab[data-tab="custom"]')).toHaveAttribute('aria-selected', 'true');
  const neutral = await previewState(page);
  expect(neutral.opaque).toBeGreaterThan(0.3);
  // sliders drive the preview, not the layer
  await setLens(page, 'distortion', 60);
  const pinched = await previewState(page);
  expect(pinched.hash).not.toBe(neutral.hash);
  expect(pinched.opaque).toBeLessThan(neutral.opaque - 0.01); // pincushion leaves empty areas along the edges
  expect(await lensParams(page)).toMatchObject({ distortion: 60 });
  await setLens(page, 'vignette', -60);
  await setLens(page, 'angle', 4);
  expect(await layerHash(page)).toBe(original);
  // Preview off shows the original again, on brings the correction back
  const corrected = await previewState(page);
  let n = await lensRenders(page);
  await lens(page).locator('input[data-key="__preview"]').uncheck();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect((await previewState(page)).hash).toBe(neutral.hash);
  n = await lensRenders(page);
  await lens(page).locator('input[data-key="__preview"]').check();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect((await previewState(page)).hash).toBe(corrected.hash);
  // grid and zoom do not touch the parameters
  await lens(page).locator('input[data-key="__grid"]').check();
  expect((await previewState(page)).hash).not.toBe(corrected.hash);
  await lens(page).locator('input[data-key="__grid"]').uncheck();
  expect((await previewState(page)).hash).toBe(corrected.hash);
  await lens(page).locator('button[data-action="zoom-in"]').click();
  await expect(lens(page).locator('select.lc-zoom')).not.toHaveValue('fit');
  await lens(page).locator('select.lc-zoom').selectOption('fit');
  expect((await previewState(page)).hash).toBe(corrected.hash);
  const params = await lensParams(page);
  expect(params).toMatchObject({ distortion: 60, vignette: -60, angle: 4 });

  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Lens Correction');
  const applied = await layerHash(page);
  expect(applied).not.toBe(original);
  // the layer holds exactly what the engine gives for the committed params
  const diff = await page.evaluate(async (p) => {
    const { lensCorrect } = await import('/shared/pixels/lens.js');
    const app = window.pigmentApp, l = app.doc.active;
    await app.commands.run('edit:undo', undefined, 'api');
    const src = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height);
    await app.commands.run('edit:redo', undefined, 'api');
    const want = lensCorrect({ width: src.width, height: src.height, data: src.data }, p);
    const got = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    // a canvas stores premultiplied pixels, so nearly transparent ones lose colour precision: compare premultiplied
    let max = 0;
    for (let i = 0; i < got.length; i += 4) {
      max = Math.max(max, Math.abs(got[i + 3] - want.data[i + 3]));
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(got[i + c] * got[i + 3] - want.data[i + c] * want.data[i + 3]) / 255);
    }
    return max;
  }, params);
  expect(diff).toBeLessThanOrEqual(1.5);
  // corners are darker (vignette) and the top edge's middle is empty (pincushion)
  expect((await layerPixel(page, 160, 0))[3]).toBe(0);
  expect(await page.evaluate(() => window.pigmentApp.settings.lastFilter)).toMatchObject({ kind: 'lens-correction', name: 'Lens Correction', params });

  // undo, then Last Filter gives the same pixels without a dialog
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(original);
  await runAwait(page, 'filter:last');
  await expect(lens(page)).toHaveCount(0);
  expect(await layerHash(page)).toBe(applied);
  await runAwait(page, 'edit:undo');

  // Cancel: nothing recorded. The next dialog starts neutral again; Previous brings the last correction back
  await openLens(page);
  expect(await lensParams(page)).toMatchObject({ distortion: 0, angle: 0, vignette: 0 });
  n = await lensRenders(page);
  await lens(page).locator('button[data-action="previous"]').click();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect(await lensParams(page)).toMatchObject({ distortion: 60, vignette: -60, angle: 4 });
  await expect(lens(page).locator('input[data-key="distortion"]')).toHaveValue('60');
  await page.keyboard.press('Escape');
  await expect(lens(page)).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0);
  expect(await layerHash(page)).toBe(original);

  // Reset makes the correction neutral, and OK on a neutral correction is not an edit
  await openLens(page);
  await setLens(page, 'scale', 120);
  n = await lensRenders(page);
  await lens(page).locator('button[data-action="reset"]').click();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect(await lensParams(page)).toMatchObject({ scale: 100, distortion: 0 });
  await expect(lens(page).locator('input[data-key="scale"]')).toHaveValue('100');
  await confirmDialog(page);
  expect(await historyLength(page)).toBe(h0);
  expect(await layerHash(page)).toBe(original);
  expect(errors).toEqual([]);
});

test('the straighten tool turns a drawn line into the angle', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintHorizon(page, 6);
  await openLens(page);
  await lens(page).locator('button[data-tool="straighten"]').click();
  await expect(lens(page).locator('.lc-root')).toHaveAttribute('data-tool', 'straighten');
  // draw along a line tilted 6° clockwise (the right end lower)
  const box = await lens(page).locator('.lc-viewport').boundingBox();
  const x0 = box.x + box.width * 0.2, x1 = box.x + box.width * 0.8, yc = box.y + box.height / 2;
  const rise = (x1 - x0) * Math.tan((6 * Math.PI) / 180);
  const n = await lensRenders(page);
  await page.mouse.move(x0, yc - rise / 2);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, yc, { steps: 5 });
  await page.mouse.move(x1, yc + rise / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  const angle = (await lensParams(page)).angle;
  expect(Math.abs(angle + 6)).toBeLessThan(0.3);
  expect(Math.abs(Number(await lens(page).locator('input[data-key="angle"]').inputValue()) - angle)).toBeLessThan(0.01);
  await expect(lens(page).locator('.lc-status')).toContainText('angle set to');
  // a second line on the corrected preview adds to the angle: now tilted 2° the other way
  const rise2 = (x1 - x0) * Math.tan((2 * Math.PI) / 180);
  const n2 = await lensRenders(page);
  await page.mouse.move(x0, yc + rise2 / 2);
  await page.mouse.down();
  await page.mouse.move(x1, yc - rise2 / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n2);
  expect(Math.abs((await lensParams(page)).angle + 4)).toBeLessThan(0.4);
  // back to 6° and apply: the horizon is level in the layer (the same row is sky on the left and on the right)
  await setLens(page, 'angle', -6);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(1);
  for (const x of [60, 340]) {
    expect((await layerPixel(page, x, 135))[2]).toBeGreaterThan(200);
    expect((await layerPixel(page, x, 165))[2]).toBeLessThan(80);
  }
  expect(await page.evaluate(() => window.pigmentApp.settings.lastFilter.params.angle)).toBe(-6);
  expect(errors).toEqual([]);
});

test('Auto Correction: Straighten horizon, the correction checkboxes, auto scale and the edge mode', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintHorizon(page, -4);
  await openLens(page);
  await showTab(page, 'auto');
  await expect(lens(page).locator('.lc-note')).toContainText('no lens profile database');
  // the horizon detector sets the angle that levels it
  let n = await lensRenders(page);
  await lens(page).locator('button[data-action="straighten-horizon"]').click();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  const angle = (await lensParams(page)).angle;
  expect(Math.abs(angle - 4)).toBeLessThan(0.5);
  await expect(lens(page).locator('.lc-status')).toContainText('Horizon tilted');
  // turning leaves empty corners; Auto Scale Image hides them
  const turned = await previewState(page);
  n = await lensRenders(page);
  await lens(page).locator('input[data-key="autoScale"]').check();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect(await lensParams(page)).toMatchObject({ autoScale: true });
  expect((await previewState(page)).opaque).toBeGreaterThan(turned.opaque);
  // the correction checkboxes switch a group off without losing its values
  await showTab(page, 'custom');
  await setLens(page, 'distortion', -30);
  await setLens(page, 'chromaRC', 40);
  await setLens(page, 'vignette', 25);
  await showTab(page, 'auto');
  for (const [key, off] of [['__geo', { distortion: 0, chromaRC: 40, vignette: 25 }], ['__chroma', { distortion: 0, chromaRC: 0, vignette: 25 }], ['__vig', { distortion: 0, chromaRC: 0, vignette: 0 }]]) {
    n = await lensRenders(page);
    await lens(page).locator(`input[data-key="${key}"]`).uncheck();
    await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
    expect(await lensParams(page)).toMatchObject(off);
  }
  await showTab(page, 'custom');
  await expect(lens(page).locator('input[data-key="distortion"]')).toHaveValue('-30');
  await showTab(page, 'auto');
  n = await lensRenders(page);
  await lens(page).locator('input[data-key="__geo"]').check();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect(await lensParams(page)).toMatchObject({ distortion: -30, chromaRC: 0, vignette: 0 });
  // edge: the background colour is named in the params so the result does not depend on later colour changes
  await lens(page).locator('select[data-key="edge"]').selectOption('background');
  await expect.poll(async () => (await lensParams(page)).edge).toBe('background');
  expect((await lensParams(page)).background).toBe(await page.evaluate(() => window.pigmentApp.settings.background));

  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(1);
  // auto scale: the whole layer is covered, and the horizon is level
  const holes = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) n++;
    return n;
  });
  expect(holes).toBe(0);
  for (const x of [50, 350]) {
    expect((await layerPixel(page, x, 130))[2]).toBeGreaterThan(200);
    expect((await layerPixel(page, x, 170))[2]).toBeLessThan(80);
  }
  const last = await page.evaluate(() => window.pigmentApp.settings.lastFilter.params);
  expect(last).toMatchObject({ distortion: -30, chromaRC: 0, vignette: 0, autoScale: true, edge: 'background' });
  expect(Math.abs(last.angle - 4)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('the Remove Distortion tool, a selection, and a smart object', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  // dragging towards the centre pinches (positive), away from it bulges (negative)
  await openLens(page);
  await lens(page).locator('button[data-tool="distort"]').click();
  const box = await lens(page).locator('.lc-viewport').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  let n = await lensRenders(page);
  await page.mouse.move(cx + 200, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  const towards = (await lensParams(page)).distortion;
  expect(towards).toBeGreaterThan(5);
  await expect(lens(page).locator('input[data-key="distortion"]')).toHaveValue(String(towards));
  n = await lensRenders(page);
  await page.mouse.move(cx + 80, cy + 20);
  await page.mouse.down();
  await page.mouse.move(cx + 260, cy + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => lensRenders(page)).toBeGreaterThan(n);
  expect((await lensParams(page)).distortion).toBeLessThan(towards - 10);
  await page.keyboard.press('Escape');
  await expect(lens(page)).toHaveCount(0);

  // a selection limits the correction to its pixels (the selection frames the geometry)
  await selectRect(page, { x: 0, y: 0, width: 160, height: 200 });
  const h0 = await historyLength(page);
  const right = await layerPixel(page, 250, 100);
  const left = await layerPixel(page, 80, 100);
  await openLens(page);
  await setLens(page, 'angle', 180);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(h0 + 1);
  expect(await layerPixel(page, 250, 100)).toEqual(right);
  expect(await layerPixel(page, 79, 99)).toEqual(left);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'select:none');

  // on a smart object the correction becomes a smart filter that re-opens with its own values
  await runAwait(page, 'layer:smart-convert');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('smart');
  const h1 = await historyLength(page);
  await openLens(page);
  await setLens(page, 'vignette', -80);
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.filters?.length)).toBe(1);
  const info = await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    return { type: l.type, layers: d.root.children.length, kind: l.filters[0].kind, vignette: l.filters[0].params.vignette };
  });
  expect(info).toEqual({ type: 'smart', layers: 1, kind: 'lens-correction', vignette: -80 });
  expect(await historyLength(page)).toBe(h1 + 1);
  // the corners are darker than the centre now
  const corner = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const ctx = d.view.compositor.composite(d).getContext('2d');
    const sum = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3).reduce((a, b) => a + b, 0);
    return sum(2, 2) + sum(317, 197);
  });
  await runAwait(page, 'edit:undo');
  const cornerBefore = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const ctx = d.view.compositor.composite(d).getContext('2d');
    const sum = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3).reduce((a, b) => a + b, 0);
    return sum(2, 2) + sum(317, 197);
  });
  expect(corner).toBeLessThan(cornerBefore * 0.5);
  expect(errors).toEqual([]);
});
