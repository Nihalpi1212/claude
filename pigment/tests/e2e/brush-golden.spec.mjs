// The brush goldens (ARCHITECTURE.md "0.5 features", S2.3, rule 11; skeleton step 4, port 8850). Every stroke case
// recorded from 0.4's BrushStroke (tests/fixtures/brush-golden, record-goldens.spec.mjs) is painted again in three
// forms: 0.4's legacy flat settings, the preset form (a BrushPreset with every section off plus the paint keys), and
// through the 0.5 tools (their options set, then tool.strokeSettings, as a stroke on the canvas gets them). While the
// classic engine is in place (ENGINE.id === 'classic-0.4') every form paints the recorded pixels exactly; after
// brush-engine-core lands, each case stays within S2.3's tolerance (largest channel difference 3, mean absolute
// difference over the stroke's box 0.35) and the aliased cases (Pencil, Eraser Pencil and Block) stay equal.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './helpers.mjs';
import { W, H, CASES, TOOL_OPTIONS, TOOL_SETTINGS, TOOL_CONTEXT, pageStrokeCases, pageToolSettings } from './goldens.mjs';
import { decodePng, toRgba8 } from '../../src/shared/pixels/png.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brush-golden');
const RECORDED = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));

async function golden(id) {
  return toRgba8(await decodePng(new Uint8Array(readFileSync(join(DIR, `${id}.png`))))).data;
}

/** { max, mean } of the per-channel differences inside the recorded stroke's box (clipped to the canvas). */
function compare(a, b, dirty) {
  let max = 0, sum = 0, n = 0;
  const x0 = Math.max(0, dirty.x), y0 = Math.max(0, dirty.y), x1 = Math.min(W, dirty.x + dirty.width), y1 = Math.min(H, dirty.y + dirty.height);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      if (d > max) max = d;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        sum += d;
        n++;
      }
    }
  }
  return { max, mean: n ? sum / n : 0 };
}

async function setup(page) {
  const errors = await openApp(page);
  await page.evaluate(([w, h]) => window.pigmentApp.newDocument({ width: w, height: h, name: 'Goldens', background: 'transparent' }), [W, H]);
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  return errors;
}

/** Installs window.__goldenStroke for a form: 'legacy' | 'preset' | 'tools'. */
async function useForm(page, form) {
  await page.evaluate(async (form) => {
    const app = window.pigmentApp;
    const { BrushStroke } = await import('/lib/brush.js');
    const { brushFromLegacy, normalizeBrush } = await import('/lib/brush/preset.js');
    const TIP = ['size', 'hardness', 'spacing', 'angle', 'roundness'];
    // the 0.5 tool a case paints with, and the options that give its settings
    const toolFor = (c) => {
      const s = c.settings;
      if (c.id === 'pencil') return { tool: 'pencil', options: { size: s.size, opacity: s.opacity, blend: s.blend, autoErase: false, spacing: s.spacing } };
      if (c.id === 'soft-eraser') return { tool: 'eraser', options: { size: s.size, hardness: s.hardness, opacity: s.opacity, flow: s.flow, smoothing: s.smoothing, pressureSize: s.pressureSize, spacing: s.spacing, angle: s.angle, roundness: s.roundness, mode: 'brush', eraseToHistory: false } };
      const options = { size: s.size, hardness: s.hardness, opacity: s.opacity, flow: s.flow, smoothing: s.smoothing, spacing: s.spacing, pressureSize: s.pressureSize, pressureOpacity: s.pressureOpacity, blend: s.blend, angle: s.angle, roundness: s.roundness, lockAlpha: s.lockTransparency };
      if (c.sampler?.kind === 'clone') return { tool: 'clone', options: { ...options, aligned: true, sampleAll: false }, clone: c.sampler.offset };
      return { tool: 'brush', options };
    };
    window.__goldenStroke = async (c, { target, layer, selection, history }) => {
      let settings;
      if (form === 'legacy') settings = { ...c.settings };
      else if (form === 'preset') {
        const paint = Object.fromEntries(Object.entries(c.settings).filter(([k]) => !TIP.includes(k)));
        settings = { ...paint, preset: normalizeBrush({ ...brushFromLegacy(Object.fromEntries(TIP.map((k) => [k, c.settings[k]]))), tool: null }) };
      } else {
        const t = toolFor(c);
        const tool = app.tools.get(t.tool);
        for (const [k, v] of Object.entries(t.options)) app.tools.setOpt(t.tool, k, v, { silent: true });
        app.setColors({ foreground: c.settings.color });
        app.ui.editingMask = c.target === 'mask';
        if (t.clone) {
          tool.source = { x: 20, y: 30 };
          tool.offset = t.clone;
        }
        try {
          settings = tool.strokeSettings(c.samples[0], layer, tool.strokeTarget(layer));
        } finally {
          app.ui.editingMask = false;
        }
      }
      if (c.sampler?.kind === 'clone' && form !== 'tools') {
        const snap = document.createElement('canvas');
        snap.width = target.canvas.width;
        snap.height = target.canvas.height;
        snap.getContext('2d').drawImage(target.canvas, 0, 0);
        const off = c.sampler.offset;
        settings.sampler = (tctx, lx, ly, w, h) => tctx.drawImage(snap, Math.round(lx + off.x), Math.round(ly + off.y), w, h, 0, 0, w, h);
      }
      const stroke = new BrushStroke({ target, layer, settings, selection, history });
      stroke.begin(c.samples[0]);
      for (const s of c.samples.slice(1)) stroke.extend(s);
      stroke.finish(c.samples[c.samples.length - 1]);
      const dirty = stroke.dirty;
      stroke.end();
      return dirty;
    };
  }, form);
}

for (const form of ['legacy', 'preset', 'tools']) {
  test(`every golden case painted in the ${form} form gives 0.4's pixels`, async ({ page }) => {
    const errors = await setup(page);
    const classic = await page.evaluate(async () => (await import('/lib/brush.js')).ENGINE.id === 'classic-0.4');
    await useForm(page, form);
    const results = await page.evaluate(pageStrokeCases, { cases: CASES, W, H });
    expect(results).toHaveLength(CASES.length);
    for (const r of results) {
      const c = CASES.find((x) => x.id === r.id);
      const got = new Uint8Array(Buffer.from(r.rgba, 'base64'));
      const want = await golden(r.id);
      const { max, mean } = compare(got, want, RECORDED.cases.find((x) => x.id === r.id).dirty);
      if (classic || c.aliased) expect({ id: r.id, max }, `${r.id} (${form})`).toEqual({ id: r.id, max: 0 });
      else {
        expect(max, `${r.id} (${form}): largest channel difference`).toBeLessThanOrEqual(3);
        expect(mean, `${r.id} (${form}): mean difference over the stroke's box`).toBeLessThanOrEqual(0.35);
      }
    }
    expect(errors).toEqual([]);
  });
}

test('the 0.5 tools give 0.4\'s stroke settings for the same options (every recorded key)', async ({ page }) => {
  const errors = await setup(page);
  const tools = await page.evaluate(pageToolSettings, { toolOptions: TOOL_OPTIONS, toolSettings: TOOL_SETTINGS, context: TOOL_CONTEXT, W, H });
  for (const want of RECORDED.toolSettings.tools) {
    const got = tools.find((t) => t.id === want.id);
    expect(got, want.id).toBeTruthy();
    for (const [k, v] of Object.entries(want.settings)) expect([want.id, k, got.settings[k]]).toEqual([want.id, k, v]);
    // the 0.5 additions (S1.3): the preset rides along, and the paint keys a new ToolPaint field would reach the stroke by
    expect(got.settings.preset, want.id).toBe('[object]');
  }
  expect(errors).toEqual([]);
});

test('a buffer modifier halving the alpha halves the composited stroke; with no modifier the stroke is unchanged', async ({ page }) => {
  const errors = await setup(page);
  const r = await page.evaluate(async ([w, h]) => {
    const { BrushStroke, registerDabModifier } = await import('/lib/brush.js');
    const { createCanvas } = await import('/lib/document.js');
    const history = { stroke: null, beginStroke: (c) => ({ backup: (() => { const b = createCanvas(c.width, c.height); b.getContext('2d').drawImage(c, 0, 0); return b; })() }), endStroke: () => null, cancelStroke() {} };
    const paint = () => {
      const canvas = createCanvas(w, h);
      const s = new BrushStroke({ target: { canvas, x: 0, y: 0 }, layer: null, history, settings: { size: 30, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: '#000000', mode: 'paint', blend: 'normal' } });
      s.begin({ x: 40, y: 60 });
      s.extend({ x: 120, y: 60 });
      s.end();
      return canvas.getContext('2d').getImageData(80, 60, 1, 1).data[3];
    };
    const plain = paint();
    const off = registerDabModifier({ id: 'spec-half', order: 800, enabled: () => true, buffer: (img) => { for (let i = 3; i < img.data.length; i += 4) img.data[i] = Math.round(img.data[i] / 2); } });
    let halved;
    try {
      halved = paint();
    } finally {
      off();
    }
    return { plain, halved, after: paint() };
  }, [W, H]);
  expect(r.plain).toBe(255);
  expect(Math.abs(r.halved - 128)).toBeLessThanOrEqual(1);
  expect(r.after).toBe(255);
  expect(errors).toEqual([]);
});
