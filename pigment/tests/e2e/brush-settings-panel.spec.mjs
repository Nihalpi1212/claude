// brush-settings-panel (ARCHITECTURE.md "0.5 features", package 2; port 8852): the Brush Settings panel (F5), its
// sections, locks and Clear Brush Controls, per tool; Texture (each tip and the whole stroke) repeating with the
// pattern, Protect Texture across a pick; Dual Brush, Noise, Wet Edges and Brush Pose on real strokes, each one
// history entry, in RGB, Grayscale and 16-bit documents; the Brushes panel's groups, search, recent row, New Brush
// Preset with tool and colour capture, reordering and deleting; the options bar's picker; tool:brush-preset recorded
// with its data; .abr import (brushes, their sampled tips and their pattern) and export; a preset-store write failure.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

/**
 * window.__paint(tool, preset | null, points, opts): the tool gets the preset as its brush (when given) and the options,
 * then one stroke through its pointer handlers, as the canvas sends them. Returns the history labels added.
 */
async function kit(page) {
  await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      const { setToolBrush, toolBrush } = await import('/lib/brush/tool-brush.js');
      const { normalizeBrush } = await import('/lib/brush/preset.js');
      window.__brush = { setToolBrush, toolBrush, normalizeBrush };
      window.__paint = (toolId, preset, points, opts = {}) => {
        app.tools.activate(toolId);
        if (preset) setToolBrush(app, toolId, normalizeBrush(preset), { includeTool: false, respectLocks: false });
        for (const [k, v] of Object.entries(opts)) app.tools.setOpt(toolId, k, v);
        const tool = app.tools.get(toolId);
        const h = app.doc.history;
        const before = h.index;
        const at = (p) => ({ pressure: 1, button: 0, buttons: 1, ...p });
        tool.onPointerDown(at(points[0]));
        for (const p of points.slice(1)) tool.onPointerMove(at(p), true);
        tool.onPointerUp(at(points[points.length - 1]));
        return h.entries.slice(before + 1, h.index + 1).map((e) => e.label);
      };
      window.__line = (x0, x1, y, step = 4) => Array.from({ length: Math.floor((x1 - x0) / step) + 1 }, (_, i) => ({ x: x0 + i * step, y }));
      window.__row = (y, x0, x1, layer = app.doc.active) => Array.from(layer.canvas.getContext('2d').getImageData(x0 - layer.x, y - layer.y, x1 - x0, 1).data).filter((_, i) => i % 4 === 3);
      window.__toasts = [];
      const toast = app.dialogs.toast.bind(app.dialogs);
      app.dialogs.toast = (msg, o) => {
        window.__toasts.push(String(msg));
        return toast(msg, o);
      };
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

const brushOf = (page, tool = 'brush') => page.evaluate((t) => window.__brush.toolBrush(window.pigmentApp, t).preset, tool);

test('F5 opens Brush Settings; a section\'s box and fields write the tool\'s own brush; Clear Brush Controls; no history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.panels.setCollapsed('middle', true);
    app.panels.setCollapsed('bottom', true);
    document.activeElement?.blur?.();
  });
  expect(await page.evaluate(() => window.pigmentApp.stubbed.includes('window:panel-brush-settings'))).toBe(false);
  await page.keyboard.press('F5');
  await expect(page.locator('.brush-settings-panel')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.panels.isVisible('brush-settings'))).toBe(true);
  const entries0 = await page.evaluate(() => window.pigmentApp.doc.history.index);
  // Shape Dynamics: the box turns it on and shows its controls
  await page.locator('.bs-section[data-section="shapeDynamics"] input').click();
  await expect(page.locator('.bs-pane[data-section="shapeDynamics"]')).toBeVisible();
  const jitter = page.locator('.bs-pane .bs-slider[data-key="sizeJitter"] input.num');
  await jitter.fill('40');
  await jitter.press('Enter');
  await page.locator('.bs-pane .bs-control[data-key="sizeControl"] select').selectOption('fade');
  await page.locator('.bs-pane .bs-control[data-key="sizeControl"] input.num').fill('12');
  await page.locator('.bs-pane .bs-control[data-key="sizeControl"] input.num').press('Enter');
  let b = await brushOf(page);
  expect(b.shapeDynamics.enabled).toBe(true);
  expect(b.shapeDynamics.sizeJitter).toBeCloseTo(0.4, 5);
  expect(b.shapeDynamics.sizeControl).toEqual({ type: 'fade', fadeSteps: 12 });
  // Brush Tip Shape: Spacing off, Flip X, the size; the flags in the list (Wet Edges, Build-up)
  await page.locator('.bs-section[data-section="tip"] .bs-section-label').click();
  await page.locator('.bs-pane [data-key="spacingOn"] input').uncheck();
  await page.locator('.bs-pane [data-key="flipX"] input').check();
  const size = page.locator('.bs-pane .bs-slider[data-key="size"] input.num');
  await size.fill('120');
  await size.press('Enter');
  await page.locator('.bs-section[data-section="wetEdges"] input').check();
  await page.locator('.bs-section[data-section="buildUp"] input').check();
  b = await brushOf(page);
  expect([b.tip.spacingOn, b.tip.flipX, b.tip.size, b.wetEdges, b.buildUp]).toEqual([false, true, 120, true, true]);
  // the options bar follows (the flat size wins, S1.3) and the airbrush button reads the one build-up flag
  await expect(page.locator('#options-bar .opt[data-key="size"] input').first()).toHaveValue('120');
  // each tool has its own brush
  const eraser = await brushOf(page, 'eraser');
  expect([eraser.shapeDynamics.enabled, eraser.wetEdges]).toEqual([false, false]);
  // Clear Brush Controls: every section off, its values and the tip kept
  await page.locator('.brush-settings-panel [data-act="clear"]').click();
  b = await brushOf(page);
  expect([b.shapeDynamics.enabled, b.wetEdges, b.buildUp, b.tip.size, b.tip.flipX]).toEqual([false, false, false, 120, true]);
  expect(b.shapeDynamics.sizeJitter).toBeCloseTo(0.4, 5);
  await expect(page.locator('.bs-section[data-section="shapeDynamics"] input')).not.toBeChecked();
  // the stroke preview is the engine's
  await expect(page.locator('.bs-preview canvas')).toHaveCount(1);
  // tool settings, not document edits
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(entries0);
  // a DabTool shows Brush Tip Shape only
  await page.evaluate(() => window.pigmentApp.tools.activate('dodge'));
  await expect(page.locator('.bs-section[data-section="scattering"] input')).toBeDisabled();
  await expect(page.locator('.bs-pane[data-section="tip"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('locks survive a preset pick from the Brushes panel; Unlock All Settings lets the next pick replace them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    const { setToolBrush, normalizeBrush } = window.__brush;
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 30 }, scattering: { enabled: true, scatter: 2, count: 3 }, shapeDynamics: { enabled: true, sizeJitter: 0.5 } }), { includeTool: false, respectLocks: false });
    app.panels.setCollapsed('middle', true);
    app.panels.setCollapsed('bottom', true);
    app.panels.show('brush-settings', { reveal: true });
  });
  await page.locator('.bs-section[data-section="scattering"] .bs-lock').click();
  await expect(page.locator('.bs-section[data-section="scattering"] .bs-lock')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.pigmentApp.settings.brushes.locks)).toEqual({ scattering: true });
  await page.evaluate(() => window.pigmentApp.panels.show('brushes', { reveal: true }));
  await page.locator('.brush-panel .brush-list .brush-item[data-id="soft-45"]').click();
  await expect.poll(async () => (await brushOf(page)).tip.size).toBe(45);
  let b = await brushOf(page);
  // the locked section kept its values; the others come from the preset
  expect([b.tip.hardness, b.scattering.enabled, b.scattering.scatter, b.scattering.count, b.shapeDynamics.enabled]).toEqual([0, true, 2, 3, false]);
  // Unlock All Settings, then pick again: nothing is kept
  await page.evaluate(() => window.pigmentApp.panels.show('brush-settings', { reveal: true }));
  await page.locator('.brush-settings-panel [data-act="menu"]').click();
  await page.locator('.popover .popover-item, .popover button').filter({ hasText: 'Unlock All Settings' }).first().click();
  expect(await page.evaluate(() => window.pigmentApp.settings.brushes.locks)).toEqual({});
  await runAwait(page, 'tool:brush-preset', 'hard-19');
  b = await brushOf(page);
  expect([b.tip.size, b.scattering.enabled]).toEqual([19, false]);
  expect(errors).toEqual([]);
});

test('a textured stroke repeats with the pattern, each tip and whole; a missing pattern paints plain with one toast; one entry that undoes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 420, height: 160, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      await app.patterns.get('checkerboard');
      const out = {};
      const texture = (eachTip, pattern = { presetId: 'checkerboard', name: 'Checkerboard' }) => ({ tip: { size: 80, hardness: 1, spacing: 0.1 }, texture: { enabled: true, pattern, eachTip, mode: 'multiply', depth: 1, scale: 1 } });
      const opts = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false };
      for (const [name, eachTip] of [['whole', false], ['tip', true]]) {
        const before = app.doc.history.index;
        // each tip builds up through the pattern dab after dab: a low flow keeps it from saturating
        const labels = window.__paint('brush', texture(eachTip), window.__line(40, 380, 80), { ...opts, flow: eachTip ? 0.15 : 1 });
        const row = window.__row(80, 120, 280);
        out[name] = { labels, row, period: row.slice(0, 64).every((a, i) => Math.abs(a - row[i + 16]) <= 2), varies: Math.max(...row) - Math.min(...row) };
        // undo restores the empty layer
        app.commands.run('edit:undo', null, 'api');
        out[name].undone = Math.max(...window.__row(80, 120, 280));
        out[name].entries = app.doc.history.index - before;
      }
      // the checkerboard's two greys (96 and 208 of 255) set the alpha: low where dark, high where light
      window.__toasts.length = 0;
      window.__paint('brush', texture(false, { presetId: 'no-such-pattern', name: 'Gone' }), window.__line(40, 380, 80), opts);
      const plain = window.__row(80, 120, 280);
      out.missing = { min: Math.min(...plain), toasts: window.__toasts.filter((t) => /pattern/.test(t)).length };
      return out;
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  for (const k of ['whole', 'tip']) {
    expect(r[k].labels).toHaveLength(1);
    expect(r[k].period, k).toBe(true);
    expect(r[k].varies, k).toBeGreaterThan(60);
    expect(r[k].undone).toBe(0);
  }
  expect(Math.min(...r.whole.row)).toBeGreaterThanOrEqual(90);
  expect(Math.max(...r.whole.row)).toBeLessThanOrEqual(212);
  expect(r.missing).toEqual({ min: 255, toasts: 1 });
  expect(errors).toEqual([]);
});

test('Protect Texture (the panel\'s box) keeps the pattern and scale when a textured preset is picked', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  const id = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      app.tools.activate('brush');
      const { setToolBrush, normalizeBrush } = window.__brush;
      setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 30 }, texture: { enabled: true, pattern: { presetId: 'checkerboard', name: 'Checkerboard' }, scale: 0.5 } }), { includeTool: false, respectLocks: false });
      await app.presets.ready('brushes');
      app.panels.setCollapsed('middle', true);
      app.panels.setCollapsed('bottom', true);
      app.panels.show('brush-settings', { reveal: true });
      return app.presets.add('brushes', { name: 'Dotted', data: { tip: { size: 50 }, texture: { enabled: true, pattern: { presetId: 'dots', name: 'Dots' }, scale: 2 } } }).id;
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  await page.locator('.bs-section[data-section="protectTexture"] input').check();
  expect((await brushOf(page)).protectTexture).toBe(true);
  await runAwait(page, 'tool:brush-preset', id);
  const b = await brushOf(page);
  expect([b.tip.size, b.texture.enabled, b.texture.pattern?.presetId, b.texture.scale]).toEqual([50, true, 'checkerboard', 0.5]);
  // Copy Texture to Other Tools: the Eraser and the Pencil get this texture, the Brush keeps its own
  await page.locator('.brush-settings-panel [data-act="menu"]').click();
  await page.locator('.popover').getByText('Copy Texture to Other Tools', { exact: true }).click();
  for (const tool of ['eraser', 'pencil']) {
    const t = await brushOf(page, tool);
    expect([t.texture.enabled, t.texture.pattern?.presetId, t.texture.scale], tool).toEqual([true, 'checkerboard', 0.5]);
  }
  expect(errors).toEqual([]);
});

test('Dual Brush, Noise, Wet Edges and Brush Pose change what a stroke paints, one entry each; Grayscale stays grey; 16-bit keeps its entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 420, height: 400, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      const opts = { opacity: 1, flow: 1, smoothing: 0, pressureSize: true };
      const base = { tip: { size: 40, hardness: 1, spacing: 0.1 } };
      const cases = {
        plain: base,
        dual: { ...base, dualBrush: { enabled: true, mode: 'multiply', tip: { size: 6, hardness: 1, spacing: 0.5 }, scatter: 1, count: 2 } },
        noise: { tip: { size: 40, hardness: 0, spacing: 0.1 }, noise: true },
        soft: { tip: { size: 40, hardness: 0, spacing: 0.1 } },
        wet: { ...base, wetEdges: true },
        pose: { ...base, brushPose: { enabled: true, pressure: 0.3 } },
      };
      const out = {};
      let y = 30;
      for (const [name, preset] of Object.entries(cases)) {
        const labels = window.__paint('brush', preset, window.__line(40, 380, y), opts);
        const row = window.__row(y, 120, 280);
        const col = [];
        const layer = app.doc.active;
        const d = layer.canvas.getContext('2d').getImageData(200 - layer.x, y - 25 - layer.y, 1, 50).data;
        for (let i = 3; i < d.length; i += 4) col.push(d[i]);
        out[name] = { labels, sum: row.reduce((s, a) => s + a, 0), centre: row[80], width: col.filter((a) => a > 0).length, edge: Math.max(...col) };
        y += 60;
      }
      return out;
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  for (const k of Object.keys(r)) expect(r[k].labels, k).toHaveLength(1);
  // the dual tip leaves gaps in a hard stroke
  expect(r.dual.sum).toBeLessThan(r.plain.sum * 0.9);
  expect(r.dual.sum).toBeGreaterThan(0);
  // noise changes the soft stroke's edges
  expect(r.noise.sum).not.toBe(r.soft.sum);
  // wet edges: a lighter inside, the edges at full alpha
  expect(r.wet.centre).toBeLessThan(170);
  expect(r.wet.edge).toBe(255);
  expect(r.plain.centre).toBe(255);
  // the pose's pressure narrows the stroke through Pressure for Size
  expect(r.pose.width).toBeLessThan(r.plain.width * 0.6);
  // Grayscale: a textured, hue-jittered stroke stays grey
  await newDoc(page, { width: 420, height: 120, background: 'white' });
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await kit(page);
  const grey = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      app.setColors({ foreground: '#808080', background: '#000000' });
      await app.patterns.get('checkerboard');
      const labels = window.__paint('brush', { tip: { size: 30, hardness: 1 }, texture: { enabled: true, pattern: { presetId: 'checkerboard', name: 'C' } }, colorDynamics: { enabled: true, hueJitter: 1, saturationJitter: 1, fbJitter: 0.5 }, wetEdges: true }, window.__line(40, 380, 60), { opacity: 1, flow: 1, smoothing: 0 });
      const l = app.doc.active;
      const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
      let coloured = 0, painted = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== 255) painted++;
        if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) coloured++;
      }
      return { labels, coloured, painted };
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  expect(grey.labels).toHaveLength(1);
  expect(grey.painted).toBeGreaterThan(1000);
  expect(grey.coloured).toBe(0);
  // 16-bit: the stroke paints the 8-bit proxy and the deep pixels follow it (0.3)
  await newDoc(page, { width: 200, height: 120, background: 'white', depth: 16 });
  await kit(page);
  const deep = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000' });
    const labels = window.__paint('brush', { tip: { size: 30, hardness: 1 }, wetEdges: true, noise: true, dualBrush: { enabled: true, tip: { size: 8 } } }, window.__line(20, 180, 60), { opacity: 1, flow: 1, smoothing: 0 });
    const l = app.doc.active;
    app.deep.sync(app.doc);
    const img = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    const d = l.deep.data;
    let mismatches = 0, painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (img[i + 1] < 250) painted++;
      if (img[i + 3] === 255 && Math.floor((d[i + 1] + 128) / 257) !== img[i + 1]) mismatches++;
    }
    return { labels, type: l.deep.type, mismatches, painted };
  });
  expect(deep.type).toBe('u16');
  expect(deep.labels).toHaveLength(1);
  expect(deep.painted).toBeGreaterThan(100);
  expect(deep.mismatches).toBe(0);
  expect(errors).toEqual([]);
});

test('Brushes panel: groups, search, the recent row, New Brush Preset with tool and colour capture, reorder, delete keeps the tip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      app.tools.activate('brush');
      await app.presets.ready('brushes');
      app.panels.setCollapsed('middle', true);
      app.panels.setCollapsed('bottom', true);
      app.panels.show('brushes', { reveal: true });
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  const panel = page.locator('.brush-panel');
  await expect(panel.locator('.brush-group-head', { hasText: 'General Brushes' })).toBeVisible();
  await expect(panel.locator('.brush-group-head', { hasText: 'Pigment Media Brushes' })).toBeVisible();
  // search
  await panel.locator('.brush-search').fill('soft round');
  await expect(panel.locator('.brush-list .brush-item')).toHaveCount(5);
  await panel.locator('.brush-search').fill('');
  // picks fill the recent row, latest first
  await panel.locator('.brush-list .brush-item[data-id="hard-9"]').click();
  await panel.locator('.brush-list .brush-item[data-id="media-charcoal"]').click();
  await expect(panel.locator('.brush-recent .brush-item')).toHaveCount(2);
  expect(await panel.locator('.brush-recent .brush-item').evaluateAll((els) => els.map((e) => e.dataset.id))).toEqual(['media-charcoal', 'hard-9']);
  expect((await brushOf(page)).dualBrush.enabled).toBe(true);
  // New Brush Preset with the tool's settings and the colour
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.setOpt('brush', 'opacity', 0.4);
    app.tools.setOpt('brush', 'blend', 'multiply');
    app.setColors({ foreground: '#336699' });
  });
  await panel.locator('[data-act="save"]').click();
  const dialog = page.locator('.dialog');
  await dialog.locator('[data-k="name"]').fill('My Charcoal');
  await dialog.locator('[data-k="tool"]').check();
  await dialog.locator('[data-k="color"]').check();
  await dialog.locator('button.primary').click();
  const made = await page.evaluate(() => {
    const app = window.pigmentApp;
    const p = app.presets.list('brushes').find((x) => x.name === 'My Charcoal');
    return p && { id: p.id, tool: p.data.tool, dual: p.data.dualBrush.enabled, picked: app.settings.tools.brush.brushPresetId };
  });
  expect(made.tool).toMatchObject({ opacity: 0.4, blend: 'multiply', color: '#336699' });
  expect(made.dual).toBe(true);
  expect(made.picked).toBe(made.id);
  await expect(panel.locator(`.brush-item[data-id="${made.id}"]`)).toHaveClass(/active/);
  // picking it again brings the tool settings and the colour back
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.setOpt('brush', 'opacity', 1);
    app.setColors({ foreground: '#000000' });
  });
  await runAwait(page, 'tool:brush-preset', made.id);
  expect(await page.evaluate(() => [window.pigmentApp.tools.opt('brush', 'opacity'), window.pigmentApp.settings.foreground])).toEqual([0.4, '#336699']);
  // reorder: drop hard-45 onto hard-3 (the first of General Brushes)
  const order = await page.evaluate(() => {
    const list = document.querySelector('.brush-panel .brush-list');
    const from = list.querySelector('.brush-item[data-id="hard-45"]');
    const to = list.querySelector('.brush-item[data-id="hard-3"]');
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return null;
  });
  void order;
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('brushes', { group: 'general' }).map((p) => p.id).slice(0, 2))).toEqual(['hard-45', 'hard-3']);
  // a sampled preset deleted: its tip blob stays (a tool or tool preset may still name it)
  const blob = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      const { brushFromAgPsd } = await import('/lib/brush/abr.js');
      const alpha = new Uint8Array(64).fill(255);
      const res = brushFromAgPsd({ name: 'Square', shape: { type: 'sampled', size: 8, sampledData: 's' } }, new Map([['s', { width: 8, height: 8, alpha }]]));
      const [[name, bytes]] = Object.entries(res.blobs);
      await app.presets.writeBlob('brushes', name, bytes);
      const p = app.presets.add('brushes', { name: 'Square', data: res.preset });
      return { id: p.id, name };
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  await panel.locator(`.brush-item[data-id="${blob.id}"]`).click({ button: 'right' });
  await page.locator('.popover').getByText('Delete Brush', { exact: true }).click();
  await page.locator('.dialog button.danger, .dialog button.primary').first().click();
  await expect.poll(() => page.evaluate((id) => !!window.pigmentApp.presets.get('brushes', id), blob.id)).toBe(false);
  expect(await page.evaluate(async (n) => {
    try {
      return (await window.pigmentApp.presets.readBlob('brushes', n))?.length ?? 0;
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  }, blob.name)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the options bar\'s picker: size, a pick recorded by tool:brush-preset with its data and its sampled tip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  const id = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      app.tools.activate('brush');
      await app.presets.ready('brushes');
      const { brushFromAgPsd } = await import('/lib/brush/abr.js');
      const alpha = Uint8Array.from({ length: 100 }, (_, i) => (i % 3 ? 255 : 0));
      const res = brushFromAgPsd({ name: 'Bristles', shape: { type: 'sampled', size: 30, sampledData: 's' } }, new Map([['s', { width: 10, height: 10, alpha }]]));
      for (const [n, b] of Object.entries(res.blobs)) await app.presets.writeBlob('brushes', n, b);
      window.__done = [];
      app.on('command:done', (ev) => {
        if (ev.id === 'tool:brush-preset') window.__done.push(ev.arg);
      });
      return app.presets.add('brushes', { name: 'Bristles', data: res.preset }).id;
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  await page.locator('#options-bar button.opt-brush').click();
  const pop = page.locator('.popover-brush');
  await expect(pop).toBeVisible();
  await pop.locator(`.brush-item[data-id="${id}"]`).click();
  await expect(page.locator('#options-bar button.opt-brush')).toContainText('30 px');
  await expect.poll(() => page.evaluate(() => window.__done.length)).toBe(1);
  const arg = await page.evaluate(() => window.__done[0]);
  expect(arg.id).toBe(id);
  expect(arg.preset.tip.kind).toBe('sampled');
  expect(arg.preset.tip.sample.dataUrl).toMatch(/^data:image\/png;base64,/);
  // the popover's size slider writes the tool's size
  const num = pop.locator('.bs-slider[data-key="size"] input.num');
  await num.fill('64');
  await num.press('Enter');
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('brush', 'size'))).toBe(64);
  await expect(page.locator('#options-bar button.opt-brush')).toContainText('64 px');
  expect(errors).toEqual([]);
});

test('.abr: opening a file imports its brushes into a group with their sampled tips and pattern; export reads back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 160, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      const abr = await import('/lib/brush/abr.js');
      const { normalizeBrush } = await import('/lib/brush/preset.js');
      const { exportPresetBytes } = await import('/lib/preset-formats.js');
      await Promise.all(['brushes', 'patterns'].map((k) => app.presets.ready(k)));
      // a square sampled tip with a hole, and a 4 x 4 pattern, built here
      const alpha = new Uint8Array(16 * 16).fill(255);
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) alpha[y * 16 + x] = 0;
      const tip = abr.brushFromAgPsd({ name: 't', shape: { type: 'sampled', size: 16, sampledData: 's' } }, new Map([['s', { width: 16, height: 16, alpha }]]));
      const blobs = tip.blobs;
      const textured = normalizeBrush({ tip: { ...tip.preset.tip, size: 24, spacing: 0.2 }, texture: { enabled: true, pattern: { presetId: 'p1', name: 'Tiny' }, depth: 0.5 } });
      const round = normalizeBrush({ tip: { size: 12, hardness: 0.5 } });
      const pattern = { name: 'Tiny', width: 4, height: 4, data: Uint8ClampedArray.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 : (i >> 2) % 2 ? 40 : 220)) };
      const { bytes } = await abr.writeAbrFile([{ name: 'Holey Square', data: textured }, { name: 'Round 12', data: round }], { readBlob: async (k, n) => blobs[n] ?? null, patternPixels: async () => pattern });
      const before = { brushes: app.presets.list('brushes').length, patterns: app.presets.list('patterns').length };
      window.__pigmentTest.files['mem:/My Set.abr'] = bytes;
      const docs = app.docs.list().length;
      await app.commands.run('file:open-paths', ['mem:/My Set.abr'], 'api');
      const group = app.presets.groups('brushes').find((g) => g.name === 'My Set');
      const members = group ? app.presets.list('brushes', { group: group.id }) : [];
      const pat = app.presets.list('patterns').find((p) => p.name === 'Tiny');
      const holey = members.find((p) => p.name === 'Holey Square');
      const tipBlob = holey ? await app.presets.readBlob('brushes', holey.data.tip.sample.blob) : null;
      // paint one dab with the imported tip: its hole stays empty
      await app.commands.run('tool:brush-preset', holey.id, 'api');
      const { prepareBrush } = await import('/lib/brush/tool-brush.js');
      await prepareBrush(app, holey.data);
      window.__paint('brush', null, [{ x: 100, y: 80 }], { opacity: 1, flow: 1, smoothing: 0, pressureSize: false });
      const layer = app.doc.active;
      const a = (x, y) => layer.canvas.getContext('2d').getImageData(x - layer.x, y - layer.y, 1, 1).data[3];
      // export the group's brushes as .abr and read them back
      const out = await exportPresetBytes(app, 'brushes', members.map((p) => p.id), 'abr');
      const back = await abr.readAbrFile(out.bytes, { name: 'back.abr' });
      return {
        added: { brushes: app.presets.list('brushes').length - before.brushes, patterns: app.presets.list('patterns').length - before.patterns },
        docs: app.docs.list().length - docs,
        names: members.map((p) => p.name),
        ref: holey?.data.texture.pattern, patId: pat?.id, tipBlob: tipBlob?.length ?? 0,
        dab: { hole: a(100, 80), body: a(92, 72) },
        back: back.items.map((it) => `${it.kind}:${it.name}`),
        backReport: back.report,
        ext: out.ext,
      };
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  expect(r.added).toEqual({ brushes: 2, patterns: 1 });
  expect(r.docs).toBe(0);
  expect(r.names).toEqual(['Holey Square', 'Round 12']);
  expect(r.ref).toEqual({ presetId: r.patId, name: 'Tiny' });
  expect(r.tipBlob).toBeGreaterThan(0);
  expect(r.dab.hole).toBe(0);
  expect(r.dab.body).toBeGreaterThan(0);
  expect(r.ext).toBe('abr');
  expect(r.back).toEqual(['patterns:Tiny', 'brushes:Holey Square', 'brushes:Round 12']);
  expect(r.backReport).toEqual([]);
  expect(errors).toEqual([]);
});

test('a preset-store write failure is reported once; the Brushes panel keeps its new group for the session', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(async () => {
    try {
      const app = window.pigmentApp;
      await app.presets.ready('brushes');
      app.presets.backend = { ...app.presets.backend, write: () => Promise.reject(Object.assign(new Error('disk full'), { code: 'storage-quota' })) };
      window.__failed = [];
      app.on('settings:write-failed', (d) => window.__failed.push(d));
      app.panels.setCollapsed('middle', true);
      app.panels.setCollapsed('bottom', true);
      app.panels.show('brushes', { reveal: true });
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  await page.locator('.brush-panel [data-act="group"]').click();
  await page.locator('.dialog input').fill('Kept');
  await page.locator('.dialog button.primary').click();
  await expect(page.locator('.brush-panel .brush-group-head', { hasText: 'Kept' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__failed.filter((f) => f.area === 'presets').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__toasts.filter((t) => /Presets could not be saved/.test(t)).length)).toBe(1);
  // the warning goes to the console, not as an error
  expect(errors).toEqual([]);
});
