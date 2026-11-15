// Records the 0.5 goldens on the 0.4.0 tree (CONTRACT-05 Part 2, step 0). Runs only with PIGMENT_RECORD=1:
//   PIGMENT_RECORD=1 PIGMENT_E2E_PORT=8850 npx playwright test -c tests/e2e/playwright.config.mjs record-goldens
// It writes
//   tests/fixtures/brush-golden/cases.json  the stroke cases (settings, samples, bases, dirty box) and the settings
//                                           0.4's painting tools return from strokeSettings for fixed options
//   tests/fixtures/brush-golden/<id>.png    the target canvas after each stroke: straight RGBA from getImageData,
//                                           encoded with src/shared/pixels/png.js (decode with decodePng + toRgba8,
//                                           never through a canvas, which premultiplies and rounds low alphas)
//   tests/fixtures/brush-golden/dabs.json   every BrushStroke.prototype.dab call of each case (wrapped here only)
//   tests/fixtures/psd-golden/<id>.json     readPsd (no image data) of writePsdDocument for six documents
// The goldens pin what 0.4's brush engine and PSD writer did, so that 0.5's engine facade, presets and PSD registries
// can be checked against them: recording them again after the skeleton has landed would make those checks
// meaningless. The cases and the page code live in goldens.mjs, which the checking specs share.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './helpers.mjs';
import { W, H, CASES, TOOL_OPTIONS, TOOL_SETTINGS, TOOL_CONTEXT, PSD_GOLDEN_DOCS, pageStrokeCases, pageToolSettings, pagePsdGolden } from './goldens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRUSH_DIR = join(ROOT, 'tests', 'fixtures', 'brush-golden');
const PSD_DIR = join(ROOT, 'tests', 'fixtures', 'psd-golden');

test.skip(!process.env.PIGMENT_RECORD, 'records the 0.4 goldens only with PIGMENT_RECORD=1');

test('record the brush goldens from 0.4\'s BrushStroke and painting tools', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(([w, h]) => window.pigmentApp.newDocument({ width: w, height: h, name: 'Goldens', background: 'transparent' }), [W, H]);
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  const results = await page.evaluate(pageStrokeCases, { cases: CASES, W, H, log: true, png: true });
  // twice: a case whose pixels or dabs differ between two runs would make a useless golden
  const again = await page.evaluate(pageStrokeCases, { cases: CASES, W, H, log: true });
  const tools = await page.evaluate(pageToolSettings, { toolOptions: TOOL_OPTIONS, toolSettings: TOOL_SETTINGS, context: TOOL_CONTEXT, W, H });
  expect(errors).toEqual([]);
  expect(results).toHaveLength(CASES.length);
  for (const [i, r] of results.entries()) {
    expect(r.dabs.length, r.id).toBeGreaterThan(0);
    expect(again[i].rgba, r.id).toBe(r.rgba);
    expect(again[i].dabs, r.id).toEqual(r.dabs);
  }

  mkdirSync(BRUSH_DIR, { recursive: true });
  const cases = CASES.map((c) => {
    const r = results.find((x) => x.id === c.id);
    writeFileSync(join(BRUSH_DIR, `${c.id}.png`), Buffer.from(r.png, 'base64'));
    return { ...c, png: `${c.id}.png`, dirty: r.dirty, dabCount: r.dabs.length };
  });
  const out = {
    recordedFrom: 'Pigment 0.4.0 (commit 99dbdee) by tests/e2e/record-goldens.spec.mjs; cases and page code in tests/e2e/goldens.mjs',
    canvas: { width: W, height: H },
    bases: {
      empty: 'transparent',
      pattern: 'rows 0..79 opaque, 90..99 alpha 128, else transparent; r = round(x * 255 / (W - 1)), g = 128 + round(60 * sin(y / 9)), b = 255 - r',
      mask: 'the layer mask canvas filled #ffffff opaque (reveal all); the stroke targets it with mask: true',
    },
    drive: 'new BrushStroke({ target, layer, settings, selection, history: doc.history }); begin(samples[0]); extend(each later sample); then 0.4\'s StrokeTool.onPointerUp finish: s.smoothing = 0, extend(the last sample), smoothing restored; end()',
    sampler: { clone: 'a snapshot of the target canvas before the stroke; sampler = (tctx, lx, ly, w, h) => tctx.drawImage(snapshot, Math.round(lx + offset.x), Math.round(ly + offset.y), w, h, 0, 0, w, h)' },
    selection: { ellipse: 'Selection.fromEllipse(W, H, rect) (antialiased), passed as the stroke\'s selection' },
    png: 'straight RGBA of the target\'s getImageData after end(), encoded by shared/pixels/png.js encodeRgba8; decode with decodePng + toRgba8',
    dabs: 'dabs.json: { [case id]: [{ x, y, pressure, size: effectiveSize(pressure), flow }] } in call order, stroke-canvas px',
    cases,
    toolSettings: {
      what: 'tool.strokeSettings(point, layer, tool.strokeTarget(layer)) on a raster layer (no mask, not locked) after app.tools.setOpt of `options`, with the Brushes panel\'s 0.4 angle/roundness hook installed; functions as "[function]", objects as "[object]"',
      ...TOOL_CONTEXT,
      tools,
    },
  };
  writeFileSync(join(BRUSH_DIR, 'cases.json'), `${JSON.stringify(out, null, 1)}\n`);
  writeFileSync(join(BRUSH_DIR, 'dabs.json'), `${JSON.stringify(Object.fromEntries(results.map((r) => [r.id, r.dabs])))}\n`);
});

test('record the PSD goldens from 0.4\'s writePsdDocument', async ({ page }) => {
  const errors = await openApp(page);
  mkdirSync(PSD_DIR, { recursive: true });
  for (const id of PSD_GOLDEN_DOCS) {
    const json = await page.evaluate(pagePsdGolden, id);
    expect(await page.evaluate(pagePsdGolden, id), id).toBe(json);
    writeFileSync(join(PSD_DIR, `${id}.json`), `${json}\n`);
  }
  expect(errors).toEqual([]);
});
