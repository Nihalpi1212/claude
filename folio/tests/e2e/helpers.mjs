// Shared helpers for the e2e specs. The renderer runs in a plain browser with the browser bridge
// (see src/renderer/lib/bridge.js); fixtures are served from /fixtures/.
import { expect } from '@playwright/test';

export async function openApp(page, { silent = true } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript((silentFlag) => {
    window.__folioTest = { silent: silentFlag, files: {}, written: {}, messages: [] };
    try {
      localStorage.clear();
    } catch {}
  }, silent);
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]');
  return errors;
}

export async function openFixture(page, name, { expectPages } = {}) {
  const result = await page.evaluate(async (path) => {
    const session = await window.folioApp.tabs.open({ path });
    return session ? { numPages: session.view.numPages, id: session.id } : null;
  }, `/fixtures/${name}`);
  expect(result, `open ${name}`).not.toBeNull();
  if (expectPages) expect(result.numPages).toBe(expectPages);
  await page.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas');
  await page.waitForSelector('.doc-host:not([hidden]) .page[data-page-number="1"] .textLayer');
  return result;
}

/** Fires a command without waiting for it to finish (commands that open dialogs resolve only when the dialog closes). */
export const run = (page, cmd, arg) =>
  page.evaluate(([c, a]) => {
    const result = window.folioApp.commands.run(c, a, 'api');
    if (result && typeof result.catch === 'function') result.catch((err) => console.error('command failed', c, err));
  }, [cmd, arg]);

/** Runs an action that triggers a document reload and waits for the reload to finish. */
export async function withReload(page, action) {
  await page.evaluate(() => {
    window.__reloaded = new Promise((resolve) => {
      const off = window.folioApp.on('doc:reloaded', () => {
        off();
        resolve(true);
      });
    });
  });
  await action();
  await page.evaluate(() => window.__reloaded);
  await page.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas');
}

/** Current document bytes (after flushing pdf.js edits) listed through the engine. */
export async function listAnnotations(page) {
  return page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    const bytes = await window.folioApp.session.flush();
    return (await engine.listAnnotations(bytes)).map((a) => ({ ...a, created: a.created && a.created.toISOString(), modified: a.modified && a.modified.toISOString() }));
  });
}

export async function pageInfo(page) {
  return page.evaluate(async () => {
    const engine = await import('/shared/engine.js');
    return engine.getPageInfo(await window.folioApp.session.flush());
  });
}

/** Selects the text layer span containing `text` on a page (1-based) and returns its bounding box. */
export async function selectText(page, pageNumber, text) {
  const box = await page.evaluate(
    ([n, t]) => {
      const spans = [...document.querySelectorAll(`.page[data-page-number="${n}"] .textLayer span`)];
      const span = spans.find((s) => s.textContent.includes(t));
      if (!span) return null;
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      const r = span.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    [pageNumber, text]
  );
  expect(box, `text "${text}" on page ${pageNumber}`).not.toBeNull();
  return box;
}

/** The VISIBLE part of a page (intersection with the scrolling container), in viewport coordinates. */
export async function pageBox(page, pageNumber) {
  return page.evaluate((n) => {
    const p = document.querySelector(`.doc-host:not([hidden]) .page[data-page-number="${n}"]`);
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const c = p.closest('.viewerContainer').getBoundingClientRect();
    const x = Math.max(r.left, c.left), y = Math.max(r.top, c.top);
    return { x, y, width: Math.min(r.right, c.right) - x, height: Math.min(r.bottom, c.bottom) - y };
  }, pageNumber);
}

export async function drag(page, from, to, { steps = 8 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
