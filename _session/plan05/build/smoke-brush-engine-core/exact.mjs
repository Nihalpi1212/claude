import { readFileSync } from 'node:fs';
import { W, H, CASES, pageStrokeCases } from '/home/user/claude/pigment/tests/e2e/goldens.mjs';
import { decodePng, toRgba8 } from '/home/user/claude/pigment/src/shared/pixels/png.js';
const DIR = '/home/user/claude/pigment/tests/fixtures/brush-golden';
export default async function (page, logs) {
  await page.evaluate(([w, h]) => window.pigmentApp.newDocument({ width: w, height: h, name: 'Goldens', background: 'transparent' }), [W, H]);
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  for (const form of ['legacy', 'preset']) {
    await page.evaluate(async (form) => {
      const { BrushStroke } = await import('/lib/brush.js');
      const { brushFromLegacy, normalizeBrush } = await import('/lib/brush/preset.js');
      const TIP = ['size', 'hardness', 'spacing', 'angle', 'roundness'];
      window.__goldenStroke = async (c, { target, layer, selection, history }) => {
        let settings = { ...c.settings };
        if (form === 'preset') {
          const paint = Object.fromEntries(Object.entries(c.settings).filter(([k]) => !TIP.includes(k)));
          settings = { ...paint, preset: normalizeBrush({ ...brushFromLegacy(Object.fromEntries(TIP.map((k) => [k, c.settings[k]]))), tool: null }) };
        }
        if (c.sampler?.kind === 'clone') {
          const snap = document.createElement('canvas'); snap.width = target.canvas.width; snap.height = target.canvas.height;
          snap.getContext('2d').drawImage(target.canvas, 0, 0);
          const off = c.sampler.offset;
          settings.sampler = (tctx, lx, ly, w, h) => tctx.drawImage(snap, Math.round(lx + off.x), Math.round(ly + off.y), w, h, 0, 0, w, h);
        }
        const stroke = new BrushStroke({ target, layer, settings, selection, history });
        stroke.begin(c.samples[0]);
        for (const s of c.samples.slice(1)) stroke.extend(s);
        stroke.finish(c.samples[c.samples.length - 1]);
        const dirty = stroke.dirty; stroke.end(); return dirty;
      };
    }, form);
    const results = await page.evaluate(pageStrokeCases, { cases: CASES, W, H });
    for (const r of results) {
      const got = new Uint8Array(Buffer.from(r.rgba, 'base64'));
      const want = toRgba8(await decodePng(new Uint8Array(readFileSync(`${DIR}/${r.id}.png`)))).data;
      let max = 0; for (let i = 0; i < got.length; i++) max = Math.max(max, Math.abs(got[i] - want[i]));
      logs.push(`${form} ${r.id}: max ${max}`);
    }
  }
}
