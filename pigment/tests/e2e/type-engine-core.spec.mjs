// type-engine-core (ARCHITECTURE.md "0.4 features", package 1): the HarfBuzz engine in the browser build. The OFL test
// font (tests/fixtures/fonts/Carlito-Regular.ttf, served at /fixtures/fonts/) is added through
// window.__pigmentTest.addFont under a family name no system has, so every pixel of it comes from HarfBuzz and the
// engine's outlines, never from the browser's own copy of the font.
import { test, expect } from '@playwright/test';
import { openApp, newDoc } from './helpers.mjs';

const FAMILY = 'Pigment Test Carlito';

/** Loads the test font into the page under FAMILY; resolves to the faces added. */
const addTestFont = (page) => page.evaluate(async (family) => {
  const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/Carlito-Regular.ttf')).arrayBuffer());
  return window.__pigmentTest.addFont(bytes, { family });
}, FAMILY);

/** Coloured pixel counts of the document composite inside a rect: { red, blue, black }. */
const colours = (page, rect = null) => page.evaluate((r) => {
  const d = window.pigmentApp.doc;
  const c = d.view.compositor.composite(d);
  const x0 = r?.x ?? 0, y0 = r?.y ?? 0, w = r?.width ?? c.width, h = r?.height ?? c.height;
  const data = c.getContext('2d').getImageData(x0, y0, w, h).data;
  let red = 0, blue = 0, black = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
    if (R > 180 && G < 90 && B < 90) red++;
    else if (B > 180 && R < 90 && G < 90) blue++;
    else if (R < 90 && G < 90 && B < 90) black++;
  }
  return { red, blue, black };
}, rect);

test('a layer with two runs of different size and colour renders both with HarfBuzz and round-trips .pigment', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 160 });
  const faces = await addTestFont(page);
  expect(faces[0]).toMatchObject({ family: FAMILY, postScriptName: 'Carlito-Regular', weight: 400, italic: false });
  const r = await page.evaluate(async (family) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const api = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    let content = M.fromPlain('Small Big', { fontFamily: family, size: 24, color: '#ff0000' });
    content = M.applyChar(content, 6, 9, { size: 60, color: '#0000ff' });
    const layer = new TextLayer({ content, x: 10, y: 20 });
    structural(app, 'Add', () => app.doc.add(layer));
    const lay = layer.layout();
    const back = await readPigment(await writePigment(app.doc));
    const t = back.layers().find((l) => l.type === 'text');
    return {
      engine: lay.engine,
      current: api.currentEngine(layer).id,
      runs: lay.lines[0].runs.map((run) => ({ from: run.from, to: run.to, size: run.style.size, color: run.style.color, glyphs: run.units.reduce((n, u) => n + u.glyphs.length, 0) })),
      ascent: lay.ascent,
      baseline: lay.lines[0].baseline,
      same: JSON.stringify(t.content) === JSON.stringify(layer.content),
      backEngine: t.layout().engine,
      backWidth: t.layout().width,
      width: lay.width,
      bigX: lay.lines[0].runs[1].x,
    };
  }, FAMILY);
  expect(r.engine).toBe('harfbuzz');
  expect(r.current).toBe('harfbuzz');
  expect(r.runs).toHaveLength(2);
  expect(r.runs[0]).toMatchObject({ from: 0, to: 6, size: 24, color: '#ff0000' });
  expect(r.runs[1]).toMatchObject({ from: 6, to: 9, size: 60, color: '#0000ff', glyphs: 3 });
  // the first baseline rule (A): 0.8 x the largest size on the first line
  expect(r.ascent).toBeCloseTo(48, 6);
  expect(r.baseline).toBeCloseTo(20 + 48, 6);
  expect(r.same).toBe(true);
  expect(r.backEngine).toBe('harfbuzz');
  expect(r.backWidth).toBe(r.width);
  const c = await colours(page);
  expect(c.red).toBeGreaterThan(80);
  expect(c.blue).toBeGreaterThan(400);
  // the small red run sits left of the big blue one
  const left = await colours(page, { x: 0, y: 0, width: Math.floor(r.bigX) - 2, height: 160 });
  expect(left.red).toBeGreaterThan(80);
  expect(left.blue).toBe(0);
  expect(errors).toEqual([]);
});

test('a text box with a height overflows, reports it and draws only the lines that fit', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 300 });
  await addTestFont(page);
  const r = await page.evaluate(async (family) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const content = M.fromPlain('one two three four five six seven eight nine ten', { fontFamily: family, size: 20, color: '#000000' });
    const layer = new TextLayer({ content, x: 10, y: 10, width: 120, height: 50 });
    structural(app, 'Add', () => app.doc.add(layer));
    const lay = layer.layout();
    const free = new TextLayer({ content, x: 10, y: 10, width: 120 });
    const grown = free.layout();
    return {
      engine: lay.engine,
      overflow: lay.overflow,
      height: lay.height,
      contentHeight: lay.contentHeight,
      frame: lay.frame,
      visible: lay.lines.map((l) => l.visible),
      lines: lay.lines.length,
      grownOverflow: grown.overflow,
      grownHeight: grown.height,
      widths: lay.lines.map((l) => l.width),
    };
  }, FAMILY);
  expect(r.engine).toBe('harfbuzz');
  expect(r.frame).toEqual({ width: 120, height: 50 });
  expect(r.height).toBe(50);
  expect(r.lines).toBeGreaterThan(3);
  expect(r.contentHeight).toBeCloseTo(r.lines * 24, 6);
  expect(r.overflow).toBe(true);
  // 24 px lines: two fit in 50 px
  expect(r.visible.slice(0, 3)).toEqual([true, true, false]);
  for (const w of r.widths) expect(w).toBeLessThanOrEqual(120);
  expect(r.grownOverflow).toBe(false);
  expect(r.grownHeight).toBe(Math.ceil(r.contentHeight));
  // nothing is drawn below the box (60 px from the top, plus the descenders of the second line)
  const below = await colours(page, { x: 0, y: 75, width: 300, height: 225 });
  expect(below.black).toBe(0);
  const inside = await colours(page, { x: 0, y: 0, width: 300, height: 70 });
  expect(inside.black).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('tracking keeps "fi" one ligature glyph and spaces the clusters; an emoji ZWJ sequence stays one cluster', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 120 });
  await addTestFont(page);
  const r = await page.evaluate(async (family) => {
    const { TextLayer } = await import('/lib/document.js');
    const api = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    const runOf = (text, char) => {
      const layer = new TextLayer({ content: M.fromPlain(text, { fontFamily: family, size: 40, ...char }), x: 0, y: 0 });
      return { layer, run: api.glyphRuns(layer)[0] };
    };
    const plain = runOf('fifi', {});
    const tracked = runOf('fifi', { tracking: 500 });
    const emoji = runOf('a\u{1F469}\u200D\u{1F469}\u200D\u{1F467}b', {});
    const caretAfterEmoji = api.caretRect(emoji.layer, 9).x - api.caretRect(emoji.layer, 1).x;
    return {
      plainUnits: plain.run.units.map((u) => [u.index, u.end, u.glyphs.length]),
      trackedUnits: tracked.run.units.map((u) => [u.index, u.end, u.glyphs.length]),
      sameGlyphs: JSON.stringify(plain.run.units.map((u) => u.glyphs.map((g) => g.id))) === JSON.stringify(tracked.run.units.map((u) => u.glyphs.map((g) => g.id))),
      plainWidth: plain.layer.layout().width,
      trackedAdvance: tracked.run.advance,
      plainAdvance: plain.run.advance,
      clusters: tracked.run.clusters.map((c) => c.index),
      emojiClusters: emoji.run.clusters.map((c) => c.index),
      emojiUnits: emoji.run.units.map((u) => [u.index, u.end, u.kind]),
      caretAfterEmoji,
    };
  }, FAMILY);
  // "fi" is one glyph (Carlito's ligature) with and without tracking
  expect(r.plainUnits).toEqual([[0, 2, 1], [2, 4, 1]]);
  expect(r.trackedUnits).toEqual([[0, 2, 1], [2, 4, 1]]);
  expect(r.sameGlyphs).toBe(true);
  // 500/1000 em at 40 px is 20 px after the first ligature, none after the last cluster of the line
  expect(r.trackedAdvance - r.plainAdvance).toBeCloseTo(20, 6);
  // carets still stop between f and i (grapheme clusters)
  expect(r.clusters).toEqual([0, 1, 2, 3]);
  expect(r.emojiClusters).toEqual([0, 1, 9]);
  expect(r.emojiUnits.map((u) => u.slice(0, 2))).toEqual([[0, 1], [1, 9], [9, 10]]);
  expect(r.emojiUnits[1][2]).toBe('fallback');
  expect(r.caretAfterEmoji).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('text on a path follows the path with HarfBuzz glyphs: ligatures stay whole, every glyph sits on the circle', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addTestFont(page);
  const r = await page.evaluate(async (family) => {
    const app = window.pigmentApp;
    const { TextLayer, ShapeLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const doc = app.doc;
    const shape = new ShapeLayer({ name: 'Circle', path: ellipsePath(100, 50, 200, 200), fill: { type: 'solid', color: '#ffffff' } });
    const layer = new TextLayer({ name: 'Txt', content: M.fromPlain('fine office AVA', { fontFamily: family, size: 24, color: '#ff0000' }), x: 20, y: 20 });
    structural(app, 'Add', () => {
      doc.add(shape);
      doc.setActive(shape);
      doc.add(layer);
      doc.setActive(layer);
    });
    await app.commands.run('text:on-path', undefined, 'api');
    const lay = layer.layout();
    return {
      onPath: !!layer.pathText,
      chars: lay.glyphs.filter((g) => !g.hidden).map((g) => g.ch),
      radii: lay.glyphs.filter((g) => !g.hidden).map((g) => Math.hypot(g.x - 200, g.y - 150)),
      angles: new Set(lay.glyphs.filter((g) => !g.hidden).map((g) => Math.round(g.angle * 10))).size,
    };
  }, FAMILY);
  expect(r.onPath).toBe(true);
  expect(r.chars).toContain('fi');
  expect(r.chars).toContain('ffi');
  for (const d of r.radii) expect(Math.abs(d - 100)).toBeLessThan(0.75);
  expect(r.angles).toBeGreaterThan(8);
  // the red glyphs are drawn round the circle (mean distance near the radius plus half the glyph height)
  const stats = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100)) continue;
      const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
      n++;
      sum += Math.hypot(x - 200, y - 150);
    }
    return { n, mean: n ? sum / n : 0 };
  });
  expect(stats.n).toBeGreaterThan(150);
  expect(stats.mean).toBeGreaterThan(95);
  expect(stats.mean).toBeLessThan(120);
  expect(errors).toEqual([]);
});

test('a layer drawn before its font arrived is drawn by the stub, then redrawn by HarfBuzz when the font arrives', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 120 });
  const before = await page.evaluate(async (family) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain('Waiting for the font', { fontFamily: family, size: 30, color: '#000000' }), x: 10, y: 20 });
    structural(app, 'Add', () => app.doc.add(layer));
    window.__waitLayer = layer;
    return { engine: layer.layout().engine, version: layer.version, width: layer.layout().width, history: app.doc.history.index, dirty: app.doc.dirty };
  }, FAMILY);
  expect(before.engine).toBe('canvas');
  await addTestFont(page);
  const after = await page.evaluate(() => {
    const layer = window.__waitLayer;
    const app = window.pigmentApp;
    return { engine: layer.layout().engine, version: layer.version, width: layer.layout().width, history: app.doc.history.index, dirty: app.doc.dirty, rendered: layer.render().version === layer.version };
  });
  expect(after.engine).toBe('harfbuzz');
  expect(after.version).toBeGreaterThan(before.version);
  // the face is not the browser's fallback font: the measured width changes
  expect(Math.abs(after.width - before.width)).toBeGreaterThan(1);
  // no history entry, the dirty flag unchanged (B.4)
  expect(after.history).toBe(before.history);
  expect(after.dirty).toBe(before.dirty);
  expect(after.rendered).toBe(true);
  expect(errors).toEqual([]);
});

test('the font provider answers from the face: metrics, features, outlines and advances', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  await addTestFont(page);
  const r = await page.evaluate(async (family) => {
    const api = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    const st = M.resolveChar({ fontFamily: family, size: 100 });
    const m = api.fonts.metrics(st);
    const o = api.fonts.outline(st, 'o');
    return {
      available: api.fonts.available,
      m,
      liga: api.fonts.hasFeature(st, 'liga'),
      foo: api.fonts.hasFeature(st, 'zzzz'),
      subpaths: o?.subpaths.length,
      closed: o?.subpaths.every((s) => s.closed),
      advances: api.fonts.advances(st, 'fi a'),
      engines: api.engines(),
    };
  }, FAMILY);
  expect(r.available).toBe(true);
  expect(r.engines).toEqual(['canvas', 'harfbuzz']);
  expect(r.m.capHeight).toBeGreaterThan(55);
  expect(r.m.capHeight).toBeLessThan(75);
  expect(r.m.underlinePosition).toBeGreaterThan(0);
  expect(r.m.strikePosition).toBeLessThan(0);
  expect(r.liga).toBe(true);
  expect(r.foo).toBe(false);
  expect(r.subpaths).toBe(2); // the outside and the counter of an 'o'
  expect(r.closed).toBe(true);
  expect(r.advances).toHaveLength(4);
  expect(r.advances[1]).toBe(0); // the 'i' of the ligature
  expect(r.advances[0]).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});
