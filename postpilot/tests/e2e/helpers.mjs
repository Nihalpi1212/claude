// Browser test harness: starts dev/server.mjs --seed on a port, opens Chromium, unlocks the demo workspace.
// Usage (node:test):
//   const h = await openApp({ port: 5301 });  ... h.page ...  await h.close();
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
export const DEMO_PASSPHRASE = 'demo passphrase 123';

export function loadPlaywright() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const require = createRequire(path.join(globalRoot, 'noop.js'));
    return require('playwright');
  } catch (err) {
    throw new Error(`Playwright is not installed globally (${err.message}).`);
  }
}

export async function startDevServer({ port, seed = true } = {}) {
  const args = [path.join(ROOT, 'dev/server.mjs')];
  if (seed) args.push('--seed');
  const child = spawn(process.execPath, args, { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/postpilot/index.html`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`dev server exited:\n${output}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, child, output: () => output, close: () => new Promise((r) => (child.once('exit', r), child.kill('SIGTERM'))) };
}

/** Start server + browser, unlock the seeded workspace, return { page, context, browser, server, url, consoleErrors, close }. */
export async function openApp({ port, viewport = { width: 1280, height: 860 }, colorScheme = 'light', hash = '#/', seed = true } = {}) {
  const { chromium } = loadPlaywright();
  const server = await startDevServer({ port, seed });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`${server.url}/postpilot/index.html${hash}`);
  await unlock(page);
  return {
    page,
    context,
    browser,
    server,
    url: server.url,
    consoleErrors,
    async close() {
      await browser.close().catch(() => {});
      await server.close();
    },
  };
}

export async function unlock(page, passphrase = DEMO_PASSPHRASE) {
  await page.waitForSelector('#lock-token, .app', { timeout: 20_000 });
  if (await page.$('.app')) return;
  await page.fill('#lock-token', 'mock-token');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('#lock-passphrase', { timeout: 20_000 });
  await page.fill('#lock-passphrase', passphrase);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForSelector('.app', { timeout: 30_000 });
}

/** Screenshot helper writing into the scratchpad (or SCREENSHOT_DIR). */
export async function shot(page, name) {
  const dir = process.env.SCREENSHOT_DIR || '/tmp/claude-0/-home-user-claude/61a6d9a0-a933-5d86-8721-920a439be9c7/scratchpad/shots';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
