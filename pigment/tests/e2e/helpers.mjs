// Shared helpers for the e2e specs: the renderer runs in a plain browser with the in-memory bridge
// (src/renderer/lib/bridge.js); fixtures are served from /fixtures/.
import { expect } from '@playwright/test';

export async function openApp(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // while modules are being written in parallel, PIGMENT_PARTIAL=1 ignores missing-module noise
    if (process.env.PIGMENT_PARTIAL && /Failed to load resource|Failed to fetch dynamically imported module/.test(m.text())) return;
    errors.push(m.text());
  });
  await page.addInitScript(() => {
    window.__pigmentTest = { silent: true, files: {}, written: {}, messages: [] };
    try {
      localStorage.clear();
    } catch {}
  });
  await page.goto('/');
  await page.waitForSelector('body[data-ready]');
  return errors;
}

/** Fires a command without waiting (commands that open dialogs resolve when the dialog closes). */
export const run = (page, cmd, arg) =>
  page.evaluate(([c, a]) => {
    const result = window.pigmentApp.commands.run(c, a, 'api');
    if (result && typeof result.catch === 'function') result.catch((err) => console.error('command failed', c, err));
  }, [cmd, arg]);

/** Runs a command and waits for it to finish (only for commands without a dialog). */
export const runAwait = (page, cmd, arg) => page.evaluate(([c, a]) => window.pigmentApp.commands.run(c, a, 'api'), [cmd, arg]);

export async function newDoc(page, opts = {}) {
  await page.evaluate((o) => window.pigmentApp.newDocument({ width: 400, height: 300, name: 'Test', ...o }), opts);
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
}

export async function openFixture(page, name) {
  await runAwait(page, 'file:open-paths', [`/fixtures/${name}`]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe(`/fixtures/${name}`);
}

/** RGBA of the flattened document at (x, y). */
export const pixel = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
  }, [x, y]);

/** RGBA of the active layer at document (x, y). */
export const layerPixel = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const l = window.pigmentApp.doc.active;
    return Array.from(l.canvas.getContext('2d').getImageData(px - l.x, py - l.y, 1, 1).data);
  }, [x, y]);

/** Screen position (page coordinates) of a document point. */
export async function screenPoint(page, x, y) {
  return page.evaluate(([px, py]) => {
    const v = window.pigmentApp.view;
    const p = v.toScreen(px, py);
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [x, y]);
}

export async function drag(page, from, to, { steps = 12, modifiers = [] } = {}) {
  const a = await screenPoint(page, ...from);
  const b = await screenPoint(page, ...to);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
}

/** Clicks the primary button of the open dialog. */
export async function confirmDialog(page) {
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
}

export const historyLength = (page) => page.evaluate(() => window.pigmentApp.doc.history.index + 1);
